import { config, describeConfig } from './config.js';
import { store } from './store.js';
import { backfillProgressSenders } from './progress-migration.js';
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
      '    搬的是会话、消息、附件和配置；bot 的工作目录（workspace）没搬，还在旧位置。',
      '    旧目录原样保留。里面有要留的文件，先拷出来再删。',
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

  // 进程被 kill 时正在跑的任务会永远停在“进行中” —— 启动时收回待办
  const stuck = store.reconcileTasks();
  if (stuck) log(`收回了 ${stuck} 条上次遗留的“进行中”任务（已放回待办）`);

  // 根据明确的消息或调度关联补全缺失来源，证据不足的回执保持未知。
  try {
    const backfilled = backfillProgressSenders(store);
    if (backfilled) log(`回填了 ${backfilled} 条私聊进度回执的派活人`);
  } catch (err) {
    log('回填进度回执派活人失败（不影响启动）：', err?.message || err);
  }

  const runner = await new PiRunner().init();
  // 探活结果 24 小时过期 —— 服务连跑几天也不会让「全员不可用」这种假结论冻在那儿
  if (config.autoProbe) runner.health?.startAutoRefresh();
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

  // ★ 端口被占必须当场说清楚并退出。
  //
  //   以前这里没挂 error handler：EADDRINUSE 会冒到外面的 uncaughtException，
  //   而那个兜底是"记日志继续跑" —— 于是进程活着、端口没监听、pid 照写，
  //   桌面端只会看到一直转圈（没有 banner、没有报错、也没法重试）。
  //   这种"活着但没干活"的僵尸进程比直接崩掉难查得多。
  //
  //   ★ 必须用 prependListener 而不是 on：
  //     `new WebSocketServer({ server })` 会给 http server 挂一个自己的
  //     error 监听器（native 实现，只做内部清理、不处理启动失败）。
  //     用 on() 注册在后面时，那个 handler 先跑 —— 错误被"消费"掉了，
  //     我们的分支永远不执行，进程照样活着不监听。实测就是这个现象。
  server.prependListener('error', (err) => {
    const code = err?.code ?? '';
    if (code === 'EADDRINUSE') {
      log(
        `❌ 端口 ${config.port} 已被占用 —— 可能上一次的 pi-bot 还在跑。\n` +
          `   查一下：lsof -nP -iTCP:${config.port} -sTCP:LISTEN\n` +
          `   或在设置里换一个端口。`,
      );
    } else if (code === 'EACCES') {
      log(`❌ 没有权限监听端口 ${config.port}（1024 以下需要管理员）`);
    } else {
      log(`❌ 服务端启动失败：${err?.message ?? err}`);
    }
    // 退非 0：让拉起它的桌面端知道"没起来"，而不是挂着等健康检查超时
    process.exit(1);
  });

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
