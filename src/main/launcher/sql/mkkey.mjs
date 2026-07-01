// 直写 sqlite 建 9router API Key —— 从 start.ps1/_mkkey.mjs 提取，逐字一致
// 用法：node mkkey.mjs <data.sqlite> <apiKey>
// 须用 node 24+（内置 node:sqlite）运行
import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync(process.argv[2]);
const ts = new Date().toISOString();
db.prepare("INSERT OR REPLACE INTO apiKeys (id,key,name,machineId,isActive,createdAt) VALUES (?,?,?,?,?,?)")
  .run('kiro-launcher', process.argv[3], 'launcher', null, 1, ts);
db.close();
