// test/router-auth.test.mjs — GUI 入口（src/main/launcher）的 9router 只监听本机、不用默认密码
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const auth = require('../src/main/launcher/router-auth.js');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

test('GUI 入口默认监听 127.0.0.1，设了 NINEROUTER_HOST 才改', () => {
  assert.equal(auth.routerHost({}), '127.0.0.1');
  assert.equal(auth.routerHost({ NINEROUTER_HOST: '0.0.0.0' }), '0.0.0.0');
  assert.ok(auth.isLoopbackHost('127.0.0.1'));
  assert.ok(!auth.isLoopbackHost('0.0.0.0'));
  const src = read('src/main/launcher/ninerouter.js');
  assert.doesNotMatch(src, /'0\.0\.0\.0'/);
  assert.match(src, /env\.INITIAL_PASSWORD = resolveAdminPassword/);
});

test('GUI 入口不出现默认密码 123456 / admin123', () => {
  for (const f of ['src/main/launcher/ninerouter.js', 'src/main/launcher/router-auth.js']) {
    assert.doesNotMatch(read(f), /123456|admin123/, f);
  }
});

test('随机密码只打到控制台一次，不写进 client.log，之后复用', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fanzai-gui-pw-'));
  try {
    const logged = [];
    const printed = [];
    const p1 = auth.resolveAdminPassword({ dataDir: dir, env: {}, log: (s) => logged.push(s), print: (s) => printed.push(s) });
    assert.ok(p1.length >= 20);
    assert.ok(existsSync(auth.passwordFilePath(dir)));
    assert.ok(printed.some((s) => s.includes(p1)), '控制台要打出密码');
    assert.ok(printed.some((s) => s.includes('NINEROUTER_INITIAL_PASSWORD')), '要写明设置方法');
    assert.ok(!logged.some((s) => s.includes(p1)), '日志里不能有密码');

    const printed2 = [];
    const p2 = auth.resolveAdminPassword({ dataDir: dir, env: {}, log() {}, print: (s) => printed2.push(s) });
    assert.equal(p2, p1);
    assert.equal(printed2.length, 0);

    const p3 = auth.resolveAdminPassword({ dataDir: dir, env: { NINEROUTER_INITIAL_PASSWORD: 'mine' }, log() {}, print() {} });
    assert.equal(p3, 'mine');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('命令行入口 scripts/init.mjs 按启动包根目录找 lib/ 和 runtime/', () => {
  const src = read('scripts/init.mjs');
  assert.doesNotMatch(src, /import\('\.\/lib\//);
  assert.doesNotMatch(src, /join\(__dirname, 'runtime'/);
  assert.match(src, /const ROOT = join\(__dirname, '\.\.'\)/);
});
