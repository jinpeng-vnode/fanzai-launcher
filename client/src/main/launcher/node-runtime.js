// 便携 Node 24 运行时 — 9router 需要 node:sqlite（Node 24+），Electron 内置 Node 20 跑不了
// 对齐 start.ps1 第2步 / start.sh 第2步：下载便携 node 到 runtime/node，三平台
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const { selectFastest, downloadFile, extractZip, extractTarGz } = require('./download');

const NODE_VERSION = 'v24.9.0';

// 按平台/架构算出包名、下载文件名、解压后 node 可执行路径
function nodeTarget() {
  const plat = os.platform();
  const arch = os.arch(); // x64 / arm64
  if (plat === 'win32') {
    const pkg = `node-${NODE_VERSION}-win-x64`;
    return {
      pkg,
      file: `${pkg}.zip`,
      kind: 'zip',
      // win zip 内是 node-vX-win-x64/node.exe
      exeRel: 'node.exe',
    };
  }
  if (plat === 'darwin') {
    const a = arch === 'arm64' ? 'arm64' : 'x64';
    const pkg = `node-${NODE_VERSION}-darwin-${a}`;
    return { pkg, file: `${pkg}.tar.gz`, kind: 'targz', exeRel: 'bin/node' };
  }
  // linux
  const a = arch === 'arm64' ? 'arm64' : 'x64';
  const pkg = `node-${NODE_VERSION}-linux-${a}`;
  return { pkg, file: `${pkg}.tar.gz`, kind: 'targz', exeRel: 'bin/node' };
}

function mirrors(file) {
  return [
    { name: '国内镜像', url: `https://cdn.npmmirror.com/binaries/node/${NODE_VERSION}/${file}` },
    { name: '官方源', url: `https://nodejs.org/dist/${NODE_VERSION}/${file}` },
  ];
}

// 确保便携 Node 就绪，返回 node 可执行文件绝对路径
async function ensureNode(nodeDir, runtimeDir, proxy, log = () => {}, onProgress = null) {
  const tgt = nodeTarget();
  const nodeExe = path.join(nodeDir, tgt.exeRel);

  // 不完整目录清理
  if (fs.existsSync(nodeDir) && !fs.existsSync(nodeExe)) {
    log('检测到不完整 Node 目录，清理后重试');
    fs.rmSync(nodeDir, { recursive: true, force: true });
  }
  if (fs.existsSync(nodeExe)) {
    log('Node 已就绪（复用）');
    return nodeExe;
  }

  const url = await selectFastest('Node', mirrors(tgt.file), mirrors(tgt.file)[0].url, proxy, log);
  log(`下载便携 Node (${NODE_VERSION})…`);
  const archive = path.join(runtimeDir, tgt.file);
  await downloadFile(url, archive, proxy, (p) => onProgress && onProgress({ title: '下载 Node', ...p }));

  log('解压 Node…');
  const tmp = path.join(runtimeDir, 'node-tmp');
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.mkdirSync(tmp, { recursive: true });
  if (tgt.kind === 'zip') await extractZip(archive, tmp, (p) => onProgress && onProgress({ title: '解压 Node', ...p }));
  else await extractTarGz(archive, tmp, (p) => onProgress && onProgress({ title: '解压 Node', ...p }));

  // 包内是 node-vX-.../ 子目录，移到 nodeDir
  const inner = fs.readdirSync(tmp).map((n) => path.join(tmp, n)).find((p) => fs.statSync(p).isDirectory());
  if (!inner) throw new Error('Node 解压结构异常');
  fs.rmSync(nodeDir, { recursive: true, force: true });
  fs.renameSync(inner, nodeDir);
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.rmSync(archive, { force: true });

  if (!fs.existsSync(nodeExe)) throw new Error('Node 解压后未找到可执行文件');
  log('Node 就绪');
  return nodeExe;
}

// 便携 npm-cli.js 路径（win 和 unix 布局不同）
function npmCliPath(nodeDir) {
  const win = path.join(nodeDir, 'node_modules', 'npm', 'bin', 'npm-cli.js');
  const unix = path.join(nodeDir, 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js');
  return fs.existsSync(win) ? win : unix;
}

// 读 npm-global 里某个包的已装版本（未装返回 null）
function installedPkgVersion(npmPrefix, pkg) {
  // win: <prefix>/node_modules/<pkg>/package.json
  // unix: <prefix>/lib/node_modules/<pkg>/package.json
  const candidates = [
    path.join(npmPrefix, 'node_modules', pkg, 'package.json'),
    path.join(npmPrefix, 'lib', 'node_modules', pkg, 'package.json'),
  ];
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8')).version || null;
    } catch {}
  }
  return null;
}

// 查 registry 上某个包的最新版本号（带超时；失败/离线返回 null）
function latestPkgVersion(nodeExe, npmCli, pkg, env, log = () => {}, timeoutMs = 10000) {
  return new Promise((resolve) => {
    let out = '';
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    try {
      const child = spawn(nodeExe, ['--no-warnings', npmCli, 'view', pkg, 'version'], { env });
      const timer = setTimeout(() => { try { child.kill(); } catch {} finish(null); }, timeoutMs);
      child.stdout.on('data', (d) => { out += d; });
      child.stderr.on('data', () => {});
      child.on('error', () => { clearTimeout(timer); finish(null); });
      child.on('close', (code) => {
        clearTimeout(timer);
        const v = out.trim().split(/\s+/).pop();
        finish(code === 0 && /^\d+\.\d+/.test(v) ? v : null);
      });
    } catch { finish(null); }
  });
}

// 确保一组 npm 全局包是最新版：逐个比对「已装 vs registry 最新」，
// 只把"没装或落后"的收进一次 npm install。优雅降级：
//   - 查不到最新版（离线/registry 挂）→ 已装过就用旧的继续、只警告；没装过才抛错
//   - runner: (pkgsToInstall:string[]) => Promise  实际执行安装的回调（由调用方提供 env/registry）
async function ensureNpmGlobalLatest(opts) {
  const { nodeExe, npmCli, npmPrefix, env, pkgs, runner, log = () => {} } = opts;
  const toInstall = [];
  for (const pkg of pkgs) {
    const installed = installedPkgVersion(npmPrefix, pkg);
    const latest = await latestPkgVersion(nodeExe, npmCli, pkg, env, log);
    if (!latest) {
      if (installed) { log(`${pkg} 无法检查更新（离线？），复用已装 v${installed}`); continue; }
      throw new Error(`${pkg} 未安装且无法连接 registry，请检查网络/代理`);
    }
    if (installed === latest) { log(`${pkg} 已是最新版 v${latest}`); continue; }
    log(installed ? `${pkg} 有新版：v${installed} → v${latest}` : `${pkg} 安装 v${latest}`);
    toInstall.push(`${pkg}@${latest}`);
  }
  if (toInstall.length) await runner(toInstall);
}

module.exports = { ensureNode, npmCliPath, NODE_VERSION, installedPkgVersion, latestPkgVersion, ensureNpmGlobalLatest };
