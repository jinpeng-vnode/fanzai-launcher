// import_kiro.mjs — 把 Kiro OAuth 凭证导入 9Router 的 sqlite 数据库（node 版，零额外依赖）
//
// 一条命令完成三件事（与 import_kiro_to_9router.py 等价）：
//   1. 刷新 token —— 用 refresh_token 经代理向 AWS OIDC 换取最新 access_token
//   2. 写凭证   —— 按 9Router schema 写入 providerConnections 表，带上 profileArn（403 根因）
//   3. 配代理   —— 在 proxyPools 表建一条代理（地址强制带 http:// 前缀）并关联连接
//
// 依赖 node 24+ 内置的 node:sqlite（无需 npm 安装任何东西）。
//
// 用法：
//   node import_kiro.mjs <认证文件或目录> <代理地址> --db <data.sqlite> [--no-refresh] [--no-proxy-pool]
//
// 例：
//   node import_kiro.mjs ./creds http://127.0.0.1:7897 --db /path/to/data.sqlite

import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, basename, extname } from "node:path";
import { randomUUID } from "node:crypto";
import http from "node:http";
import https from "node:https";

const OIDC_TOKEN_URL = "https://oidc.us-east-1.amazonaws.com/token";
const REQUIRED = ["refresh_token", "profile_arn", "client_id", "client_secret", "region", "email"];

// ── 参数解析 ──
function parseArgs(argv) {
  const positional = [];
  const opts = { refresh: true, proxyPool: true, db: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--no-refresh") opts.refresh = false;
    else if (a === "--no-proxy-pool") opts.proxyPool = false;
    else if (a === "--db") opts.db = argv[++i];
    else positional.push(a);
  }
  opts.input = positional[0];
  opts.proxy = positional[1] || null;
  return opts;
}

function nowIso() {
  return new Date().toISOString().replace(/(\.\d{3})\d*Z$/, "$1Z");
}
function isoAfter(seconds) {
  return new Date(Date.now() + seconds * 1000).toISOString().replace(/(\.\d{3})\d*Z$/, "$1Z");
}

// 代理地址强制带协议前缀（9Router 解析无前缀的 host:port 会报 Invalid URL protocol）
function normalizeProxy(url) {
  url = (url || "").trim();
  if (url && !/^(https?|socks5?):\/\//.test(url)) url = "http://" + url;
  return url;
}

// 读认证文件（顶层数组或单对象）
function loadRecords(path) {
  const raw = JSON.parse(readFileSync(path, "utf8"));
  if (Array.isArray(raw)) return raw.filter((r) => r && typeof r === "object");
  if (raw && typeof raw === "object") return [raw];
  throw new Error(`${path}: 顶层既不是对象也不是数组`);
}

function expandInputs(input) {
  if (statSync(input).isDirectory()) {
    return readdirSync(input)
      .filter((f) => f.toLowerCase().endsWith(".json"))
      .sort()
      .map((f) => join(input, f));
  }
  return [input];
}

function validate(rec) {
  return REQUIRED.filter((k) => !rec[k]);
}

// 经 HTTP 代理 CONNECT 隧道发 HTTPS 请求（零依赖；node 内置 fetch 不暴露代理设置）。
// proxy 为空时直连。
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

// 经代理刷新 token（用 refresh_token 向 AWS OIDC 换 access_token）
async function refreshToken(rec, proxy) {
  const body = JSON.stringify({
    clientId: rec.client_id,
    clientSecret: rec.client_secret,
    grantType: "refresh_token",
    refreshToken: rec.refresh_token,
  });
  const resp = await httpsPost(OIDC_TOKEN_URL, body, proxy);
  let payload;
  try {
    payload = JSON.parse(resp.body);
  } catch {
    throw new Error(`刷新响应非 JSON (HTTP ${resp.status}): ${resp.body.slice(0, 120)}`);
  }
  if (!payload.accessToken) throw new Error(`刷新返回无 accessToken: ${JSON.stringify(payload)}`);
  const expiresIn = payload.expiresIn || 3600;
  rec.access_token = payload.accessToken;
  rec.refresh_token = payload.refreshToken || rec.refresh_token;
  rec.expires_in = expiresIn;
  rec.expires_at = isoAfter(expiresIn);
  return rec;
}

function buildData(rec, proxyPoolId) {
  const psd = {
    profileArn: rec.profile_arn, // ★ 403 根因，必须有
    region: rec.region,
    authMethod: rec.auth_method || "idc",
    clientId: rec.client_id,
    clientSecret: rec.client_secret,
  };
  if (proxyPoolId) psd.proxyPoolId = proxyPoolId;
  return {
    accessToken: rec.access_token || "",
    refreshToken: rec.refresh_token,
    expiresAt: rec.expires_at || null,
    expiresIn: rec.expires_in || 3600,
    testStatus: "active",
    providerSpecificData: psd,
    // 官方中转 Opus 组合在供应商连接里也保留模型锁键，值为 null 表示不锁定单账号。
    modelLock_claude_opus_4_6: null,
    modelLock_claude_opus_4_7: null,
    modelLock_claude_opus_4_8: null,
    "modelLock_claude-opus-4.6": null,
    "modelLock_claude-opus-4.7": null,
    "modelLock_claude-opus-4.8": null,
    "modelLock_claude-opus-4-6": null,
    "modelLock_claude-opus-4-7": null,
    "modelLock_claude-opus-4-8": null,
  };
}

function makeName(rec, srcFile) {
  const base = basename(srcFile, extname(srcFile));
  if (base.toLowerCase().startsWith("item")) return base;
  const ts = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 15);
  return `kiro-${rec.email || "unknown"}-${ts}`;
}

