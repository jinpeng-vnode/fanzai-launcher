// Kiro 账号凭证管理 — 用量查询 / 超额开关 / 凭证列表 / 格式转换
// 移植自 Kiro-Go proxy/kiro_api.go + proxy/kiro_overage.go，纯 Node.js 实现
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const crypto = require('crypto');
const { detectProxy } = require('./proxy');

// --- Constants (mirrors Kiro-Go / kiro-login-helper) ---
const KIRO_IDE_VERSION = '0.12.333';
const KIRO_Q_API_BASE = 'https://q.us-east-1.amazonaws.com';
const KIRO_REST_API_BASE = 'https://codewhisperer.us-east-1.amazonaws.com';

// --- Helpers ---

function buildMachineId(...parts) {
  return crypto.createHash('sha256').update(parts.join('|')).digest('hex');
}

function buildUserAgent(machineId) {
  return `aws-sdk-js/1.0.0 ua/2.1 os/windows#10.0.26200 lang/js md/nodejs#22.21.1 api/codewhispererruntime#1.0.0 m/N,E KiroIDE-${KIRO_IDE_VERSION}-${machineId}`;
}

function buildXAmzUserAgent(machineId) {
  return `aws-sdk-js/1.0.0 KiroIDE-${KIRO_IDE_VERSION}-${machineId}`;
}

function regionFromProfileArn(profileArn) {
  const parts = (profileArn || '').trim().split(':');
  return parts.length >= 4 ? parts[3].trim() : '';
}

function kiroRegion(account) {
  const arnRegion = regionFromProfileArn(account.profileArn || account.profile_arn || '');
  if (arnRegion) return arnRegion;
  if (account.region) return account.region;
  return 'us-east-1';
}

function regionalizeURL(rawURL, account) {
  const region = kiroRegion(account);
  if (region === 'us-east-1') return rawURL;
  const regionalHost = `q.${region}.amazonaws.com`;
  return rawURL
    .replace('q.us-east-1.amazonaws.com', regionalHost)
    .replace('codewhisperer.us-east-1.amazonaws.com', regionalHost);
}

function getAccessToken(account) {
  return account.accessToken || account.access_token || '';
}

function getProfileArn(account) {
  return account.profileArn || account.profile_arn || '';
}

// --- Token refresh (external_idp: Microsoft Entra ID / Azure AD) ---

function isTokenExpired(account) {
  const expiresAt = account.expiresAt || 0;
  if (!expiresAt) return true; // 无过期时间视为需要刷新
  // 提前 60 秒视为过期（避免边界竞态）
  return Math.floor(Date.now() / 1000) >= (expiresAt - 60);
}

// refreshAccessToken 用 refresh_token grant 向 IdP token endpoint 换新 access token。
// 仅 external_idp 账号有 tokenEndpoint/clientId/refreshToken；social 账号走 AWS SSO 刷新（暂不支持）。
async function refreshAccessToken(account) {
  const tokenEndpoint = account.tokenEndpoint || account.token_endpoint || '';
  const clientId = account.clientId || account.client_id || '';
  const refreshToken = account.refreshToken || account.refresh_token || '';
  const scopes = account.scopes || '';

  if (!tokenEndpoint || !clientId || !refreshToken) {
    throw new Error('token 已过期且缺少刷新材料（需要 tokenEndpoint + clientId + refreshToken）');
  }

  const form = new URLSearchParams({
    client_id: clientId,
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
  });
  if (scopes) form.append('scope', scopes);

  const headers = {
    'Content-Type': 'application/x-www-form-urlencoded',
    'Accept': 'application/json',
  };

  const resp = await request('POST', tokenEndpoint, headers, form.toString());
  if (resp.status !== 200 || !resp.data?.access_token) {
    const err = resp.data?.error || '';
    const desc = resp.data?.error_description || resp.raw?.slice(0, 200) || '';
    throw new Error(`token 刷新失败 (HTTP ${resp.status}): ${err} ${desc}`);
  }

  // 更新 account 对象内存中的 token（调用方可选择持久化回文件）
  account.accessToken = resp.data.access_token;
  account.access_token = resp.data.access_token;
  if (resp.data.refresh_token) {
    account.refreshToken = resp.data.refresh_token;
    account.refresh_token = resp.data.refresh_token;
  }
  if (resp.data.expires_in) {
    account.expiresAt = Math.floor(Date.now() / 1000) + parseInt(resp.data.expires_in);
  }

  // 持久化刷新后的 token 回文件（如果有 filePath）
  if (account.filePath && fs.existsSync(account.filePath)) {
    try {
      const fileData = JSON.parse(fs.readFileSync(account.filePath, 'utf8'));
      // 按文件原有的 key 风格更新
      if ('accessToken' in fileData) {
        fileData.accessToken = account.accessToken;
        if (resp.data.refresh_token) fileData.refreshToken = account.refreshToken;
        if (account.expiresAt) fileData.expiresAt = account.expiresAt;
      } else {
        fileData.access_token = account.accessToken;
        if (resp.data.refresh_token) fileData.refresh_token = account.refreshToken;
      }
      fs.writeFileSync(account.filePath, JSON.stringify(fileData, null, 2) + '\n', 'utf8');
    } catch { /* 持久化失败不阻断，内存 token 仍可用 */ }
  }

  return account.accessToken;
}

