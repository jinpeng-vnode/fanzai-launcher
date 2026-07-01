// 便携 VS Code 编排 — 对齐 setup-vscode.ps1，三平台
// 下载便携 VS Code → 装 Claude Code 扩展 → 注入 .launcher.json 的 baseUrl/key/model → 启动
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { selectFastest, downloadFile, extractZip, extractTarGz } = require('./download');
const { applyClaudeMcp } = require('./mcp');

const CLAUDE_EXT_ID = 'anthropic.claude-code';
const CODEX_EXT_ID = 'openai.chatgpt';
// Claude Code 的 ANTHROPIC_BASE_URL 会自动追加 /v1/messages，基址不能带 /v1
const DEFAULT_PUBLIC_BASE_URL = 'https://api.todonot.com';

// 兜底：万一传进来的基址带了 /v1，去掉它（Claude 用）
function stripV1(s) {
  return String(s || '').trim().replace(/\/+$/, '').replace(/\/v1$/i, '');
}

function withV1(s) {
  const base = stripV1(s);
  return base ? `${base}/v1` : base;
}

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

// 按平台算 VS Code 便携包下载信息 + 解压后可执行路径
function vscodeTarget() {
  const plat = os.platform();
  const arch = os.arch();
  if (plat === 'win32') {
    return {
      kind: 'zip',
      mirrors: [
        { name: '国内镜像', url: 'https://vscode.cdn.azure.cn/stable/latest/VSCode-win32-x64.zip' },
        { name: '官方源', url: 'https://update.code.visualstudio.com/latest/win32-x64-archive/stable' },
      ],
      fallback: 'https://update.code.visualstudio.com/latest/win32-x64-archive/stable',
      exeRel: 'Code.exe',
      cliRel: path.join('bin', 'code.cmd'),
    };
  }
  if (plat === 'darwin') {
    const a = arch === 'arm64' ? 'darwin-arm64' : 'darwin';
    return {
      kind: 'zip',
      mirrors: [{ name: '官方源', url: `https://update.code.visualstudio.com/latest/${a}/stable` }],
      fallback: `https://update.code.visualstudio.com/latest/${a}/stable`,
      // mac 解压出 Visual Studio Code.app
      exeRel: path.join('Visual Studio Code.app', 'Contents', 'Resources', 'app', 'bin', 'code'),
      cliRel: path.join('Visual Studio Code.app', 'Contents', 'Resources', 'app', 'bin', 'code'),
      appBundle: 'Visual Studio Code.app',
    };
  }
  // linux
  const a = arch === 'arm64' ? 'linux-arm64' : 'linux-x64';
  return {
    kind: 'targz',
    mirrors: [{ name: '官方源', url: `https://update.code.visualstudio.com/latest/${a}/stable` }],
    fallback: `https://update.code.visualstudio.com/latest/${a}/stable`,
    exeRel: 'bin/code',
    cliRel: 'bin/code',
  };
}

