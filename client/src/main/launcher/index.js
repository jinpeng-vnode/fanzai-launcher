// 总编排 — 把 9router 启动 + VS Code 启动串成对外两个高层动作
// 供 ipc.js 调用，渲染层通过 preload 触发
//
// 两种模式：
//   A. 我们的 key（LabPinky 远程）：直接拿 key 配 .launcher.json → 启动 VS Code
//   B. 本地 9router：起便携 Node24 + 9router（用客户自己的 Kiro 账号）→ 拿本地 key → 启动 VS Code
const fs = require('fs');
const path = require('path');
const { detectProxy } = require('./proxy');
const { startNineRouter, checkModels, stopManagedRouter, stopProcessTree, PORT_DEFAULT } = require('./ninerouter');
const { ensureVscode, installExtension, installCodexExtension, launch } = require('./vscode');
const { launchCodex } = require('./codex');

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

module.exports = {
  launchVscodeRemote,
  launchVscodeLocal,
  launchVscodeCodex,
  startLocalRouterOnly,
  isLocalRouterRunning,
  stopLocalRouter,
};
