const fs = require('fs');
const os = require('os');
const path = require('path');

const PLAYWRIGHT_MCP_PACKAGE = '@playwright/mcp@latest';
const BUILTIN_SERVERS = {
  playwright: {
    label: 'Playwright',
    description: 'browser automation',
  },
  batch: {
    label: 'Batch',
    description: 'local SSE server',
  },
};

function playwrightServer() {
  if (os.platform() === 'win32') {
    return {
      command: 'cmd',
      args: ['/c', 'npx', '-y', PLAYWRIGHT_MCP_PACKAGE],
    };
  }
  return {
    command: 'npx',
    args: ['-y', PLAYWRIGHT_MCP_PACKAGE],
  };
}

function batchServer() {
  return { type: 'sse', url: 'http://localhost:3179/sse' };
}

function builtInServerConfig(id) {
  if (id === 'playwright') return playwrightServer();
  if (id === 'batch') return batchServer();
  return null;
}

function defaultEnabled(launcherRoot) {
  const existing = readClaudeMcpConfig(launcherRoot).mcpServers || {};
  return {
    playwright: true,
    batch: !!existing.batch,
  };
}

function readMcpSettings(settingsPath, launcherRoot) {
  try {
    const data = JSON.parse(fs.readFileSync(settingsPath, 'utf8').replace(/^\uFEFF/, ''));
    return normalizeMcpSettings(data, launcherRoot);
  } catch {
    return normalizeMcpSettings({ enabled: defaultEnabled(launcherRoot) }, launcherRoot);
  }
}

function writeMcpSettings(settingsPath, launcherRoot, input = {}) {
  const settings = normalizeMcpSettings(input, launcherRoot);
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf8');
  return settings;
}

function normalizeMcpSettings(input = {}, launcherRoot) {
  const defaults = defaultEnabled(launcherRoot);
  const enabled = { ...defaults, ...(input.enabled || {}) };
  for (const id of Object.keys(BUILTIN_SERVERS)) enabled[id] = !!enabled[id];
  return { enabled };
}

function readClaudeMcpConfig(launcherRoot) {
  const p = path.join(launcherRoot, '.mcp.json');
  let cfg = {};
  if (fs.existsSync(p)) {
    try { cfg = JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '')); } catch { cfg = {}; }
  }
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) cfg = {};
  cfg.mcpServers = cfg.mcpServers && typeof cfg.mcpServers === 'object' && !Array.isArray(cfg.mcpServers)
    ? cfg.mcpServers
    : {};
  return cfg;
}

function enabledServerIds(settingsPath, launcherRoot) {
  const settings = readMcpSettings(settingsPath, launcherRoot);
  return Object.keys(BUILTIN_SERVERS).filter((id) => settings.enabled[id]);
}

function applyClaudeMcp(launcherRoot, settingsPath, log = () => {}) {
  const p = path.join(launcherRoot, '.mcp.json');
  const cfg = readClaudeMcpConfig(launcherRoot);
  cfg.mcpServers = cfg.mcpServers || {};

  for (const id of Object.keys(BUILTIN_SERVERS)) delete cfg.mcpServers[id];
  for (const id of enabledServerIds(settingsPath, launcherRoot)) {
    cfg.mcpServers[id] = builtInServerConfig(id);
  }

  fs.writeFileSync(p, JSON.stringify(cfg, null, 2), 'utf8');
  log(`Claude Code MCP 已配置（${Object.keys(cfg.mcpServers).length} 个）`);
}

function tomlString(value) {
  return JSON.stringify(String(value));
}

function tomlArray(values) {
  return '[' + values.map(tomlString).join(', ') + ']';
}

function upsertCodexMcp(configPath, settingsPath, launcherRoot, log = () => {}) {
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  let raw = fs.existsSync(configPath) ? fs.readFileSync(configPath, 'utf8').replace(/^\uFEFF/, '') : '';
  raw = raw.replace(/\r\n/g, '\n');
  for (const id of Object.keys(BUILTIN_SERVERS)) {
    raw = raw.replace(new RegExp(`\\n?\\[mcp_servers\\.${id}\\]\\n(?:[^\\n[]*\\n?)*`, 'g'), '\n');
  }
  raw = raw.trimEnd();

  const blocks = [];
  for (const id of enabledServerIds(settingsPath, launcherRoot)) {
    const server = builtInServerConfig(id);
    if (!server || !server.command) continue;
    blocks.push([
      `[mcp_servers.${id}]`,
      `command = ${tomlString(server.command)}`,
      `args = ${tomlArray(server.args)}`,
      '',
    ].join('\n'));
  }

  fs.writeFileSync(configPath, [raw, ...blocks].filter(Boolean).join('\n\n'), 'utf8');
  log(`Codex MCP 已配置（${blocks.length} 个）`);
}

module.exports = {
  BUILTIN_SERVERS,
  applyClaudeMcp,
  readMcpSettings,
  writeMcpSettings,
  upsertCodexMcp,
};
