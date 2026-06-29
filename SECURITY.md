# Security Policy / 安全策略

## Reporting a Vulnerability / 报告漏洞

If you discover a security vulnerability, please **DO NOT** open a public issue.

如果你发现安全漏洞，请**不要**公开提交 Issue。

Instead, please report it responsibly:
1. Email the maintainer directly (see profile)
2. Provide steps to reproduce
3. Allow reasonable time for a fix before disclosure

请通过以下方式负责任地报告：
1. 直接通过邮件联系维护者
2. 提供复现步骤
3. 在公开前给予合理的修复时间

## Scope / 范围

This project handles sensitive data including:
- OAuth tokens (Kiro refresh tokens)
- API keys
- Device fingerprints

本项目涉及敏感数据，包括：
- OAuth Token（Kiro refresh token）
- API Key
- 设备指纹

## Known Limitations / 已知限制

- Credentials are stored in plaintext JSON on disk (same approach as Kiro IDE itself)
- The Electron app runs with full Node.js access in the main process
- API keys are transmitted to configured endpoints over HTTPS

- 凭证以明文 JSON 存储在磁盘上（与 Kiro IDE 自身的方式一致）
- Electron 应用在主进程中拥有完整 Node.js 权限
- API Key 通过 HTTPS 传输到配置的端点
