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
- **Kiro Credential Management** — One-click import to 9Router via REST API (auto proxy pool, supports idc/external_idp)
- **Claude Code / Codex Quick Launch** — One-click launch after API configuration
- **Custom API Management** — Supports any OpenAI-compatible endpoint with auto model detection

## ⚡ Quick Start

### Option 1: Direct Download (Recommended)

1. Download the portable zip from the [Releases](../../releases) page
2. Extract and double-click `启动.bat` (Windows) or `启动.command` (macOS)
3. Go to "Credentials" tab → add credentials → start 9Router → click "Import to 9Router"

### Option 2: Build from Source

```bash
# Clone the repository
git clone https://github.com/jinpeng-vnode/fanzai-launcher.git
cd fanzai-launcher

# Install dependencies
npm install

# Development mode
npm run dev

# Build (see build commands below)
npm run pack:win:green   # Windows portable zip
npm run pack:mac:green   # macOS portable zip
```

## 🔑 Key Features

### Credential Import

Manage credentials in the "Credentials" tab:
- Add credentials (supports JSON paste, arrays auto-split into individual files)
- One-click import to running 9Router (REST API, hot-reload, idempotent)
- Auto-create proxy pool and link to connections
- Usage queries, overage toggle, account enable/disable

Supports two account types:
- **idc** (AWS SSO) → 9Router server-side token refresh
- **external_idp** (Microsoft Entra ID) → stored as-is

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
├── package.json              # Project root (Electron entry + build config)
├── src/                      # Electron source
│   ├── main/                 # Main process (IPC, launcher orchestration)
│   │   ├── launcher/         # 9Router / VS Code / Codex launch submodules
│   │   ├── paths.js          # Launcher root directory resolution
│   │   └── ipc.js            # IPC entry point
│   ├── preload/              # Preload scripts (security bridge)
│   └── renderer/             # Renderer process (UI)
├── scripts/                  # Utility scripts
│   ├── import_kiro.mjs       # Kiro credential import CLI (legacy, kept for compat)
│   ├── scan_kiro_credential.mjs  # Kiro credential scanner CLI
│   ├── mac-build.py          # Mac Mini remote build script
│   └── make-dist.mjs         # Portable distribution packaging
├── lib/                      # Shared libraries
├── docs/                     # Documentation
├── runtime/                  # Runtime data (auto-downloaded on first launch, gitignored)
├── creds/                    # Credential files (gitignored)
├── dist-packages/            # Distribution packages (gitignored)
├── 启动.bat                  # Windows portable launcher
└── 启动.command              # macOS portable launcher
```

## 📦 Build Commands

| Command | Output | Description |
|---------|--------|-------------|
| `npm run dev` | — | Development mode |
| `npm run pack:win:green` | `dist-packages/饭仔客户端-win-x64.zip` | Windows portable (extract & run) |
| `npm run pack:mac:green` | `dist-packages/饭仔客户端-mac-arm64.zip` | macOS portable (extract & run) |
| `npm run pack:win:setup` | `runtime/electron-app/饭仔客户端-Setup.exe` | Windows installer (NSIS) |
| `npm run pack:mac:dmg` | `runtime/electron-app/饭仔客户端-arm64.dmg` | macOS installer (DMG) |

Mac builds require execution on Mac Mini (no cross-compilation):
```bash
python scripts/mac-build.py  # SSH remote build on Mac Mini
```

## 🖥 Platform Support

| Platform | Status | Notes |
|----------|--------|-------|
| Windows x64 | ✅ Full support | Portable zip + NSIS installer |
| macOS ARM64 | ✅ Full support | Portable zip + DMG, unsigned (manual allow required) |
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