// ensureFreshToken 检查 token 是否过期，过期则自动刷新。返回可用的 access token。
async function ensureFreshToken(account) {
  if (!isTokenExpired(account)) {
    return getAccessToken(account);
  }
  return await refreshAccessToken(account);
}

// --- HTTP request helper (with proxy support) ---

function request(method, url, headers, body) {
  const proxy = detectProxy();
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const isHttps = parsed.protocol === 'https:';

    // If proxy available, tunnel through it
    if (proxy) {
      const proxyUrl = new URL(proxy);
      const connectReq = http.request({
        host: proxyUrl.hostname,
        port: proxyUrl.port || 80,
        method: 'CONNECT',
        path: `${parsed.hostname}:${parsed.port || (isHttps ? 443 : 80)}`,
      });
      connectReq.on('connect', (_res, socket) => {
        const options = {
          hostname: parsed.hostname,
          port: parsed.port || 443,
          path: parsed.pathname + parsed.search,
          method,
          headers: { ...headers },
          socket,
          agent: false,
          timeout: 30000,
        };
        const req = https.request(options, handleResponse(resolve));
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('request timeout')); });
        if (body) req.write(typeof body === 'string' ? body : JSON.stringify(body));
        req.end();
      });
      connectReq.on('error', (e) => {
        // Proxy connect failed — fall through without proxy
        requestDirect(method, url, headers, body, isHttps).then(resolve).catch(reject);
      });
      connectReq.on('timeout', () => { connectReq.destroy(); reject(new Error('proxy connect timeout')); });
      connectReq.end();
      return;
    }

    // No proxy — direct request
    requestDirect(method, url, headers, body, isHttps).then(resolve).catch(reject);
  });
}

function requestDirect(method, url, headers, body, isHttps) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const mod = isHttps ? https : http;
    const options = {
      hostname: parsed.hostname,
      port: parsed.port || (isHttps ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method,
      headers: { ...headers },
      timeout: 30000,
    };
    const req = mod.request(options, handleResponse(resolve));
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('request timeout')); });
    if (body) req.write(typeof body === 'string' ? body : JSON.stringify(body));
    req.end();
  });
}

function handleResponse(resolve) {
  return (res) => {
    let data = '';
    res.on('data', (chunk) => { data += chunk; });
    res.on('end', () => {
      try {
        resolve({ status: res.statusCode, data: data ? JSON.parse(data) : {}, raw: data });
      } catch {
        resolve({ status: res.statusCode, data: null, raw: data });
      }
    });
  };
}

// --- Build Kiro request headers ---

