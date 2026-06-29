// IPC 处理 — 渲染层通过 preload 白名单调用这些能力
const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { shell } = require('electron');
const { LAUNCHER_ROOT, RUNTIME_DIR, CONFIG_PATH, KEYS_PATH, MCP_SETTINGS_PATH, SETUP_VSCODE_PS1 } = require('./paths');
const launcher = require('./launcher');
const mcp = require('./launcher/mcp');
const log = require('./logger');
const { selectProjectRuntime } = require('./project-runtime');

// LabPinky / 9Router key 用量查询端点（已验证可用）
const KEY_STATUS_URL = 'https://xapi.labpinky.com/api/public/key-status';

// 店铺地址（自动售卖，购买/续费 key）
const SHOP_URL = 'https://pay.ldxp.cn/shop/BUX1PQH9';
// 默认基址：统一存"不带 /v1"，使用时按需追加（Claude 不加、OpenAI 风格端点加）
const DEFAULT_PUBLIC_BASE_URL = 'https://api.todonot.com';
const REMOTE_BASE_URL = DEFAULT_PUBLIC_BASE_URL;
const REMOTE_MODEL = 'kr/claude-opus-4.8';

function trimTrailingSlash(s) {
  return String(s || '').trim().replace(/\/+$/, '');
}

// 去掉末尾的 /v1（及多余斜杠）→ 得到"干净基址"。
// Claude Code 的 ANTHROPIC_BASE_URL 会自动追加 /v1/messages，
// 若基址本身带 /v1 会变成 /v1/v1/messages 导致模型访问失败，所以统一存"不带 /v1"的基址。
function stripV1(s) {
  return trimTrailingSlash(s).replace(/\/v1$/i, '');
}

// 在干净基址上追加 /v1 → 供 OpenAI 风格端点（/v1/models、/v1/chat/completions、Codex）使用
function withV1(s) {
  const base = stripV1(s);
  return base ? `${base}/v1` : base;
}

function assertHttpUrl(urlText) {
  let url;
  try { url = new URL(String(urlText || '').trim()); } catch { throw new Error('链接格式不正确'); }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('只允许打开 http/https 链接');
  return url.toString();
}

function manualBaseCandidates(baseUrl) {
  const base = trimTrailingSlash(baseUrl) || DEFAULT_PUBLIC_BASE_URL;
  const withoutV1 = base.replace(/\/v1$/i, '');
  const withV1 = /\/v1$/i.test(base) ? base : `${base}/v1`;
  return [...new Set([withV1, base, withoutV1])];
}

function requestJson(urlText, { apiKey, method = 'GET', body, timeout = 18000 } = {}) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(urlText); } catch { return reject(new Error('API 地址格式不正确')); }
    const lib = u.protocol === 'http:' ? require('http') : https;
    const payload = body ? JSON.stringify(body) : '';
    const req = lib.request(
      {
        protocol: u.protocol,
        hostname: u.hostname,
        port: u.port || undefined,
        path: u.pathname + u.search,
        method,
        headers: {
          accept: 'application/json',
          ...(payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}),
          ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
        },
        timeout,
      },
      (res) => {
        let text = '';
        res.on('data', (c) => { text += c; });
        res.on('end', () => {
          let json = null;
          try { json = text ? JSON.parse(text) : null; } catch {}
          if (res.statusCode < 200 || res.statusCode >= 300) {
            const msg = json && (json.error?.message || json.message || json.msg);
            reject(new Error(msg || `HTTP ${res.statusCode}`));
            return;
          }
          const contentType = String(res.headers['content-type'] || '').toLowerCase();
          if (!json || Array.isArray(json) || typeof json !== 'object') {
            const preview = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 120);
            reject(new Error(`接口返回的不是 JSON（HTTP ${res.statusCode}${contentType ? `, ${contentType}` : ''}）${preview ? `：${preview}` : ''}`));
            return;
          }
          resolve(json);
        });
      }
    );
    req.on('timeout', () => req.destroy(new Error('请求超时')));
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function normalizeModels(json) {
  const raw = Array.isArray(json?.data) ? json.data : Array.isArray(json?.models) ? json.models : [];
  return [...new Set(raw.map((m) => String(m.id || m.name || m.model || m).trim()).filter(Boolean))].sort();
}

