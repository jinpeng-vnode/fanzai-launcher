# 饭仔客户端（Electron）

现代化暗色 GUI 启动器，替代原来的 `.bat` + PowerShell 命令行问答。
负责：管理多个 API Key、查询用量/余额、一键启动 VS Code（Claude Code）、后台采集设备指纹。

---

## 1. 它在整个启动包里的位置

```
饭仔9router-kiro-启动包/
├── client/                    ← 本客户端（开发源码）
│   ├── src/
│   │   ├── main/              主进程（Node 环境，可访问文件/网络/子进程）
│   │   │   ├── main.js        创建无边框暗色窗口、生命周期
│   │   │   ├── ipc.js         所有能力实现（配置/多key/查询/指纹/启动）
│   │   │   └── paths.js       定位启动包根目录与各配置文件路径
│   │   ├── preload/
│   │   │   └── preload.js     白名单桥接：渲染层只能调这里暴露的 api
│   │   └── renderer/          渲染层（浏览器环境，纯 UI，拿不到 node）
│   │       ├── index.html     结构
│   │       ├── styles.css     暗色样式
│   │       └── renderer.js    交互逻辑 + WebGL GPU 指纹
│   └── package.json
├── runtime/
│   ├── .launcher.json         ← 启动配置（baseUrl/apiKey/model），由客户端主进程读写
│   ├── keys.json              ← 多 key 仓库（客户端写入）
│   └── vscode/                便携 VS Code（首次启动下载）
├── 启动.bat                   ← Windows 绿色包引导脚本，只负责拉起客户端
└── 启动.command               ← macOS 绿色包引导脚本，只负责拉起客户端
```

**核心衔接点**：客户端选中某个 key → 写进 `runtime/.launcher.json` 的 `apiKey` 字段 →
主进程里的 launcher 模块读取配置、下载运行时、安装扩展并注入环境变量启动 VS Code。
根目录启动脚本只做引导，不承载安装、解压或 9Router 启动逻辑。

---

## 2. 架构：三层隔离

Electron 安全模型，三层各司其职，渲染层（UI）**拿不到** node 能力，必须经 preload 白名单：

```
渲染层 renderer.js        preload.js              主进程 ipc.js
（UI，无 node）   ──调用──> window.api.xxx  ──IPC──> 实际实现（文件/网络/子进程）
```

- `contextIsolation: true` + `nodeIntegration: false`：UI 即使被注入脚本也碰不到文件系统
- 所有敏感操作（读写 key、查询、启动 VS Code）都在主进程，UI 只发请求

---

## 3. 功能

| 功能 | 实现位置 | 说明 |
|------|----------|------|
| 多 key 管理 | `ipc.js` readKeys/addKey/removeKey/selectKey | 存 `runtime/keys.json` |
| 切换 key | `selectKey` | 选中即写入 `.launcher.json`，启动 VS Code 就用它 |
| 查询用量/余额 | `ipc.js` fetchKeyStatus | POST `xapi.labpinky.com/api/public/key-status` |
| 批量查询 | `ipc.js` statusAll | 并发查所有 key |
| 一键启动 VS Code | `ipc.js` + `launcher/` | JS/mjs 编排下载、扩展安装与进程启动 |
| 店铺购买/续费 | `ipc.js` shell.openExternal | 打开 `pay.ldxp.cn/shop/BUX1PQH9` |
| 设备指纹 | `ipc.js` collectFingerprint + `renderer.js` collectGpuFingerprint | 后台采集，不上屏 |

### 多 key 数据结构（`runtime/keys.json`）

```json
{
  "activeId": "<当前选中 key 的 id>",
  "keys": [
    { "id": "<uuid>", "label": "备注名", "value": "sk-...", "prefix": "sk-VRhN2P0F" }
  ]
}
```

### 用量换算

实测 `150000 quota = $15`（Opus 输入价 /1M）→ **1 美元 = 10000 quota**。
界面金额 = `quota / 10000`，见 `renderer.js` 的 `QUOTA_PER_USD`。

---

## 4. 设备指纹（为服务端绑定铺路）

分两层采集，合并成最终 `deviceId`：

- **硬件层**（主进程 `collectFingerprint`）：CPU 型号/核数、内存、网卡 MAC、主机名、用户名 → sha256
- **GPU 层**（渲染层 `collectGpuFingerprint`）：WebGL 厂商/renderer 字符串 + 渲染固定场景读回像素做 FNV-1a 哈希（不同 GPU/驱动产生像素级差异）
- **合并**：`sha256(硬件id + GPU厂商 + renderer + GPU像素哈希)`

> ⚠️ 诚实边界：指纹是客户端自报，虚拟机 / Hook 系统 API 可以伪造。
> 它的作用是**抬高 99% 普通用户的门槛 + 给服务端异常检测喂信号**，
> 不是不可破的硬锁。真正的兜底是服务端的「流量上限 + 同 key 多设备/多 IP 检测」。

目前指纹**只采集、未上报**。等服务端校验网关（FastAPI）定好接口后，
在 `renderer.js` 的 `initFingerprint` 之后把 `deviceFp` POST 给网关做绑定。

---

## 5. 开发 / 运行

```bash
cd client
npm install          # 依赖装进 client/node_modules，不污染全局
npm start            # 启动客户端
npm run dev          # 带 DevTools
```

### ⚠️ 在 VS Code / Claude 扩展里启动的坑

宿主（VS Code）本身是 Electron，会向子进程注入 `ELECTRON_RUN_AS_NODE=1`，
导致我们的 electron 退化成纯 Node 跑，报 `Cannot read properties of undefined (reading 'whenReady')`。

**解决**：启动时彻底删掉该变量（注意是删掉，不是设成 0——Electron 只看它存不存在）：

```bash
env -u ELECTRON_RUN_AS_NODE npm start
```

> 打包成独立 exe 发给客户后**不会有这个问题**，因为那时不再继承 VS Code 的环境。

---

## 6. 打包（绿色免安装）

```bash
cd client
npm run pack         # 仅打包到目录（测试用）
npm run dist         # 出 portable exe → ../runtime/electron-app/饭仔客户端.exe（中间产物）

cd ..
node client/scripts/make-dist.mjs  # 出完整绿色分发 zip
```

对用户只发布绿色 zip，不提供安装版。zip 内含 `启动.bat` / `启动.command`、Electron 产物和 mjs/lib 运行逻辑。便携 Node 与 9Router 由客户端首次启动从 npm 源自动下载安装，运行数据写入启动包自己的 `runtime/`，不写注册表，删文件夹即干净。

---

## 7. 待办（后续）

- [ ] **key 本地加密存储**：`keys.json` 现为明文，改 AES-256-GCM（Node 内置 `crypto`），密钥用机器指纹派生 → 换机器解不开
- [ ] **JS 字节码化**（bytenode）+ 出受保护的绿色包，发给客户
- [ ] **指纹上报网关**：对接 FastAPI 校验层，登录/请求时核对绑定设备
- [ ] 服务端：上游真 key 不下发，客户端只拿绑定设备的短期 token（最终防分享方案）
