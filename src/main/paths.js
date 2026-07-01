// 解析启动包根目录 — 向上查找含 scripts/ 目录的位置
// .app 打包后内部只有 src/，不会有 scripts/，所以不会误命中 .app 内部
// dev 模式：src/main/ 上两级即根目录
const path = require('path');
const fs = require('fs');

function resolveLauncherRoot() {
  // 允许用环境变量强制指定（打包后定位用）
  if (process.env.FANZAI_LAUNCHER_ROOT && fs.existsSync(process.env.FANZAI_LAUNCHER_ROOT)) {
    return process.env.FANZAI_LAUNCHER_ROOT;
  }
  let dir = __dirname;
  for (let i = 0; i < 8; i++) {
    if (fs.existsSync(path.join(dir, 'scripts'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // 兜底：src/main/ 上两级
  return path.join(__dirname, '..', '..');
}

const LAUNCHER_ROOT = resolveLauncherRoot();
const RUNTIME_DIR = path.join(LAUNCHER_ROOT, 'runtime');
const CONFIG_PATH = path.join(RUNTIME_DIR, '.launcher.json');
const KEYS_PATH = path.join(RUNTIME_DIR, 'keys.json');
const MCP_SETTINGS_PATH = path.join(RUNTIME_DIR, 'mcp-settings.json');
const LOG_PATH = path.join(RUNTIME_DIR, 'client.log');

module.exports = { LAUNCHER_ROOT, RUNTIME_DIR, CONFIG_PATH, KEYS_PATH, MCP_SETTINGS_PATH, LOG_PATH };