async function fetchManualModels(input = {}) {
  const apiKey = String(input.apiKey || '').trim();
  if (!apiKey) throw new Error('API Key 不能为空');
  let lastError = null;
  for (const baseUrl of manualBaseCandidates(input.baseUrl)) {
    try {
      const json = await requestJson(`${baseUrl}/models`, { apiKey });
      const models = normalizeModels(json);
      if (!models.length) throw new Error('接口返回成功，但没有识别到模型列表');
      return { baseUrl, models, rawCount: Array.isArray(json?.data) ? json.data.length : 0 };
    } catch (e) {
      lastError = e;
    }
  }
  throw new Error(`模型列表获取失败：${lastError ? lastError.message : '未知错误'}`);
}

function extractModelReply(json) {
  return json?.choices?.[0]?.message?.content
    || json?.choices?.[0]?.text
    || json?.output_text
    || json?.output?.flatMap((o) => o.content || []).map((c) => c.text || '').join('').trim()
    || '';
}

async function testManualModel(input = {}) {
  const apiKey = String(input.apiKey || '').trim();
  const model = String(input.model || input.claudeModel || input.codexModel || '').trim();
  if (!apiKey) throw new Error('API Key 不能为空');
  if (!model) throw new Error('请先选择或填写模型');
  const prompt = 'Reply with exactly: OK';
  let lastError = null;
  for (const baseUrl of manualBaseCandidates(input.baseUrl)) {
    try {
      const json = await requestJson(`${baseUrl}/chat/completions`, {
        apiKey,
        method: 'POST',
        body: {
          model,
          messages: [{ role: 'user', content: prompt }],
          max_tokens: 16,
          temperature: 0,
        },
        timeout: 90000,
      });
      if (!Array.isArray(json?.choices) && !json?.output && !json?.output_text) {
        throw new Error('接口返回成功，但不是聊天补全结果');
      }
      return { baseUrl, model, endpoint: 'chat/completions', reply: extractModelReply(json) };
    } catch (e) {
      lastError = e;
    }
    try {
      const json = await requestJson(`${baseUrl}/responses`, {
        apiKey,
        method: 'POST',
        body: { model, input: prompt, max_output_tokens: 16 },
        timeout: 90000,
      });
      if (!Array.isArray(json?.output) && !json?.output_text && !Array.isArray(json?.choices)) {
        throw new Error('接口返回成功，但不是 responses 结果');
      }
      return { baseUrl, model, endpoint: 'responses', reply: extractModelReply(json) };
    } catch (e) {
      lastError = e;
    }
  }
  throw new Error(`模型检测失败：${lastError ? lastError.message : '未知错误'}`);
}

// ── 配置读写（.launcher.json，与 setup-vscode.ps1 共用）──
function readConfig() {
  try {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf8').replace(/^﻿/, '');
    return JSON.parse(raw);
  } catch {
    return { baseUrl: REMOTE_BASE_URL, apiKey: '', model: REMOTE_MODEL };
  }
}

function writeConfig(cfg) {
  fs.mkdirSync(RUNTIME_DIR, { recursive: true });
  const merged = { ...readConfig(), ...cfg };
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(merged, null, 4), 'utf8');
  return merged;
}

// ── 多 key 仓库（keys.json）──
// 结构：{ activeId, keys: [{ id, kind, label, value, prefix, baseUrl, model, models }] }
function readKeys() {
  try {
    const raw = fs.readFileSync(KEYS_PATH, 'utf8').replace(/^﻿/, '');
    const data = JSON.parse(raw);
    if (!Array.isArray(data.keys)) data.keys = [];
    data.keys = data.keys.map(normalizeStoredKey).filter(Boolean);
    return data;
  } catch {
    return { activeId: '', keys: [] };
  }
}

