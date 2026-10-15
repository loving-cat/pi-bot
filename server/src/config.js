/**
 * pi-bot server 配置。
 *
 * 全部可用环境变量覆盖；默认落在 <repo>/data 下，方便直接看数据。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const pkgRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

const home = process.env.PI_BOT_HOME
  ? path.resolve(process.env.PI_BOT_HOME)
  : path.join(pkgRoot, 'data');

const dataDir = home;
const workspace = process.env.PI_BOT_WORKSPACE
  ? path.resolve(process.env.PI_BOT_WORKSPACE)
  : path.join(home, 'workspace');

for (const dir of [home, dataDir, workspace, path.join(dataDir, 'rooms'), path.join(dataDir, 'sessions')]) {
  fs.mkdirSync(dir, { recursive: true });
}

const tools = (process.env.PI_BOT_TOOLS || 'read,write,edit,ls,find,grep,bash')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

export const config = {
  pkgRoot,
  home,
  dataDir,
  workspace,
  host: process.env.PI_BOT_HOST || '0.0.0.0',
  port: Number(process.env.PI_BOT_PORT || 8787),
  serverName: process.env.PI_BOT_NAME || 'pi-bot',
  /** 固定 token：设了就跳过配对码（自用/服务器部署方便） */
  staticToken: process.env.PI_BOT_TOKEN || null,
  /** 形如 cline-pass/deepseek-v4.1-flash；不设则用 pi 默认模型 */
  model: process.env.PI_BOT_MODEL || null,
  thinking: process.env.PI_BOT_THINKING || 'medium',
  tools,
  /** 每个房间内存里保留的消息条数（落盘也按此裁剪） */
  maxMessagesPerRoom: Number(process.env.PI_BOT_MAX_MESSAGES || 500),
  pairTtlMs: Number(process.env.PI_BOT_PAIR_TTL_MS || 10 * 60 * 1000),
  /** 不加载 ~/.pi/agent 下的扩展（默认加载：这样 pi-bot 能拿到 team/dispatch_task 等） */
  noExtensions: process.env.PI_BOT_NO_EXTENSIONS === '1',
  /** bot 跑完一轮后，自动把工作目录里新生成的图片附到消息上 */
  autoAttachImages: process.env.PI_BOT_AUTO_ATTACH !== '0',
  /** 部门里单次最多动手几步（超过就收住，防止一个成员把部门拖住） */
  groupTurnMaxSteps: Number(process.env.PI_BOT_GROUP_MAX_STEPS || 12),
  /** 部门老大每次发言最多能跑几轮 */
  groupTurnsLead: Number(process.env.PI_BOT_GROUP_TURNS_LEAD || 4),
  /** 普通成员每次发言最多能跑几轮 */
  groupTurnsMember: Number(process.env.PI_BOT_GROUP_TURNS_MEMBER || 2),
  /** 一条用户消息最多触发几次 bot 运行（防部门内部无限互吹） */
  groupMaxRuns: Number(process.env.PI_BOT_GROUP_MAX_RUNS || 10),
  /** 主控只有只读文件工具 —— 它是调度者，不是干活的人 */
  chiefTools: (process.env.PI_BOT_CHIEF_TOOLS || 'read,ls,grep,find').split(',').map((s) => s.trim()).filter(Boolean),
  /** 单轮 agent 运行的硬超时（毫秒），0 = 不限 */
  runTimeoutMs: Number(process.env.PI_BOT_RUN_TIMEOUT_MS || 10 * 60 * 1000),
  hostname: os.hostname(),
};

export function describeConfig() {
  return {
    serverName: config.serverName,
    port: config.port,
    home: config.home,
    workspace: config.workspace,
    model: config.model ?? '(pi 默认)',
    thinking: config.thinking,
    tools: config.tools.join(','),
    auth: config.staticToken ? 'static-token' : 'pairing-code',
  };
}
