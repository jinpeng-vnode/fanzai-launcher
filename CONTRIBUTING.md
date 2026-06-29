# 贡献指南 / Contributing Guide

感谢你对本项目的关注！欢迎提交 Issue 和 Pull Request。

Thank you for your interest! Issues and Pull Requests are welcome.

## 开发环境 / Development Setup

```bash
cd client
npm install
npm run dev   # 开发模式
npm run dist  # 构建 Electron portable exe（分发包中间产物）

cd ..
node client/scripts/make-dist.mjs  # 构建完整绿色分发包 zip
```

**要求 / Requirements:**
- Node.js 18+
- Windows 10+ (构建 Windows 绿色包)

## 代码规范 / Code Style

- JavaScript (ES2020+, no TypeScript)
- 中文注释优先，关键函数加英文 JSDoc
- 缩进 2 空格
- 文件编码 UTF-8

## 提交规范 / Commit Convention

```
feat: 新功能
fix: 修复
docs: 文档
style: 格式（不影响逻辑）
refactor: 重构
chore: 构建/工具
```

## Issue 模板 / Issue Template

提交 Issue 时请包含：
- 操作系统和版本
- 复现步骤
- 期望行为 vs 实际行为
- 错误截图或日志

## 安全 / Security

如发现安全漏洞，请勿公开提交 Issue。请通过邮件联系维护者。

If you discover a security vulnerability, please do NOT open a public issue. Contact the maintainer via email instead.