function persistKeys(store) {
  fs.mkdirSync(RUNTIME_DIR, { recursive: true });
  fs.writeFileSync(KEYS_PATH, JSON.stringify(store, null, 2), 'utf8');
  return store;
}

const keyPrefix = (v) => (v || '').slice(0, 10);

function normalizeStoredKey(k) {
  if (!k || typeof k !== 'object') return null;
  const value = String(k.value || '').trim();
  if (!value) return null;
  const kind = k.kind === 'manual' ? 'manual' : 'remote';
  const prefix = keyPrefix(value);
  const label = String(k.label || '').trim() || `${prefix}…`;
  return {
    id: String(k.id || crypto.randomUUID()),
    kind,
    label,
    value,
    prefix,
    baseUrl: kind === 'manual' ? stripV1(k.baseUrl) || DEFAULT_PUBLIC_BASE_URL : '',
    // 兼容旧数据：claudeModel/codexModel 合并为单个 model
    model: kind === 'manual' ? String(k.model || k.claudeModel || k.codexModel || '').trim() : '',
    models: kind === 'manual' && Array.isArray(k.models)
      ? [...new Set(k.models.map((m) => String(m).trim()).filter(Boolean))]
      : [],
  };
}

// 添加 key（去重：相同 value 不重复添加，返回其 id）
function addKey(value, label) {
  value = (value || '').trim();
  if (!value) throw new Error('API Key 为空');
  const store = readKeys();
  let found = store.keys.find((k) => k.kind === 'remote' && k.value === value);
  if (!found) {
    found = {
      id: crypto.randomUUID(),
      kind: 'remote',
      label: (label || '').trim() || keyPrefix(value) + '…',
      value,
      prefix: keyPrefix(value),
      baseUrl: '',
      model: '',
      models: [],
    };
    store.keys.push(found);
  }
  // 新增即选中；首个 key 自动选中
  store.activeId = found.id;
  persistKeys(store);
  // 同步写进 .launcher.json，供 setup-vscode.ps1 启动用
  writeConfig({ baseUrl: REMOTE_BASE_URL, apiKey: value, model: REMOTE_MODEL });
  return { store, activeId: found.id };
}

function upsertManualKey(input = {}) {
  const cfg = normalizeManualConfig(input);
  const store = readKeys();
  let entry = null;
  if (input.id) entry = store.keys.find((k) => k.id === input.id);
  if (!entry) {
    entry = store.keys.find((k) => k.kind === 'manual' && k.value === cfg.apiKey && k.baseUrl === cfg.baseUrl);
  }
  const models = Array.isArray(input.models)
    ? [...new Set(input.models.map((m) => String(m).trim()).filter(Boolean))]
    : (entry && Array.isArray(entry.models) ? entry.models : []);
  const label = String(input.label || '').trim() || `${new URL(cfg.baseUrl).hostname} · ${keyPrefix(cfg.apiKey)}…`;
  if (entry) {
    Object.assign(entry, {
      kind: 'manual',
      label,
      value: cfg.apiKey,
      prefix: keyPrefix(cfg.apiKey),
      baseUrl: cfg.baseUrl,
      model: cfg.model,
      models,
    });
  } else {
    entry = {
      id: crypto.randomUUID(),
      kind: 'manual',
      label,
      value: cfg.apiKey,
      prefix: keyPrefix(cfg.apiKey),
      baseUrl: cfg.baseUrl,
      model: cfg.model,
      models,
    };
    store.keys.push(entry);
  }
  store.activeId = entry.id;
  persistKeys(store);
  writeConfig({ baseUrl: cfg.baseUrl, apiKey: cfg.apiKey, model: cfg.model });
  return { store, activeId: entry.id, key: entry };
}

