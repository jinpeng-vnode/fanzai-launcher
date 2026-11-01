// 9router 监听地址与管理密码 — GUI 入口用（命令行入口的同一口径在 lib/setup.mjs）
//
// 监听：默认只监听 127.0.0.1；确实要给局域网用，启动前设环境变量 NINEROUTER_HOST=0.0.0.0。
// 密码：环境变量 NINEROUTER_INITIAL_PASSWORD > 已生成的密码文件 > 首次随机生成。
//       随机密码只打到控制台（console.log）一次，不进 client.log、不推到界面、不进 git；
//       文件存在 9router 数据目录里（runtime/ 已被 gitignore）。
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const LOOPBACK_HOST = '127.0.0.1';
const PASSWORD_FILE = '.admin-password';

function routerHost(env = process.env) {
  return env.NINEROUTER_HOST || LOOPBACK_HOST;
}

function isLoopbackHost(host) {
  return host === LOOPBACK_HOST || host === 'localhost' || host === '::1';
}

function passwordFilePath(dataDir) {
  return path.join(dataDir, PASSWORD_FILE);
}

// log：写进 client.log 的日志（只写文件位置，不写密码）；print：控制台输出（密码只在这里出现）
function resolveAdminPassword({ dataDir, env = process.env, log = () => {}, print = console.log }) {
  if (env.NINEROUTER_INITIAL_PASSWORD) return env.NINEROUTER_INITIAL_PASSWORD;

  const file = passwordFilePath(dataDir);
  if (fs.existsSync(file)) {
    const saved = fs.readFileSync(file, 'utf8').trim();
    if (saved) return saved;
  }

  const password = crypto.randomBytes(18).toString('base64url');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(file, password + '\n', { encoding: 'utf8', mode: 0o600 });
  print('[!] 未设置 9router 管理密码，已随机生成（只提示这一次，请记下）：');
  print(`    ${password}`);
  print(`    已保存在 ${file}；要改用自己的密码，启动前设置环境变量 NINEROUTER_INITIAL_PASSWORD。`);
  log(`已随机生成 9router 管理密码，保存在 ${file}`);
  return password;
}

module.exports = { LOOPBACK_HOST, routerHost, isLoopbackHost, resolveAdminPassword, passwordFilePath };