function buildKiroHeaders(account, freshToken) {
  const accessToken = freshToken || getAccessToken(account);
  const machineId = buildMachineId(accessToken);
  const headers = {
    'Accept': 'application/json',
    'Authorization': `Bearer ${accessToken}`,
    'User-Agent': buildUserAgent(machineId),
    'x-amz-user-agent': buildXAmzUserAgent(machineId),
    'x-amzn-kiro-agent-mode': 'vibe',
    'x-amzn-codewhisperer-optout': 'true',
    'amz-sdk-invocation-id': buildMachineId(accessToken, Date.now().toString()),
    'amz-sdk-request': 'attempt=1; max=1',
  };
  // external_idp token 必须带 TokenType 头，否则 AWS 无法验证返回 403
  const authMethod = account.authMethod || account.auth_method || '';
  if (authMethod === 'external_idp') {
    headers['TokenType'] = 'EXTERNAL_IDP';
  }
  return headers;
}

// --- Usage / Subscription query ---

async function fetchUsage(account) {
  ensureProxy();
  const freshToken = await ensureFreshToken(account);
  const profileArn = getProfileArn(account);
  let url = `${KIRO_Q_API_BASE}/getUsageLimits?origin=AI_EDITOR&resourceType=AGENTIC_REQUEST&isEmailRequired=true`;
  url = regionalizeURL(url, account);
  if (profileArn) url += `&profileArn=${encodeURIComponent(profileArn)}`;

  const headers = buildKiroHeaders(account, freshToken);
  const resp = await request('GET', url, headers);

  if (resp.status !== 200) {
    throw new Error(`fetchUsage HTTP ${resp.status}: ${resp.raw.slice(0, 200)}`);
  }

  const d = resp.data || {};
  const result = {
    email: d.userInfo?.email || '',
    userId: d.userInfo?.userId || '',
    subscriptionType: '',
    subscriptionTitle: '',
    usageCurrent: 0,
    usageLimit: 0,
    usagePercent: 0,
    nextResetDate: '',
    overageStatus: 'UNKNOWN',
    overageCap: 0,
    overageRate: 0,
    currentOverages: 0,
  };

  // Subscription
  if (d.subscriptionInfo) {
    result.subscriptionTitle = d.subscriptionInfo.subscriptionTitle || d.subscriptionInfo.subscriptionName || '';
    result.subscriptionType = parseSubscriptionType(result.subscriptionTitle || d.subscriptionInfo.subscriptionType || '');
  }

  // Usage breakdown
  if (d.usageBreakdownList && d.usageBreakdownList.length > 0) {
    const bd = d.usageBreakdownList[0];
    result.usageCurrent = bd.currentUsage || 0;
    result.usageLimit = bd.usageLimit || 0;
    if (result.usageLimit > 0) {
      result.usagePercent = result.usageCurrent / result.usageLimit;
    }
    result.overageCap = bd.overageCap || 0;
    result.overageRate = bd.overageRate || 0;
    result.currentOverages = bd.currentOverages || 0;
  }

  // Overage configuration
  if (d.overageConfiguration) {
    result.overageStatus = (d.overageConfiguration.overageStatus || 'UNKNOWN').toUpperCase();
  }

  // Next reset
  if (d.nextDateReset) {
    const ts = Number(d.nextDateReset);
    if (ts > 0) {
      result.nextResetDate = new Date(ts * 1000).toISOString().split('T')[0];
    }
  }

  return result;
}

function parseSubscriptionType(raw) {
  const upper = (raw || '').toUpperCase();
  if (upper.includes('PRO_PLUS') || upper.includes('PROPLUS')) return 'PRO_PLUS';
  if (upper.includes('POWER')) return 'POWER';
  if (upper.includes('PRO')) return 'PRO';
  return 'FREE';
}

// --- Overage status ---