function removeKey(id) {
  const store = readKeys();
  store.keys = store.keys.filter((k) => k.id !== id);
  if (store.activeId === id) {
    store.activeId = store.keys[0] ? store.keys[0].id : '';
    const next = store.keys[0];
    if (next && next.kind === 'manual') writeConfig({ baseUrl: next.baseUrl, apiKey: next.value, model: next.model });
    else writeConfig({ baseUrl: REMOTE_BASE_URL, apiKey: next ? next.value : '', model: REMOTE_MODEL });
  }
  persistKeys(store);
  return store;
}

function selectKey(id) {
  const store = readKeys();
  const k = store.keys.find((x) => x.id === id);
  if (!k) throw new Error('密钥不存在');
  store.activeId = id;
  persistKeys(store);
  if (k.kind === 'manual') {
    writeConfig({ baseUrl: k.baseUrl, apiKey: k.value, model: k.model });
  } else {
    writeConfig({ baseUrl: REMOTE_BASE_URL, apiKey: k.value, model: REMOTE_MODEL });   // 切换即生效：启动 VS Code 用这个
  }
  return store;
}

// ── 查询 key 用量/余额 ──
function fetchKeyStatus(apiKey) {
  return new Promise((resolve, reject) => {
    if (!apiKey) return reject(new Error('API Key 为空'));
    const u = new URL(KEY_STATUS_URL);
    const req = https.request(
      {
        hostname: u.hostname,
        path: u.pathname + u.search,
        method: 'POST',
        headers: {
          'authorization': `Bearer ${apiKey}`,
          'content-length': 0,
          'accept': '*/*',
        },
        timeout: 12000,
      },
      (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => {
          try {
            const json = JSON.parse(body);
            if (json.code !== 0) return reject(new Error(json.message || '查询失败'));
            resolve(json.data);
          } catch (e) {
            reject(new Error(`解析失败 (HTTP ${res.statusCode})`));
          }
        });
      }
    );
    req.on('timeout', () => req.destroy(new Error('请求超时')));
    req.on('error', reject);
    req.end();
  });
}

// ── 设备指纹采集（第一版：稳定硬件标识哈希；GPU 深度指纹后续在渲染层用 WebGL 补充）──
function collectFingerprint() {
  const cpus = os.cpus();
  const parts = {
    platform: os.platform(),
    arch: os.arch(),
    hostname: os.hostname(),
    cpuModel: cpus[0] ? cpus[0].model : '',
    cpuCount: cpus.length,
    totalMem: os.totalmem(),
    // 网卡 MAC（取第一个非内网回环的）
    mac: (() => {
      const ifaces = os.networkInterfaces();
      for (const name of Object.keys(ifaces)) {
        for (const ni of ifaces[name] || []) {
          if (!ni.internal && ni.mac && ni.mac !== '00:00:00:00:00:00') return ni.mac;
        }
      }
      return '';
    })(),
    user: os.userInfo().username,
  };
  const raw = JSON.stringify(parts);
  const deviceId = crypto.createHash('sha256').update(raw).digest('hex');
  return { deviceId, parts };
}

// ── 启动 VS Code（跨平台 JS 编排，三平台共用，不再依赖 .ps1）──
// 日志：同时写进 client.log（落盘留底）+ 推给渲染层（用户可见进度）
function makeLogger(getWindow) {
  return (line) => {
    log.step(String(line));   // 落盘 + 转发渲染层（logger.attachRenderer 已接好）
    try { getWindow()?.webContents.send('launch:log', String(line)); } catch {}
  };
}

function makeProgress(getWindow) {
  return (payload) => {
    try { getWindow()?.webContents.send('launch:progress', payload); } catch {}
  };
}

function handleLaunchError(label, e) {
  if (e && e.code === 'PROJECT_SELECT_CANCELED') return { canceled: true };
  log.error(label, e);
  throw e;
}

