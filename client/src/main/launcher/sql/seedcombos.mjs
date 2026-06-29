// 种默认 Opus 组合模型 —— 从 start.ps1/_seedcombos.mjs 提取，逐字一致
// 用法：node seedcombos.mjs <data.sqlite>
// 须用 node 24+（内置 node:sqlite）运行
import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync(process.argv[2]);
const ts = new Date().toISOString();
const combos = [
  { id: 'combo-claude-opus-4-6', name: 'claude-opus-4-6', models: ['kr/claude-opus-4.6'] },
  { id: 'combo-claude-opus-4-7', name: 'claude-opus-4-7', models: ['kr/claude-opus-4.7'] },
  { id: 'combo-claude-opus-4-8', name: 'claude-opus-4-8', models: ['kr/claude-opus-4.8'] },
];
const modelAliases = {
  'claude-opus-4.6': 'kr/claude-opus-4.6',
  'claude-opus-4.7': 'kr/claude-opus-4.7',
  'claude-opus-4.8': 'kr/claude-opus-4.8',
};
const upsertCombo = db.prepare(`
  INSERT INTO combos (id,name,kind,models,createdAt,updatedAt)
  VALUES (?,?,?,?,?,?)
  ON CONFLICT(name) DO UPDATE SET
    models=excluded.models,
    updatedAt=excluded.updatedAt
`);
for (const combo of combos) {
  upsertCombo.run(combo.id, combo.name, null, JSON.stringify(combo.models), ts, ts);
}
const upsertAlias = db.prepare(`
  INSERT OR REPLACE INTO kv (scope,key,value)
  VALUES ('modelAliases', ?, ?)
`);
for (const [alias, target] of Object.entries(modelAliases)) {
  upsertAlias.run(alias, JSON.stringify(target));
}

let settings = {};
const row = db.prepare('SELECT data FROM settings WHERE id = 1').get();
if (row?.data) {
  try { settings = JSON.parse(row.data); } catch {}
}
settings.providerStrategies ||= {};
settings.comboStrategies ||= {};
for (const combo of combos) {
  settings.comboStrategies[combo.name] = { fallbackStrategy: 'round-robin' };
}
db.prepare(`
  INSERT INTO settings (id,data) VALUES (1,?)
  ON CONFLICT(id) DO UPDATE SET data=excluded.data
`).run(JSON.stringify(settings));
db.close();
