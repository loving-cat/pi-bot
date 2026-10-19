/**
 * pi-bot server 配置。
 *
 * 全部可用环境变量覆盖；默认使用平台对应的用户数据目录。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const pkgRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

/**
 * 用户数据目录：与安装位置无关，重装/换目录不影响数据。
 *
 * Windows 为 %LOCALAPPDATA%\pi-bot\data，macOS 为
 * ~/Library/Application Support/pi-bot/data，Linux 为
 * $XDG_DATA_HOME/pi-bot/data。
 */
function userDataDir() {
  if (process.platform === 'win32' && process.env.LOCALAPPDATA) {
    return path.join(process.env.LOCALAPPDATA, 'pi-bot', 'data');
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'pi-bot', 'data');
  }
  const base = process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share');
  return path.join(base, 'pi-bot', 'data');
}

/**
 * 一次性迁移：把 `<repo>/data` 的数据复制到用户数据目录。
 *
 * 仅当新目录没有 state.json 且旧目录有时执行；旧目录保持原样。
 * 以下划线开头的目录（测试产物）不迁移。
 */
function migrateLegacyData(legacy, target) {
  try {
    if (fs.existsSync(path.join(target, 'state.json'))) return;
    if (!fs.existsSync(path.join(legacy, 'state.json'))) return;
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.cpSync(legacy, target, {
      recursive: true,
      filter: (src) => !path.basename(src).startsWith('_'),
    });
    migratedFrom = legacy;
    console.warn(`[config] 已把旧数据目录搬过来：${legacy} → ${target}（旧的留着当备份）`);
  } catch (err) {
    console.warn('[config] 搬旧数据失败（继续用新目录）：', err?.message || err);
  }
}

/** 本次启动是否执行了数据迁移（未迁移为 null） */
let migratedFrom = null;

const home = process.env.PI_BOT_HOME
  ? path.resolve(process.env.PI_BOT_HOME)
  : userDataDir();

if (!process.env.PI_BOT_HOME) migrateLegacyData(path.join(pkgRoot, 'data'), home);

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
  /** 本次启动是否从旧目录搬过来的（不是则为 null） */
  migratedFrom,
  host: process.env.PI_BOT_HOST || '0.0.0.0',
  port: Number(process.env.PI_BOT_PORT || 8787),
  serverName: process.env.PI_BOT_NAME || 'pi-bot',
  /** 固定 token：设了就跳过配对码（自用/服务器部署方便） */
  staticToken: process.env.PI_BOT_TOKEN || null,
  /** 形如 provider/model-id；不设则用 pi 的默认模型 */
  model: process.env.PI_BOT_MODEL || null,
  thinking: process.env.PI_BOT_THINKING || 'medium',
  tools,
  /** 每个房间内存里保留的消息条数（落盘也按此裁剪） */
  maxMessagesPerRoom: Number(process.env.PI_BOT_MAX_MESSAGES || 500),
  pairTtlMs: Number(process.env.PI_BOT_PAIR_TTL_MS || 10 * 60 * 1000),
  /**
   * 收尾复盘：一轮群聊结束后提炼候选经验（只进库，等用户启用才注入）。
   * 默认开；PI_BOT_LESSON_REFLECT=0 关掉（关掉后零额外调用）。
   */
  lessonReflect: process.env.PI_BOT_LESSON_REFLECT !== '0',
  /** bot 跑完一轮后，自动把工作目录里新生成的图片附到消息上 */
  autoAttachImages: process.env.PI_BOT_AUTO_ATTACH !== '0',
  /**
   * 群内派活遇到成员正忙时的最长等待时间（毫秒）。
   * 超时后放弃等待，避免整轮被单个成员阻塞。
   */
  groupBusyWaitMs: Number(process.env.PI_BOT_GROUP_BUSY_WAIT_MS || 120_000),
  /** 单轮最长多久没动静就算"断了"（毫秒） */
  heartbeatMs: Number(process.env.PI_BOT_HEARTBEAT_MS || 15_000),
  /**
   * 多久没心跳就判为中断（毫秒）。
   *
   * 用户要的："做个心跳机制可以给工程师 bot 们，这样如果任务中断了，
   * 组长 / 部长级别的知晓。"
   *
   * 定得比较宽（6 分钟）是因为：推理型模型光"想"就能想好几分钟，
   * 中间一个字节都不吐 —— 那不算断。真正要抓的是"卡死不动了"。
   */
  stallMs: Number(process.env.PI_BOT_STALL_MS || 360_000),
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
   * bot 是在跟你汇报工作，称呼对了，消息读起来才像团队而不是日志。
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
    dataDir: config.dataDir,
    migratedFrom: config.migratedFrom,
    workspace: config.workspace,
    model: config.model ?? '(pi 默认)',
    thinking: config.thinking,
    tools: config.tools.join(','),
    auth: config.staticToken ? 'static-token' : 'pairing-code',
  };
}

/**
 * bot 会话要加载哪些 pi 侧资源。
 *
 * **默认全关。** 那些资源是给终端里的 pi 用的：
 *   · 扩展（extensions/）：会起子进程（派子 agent、MCP 客户端、弹窗），
 *   · MCP 服务（mcp.json）：每个会话拉一堆 python/node 进程，
 *   · skills / 提示模板：是给终端 agent 的提示词，bot 用不上。
 * bot 需要的是"模型 + 我们自己给的工具"，多一样都是隐患：占资源、塞满提示词、
 * 几十个 bot 并存时互相打架。要开就用环境变量单独开。
 *
 * @param {Record<string,string|undefined>} env
 * @returns {{noExtensions:boolean,noMcp:boolean,noSkills:boolean,noPromptTemplates:boolean}}
 */
export function resourceSwitches(env = process.env) {
  const on = (v) => v === '1';
  return {
    noExtensions: !on(env.PI_BOT_EXTENSIONS),
    noMcp: !on(env.PI_BOT_MCP),
    noSkills: !on(env.PI_BOT_SKILLS),
    noPromptTemplates: !on(env.PI_BOT_SKILLS),
  };
}

/** 本次启动生效的开关 */
export const resourceOptions = resourceSwitches();