// 确保便携 VS Code 就绪，返回 { exe, cli, dataDir }
async function ensureVscode(runtimeDir, proxy, log = () => {}, opts = {}) {
  const disableAi = opts.disableAi !== false;
  const onProgress = opts.onProgress || null;
  const tgt = vscodeTarget();
  const vscodeDir = path.join(runtimeDir, 'vscode');
  const exe = path.join(vscodeDir, tgt.exeRel);
  const dataDir = opts.dataDir || path.join(vscodeDir, 'data');
  const extensionsDir = path.join(vscodeDir, 'extensions');

  if (fs.existsSync(vscodeDir) && !fs.existsSync(exe)) {
    log('检测到不完整 VS Code 目录，清理后重试');
    fs.rmSync(vscodeDir, { recursive: true, force: true });
  }

  if (!fs.existsSync(exe)) {
    const url = await selectFastest('VS Code', tgt.mirrors, tgt.fallback, proxy, log);
    log('下载便携 VS Code（约 130MB，请稍候）…');
    const archive = path.join(runtimeDir, tgt.kind === 'zip' ? 'vscode.zip' : 'vscode.tar.gz');
    await downloadFile(url, archive, proxy, (p) => onProgress && onProgress({ title: '下载 VS Code', ...p }));

    log('解压 VS Code…');
    fs.mkdirSync(vscodeDir, { recursive: true });
    if (tgt.kind === 'zip') await extractZip(archive, vscodeDir, (p) => onProgress && onProgress({ title: '解压 VS Code', ...p }));
    else await extractTarGz(archive, vscodeDir, (p) => onProgress && onProgress({ title: '解压 VS Code', ...p }));
    fs.rmSync(archive, { force: true });

    if (!fs.existsSync(exe)) throw new Error('VS Code 解压后未找到可执行文件');
    log('VS Code 解压完成');
  } else {
    log('VS Code 已就绪（复用）');
  }

  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(extensionsDir, { recursive: true });
  optimizePortableVscode(dataDir);
  if (disableAi) disableBuiltinAiFeatures(dataDir);
  else enableCodexAiFeatures(dataDir);
  return { exe, cli: path.join(vscodeDir, tgt.cliRel), dataDir, extensionsDir, vscodeDir };
}

function readJsonObject(filePath) {
  if (!fs.existsSync(filePath)) return {};
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8').replace(/^﻿/, ''));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function mergeTruthyMap(base, extra) {
  return { ...(base && typeof base === 'object' && !Array.isArray(base) ? base : {}), ...extra };
}

function optimizePortableVscode(dataDir) {
  try {
    const userDir = path.join(dataDir, 'user-data', 'User');
    fs.mkdirSync(userDir, { recursive: true });

    const settingsPath = path.join(userDir, 'settings.json');
    const settings = readJsonObject(settingsPath);
    const excludes = {
      '**/*': true,
      '**/.git/**': true,
      '**/.playwright-mcp/**': true,
      '**/node_modules/**': true,
      '**/runtime/**': true,
      '**/vendor/**': true,
      '**/*.log': true,
    };
    settings['files.watcherExclude'] = mergeTruthyMap(settings['files.watcherExclude'], excludes);
    settings['search.exclude'] = mergeTruthyMap(settings['search.exclude'], excludes);
    settings['files.exclude'] = mergeTruthyMap(settings['files.exclude'], {
      '**/runtime/vscode/data/**': true,
    });
    settings['extensions.autoCheckUpdates'] = false;
    settings['extensions.autoUpdate'] = false;
    settings['extensions.ignoreRecommendations'] = true;
    settings['telemetry.telemetryLevel'] = 'off';
    settings['update.mode'] = 'none';
    settings['workbench.enableExperiments'] = false;
    settings['workbench.settings.enableNaturalLanguageSearch'] = false;
    settings['workbench.localHistory.enabled'] = false;
    settings['workbench.editor.restoreViewState'] = false;
    settings['workbench.editorAssociations'] = mergeTruthyMap(settings['workbench.editorAssociations'], {
      '*.md': 'vscode.markdown.preview.editor',
    });
    settings['workbench.startupEditor'] = 'none';
    settings['breadcrumbs.enabled'] = false;
    settings['outline.showFiles'] = false;
    settings['problems.decorations.enabled'] = false;
    settings['scm.diffDecorations'] = 'none';
    settings['git.enabled'] = false;
    settings['git.autofetch'] = false;
    settings['git.autoRepositoryDetection'] = false;
    settings['typescript.disableAutomaticTypeAcquisition'] = true;
    settings['typescript.tsserver.experimental.enableProjectDiagnostics'] = false;
    settings['javascript.suggest.autoImports'] = false;
    settings['typescript.suggest.autoImports'] = false;
    settings['npm.autoDetect'] = 'off';
    settings['task.autoDetect'] = 'off';
    settings['debug.javascript.autoAttachFilter'] = 'disabled';
    settings['search.followSymlinks'] = false;
    settings['search.useGlobalIgnoreFiles'] = true;
    settings['search.useParentIgnoreFiles'] = true;
    settings['files.restoreUndoStack'] = false;
    settings['files.hotExit'] = 'off';
    settings['explorer.decorations.badges'] = false;
    settings['explorer.decorations.colors'] = false;
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf8');

    const argvPath = path.join(userDir, 'argv.json');
    const argv = readJsonObject(argvPath);
    argv['disable-hardware-acceleration'] = true;
    fs.writeFileSync(argvPath, JSON.stringify(argv, null, 2), 'utf8');
  } catch {}
}

