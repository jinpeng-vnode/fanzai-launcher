# Changelog / 更新日志

## [0.3.0] - 2026-07-02

### 新增 / Added
- **一键导入凭证到 9Router**：凭证 tab 新增「导入到 9router」按钮，调 REST API 热生效、可重复导入
  - external_idp（微软）→ `import-cli-proxy`（原样存）
  - idc（AWS SSO）→ `/api/oauth/kiro/import`（服务端刷新）
  - 自动创建代理池 + 关联到连接
  - 添加凭证时数组自动拆分为多个独立文件
- **超额开关做实**：先查真实 ENABLED/DISABLED 再取反（修复只能开不能关）
- **账号启用/禁用**：新增切换入口，写回 json 文件
- **检查更新按钮**：顶部标题栏 ↻ 按钮，按需触发联网升级

### 修复 / Fixed
- 模型刷新残留 bug（服务器返回替换而非合并）
- Windows 路径 querySelector bug（改用稳定 DOM id）
- macOS 进程识别失败（`/proc` 不存在 + Next.js 改写进程标题，回退到 `ps`）
- paths.js 哨兵误命中 .app 内部 package.json（改为检测 `scripts/` 目录）
- 9Router 服务端刷 token 走代理（加 `NODE_USE_ENV_PROXY=1`）

### 变更 / Changed
- **项目结构重构**：消除 `client/` 子层，根目录即 Electron 项目
  - `npm run dev` / `npm run pack:*` 直接在根目录执行
  - 独立脚本归入 `scripts/`（import_kiro.mjs、scan_kiro_credential.mjs、init.mjs）
- 启动时不再直写 sqlite 导入凭证（改为按需 API 调用）
- 启动提速：npm 包 / VS Code 扩展本地已有则复用，不联网检查
- 窗口默认尺寸调大（1280×780）
- 打包命令统一为 `pack:win:green` / `pack:mac:green` / `pack:win:setup` / `pack:mac:dmg`
- Mac 远程构建改用 `/tmp` 临时目录，产出完整绿色 zip

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
