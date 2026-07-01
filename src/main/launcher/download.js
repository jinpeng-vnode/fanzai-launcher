// 跨平台下载 — 测速选源 + 下载 + 解压
// 对齐 start.ps1 Select-FastestSource/Measure-HttpSource + start.sh select_fastest_source
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const https = require('https');
const { spawn } = require('child_process');

// HEAD 测速一个源，返回毫秒；不可达返回 Infinity
function measure(url, proxy, timeoutMs = 6000) {
  return new Promise((resolve) => {
    const start = Date.now();
    let settled = false;
    const done = (ok) => {
      if (settled) return;
      settled = true;
      resolve(ok ? Date.now() - start : Infinity);
    };
    try {
      const u = new URL(url);
      const mod = u.protocol === 'https:' ? https : http;
      // 有代理时走代理 CONNECT 比较复杂，这里测速直接用 HEAD 直连判断可达性即可
      const req = mod.request(
        { method: 'HEAD', hostname: u.hostname, port: u.port, path: u.pathname + u.search, timeout: timeoutMs },
        (res) => {
          res.resume();
          done(res.statusCode >= 200 && res.statusCode < 400);
        }
      );
      req.on('timeout', () => { req.destroy(); done(false); });
      req.on('error', () => done(false));
      req.end();
    } catch {
      done(false);
    }
  });
}

// sources: [{name, url}]，返回最快可用 url，全失败用 fallback
async function selectFastest(title, sources, fallbackUrl, proxy, log = () => {}) {
  log(`检测 ${title} 下载源…`);
  let best = null;
  let bestMs = Infinity;
  for (const s of sources) {
    const ms = await measure(s.url, proxy);
    if (ms < Infinity) {
      log(`    ${s.name}: ${ms}ms`);
      if (ms < bestMs) { bestMs = ms; best = s.url; }
    } else {
      log(`    ${s.name}: 不可用`);
    }
  }
  if (best) { log(`${title} 使用较快源`); return best; }
  log(`${title} 测速均失败，使用默认源`);
  return fallbackUrl;
}

function formatBytes(n) {
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = n;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

function emitProgress(onProgress, payload) {
  try { onProgress && onProgress(payload); } catch {}
}

// 下载文件到 dest，支持 http 代理 CONNECT 隧道、重定向
function downloadFile(url, dest, proxy, onProgress = null) {
  return new Promise((resolve, reject) => {
    const fetchOnce = (targetUrl, redirects) => {
      if (redirects > 6) return reject(new Error('重定向过多'));
      const t = new URL(targetUrl);
      const isHttps = t.protocol === 'https:';

      const onResponse = (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          const next = new URL(res.headers.location, targetUrl).toString();
          return fetchOnce(next, redirects + 1);
        }
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error(`HTTP ${res.statusCode} @ ${targetUrl}`));
        }
        const total = Number(res.headers['content-length'] || 0);
        let loaded = 0;
        const started = Date.now();
        let lastEmit = 0;
        let finalEmitted = false;
        const out = fs.createWriteStream(dest);
        res.on('data', (chunk) => {
          loaded += chunk.length;
          const now = Date.now();
          if (now - lastEmit < 250 && (!total || loaded < total)) return;
          lastEmit = now;
          const elapsed = Math.max(0.001, (now - started) / 1000);
          const speed = loaded / elapsed;
          emitProgress(onProgress, {
            phase: 'download',
            loaded,
            total,
            percent: total ? Math.min(100, (loaded / total) * 100) : null,
            label: total
              ? `${formatBytes(loaded)} / ${formatBytes(total)} · ${formatBytes(speed)}/s`
              : `${formatBytes(loaded)} · ${formatBytes(speed)}/s`,
          });
          if (total && loaded >= total) finalEmitted = true;
        });
        res.pipe(out);
        out.on('finish', () => out.close(() => {
          if (!finalEmitted) {
            emitProgress(onProgress, {
              phase: 'download',
              loaded,
              total,
              percent: 100,
              label: total ? `${formatBytes(total)} / ${formatBytes(total)}` : `${formatBytes(loaded)} downloaded`,
            });
          }
          resolve();
        }));
        out.on('error', reject);
      };

      // 经 http 代理：先 CONNECT 隧道再发请求（https 目标）
      if (proxy && isHttps) {
        const p = new URL(proxy);
        const conn = http.request({
          host: p.hostname, port: p.port || 80, method: 'CONNECT',
          path: `${t.hostname}:${t.port || 443}`,
        });
        conn.on('connect', (resC, socket) => {
          if (resC.statusCode !== 200) return reject(new Error(`代理 CONNECT 失败 ${resC.statusCode}`));
          https.request(targetUrl, { socket, agent: false }, onResponse).on('error', reject).end();
        });
        conn.on('error', reject);
        conn.end();
        return;
      }
      // 直连
      const mod = isHttps ? https : http;
      const opts = {};
      if (proxy && !isHttps) {
        // http 目标走代理：直接请求代理，path 用完整 url
        const p = new URL(proxy);
        opts.host = p.hostname; opts.port = p.port || 80; opts.path = targetUrl;
        opts.headers = { Host: t.host };
        http.request(opts, onResponse).on('error', reject).end();
        return;
      }
      mod.get(targetUrl, onResponse).on('error', reject);
    };
    fetchOnce(url, 0);
  });
}

function runExtract(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error((stderr || `${command} exited ${code}`).trim()));
    });
  });
}

// 解压 .zip（Windows 用系统 tar，失败回退 PowerShell Expand-Archive）
async function extractZip(zipPath, destDir, onProgress = null) {
  fs.mkdirSync(destDir, { recursive: true });
  emitProgress(onProgress, { phase: 'extract', percent: null, label: '正在解压…' });
  const sysTar = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
  if (fs.existsSync(sysTar)) {
    try {
      await runExtract(sysTar, ['-xf', zipPath, '-C', destDir]);
      emitProgress(onProgress, { phase: 'extract', percent: 100, label: '解压完成' });
      return;
    } catch { /* 回退 */ }
  }
  // PowerShell 回退
  await runExtract('powershell', [
    '-NoProfile',
    '-Command',
    'Expand-Archive -LiteralPath $args[0] -DestinationPath $args[1] -Force',
    zipPath,
    destDir,
  ]);
  emitProgress(onProgress, { phase: 'extract', percent: 100, label: '解压完成' });
}

// 解压 .tar.gz（mac/linux 用系统 tar）
async function extractTarGz(tarPath, destDir, onProgress = null) {
  fs.mkdirSync(destDir, { recursive: true });
  emitProgress(onProgress, { phase: 'extract', percent: null, label: '正在解压…' });
  await runExtract('tar', ['-xzf', tarPath, '-C', destDir]);
  emitProgress(onProgress, { phase: 'extract', percent: 100, label: '解压完成' });
}

module.exports = { selectFastest, downloadFile, extractZip, extractTarGz };