function lightweightVscodeArgs(workdir, disabledExtensions = [], vsc = null) {
  const args = [
    '--new-window',
    '--disable-gpu',
    '--disable-telemetry',
    '--disable-updates',
    '--disable-workspace-trust',
    '--skip-release-notes',
    '--skip-welcome',
  ];
  if (vsc && vsc.dataDir) args.push('--user-data-dir', vsc.dataDir);
  if (vsc && vsc.extensionsDir) args.push('--extensions-dir', vsc.extensionsDir);
  for (const id of disabledExtensions) args.push('--disable-extension', id);
  args.push(workdir);
  return args;
}

function disableBuiltinAiFeatures(dataDir) {
  try {
    const userDir = path.join(dataDir, 'user-data', 'User');
    fs.mkdirSync(userDir, { recursive: true });
    const settingsPath = path.join(userDir, 'settings.json');
    let settings = readJsonObject(settingsPath);
    settings['chat.disableAIFeatures'] = true;
    settings['github.copilot.enable'] = {
      '*': false,
      plaintext: false,
      markdown: false,
      scminput: false,
    };
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf8');
  } catch {}
}

function enableCodexAiFeatures(dataDir) {
  try {
    const userDir = path.join(dataDir, 'user-data', 'User');
    fs.mkdirSync(userDir, { recursive: true });
    const settingsPath = path.join(userDir, 'settings.json');
    let settings = readJsonObject(settingsPath);
    settings['chat.disableAIFeatures'] = true;
    settings['github.copilot.enable'] = {
      '*': false,
      plaintext: false,
      markdown: false,
      scminput: false,
    };
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf8');
  } catch {}
}

function hasExtension(vsc, idPrefix) {
  const extDir = vsc.extensionsDir || path.join(vsc.dataDir, 'extensions');
  return fs.existsSync(extDir) && fs.readdirSync(extDir).some((d) => d.toLowerCase().startsWith(idPrefix.toLowerCase() + '-'));
}

function runExtensionCli(command, args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', (d) => { output += d; });
    child.stderr.on('data', (d) => { output += d; });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve(output);
      else reject(new Error((output || `${command} exited ${code}`).trim()));
    });
  });
}

async function installVsCodeExtension(vsc, extensionId, label, proxy, log = () => {}, onProgress = null, checkUpdate = false) {
  // 快速启动（checkUpdate=false）：磁盘上已有该扩展就直接复用，跳过联网的 Marketplace 检查。
  // 检查更新（checkUpdate=true）：用 --install-extension --force 联网安装/更新到最新版。
  // 首次启动（未装）无论哪种模式都会联网安装一次。
  if (!checkUpdate && hasExtension(vsc, extensionId)) {
    log(`${label} 扩展已就绪（复用，跳过更新检查）`);
    return;
  }
  log(`检查/更新 ${label} 扩展…`);
  try {
    onProgress && onProgress({ title: `安装 ${label} 扩展`, phase: 'install', percent: null, label: '正在检查更新…' });
  } catch {}
  const env = { ...process.env };
  if (proxy) { env.HTTP_PROXY = proxy; env.HTTPS_PROXY = proxy; }
  // 优先用 CLI shim（不弹主窗口）
  const cliExists = fs.existsSync(vsc.cli);
  try {
    const commonArgs = ['--user-data-dir', vsc.dataDir, '--extensions-dir', vsc.extensionsDir, '--install-extension', extensionId, '--force'];
    if (cliExists && os.platform() === 'win32') {
      await runExtensionCli('cmd', ['/c', vsc.cli, ...commonArgs], env);
    } else if (cliExists) {
      await runExtensionCli(vsc.cli, commonArgs, env);
    } else {
      await runExtensionCli(vsc.exe, commonArgs, env);
    }
    log(`${label} 扩展已安装`);
    try {
      onProgress && onProgress({ title: `安装 ${label} 扩展`, phase: 'install', percent: 100, label: '安装完成' });
    } catch {}
  } catch (e) {
    log(`${label} 扩展安装失败（可重试）：` + (e.message || e));
    try {
      onProgress && onProgress({ title: `安装 ${label} 扩展`, phase: 'install', percent: 100, label: '安装失败，可重试' });
    } catch {}
  }
}

