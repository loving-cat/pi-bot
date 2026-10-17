/**
 * 进程入口：只做一件事 —— 判断这次是「起服务端」还是「pi CLI 被当成了入口」。
 *
 * 服务端真正的启动逻辑在 server-main.js；这里保持入口很小，
 * 免得以后又有人在入口里堆业务。
 */
import { isPiInvocation, runPiCli } from './pi-args.js';

const argv = process.argv.slice(2);

if (isPiInvocation(argv)) {
  process.exit(await runPiCli(argv));
} else {
  await import('./server-main.js');
}
