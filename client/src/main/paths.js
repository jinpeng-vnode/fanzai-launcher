// 解析启动包根目录 — 向上查找含 setup-vscode.ps1 的目录
// dev 模式：client/ 的上一级即启动包根
// 打包后：portable exe 解压目录，同样向上找
const path = require('path');
const fs = require('fs');

function resolveLauncherRoot() {
  // 允许用环境变量强制指定（打包后定位用）
  if (process.env.FANZAI_LAUNCHER_ROOT && fs.existsSync(process.env.FANZAI_LAUNCHER_ROOT)) {
    return process.env.FANZAI_LAUNCHER_ROOT;
  }
  let dir = __dirname;
  for (let i = 0; i < 8; i++) {
    if (fs.existsSync(path.join(dir, 'setup-vscode.ps1'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // 兜底：client 的上一级
  return path.join(__dirname, '..', '..', '..');
}

const LAUNCHER_ROOT = resolveLauncherRoot();
const RUNTIME_DIR = path.join(LAUNCHER_ROOT, 'runtime');
const CONFIG_PATH = path.join(RUNTIME_DIR, '.launcher.json');
const KEYS_PATH = path.join(RUNTIME_DIR, 'keys.json');
const MCP_SETTINGS_PATH = path.join(RUNTIME_DIR, 'mcp-settings.json');
const SETUP_VSCODE_PS1 = path.join(LAUNCHER_ROOT, 'setup-vscode.ps1');
const LOG_PATH = path.join(RUNTIME_DIR, 'client.log');

module.exports = { LAUNCHER_ROOT, RUNTIME_DIR, CONFIG_PATH, KEYS_PATH, MCP_SETTINGS_PATH, SETUP_VSCODE_PS1, LOG_PATH };