async function fetchOverage(account) {
  ensureProxy();
  const freshToken = await ensureFreshToken(account);
  const profileArn = getProfileArn(account);
  let url = `${KIRO_Q_API_BASE}/getUsageLimits?origin=AI_EDITOR&resourceType=AGENTIC_REQUEST&isEmailRequired=true`;
  url = regionalizeURL(url, account);
  if (profileArn) url += `&profileArn=${encodeURIComponent(profileArn)}`;

  const headers = buildKiroHeaders(account, freshToken);
  const resp = await request('GET', url, headers);

  if (resp.status !== 200) {
    throw new Error(`fetchOverage HTTP ${resp.status}: ${resp.raw.slice(0, 200)}`);
  }

  const d = resp.data || {};
  const snap = {
    status: 'UNKNOWN',
    capability: '',
    subscriptionTitle: '',
    overageCap: 0,
    overageRate: 0,
    currentOverages: 0,
    checkedAt: Math.floor(Date.now() / 1000),
  };

  if (d.overageConfiguration?.overageStatus) {
    snap.status = d.overageConfiguration.overageStatus.toUpperCase();
  }
  if (d.subscriptionInfo) {
    snap.capability = d.subscriptionInfo.overageCapability || '';
    snap.subscriptionTitle = d.subscriptionInfo.subscriptionTitle || '';
  }
  if (d.usageBreakdownList) {
    for (const bd of d.usageBreakdownList) {
      if (bd.overageCap > 0 || bd.overageRate > 0 || bd.currentOverages > 0) {
        snap.overageCap = bd.overageCap;
        snap.overageRate = bd.overageRate;
        snap.currentOverages = bd.currentOverages;
        break;
      }
    }
  }

  return snap;
}

// --- Set overage on/off ---

async function setOverage(account, enabled) {
  ensureProxy();
  const freshToken = await ensureFreshToken(account);
  const profileArn = getProfileArn(account);
  if (!profileArn) throw new Error('account 缺少 profileArn');

  const status = enabled ? 'ENABLED' : 'DISABLED';
  const payload = {
    overageConfiguration: { overageStatus: status },
    profileArn,
  };

  let url = `${KIRO_Q_API_BASE}/setUserPreference`;
  url = regionalizeURL(url, account);

  const headers = {
    ...buildKiroHeaders(account, freshToken),
    'Content-Type': 'application/json',
  };

  const resp = await request('POST', url, headers, JSON.stringify(payload));
  if (resp.status !== 200) {
    throw new Error(`setOverage HTTP ${resp.status}: ${resp.raw.slice(0, 200)}`);
  }

  // Re-fetch for accurate snapshot
  try {
    const snap = await fetchOverage(account);
    snap.status = status; // Force the just-set value in case of AWS lag
    return snap;
  } catch {
    return { status, checkedAt: Math.floor(Date.now() / 1000) };
  }
}

// --- Credential file management ---

// 按 key 灵活搜索：忽略大小写和下划线/连字符等分隔符，命中任一候选名即返回值。
// 这样不管凭证是 access_token / accessToken / AccessToken 都能取到，不要求格式严格一致。
function getField(obj, names) {
  if (!obj || typeof obj !== 'object') return undefined;
  const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
  const wanted = names.map(norm);
  for (const [k, v] of Object.entries(obj)) {
    if (wanted.includes(norm(k))) return v;
  }
  return undefined;
}

function normalizeAccount(data, filePath) {
  if (!data || typeof data !== 'object') return null;

  // 灵活按 key 搜索字段，不依赖格式严格匹配
  const accessToken = getField(data, ['accessToken', 'access_token']) || '';
  // 没有 access token 的不当作凭证账号
  if (!accessToken) return null;

  const disabled = getField(data, ['disabled']);
  const enabledRaw = getField(data, ['enabled']);
  // enabled 优先；否则看 disabled 取反；都没有则默认启用
  let enabled = true;
  if (enabledRaw !== undefined) enabled = enabledRaw !== false;
  else if (disabled !== undefined) enabled = !disabled;

  // 展示用的格式标签（不影响读取）：有 camelCase 关键键 → kirogo，否则 cliproxy
  const fmt = (data.accessToken || data.authMethod || data.profileArn) ? 'kirogo' : 'cliproxy';

  return {
    id: getField(data, ['id']) || '',
    email: getField(data, ['email', 'preferredUsername']) || '',
    accessToken,
    refreshToken: getField(data, ['refreshToken', 'refresh_token']) || '',
    authMethod: getField(data, ['authMethod', 'auth_method']) || 'social',
    region: getField(data, ['region']) || 'us-east-1',
    profileArn: getField(data, ['profileArn', 'profile_arn']) || '',
    enabled,
    expiresAt: getField(data, ['expiresAt', 'expires_at']) || 0,
    provider: getField(data, ['provider']) || '',
    // 刷新材料（external_idp 必需）
    tokenEndpoint: getField(data, ['tokenEndpoint', 'token_endpoint']) || '',
    clientId: getField(data, ['clientId', 'client_id']) || '',
    scopes: getField(data, ['scopes']) || '',
    issuerUrl: getField(data, ['issuerUrl', 'issuer_url']) || '',
    format: fmt,
    filePath,
  };
}

