/**
 * 入口分发：服务端 vs pi CLI。
 *
 * 有些扩展（team-collab、rsi）派子 agent 时用 `process.argv[1]` 猜"当前这个
 * 脚本就是 pi 入口"，于是从服务端里派活会变成
 * `node src/index.js --mode json -p ...` —— 那会再起一个服务端：
 * 抢同一个端口、共用同一个数据目录、还白白跑一遍模型探活。
 *
 * 所以入口先看参数：像 pi CLI 就把参数原样交给 pi CLI，否则才起服务端。
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** pi CLI 的特征参数（子 agent 派活时一定带） */
const PI_FLAGS = new Set([
  '--mode',
  '-p',
  '--print',
  '--append-system-prompt',
  '--no-session',
  '--tools',
  '--output-format',
]);

/**
 * 判断这组参数是不是 pi CLI 的调用。
 * 只认"模式/打印"这类强特征，避免把服务端自己的参数误判。
 * @param {string[]} argv  process.argv.slice(2)
 * @returns {boolean}
 */
export function isPiInvocation(argv = []) {
  const has = (flag) => argv.includes(flag);
  if (!has('--mode') && !has('-p') && !has('--print')) return false;
  // 至少还要有一个 pi 专属参数，才认定是 CLI 调用
  return argv.filter((a) => PI_FLAGS.has(a)).length >= 1;
}

/**
 * 找 pi CLI 的入口脚本。
 * 顺序：PI_CLI 环境变量 → 本仓库依赖里的 dist/bundle/cli.js → PATH 里的 pi。
 * @returns {{ command: string, args: string[] }}
 */
export function resolvePiCli() {
  const fromEnv = process.env.PI_CLI;
  if (fromEnv && fromEnv.trim()) {
    return { command: process.execPath, args: [fromEnv.trim()] };
  }
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const pkgRoot = path.resolve(here, '..');
    const cli = path.join(
      pkgRoot,
      'node_modules',
      '@earendil-works',
      'pi-coding-agent',
      'dist',
      'bundle',
      'cli.js',
    );
    // 不 stat：打包后可能只有一层 node_modules；交给 spawn 报错更清楚
    return { command: process.execPath, args: [cli] };
  } catch {
    return { command: 'pi', args: [] };
  }
}

/**
 * 把参数交给 pi CLI 执行，返回退出码。
 * stdio 直通（扩展是拿管道读 JSON 事件的）；windowsHide 避免弹控制台窗口。
 */
export function delegateToPiCli(argv, { env = process.env } = {}) {
  const { command, args } = resolvePiCli();
  const res = spawnSync(command, [...args, ...argv], {
    stdio: 'inherit',
    windowsHide: true,
    env,
  });
  if (res.error) {
    console.error(`pi 入口调用失败（${command}）：${res.error.message}`);
    return 127;
  }
  return res.status ?? 1;
}
