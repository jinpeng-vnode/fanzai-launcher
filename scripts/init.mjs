// init.mjs — 9Router 统一启动入口（跨平台 Node.js）
//
// 流程：检测代理 → 确保运行时 → 启动 9Router → API 初始化 → 打印信息
//
// 用法：
//   node init.mjs [--port 20128] [--proxy http://...] [--no-setup] [--no-download]
//
// 环境变量：
//   NINEROUTER_PORT             — 端口（默认 20128）
//   NINEROUTER_INITIAL_PASSWORD — 管理密码（默认 admin123）
//   HTTP_PROXY / HTTPS_PROXY   — 代理

import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ── 参数解析 ──
function parseArgs(argv) {
  const opts = {
    port: parseInt(process.env.NINEROUTER_PORT || '20128', 10),
    proxy: null,
    noSetup: false,
    noDownload: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--port' && argv[i + 1]) opts.port = parseInt(argv[++i], 10);
    else if (a === '--proxy' && argv[i + 1]) opts.proxy = argv[++i];
    else if (a === '--no-setup') opts.noSetup = true;
    else if (a === '--no-download') opts.noDownload = true;
  }

  return opts;
}

// ── 代理检测 ──
async function detectProxy() {
  const candidates = [
    'http://127.0.0.1:7897',
    'http://127.0.0.1:7890',
    'http://127.0.0.1:1080',
    'http://127.0.0.1:8080',
  ];

  // 优先用环境变量
  const envProxy = process.env.HTTPS_PROXY || process.env.HTTP_PROXY
    || process.env.https_proxy || process.env.http_proxy;
  if (envProxy) {
    return envProxy;
  }

  // 逐个探测常见代理端口
  for (const candidate of candidates) {
    const url = new URL(candidate);
    const reachable = await testPort(url.hostname, parseInt(url.port, 10));
    if (reachable) return candidate;
  }

  return null;
}

function testPort(host, port, timeoutMs = 2000) {
  return new Promise((resolve) => {
    const sock = net.createConnection({ host, port });
    sock.setTimeout(timeoutMs);
    sock.on('connect', () => { sock.destroy(); resolve(true); });
    sock.on('timeout', () => { sock.destroy(); resolve(false); });
    sock.on('error', () => { sock.destroy(); resolve(false); });
  });
}

// ── 获取局域网 IP ──
function getLanIP() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal && !iface.address.startsWith('169.254.')) {
        return iface.address;
      }
    }
  }
  return null;
}