// 模式A：我们的 key（远程 LabPinky）→ 直接连
async function launchVscodeRemote(getWindow) {
  log.step('=== 启动：我们的密钥（远程）===');
  try {
    const project = await selectProjectRuntime(RUNTIME_DIR, getWindow, makeLogger(getWindow));
    return await launcher.launchVscodeRemote({
      runtimeDir: RUNTIME_DIR, launcherRoot: LAUNCHER_ROOT, configPath: CONFIG_PATH,
      project,
      onLog: makeLogger(getWindow),
      onProgress: makeProgress(getWindow),
    });
  } catch (e) { return handleLaunchError('远程启动失败', e); }
}

// 模式B：本地 9router（用客户自己的 Kiro 账号）→ 起路由器再连
async function launchVscodeLocal(getWindow) {
  log.step('=== 启动：本地 9Router + VS Code ===');
  try {
    const project = await selectProjectRuntime(RUNTIME_DIR, getWindow, makeLogger(getWindow));
    return await launcher.launchVscodeLocal({
      runtimeDir: RUNTIME_DIR, launcherRoot: LAUNCHER_ROOT, configPath: CONFIG_PATH,
      project,
      onLog: makeLogger(getWindow),
      onProgress: makeProgress(getWindow),
    });
  } catch (e) { return handleLaunchError('本地 9Router 启动失败', e); }
}

// 只起本地 9router（不开 VS Code）—— 给"只想要路由器"的留存用户
async function startLocalRouterOnly(getWindow) {
  log.step('=== 启动：仅本地 9Router ===');
  try {
    return await launcher.startLocalRouterOnly({
      runtimeDir: RUNTIME_DIR, launcherRoot: LAUNCHER_ROOT, configPath: CONFIG_PATH,
      onLog: makeLogger(getWindow),
      onProgress: makeProgress(getWindow),
    });
  } catch (e) { return handleLaunchError('仅启动 9Router 失败', e); }
}

async function launchVscodeCodex(getWindow) {
  log.step('=== 启动：Codex ===');
  try {
    const project = await selectProjectRuntime(RUNTIME_DIR, getWindow, makeLogger(getWindow));
    return await launcher.launchVscodeCodex({
      runtimeDir: RUNTIME_DIR, launcherRoot: LAUNCHER_ROOT, configPath: CONFIG_PATH,
      project,
      onLog: makeLogger(getWindow),
      onProgress: makeProgress(getWindow),
    });
  } catch (e) { return handleLaunchError('Codex 启动失败', e); }
}

function normalizeManualConfig(cfg = {}) {
  // 统一存"干净基址"（去掉用户可能手填的 /v1），启动时按工具按需追加
  const baseUrl = stripV1(cfg.baseUrl) || DEFAULT_PUBLIC_BASE_URL;
  const apiKey = String(cfg.apiKey || '').trim();
  // claudeModel/codexModel 合并为单个 model；保留旧字段读取以兼容已存配置
  const model = String(cfg.model || cfg.claudeModel || cfg.codexModel || '').trim()
    || (baseUrl.includes('xapi.labpinky.com') || baseUrl.includes('api.todonot.com') ? 'kr/claude-opus-4.8' : 'gpt-5.1-codex-max');
  if (!apiKey) throw new Error('API Key 不能为空');
  return { baseUrl, apiKey, model };
}

async function launchManualClaude(getWindow, input) {
  log.step('=== 启动：手动 API + Claude Code ===');
  const cfg = normalizeManualConfig(input);
  try {
    const project = await selectProjectRuntime(RUNTIME_DIR, getWindow, makeLogger(getWindow));
    // Claude Code：直接用干净基址（SDK 自动追加 /v1/messages）
    writeConfig({ baseUrl: cfg.baseUrl, apiKey: cfg.apiKey, model: cfg.model });
    return await launcher.launchVscodeRemote({
      runtimeDir: RUNTIME_DIR, launcherRoot: LAUNCHER_ROOT, configPath: CONFIG_PATH,
      project,
      onLog: makeLogger(getWindow),
      onProgress: makeProgress(getWindow),
    });
  } catch (e) { return handleLaunchError('手动 Claude Code 启动失败', e); }
}