function listCredentials(credsDir) {
  const accounts = [];
  if (!fs.existsSync(credsDir)) return accounts;

  // 只列真实凭证文件；turn_ 前缀是「格式转换」的产物副本，不作为独立账号展示，
  // 否则一个账号会显示成多张重复卡片（原文件 + 转换出的两种格式）。
  const files = fs.readdirSync(credsDir).filter((f) => f.endsWith('.json') && !f.startsWith('turn_'));
  for (const file of files) {
    try {
      const filePath = path.join(credsDir, file);
      const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      const account = normalizeAccount(data, filePath);
      if (account) accounts.push(account);
    } catch {
      // skip invalid files
    }
  }
  return accounts;
}

function deriveLabel(data) {
  // 灵活按 key 搜索 token / email，提取账号标识用于文件名
  const token = getField(data, ['accessToken', 'access_token']) || '';
  const email = extractEmailFromJwt(token) || getField(data, ['email']) || '';
  if (email) return sanitize(email);
  return `unknown-${Date.now()}`;
}

function extractEmailFromJwt(token) {
  try {
    const parts = (token || '').split('.');
    if (parts.length < 2) return '';
    let seg = parts[1];
    while (seg.length % 4) seg += '=';
    const payload = JSON.parse(Buffer.from(seg, 'base64url').toString('utf8'));
    return payload.email || payload.preferred_username || payload.upn || '';
  } catch { return ''; }
}

function sanitize(s) {
  return (s || '').replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'credential';
}

// --- Save / Delete credential files ---

function saveCredential(credsDir, jsonStr) {
  // 只验证是合法 JSON；不校验凭证格式——任何 JSON 都原样保存。
  // 如果是数组则自动拆分成多个独立文件（每条一个），保证导入时每个文件是单对象。
  const data = JSON.parse(jsonStr);
  fs.mkdirSync(credsDir, { recursive: true });

  if (Array.isArray(data)) {
    const results = [];
    for (const item of data) {
      if (!item || typeof item !== 'object') continue;
      const label = deriveLabel(item);
      const filePath = path.join(credsDir, `kiro-cred_${label}.json`);
      fs.writeFileSync(filePath, JSON.stringify(item, null, 2) + '\n', 'utf8');
      results.push(filePath);
    }
    return { ok: true, count: results.length, paths: results };
  }

  const label = deriveLabel(data);
  const filePath = path.join(credsDir, `kiro-cred_${label}.json`);
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n', 'utf8');
  return { ok: true, count: 1, path: filePath };
}

function deleteCredential(filePath) {
  if (!filePath || !fs.existsSync(filePath)) {
    throw new Error('凭证文件不存在');
  }
  fs.unlinkSync(filePath);
  return { ok: true };
}

// 启用/禁用账号：写回 json 文件的 enabled 字段（列表用它决定灰化与是否参与）
function setEnabled(filePath, enabled) {
  if (!filePath || !fs.existsSync(filePath)) {
    throw new Error('凭证文件不存在');
  }
  const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  data.enabled = !!enabled;
  // 若文件原本用 disabled 表达状态，一并同步，避免两个字段互相矛盾
  if ('disabled' in data) data.disabled = !enabled;
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n', 'utf8');
  return { ok: true, enabled: !!enabled };
}

