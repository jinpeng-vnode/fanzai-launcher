// scan_kiro_credential.mjs — 扫描本机 Kiro IDE 凭证并导出为 9Router 可用格式
//
// Kiro IDE 登录后会将 OAuth 凭证存储在：
//   ~/.aws/sso/cache/kiro-auth-token.json
//
// 本脚本自动扫描该文件，提取 refreshToken + profileArn，
// 然后输出为 import_kiro.mjs 能直接导入的 JSON 格式。
//
// 用法：
//   node scan_kiro_credential.mjs [--output <输出文件>] [--refresh] [--proxy <代理地址>]
//
// 示例：
//   node scan_kiro_credential.mjs                          # 打印到控制台
//   node scan_kiro_credential.mjs --output creds/kiro.json # 写入文件
//   node scan_kiro_credential.mjs --refresh                # 同时刷新 token 验证有效性
//   node scan_kiro_credential.mjs --refresh --proxy http://127.0.0.1:7897

import { readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import http from "node:http";
import https from "node:https";

const KIRO_AUTH_SERVICE = "https://prod.us-east-1.auth.desktop.kiro.dev";

// ── 参数解析 ──
function parseArgs(argv) {
  const opts = { output: null, refresh: false, proxy: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--output" || a === "-o") opts.output = argv[++i];
    else if (a === "--refresh") opts.refresh = true;
    else if (a === "--proxy") opts.proxy = argv[++i];
  }
  return opts;
}

// ── 跨平台路径 ──
function getKiroTokenPath() {
  return join(homedir(), ".aws", "sso", "cache", "kiro-auth-token.json");
}

function getSsoCacheDir() {
  return join(homedir(), ".aws", "sso", "cache");
}

// ── 代理地址规范化 ──
function normalizeProxy(url) {
  url = (url || "").trim();
  if (url && !/^(https?|socks5?):\/\//.test(url)) url = "http://" + url;
  return url;
}

// ── HTTP POST（经代理隧道） ──
function httpsPost(targetUrl, bodyStr, proxy) {
  return new Promise((resolve, reject) => {
    const t = new URL(targetUrl);
    const reqOpts = {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(bodyStr),
      },
    };
    const sendOn = (socket) => {
      const r = https.request(
        targetUrl,
        socket ? { ...reqOpts, socket, agent: false } : reqOpts,
        (resp) => {
          let d = "";
          resp.on("data", (c) => (d += c));
          resp.on("end", () => resolve({ status: resp.statusCode, body: d }));
        }
      );
      r.on("error", reject);
      r.write(bodyStr);
      r.end();
    };
    if (!proxy) return sendOn(null);
    const p = new URL(proxy);
    const conn = http.request({
      host: p.hostname,
      port: p.port || 80,
      method: "CONNECT",
      path: `${t.hostname}:${t.port || 443}`,
    });
    conn.on("connect", (res, socket) => {
      if (res.statusCode !== 200) return reject(new Error(`代理 CONNECT 失败 ${res.statusCode}`));
      sendOn(socket);
    });
    conn.on("error", reject);
    conn.end();
  });
}

// ── 从 profileArn 提取 region ──
function regionFromArn(profileArn) {
  if (!profileArn) return "us-east-1";
  const parts = profileArn.split(":");
  return parts.length >= 4 && parts[3] ? parts[3] : "us-east-1";
}

// ── 从 JWT 提取 email ──
function extractEmail(accessToken) {
  if (!accessToken) return null;
  try {
    const parts = accessToken.split(".");
    if (parts.length !== 3) return null;
    let payload = parts[1];
    while (payload.length % 4) payload += "=";
    const decoded = JSON.parse(
      Buffer.from(payload.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8")
    );
    return decoded.email || decoded.preferred_username || decoded.sub || null;
  } catch {
    return null;
  }
}

// ── 扫描并查找匹配的 clientId/clientSecret ──
function findClientRegistration(cacheDir) {
  // 找未过期的 client registration 文件
  const now = new Date();
  const files = readdirSync(cacheDir).filter(
    (f) => f.endsWith(".json") && f !== "kiro-auth-token.json"
  );

  let best = null;
  for (const f of files) {
    try {
      const data = JSON.parse(readFileSync(join(cacheDir, f), "utf8"));
      if (!data.clientId || !data.clientSecret) continue;
      const expires = new Date(data.expiresAt);
      if (expires <= now) continue; // 已过期，跳过
      // 选最晚过期的
      if (!best || expires > new Date(best.expiresAt)) {
        best = data;
      }
    } catch {}
  }
  return best;
}

// ── 用 Kiro Auth Service 刷新 token（社交登录） ──
async function refreshSocialToken(refreshToken, proxy) {
  const body = JSON.stringify({ refreshToken });
  const resp = await httpsPost(`${KIRO_AUTH_SERVICE}/refreshToken`, body, proxy);
  let payload;
  try {
    payload = JSON.parse(resp.body);
  } catch {
    throw new Error(`刷新响应非 JSON (HTTP ${resp.status}): ${resp.body.slice(0, 120)}`);
  }
  if (!payload.accessToken) {
    throw new Error(`刷新失败: ${JSON.stringify(payload).slice(0, 200)}`);
  }
  return payload;
}

// ── 用 AWS OIDC 刷新 token（Builder ID / IDC） ──
async function refreshOidcToken(refreshToken, clientId, clientSecret, region, proxy) {
  const endpoint = `https://oidc.${region || "us-east-1"}.amazonaws.com/token`;
  const body = JSON.stringify({
    clientId,
    clientSecret,
    grantType: "refresh_token",
    refreshToken,
  });
  const resp = await httpsPost(endpoint, body, proxy);
  let payload;
  try {
    payload = JSON.parse(resp.body);
  } catch {
    throw new Error(`刷新响应非 JSON (HTTP ${resp.status}): ${resp.body.slice(0, 120)}`);
  }
  if (!payload.accessToken) {
    throw new Error(`刷新失败: ${JSON.stringify(payload).slice(0, 200)}`);
  }
  return payload;
}

// ── 主逻辑 ──
async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const proxy = opts.proxy ? normalizeProxy(opts.proxy) : null;

  console.log("╔══════════════════════════════════════╗");
  console.log("║   Kiro 凭证扫描工具                 ║");
  console.log("╚══════════════════════════════════════╝");
  console.log();

  // 1. 扫描 kiro-auth-token.json
  const tokenPath = getKiroTokenPath();
  console.log(`[扫描] 检查 ${tokenPath}`);

  if (!existsSync(tokenPath)) {
    console.error("[错误] 未找到 kiro-auth-token.json");
    console.error("       请先使用 Kiro IDE 登录，凭证会自动写入该文件。");
    process.exit(1);
  }

  let tokenData;
  try {
    tokenData = JSON.parse(readFileSync(tokenPath, "utf8"));
  } catch (e) {
    console.error(`[错误] 解析失败: ${e.message}`);
    process.exit(1);
  }

  const { accessToken, refreshToken, profileArn, authMethod, provider } = tokenData;

  if (!refreshToken) {
    console.error("[错误] 文件中缺少 refreshToken，无法使用");
    process.exit(1);
  }

  console.log(`[找到] authMethod=${authMethod}, provider=${provider}`);
  console.log(`       profileArn=${profileArn}`);
  const email = extractEmail(accessToken);
  if (email) console.log(`       email=${email}`);

  const region = regionFromArn(profileArn);
  console.log(`       region=${region}`);

  // 2. 查找 client registration（用于 OIDC 刷新）
  const cacheDir = getSsoCacheDir();
  const clientReg = findClientRegistration(cacheDir);
  if (clientReg) {
    console.log(`[找到] clientId=${clientReg.clientId.slice(0, 20)}...`);
    console.log(`       过期时间=${clientReg.expiresAt}`);
  } else {
    console.log("[信息] 未找到有效的 client registration（社交登录不需要）");
  }

  // 3. 可选：刷新 token 验证有效性
  let finalAccessToken = accessToken;
  let finalRefreshToken = refreshToken;

  if (opts.refresh) {
    console.log();
    console.log("[刷新] 正在验证并刷新 token...");
    try {
      let result;
      if (authMethod === "social" || !clientReg) {
        // 社交登录 / 无 client registration → 用 Kiro Auth Service
        result = await refreshSocialToken(refreshToken, proxy);
      } else {
        // AWS OIDC 刷新
        result = await refreshOidcToken(
          refreshToken,
          clientReg.clientId,
          clientReg.clientSecret,
          region,
          proxy
        );
      }
      finalAccessToken = result.accessToken;
      finalRefreshToken = result.refreshToken || refreshToken;
      const newEmail = extractEmail(finalAccessToken);
      console.log(`[成功] token 有效！新 accessToken 已获取`);
      if (newEmail) console.log(`       email=${newEmail}`);
      if (result.profileArn) console.log(`       profileArn=${result.profileArn}`);
    } catch (e) {
      console.error(`[失败] 刷新失败: ${e.message}`);
      console.error("       将使用文件中的原始 token（可能已过期）");
    }
  }

  // 4. 构建输出
  const output = {
    // import_kiro.mjs 格式字段
    type: "kiro",
    email: email || extractEmail(finalAccessToken) || "unknown",
    refresh_token: finalRefreshToken,
    access_token: finalAccessToken,
    profile_arn: profileArn,
    region,
    auth_method: authMethod || "social",
    provider: provider || "social",
    // 如果有 client registration 则附带
    ...(clientReg && {
      client_id: clientReg.clientId,
      client_secret: clientReg.clientSecret,
    }),
    // 元数据
    scanned_at: new Date().toISOString(),
    source: tokenPath,
  };

  // 5. 输出
  console.log();
  if (opts.output) {
    writeFileSync(opts.output, JSON.stringify(output, null, 2), "utf8");
    console.log(`[导出] 凭证已写入: ${opts.output}`);
    console.log();
    console.log("下一步：用 import_kiro.mjs 导入 9Router：");
    console.log(`  node import_kiro.mjs ${opts.output} <代理地址> --db <data.sqlite>`);
  } else {
    console.log("══ 扫描结果（JSON） ══");
    console.log(JSON.stringify(output, null, 2));
    console.log();
    console.log("提示：加 --output creds/kiro.json 可写入文件");
  }

  // 6. 同时输出 9Router API 导入格式（可直接 POST 到 /api/oauth/kiro/import-credential）
  console.log();
  console.log("══ 9Router API 导入格式 ══");
  const apiPayload = {
    accessToken: finalAccessToken,
    refreshToken: finalRefreshToken,
    profileArn,
    expiresAt: tokenData.expiresAt,
    expiresIn: 3600,
    region,
    authMethod: authMethod || "social",
    email: output.email,
    ...(clientReg && {
      clientId: clientReg.clientId,
      clientSecret: clientReg.clientSecret,
    }),
  };
  console.log(JSON.stringify(apiPayload, null, 2));
  console.log();
  console.log("可直接 POST 到 9Router：");
  console.log("  curl -X POST http://localhost:20128/api/oauth/kiro/import-credential \\");
  console.log('    -H "Content-Type: application/json" \\');
  console.log(`    -d '${JSON.stringify(apiPayload)}'`);
}

main().catch((e) => {
  console.error("致命错误:", e);
  process.exit(1);
});
