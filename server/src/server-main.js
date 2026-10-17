import { config, describeConfig } from './config.js';
import { store } from './store.js';
import { PiRunner } from './pi-runner.js';
import { Pairing, lanAddresses } from './pairing.js';
import { createHttpServer } from './http.js';
import { createSiteRuntime } from './site-runtime.js';
import { loadOrCreateKey } from './secrets.js';
import { attachWs } from './ws.js';
import { log } from './util.js';
import { shells } from './shells.js';
import { createAutomationScheduler } from './automations.js';

async function banner(pairing, runner) {
  const c = describeConfig();
  const lines = [
    '',
    '  ┌───────────────────────────────────────────────┐',
    '  │               pi-bot   server                 │',
    '  └───────────────────────────────────────────────┘',
    `  工作目录   ${c.workspace}`,
    `  数据目录   ${c.dataDir}`,
    `  模型       ${runner.modelLabel() ?? '(无)'}    思考 ${c.thinking}`,
    `  工具       ${c.tools}`,
    '',
  ];
  if (c.migratedFrom) {
    lines.push(
      `  ★ 数据已从旧位置搬过来：${c.migratedFrom}`,
      '    旧目录原样保留当备份，确认没问题后可以自己删。',
      '',
    );
  }
  console.log(lines.join('\n'));

  if (config.staticToken) {
    console.log('  ★ 已配置固定 token（PI_BOT_TOKEN），手机端直接填这个 token 即可\n');
    return;
  }

  const snap = pairing.snapshot();
  console.log('  ┌─ 手机连接 ────────────────────────────────────┐');
  console.log('  │  在 pi-bot App 的配对页填下面这两项             │');
  console.log('  └───────────────────────────────────────────────┘');
  console.log(`  有效地址   ${snap.url}`);
  for (const { name, address } of lanAddresses()) {
    console.log(`             http://${address}:${config.port}      (${name})`);
  }
  console.log(`  配对码     ${snap.code}   （${Math.round(config.pairTtlMs / 60000)} 分钟轮换）`);
  console.log(`  网页版     ${snap.url}/pair     ← 手机上不想手输地址就开这个`);
  console.log('');
}

async function main() {
  // 进程级异常兜底：记录日志并保持服务运行。
  process.on('uncaughtException', (err) => {
    log('‼️  未捕获异常（进程继续跑）：', err?.stack || err?.message || err);
  });
  process.on('unhandledRejection', (reason) => {
    log('‼️  未处理的 Promise 拒绝（进程继续跑）：', reason?.stack || reason?.message || reason);
  });
  // 退出时写入一行日志，桌面端据此快速判定启动失败。
  process.on('exit', (code) => {
    log(`服务端进程退出 code=${code}`);
  });

  const reaped = store.reapStaleStreaming();
  if (reaped) log(`清理了 ${reaped} 条上次遗留的 streaming 消息`);

  const runner = await new PiRunner().init();
  // 探活结果 24 小时过期 —— 服务连跑几天也不会让「全员不可用」这种假结论冻在那儿
  runner.health?.startAutoRefresh();
  const pairing = new Pairing();
  pairing.onRotate = async (code) => {
    log(`🔑 配对码已轮换：${code}`);
    if (!config.staticToken) {
      console.log(`  配对码 ${code}   网页版 ${pairing.snapshot().url}/pair`);
    }
  };

  // 站点口令的加密密钥：只在本机数据目录，权限 0600，不进仓库。
  // 没有它就只能存明文 —— 所以这一步失败要显式告警，不能静默降级。
  try {
    store.useSecretsKey(loadOrCreateKey(config.dataDir));
  } catch (err) {
    log(`⚠️ 无法初始化口令加密（${err?.message ?? err}）—— 站点口令将无法安全保存`);
  }

  // 外部 Web 系统的传输层：管 token、转发查询。给工具和 HTTP 接口共用一份。
  const sites = createSiteRuntime({ log });
  runner.sites = sites;

  const server = createHttpServer({ runner, pairing, sites });
  attachWs(server, { runner });

  // 定时任务：每 30s 看一次有没有到点的
  const scheduler = createAutomationScheduler({
    store,
    log,
    run: (automation) => runner.runAutomation(automation),
  });
  scheduler.start();

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
    scheduler.stop();
    runner.health?.stop();
    shells.stopAll();
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