// --- 导入到 9router（调本地 REST API，热生效、可重复导入、由 9router 自己 upsert）---

// 代理地址强制带协议前缀（9router 解析无前缀的 host:port 会报 Invalid URL protocol）
function normalizeProxyUrl(url) {
  url = (url || '').trim();
  if (url && !/^(https?|socks5?):\/\//.test(url)) url = 'http://' + url;
  return url;
}

// 直连本地 9router 发请求（本机回环，绝不走代理）。
// cliToken 用于 9router 管理 API 鉴权（x-9r-cli-token 头，非 sk-9r key——后者只对 /v1 推理端点有效）。
function localReq(baseUrl, method, pathName, bodyObj, cliToken) {
  return new Promise((resolve, reject) => {
    const u = new URL(baseUrl);
    const body = bodyObj != null ? JSON.stringify(bodyObj) : null;
    const headers = { 'Accept': 'application/json' };
    if (body != null) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(body);
    }
    if (cliToken) headers['x-9r-cli-token'] = cliToken;
    const req = http.request(
      {
        hostname: u.hostname,
        port: u.port,
        path: pathName,
        method,
        headers,
        timeout: 60000,
      },
      (res) => {
        let data = '';
        res.on('data', (c) => { data += c; });
        res.on('end', () => {
          let parsed = null;
          try { parsed = data ? JSON.parse(data) : {}; } catch { /* 保留 raw */ }
          resolve({ status: res.statusCode, data: parsed, raw: data });
        });
      }
    );
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('9router 请求超时')); });
    if (body != null) req.write(body);
    req.end();
  });
}

// 确保 9router 里有指向 proxyUrl 的代理池，返回其 id（已存在则复用，对齐旧 ensureProxyPool 行为）。
async function ensureProxyPool(baseUrl, cliToken, proxyUrl) {
  const target = normalizeProxyUrl(proxyUrl);
  if (!target) return null;

  // 先查现有池去重（GET 返回 { proxyPools: [...] }）
  try {
    const list = await localReq(baseUrl, 'GET', '/api/proxy-pools', null, cliToken);
    const pools = (list.data && list.data.proxyPools) || [];
    for (const p of pools) {
      const url = p.proxyUrl || (p.data && p.data.proxyUrl);
      if (url && normalizeProxyUrl(url) === target) return p.id;
    }
  } catch { /* 查不到就继续创建 */ }

  // 创建新池（POST 返回 { proxyPool: { id, ... } } 状态 201）
  const resp = await localReq(baseUrl, 'POST', '/api/proxy-pools', {
    name: target,
    proxyUrl: target,
    noProxy: '',
    isActive: true,
    strictProxy: false,
  }, cliToken);
  if ((resp.status === 200 || resp.status === 201) && resp.data && resp.data.proxyPool) {
    return resp.data.proxyPool.id;
  }
  throw new Error((resp.data && resp.data.error) || `创建代理池失败 HTTP ${resp.status}`);
}

