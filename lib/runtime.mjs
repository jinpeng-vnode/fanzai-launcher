// lib/runtime.mjs — Node.js 运行时管理（检测/下载便携版 Node + 安装 9Router npm 包）
//
// 零外部依赖，纯 Node.js 内置模块。

import { existsSync, mkdirSync, createWriteStream, unlinkSync, readdirSync, renameSync, statSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createGunzip } from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import http from 'node:http';
import https from 'node:https';
import os from 'node:os';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = join(__dirname, '..');
const RUNTIME = join(ROOT, 'runtime');

const NODE_VERSION = 'v24.9.0';

// ── 平台检测 ──
function getPlatformInfo() {
  const platform = os.platform(); // 'win32' | 'darwin' | 'linux'
  const arch = os.arch();         // 'x64' | 'arm64'
  if (platform === 'win32') {
    return { platform, arch: 'x64', ext: 'zip', nodeDir: 'node', exeName: 'node.exe' };
  } else if (platform === 'darwin') {
    return { platform, arch: arch === 'arm64' ? 'arm64' : 'x64', ext: 'tar.gz', nodeDir: 'node', exeName: 'bin/node' };
  } else {
    return { platform, arch: 'x64', ext: 'tar.xz', nodeDir: 'node', exeName: 'bin/node' };
  }
}

// ── 下载文件（支持代理 + 重定向） ──
function download(url, dest, proxy) {
  return new Promise((resolve, reject) => {
    const doRequest = (targetUrl) => {
      const parsed = new URL(targetUrl);
      const isHttps = parsed.protocol === 'https:';

      const makeReq = (options) => {
        const mod = isHttps ? https : http;
        const req = mod.get(options, (res) => {
          // 跟随重定向
          if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            res.resume();
            doRequest(res.headers.location);
            return;
          }
          if (res.statusCode !== 200) {
            res.resume();
            reject(new Error(`下载失败 HTTP ${res.statusCode}: ${targetUrl}`));
            return;
          }
          const total = parseInt(res.headers['content-length'] || '0', 10);
          let downloaded = 0;
          let lastPercent = -1;

          res.on('data', (chunk) => {
            downloaded += chunk.length;
            if (total > 0) {
              const pct = Math.floor(downloaded / total * 100);
              if (pct !== lastPercent && pct % 10 === 0) {
                process.stdout.write(`\r    下载进度: ${pct}%`);
                lastPercent = pct;
              }
            }
          });

          const file = createWriteStream(dest);
          res.pipe(file);
          file.on('finish', () => {
            file.close();
            if (total > 0) process.stdout.write('\r    下载进度: 100%\n');
            resolve();
          });
          file.on('error', (e) => { unlinkSync(dest); reject(e); });
        });
        req.on('error', reject);
        req.setTimeout(60000, () => { req.destroy(); reject(new Error('下载超时')); });
      };

      if (proxy && isHttps) {
        // CONNECT 隧道
        const p = new URL(proxy);
        const connReq = http.request({
          host: p.hostname,
          port: p.port || 80,
          method: 'CONNECT',
          path: `${parsed.hostname}:${parsed.port || 443}`,
        });
        connReq.on('connect', (res, socket) => {
          if (res.statusCode !== 200) {
            reject(new Error(`代理 CONNECT 失败: ${res.statusCode}`));
            return;
          }
          makeReq({ hostname: parsed.hostname, port: parsed.port || 443, path: parsed.pathname + parsed.search, agent: new https.Agent({ socket, rejectUnauthorized: false }) });
        });
        connReq.on('error', reject);
        connReq.end();
      } else if (proxy && !isHttps) {
        // HTTP 代理直连
        const p = new URL(proxy);
        makeReq({ hostname: p.hostname, port: p.port || 80, path: targetUrl });
      } else {
        makeReq(targetUrl);
      }
    };
    doRequest(url);
  });
}

// ── 解压 zip (Windows) ──
function extractZip(zipPath, destDir) {
  // 使用系统 tar 或 PowerShell
  const tarExe = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
  if (existsSync(tarExe)) {
    execFileSync(tarExe, ['-xf', zipPath, '-C', destDir], { stdio: 'pipe' });
  } else {
    execFileSync('powershell', [
      '-NoProfile', '-Command',
      `Expand-Archive -Path '${zipPath}' -DestinationPath '${destDir}' -Force`
    ], { stdio: 'pipe' });
  }
}

// ── 解压 tar.gz (macOS/Linux) ──
function extractTarGz(tarPath, destDir) {
  execFileSync('tar', ['-xzf', tarPath, '-C', destDir], { stdio: 'pipe' });
}

