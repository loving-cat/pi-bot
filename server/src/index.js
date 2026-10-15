import { config, describeConfig } from './config.js';
import { store } from './store.js';
import { PiRunner } from './pi-runner.js';
import { Pairing, lanAddresses } from './pairing.js';
import { createHttpServer } from './http.js';
import { attachWs } from './ws.js';
import { log } from './util.js';

async function banner(pairing, runner) {
  const c = describeConfig();
  const lines = [
    '',
    '  ┌───────────────────────────────────────────────┐',
    '  │               pi-bot   server                 │',
    '  └───────────────────────────────────────────────┘',
    `  工作目录   ${c.workspace}`,
    `  模型       ${runner.modelLabel() ?? '(无)'}    思考 ${c.thinking}`,
    `  工具       ${c.tools}`,
    '',
  ];
  console.log(lines.join('\n'));

  if (config.staticToken) {
    console.log('  ★ 已配置固定 token（PI_BOT_TOKEN），手机端直接填这个 token 即可\n');
    return;
  }

  const snap = pairing.snapshot();
  const qr = await pairing.ascii();
  console.log('  ┌─ 手机配对 ────────────────────────────────────┐');
  console.log('  │  用 pi-bot App 里的「扫码配对」扫下面这个码     │');
  console.log('  └───────────────────────────────────────────────┘');
  console.log(qr);
  console.log(`  配对码     ${snap.code}   （${Math.round(config.pairTtlMs / 60000)} 分钟轮换）`);
  console.log(`  有效地址   ${snap.url}`);
  for (const { name, address } of lanAddresses()) {
    console.log(`             http://${address}:${config.port}      (${name})`);
  }
  console.log(`  网页版     ${snap.url}/pair     ← 打不开二维码就点这个`);
  console.log('');
}

async function main() {
  const reaped = store.reapStaleStreaming();
  if (reaped) log(`清理了 ${reaped} 条上次遗留的 streaming 消息`);

  const runner = await new PiRunner().init();
  const pairing = new Pairing();
  pairing.onRotate = async (code) => {
    log(`🔑 配对码已轮换：${code}`);
    if (!config.staticToken) {
      try {
        console.log(await pairing.ascii());
        console.log(`  配对码 ${code}   网页版 ${pairing.snapshot().url}/pair`);
      } catch {
        /* ignore */
      }
    }
  };

  const server = createHttpServer({ runner, pairing });
  attachWs(server, { runner });

  server.listen(config.port, config.host, async () => {
    await banner(pairing, runner);
    log(`listening on http://${config.host}:${config.port}  (ws://…/ws)`);
  });

  let closing = false;
  const shutdown = (signal) => {
    if (closing) return;
    closing = true;
    log(`${signal} → 收工`);
    pairing.stop();
    runner.disposeAll();
    store.saveNow();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref?.();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error('pi-bot server 启动失败：', err);
  process.exit(1);
});