// 把 creds/*.json 逐个推给运行中的 9router。baseUrl 形如 http://127.0.0.1:20128。
// 走 dashboard 同款流程：import-cli-proxy 原样导入凭证（支持 social / external_idp），
// 再把连接关联到自动创建的代理池（对齐旧 import_kiro.mjs 的代理自动配置）。
async function importToRouter(baseUrl, credsDir, cliToken, proxyUrl) {
  if (!baseUrl) throw new Error('缺少 9router 地址');
  if (!fs.existsSync(credsDir)) {
    return { ok: false, imported: 0, failed: 0, skipped: 0, details: [], message: '未找到 creds 目录，无凭证可导入' };
  }

  const files = fs.readdirSync(credsDir).filter((f) => f.endsWith('.json') && !f.startsWith('turn_'));
  const details = [];
  let imported = 0, failed = 0, skipped = 0;

  // 先确保代理池就绪（有代理才建）。失败不阻断导入，仅记提示。
  let proxyPoolId = null;
  let proxyNote = '';
  if (proxyUrl) {
    try {
      proxyPoolId = await ensureProxyPool(baseUrl, cliToken, proxyUrl);
    } catch (e) {
      proxyNote = `（代理池配置失败：${e.message}）`;
    }
  }

  for (const file of files) {
    const filePath = path.join(credsDir, file);
    let raw;
    try {
      raw = fs.readFileSync(filePath, 'utf8');
      JSON.parse(raw); // 仅校验是合法 JSON；内容原样交给 9router 解析
    } catch (e) {
      skipped++;
      details.push({ file, status: 'skipped', reason: 'JSON 解析失败' });
      continue;
    }

    const data = JSON.parse(raw);
    if (Array.isArray(data)) {
      skipped++;
      details.push({ file, status: 'skipped', reason: '凭证文件是数组格式，请先在「添加凭证」里重新导入以自动拆分' });
      continue;
    }
    const email = getField(data, ['email']) || extractEmailFromJwt(getField(data, ['accessToken', 'access_token']) || '') || file;

    try {
      // 9router 对 idc 和 external_idp 账号提供两个不同的导入端点：
      //   - import-cli-proxy：仅支持 external_idp（有 token_endpoint）
      //   - import：支持 idc（有 clientId+clientSecret，服务端自己刷新）
      // 我们按字段判断走哪个，不做任何额外操作，9router 自己处理刷新。
      const hasTokenEndpoint = !!(getField(data, ['tokenEndpoint', 'token_endpoint']));
      let resp;
      if (hasTokenEndpoint) {
        resp = await localReq(baseUrl, 'POST', '/api/oauth/kiro/import-cli-proxy', { json: raw }, cliToken);
      } else {
        resp = await localReq(baseUrl, 'POST', '/api/oauth/kiro/import', {
          refreshToken: getField(data, ['refreshToken', 'refresh_token']) || '',
          clientId: getField(data, ['clientId', 'client_id']) || '',
          clientSecret: getField(data, ['clientSecret', 'client_secret']) || '',
          region: getField(data, ['region']) || 'us-east-1',
          authMethod: getField(data, ['authMethod', 'auth_method']) || 'idc',
          profileArn: getField(data, ['profileArn', 'profile_arn']) || '',
        }, cliToken);
      }
      if (resp.status !== 200 || !resp.data || !resp.data.success) {
        failed++;
        const reason = (resp.data && resp.data.error) || `HTTP ${resp.status}`;
        details.push({ file, email, status: 'failed', reason });
        continue;
      }
      const connId = resp.data.connection && resp.data.connection.id;

      // 2. 关联代理池（PUT providers/{id}）
      if (proxyPoolId && connId) {
        try {
          await localReq(baseUrl, 'PUT', `/api/providers/${connId}`, { proxyPoolId }, cliToken);
        } catch { /* 关联失败不影响凭证已导入，忽略 */ }
      }

      imported++;
      details.push({ file, email: (resp.data.connection && resp.data.connection.email) || email, status: 'ok' });
    } catch (e) {
      failed++;
      details.push({ file, email, status: 'failed', reason: e.message });
    }
  }

  const proxyMsg = proxyPoolId ? '，已配代理池' : (proxyUrl ? proxyNote : '');
  return {
    ok: failed === 0 && imported > 0,
    imported,
    failed,
    skipped,
    details,
    message: `导入完成：成功 ${imported}，失败 ${failed}，跳过 ${skipped}${proxyMsg}`,
  };
}

// --- Proxy check for API calls ---

function ensureProxy() {
  const proxy = detectProxy();
  if (!proxy) {
    throw new Error('未检测到代理。Kiro API 需要代理才能访问，请先配置系统代理或设置 HTTPS_PROXY 环境变量。');
  }
  return proxy;
}

module.exports = {
  listCredentials,
  fetchUsage,
  fetchOverage,
  setOverage,
  saveCredential,
  deleteCredential,
  setEnabled,
  importToRouter,
};
