const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { ensureNode, npmCliPath, ensureNpmGlobalLatest } = require('./node-runtime');
const { ensureVscode, installExtension, installCodexExtension, prependPath, lightweightVscodeArgs, syncSettingsJson, spawnVscode } = require('./vscode');
const { selectFastest } = require('./download');
const { upsertCodexMcp } = require('./mcp');

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

function codexCmdPath(npmPrefix) {
  if (os.platform() === 'win32') return path.join(npmPrefix, 'codex.cmd');
  return path.join(npmPrefix, 'bin', 'codex');
}

async function ensureCodexCli(runtimeDir, proxy, log = () => {}, onProgress = null) {
  const nodeDir = path.join(runtimeDir, 'node');
  const npmPrefix = path.join(runtimeDir, 'npm-global');
  const npmCache = path.join(runtimeDir, 'npm-cache');
  fs.mkdirSync(npmPrefix, { recursive: true });
  fs.mkdirSync(npmCache, { recursive: true });

  const nodeExe = await ensureNode(nodeDir, runtimeDir, proxy, log, onProgress);
  const codexCmd = codexCmdPath(npmPrefix);

  const env = { ...process.env };
  const nodeBin = os.platform() === 'win32' ? nodeDir : path.join(nodeDir, 'bin');
  const npmBin = os.platform() === 'win32' ? npmPrefix : path.join(npmPrefix, 'bin');
  prependPath(env, [nodeBin, npmBin]);
  const registry = await selectFastest('npm', npmRegistries, npmRegistries[0].url, proxy, log);
  env.npm_config_registry = registry;
  env.npm_config_prefix = npmPrefix;
  env.npm_config_cache = npmCache;
  if (proxy) { env.HTTP_PROXY = proxy; env.HTTPS_PROXY = proxy; }

  // 每次启动校验版本，有新版自动更新
  await ensureNpmGlobalLatest({
    nodeExe,
    npmCli: npmCliPath(nodeDir),
    npmPrefix,
    env,
    pkgs: ['@openai/codex'],
    log,
    runner: (toInstall) => runNode(nodeExe, [npmCliPath(nodeDir), 'install', '-g', ...toInstall], env, log),
  });
  if (!fs.existsSync(codexCmd)) throw new Error('Codex CLI 安装失败');
  return { nodeExe, codexCmd };
}

function ensureCodexHome(runtimeDir, project = null) {
  const codexHome = project && project.codexHome
    ? project.codexHome
    : path.join(runtimeDir, 'codex-home');
  fs.mkdirSync(codexHome, { recursive: true });
  const configPath = path.join(codexHome, 'config.toml');
  if (!fs.existsSync(configPath)) {
    fs.writeFileSync(configPath, [
      '# Codex launcher managed config',
      'model = "gpt-5.1-codex-max"',
      '',
    ].join('\n'), 'utf8');
  }
  return codexHome;
}

function writeManualCodexConfig(codexHome, manual, log = () => {}) {
  if (!manual || !manual.apiKey) return;
  const model = manual.model || 'gpt-5.1-codex-max';
  const providerId = 'manual_api';
  const configPath = path.join(codexHome, 'config.toml');
  const lines = [
    '# Codex launcher managed config',
    `model = ${JSON.stringify(model)}`,
    `model_provider = ${JSON.stringify(providerId)}`,
    'preferred_auth_method = "apikey"',
    '',
    '[model_providers.manual_api]',
    'name = "Manual API"',
    `base_url = ${JSON.stringify(manual.baseUrl)}`,
    'env_key = "OPENAI_API_KEY"',
    'wire_api = "responses"',
    '',
  ];
  fs.writeFileSync(configPath, lines.join('\n'), 'utf8');
  log('Codex 手动 API 配置已写入');
}

