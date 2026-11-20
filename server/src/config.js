/**
 * Orbis server 配置。
 *
 * 全部可用环境变量覆盖（优先 `ORBIS_*`，兼容 `PI_BOT_*`）；默认使用平台对应的用户数据目录。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { BRAND_NAME, noticeBrandDeprecation, readBrandEnv } from './brand.js';
import { migrateLegacyData, migratedWorkspace, repairSessionRefs, SERVER_BOOT } from './data-migration.js';

const pkgRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

/**
 * 用户数据目录：与安装位置无关，重装/换目录不影响数据。
 *
 * Windows 为 %LOCALAPPDATA%\pi-bot\data，macOS 为
 * ~/Library/Application Support/pi-bot/data，Linux 为
 * $XDG_DATA_HOME/pi-bot/data。
 */
/**
 * 本组件在用户目录下的文件夹名。
 *
 * 2026-11-19 品牌统一：新装用 `orbis`，但**老用户的数据还在 `pi-bot` 下**。
 */
const HOME_DIR_NAME = 'orbis';
// @remove-2.0 2.0 起把旧目录回退整段删掉（届时给用户一次“手动重命名目录”的说明）
const LEGACY_HOME_DIR_NAME = 'pi-bot';

/**
 * 选一个目录名：`orbis` 优先，旧 `pi-bot` 只在“新目录还不存在”时继续沿用。
 *
 * ★ 为什么不自动迁移：迁移一旦半途失败（磁盘满、权限、进程被结束），
 *   用户看到的是“我的聊天记录全没了”。沿用旧目录零风险，想换的用户
 *   可以手动搬（见 docs/WINDOWS.md 的升级说明）。
 *
 * 命中旧目录时发一次弃用提醒（1.7.1）：不提醒的话，用户到 2.0 才会
 * 发现程序突然不看旧目录了。
 */
export function resolveHomeDir(base) {
  const next = path.join(base, HOME_DIR_NAME);
  const legacy = path.join(base, LEGACY_HOME_DIR_NAME);
  try {
    if (!fs.existsSync(next) && fs.existsSync(legacy)) {
      noticeBrandDeprecation({
        kind: 'data-dir',
        from: legacy,
        to: next,
        hint:
          '2.0 不再读旧目录；可以停服务后手动把目录改名，或等 2.0 发布后用迁移工具做复制迁移',
      });
      return legacy;
    }
  } catch { /* 读不到就按新目录走 */ }
  return next;
}

function userDataDir() {
  if (process.platform === 'win32' && process.env.LOCALAPPDATA) {
    return path.join(resolveHomeDir(process.env.LOCALAPPDATA), 'data');
  }
  if (process.platform === 'darwin') {
    return path.join(resolveHomeDir(path.join(os.homedir(), 'Library', 'Application Support')), 'data');
  }
  const base = process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share');
  return path.join(resolveHomeDir(base), 'data');
}

/**
 * 构造实例级配置（无模块级全局副作用，供 SDK / 多实例宿主使用）。
 *
 * `dataDir` / `workspace` 优先取显式入参，否则读 `env` 或平台用户数据目录。
 * 只有显式传 `serverBoot: true` 且未指定 `dataDir` 时才做旧目录迁移与修复。
 */
