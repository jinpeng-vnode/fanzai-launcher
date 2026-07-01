// 文件日志系统 — 全程结构化日志落盘，崩溃也留底
// 对齐 start.ps1 的日志风格：每步、每错、每个子进程输出都带时间戳写入文件。
// 任何问题直接读 runtime/client.log 即可定位，不依赖会被杀掉的前台命令。
const fs = require('fs');
const path = require('path');
const { LOG_PATH, RUNTIME_DIR } = require('./paths');

let stream = null;
let renderLogger = null; // 可选：把日志同时推给渲染层

// 初始化：确保目录存在，启动时轮转旧日志（保留上一份为 .prev.log）
function init() {
  try {
    fs.mkdirSync(RUNTIME_DIR, { recursive: true });
    // 轮转：上一次的 client.log → client.prev.log（崩溃后还能回看上一轮）
    if (fs.existsSync(LOG_PATH)) {
      const prev = LOG_PATH.replace(/\.log$/, '.prev.log');
      try { fs.rmSync(prev, { force: true }); } catch {}
      try { fs.renameSync(LOG_PATH, prev); } catch {}
    }
    stream = fs.createWriteStream(LOG_PATH, { flags: 'a' });
    write('INFO', '=== 客户端启动 ===');
    write('INFO', `平台 ${process.platform} ${process.arch} | electron ${process.versions.electron} | node ${process.versions.node}`);
    write('INFO', `日志文件 ${LOG_PATH}`);
  } catch (e) {
    // 日志系统本身不能反过来打挂程序
    try { console.error('[logger] init 失败', e); } catch {}
  }
}

function ts() {
  return new Date().toISOString();
}

// 核心写入：带时间戳 + 级别，落盘 + 控制台。level: INFO/WARN/ERROR/STEP/PROC
function write(level, msg) {
  const line = `[${ts()}] [${level}] ${msg}`;
  try { stream && stream.write(line + '\n'); } catch {}
  try { (level === 'ERROR' ? console.error : console.log)(line); } catch {}
  // 推给渲染层（启动日志框）——只推面向用户的级别
  if (renderLogger && (level === 'STEP' || level === 'INFO' || level === 'WARN' || level === 'ERROR')) {
    try { renderLogger(msg); } catch {}
  }
}

const info = (m) => write('INFO', m);
const warn = (m) => write('WARN', m);
const step = (m) => write('STEP', m);
// 错误：把 message + stack 都写进去
function error(m, err) {
  if (err) {
    write('ERROR', `${m}: ${err.message || err}`);
    if (err.stack) write('ERROR', 'STACK ' + err.stack.replace(/\n/g, ' | '));
  } else {
    write('ERROR', m);
  }
}
// 子进程输出：逐行打 PROC 标签
function proc(tag, chunk) {
  String(chunk).split(/\r?\n/).forEach((l) => { if (l.trim()) write('PROC', `[${tag}] ${l}`); });
}

// 绑定渲染层日志推送（main 创建窗口后调用）
function attachRenderer(fn) { renderLogger = fn; }

module.exports = { init, info, warn, step, error, proc, attachRenderer, LOG_PATH };
