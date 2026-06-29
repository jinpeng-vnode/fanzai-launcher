// 主进程 — 创建无边框暗色窗口、管理生命周期、桥接系统能力
//
// 日志：最早期就初始化文件日志（runtime/client.log），连模块加载期的崩溃都能留底。
// 任何问题直接读 runtime/client.log（上一轮在 client.prev.log）。
const fs = require('fs');
const { RUNTIME_DIR } = require('./paths');
const log = require('./logger');
log.init();

let app, BrowserWindow, ipcMain, registerIpcHandlers, launcher, path;
try {
  ({ app, BrowserWindow, ipcMain } = require('electron'));
  path = require('path');
  ({ registerIpcHandlers } = require('./ipc'));
  launcher = require('./launcher');
} catch (e) {
  // 模块加载阶段崩溃也写进日志，否则窗口一闪而过查不到原因
  log.error('模块加载失败', e);
  throw e;
}

const isDev = process.argv.includes('--dev');

let mainWindow = null;

try {
  const electronUserData = path.join(RUNTIME_DIR, 'electron-user-data');
  fs.mkdirSync(electronUserData, { recursive: true });
  app.setPath('userData', electronUserData);
} catch (e) {
  log.error('设置 Electron 绿色配置目录失败', e);
}

// 崩溃护栏：后台启动器（9router/VS Code）里任何未捕获的异常或 Promise 拒绝
// 都不该带走整个窗口。写进日志文件 + 推给渲染层提示，但主进程继续活着。
process.on('uncaughtException', (err) => {
  log.error('uncaughtException', err);
  try { mainWindow?.webContents.send('launch:log', '[错误] ' + (err && err.message || err)); } catch {}
});
process.on('unhandledRejection', (reason) => {
  log.error('unhandledRejection', reason instanceof Error ? reason : new Error(String(reason)));
  try { mainWindow?.webContents.send('launch:log', '[错误] ' + (reason && reason.message || reason)); } catch {}
});

function createWindow() {
  log.step('创建主窗口');
  mainWindow = new BrowserWindow({
    width: 980,
    height: 680,
    minWidth: 880,
    minHeight: 600,
    show: false,
    frame: false,              // 无边框 — 自绘标题栏，配合暗色现代 UI
    titleBarStyle: 'hidden',
    backgroundColor: '#0f1115', // 暗色底，避免加载白闪
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true,  // 渲染层与 node 隔离，只能走 preload 暴露的白名单 API
      nodeIntegration: false,
      sandbox: false,
    },
  });

  // 渲染层崩溃 / 白屏也写进日志
  mainWindow.webContents.on('render-process-gone', (_e, details) => {
    log.error('渲染进程退出: ' + JSON.stringify(details));
  });
  mainWindow.webContents.on('preload-error', (_e, p, err) => {
    log.error('preload 错误 ' + p, err);
  });

  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  mainWindow.once('ready-to-show', () => {
    log.step('窗口就绪，显示');
    mainWindow.show();
    if (isDev) mainWindow.webContents.openDevTools({ mode: 'detach' });
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// 单实例锁：只允许一个客户端实例。开第二个时聚焦已有窗口并退出自己。
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });

  app.whenReady().then(() => {
    registerIpcHandlers(ipcMain, () => mainWindow);
    createWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// 退出前收尾：停掉本进程拉起的本地 9router，避免遗留后台进程
app.on('before-quit', () => {
  try { launcher.stopLocalRouter(); } catch {}
});