// 装 Claude Code 扩展（用 CLI 入口，避免弹出 GUI 窗口）
async function installExtension(vsc, proxy, log = () => {}, onProgress = null, checkUpdate = false) {
  await installVsCodeExtension(vsc, CLAUDE_EXT_ID, 'Claude Code', proxy, log, onProgress, checkUpdate);
}

async function installCodexExtension(vsc, proxy, log = () => {}, onProgress = null, checkUpdate = false) {
  await installVsCodeExtension(vsc, CODEX_EXT_ID, 'Codex', proxy, log, onProgress, checkUpdate);
}

function spawnVscode(vsc, args, env) {
  if (os.platform() === 'win32' && vsc.cli && fs.existsSync(vsc.cli)) {
    return spawn('cmd', ['/c', vsc.cli, ...args], { env, detached: true, stdio: 'ignore' });
  }
  if (os.platform() !== 'darwin' && vsc.cli && fs.existsSync(vsc.cli)) {
    return spawn(vsc.cli, args, { env, detached: true, stdio: 'ignore' });
  }
  return spawn(vsc.exe, args, { env, detached: true, stdio: 'ignore' });
}

// 启动 VS Code，注入 9router/labpinky 的连接环境变量
// cfg: { baseUrl, apiKey, model }；workdir：VS Code 打开的目录（启动包根）
function launch(vsc, cfg, runtimeDir, workdir, log = () => {}, project = null) {
  const env = { ...process.env };
  env.ANTHROPIC_BASE_URL = stripV1(cfg.baseUrl) || DEFAULT_PUBLIC_BASE_URL;
  if (cfg.apiKey) { env.ANTHROPIC_AUTH_TOKEN = cfg.apiKey; env.ANTHROPIC_API_KEY = cfg.apiKey; }
  if (cfg.apiKey) env.OPENAI_API_KEY = cfg.apiKey;
  env.OPENAI_BASE_URL = withV1(cfg.baseUrl) || withV1(DEFAULT_PUBLIC_BASE_URL);
  if (cfg.model) {
    env.ANTHROPIC_MODEL = cfg.model;
    env.ANTHROPIC_DEFAULT_OPUS_MODEL = cfg.model;
    env.ANTHROPIC_DEFAULT_SONNET_MODEL = cfg.model;
    env.ANTHROPIC_DEFAULT_HAIKU_MODEL = cfg.model;
    env.CLAUDE_CODE_SUBAGENT_MODEL = cfg.model;
    env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1';
    env.OPENAI_MODEL = cfg.model;
  }
  env.CLAUDE_CONFIG_DIR = project && project.claudeConfigDir
    ? project.claudeConfigDir
    : path.join(runtimeDir, 'claude-config');

  // ★ 关键：把选中的 key/地址同步进 settings.json 的 env 块。
  // Claude Code 扩展读 settings.json 的 env 优先级高于进程环境变量，
  // 若这里残留旧 token，会盖掉我们切换的 key（切 key 不生效的根因）。
  syncSettingsJson(env.CLAUDE_CONFIG_DIR, cfg);
  applyClaudeMcp(workdir, path.join(runtimeDir, 'mcp-settings.json'), log);

  // PATH 前置便携 node / npm-global，便于扩展内置 CLI 找到 claude
  const nodeBin = os.platform() === 'win32' ? path.join(runtimeDir, 'node') : path.join(runtimeDir, 'node', 'bin');
  const npmBin = os.platform() === 'win32' ? path.join(runtimeDir, 'npm-global') : path.join(runtimeDir, 'npm-global', 'bin');
  prependPath(env, [nodeBin, npmBin]);
  // 关键：清掉 ELECTRON_RUN_AS_NODE，否则 VS Code(Electron) 退化成纯 node 起不来
  delete env.ELECTRON_RUN_AS_NODE;

  // 清理可能残留的 ide lock
  const ideDir = path.join(env.CLAUDE_CONFIG_DIR, 'ide');
  try {
    if (fs.existsSync(ideDir)) {
      for (const f of fs.readdirSync(ideDir)) if (f.endsWith('.lock')) fs.rmSync(path.join(ideDir, f), { force: true });
    }
  } catch {}

  log(`启动 VS Code（连接 ${env.ANTHROPIC_BASE_URL}）…`);
  // mac 用 open -a 启动 .app；win/linux 直接跑可执行
  let child;
  if (os.platform() === 'darwin' && vsc.vscodeDir) {
    const appPath = path.join(vsc.vscodeDir, 'Visual Studio Code.app');
    child = spawn('open', ['-a', appPath, '--args', ...lightweightVscodeArgs(workdir, [], vsc)], { env, detached: true, stdio: 'ignore' });
  } else {
    child = spawnVscode(vsc, lightweightVscodeArgs(workdir, [], vsc), env);
  }
  child.on('error', (e) => log('VS Code 启动失败：' + (e && e.message || e)));
  child.unref();
  log('VS Code 已启动');
}

