// test/setup-security.test.mjs — 9Router 默认只监听本机、不再有固定默认密码
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { DEFAULT_HOST, resolveAdminPassword } from '../lib/setup.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

test('默认监听地址是 127.0.0.1', () => {
  assert.equal(DEFAULT_HOST, '127.0.0.1');
  assert.match(read('lib/router.mjs'), /host = '127\.0\.0\.1'/);
  assert.doesNotMatch(read('scripts/init.mjs'), /host: '0\.0\.0\.0'/);
});

test('命令行流程里不再出现默认密码 admin123', () => {
  for (const f of ['lib/setup.mjs', 'lib/router.mjs', 'scripts/init.mjs']) {
    assert.doesNotMatch(read(f), /admin123/, f);
  }
});

test('没设密码时随机生成强密码，只提示一次，之后复用', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fanzai-pw-'));
  try {
    const logs = [];
    const log = (s) => logs.push(s);
    const p1 = resolveAdminPassword({ dataDir: dir, env: {}, log });
    assert.ok(p1.length >= 20, '密码长度不足');
    assert.notEqual(p1, 'admin123');
    assert.ok(existsSync(join(dir, '.admin-password')));
    assert.ok(logs.some((s) => s.includes(p1)), '首次要打出密码');
    assert.ok(logs.some((s) => s.includes('NINEROUTER_INITIAL_PASSWORD')), '要写明设置方法');

    const logs2 = [];
    const p2 = resolveAdminPassword({ dataDir: dir, env: {}, log: (s) => logs2.push(s) });
    assert.equal(p2, p1);
    assert.equal(logs2.length, 0, '第二次不再提示');

    const other = mkdtempSync(join(tmpdir(), 'fanzai-pw-'));
    try {
      assert.notEqual(resolveAdminPassword({ dataDir: other, env: {}, log() {} }), p1);
    } finally { rmSync(other, { recursive: true, force: true }); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('设了环境变量就用环境变量，不生成文件', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fanzai-pw-'));
  try {
    const p = resolveAdminPassword({ dataDir: dir, env: { NINEROUTER_INITIAL_PASSWORD: 'mine-xyz' }, log() {} });
    assert.equal(p, 'mine-xyz');
    assert.ok(!existsSync(join(dir, '.admin-password')));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
