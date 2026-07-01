// 总编排 — 把 9router 启动 + VS Code 启动串成对外两个高层动作
// 供 ipc.js 调用，渲染层通过 preload 触发
//
// 两种模式：
//   A. 我们的 key（LabPinky 远程）：直接拿 key 配 .launcher.json → 启动 VS Code
//   B. 本地 9router：起便携 Node24 + 9router（用客户自己的 Kiro 账号）→ 拿本地 key → 启动 VS Code
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { detectProxy } = require('./proxy');
const { startNineRouter, checkModels, stopManagedRouter, stopProcessTree, hasManagedRouter, PORT_DEFAULT } = require('./ninerouter');
const { ensureVscode, installExtension, installCodexExtension, launch, prependPath } = require('./vscode');
const { launchCodex } = require('./codex');
const { ensureNode, npmCliPath, ensureNpmGlobalLatest } = require('./node-runtime');
const { selectFastest } = require('./download');

const npmRegistries = [
  { name: '国内镜像', url: 'https://registry.npmmirror.com' },
  { name: '官方源', url: 'https://registry.npmjs.org' },
];

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

// 持有本进程拉起的 9router 子进程句柄，退出时收尾
let routerProc = null;
let routerRuntimeDir = null;

function readConfig(configPath) {
  try {
    const raw = fs.readFileSync(configPath, 'utf8').replace(/^﻿/, '');
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function writeConfig(configPath, runtimeDir, patch) {
  fs.mkdirSync(runtimeDir, { recursive: true });
  const merged = { ...readConfig(configPath), ...patch };
  fs.writeFileSync(configPath, JSON.stringify(merged, null, 4), 'utf8');
  return merged;
}

// ── 模式A：我们的 key（远程）启动 VS Code ──
// cfg 来自 .launcher.json（baseUrl/apiKey/model 已由客户端选中 key 时写好）
async function launchVscodeRemote(opts) {
  const { runtimeDir, launcherRoot, configPath, project } = opts;
  routerRuntimeDir = runtimeDir;
  const log = opts.onLog || (() => {});
  const onProgress = opts.onProgress || null;
  const proxy = detectProxy();

  const cfg = readConfig(configPath);
  if (!cfg.apiKey) throw new Error('未选择密钥，无法启动');

  const vsc = await ensureVscode(runtimeDir, proxy, log, { onProgress, dataDir: project && project.vscodeDataDir });
  await installExtension(vsc, proxy, log, onProgress);
  await installCodexExtension(vsc, proxy, log, onProgress);
  launch(vsc, cfg, runtimeDir, project ? project.path : launcherRoot, log, project);
  return { baseUrl: cfg.baseUrl, started: true };
}

// ── 模式B：本地 9router 启动 VS Code ──
async function launchVscodeLocal(opts) {
  const { runtimeDir, launcherRoot, configPath, project } = opts;
  routerRuntimeDir = runtimeDir;
  const log = opts.onLog || (() => {});
  const onProgress = opts.onProgress || null;
  const proxy = detectProxy();
  if (proxy) log(`检测到代理：${proxy}`);
  else log('未检测到系统代理（Kiro 账号需经代理连接 AWS，可能失败）');

  // 1. 起 9router，拿本地 baseUrl + key
  const router = await startNineRouter({ launcherRoot, runtimeDir, proxy, onLog: log, onProgress });
  if (router.proc) routerProc = router.proc;

  // 2. 本地连接信息写进 .launcher.json（model 用本地组合名）
  const cfg = writeConfig(configPath, runtimeDir, {
    baseUrl: router.baseUrl,
    apiKey: router.apiKey,
    model: 'claude-opus-4-8',
  });

  // 3. 启动 VS Code 连本地
  const vsc = await ensureVscode(runtimeDir, proxy, log, { onProgress, dataDir: project && project.vscodeDataDir });
  await installExtension(vsc, proxy, log, onProgress);
  await installCodexExtension(vsc, proxy, log, onProgress);
  launch(vsc, cfg, runtimeDir, project ? project.path : launcherRoot, log, project);

  return { baseUrl: router.baseUrl, lanUrl: router.lanUrl, apiKey: router.apiKey, started: true };
}

// 仅启动本地 9router（不开 VS Code），给"只想要个路由器"的用户
async function startLocalRouterOnly(opts) {
  const { runtimeDir, launcherRoot, configPath } = opts;
  routerRuntimeDir = runtimeDir;
  const log = opts.onLog || (() => {});
  const onProgress = opts.onProgress || null;
  const proxy = detectProxy();
  const router = await startNineRouter({ launcherRoot, runtimeDir, proxy, onLog: log, onProgress });
  if (router.proc) routerProc = router.proc;
  writeConfig(configPath, runtimeDir, { baseUrl: router.baseUrl, apiKey: router.apiKey, model: 'claude-opus-4-8' });
  return { baseUrl: router.baseUrl, lanUrl: router.lanUrl, apiKey: router.apiKey };
}

async function launchVscodeCodex(opts) {
  const { runtimeDir } = opts;
  routerRuntimeDir = runtimeDir;
  const log = opts.onLog || (() => {});
  const proxy = detectProxy();
  return launchCodex({ ...opts, proxy, onLog: log });
}

// 本地 9router 是否在跑
async function isLocalRouterRunning(port) {
  return checkModels(`http://127.0.0.1:${port || PORT_DEFAULT}`);
}

// ── 检查更新（手动触发）──
// 正常启动只复用本地已装的，不联网查版本；此函数专供"检查更新"按钮，
// 一次性联网检查并升级：npm 全局包（9router / claude-code / codex）+ VS Code 两个扩展。
async function checkForUpdates(opts) {
  const { runtimeDir } = opts;
  const log = opts.onLog || (() => {});
  const onProgress = opts.onProgress || null;
  const proxy = detectProxy();
  if (proxy) log(`检测到代理：${proxy}`);

  log('=== 开始检查更新 ===');

  // 1. npm 全局包（三个包都装进同一个 npm-global 前缀，一次搞定）
  const nodeDir = path.join(runtimeDir, 'node');
  const npmPrefix = path.join(runtimeDir, 'npm-global');
  const npmCache = path.join(runtimeDir, 'npm-cache');
  fs.mkdirSync(npmPrefix, { recursive: true });
  fs.mkdirSync(npmCache, { recursive: true });

  const nodeExe = await ensureNode(nodeDir, runtimeDir, proxy, log, onProgress);
  const env = { ...process.env };
  const nodeBin = os.platform() === 'win32' ? nodeDir : path.join(nodeDir, 'bin');
  const npmBin = os.platform() === 'win32' ? npmPrefix : path.join(npmPrefix, 'bin');
  prependPath(env, [nodeBin, npmBin]);
  const registry = await selectFastest('npm', npmRegistries, npmRegistries[0].url, proxy, log);
  const npmEnv = { ...env, npm_config_registry: registry, npm_config_prefix: npmPrefix, npm_config_cache: npmCache };
  if (proxy) { npmEnv.HTTP_PROXY = proxy; npmEnv.HTTPS_PROXY = proxy; }

  log('检查 npm 全局包更新（9router / claude-code / codex）…');
  await ensureNpmGlobalLatest({
    nodeExe,
    npmCli: npmCliPath(nodeDir),
    npmPrefix,
    env: npmEnv,
    pkgs: ['9router', '@anthropic-ai/claude-code', '@openai/codex'],
    log,
    checkUpdate: true,
    runner: (toInstall) => runNode(nodeExe, [npmCliPath(nodeDir), 'install', '-g', ...toInstall], npmEnv, log),
  });

  // 2. VS Code 两个扩展（强制拉 Marketplace 最新版）
  log('检查 VS Code 扩展更新（Claude Code / Codex）…');
  const vsc = await ensureVscode(runtimeDir, proxy, log, { onProgress });
  await installExtension(vsc, proxy, log, onProgress, true);
  await installCodexExtension(vsc, proxy, log, onProgress, true);

  log('=== 检查更新完成 ===');
  return { updated: true };
}

// 停掉本进程拉起的 9router
function stopLocalRouter() {
  if (routerProc && routerProc.exitCode === null) {
    stopProcessTree(routerProc);
    if (routerRuntimeDir) stopManagedRouter(routerRuntimeDir);
    routerProc = null;
    return { stopped: true };
  }
  const result = routerRuntimeDir ? stopManagedRouter(routerRuntimeDir) : { stopped: false };
  routerProc = null;
  return result;
}

// 把 creds/ 里的凭证导入运行中的 9router（调其 REST API，热生效、可重复）。
// 路由必须已在运行——本函数不负责拉起它，避免把一次"导入"变成重活。
async function importCredentials(opts) {
  const { runtimeDir, credsDir } = opts;
  const kiroCreds = require('./kiro-credentials');

  // 优先用本进程托管的实例地址；否则查 pid 文件里的托管状态。
  let baseUrl = null;
  const managed = hasManagedRouter(runtimeDir);
  if (managed?.baseUrl) baseUrl = managed.baseUrl;
  else if (managed?.port) baseUrl = `http://127.0.0.1:${managed.port}`;

  if (!baseUrl || !(await checkModels(baseUrl))) {
    throw new Error('本地 9router 未在运行，请先启动本地 9router 后再导入');
  }

  // 9router 管理 API（/api/*）认 x-9r-cli-token 头，不是 sk-9r key（后者只对 /v1 推理端点有效）。
  // token 由启动后现成的 machine-id + cli-secret 文件派生，与 9router 内部算法一致。
  const cliToken = deriveCliToken(runtimeDir);
  if (!cliToken) {
    throw new Error('无法派生 9router 管理令牌，请先完整启动一次本地 9router');
  }

  // 自动检测代理，导入时一并在 9router 建代理池并关联到连接（对齐旧 import_kiro.mjs）。
  const proxy = detectProxy();
  return kiroCreds.importToRouter(baseUrl, credsDir, cliToken, proxy);
}

// 派生 9router 管理 API 的 x-9r-cli-token，与 9router 内部 Xj('9r-cli-auth') 完全一致：
//   sha256(machineId + '9r-cli-auth' + cliSecret).slice(0,16)
// machineId / cliSecret 存于 DATA_DIR(=runtime/data) 下的文件，9router 启动后自动生成；
// 若尚未生成则按同样方式补齐——我们与 9router 读写同一份文件，派生结果必然一致。
function deriveCliToken(runtimeDir) {
  const crypto = require('crypto');
  const dataDir = path.join(runtimeDir, 'data');
  const midFile = path.join(dataDir, 'machine-id');
  const secFile = path.join(dataDir, 'auth', 'cli-secret');
  const rd = (p) => { try { return fs.readFileSync(p, 'utf8').trim(); } catch { return null; } };

  let machineId = rd(midFile);
  if (!machineId) {
    try { machineId = require('node-machine-id').machineIdSync(); }
    catch { machineId = crypto.randomUUID(); }
    try { fs.mkdirSync(dataDir, { recursive: true }); fs.writeFileSync(midFile, machineId, { mode: 0o600 }); } catch {}
  }

  let secret = rd(secFile);
  if (!secret) {
    secret = crypto.randomBytes(32).toString('hex');
    try { fs.mkdirSync(path.dirname(secFile), { recursive: true }); fs.writeFileSync(secFile, secret, { mode: 0o600 }); } catch {}
  }

  try {
    return crypto.createHash('sha256').update(machineId + '9r-cli-auth' + secret).digest('hex').substring(0, 16);
  } catch {
    return null;
  }
}

module.exports = {
  launchVscodeRemote,
  launchVscodeLocal,
  launchVscodeCodex,
  startLocalRouterOnly,
  isLocalRouterRunning,
  stopLocalRouter,
  checkForUpdates,
  importCredentials,
};