// 把选中的连接信息同步进 claude-config/settings.json 的 env 块。
// Claude Code 扩展优先读 settings.json 的 env，必须在这里更新，否则切 key 不生效。
// 保留 modelOverrides / permissions 等其他既有配置，只覆盖与连接相关的字段。
function syncSettingsJson(claudeCfgDir, cfg) {
  try {
    fs.mkdirSync(claudeCfgDir, { recursive: true });
    const p = path.join(claudeCfgDir, 'settings.json');
    let settings = {};
    if (fs.existsSync(p)) {
      try { settings = JSON.parse(fs.readFileSync(p, 'utf8').replace(/^﻿/, '')); } catch { settings = {}; }
    }
    settings.env = settings.env || {};
    const e = settings.env;
    const key = cfg.apiKey || '';
    const baseUrl = stripV1(cfg.baseUrl) || DEFAULT_PUBLIC_BASE_URL;
    const model = cfg.model || '';

    e.ANTHROPIC_BASE_URL = baseUrl;
    if (key) { e.ANTHROPIC_AUTH_TOKEN = key; e.ANTHROPIC_API_KEY = key; }
    else { delete e.ANTHROPIC_AUTH_TOKEN; delete e.ANTHROPIC_API_KEY; }
    if (model) {
      e.ANTHROPIC_MODEL = model;
      e.ANTHROPIC_DEFAULT_OPUS_MODEL = model;
      e.ANTHROPIC_DEFAULT_SONNET_MODEL = model;
      e.ANTHROPIC_DEFAULT_HAIKU_MODEL = model;
      e.CLAUDE_CODE_SUBAGENT_MODEL = model;
      e.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1';
    }
    fs.writeFileSync(p, JSON.stringify(settings, null, 2), 'utf8');
  } catch { /* settings 同步失败不阻塞启动，进程 env 仍是兜底 */ }
}

module.exports = { ensureVscode, installExtension, installCodexExtension, launch, prependPath, lightweightVscodeArgs, syncSettingsJson, spawnVscode };
