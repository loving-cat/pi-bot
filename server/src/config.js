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
  /**
   * 部门里单次最多**来回几轮**（对话轮次，不是工具调用次数）。
   *
   * 用户原话："这个步数 不是算工具调用多少次，是每次干完要多次对话，
   * 步数是对话次数 —— 你这 30 步很多模型活都干不完，对话次数算才行。"
   *
   * 一次 assistant 发言 = 一轮（里面可以带好几个工具调用）。
   * 按工具调用算的话，模型连查带改跑十几个 bash 就把额度烧光了，活才刚开头。
   */
  groupTurnMaxSteps: Number(process.env.PI_BOT_GROUP_MAX_STEPS || 30),
  /** 部门里单轮最长跑多久（毫秒），到点收住交给下一个人 */
  groupTurnMaxMs: Number(process.env.PI_BOT_GROUP_TURN_MAX_MS || 300_000),
  /** 部门老大每次发言最多能跑几轮 */
  groupTurnsLead: Number(process.env.PI_BOT_GROUP_TURNS_LEAD || 4),
  /** 普通成员每次发言最多能跑几轮 */
  groupTurnsMember: Number(process.env.PI_BOT_GROUP_TURNS_MEMBER || 2),
  /** 同时驻留的 agent 会话上限（每个 房间×bot 一个，各自占内存），超出按 LRU 释放 */
  maxSessions: Number(process.env.PI_BOT_MAX_SESSIONS || 40),
  /** 一条用户消息最多触发几次 bot 运行（防部门内部无限互吹） */
  groupMaxRuns: Number(process.env.PI_BOT_GROUP_MAX_RUNS || 10),
  /** 主控只有只读文件工具 —— 它是调度者，不是干活的人 */
  chiefTools: (process.env.PI_BOT_CHIEF_TOOLS || 'read,ls,grep,find').split(',').map((s) => s.trim()).filter(Boolean),
  /**
   * 联网搜索用什么接口。
   * 不配也能用 —— 默认走搜索引擎的 HTML 端点（不需要 key）。
   * 想更稳/更干净就填一个正式接口，URL 里用 {q} 占位：
   *   PI_BOT_SEARCH_URL=https://api.search.brave.com/res/v1/web/search?q={q}&count=8
   * 配了 key 就带上 Authorization: Bearer。
   */
  searchUrl: process.env.PI_BOT_SEARCH_URL || null,
  searchKey: process.env.PI_BOT_SEARCH_KEY || null,
  /**
   * 上下文压缩的全局默认（null = 用 pi 自带的默认：reserve 16384 / keepRecent 20000）。
   * 每个 bot 还能各自覆盖（App 的设置里改），所以这里只是"没单独设过时用多少"。
   * 触发条件：contextTokens > contextWindow - reserveTokens。
   */
  reserveTokens: Number(process.env.PI_BOT_RESERVE_TOKENS || 0) || null,
  keepRecentTokens: Number(process.env.PI_BOT_KEEP_RECENT_TOKENS || 0) || null,
  /** 关掉自动压缩（PI_BOT_AUTO_COMPACT=0）。关掉之后长会话会直接撞上下文上限 */
  autoCompact: process.env.PI_BOT_AUTO_COMPACT !== '0',
  /** 单轮 agent 运行的硬超时（毫秒），0 = 不限 */
  runTimeoutMs: Number(process.env.PI_BOT_RUN_TIMEOUT_MS || 10 * 60 * 1000),
  hostname: os.hostname(),
  /**
   * 用户自己叫什么。
   *
   * 为什么要这个东西：bot 需要知道**在跟谁说话** —— 不然它只能从人设里猜，
   * 或者干脆不称呼你。而且在群里，它得知道"哪条消息是人发的"。
   * 同类客户端里这件事做得很自然：bot 就是在跟你汇报工作，知道你是谁。
   *
   * 默认取系统用户名，用户可以在设置里改（改的是 store 那份，不是这里）。
   */
  userName: process.env.PI_BOT_USER_NAME || os.userInfo().username || '我',
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
