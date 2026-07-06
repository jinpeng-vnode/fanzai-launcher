# L1-TASK-001 饭仔启动包 架构概述

## 一、项目定位

饭仔启动包（fanzai-launcher）是一个 Electron 桌面客户端，集成 9Router 智能路由 + Kiro 凭证管理 + AI 开发工具启动能力，面向需要高效使用 AI 编程工具的开发者。

## 二、技术栈

| 层级 | 技术 | 说明 |
|------|------|------|
| 框架 | Electron 33 | 跨平台桌面应用 |
| 主进程 | Node.js (CommonJS) | IPC 处理、进程管理、文件系统操作 |
| 渲染进程 | 原生 HTML/CSS/JS | 无框架，单页暗色 UI |
| 构建 | electron-builder 25 | NSIS/DMG/绿色包 |
| 分发 | 自定义 make-dist.mjs | 绿色 zip 打包 |

## 三、系统架构

```
┌─────────────────────────────────────────────────────┐
│                   渲染进程 (renderer/)                │
│  index.html + renderer.js + styles.css              │
│  无边框暗色 UI，Tab 切换                              │
└────────────────────────┬────────────────────────────┘
                         │ IPC (contextBridge)
┌────────────────────────▼────────────────────────────┐
│                   预加载层 (preload/)                 │
│  preload.js — 白名单 API 暴露给渲染层                 │
└────────────────────────┬────────────────────────────┘
                         │
┌────────────────────────▼────────────────────────────┐
│                   主进程 (main/)                      │
│  main.js — 窗口管理、生命周期                         │
│  ipc.js  — IPC 路由总入口（配置/密钥/启动/凭证）       │
│  logger.js — 文件日志 (runtime/client.log)           │
│  paths.js — 启动包根目录解析                          │
│  project-runtime.js — 项目运行时选择                  │
├─────────────────────────────────────────────────────┤
│                launcher/ 子模块                       │
│  ├── index.js          — 启动器编排入口               │
│  ├── ninerouter.js     — 9Router 本地进程管理         │
│  ├── vscode.js         — VS Code / Claude Code 启动  │
│  ├── codex.js          — Codex CLI 启动              │
│  ├── kiro-credentials.js — Kiro 凭证 CRUD + 用量查询 │
│  ├── mcp.js            — MCP 配置读写 + 应用         │
│  ├── proxy.js          — 系统代理检测                 │
│  ├── download.js       — 运行时资源下载               │
│  ├── node-runtime.js   — Node.js 运行时管理          │
│  └── sql/              — 9Router 数据库操作脚本       │
└─────────────────────────────────────────────────────┘
         │                        │
         ▼                        ▼
┌─────────────────┐    ┌──────────────────────┐
│  runtime/       │    │  creds/              │
│  9Router 二进制  │    │  Kiro 凭证文件        │
│  Node.js        │    │  (.json, gitignore)  │
│  配置文件        │    └──────────────────────┘
│  日志/缓存       │
└─────────────────┘
```

## 四、核心模块职责

### 4.1 主进程入口 (main.js)

- 单实例锁（防多开）
- 无边框暗色窗口创建
- 全局异常护栏（uncaughtException / unhandledRejection）
- 退出前收尾（停止 9Router 子进程）

### 4.2 IPC 路由 (ipc.js)

所有渲染层能力通过 IPC handle 暴露，按功能分组：

| 分组 | 频道前缀 | 能力 |
|------|----------|------|
| 配置 | `config:*` | 读写 .launcher.json |
| 密钥 | `keys:*` | 多 key 管理（增删改选/批量状态） |
| 启动 | `vscode:*` | Claude Code / Codex / 远程/本地/手动 |
| 路由器 | `router:*` | 9Router 启停/状态 |
| 凭证 | `kiro:*` | Kiro 凭证扫描/导入/用量/超额 |
| MCP | `mcp:*` | MCP 服务配置读写 |
| 更新 | `update:*` | 检查更新 |
| 系统 | `win:*`, `url:*`, `shop:*` | 窗口控制/打开链接 |

### 4.3 启动器编排 (launcher/)

支持多种启动模式：

1. **远程模式** — 使用饭仔密钥直连 LabPinky API
2. **本地 9Router 模式** — 起本地 9Router + 用户自有 Kiro 凭证
3. **手动 API 模式** — 自定义 OpenAI 兼容端点
4. **Codex 模式** — OpenAI Codex CLI 启动

### 4.4 Kiro 凭证管理 (kiro-credentials.js)

- 本地凭证文件读写（creds/ 目录）
- 支持 idc (AWS SSO) 和 external_idp (微软 Entra ID) 两种类型
- 用量查询 / 超额开关
- 一键导入到运行中的 9Router（调 REST API 热生效）

### 4.5 共享库 (lib/)

| 文件 | 职责 |
|------|------|
| router.mjs | 9Router 启动/停止/配置生成 |
| setup.mjs | 环境初始化（下载依赖、配置检查） |
| runtime.mjs | 运行时路径/版本管理 |

## 五、数据流

```
用户操作 UI
    ↓ IPC invoke
主进程 ipc.js 路由
    ↓
launcher/ 对应模块执行
    ↓ spawn/exec
外部进程（9Router / VS Code / Codex CLI）
    ↓ 日志回传
渲染层 launch:log 事件显示
```

## 六、文件存储

| 路径 | 用途 | 持久化 |
|------|------|--------|
| `runtime/.launcher.json` | 当前活跃配置（baseUrl/apiKey/model） | 是 |
| `runtime/keys.json` | 多密钥仓库 | 是 |
| `runtime/client.log` | 应用日志 | 是（轮转） |
| `runtime/mcp-settings.json` | MCP 服务配置 | 是 |
| `creds/*.json` | Kiro 凭证文件 | 是（gitignore） |
| `runtime/electron-user-data/` | Electron 用户数据（绿色化） | 是 |

## 七、安全边界

- **contextIsolation: true** — 渲染层无法直接访问 Node API
- **preload 白名单** — 只暴露必要的 IPC 频道
- **凭证 gitignore** — creds/ 和 runtime/ 不入库
- **单实例锁** — 防止多开导致端口冲突

## 八、构建与分发

- 绿色包模式（推荐）：`make-dist.mjs` 打包为解压即用的 zip
- 安装包模式：electron-builder 生成 NSIS (Windows) / DMG (macOS)
- Mac 构建需在 ARM64 Mac 上执行（`scripts/mac-build.py` 远程构建）

## 九、平台差异处理

| 能力 | Windows | macOS |
|------|---------|-------|
| 绿色包启动 | 启动.bat | 启动.command |
| 9Router 二进制 | runtime/9router.exe | runtime/9router |
| 代理检测 | 注册表 / 环境变量 | networksetup |
| 进程终止 | taskkill | kill |
