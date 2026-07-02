# 贡献指南 / Contributing Guide

感谢你对本项目的关注！欢迎提交 Issue 和 Pull Request。

Thank you for your interest! Issues and Pull Requests are welcome.

## 开发环境 / Development Setup

```bash
# 克隆仓库
git clone https://github.com/jinpeng-vnode/fanzai-launcher.git
cd fanzai-launcher

# 安装依赖
npm install

# 开发模式
npm run dev
```

**要求 / Requirements:**
- Node.js 18+
- Windows 10+（构建 Windows 包）
- macOS ARM64（构建 Mac 包，需 Mac Mini 远程构建）

## 打包命令 / Build Commands

| 命令 | 产物 |
|------|------|
| `npm run pack:win:green` | Windows 绿色版 zip |
| `npm run pack:mac:green` | macOS 绿色版 zip |
| `npm run pack:win:setup` | Windows NSIS 安装包 |
| `npm run pack:mac:dmg` | macOS DMG 安装包 |

Mac 构建需在 Mac Mini 上执行：
```bash
python scripts/mac-build.py
```

## 项目结构 / Project Structure

```
.
├── package.json          # 根目录即 Electron 项目
├── src/main/             # 主进程
├── src/preload/          # 预加载脚本
├── src/renderer/         # 渲染进程（UI）
├── scripts/              # 工具脚本（构建、导入、扫描）
├── lib/                  # 共享库
├── docs/                 # 文档
├── runtime/              # 运行时（gitignore）
└── dist-packages/        # 分发包产物（gitignore）
```

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