async function launchManualCodex(getWindow, input) {
  log.step('=== 启动：手动 API + Codex ===');
  const cfg = normalizeManualConfig(input);
  try {
    const project = await selectProjectRuntime(RUNTIME_DIR, getWindow, makeLogger(getWindow));
    return await launcher.launchVscodeCodex({
      runtimeDir: RUNTIME_DIR, launcherRoot: LAUNCHER_ROOT, configPath: CONFIG_PATH,
      project,
      // Codex 走 OpenAI 风格端点，基址需要 /v1
      manualCodex: { baseUrl: withV1(cfg.baseUrl), apiKey: cfg.apiKey, model: cfg.model },
      onLog: makeLogger(getWindow),
      onProgress: makeProgress(getWindow),
    });
  } catch (e) { return handleLaunchError('手动 Codex 启动失败', e); }
}

// ── 扫描本机 Kiro 凭证 ──
function scanKiroCredential() {
  const tokenPath = path.join(os.homedir(), '.aws', 'sso', 'cache', 'kiro-auth-token.json');
  if (!fs.existsSync(tokenPath)) {
    throw new Error('未找到 Kiro 凭证文件。请先用 Kiro IDE 登录一次。\n路径: ' + tokenPath);
  }

  let tokenData;
  try {
    tokenData = JSON.parse(fs.readFileSync(tokenPath, 'utf8'));
  } catch (e) {
    throw new Error('凭证文件解析失败: ' + e.message);
  }

  const { accessToken, refreshToken, profileArn, expiresAt, authMethod, provider } = tokenData;
  if (!refreshToken) {
    throw new Error('凭证文件中缺少 refreshToken，无法使用');
  }

  // 提取 region
  const region = profileArn ? (profileArn.split(':')[3] || 'us-east-1') : 'us-east-1';

  // 提取 email from JWT
  let email = null;
  if (accessToken) {
    try {
      const parts = accessToken.split('.');
      if (parts.length === 3) {
        let payload = parts[1];
        while (payload.length % 4) payload += '=';
        const decoded = JSON.parse(Buffer.from(payload.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
        email = decoded.email || decoded.preferred_username || decoded.sub || null;
      }
    } catch {}
  }

  // 查找 clientId/clientSecret（从同目录下的 registration 文件）
  const cacheDir = path.dirname(tokenPath);
  let clientReg = null;
  const now = new Date();
  try {
    for (const f of fs.readdirSync(cacheDir)) {
      if (!f.endsWith('.json') || f === 'kiro-auth-token.json') continue;
      try {
        const data = JSON.parse(fs.readFileSync(path.join(cacheDir, f), 'utf8'));
        if (data.clientId && data.clientSecret) {
          const expires = new Date(data.expiresAt);
          if (expires > now && (!clientReg || expires > new Date(clientReg.expiresAt))) {
            clientReg = data;
          }
        }
      } catch {}
    }
  } catch {}

  return {
    found: true,
    accessToken,
    refreshToken,
    profileArn,
    expiresAt,
    region,
    authMethod: authMethod || 'social',
    provider: provider || 'unknown',
    email: email || 'unknown',
    clientId: clientReg ? clientReg.clientId : null,
    clientSecret: clientReg ? clientReg.clientSecret : null,
    source: tokenPath,
  };
}

// 批量查询：并发查所有 key，返回 { id -> {ok, data|error} }
async function statusAll() {
  const store = readKeys();
  const results = await Promise.all(
    store.keys.map(async (k) => {
      if (k.kind === 'manual') return [k.id, { ok: null, manual: true }];
      try {
        const data = await fetchKeyStatus(k.value);
        return [k.id, { ok: true, data }];
      } catch (e) {
        return [k.id, { ok: false, error: e.message }];
      }
    })
  );
  return Object.fromEntries(results);
}

function registerIpcHandlers(ipcMain, getWindow) {
  ipcMain.handle('config:read', () => readConfig());
  ipcMain.handle('config:write', (_e, cfg) => writeConfig(cfg));
  ipcMain.handle('key:status', (_e, apiKey) => fetchKeyStatus(apiKey));
  ipcMain.handle('device:fingerprint', () => collectFingerprint());
  ipcMain.handle('mcp:read', () => mcp.readMcpSettings(MCP_SETTINGS_PATH, LAUNCHER_ROOT));
  ipcMain.handle('mcp:write', (_e, input) => mcp.writeMcpSettings(MCP_SETTINGS_PATH, LAUNCHER_ROOT, input));
  ipcMain.handle('mcp:apply', (_e, input) => {
    const settings = mcp.writeMcpSettings(MCP_SETTINGS_PATH, LAUNCHER_ROOT, input);
    mcp.applyClaudeMcp(LAUNCHER_ROOT, MCP_SETTINGS_PATH, makeLogger(getWindow));
    const codexConfig = path.join(RUNTIME_DIR, 'codex-home', 'config.toml');
    mcp.upsertCodexMcp(codexConfig, MCP_SETTINGS_PATH, LAUNCHER_ROOT, makeLogger(getWindow));
    const projectsDir = path.join(RUNTIME_DIR, 'projects');
    if (fs.existsSync(projectsDir)) {
      for (const id of fs.readdirSync(projectsDir)) {
        const projectCodexConfig = path.join(projectsDir, id, 'codex-home', 'config.toml');
        if (fs.existsSync(projectCodexConfig)) {
          mcp.upsertCodexMcp(projectCodexConfig, MCP_SETTINGS_PATH, LAUNCHER_ROOT, makeLogger(getWindow));
        }
      }
    }
    return settings;
  });

  // 启动 VS Code：双模式
  ipcMain.handle('vscode:launchRemote', () => launchVscodeRemote(getWindow));   // 我们的 key
  ipcMain.handle('vscode:launchLocal', () => launchVscodeLocal(getWindow));     // 本地 9router
  ipcMain.handle('vscode:launchCodex', () => launchVscodeCodex(getWindow));     // Codex
  ipcMain.handle('vscode:launchManualClaude', (_e, cfg) => launchManualClaude(getWindow, cfg));
  ipcMain.handle('vscode:launchManualCodex', (_e, cfg) => launchManualCodex(getWindow, cfg));
  ipcMain.handle('manual:models', (_e, cfg) => fetchManualModels(cfg));
  ipcMain.handle('manual:testModel', (_e, cfg) => testManualModel(cfg));
  // 只起本地 9router（不开 VS Code）
  ipcMain.handle('router:startOnly', () => startLocalRouterOnly(getWindow));
  ipcMain.handle('router:status', () => launcher.isLocalRouterRunning());
  ipcMain.handle('router:stop', () => launcher.stopLocalRouter());

  // 扫描本机 Kiro 凭证
  ipcMain.handle('kiro:scanCredential', () => scanKiroCredential());

  // 多 key 管理
  ipcMain.handle('keys:read', () => readKeys());
  ipcMain.handle('keys:add', (_e, value, label) => addKey(value, label));
  ipcMain.handle('keys:upsertManual', (_e, input) => upsertManualKey(input));
  ipcMain.handle('keys:remove', (_e, id) => removeKey(id));
  ipcMain.handle('keys:select', (_e, id) => selectKey(id));
  ipcMain.handle('keys:statusAll', () => statusAll());

  // 打开店铺（外部浏览器）
  ipcMain.handle('shop:open', () => shell.openExternal(SHOP_URL));
  ipcMain.handle('url:open', (_e, url) => shell.openExternal(assertHttpUrl(url)));

  // 窗口控制（无边框自绘标题栏用）
  ipcMain.on('win:minimize', () => getWindow()?.minimize());
  ipcMain.on('win:close', () => getWindow()?.close());
}

module.exports = { registerIpcHandlers };
