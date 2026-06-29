# Changelog / 更新日志

## [0.2.1] - 2026-06-24

### 修复 / Fixed
- Windows `启动.bat` 改为纯引导脚本，不再硬编码中文 exe 文件名，降低不同系统编码导致启动失败的风险。
- 重复点击启动脚本时由 Electron 单实例逻辑接管，脚本自身启动客户端后立即退出，避免保留无意义的 cmd 窗口。

### 文档 / Docs
- 明确用户侧只发布绿色 zip，不提供安装版。
- 更新中英文 README、客户端 README 和贡献指南中的打包/启动说明。

## [0.2.0] - 2026-06-20

### 新增 / Added
- Kiro 凭证扫描功能（GUI + CLI）
- 一键导入凭证到 9Router
- 自定义 API 面板"+ 新建"按钮移至标题栏
- `scan_kiro_credential.mjs` CLI 工具

### 修复 / Fixed
- 密钥列表"自定义"标签遮挡名字的布局问题
- 9Router User-Agent 版本号更新至 KiroIDE 0.12.333

### 变更 / Changed
- 移除侧边栏冗余的"新建自定义 API"按钮
- 移除自定义面板底部冗余的"新建配置"按钮

## [0.1.0] - 2026-06-08

### 初始版本 / Initial Release
- Electron GUI 客户端
- 饭仔密钥管理 + 用量查询
- 自定义 API 配置（自动检测模型）
- 本地 9Router 启动
- Claude Code / Codex 一键启动
- 设备指纹采集
