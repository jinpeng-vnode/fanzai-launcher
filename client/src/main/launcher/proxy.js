// 跨平台代理检测 — 对齐 start.ps1 Detect-Proxy / start.sh detect_proxy
// Windows：注册表 → 环境变量
// macOS：环境变量 → scutil
// Linux：环境变量
const os = require('os');
const { execFileSync } = require('child_process');

function fromEnv() {
  for (const v of [process.env.HTTPS_PROXY, process.env.HTTP_PROXY, process.env.https_proxy, process.env.http_proxy]) {
    if (v) return v;
  }
  return null;
}

// Windows 注册表读系统代理
function fromWinRegistry() {
  try {
    const out = execFileSync(
      'reg',
      ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'],
      { encoding: 'utf8', windowsHide: true }
    );
    const enabled = /ProxyEnable\s+REG_DWORD\s+0x1/i.test(out);
    if (!enabled) return null;
    const m = out.match(/ProxyServer\s+REG_SZ\s+(.+)/i);
    if (!m) return null;
    const ps = m[1].trim();
    // 可能是 "host:port" 或 "http=...;https=..."
    if (/https?=/i.test(ps)) {
      const hm = ps.match(/https=([^;]+)/i) || ps.match(/http=([^;]+)/i);
      if (hm) return hm[1].trim();
    }
    return ps;
  } catch {
    return null;
  }
}

// macOS scutil 读系统 HTTP 代理
function fromMacScutil() {
  try {
    const out = execFileSync('scutil', ['--proxy'], { encoding: 'utf8' });
    const enabled = /HTTPEnable\s*:\s*1/.test(out);
    if (!enabled) return null;
    const host = (out.match(/HTTPProxy\s*:\s*(\S+)/) || [])[1];
    const port = (out.match(/HTTPPort\s*:\s*(\S+)/) || [])[1];
    if (host && port) return `http://${host}:${port}`;
    return null;
  } catch {
    return null;
  }
}

function normalizeProxy(p) {
  p = (p || '').trim();
  if (p && !/^(https?|socks5?):\/\//.test(p)) p = 'http://' + p;
  return p;
}

// 返回规范化后的代理地址，或 null
function detectProxy() {
  let p = fromEnv();
  if (!p) {
    if (os.platform() === 'win32') p = fromWinRegistry();
    else if (os.platform() === 'darwin') p = fromMacScutil();
  }
  return p ? normalizeProxy(p) : null;
}

module.exports = { detectProxy, normalizeProxy };