async function launchCodex(opts) {
  const { runtimeDir, launcherRoot, project } = opts;
  const log = opts.onLog || (() => {});
  const onProgress = opts.onProgress || null;
  const proxy = opts.proxy || null;
  const codexHome = ensureCodexHome(runtimeDir, project);
  writeManualCodexConfig(codexHome, opts.manualCodex, log);
  upsertCodexMcp(path.join(codexHome, 'config.toml'), path.join(runtimeDir, 'mcp-settings.json'), launcherRoot, log);
  await ensureCodexCli(runtimeDir, proxy, log, onProgress);
  const vsc = await ensureVscode(runtimeDir, proxy, log, {
    disableAi: false,
    onProgress,
    dataDir: project && project.vscodeDataDir,
  });
  await installExtension(vsc, proxy, log, onProgress);
  await installCodexExtension(vsc, proxy, log, onProgress);

  const env = { ...process.env };
  env.CODEX_HOME = codexHome;
  env.CLAUDE_CONFIG_DIR = project && project.claudeConfigDir
    ? project.claudeConfigDir
    : path.join(runtimeDir, 'claude-config');
  const nodeBin = os.platform() === 'win32' ? path.join(runtimeDir, 'node') : path.join(runtimeDir, 'node', 'bin');
  const npmBin = os.platform() === 'win32' ? path.join(runtimeDir, 'npm-global') : path.join(runtimeDir, 'npm-global', 'bin');
  prependPath(env, [nodeBin, npmBin]);
  if (opts.manualCodex && opts.manualCodex.apiKey) {
    env.OPENAI_API_KEY = opts.manualCodex.apiKey;
    env.OPENAI_BASE_URL = opts.manualCodex.baseUrl;
    env.OPENAI_MODEL = opts.manualCodex.model || '';
    env.ANTHROPIC_BASE_URL = String(opts.manualCodex.baseUrl || '').replace(/\/+$/, '').replace(/\/v1$/i, '');
    env.ANTHROPIC_AUTH_TOKEN = opts.manualCodex.apiKey;
    env.ANTHROPIC_API_KEY = opts.manualCodex.apiKey;
    if (opts.manualCodex.model) {
      env.ANTHROPIC_MODEL = opts.manualCodex.model;
      env.ANTHROPIC_DEFAULT_OPUS_MODEL = opts.manualCodex.model;
      env.ANTHROPIC_DEFAULT_SONNET_MODEL = opts.manualCodex.model;
      env.ANTHROPIC_DEFAULT_HAIKU_MODEL = opts.manualCodex.model;
      env.CLAUDE_CODE_SUBAGENT_MODEL = opts.manualCodex.model;
      env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1';
    }
    syncSettingsJson(env.CLAUDE_CONFIG_DIR, {
      baseUrl: env.ANTHROPIC_BASE_URL,
      apiKey: opts.manualCodex.apiKey,
      model: opts.manualCodex.model,
    });
  }
  delete env.ELECTRON_RUN_AS_NODE;
  if (proxy) { env.HTTP_PROXY = proxy; env.HTTPS_PROXY = proxy; }

  log('启动 VS Code（Codex 模式）…');
  let child;
  if (os.platform() === 'darwin' && vsc.vscodeDir) {
    const appPath = path.join(vsc.vscodeDir, 'Visual Studio Code.app');
    child = spawn('open', ['-a', appPath, '--args', ...lightweightVscodeArgs(project ? project.path : launcherRoot, [], vsc)], { env, detached: true, stdio: 'ignore' });
  } else {
    child = spawnVscode(vsc, lightweightVscodeArgs(project ? project.path : launcherRoot, [], vsc), env);
  }
  child.on('error', (e) => log('VS Code 启动失败：' + (e && e.message || e)));
  child.unref();
  log('VS Code 已启动，Codex 首次使用需要 ChatGPT 或 API Key 登录');
  return { started: true, codexHome };
}

module.exports = { launchCodex, ensureCodexCli, ensureCodexHome };