export function createConfig(overrides = {}) {
  const {
    env = process.env,
    serverBoot = false,
    ensureDirs = true,
    home: overrideHome,
    dataDir: overrideDataDir,
    workspace: overrideWorkspace,
    ...scalarOverrides
  } = overrides;

  /** 本次启动是否执行了数据迁移（未迁移为 null） */
  let migratedFrom = null;

  const home = overrideDataDir
    ? path.resolve(overrideDataDir)
    : overrideHome
      ? path.resolve(overrideHome)
      : readBrandEnv(env, 'HOME')
        ? path.resolve(readBrandEnv(env, 'HOME'))
        : userDataDir();

  // ⇩ 必须在 store 读 state.json 之前跑（store 在它自己的模块加载时就读）。
  //   迁移和修复都只是文件操作，失败不能挡住启动。
  //
  // ★ 只在「真的要起服务端」且未覆盖 dataDir 时动数据：
  //   index.js 在导入 server-main 之前调用 markServerBoot()。
  //   否则任何 import 了 config 的脚本（诊断、维护、一次性检查）都会改写用户的 state.json。
  //   用进程内的标记而不是环境变量：ORBIS_* / PI_BOT_* 会被子进程继承（见 child-env.js），
  //   bot 的 shell 里再跑一个导入 config 的脚本也会触发。
  const warn = (msg) => console.warn(msg);
  if (serverBoot === true && !overrideDataDir) {
    try {
      if (!readBrandEnv(env, 'HOME')) {
        const legacy = path.join(pkgRoot, 'data');
        if (migrateLegacyData({ legacy, target: home, log: warn }).migrated) migratedFrom = legacy;
      }
      // state.json 里指向数据目录之外的会话文件，每次启动改回 <数据目录>/sessions。
      repairSessionRefs({ dataDir: home, log: warn });
    } catch (err) {
      console.warn('[config] 数据迁移/修复失败（继续启动，旧目录未动）：', err?.message || err);
    }
  }

  const dataDir = home;
  // 优先级：显式入参 > 环境变量 > 迁移时记下的旧工作目录（没复制，继续用）> <数据目录>/workspace
  const wsEnv = readBrandEnv(env, 'WORKSPACE');
  const workspace = overrideWorkspace
    ? path.resolve(overrideWorkspace)
    : wsEnv
      ? path.resolve(wsEnv)
      : (migratedWorkspace(home) ?? path.join(home, 'workspace'));

  if (ensureDirs !== false) {
    for (const dir of [home, dataDir, workspace, path.join(dataDir, 'rooms'), path.join(dataDir, 'sessions')]) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  const tools = (readBrandEnv(env, 'TOOLS') || 'read,write,edit,ls,find,grep,bash')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  const built = {
    // 服务进程实例：客户端用它隔离旧连接/旧服务回包
    serverInstanceId: randomUUID(),
    pkgRoot,
    home,
    dataDir,
    workspace,
    /** 本次启动是否从旧目录迁移而来（未迁移为 null） */
    migratedFrom,
    host: readBrandEnv(env, 'HOST') || '0.0.0.0',
    port: Number(readBrandEnv(env, 'PORT') || 8787),
    serverName: readBrandEnv(env, 'NAME') || BRAND_NAME,
    discoveryEnabled: readBrandEnv(env, 'DISCOVERY') !== '0',
    tlsEnabled: readBrandEnv(env, 'TLS') !== '0',
    tlsPort: Number(readBrandEnv(env, 'TLS_PORT') || 8443),
    discoveryPort: Number(readBrandEnv(env, 'DISCOVERY_PORT') || 8788),
    staticToken: readBrandEnv(env, 'TOKEN') || null,
    trustLocal: readBrandEnv(env, 'TRUST_LOCAL')
      ? readBrandEnv(env, 'TRUST_LOCAL') === '1'
      : !readBrandEnv(env, 'TOKEN'),
    allowedHosts: (readBrandEnv(env, 'ALLOWED_HOSTS') || '')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
    model: readBrandEnv(env, 'MODEL') || null,
    thinking: readBrandEnv(env, 'THINKING') || 'medium',
    tools,
    maxMessagesPerRoom: Number(readBrandEnv(env, 'MAX_MESSAGES') || 500),
    autoProbe: readBrandEnv(env, 'PROBE') !== '0',
    pairTtlMs: Number(readBrandEnv(env, 'PAIR_TTL_MS') || 10 * 60 * 1000),
    lessonReflect: readBrandEnv(env, 'LESSON_REFLECT') !== '0',
    autoAttachArtifacts: readBrandEnv(env, 'AUTO_ATTACH_FILES') !== '0',
    autoAttachImages: readBrandEnv(env, 'AUTO_ATTACH') !== '0',
    groupBusyWaitMs: Number(readBrandEnv(env, 'GROUP_BUSY_WAIT_MS') || 120_000),
    heartbeatMs: Number(readBrandEnv(env, 'HEARTBEAT_MS') || 15_000),
    stallMs: Number(readBrandEnv(env, 'STALL_MS') || 360_000),
    maxSessions: Number(readBrandEnv(env, 'MAX_SESSIONS') || 40),
    maxConcurrentRuns: Number(readBrandEnv(env, 'MAX_CONCURRENT_RUNS') || 0),
    runSlotReserve: Number(readBrandEnv(env, 'RUN_SLOT_RESERVE') ?? 1),
    runSlotWaitMs: Number(readBrandEnv(env, 'RUN_SLOT_WAIT_MS') || 0),
    backgroundConcurrency: Number(readBrandEnv(env, 'BACKGROUND_CONCURRENCY') ?? 1),
    backgroundSlotWaitMs: Number(readBrandEnv(env, 'BACKGROUND_SLOT_WAIT_MS') ?? 30_000),
    chiefTools: (readBrandEnv(env, 'CHIEF_TOOLS') || 'read,write,edit,ls,find,grep,bash').split(',').map((s) => s.trim()).filter(Boolean),
    leadTools: (readBrandEnv(env, 'LEAD_TOOLS') || 'read,write,edit,ls,find,grep,bash').split(',').map((s) => s.trim()).filter(Boolean),
    searchUrl: readBrandEnv(env, 'SEARCH_URL') || null,
    searchKey: readBrandEnv(env, 'SEARCH_KEY') || null,
    reserveTokens: Number(readBrandEnv(env, 'RESERVE_TOKENS') || 0) || null,
    keepRecentTokens: Number(readBrandEnv(env, 'KEEP_RECENT_TOKENS') || 0) || 60_000,
    compactAtPercent: Number(readBrandEnv(env, 'COMPACT_AT_PERCENT') || 0.6),
    autoCompact: readBrandEnv(env, 'AUTO_COMPACT') !== '0',
    fullDuplex: readBrandEnv(env, 'FULL_DUPLEX') !== '0',
    jarvisMode: readBrandEnv(env, 'JARVIS') !== '0',
    memoryRecursive: readBrandEnv(env, 'MEMORY_RECURSIVE') !== '0',
    runTimeoutMs: Number(readBrandEnv(env, 'RUN_TIMEOUT_MS') || 10 * 60 * 1000),
    hostname: os.hostname(),
    userName: readBrandEnv(env, 'USER_NAME') || os.userInfo().username || '我',
  };

  for (const [k, v] of Object.entries(scalarOverrides)) {
    if (v !== undefined) built[k] = v;
  }
  return built;
}

export const config = createConfig({
  env: process.env,
  serverBoot: globalThis[SERVER_BOOT] === true,
});

export function describeConfig(cfg = config) {
  return {
    serverName: cfg.serverName,
    port: cfg.port,
    home: cfg.home,
    dataDir: cfg.dataDir,
    migratedFrom: cfg.migratedFrom,
    workspace: cfg.workspace,
    model: cfg.model ?? '(pi 默认)',
    thinking: cfg.thinking,
    tools: cfg.tools.join(','),
    auth: cfg.staticToken ? 'static-token' : 'pairing-code',
    trustLocal: cfg.trustLocal,
  };
}

/**
 * bot 会话要加载哪些 pi 侧资源。
 *
 * **默认全关。** 那些资源是给终端里的 pi 用的：
 *   · 扩展（extensions/）：会起子进程（派子 agent、MCP 客户端、弹窗），
 *   · MCP 服务（mcp.json）：每个会话拉一堆 python/node 进程，
 *   · skills / 提示模板：是给终端 agent 的提示词，bot 用不上。
 * bot 需要的是"模型 + 这里给的工具"，多一样都是隐患：占资源、塞满提示词、
 * 几十个 bot 并存时互相打架。要开就用环境变量单独开。
 *
 * @param {Record<string,string|undefined>} env
 * @returns {{noExtensions:boolean,noMcp:boolean,noSkills:boolean,noPromptTemplates:boolean}}
 */
export function resourceSwitches(env = process.env) {
  const on = (v) => v === '1';
  return {
    noExtensions: !on(readBrandEnv(env, 'EXTENSIONS')),
    noMcp: !on(readBrandEnv(env, 'MCP')),
    noSkills: !on(readBrandEnv(env, 'SKILLS')),
    noPromptTemplates: !on(readBrandEnv(env, 'SKILLS')),
  };
}

/** 本次启动生效的开关 */
export const resourceOptions = resourceSwitches();
