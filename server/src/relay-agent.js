/**
 * 电脑侧的中转客户端入口。
 *
 *   node src/relay-agent.js --relay wss://<中转域名>/agent --code 0123456789ab
 *
 * 不指定 --code 就随机生成一个（会打印出来）；也可以设 RELAY_SECRET 与中转对齐。
 * 手机 App 的服务器地址填 `https://<中转域名>/<配对码>`，token 用电脑上配的那个。
 */
import './child-env.js';
import crypto from 'node:crypto';
import { startRelayAgent } from './relay/agent.js';
import { log } from './util.js';

function arg(name, fallback = '') {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const relay = arg('relay', process.env.RELAY_URL || '');
if (!relay) {
  console.error('用法：node src/relay-agent.js --relay wss://<中转>/agent [--code 0123456789ab] [--local http://127.0.0.1:8787]');
  process.exit(1);
}
const code = arg('code', process.env.RELAY_CODE || crypto.randomBytes(6).toString('hex'));
const secret = arg('secret', process.env.RELAY_SECRET || '');
const local = arg('local', process.env.RELAY_LOCAL || 'http://127.0.0.1:8787');

const agent = startRelayAgent({ relay, code, secret, local });
log(`本机配对码：${code}`);
log(`手机地址形如：${relay.replace(/^ws/, 'http').replace(/\/agent$/, '')}/${code}`);

const shutdown = () => {
  agent.close();
  setTimeout(() => process.exit(0), 200);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// 兜底：中转是长跑进程，任何一处未捕获异常都不该让 agent 整个退出
// （退出 = 手机上所有连接一起断）。记日志，继续服务。
process.on('uncaughtException', (err) => {
  log('未捕获异常：', err?.stack || err?.message || err);
});
process.on('unhandledRejection', (reason) => {
  log('未处理的 Promise 拒绝：', reason?.stack || reason?.message || reason);
});
