// 预加载 — 在隔离上下文中只暴露一组白名单 API 给渲染层
// 渲染层拿不到 node / require，所有能力都经这里转发到主进程 IPC
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // 配置读写（.launcher.json）
  readConfig: () => ipcRenderer.invoke('config:read'),
  writeConfig: (cfg) => ipcRenderer.invoke('config:write', cfg),

  // key 用量/余额查询
  keyStatus: (apiKey) => ipcRenderer.invoke('key:status', apiKey),

  // 多 key 管理
  keysRead: () => ipcRenderer.invoke('keys:read'),
  keysAdd: (value, label) => ipcRenderer.invoke('keys:add', value, label),
  keysUpsertManual: (input) => ipcRenderer.invoke('keys:upsertManual', input),
  keysRemove: (id) => ipcRenderer.invoke('keys:remove', id),
  keysSelect: (id) => ipcRenderer.invoke('keys:select', id),
  keysStatusAll: () => ipcRenderer.invoke('keys:statusAll'),

  // 打开店铺（购买/续费）
  openShop: () => ipcRenderer.invoke('shop:open'),
  openUrl: (url) => ipcRenderer.invoke('url:open', url),

  // 设备指纹（硬件层；GPU 渲染指纹在渲染层用 WebGL 单独算后并入）
  fingerprint: () => ipcRenderer.invoke('device:fingerprint'),

  // MCP 配置
  mcpRead: () => ipcRenderer.invoke('mcp:read'),
  mcpWrite: (input) => ipcRenderer.invoke('mcp:write', input),
  mcpApply: (input) => ipcRenderer.invoke('mcp:apply', input),

  // 启动 VS Code：双模式
  launchRemote: () => ipcRenderer.invoke('vscode:launchRemote'),   // 我们的 key（远程）
  launchLocal: () => ipcRenderer.invoke('vscode:launchLocal'),     // 本地 9router
  launchCodex: () => ipcRenderer.invoke('vscode:launchCodex'),
  launchManualClaude: (cfg) => ipcRenderer.invoke('vscode:launchManualClaude', cfg),
  launchManualCodex: (cfg) => ipcRenderer.invoke('vscode:launchManualCodex', cfg),
  manualModels: (cfg) => ipcRenderer.invoke('manual:models', cfg),
  manualTestModel: (cfg) => ipcRenderer.invoke('manual:testModel', cfg),
  // 只起本地 9router（不开 VS Code）
  startRouterOnly: () => ipcRenderer.invoke('router:startOnly'),
  routerStatus: () => ipcRenderer.invoke('router:status'),
  stopRouter: () => ipcRenderer.invoke('router:stop'),

  // 扫描本机 Kiro 凭证
  scanKiroCredential: () => ipcRenderer.invoke('kiro:scanCredential'),

  // Kiro 账号凭证管理（用量查询 / 超额开关 / 增删）
  kiroListCredentials: () => ipcRenderer.invoke('kiro:listCredentials'),
  kiroFetchUsage: (accountId) => ipcRenderer.invoke('kiro:fetchUsage', accountId),
  kiroFetchOverage: (accountId) => ipcRenderer.invoke('kiro:fetchOverage', accountId),
  kiroSetOverage: (accountId, enabled) => ipcRenderer.invoke('kiro:setOverage', accountId, enabled),
  kiroSaveCredential: (jsonStr) => ipcRenderer.invoke('kiro:saveCredential', jsonStr),
  kiroDeleteCredential: (fileId) => ipcRenderer.invoke('kiro:deleteCredential', fileId),
  kiroGetProxy: () => ipcRenderer.invoke('kiro:getProxy'),

  // 启动日志流（下载/安装进度）——返回取消订阅函数
  onLaunchLog: (cb) => {
    const handler = (_e, line) => cb(line);
    ipcRenderer.on('launch:log', handler);
    return () => ipcRenderer.removeListener('launch:log', handler);
  },
  onLaunchProgress: (cb) => {
    const handler = (_e, payload) => cb(payload);
    ipcRenderer.on('launch:progress', handler);
    return () => ipcRenderer.removeListener('launch:progress', handler);
  },

  // 窗口控制
  winMinimize: () => ipcRenderer.send('win:minimize'),
  winClose: () => ipcRenderer.send('win:close'),
});
