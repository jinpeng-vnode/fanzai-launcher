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
- **Kiro 凭证扫描** — 一键从本机 Kiro IDE 提取 OAuth 凭证并导入 9Router
- **Claude Code / Codex 快速启动** — 配置好 API 后一键启动开发环境
- **自定义 API 管理** — 支持任意 OpenAI 兼容端点，自动检测模型列表

## ⚡ 快速开始

### 方式一：直接运行（推荐）

1. 下载 [Releases](../../releases) 页面的 `饭仔客户端-win-x64.zip`（绿色版，无需安装）
2. 解压后双击 `启动.bat`
3. 添加密钥或扫描本机 Kiro 凭证

### 方式二：从源码构建

```bash
# 克隆仓库
git clone https://github.com/jinpeng-vnode/api-relay-hub.git
cd api-relay-hub/饭仔9router-kiro-启动包/client

# 安装依赖
npm install

# 开发模式
npm run dev

# 构建 Electron portable exe（中间产物）
npm run dist

# 构建完整绿色分发包 zip
cd ..
node client/scripts/make-dist.mjs
```

## 🔑 核心功能

### Kiro 凭证扫描

自动扫描 `~/.aws/sso/cache/kiro-auth-token.json`，提取：
- RefreshToken（可直接导入 9Router）
- ProfileArn（区域路由必需）
- ClientId / ClientSecret（token 刷新用）

```bash
# 命令行工具（不需要客户端也能用）
node scan_kiro_credential.mjs
node scan_kiro_credential.mjs --output creds/kiro.json --refresh
```

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
├── client/               # Electron 客户端源码
│   ├── src/main/         # 主进程（IPC、启动器）
│   ├── src/preload/      # 预加载脚本（安全桥接）
│   └── src/renderer/     # 渲染进程（UI）
├── runtime/              # 运行时数据（便携 Node.js、9Router 等，首次启动自动下载）
├── creds/                # 凭证文件（.gitignore）
├── scan_kiro_credential.mjs  # Kiro 凭证扫描 CLI
├── import_kiro.mjs       # 凭证导入 9Router CLI
├── 启动.bat              # Windows 绿色包引导脚本
└── 启动.command          # macOS 绿色包引导脚本
```

## 📦 打包与分发

面向用户只发布绿色版 zip，不提供安装版。Windows 用户解压后运行 `启动.bat`，macOS 用户运行 `启动.command`。启动脚本只负责定位启动包根目录和拉起 Electron 客户端，下载运行时、安装扩展、启动 9Router/VS Code/Codex 等能力都在客户端主进程和 mjs 模块里完成。

```bash
node client/scripts/make-dist.mjs
```

Windows 会生成 `dist-packages/饭仔客户端-win-x64.zip`。`npm run dist` 生成的 `runtime/electron-app/饭仔客户端.exe` 是分发 zip 的中间产物。

## 🖥 平台支持

| 平台 | 状态 | 说明 |
|------|------|------|
| Windows x64 | ✅ 完整支持 | 绿色 zip，无需安装 |
| macOS (Intel/ARM) | 🔧 打包脚本已预留 | 需要 .app 签名/公证后正式发布 |
| Linux x64 | 🔧 计划中 | AppImage |

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
