/**
 * 中转服务器入口（放在云服务器上跑）。
 *
 *   RELAY_SECRET=一串随机字符 RELAY_PORT=8788 node src/relay-server.js
 *
 * 生产环境请套一层 TLS 反代（nginx/caddy），把 https/wss 转给这个端口；
 * 手机端地址就是 `https://<你的域名>/<配对码>`。
 */
import { createRelay } from './relay/server.js';
import { log } from './util.js';

const secret = process.env.RELAY_SECRET || '';
if (!secret) {
  log('⚠️  没设 RELAY_SECRET：任何人都能往这台中转挂 agent，只建议本机调试时这样跑');
}

const relay = createRelay({
  secret,
  port: Number(process.env.RELAY_PORT || 8788),
  host: process.env.RELAY_HOST || '0.0.0.0',
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
