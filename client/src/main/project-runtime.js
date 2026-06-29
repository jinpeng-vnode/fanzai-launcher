const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { dialog } = require('electron');

function normalizeProjectPath(projectPath) {
  return path.resolve(String(projectPath || '')).replace(/[\\/]+$/, '').toLowerCase();
}

function projectIdForPath(projectPath) {
  return crypto.createHash('sha256').update(normalizeProjectPath(projectPath)).digest('hex').slice(0, 16);
}

function projectNameForPath(projectPath) {
  return path.basename(path.resolve(projectPath)) || 'project';
}

function projectRuntime(runtimeDir, projectPath) {
  const resolvedPath = path.resolve(projectPath);
  const id = projectIdForPath(resolvedPath);
  const root = path.join(runtimeDir, 'projects', id);
  const project = {
    id,
    name: projectNameForPath(resolvedPath),
    path: resolvedPath,
    root,
    codexHome: path.join(root, 'codex-home'),
    claudeConfigDir: path.join(root, 'claude-config'),
    vscodeDataDir: path.join(root, 'vscode-data'),
  };
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, 'meta.json'), JSON.stringify({
    id: project.id,
    name: project.name,
    path: project.path,
    lastOpenedAt: new Date().toISOString(),
  }, null, 2), 'utf8');
  return project;
}

async function selectProjectRuntime(runtimeDir, getWindow, log = () => {}) {
  const options = {
    title: '选择要打开的项目文件夹',
    properties: ['openDirectory'],
  };
  const owner = getWindow ? getWindow() : null;
  const result = owner
    ? await dialog.showOpenDialog(owner, options)
    : await dialog.showOpenDialog(options);
  if (result.canceled || !result.filePaths || !result.filePaths[0]) {
    const err = new Error('已取消选择项目文件夹');
    err.code = 'PROJECT_SELECT_CANCELED';
    throw err;
  }
  const project = projectRuntime(runtimeDir, result.filePaths[0]);
  log(`项目已选择：${project.path}`);
  log(`项目隔离 ID：${project.id}`);
  return project;
}

module.exports = { selectProjectRuntime, projectRuntime, projectIdForPath };
