// lib/router.mjs — 9Router 进程管理（启动、等待就绪、停止、端口检测）
//
// 零外部依赖，纯 Node.js 内置模块。

import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import http from 'node:http';
import net from 'node:net';

// ── 检测端口是否已被占用 ──
export function isPortInUse(port, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const sock = net.createConnection({ host, port });
    sock.setTimeout(2000);
    sock.on('connect', () => { sock.destroy(); resolve(true); });
    sock.on('timeout', () => { sock.destroy(); resolve(false); });
    sock.on('error', () => { sock.destroy(); resolve(false); });
  });
}

// ── 检查 9Router 健康（/api/health 或 /v1/models） ──
export function checkHealth(port, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const req = http.get(`http://${host}:${port}/v1/models`, { timeout: 3000 }, (res) => {
      let body = '';
      res.on('data', (c) => body += c);
      res.on('end', () => {
        resolve(res.statusCode === 200);
      });
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

// ── 等待就绪（轮询） ──
export async function waitForReady(port, host = '127.0.0.1', timeoutMs = 60000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await checkHealth(port, host)) return true;
    await sleep(1000);
  }
  return false;
}

// ── 启动 9Router 进程 ──
export async function startRouter({ nodeExe, routerBin, port = 20128, host = '0.0.0.0', dataDir, proxy }) {
  // 确保数据目录存在
  mkdirSync(dataDir, { recursive: true });

  // 检查是否已在运行
  const alreadyRunning = await isPortInUse(port, '127.0.0.1');
  if (alreadyRunning) {
    const healthy = await checkHealth(port, '127.0.0.1');
    if (healthy) {
      console.log(`[✓] 9Router 已在端口 ${port} 运行，复用现有实例`);
      return { process: null, reused: true, port };
    } else {
      throw new Error(`端口 ${port} 已被占用，但不是 9Router 服务。请先释放该端口。`);
    }
  }

  console.log(`[*] 启动 9Router (端口 ${port})...`);

  const env = {
    ...process.env,
    DATA_DIR: dataDir,
  };
  if (proxy) {
    env.HTTP_PROXY = proxy;
    env.HTTPS_PROXY = proxy;
  }

  const args = [routerBin, '--port', String(port), '--host', host, '--no-browser', '--skip-update'];

  const child = spawn(nodeExe, args, {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: false,
    windowsHide: true,
  });

  // 收集错误输出（仅保留最后几行用于诊断）
  let stderrBuf = '';
  child.stderr.on('data', (d) => {
    stderrBuf += d.toString();
    if (stderrBuf.length > 4096) stderrBuf = stderrBuf.slice(-2048);
  });

  child.on('error', (e) => {
    console.error(`[✗] 9Router 进程启动失败: ${e.message}`);
  });

  // 等待就绪
  console.log('[*] 等待 9Router 就绪...');
  const ready = await waitForReady(port, '127.0.0.1', 90000);

  if (!ready) {
    child.kill('SIGTERM');
    const errMsg = stderrBuf.trim().split('\n').slice(-5).join('\n');
    throw new Error(`9Router 启动超时（90秒）。\n最后错误信息:\n${errMsg}`);
  }

  console.log(`[✓] 9Router 已启动 (PID: ${child.pid}, 端口: ${port})`);
  return { process: child, reused: false, port };
}

// ── 停止 9Router ──
export function stopRouter(routerHandle) {
  if (!routerHandle || !routerHandle.process) return;
  try {
    routerHandle.process.kill('SIGTERM');
    console.log('[✓] 9Router 已停止');
  } catch (e) {
    // 进程可能已退出
  }
}

// ── 辅助 ──
function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}
