// 9router 全流程编排 — 三平台共用
// 步骤：装包 → 初始化DB → 建key → 种组合 → 启动 → 健康检查 → 写配置
// 凭证导入改为按需触发（用户在凭证 tab 点「导入到 9router」按钮）
//
// 复用现成纯 Node 资产：
//   - sql/mkkey.mjs、sql/seedcombos.mjs（直写 sqlite）
// 9router 本身从 npm 源拉最新版安装（上游不再需要我们维护）。
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn, execFileSync } = require('child_process');
const { ensureNode, npmCliPath, ensureNpmGlobalLatest } = require('./node-runtime');
const { selectFastest } = require('./download');

const PORT_DEFAULT = 20128;

function getLanIp() {
  const nets = os.networkInterfaces();
  const privateRe = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/;
  const candidates = [];
  for (const entries of Object.values(nets)) {
    for (const ni of entries || []) {
      if (ni.family !== 'IPv4' || ni.internal || !ni.address) continue;
      candidates.push(ni.address);
    }
  }
  return candidates.find((ip) => privateRe.test(ip)) || candidates[0] || '';
}

function localUrl(port) {
  return `http://127.0.0.1:${port}`;
}

function lanUrl(port) {
  const ip = getLanIp();
  return ip ? `http://${ip}:${port}` : '';
}

// npm 装好后 9router 的 cli.js 路径（win 与 unix 布局不同）
function routerBinPath(npmPrefix) {
  const win = path.join(npmPrefix, 'node_modules', '9router', 'cli.js');
  const unix = path.join(npmPrefix, 'lib', 'node_modules', '9router', 'cli.js');
  return fs.existsSync(win) ? win : (fs.existsSync(unix) ? unix : win);
}

function routerServerPath(routerCli) {
  return path.join(path.dirname(routerCli), 'app', 'server.js');
}

const npmRegistries = [
  { name: '国内镜像', url: 'https://registry.npmmirror.com' },
  { name: '官方源', url: 'https://registry.npmjs.org' },
];

function prependPath(env, entries) {
  const sep = os.platform() === 'win32' ? ';' : ':';
  const key = Object.keys(env).find((k) => k.toUpperCase() === 'PATH') || 'PATH';
  const current = env[key] || '';
  const extra = [];

  if (os.platform() === 'win32') {
    const winDir = env.SystemRoot || env.windir || 'C:\\Windows';
    extra.push(
      path.join(winDir, 'System32'),
      path.join(winDir, 'System32', 'WindowsPowerShell', 'v1.0'),
      winDir
    );
  }

  const parts = [...entries, ...extra, current].filter(Boolean);
  env[key] = parts.join(sep);
  if (key !== 'PATH') {
    delete env.PATH;
  }
}

function stopProcessTree(procOrPid) {
  const pid = typeof procOrPid === 'number' ? procOrPid : procOrPid && procOrPid.pid;
  if (!pid) return;

  if (os.platform() === 'win32') {
    const taskkill = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe');
    try { execFileSync(taskkill, ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' }); return; } catch {}
  }

  try {
    if (typeof procOrPid === 'number') process.kill(pid, 'SIGTERM');
    else procOrPid.kill('SIGTERM');
  } catch {}
}

function pidFilePath(runtimeDir) {
  return path.join(runtimeDir, 'ninerouter.pid');
}

function readManagedState(runtimeDir) {
  try {
    const raw = fs.readFileSync(pidFilePath(runtimeDir), 'utf8').trim();
    if (raw.startsWith('{')) {
      const state = JSON.parse(raw);
      return state && Number.isInteger(state.pid) && state.pid > 0 ? state : null;
    }
    const pid = Number(raw);
    return Number.isInteger(pid) && pid > 0 ? { pid } : null;
  } catch {
    return null;
  }
}

function writeManagedState(runtimeDir, state) {
  try {
    fs.writeFileSync(pidFilePath(runtimeDir), JSON.stringify(state, null, 2), 'utf8');
  } catch {}
}

function clearManagedPid(runtimeDir, pid) {
  try {
    const current = readManagedState(runtimeDir);
    if (!pid || current?.pid === pid) fs.rmSync(pidFilePath(runtimeDir), { force: true });
  } catch {}
}

function stopManagedRouter(runtimeDir) {
  const state = hasManagedRouter(runtimeDir);
  if (!state) {
    clearManagedPid(runtimeDir);
    return { stopped: false };
  }
  stopProcessTree(state.pid);
  clearManagedPid(runtimeDir, state.pid);
  return { stopped: true, pid: state.pid, port: state.port, baseUrl: state.baseUrl };
}

function getProcessCommandLine(pid) {
  if (!pid) return '';
  if (os.platform() === 'win32') {
    const ps = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    try {
      return execFileSync(ps, [
        '-NoLogo',
        '-NoProfile',
        '-Command',
        `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`,
      ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 }).trim();
    } catch {
      return '';
    }
  }

  // Linux 优先读 /proc（快）；macOS 无 /proc，回退到 ps。-ww 禁止命令行截断。
  try {
    return fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' ').trim();
  } catch {}
  try {
    return execFileSync('ps', ['-ww', '-p', String(pid), '-o', 'command='], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000,
    }).trim();
  } catch {
    return '';
  }
}