// ── 主流程 ──
async function main() {
  const opts = parseArgs(process.argv.slice(2));

  console.log('');
  console.log('╔══════════════════════════════════════════════════╗');
  console.log('║     饭仔 · 9Router 一键启动（Node.js 版）       ║');
  console.log('╚══════════════════════════════════════════════════╝');
  console.log('');
  console.log('免责声明：非官方产品；账号、OAuth、代理、费用及使用后果均由使用者自行承担。');
  console.log('');

  // 1. 检测代理
  if (!opts.proxy) {
    console.log('[*] 检测本机代理...');
    opts.proxy = await detectProxy();
  }
  if (opts.proxy) {
    // 标准化代理地址
    if (!/^(https?|socks5?):\/\//.test(opts.proxy)) {
      opts.proxy = 'http://' + opts.proxy;
    }
    console.log(`[✓] 使用代理: ${opts.proxy}`);
    process.env.HTTP_PROXY = opts.proxy;
    process.env.HTTPS_PROXY = opts.proxy;
  } else {
    console.log('[!] 未检测到代理。Kiro 连接可能需要代理，可用 --proxy 手动指定。');
  }
  console.log('');

  // 2. 确保运行时（Node.js + 9Router）
  // 如果正在被 runtime/node/node.exe 执行，说明 Node 已就绪，只需确保 9Router 安装
  const { ensureNode, ensureRouter, getPaths } = await import('./lib/runtime.mjs');

  let nodeExe = process.execPath; // 当前正在执行的 node
  if (!opts.noDownload) {
    // 如果当前 node 不在 runtime 目录内（例如系统 node 直接调用），仍检测/下载便携版
    const runtimeNodeDir = join(__dirname, 'runtime', 'node');
    const isPortableNode = process.execPath.startsWith(runtimeNodeDir.replace(/\\/g, '/'))
      || process.execPath.replace(/\//g, '\\').startsWith(runtimeNodeDir);

    if (!isPortableNode) {
      // 使用系统 node 运行，确保 runtime 下也有便携版（供 bat/command 脚本用）
      try {
        nodeExe = await ensureNode(opts.proxy);
      } catch (e) {
        console.log(`[!] 便携 Node 下载失败，继续使用系统 Node: ${e.message}`);
        nodeExe = process.execPath;
      }
    } else {
      console.log('[✓] 使用便携版 Node.js');
    }
  }

  const { routerBin, npmPrefix } = await ensureRouter(nodeExe, opts.proxy);
  const paths = getPaths(nodeExe, routerBin);
  console.log('');

  // 3. 启动 9Router
  const { startRouter, stopRouter } = await import('./lib/router.mjs');
  const dataDir = join(__dirname, 'runtime', '9router-data');
  process.env.DATA_DIR = dataDir;

  const routerHandle = await startRouter({
    nodeExe,
    routerBin,
    port: opts.port,
    host: '0.0.0.0',
    dataDir,
    proxy: opts.proxy,
  });
  console.log('');

  // 4. API 初始化
  let apiKey = null;
  if (!opts.noSetup) {
    try {
      const { runSetup } = await import('./lib/setup.mjs');
      const result = await runSetup({ port: opts.port, proxy: opts.proxy });
      apiKey = result.apiKey;
    } catch (e) {
      console.log(`[!] API 初始化失败: ${e.message}`);
      console.log('    可手动访问 Web UI 完成配置。');
    }
  } else {
    console.log('[*] 跳过 API 初始化（--no-setup）');
  }

  // 5. 打印连接信息
  const lanIP = getLanIP();
  const baseUrl = `http://127.0.0.1:${opts.port}`;
  const lanUrl = lanIP ? `http://${lanIP}:${opts.port}` : null;

  console.log('');
  console.log('══════════════════════════════════════════════════');
  console.log('  饭仔 · 9Router 已就绪');
  console.log('══════════════════════════════════════════════════');
  console.log('');
  console.log(`  本机地址   : ${baseUrl}`);
  if (lanUrl) {
    console.log(`  局域网地址 : ${lanUrl}`);
  }
  console.log(`  Web 管理   : ${baseUrl}`);
  if (apiKey) {
    console.log(`  API Key    : ${apiKey}`);
    console.log('');
    console.log('  在 Claude Code / Cursor / 其他客户端中设置：');
    console.log(`    ANTHROPIC_BASE_URL=${baseUrl}`);
    console.log(`    ANTHROPIC_AUTH_TOKEN=${apiKey}`);
  }
  if (opts.proxy) {
    console.log(`  代理       : ${opts.proxy}`);
  }
  console.log('');
  console.log('  可用模型：claude-opus-4.6, claude-opus-4.7, claude-opus-4.8,');
  console.log('           claude-sonnet-4, claude-sonnet-4.5');
  console.log('');
  console.log('  关闭本窗口将停止 9Router。');
  console.log('══════════════════════════════════════════════════');
  console.log('');

  // 6. 保持进程运行，Ctrl+C 或关窗口时清理
  if (routerHandle.process) {
    const cleanup = () => {
      console.log('\n[*] 正在停止 9Router...');
      stopRouter(routerHandle);
      process.exit(0);
    };

    process.on('SIGINT', cleanup);
    process.on('SIGTERM', cleanup);
    process.on('SIGHUP', cleanup);

    // Windows: 监听进程退出事件
    if (os.platform() === 'win32') {
      process.on('exit', () => {
        try { routerHandle.process.kill('SIGTERM'); } catch {}
      });
    }

    // 监控子进程退出
    routerHandle.process.on('exit', (code) => {
      console.log(`\n[!] 9Router 进程已退出 (code: ${code})`);
      process.exit(code || 1);
    });

    // 保持事件循环活跃
    await new Promise(() => {}); // 永不 resolve
  } else {
    // 复用已有实例，直接退出（不需要保持运行）
    console.log('[*] 复用已有 9Router 实例，初始化完成。');
  }
}

main().catch((e) => {
  console.error(`\n[✗] 启动失败: ${e.message}`);
  if (e.stack) {
    console.error(e.stack.split('\n').slice(1, 4).join('\n'));
  }
  process.exitCode = 1;
});
