<div align="center">

# 饭仔 9Router + Kiro 启动包

**一键启动 AI 编程工具，自动管理 Kiro 凭证 + 9Router 智能路由**

[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey.svg)](#平台支持)

[English](README_EN.md) · 中文

</div>

---

## 📌 这是什么

饭仔启动包是一个 Electron 桌面客户端，集成了：

- **9Router 智能路由器** — 多账号自动轮换、三层降级、省 20-40% token
- **Kiro 凭证管理** — 一键导入凭证到 9Router（调 REST API，自动配代理池、支持 idc/external_idp）
- **Claude Code / Codex 快速启动** — 配置好 API 后一键启动开发环境
- **自定义 API 管理** — 支持任意 OpenAI 兼容端点，自动检测模型列表

## ⚡ 快速开始

### 方式一：直接运行（推荐）

1. 下载 [Releases](../../releases) 页面的绿色包 zip
2. 解压后双击 `启动.bat`（Windows）或 `启动.command`（macOS）
3. 在「账号凭证」tab 添加凭证 → 启动 9Router → 点「导入到 9Router」

### 方式二：从源码构建

```bash
# 克隆仓库
git clone https://github.com/jinpeng-vnode/fanzai-launcher.git
cd fanzai-launcher

# 安装依赖
npm install

# 开发模式
npm run dev

# 构建（详见下方打包命令）
npm run pack:win:green   # Windows 绿色版 zip
npm run pack:mac:green   # macOS 绿色版 zip
```

## 🔑 核心功能

### 凭证导入

在「账号凭证」tab 管理凭证：
- 添加凭证（支持 JSON 粘贴，数组自动拆分为多个文件）
- 一键导入到运行中的 9Router（调 REST API，热生效、可重复）
- 自动创建代理池并关联（对齐旧 import_kiro.mjs 逻辑）
- 用量查询、超额开关、账号启用/禁用

支持两种账号类型：
- **idc**（AWS SSO）→ 9Router 服务端刷新 token
- **external_idp**（微软 Entra ID）→ 原样存储

### 9Router 本地路由器

在本机启动 9Router，实现：
- 多 Kiro 账号自动轮换
- 请求失败自动降级
- RTK Token 压缩（省 20-40% token）
- OpenAI / Claude / Gemini 格式自动转换

### 多密钥管理

- 支持饭仔密钥（带用量查询）和自定义 API 并存
- 自动检测 API 地址和可用模型
- 一键切换当前活跃密钥

## 📁 项目结构

```
.
├── package.json              # 项目根（Electron 入口 + 构建配置）
├── src/                      # Electron 源码
│   ├── main/                 # 主进程（IPC、启动器编排）
│   │   ├── launcher/         # 9Router / VS Code / Codex 启动子模块
│   │   ├── paths.js          # 启动包根目录解析
│   │   └── ipc.js            # IPC 总入口
│   ├── preload/              # 预加载脚本（安全桥接）
│   └── renderer/             # 渲染进程（UI）
├── scripts/                  # 工具脚本
│   ├── import_kiro.mjs       # Kiro 凭证导入 CLI（旧，保留兼容）
│   ├── scan_kiro_credential.mjs  # Kiro 凭证扫描 CLI
│   ├── mac-build.py          # Mac Mini 远程构建脚本
│   └── make-dist.mjs         # 绿色分发包打包
├── lib/                      # 共享库
├── docs/                     # 文档（导入流程图等）
├── runtime/                  # 运行时数据（首次启动自动下载，gitignore）
├── creds/                    # 凭证文件（gitignore）
├── dist-packages/            # 分发包产物（gitignore）
├── 启动.bat                  # Windows 绿色包引导脚本
└── 启动.command              # macOS 绿色包引导脚本
```

## 📦 打包命令

| 命令 | 产物 | 说明 |
|------|------|------|
| `npm run dev` | — | 开发模式启动 |
| `npm run pack:win:green` | `dist-packages/饭仔客户端-win-x64.zip` | Windows 绿色版（解压即用） |
| `npm run pack:mac:green` | `dist-packages/饭仔客户端-mac-arm64.zip` | macOS 绿色版（解压即用） |
| `npm run pack:win:setup` | `runtime/electron-app/饭仔客户端-Setup.exe` | Windows 安装版（NSIS） |
| `npm run pack:mac:dmg` | `runtime/electron-app/饭仔客户端-arm64.dmg` | macOS 安装版（DMG） |

Mac 构建需在 Mac Mini 上执行（无法交叉编译）：
```bash
python scripts/mac-build.py  # SSH 到 Mac Mini 远程构建
```

## 🖥 平台支持

| 平台 | 状态 | 说明 |
|------|------|------|
| Windows x64 | ✅ 完整支持 | 绿色 zip + NSIS 安装包 |
| macOS ARM64 | ✅ 完整支持 | 绿色 zip + DMG，未签名需手动放行 |
| Linux x64 | 🔧 计划中 | AppImage |

## 功能全景图 — 完成度: 95%

> 项目定义：Electron 桌面客户端，集成 9Router 智能路由 + Kiro 凭证管理 + AI 编程工具一键启动
> 当前阶段：已上线（持续维护）
> 下一步优先级：
> 1. Linux 平台支持（AppImage）
> 2. 项目规范化整理（#1 进行中）
> 禁止：无

```
饭仔客户端 (fanzai-client)
├── Electron 主框架（src/main/）
│   ├── 无边框暗色窗口 — ✅
│   ├── 单实例锁 — ✅
│   ├── 崩溃护栏（uncaughtException/unhandledRejection）— ✅
│   ├── IPC 通信桥（ipc.js）— ✅
│   └── 文件日志系统（logger.js）— ✅
├── 9Router 本地路由器（src/main/launcher/ninerouter.js）
│   ├── 启动/停止/状态检测 — ✅
│   ├── 多账号自动轮换 — ✅
│   ├── 请求失败三层降级 — ✅
│   └── RTK Token 压缩 — ✅
├── Kiro 凭证管理（src/main/launcher/kiro-credentials.js）
│   ├── 凭证扫描（本机 AWS SSO 缓存）— ✅
│   ├── 凭证添加/删除/启用禁用 — ✅
│   ├── 一键导入到 9Router（REST API 热生效）— ✅
│   ├── 用量查询 — ✅
│   ├── 超额开关 — ✅
│   └── 支持 idc + external_idp 两种类型 — ✅
├── AI 工具启动器（src/main/launcher/）
│   ├── Claude Code 远程模式启动（vscode.js）— ✅
│   ├── Claude Code 本地 9Router 模式（vscode.js）— ✅
│   ├── Codex 启动（codex.js）— ✅
│   ├── 自定义 API + Claude Code（ipc.js）— ✅
│   ├── 自定义 API + Codex（ipc.js）— ✅
│   └── 项目运行时选择（project-runtime.js）— ✅
├── 多密钥管理（src/main/ipc.js）
│   ├── 饭仔密钥 + 自定义 API 并存 — ✅
│   ├── 添加/删除/切换密钥 — ✅
│   ├── 批量用量查询 — ✅
│   └── 自动检测模型列表 — ✅
├── MCP 配置管理（src/main/launcher/mcp.js）
│   ├── MCP 设置读写 — ✅
│   └── 同步到 Claude/Codex 配置 — ✅
├── 渲染进程 UI（src/renderer/）
│   ├── 暗色现代界面 — ✅
│   ├── 自绘标题栏 — ✅
│   └── 多 Tab 面板（凭证/密钥/启动）— ✅
├── 跨平台构建（scripts/）
│   ├── Windows 绿色版 zip — ✅
│   ├── Windows NSIS 安装版 — ✅
│   ├── macOS 绿色版 zip — ✅
│   ├── macOS DMG 安装版 — ✅
│   └── Linux AppImage — ❌(#1 计划中)
└── 工具脚本（scripts/）
    ├── Kiro 凭证导入 CLI — ✅
    ├── Kiro 凭证扫描 CLI — ✅
    └── Mac Mini 远程构建 — ✅
```

---

## ⚠️ 免责声明

本项目仅供技术学习与交流目的。

- 本工具涉及的 Kiro/AWS 逆向分析基于 [aws/amazon-q-developer-cli](https://github.com/aws/amazon-q-developer-cli)（Apache-2.0 许可）的公开源码
- 使用本工具产生的任何行为由使用者自行承担责任
- 请遵守相关服务的使用条款
- 不鼓励、不支持任何商业化滥用行为

## 🙏 致谢

- [9Router](https://github.com/decolua/9router) — 开源 AI 智能路由器
- [amazon-q-developer-cli](https://github.com/aws/amazon-q-developer-cli) — Kiro CLI 开源实现
- [Electron](https://www.electronjs.org/) — 跨平台桌面框架

## 📄 许可证

[MIT License](LICENSE) — 自由使用、修改、分发，但需保留版权声明。