// ── 确保 Node.js 已就绪 ──
export async function ensureNode(proxy) {
  const info = getPlatformInfo();
  const nodeDir = join(RUNTIME, info.nodeDir);
  const nodeExe = join(nodeDir, info.exeName);

  if (existsSync(nodeExe)) {
    console.log('[✓] Node.js 已就绪（复用）');
    return nodeExe;
  }

  // 清理不完整目录
  if (existsSync(nodeDir)) {
    console.log('[!] 检测到不完整 Node 目录，清理中...');
    const { rmSync } = await import('node:fs');
    rmSync(nodeDir, { recursive: true, force: true });
  }

  // 构造下载 URL
  const archiveName = info.platform === 'win32'
    ? `node-${NODE_VERSION}-win-x64.zip`
    : info.platform === 'darwin'
      ? `node-${NODE_VERSION}-darwin-${info.arch}.tar.gz`
      : `node-${NODE_VERSION}-linux-${info.arch}.tar.xz`;

  const mirrors = [
    { name: '国内镜像', url: `https://cdn.npmmirror.com/binaries/node/${NODE_VERSION}/${archiveName}` },
    { name: '官方源', url: `https://nodejs.org/dist/${NODE_VERSION}/${archiveName}` },
  ];

  mkdirSync(RUNTIME, { recursive: true });
  const archivePath = join(RUNTIME, archiveName);
  let downloaded = false;

  for (const mirror of mirrors) {
    console.log(`[*] 尝试从${mirror.name}下载 Node.js ${NODE_VERSION}...`);
    try {
      await download(mirror.url, archivePath, proxy);
      downloaded = true;
      console.log(`[✓] 下载完成（${mirror.name}）`);
      break;
    } catch (e) {
      console.log(`[!] ${mirror.name}下载失败: ${e.message}`);
    }
  }
  if (!downloaded) {
    throw new Error('所有镜像源均下载失败，请检查网络/代理设置');
  }

  // 解压
  console.log('[*] 解压 Node.js...');
  const tmpDir = join(RUNTIME, 'node-tmp');
  mkdirSync(tmpDir, { recursive: true });

  if (info.ext === 'zip') {
    extractZip(archivePath, tmpDir);
  } else {
    extractTarGz(archivePath, tmpDir);
  }

  // 移动内层目录到 nodeDir
  const inner = readdirSync(tmpDir).find(d => statSync(join(tmpDir, d)).isDirectory());
  if (!inner) throw new Error('解压结果异常：找不到内层目录');
  renameSync(join(tmpDir, inner), nodeDir);

  // 清理
  const { rmSync } = await import('node:fs');
  rmSync(tmpDir, { recursive: true, force: true });
  unlinkSync(archivePath);

  console.log('[✓] Node.js 就绪');
  return nodeExe;
}

// ── 确保 9Router 已安装且为最新版（每次启动校验，有新版自动更新）──
export async function ensureRouter(nodeExe, proxy) {
  const info = getPlatformInfo();
  const npmPrefix = join(RUNTIME, 'npm-global');
  mkdirSync(npmPrefix, { recursive: true });

  const routerBin = info.platform === 'win32'
    ? join(npmPrefix, 'node_modules', '9router', 'cli.js')
    : join(npmPrefix, 'lib', 'node_modules', '9router', 'cli.js');
  const pkgJson = info.platform === 'win32'
    ? join(npmPrefix, 'node_modules', '9router', 'package.json')
    : join(npmPrefix, 'lib', 'node_modules', '9router', 'package.json');

  const npmCli = info.platform === 'win32'
    ? join(dirname(nodeExe), 'node_modules', 'npm', 'bin', 'npm-cli.js')
    : join(dirname(dirname(nodeExe)), 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js');

  const env = {
    ...process.env,
    npm_config_prefix: npmPrefix,
    npm_config_cache: join(RUNTIME, 'npm-cache'),
    npm_config_registry: 'https://registry.npmmirror.com',
    PATH: `${dirname(nodeExe)}${info.platform === 'win32' ? ';' : ':'}${process.env.PATH}`,
  };
  if (proxy) {
    env.HTTP_PROXY = proxy;
    env.HTTPS_PROXY = proxy;
  }

  // 已装版本（未装为 null）
  let installed = null;
  if (existsSync(pkgJson)) {
    try { installed = JSON.parse(readFileSync(pkgJson, 'utf8')).version || null; } catch {}
  }

  // 查 registry 最新版（失败/离线返回 null）
  let latest = null;
  try {
    const out = execFileSync(nodeExe, [npmCli, 'view', '9router', 'version'], {
      env, stdio: ['ignore', 'pipe', 'ignore'], timeout: 30000,
    }).toString().trim();
    if (/^\d+\.\d+/.test(out)) latest = out;
  } catch {}

  // 已是最新 → 复用
  if (installed && latest && installed === latest) {
    console.log(`[✓] 9Router 已是最新版 v${latest}`);
    return { routerBin, npmPrefix };
  }
  // 查不到最新版：已装就用旧的、只警告；没装才报错
  if (!latest) {
    if (installed) {
      console.log(`[!] 9Router 无法检查更新（离线？），复用已装 v${installed}`);
      return { routerBin, npmPrefix };
    }
    throw new Error('9Router 未安装且无法连接 registry，请检查网络/代理设置');
  }

  console.log(installed
    ? `[*] 9Router 有新版：v${installed} → v${latest}，更新中...`
    : `[*] 安装 9Router（npm 最新版 v${latest}）...`);

  try {
    execFileSync(nodeExe, [npmCli, 'install', '-g', '9router@latest'], {
      env,
      stdio: 'pipe',
      timeout: 300000,
    });
  } catch (e) {
    throw new Error(`9Router 安装失败: ${e.stderr?.toString() || e.message}`);
  }

  if (!existsSync(routerBin)) {
    throw new Error('9Router 安装后找不到 cli.js，请检查安装日志');
  }

  console.log('[✓] 9Router 安装完成');
  return { routerBin, npmPrefix };
}

// ── 获取各路径 ──
export function getPaths(nodeExe, routerBin) {
  return {
    root: ROOT,
    runtime: RUNTIME,
    nodeExe,
    routerBin,
    dataDir: join(RUNTIME, '9router-data'),
  };
}