function isManagedRouterProcess(pid, runtimeDir) {
  const cmd = getProcessCommandLine(pid);
  if (!cmd) return false;
  const runtime = path.resolve(runtimeDir).toLowerCase();
  const normalized = cmd.toLowerCase().replace(/\//g, '\\');
  // Linux（/proc）能拿到完整命令行：校验 runtime 路径 + 9router 脚本，最严格。
  if (normalized.includes(runtime.replace(/\//g, '\\')) &&
    /node_modules[\\/]9router[\\/](cli\.js|app[\\/]server\.js)/i.test(cmd)) {
    return true;
  }
  // macOS：9router 是 Next.js standalone，会把进程标题改写成 "next-server (vX.Y.Z)"，
  // ps 拿不到原始命令行与路径。回退到匹配该标题——配合调用方的端口健康检查已足够可靠。
  if (os.platform() === 'darwin' && /next-server/i.test(cmd)) {
    return true;
  }
  return false;
}

function hasManagedRouter(runtimeDir) {
  const state = readManagedState(runtimeDir);
  return state?.pid && isManagedRouterProcess(state.pid, runtimeDir) ? state : null;
}

// GET 健康检查（绕过代理，直连本地）
function checkModels(baseUrl, timeoutMs = 3000) {
  return new Promise((resolve) => {
    try {
      const u = new URL(baseUrl + '/v1/models');
      const req = http.get(
        { hostname: u.hostname, port: u.port, path: u.pathname, timeout: timeoutMs },
        (res) => { res.resume(); resolve(res.statusCode === 200); }
      );
      req.on('timeout', () => { req.destroy(); resolve(false); });
      req.on('error', () => resolve(false));
    } catch { resolve(false); }
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 探测某端口本机是否可绑（空闲返回 true）
function isPortFree(port) {
  return new Promise((resolve) => {
    const srv = require('net').createServer();
    srv.once('error', () => resolve(false));
    srv.once('listening', () => srv.close(() => resolve(true)));
    srv.listen(port, '0.0.0.0');
  });
}

// 从 startPort 起找一个空闲端口（最多顺延 20 个）
async function findFreePort(startPort) {
  for (let p = startPort; p < startPort + 20; p++) {
    if (await isPortFree(p)) return p;
  }
  throw new Error(`端口 ${startPort}~${startPort + 19} 全部被占用，请释放后重试`);
}

// 用便携 node 跑一个 .mjs，返回 Promise（拒绝时带 stderr）
function runNode(nodeExe, args, env, log) {
  return new Promise((resolve, reject) => {
    const child = spawn(nodeExe, ['--no-warnings', ...args], { env });
    let err = '';
    child.stdout.on('data', (d) => log(String(d).trimEnd()));
    child.stderr.on('data', (d) => { err += d; log(String(d).trimEnd()); });
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(err || `exit ${code}`))));
    child.on('error', reject);
  });
}

function buildRouterServerEnv(routerCli, env, port, host) {
  const routerRoot = path.dirname(routerCli);
  try {
    const sqliteRuntime = require(path.join(routerRoot, 'hooks', 'sqliteRuntime'));
    try { sqliteRuntime.ensureSqliteRuntime({ silent: true }); } catch {}
    env = sqliteRuntime.buildEnvWithRuntime(env);
  } catch {}
  return {
    ...env,
    NODE_ENV: 'production',
    PORT: String(port),
    HOSTNAME: host,
  };
}

function spawnRouter(nodeExe, routerCli, port, host, env, runtimeDir, tag, log) {
  const serverPath = routerServerPath(routerCli);
  if (!fs.existsSync(serverPath)) throw new Error(`9router 服务端文件不存在：${serverPath}`);

  const outPath = path.join(runtimeDir, `.${tag}.out.log`);
  const errPath = path.join(runtimeDir, `.${tag}.err.log`);
  try {
    fs.rmSync(outPath, { force: true });
    fs.rmSync(errPath, { force: true });
  } catch {}

  const out = fs.openSync(outPath, 'a');
  const err = fs.openSync(errPath, 'a');
  const proc = spawn(
    nodeExe,
    ['--max-old-space-size=6144', serverPath],
    {
      cwd: path.dirname(serverPath),
      env: buildRouterServerEnv(routerCli, env, port, host),
      stdio: ['ignore', out, err],
      detached: false,
      windowsHide: true,
    }
  );

  try { fs.closeSync(out); } catch {}
  try { fs.closeSync(err); } catch {}

  proc.on('error', (e) => log(`[9router] 启动进程失败：${e.message}`));
  proc.on('exit', (code, sig) => {
    log(`[9router] 退出 code=${code} sig=${sig}`);
    appendRouterLog(outPath, errPath, log);
  });

  return { proc, outPath, errPath };
}

function appendRouterLog(outPath, errPath, log) {
  for (const [label, p] of [['out', outPath], ['err', errPath]]) {
    try {
      const content = fs.readFileSync(p, 'utf8').trim();
      if (content) log(`[9router-${label}] ${tailText(content, 4000)}`);
    } catch {}
  }
}

function tailText(text, maxChars) {
  return text.length <= maxChars ? text : text.slice(text.length - maxChars);
}

function materializeScript(scriptPath, runtimeDir) {
  const dir = path.join(runtimeDir, 'helper-scripts');
  fs.mkdirSync(dir, { recursive: true });
  const target = path.join(dir, path.basename(scriptPath));
  fs.writeFileSync(target, fs.readFileSync(scriptPath, 'utf8'), 'utf8');
  return target;
}

// 主流程：确保 9router 起来并返回 { baseUrl, apiKey }
// opts: { launcherRoot, runtimeDir, proxy, port, onLog }
async function startNineRouter(opts) {
  const { launcherRoot, runtimeDir } = opts;
  const log = opts.onLog || (() => {});
  const onProgress = opts.onProgress || null;
  const proxy = opts.proxy || null;
  const wantPort = opts.port || (process.env.NINEROUTER_PORT ? Number(process.env.NINEROUTER_PORT) : PORT_DEFAULT);

  const nodeDir = path.join(runtimeDir, 'node');
  const npmPrefix = path.join(runtimeDir, 'npm-global');
  const npmCache = path.join(runtimeDir, 'npm-cache');
  const claudeCfg = path.join(runtimeDir, 'claude-config');
  const homeDir = path.join(runtimeDir, 'home');
  const dataDir = path.join(runtimeDir, 'data');
  const dbPath = path.join(dataDir, 'db', 'data.sqlite');

  for (const d of [runtimeDir, npmPrefix, claudeCfg, homeDir, npmCache, path.dirname(dbPath)]) {
    fs.mkdirSync(d, { recursive: true });
  }

  const managed = hasManagedRouter(runtimeDir);
  if (managed?.port && await checkModels(`http://127.0.0.1:${managed.port}`)) {
    const existed = readExistingKey(claudeCfg);
    if (existed && fs.existsSync(dbPath)) {
      log(`检测到本启动器的 9router 已在端口 ${managed.port} 运行，复用`);
      return { baseUrl: localUrl(managed.port), lanUrl: lanUrl(managed.port), apiKey: existed, pid: managed.pid, reused: true };
    }
  }

  // ── 端口解析 ──
  // 1. 期望端口上若已有 9router 在响应：只有 pid 文件确认它是本启动器拉起的进程，才复用。
  //    外部容器/其他 9router 即使也响应 /v1/models，也必须自动顺延端口启动自己的实例。
  let port = wantPort;
  if (await checkModels(`http://127.0.0.1:${wantPort}`)) {
    const existed = readExistingKey(claudeCfg);
    const managedAtDefault = hasManagedRouter(runtimeDir);
    if (existed && fs.existsSync(dbPath) && managedAtDefault?.port === wantPort) {
      log(`检测到本启动器的 9router 已在端口 ${wantPort} 运行，复用`);
      return { baseUrl: localUrl(wantPort), lanUrl: lanUrl(wantPort), apiKey: existed, pid: managedAtDefault.pid, reused: true };
    }
    log(`端口 ${wantPort} 已有外部服务响应，自动换端口启动本启动器自己的 9router…`);
    port = await findFreePort(wantPort + 1);
  } else if (!(await isPortFree(wantPort))) {
    // 端口被占但不是 9router（没响应 /v1/models）→ 也顺延
    log(`端口 ${wantPort} 被占用，自动换端口…`);
    port = await findFreePort(wantPort + 1);
  }
  const baseUrl = localUrl(port);
  const publicBaseUrl = lanUrl(port);
  if (port !== wantPort) log(`使用端口 ${port}`);

  // ── 1. 便携 Node 24 ──
  const nodeExe = await ensureNode(nodeDir, runtimeDir, proxy, log, onProgress);

  // 进程环境：PATH 前置便携 node、设代理、数据目录指向包内（绿色核心）
  const env = { ...process.env };
  const nodeBinDir = os.platform() === 'win32' ? nodeDir : path.join(nodeDir, 'bin');
  const npmBinDir = os.platform() === 'win32' ? npmPrefix : path.join(npmPrefix, 'bin');
  prependPath(env, [nodeBinDir, npmBinDir]);
  env.DATA_DIR = dataDir;
  if (os.platform() === 'win32') env.APPDATA = path.join(homeDir, 'AppData', 'Roaming');
  if (proxy) {
    env.HTTP_PROXY = proxy; env.HTTPS_PROXY = proxy; env.http_proxy = proxy; env.https_proxy = proxy;
    // Node 24 的原生 fetch 默认不读 HTTP(S)_PROXY；9router 服务端刷 Kiro token 走 fetch 连 AWS OIDC，
    // 国内必须走代理，故显式开启，让服务端 fetch 也吃上面的代理环境变量。
    env.NODE_USE_ENV_PROXY = '1';
  }

  // ── 2. 装 9router + claude-code（每次启动校验版本，有新版自动更新）──
  const registry = await selectFastest('npm', npmRegistries, npmRegistries[0].url, proxy, log);
  const npmEnv = { ...env, npm_config_registry: registry, npm_config_prefix: npmPrefix, npm_config_cache: npmCache };
  await ensureNpmGlobalLatest({
    nodeExe,
    npmCli: npmCliPath(nodeDir),
    npmPrefix,
    env: npmEnv,
    pkgs: ['9router', '@anthropic-ai/claude-code'],
    log,
    runner: (toInstall) => runNode(nodeExe, [npmCliPath(nodeDir), 'install', '-g', ...toInstall], npmEnv, log),
  });
  if (!fs.existsSync(routerBinPath(npmPrefix))) throw new Error('9router 安装失败');
  const routerCli = routerBinPath(npmPrefix);

  // ── 3. 初始化数据库（首次 self-heal 下载 better-sqlite3，1-2 分钟）──
  if (!fs.existsSync(dbPath)) {
    log('初始化 9router 数据库（首次需下载运行时，约 1-2 分钟）…');
    const initRun = spawnRouter(nodeExe, routerCli, port, '0.0.0.0', env, runtimeDir, 'init', log);
    const init = initRun.proc;
    let spawnErr = null;
    init.on('error', (e) => { spawnErr = e; });
    let ok = false;
    for (let i = 0; i < 90; i++) {
      if (spawnErr) throw new Error(`无法启动 9router 进程：${spawnErr.message}`);
      if (fs.existsSync(dbPath)) { ok = true; break; }
      if (init.exitCode !== null) break;
      if (await checkModels(baseUrl, 2000)) { ok = true; break; }
      await sleep(1000);
    }
    stopProcessTree(init);
    await sleep(2000);
    appendRouterLog(initRun.outPath, initRun.errPath, log);
    if (!ok && !fs.existsSync(dbPath)) throw new Error('数据库初始化失败（self-heal 可能超时，请重试）');
    log('数据库就绪');
  }

  // ── 4. 凭证导入改为按需触发 ──
  // 不再在启动时直写数据库；凭证由用户在「账号凭证」页点「导入到 9router」，
  // 走 9router 自身的 REST API 导入（服务端刷 token + upsert，热生效、可重复）。

  // ── 5. 建 API Key（复用上次的固定 key）──
  let apiKey = readExistingKey(claudeCfg);
  if (apiKey) log('复用已有 API Key（固定秘钥）');
  else { apiKey = 'sk-9r-' + randomHex(24); log('生成新 API Key（首次）'); }
  const mkkeyScript = materializeScript(path.join(__dirname, 'sql', 'mkkey.mjs'), runtimeDir);
  await runNode(nodeExe, [mkkeyScript, dbPath, apiKey], env, log);
  log('API Key 已生成');

  // ── 6. 种默认 Opus 组合 ──
  const seedCombosScript = materializeScript(path.join(__dirname, 'sql', 'seedcombos.mjs'), runtimeDir);
  await runNode(nodeExe, [seedCombosScript, dbPath], env, log);
  log('官方中转模型配置已生成');

  // ── 7. 启动 9router（后台托管，由主进程持有句柄）──
  log('启动 9router…');
  const run = spawnRouter(nodeExe, routerCli, port, '0.0.0.0', env, runtimeDir, 'live', log);
  const proc = run.proc;
  let procErr = null;
  proc.on('error', (e) => { procErr = e; });
  let ready = false;
  for (let i = 0; i < 40; i++) {
    await sleep(1000);
    if (procErr) throw new Error('启动 9router 失败：' + procErr.message);
    if (proc.exitCode !== null) break;
    if (await checkModels(baseUrl)) { ready = true; break; }
  }
  appendRouterLog(run.outPath, run.errPath, log);
  if (!ready) { stopProcessTree(proc); throw new Error('9router 启动超时'); }
  log(`9router 已启动 (PID ${proc.pid})`);
  writeManagedState(runtimeDir, { pid: proc.pid, port, baseUrl, lanUrl: publicBaseUrl });
  proc.on('exit', () => clearManagedPid(runtimeDir, proc.pid));

  // ── 8. 写 Claude Code 配置 ──
  const settings = {
    env: { ANTHROPIC_BASE_URL: baseUrl, ANTHROPIC_AUTH_TOKEN: apiKey },
    permissions: { defaultMode: 'bypassPermissions' },
  };
  fs.writeFileSync(path.join(claudeCfg, 'settings.json'), JSON.stringify(settings, null, 2), 'utf8');
  log('Claude Code 已配置');

  return { baseUrl, lanUrl: publicBaseUrl, apiKey, proc, pid: proc.pid };
}

// 从 claude-config/settings.json 复用上次的固定 key
function readExistingKey(claudeCfg) {
  try {
    const p = path.join(claudeCfg, 'settings.json');
    const j = JSON.parse(fs.readFileSync(p, 'utf8'));
    const k = j.env && j.env.ANTHROPIC_AUTH_TOKEN;
    return /^sk-9r-/.test(k || '') ? k : null;
  } catch { return null; }
}

function randomHex(n) {
  return require('crypto').randomBytes(Math.ceil(n / 2)).toString('hex').slice(0, n);
}

module.exports = { startNineRouter, checkModels, stopManagedRouter, stopProcessTree, hasManagedRouter, PORT_DEFAULT };
