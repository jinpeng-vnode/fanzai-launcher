// lib/setup.mjs — 通过 9Router HTTP API 完成首次初始化（幂等）
//
// 所有操作通过 API 完成，不再直接写 SQLite。
// 零外部依赖，使用 Node.js 原生 fetch()。

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

// ── Cookie Jar（简易实现） ──
class CookieJar {
  constructor() {
    this.cookies = new Map();
  }

  // 从 Set-Cookie 响应头提取并存储
  capture(headers) {
    const setCookies = headers.getSetCookie?.() || [];
    for (const raw of setCookies) {
      const parts = raw.split(';')[0]; // 只取 name=value
      const [name, ...rest] = parts.split('=');
      this.cookies.set(name.trim(), rest.join('=').trim());
    }
  }

  // 输出 Cookie 请求头
  toString() {
    return [...this.cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
  }
}

// ── API 客户端 ──
class RouterAPI {
  constructor(baseUrl, password) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.password = password;
    this.jar = new CookieJar();
    this.loggedIn = false;
  }

  async request(method, path, body = null) {
    const url = `${this.baseUrl}${path}`;
    const headers = {
      'Content-Type': 'application/json',
    };
    const cookieStr = this.jar.toString();
    if (cookieStr) headers['Cookie'] = cookieStr;

    const options = { method, headers };
    if (body !== null) {
      options.body = JSON.stringify(body);
    }

    const res = await fetch(url, options);
    this.jar.capture(res.headers);

    let data = null;
    const text = await res.text();
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
    return { status: res.status, data, ok: res.ok };
  }

  async get(path) { return this.request('GET', path); }
  async post(path, body) { return this.request('POST', path, body); }
  async put(path, body) { return this.request('PUT', path, body); }

  // 登录
  async login() {
    console.log('[*] 登录 9Router...');
    const res = await this.post('/api/auth/login', { password: this.password });
    if (!res.ok) {
      throw new Error(`登录失败 (HTTP ${res.status}): ${JSON.stringify(res.data)}`);
    }
    this.loggedIn = true;
    console.log('[✓] 登录成功');
    return res.data;
  }
}

