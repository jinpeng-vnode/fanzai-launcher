#!/usr/bin/env node
// make-dist.mjs — 构建 GUI 客户端并打包成可分发 zip（跨平台，自动识别当前系统）
//
// 用法：
//   node scripts/make-dist.mjs            # 构建 + 打包当前平台
//   node scripts/make-dist.mjs --no-build # 跳过构建，直接用已有产物打包
//
// 产出：
//   Windows → dist-packages/饭仔客户端-win-x64.zip   （内含 portable exe + 启动.bat）
//   macOS   → dist-packages/饭仔客户端-mac-<arch>.zip （内含 .app + 启动.command）
//
// 设计：
//   - 在哪个系统就打哪个系统的包（electron-builder 不便跨平台构建）
//   - 分发包保持启动脚本所需的相对结构：runtime/electron-app/ 下放 GUI
//   - 绝不打入 creds/（真实凭证），用户拿到后自行扫描导入
//   - 运行时所需的便携 Node / 9router 由 GUI 首次启动自动下载安装

import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  cpSync, rmSync, mkdirSync, existsSync, readdirSync, statSync,
} from 'node:fs';
import { join, dirname, basename } from 'node:path';
import os from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');                 // 启动包根（scripts/ 的上一级）
const OUT_DIR = join(ROOT, 'dist-packages');       // zip 输出目录

const PLATFORM = os.platform();                    // win32 / darwin
const ARCH = os.arch();                            // x64 / arm64
const noBuild = process.argv.includes('--no-build');

const NPMMIRROR = 'https://registry.npmmirror.com/-/binary';

function log(msg) { console.log(`[make-dist] ${msg}`); }
function fail(msg) { console.error(`[make-dist] ✗ ${msg}`); process.exit(1); }

// 在根目录下跑 npm 脚本，带上 electron 镜像环境（避免二进制下载卡住）
function run(cmd, args, cwd = ROOT) {
  log(`$ ${cmd} ${args.join(' ')}`);
  execFileSync(cmd, args, {
    cwd,
    stdio: 'inherit',
    shell: PLATFORM === 'win32',   // Windows 下 npm 是 .cmd，需走 shell
    env: {
      ...process.env,
      ELECTRON_MIRROR: `${NPMMIRROR}/electron/`,
      ELECTRON_BUILDER_BINARIES_MIRROR: `${NPMMIRROR}/electron-builder-binaries/`,
    },
  });
}

// 把分发所需文件收集到 staging 目录
function collect(stageDir, items) {
  rmSync(stageDir, { recursive: true, force: true });
  mkdirSync(stageDir, { recursive: true });
  for (const { from, to } of items) {
    const src = join(ROOT, from);
    if (!existsSync(src)) fail(`缺少文件：${from}`);
    const dst = join(stageDir, to);
    mkdirSync(dirname(dst), { recursive: true });
    cpSync(src, dst, { recursive: true });
    log(`  + ${to}`);
  }
}

// 压缩 staging 目录为 zip（用各平台原生工具）
function zip(stageDir, zipPath) {
  rmSync(zipPath, { force: true });
  if (PLATFORM === 'win32') {
    // PowerShell Compress-Archive
    execFileSync('powershell', [
      '-NoProfile', '-Command',
      `Compress-Archive -Path '${stageDir}\\*' -DestinationPath '${zipPath}' -Force`,
    ], { stdio: 'inherit' });
  } else {
    // mac/linux: zip -r（在 staging 父目录下打，保证包内根是 staging 名）
    execFileSync('zip', ['-r', '-q', zipPath, basename(stageDir)], {
      cwd: dirname(stageDir), stdio: 'inherit',
    });
  }
}

function humanSize(p) {
  const bytes = statSync(p).size;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

// ── 主流程 ──
mkdirSync(OUT_DIR, { recursive: true });

// 三平台共用的分发文件（保持启动脚本所需的相对路径）
const commonItems = [
  { from: 'scripts/import_kiro.mjs', to: 'scripts/import_kiro.mjs' },
  { from: 'scripts/scan_kiro_credential.mjs', to: 'scripts/scan_kiro_credential.mjs' },
  { from: 'scripts/init.mjs', to: 'scripts/init.mjs' },
  { from: 'lib', to: 'lib' },
  { from: '.mcp.json', to: '.mcp.json' },
  { from: 'README.md', to: 'README.md' },
];

if (PLATFORM === 'win32') {
  if (!noBuild) run('npx', ['electron-builder', '--win', 'portable']);
  const exe = join(ROOT, 'runtime', 'electron-app', '饭仔客户端.exe');
  if (!existsSync(exe)) fail('未找到 runtime/electron-app/饭仔客户端.exe，请先构建');

  const stage = join(OUT_DIR, '饭仔客户端-win-x64');
  collect(stage, [
    ...commonItems,
    { from: '启动.bat', to: '启动.bat' },
    { from: 'runtime/electron-app/饭仔客户端.exe', to: 'runtime/electron-app/饭仔客户端.exe' },
  ]);
  const zipPath = join(OUT_DIR, '饭仔客户端-win-x64.zip');
  zip(stage, zipPath);
  rmSync(stage, { recursive: true, force: true });
  log(`✓ Windows 分发包：${zipPath}（${humanSize(zipPath)}）`);

} else if (PLATFORM === 'darwin') {
  if (!noBuild) run('npx', ['electron-builder', '--mac', 'zip']);
  const appDirParent = join(ROOT, 'runtime', 'electron-app', `mac-${ARCH}`);
  if (!existsSync(appDirParent)) fail(`未找到 ${appDirParent}，请先构建`);
  const app = readdirSync(appDirParent).find((f) => f.endsWith('.app'));
  if (!app) fail('未找到 .app 产物');

  const stage = join(OUT_DIR, `饭仔客户端-mac-${ARCH}`);
  collect(stage, [
    ...commonItems,
    { from: '启动.command', to: '启动.command' },
    { from: `runtime/electron-app/mac-${ARCH}/${app}`, to: `runtime/electron-app/mac-${ARCH}/${app}` },
  ]);
  // 保住 .command 和 .app 内可执行文件的执行位（zip -r 会保留 unix 权限）
  const zipPath = join(OUT_DIR, `饭仔客户端-mac-${ARCH}.zip`);
  zip(stage, zipPath);
  rmSync(stage, { recursive: true, force: true });
  log(`✓ macOS 分发包：${zipPath}（${humanSize(zipPath)}）`);

} else {
  fail(`不支持的平台：${PLATFORM}`);
}

log('完成。分发包不含 creds/，用户首次运行需自行扫描导入 Kiro 凭证。');
