<div align="center">

# Fanzai 9Router + Kiro Launcher

**One-click AI coding tools launcher with automatic Kiro credential management + 9Router smart routing**

[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey.svg)](#platform-support)

[中文](README.md) · English

</div>

---

## 📌 What Is This

Fanzai Launcher is an Electron desktop client that integrates:

- **9Router Smart Router** — Multi-account rotation, 3-tier fallback, saves 20-40% tokens
- **Kiro Credential Scanner** — One-click extraction of OAuth credentials from local Kiro IDE
- **Claude Code / Codex Quick Launch** — One-click launch after API configuration
- **Custom API Management** — Supports any OpenAI-compatible endpoint with auto model detection

## ⚡ Quick Start

### Option 1: Direct Download (Recommended)

1. Download `饭仔客户端-win-x64.zip` from the [Releases](../../releases) page (portable zip, no installation required)
2. Extract it and double-click `启动.bat`
3. Add API keys or scan local Kiro credentials

### Option 2: Build from Source

```bash
# Clone the repository
git clone https://github.com/jinpeng-vnode/api-relay-hub.git
cd api-relay-hub/饭仔9router-kiro-启动包/client

# Install dependencies
npm install

# Development mode
npm run dev

# Build Electron portable exe (intermediate artifact)
npm run dist

# Build the complete portable distribution zip
cd ..
node client/scripts/make-dist.mjs
```

## 🔑 Key Features

### Kiro Credential Scanner

Automatically scans `~/.aws/sso/cache/kiro-auth-token.json` to extract:
- RefreshToken (directly importable to 9Router)
- ProfileArn (required for region routing)
- ClientId / ClientSecret (for token refresh)

```bash
# CLI tool (works without the GUI client)
node scan_kiro_credential.mjs
node scan_kiro_credential.mjs --output creds/kiro.json --refresh
```

### 9Router Local Router

Runs 9Router locally to provide:
- Multi-Kiro-account automatic rotation
- Automatic fallback on request failure
- RTK Token compression (saves 20-40% tokens)
- Automatic format translation between OpenAI / Claude / Gemini

### Multi-Key Management

- Supports both Fanzai keys (with usage queries) and custom APIs
- Auto-detect API endpoint and available models
- One-click switching between active keys

## 📁 Project Structure

```
.
├── client/               # Electron client source
│   ├── src/main/         # Main process (IPC, launchers)
│   ├── src/preload/      # Preload scripts (security bridge)
│   └── src/renderer/     # Renderer process (UI)
├── runtime/              # Runtime data (portable Node.js, 9Router, etc., auto-downloaded on first launch)
├── creds/                # Credential files (.gitignore'd)
├── scan_kiro_credential.mjs  # Kiro credential scanner CLI
├── import_kiro.mjs       # Credential import to 9Router CLI
├── 启动.bat              # Windows portable package launcher
└── 启动.command          # macOS portable package launcher
```

## 📦 Packaging and Distribution

The user-facing release is a portable zip only. There is no installer build. Windows users extract the zip and run `启动.bat`; macOS users run `启动.command`. The startup scripts only locate the launcher root and start the Electron client. Runtime downloads, extension installation, 9Router startup, VS Code launch, and Codex launch are handled by the Electron main process and mjs modules.

```bash
node client/scripts/make-dist.mjs
```

On Windows this creates `dist-packages/饭仔客户端-win-x64.zip`. The `runtime/electron-app/饭仔客户端.exe` produced by `npm run dist` is an intermediate artifact used by the zip package.

## 🖥 Platform Support

| Platform | Status | Notes |
|----------|--------|-------|
| Windows x64 | ✅ Full support | Portable zip, no install needed |
| macOS (Intel/ARM) | 🔧 Packaging script prepared | Requires .app signing/notarization before public release |
| Linux x64 | 🔧 Planned | AppImage |

## ⚠️ Disclaimer

This project is for educational and research purposes only.

- Kiro/AWS reverse engineering is based on the publicly available [aws/amazon-q-developer-cli](https://github.com/aws/amazon-q-developer-cli) (Apache-2.0 license)
- Users are solely responsible for any actions taken using this tool
- Please comply with the terms of service of all related services
- Commercial abuse is neither encouraged nor supported

## 🙏 Acknowledgments

- [9Router](https://github.com/decolua/9router) — Open source AI smart router
- [amazon-q-developer-cli](https://github.com/aws/amazon-q-developer-cli) — Kiro CLI open source implementation
- [Electron](https://www.electronjs.org/) — Cross-platform desktop framework

## 📄 License

[MIT License](LICENSE) — Free to use, modify, and distribute with attribution.
