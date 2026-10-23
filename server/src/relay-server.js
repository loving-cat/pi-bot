/**
 * 中转服务器入口（放在云服务器上跑）。
 *
 *   RELAY_SECRET=一串随机字符 RELAY_PORT=8788 node src/relay-server.js
 *
 * 生产环境请套一层 TLS 反代（nginx/caddy），把 https/wss 转给这个端口；
 * 手机端地址就是 `https://<你的域名>/<配对码>`。
 */
import './child-env.js';
import { createRelay } from './relay/server.js';
import { log } from './util.js';

const secret = process.env.RELAY_SECRET || '';
const host = process.env.RELAY_HOST || '0.0.0.0';

/**
 * 没口令就对外监听 = 任何人都能挂 agent 上来。
 *
 * 以前这里只打一行警告就继续跑 —— 风险配置被静默接受，
 * 而中转通常丢在公网服务器上，没人会盯着启动日志看。
 *
 * 规则：
 *   · 空 secret + 对外监听（非 loopback）→ **直接拒绝启动**，除非显式放行
 *   · 空 secret + 只听本机 → 放行（本地调试就是这个用法，风险可控）
 *   · 要故意跑一个公开中转（比如放在内网里靠防火墙保），
 *     显式设 RELAY_ALLOW_OPEN=1 —— 让它变成一个"想清楚了才做"的决定。
 */
function isLoopback(hostname) {
  const h = String(hostname ?? '').toLowerCase();
  return h === '127.0.0.1' || h === 'localhost' || h === '::1' || h === '[::1]';
}

if (!secret) {
  if (!isLoopback(host) && process.env.RELAY_ALLOW_OPEN !== '1') {
    log(
      '❌ 拒绝启动：没设 RELAY_SECRET，却在 ' + host + ' 上对外监听。\n' +
        '   这样任何人都能往中转挂 agent，接管你的会话。\n' +
        '   · 正经用法：RELAY_SECRET=<一串随机字符> node src/relay-server.js\n' +
        '   · 只想本机调试：RELAY_HOST=127.0.0.1 node src/relay-server.js\n' +
        '   · 确实要在内网裸跑：加 RELAY_ALLOW_OPEN=1（后果自负）',
    );
    process.exit(1);
  }
  log('⚠️  没设 RELAY_SECRET（仅本机调试可接受）：任何能连到这个端口的人都能挂 agent');
}

const relay = createRelay({
  secret,
  port: Number(process.env.RELAY_PORT || 8788),
  host,
});

relay.listen().then((addr) => {
  log(`中转已启动：http://${addr.address}:${addr.port}`);
  log('电脑侧：node src/relay-agent.js --relay wss://<这台>/agent --code <配对码>');
});

const shutdown = () => {
  relay.close().then(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref?.();
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// 兜底：中转是长跑进程，任何一处未捕获异常都不该让 relay 整个退出
// （退出 = 手机上所有连接一起断）。记日志，继续服务。
process.on('uncaughtException', (err) => {
  log('未捕获异常：', err?.stack || err?.message || err);
});
process.on('unhandledRejection', (reason) => {
  log('未处理的 Promise 拒绝：', reason?.stack || reason?.message || reason);
});