// ── 扫描本机 Kiro 凭证 ──
function scanKiroCredential() {
  const tokenPath = join(homedir(), '.aws', 'sso', 'cache', 'kiro-auth-token.json');
  if (!existsSync(tokenPath)) {
    console.log('[!] 未找到 Kiro 凭证文件 (~/.aws/sso/cache/kiro-auth-token.json)');
    return null;
  }

  try {
    const data = JSON.parse(readFileSync(tokenPath, 'utf8'));
    if (!data.refreshToken && !data.accessToken) {
      console.log('[!] 凭证文件缺少 token 信息');
      return null;
    }

    // 查找 client registration
    const cacheDir = join(homedir(), '.aws', 'sso', 'cache');
    let clientReg = null;
    const now = new Date();
    const files = readdirSync(cacheDir).filter(f => f.endsWith('.json') && f !== 'kiro-auth-token.json');
    for (const f of files) {
      try {
        const reg = JSON.parse(readFileSync(join(cacheDir, f), 'utf8'));
        if (reg.clientId && reg.clientSecret) {
          const expires = new Date(reg.expiresAt);
          if (expires > now) {
            if (!clientReg || expires > new Date(clientReg.expiresAt)) {
              clientReg = reg;
            }
          }
        }
      } catch {}
    }

    // 从 JWT 提取 email
    let email = 'unknown';
    if (data.accessToken) {
      try {
        const parts = data.accessToken.split('.');
        if (parts.length === 3) {
          let payload = parts[1];
          while (payload.length % 4) payload += '=';
          const decoded = JSON.parse(Buffer.from(payload.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
          email = decoded.email || decoded.preferred_username || decoded.sub || 'unknown';
        }
      } catch {}
    }

    // 提取 region
    const region = data.profileArn
      ? (data.profileArn.split(':')[3] || 'us-east-1')
      : 'us-east-1';

    console.log(`[✓] 找到 Kiro 凭证 (email: ${email}, region: ${region})`);

    return {
      access_token: data.accessToken || '',
      refresh_token: data.refreshToken || '',
      profile_arn: data.profileArn || '',
      region,
      client_id: clientReg?.clientId || 'unknown',
      client_secret: clientReg?.clientSecret || 'unknown',
      auth_method: data.authMethod || 'social',
      email,
      type: 'kiro',
    };
  } catch (e) {
    console.log(`[!] 读取凭证文件失败: ${e.message}`);
    return null;
  }
}

// ── 检查 ksk_ API Key 格式（直接当 access_token 用） ──
function scanKskKey() {
  // 从环境变量读取
  const key = process.env.KIRO_API_KEY || process.env.KSK_KEY;
  if (key && key.startsWith('ksk_')) {
    console.log(`[✓] 检测到 ksk_ API Key`);
    return {
      access_token: key,
      refresh_token: 'ksk_no_refresh',
      profile_arn: '',
      region: 'us-east-1',
      client_id: 'apikey',
      client_secret: 'apikey',
      auth_method: 'apikey',
      email: 'ksk-apikey@kiro',
      type: 'kiro',
    };
  }
  return null;
}

// ── 主初始化流程 ──
export async function runSetup({ port = 20128, proxy = null }) {
  const baseUrl = `http://127.0.0.1:${port}`;
  const password = process.env.NINEROUTER_INITIAL_PASSWORD || 'admin123';

  const api = new RouterAPI(baseUrl, password);

  // 1. 登录
  await api.login();

  // 2. 检查是否已有 kiro 连接
  console.log('[*] 检查已有配置...');
  const providersRes = await api.get('/api/providers');
  const connections = providersRes.data?.connections || [];
  const hasKiro = connections.some(c => c.provider === 'kiro');

  if (hasKiro) {
    console.log('[✓] 已有 Kiro 连接，跳过凭证导入');
  } else {
    // 3. 扫描凭证
    const cred = scanKskKey() || scanKiroCredential();
    if (cred) {
      // 4. 导入凭证
      console.log('[*] 导入 Kiro 凭证...');
      const importRes = await api.post('/api/oauth/kiro/import-credential', cred);
      if (importRes.ok) {
        console.log('[✓] 凭证导入成功');
      } else {
        console.log(`[!] 凭证导入失败 (HTTP ${importRes.status}): ${JSON.stringify(importRes.data)}`);
      }
    } else {
      console.log('[!] 未找到可用凭证，跳过导入（稍后可通过 Web UI 手动添加）');
    }
  }

  // 5. 创建代理池（如果有代理）
  let proxyPoolId = null;
  if (proxy) {
    console.log('[*] 配置代理池...');
    const poolsRes = await api.get('/api/proxy-pools');
    const existingPools = poolsRes.data?.pools || poolsRes.data?.proxyPools || [];
    const existingPool = existingPools.find(p => p.proxyUrl === proxy);

    if (existingPool) {
      proxyPoolId = existingPool.id;
      console.log('[✓] 代理池已存在，复用');
    } else {
      const createPoolRes = await api.post('/api/proxy-pools', {
        name: 'local-proxy',
        proxyUrl: proxy,
        type: 'http',
        strictProxy: false,
      });
      if (createPoolRes.ok) {
        proxyPoolId = createPoolRes.data?.id || createPoolRes.data?.pool?.id;
        console.log('[✓] 代理池创建成功');
      } else {
        console.log(`[!] 代理池创建失败: ${JSON.stringify(createPoolRes.data)}`);
      }
    }
  }

  // 6. 关联代理到 kiro 连接
  if (proxyPoolId) {
    const providersRes2 = await api.get('/api/providers');
    const conns2 = providersRes2.data?.connections || [];
    const kiroConn = conns2.find(c => c.provider === 'kiro');
    if (kiroConn && !kiroConn.proxyPoolId) {
      console.log('[*] 关联代理到 Kiro 连接...');
      const updateRes = await api.put(`/api/providers/${kiroConn.id}`, { proxyPoolId });
      if (updateRes.ok) {
        console.log('[✓] 代理关联成功');
      } else {
        console.log(`[!] 代理关联失败: ${JSON.stringify(updateRes.data)}`);
      }
    }
  }

  // 7. 创建 combos
  console.log('[*] 配置模型组合...');
  const combos = [
    { name: 'claude-opus-4.6', models: ['kiro/claude-opus-4.6'] },
    { name: 'claude-opus-4.7', models: ['kiro/claude-opus-4.7'] },
    { name: 'claude-opus-4.8', models: ['kiro/claude-opus-4.8'] },
    { name: 'claude-sonnet-4', models: ['kiro/claude-sonnet-4'] },
    { name: 'claude-sonnet-4.5', models: ['kiro/claude-sonnet-4.5'] },
  ];

  // 获取已有 combos
  const combosRes = await api.get('/api/combos');
  const existingCombos = combosRes.data?.combos || [];
  const existingComboNames = new Set(existingCombos.map(c => c.name));

  for (const combo of combos) {
    if (existingComboNames.has(combo.name)) continue;
    const res = await api.post('/api/combos', combo);
    if (res.ok) {
      console.log(`    [✓] 组合 ${combo.name} 创建成功`);
    } else if (res.data?.error?.includes?.('already') || res.status === 409) {
      // 已存在，跳过
    } else {
      console.log(`    [!] 组合 ${combo.name} 创建失败: ${JSON.stringify(res.data)}`);
    }
  }
  console.log('[✓] 模型组合配置完成');

  // 8. 添加模型别名
  console.log('[*] 配置模型别名...');
  const aliases = [
    { alias: 'claude-opus-4.6', target: 'kiro/claude-opus-4.6' },
    { alias: 'claude-opus-4.7', target: 'kiro/claude-opus-4.7' },
    { alias: 'claude-opus-4.8', target: 'kiro/claude-opus-4.8' },
    { alias: 'claude-sonnet-4', target: 'kiro/claude-sonnet-4' },
    { alias: 'claude-sonnet-4.5', target: 'kiro/claude-sonnet-4.5' },
  ];

  for (const { alias, target } of aliases) {
    const res = await api.post('/api/models/alias', { alias, target });
    if (!res.ok && res.status !== 409) {
      // 某些版本可能不支持该 API，静默跳过
    }
  }
  console.log('[✓] 模型别名配置完成');

  // 9. 创建 API Key
  console.log('[*] 检查 API Key...');
  const keysRes = await api.get('/api/keys');
  const existingKeys = keysRes.data?.keys || [];
  let apiKey = null;

  if (existingKeys.length > 0) {
    apiKey = existingKeys[0].key;
    console.log('[✓] API Key 已存在，复用');
  } else {
    const createKeyRes = await api.post('/api/keys', { name: 'default' });
    if (createKeyRes.ok) {
      apiKey = createKeyRes.data?.key || createKeyRes.data?.apiKey;
      console.log('[✓] API Key 创建成功');
    } else {
      console.log(`[!] API Key 创建失败: ${JSON.stringify(createKeyRes.data)}`);
    }
  }

  // 10. 更新 settings（combo 策略）
  console.log('[*] 更新路由策略...');
  const comboStrategies = {};
  for (const combo of combos) {
    comboStrategies[combo.name] = { fallbackStrategy: 'round-robin' };
  }

  const settingsRes = await api.put('/api/settings', { comboStrategies });
  if (settingsRes.ok) {
    console.log('[✓] 路由策略更新成功');
  } else {
    // 某些版本可能没有该端点，非致命
    console.log('[!] 路由策略更新跳过（可能不支持该 API）');
  }

  return { apiKey, baseUrl };
}