// 确保存在指向 proxy 的代理池，返回其 id（已存在则复用）
function ensureProxyPool(db, proxy) {
  proxy = normalizeProxy(proxy);
  const rows = db.prepare("SELECT id, data FROM proxyPools").all();
  for (const r of rows) {
    try {
      if (JSON.parse(r.data).proxyUrl === proxy) return r.id;
    } catch {}
  }
  const id = randomUUID();
  const ts = nowIso();
  const data = JSON.stringify({
    name: "kiro-import",
    proxyUrl: proxy,
    noProxy: "",
    type: "http",
    strictProxy: false,
    lastTestedAt: null,
    lastError: null,
  });
  db.prepare(
    "INSERT INTO proxyPools (id, isActive, testStatus, data, createdAt, updatedAt) VALUES (?,?,?,?,?,?)"
  ).run(id, 1, "unknown", data, ts, ts);
  return id;
}

function upsert(db, rec, srcFile, proxyPoolId) {
  const provider = rec.type || "kiro";
  const email = rec.email;
  const dataJson = JSON.stringify(buildData(rec, proxyPoolId));
  const ts = nowIso();
  const existing = db
    .prepare("SELECT id FROM providerConnections WHERE provider=? AND email=?")
    .get(provider, email);

  if (existing) {
    db.prepare(
      "UPDATE providerConnections SET authType=?, name=?, data=?, isActive=1, updatedAt=? WHERE id=?"
    ).run("oauth", makeName(rec, srcFile), dataJson, ts, existing.id);
    return `更新 ${provider}/${email} (id=${existing.id})`;
  }
  const id = randomUUID();
  db.prepare(
    "INSERT INTO providerConnections (id, provider, authType, name, email, priority, isActive, data, createdAt, updatedAt) VALUES (?,?,?,?,?,?,?,?,?,?)"
  ).run(id, provider, "oauth", makeName(rec, srcFile), email, 1, 1, dataJson, ts, ts);
  return `新增 ${provider}/${email} (id=${id})`;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!opts.input || !opts.db) {
    console.error("用法: node import_kiro.mjs <认证文件或目录> <代理地址> --db <data.sqlite>");
    process.exit(2);
  }

  const db = new DatabaseSync(opts.db);
  // 确认目标表存在，避免写错库
  const t = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='providerConnections'")
    .get();
  if (!t) {
    console.error("[错误] 该 sqlite 没有 providerConnections 表，可能不是 9Router 库");
    process.exit(2);
  }

  let proxyPoolId = null;
  if (opts.proxy && opts.proxyPool) {
    proxyPoolId = ensureProxyPool(db, opts.proxy);
    console.log(`[代理] 使用代理池 ${proxyPoolId} -> ${normalizeProxy(opts.proxy)}`);
  }

  const files = expandInputs(opts.input);
  let ok = 0,
    skipped = 0;
  for (const fp of files) {
    let records;
    try {
      records = loadRecords(fp);
    } catch (e) {
      console.log(`[跳过] ${fp}: 解析失败 ${e.message}`);
      skipped++;
      continue;
    }
    for (const rec of records) {
      const missing = validate(rec);
      if (missing.length) {
        console.log(`[跳过] ${basename(fp)} email=${rec.email} 缺字段: ${missing.join(", ")}`);
        skipped++;
        continue;
      }
      if (opts.refresh) {
        try {
          await refreshToken(rec, opts.proxy ? normalizeProxy(opts.proxy) : null);
          console.log(`[刷新] ${rec.email} token 已更新，有效期至 ${rec.expires_at}`);
        } catch (e) {
          console.log(`[警告] ${rec.email} 刷新失败（用文件原 token）：${e.message}`);
        }
      }
      if (!rec.access_token) {
        console.log(`[跳过] ${rec.email} 无可用 access_token`);
        skipped++;
        continue;
      }
      console.log("[ok] " + upsert(db, rec, fp, proxyPoolId));
      ok++;
    }
  }
  db.close();
  console.log(`\n完成：成功 ${ok}，跳过 ${skipped}`);
  if (ok) console.log("提示：导入后请重启 9Router，使其重新加载数据库。");
  process.exit(ok ? 0 : 1);
}

main().catch((e) => {
  console.error("致命错误:", e);
  process.exit(1);
});
