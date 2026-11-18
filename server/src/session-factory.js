/**
 * 建会话（执行层）：把一个 bot 在某房间里"跑起来"需要的全部准备工作。
 *
 * 这里最容易出错的地方不是代码复杂，而是**配置的来路**：
 * 模型来自用户自己配的模型组、工具集受部门规矩限制、上下文预算三层回退、
 * 系统提示跟着用户名和规矩走 —— 任何一条接错，表现都是"跑不起来"或"跑错东西"，
 * 而且很难从界面看出来。
 *
 * 会话池（缓存、pending 去重、LRU 驱逐）留在 runner 里：那是"怎么复用"，
 * 这里是"怎么造出来"。造完交回去。
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  DefaultResourceLoader,
  SessionManager,
  createAgentSession,
  createBashTool,
  createPowerShellTool,
  getAgentDir,
} from '@earendil-works/pi-coding-agent';

import { config as defaultConfig, resourceOptions } from './config.js';
import { store as defaultStore } from './store.js';
import { preferencesPromptLines } from './preferences.js';
import { isDelegatingLead, isRoomLead, isReadonlyPolicy, toolsForRole, customToolsForRole, roleConfigurationKey } from './role-tools.js';
import { executionModeOf } from './exec-mode.js';
import { applyCompactionBudget, withCapacity } from './context-budget.js';
import { buildAppendSystemPrompt } from './system-prompt.js';
import { buildSandboxedShellTools, setMcpCounter, setSandboxProbe } from './sandboxed-shell.js';
import { probeSandbox } from './sandbox.js';
import { buildChiefTools, buildCommonTools } from './tools.js';
import { buildIntakeTools, intakeEnabled } from './coordination/intake-tool.js';
import { buildReportTool } from './tasks/task-report-tool.js';
import { buildMemberTaskTool } from './tasks/task-member-tool.js';
import { buildPlanTool } from './tasks/task-plan-tool.js';
import { buildGitTools } from './git-tools.js';
import { buildExpertReviewTool } from './tasks/task-expert-tool.js';
import { buildTaskInsightTools } from './coordination/task-insight-tool.js';
import { createPolicyExtension } from './policy-hook.js';
import { createMcpExtension, mcpSectionForPrompt } from './mcp-hook.js';
import { capabilityGuideForPrompt } from './mcp-capability.js';
import { log } from './util.js';
import { menuEntries } from './model-menu.js';
import { modelCatalogSection } from './model-dispatch.js';

/**
 * 这个 bot 用哪个模型、哪个思考档位。
 *
 * 纯函数：把"挑了谁"的判断从建会话那一大坨里拎出来，好单测。
 *   · 没单独设模型 → 用全局默认
 *   · 这个模型的这个档位**已知会吐空**（档位矩阵探出来的）→ 换一个能用的
 */
export function pickModelAndThinking({
  bot = {},
  botModel = null,
  fallbackModel = null,
  safeLevel = null,
  modelLabel = '',
} = {}) {
  const model = botModel ?? fallbackModel ?? null;
  let thinking = bot.thinking || null;
  if (thinking && safeLevel) {
    const slug = botModel ? `${botModel.provider}/${botModel.id}` : modelLabel;
    thinking = safeLevel(slug, thinking) ?? thinking;
  }
  return { model, thinking };
}

/**
 * @param {object} deps
 * @param {object} deps.runner      PiRunner 实例（工具要回调它，比如发图 / 派活）
 * @param {object} deps.health      模型探活（档位安全值）
 * @param {(slug:string)=>any} deps.resolveModel
 * @param {()=>string} deps.modelLabel
 * @param {object} [deps.sessionApi] 会话SDK适配器，默认使用生产实现。
 */
export function createSessionBuilder({
  runner, health, resolveModel, modelLabel,
  config: scopedConfig = null,
  store: scopedStore = null,
  bus: scopedBus = null,
  sessionApi = {
    DefaultResourceLoader,
    SessionManager,
    createAgentSession,
    createBashTool,
    createPowerShellTool,
    getAgentDir,
  },
}) {
  const config = scopedConfig ?? runner?.config ?? defaultConfig;
  const store = scopedStore ?? runner?.store ?? defaultStore;
  const bus = scopedBus ?? runner?.bus ?? null;
  const {
    DefaultResourceLoader,
    SessionManager,
    createAgentSession,
    createBashTool,
    createPowerShellTool,
    getAgentDir,
  } = sessionApi;

  // 注入依赖（不用模块顶层 import，避免 store ↔ session-factory 循环依赖）
  setSandboxProbe(probeSandbox);
  setMcpCounter((botId) => {
    try { return store.mcpServersFor(botId).length; } catch { return 0; }
  });

  /**
   * 建一个会话。
   *
   * @param {string} roomId
   * @param {string} botId
   * @param {{reportTool?: boolean}} [opts]
   *   `reportTool`：这次会话要不要带受管阶段报告工具。
   *   只有受管执行才需要 —— 普通调用拿到它也没有消费者。
   */
  /**
   * 把用户覆盖盖到 bot 记录上（只碰白名单字段）。
   *
   * 为什么要单独一个函数：这是**唯一**允许"覆盖影响行为"的地方。
   * 散在别处就会出现"我以为改了人设、其实没生效"或者反过来的情况。
   */
  function applyBotOverride(bot, override) {
    if (!override || !override.values) return bot;
    const merged = { ...bot };
    for (const [key, value] of Object.entries(override.values)) {
      if (value === undefined || value === null) continue;
      merged[key] = value;
    }
    return merged;
  }

  return async function buildSession(roomId, botId, opts = {}) {
    const isTalkLane = opts.talkLane === true;
    const wantsReportTool = !isTalkLane && opts.reportTool === true;
    const stored = store.getBot(botId);
    if (!stored) throw new Error(`找不到 bot ${botId}`);

    // ★ 用户自定义覆盖（规格 §13.1 第②层）：人设/模型/技能这些"软配置"
    //   在**用的时候**合成，不在存的时候合并。
    //
    //   这样模板升级只改模板，用户改过的东西还在；而且"这个值是谁定的"
    //   随时查得到（`sources`）。合并进 bot 记录会让两件事都做不到。
    //
    //   注意覆盖**只允许白名单字段**（见 overrides.js），所以这里不可能被
    //   用来改 mcpServers / role 这类能扩权的字段。
    const bot = applyBotOverride(stored, store.botOverride(botId));

    const sessionDir = path.join(config.dataDir, 'sessions');
    const savedFile = isTalkLane ? null : store.sessionFileFor(roomId, botId);
    // 旁路 Talk 会话强制纯内存隔离，绝不与后台 Work 并发读写同一磁盘会话文件
    const sessionManager = isTalkLane
      ? (typeof SessionManager.inMemory === 'function'
          ? SessionManager.inMemory(config.workspace)
          : {})
      : (savedFile && fs.existsSync(savedFile)
          ? SessionManager.open(savedFile)
          : SessionManager.create(config.workspace, sessionDir));

    const isChief = bot.role === 'main';
    const room = store.getRoom(roomId);
    const isDeptLead = isDelegatingLead(room, bot);
    const policy = store.policy();
    const effectivePolicy = isTalkLane ? { ...policy, dangerous: 'deny' } : policy;
    const roleKey = roleConfigurationKey(room, bot);
    // isMain 决定要不要给 ask_user（主控不给 —— 它直接跟用户对话，不弹卡片）
    const commonTools = buildCommonTools({ runner, roomId, botId, isMain: isChief, store, config, bus });
    // ★ 受管阶段报告工具：真的注册进 SDK，模型才能调用。
    //   收集器由 runner 按「房间:Bot」挂，工具 execute 时取当前那个。
    const reportTools = wantsReportTool
      ? [buildReportTool({ collect: (input) => runner.collectReport?.(roomId, botId, input) })]
      : [];
    // 负责人派活工具：只有受管执行时注册，成员用不了（执行体里再核一次）
    // ★ 负责人先列计划、再按计划派活。
    //   正常团队是「先有分工方案，再照着分发」；没有计划的派活是
    //   一次性的，出了偏差没人知道该对齐到哪里。
    const memberTools = wantsReportTool && isDeptLead
      ? [
        buildPlanTool({ runner, store, roomId, botId }),
        buildMemberTaskTool({ runner, store, roomId, botId }),
      ]
      : [];
    // 验收能力与派工能力分开：单成员部门仍可有真实负责人做专业验收，只是不能派工。
    const expertTools = wantsReportTool && isRoomLead(room, botId)
      ? [buildExpertReviewTool({ runner, store, roomId, botId })]
      : [];

    // ★ Git：负责人对自己的任务有 git 权限（用户 2026-11-14 的产品要求），
    //   主控也有（它在根目录调度整机）。执行 Bot 不给 ——
    //   规格 §5.3「执行 Bot 不能自批、转授或修改策略」，
    //   而提交是"把改动落成事实"，那一步该由负责人核对后做。
    //
    //   能力边界在 git-ops.js 的白名单里（只有 status/diff/log/show/branches/add/commit），
    //   push/merge/reset/clean 在那张表里根本没有。
    const gitTools = !isTalkLane && (isChief || isDeptLead)
      ? buildGitTools({ runner, store, roomId, botId, config })
      : [];

    // ★ 接单工具：正式内部入口。默认关闭，不影响真实用户路径。
    const intakeTools =
      !isTalkLane && isChief && intakeEnabled()
        ? buildIntakeTools({
            runner, store, roomId, botId, health,
            requestScopeOf: () => runner.currentRequestScope?.(roomId, botId) ?? null,
          })
        : [];

    // 自然进度/改版：主控在本轮理解里读任务权威状态或沿原任务升版。
    const insightTools = !isTalkLane && isChief && intakeEnabled()
      ? buildTaskInsightTools({ runner, store, roomId, botId })
      : [];

    const modelGroups = runner?.modelGroups ?? null;
    const customTools = isTalkLane
      ? []
      : customToolsForRole([
          ...commonTools,
          ...reportTools,
          ...memberTools,
          ...expertTools,
          ...gitTools,
          ...intakeTools,
          ...insightTools,
          ...(isChief ? buildChiefTools({ runner, health, roomId, botId, store, config, bus, modelGroups }) : []),
        ], { room, bot, policy });


    // 角色能力与行为策略共同决定内置工具；旁路 Talk 仅保留只读查阅能力。
    const rawBaseTools = toolsForRole({
      isChief,
      isDeptLead,
      chiefTools: config.chiefTools,
      leadTools: config.leadTools,
      memberTools: config.tools,
      policy: effectivePolicy,
    });
    const baseTools = isTalkLane
      ? rawBaseTools.filter((t) => ['read', 'ls', 'find', 'grep'].includes(t))
      : rawBaseTools;

    // 旁路 Talk 不起沙箱 shell 工具，避免任何命令执行开销
    const shellTools = isTalkLane
      ? []
      : buildSandboxedShellTools({
          bot,
          workDir: config.workspace,
          dataDir: config.dataDir,
          tools: baseTools,
          mcpCount: store.mcpServersFor(botId).length,
          config,
          pi: { createBashTool, createPowerShellTool },
        });

    // ★ 执行模式（规格 §8）—— **必须在这里算**，因为只有这里知道
    //   命令工具到底换没换成沙箱版。算晚了（或者干脆不传）就变成
    //   “授权上写了 mode、运行时根本不看”，§8 整节形同虚设。
    const execMode = executionModeOf({ bot, sandboxedToolNames: shellTools.map((t) => t.name) });

    const baseAppendPrompt = buildAppendSystemPrompt(bot, {
      userName: store.userName(),
      // ★ 用户的习惯（规格 spec-intent-and-habits-v1.md §3）：只放 strong、最多 5 条。
      preferenceLines: preferencesPromptLines(store.preferences()),
      // 部门规矩跟着会话走：工具集和提示都是建会话时定的，规矩变了会作废重建
      policy: effectivePolicy,
      // MCP 清单只给主控：它要知道有哪些能力可以派给成员。
      mcpLines: !isTalkLane && isChief
        ? [mcpSectionForPrompt({ store }), capabilityGuideForPrompt(store.mcpLibrary())]
            .filter(Boolean)
            .join('\n\n')
        : '',

      modelLines: !isTalkLane && isChief ? modelCatalogSection(menuEntries(modelGroups ?? undefined), health) : '',
    });

    const talkAppendPrompt = isTalkLane
      ? `${baseAppendPrompt}\n\n## 全双工快速旁路通道规则\n` +
        '当前处于「边干活边回话」的旁路只读通道：后台工作会话仍在继续执行，' +
        '请直接结合实时工作台快照与上下文，用 1～4 句自然口吻快速回答用户问题或确认已记下补充要求；' +
        '禁止在当前旁路里声称执行了写文件、跑命令或改任务状态，也不要生硬复述快照格式。'
      : baseAppendPrompt;

    const resourceLoader = new DefaultResourceLoader({
      cwd: config.workspace,
      agentDir: getAgentDir(),
      // 旁路 Talk 不挂载 MCP，保留策略钩子兜底只读
      extensionFactories: [
        createPolicyExtension({
          roomId,
          bot,
          grantGate: runner.grantGate ?? null,
          mode: execMode,
          talkLane: isTalkLane,
          config,
          store,
          bus,
          managedContextOf: () => runner.currentTaskContext?.(roomId, bot.id) ?? null,
          onBlocked: (approval, info) => runner.notePolicyBlocked?.(roomId, bot.id, approval, info),
        }),
        ...(isTalkLane ? [] : [createMcpExtension({ botId, roomId, store })]),
      ],
      extensionsOverride: (base) => {
        const needles = (process.env.PI_BOT_DISABLED_EXTENSIONS ?? 'context-mode')
          .split(',')
          .map((x) => x.trim())
          .filter(Boolean);
        if (!needles.length) return base;
        return {
          ...base,
          extensions: base.extensions.filter((ext) => {
            const where = `${ext.path ?? ''} ${ext.resolvedPath ?? ''}`;
            return !needles.some((needle) => where.includes(needle));
          }),
        };
      },
      appendSystemPrompt: talkAppendPrompt,
      ...resourceOptions,
      ...(isTalkLane || isDeptLead || isReadonlyPolicy(effectivePolicy)
        ? { noExtensions: true, noMcp: true }
        : {}),
    });
    await resourceLoader.reload();

    const botModel = bot.model ? resolveModel(bot.model) : null;
    const picked = pickModelAndThinking({
      bot,
      botModel,
      fallbackModel: runner.model,
      safeLevel: (slug, level) => health?.safeLevel(slug, level),
      modelLabel: modelLabel(),
    });
    if (isTalkLane && picked.thinking && picked.thinking !== 'off') {
      const talkThinking = String(process.env.PI_BOT_TALK_THINKING ?? 'low').trim();
      if (talkThinking) picked.thinking = talkThinking;
    }

    const options = {
      cwd: config.workspace,
      sessionManager,
      resourceLoader,
      // 沙箱版 shell 工具与内置同名，放在后面即可覆盖
      tools: [...baseTools, ...customTools.map((t) => t.name), ...shellTools.map((t) => t.name)],
      customTools: [...customTools, ...shellTools],
      // ★★★ 把 runner 的 model runtime 传进去。
      modelRuntime: runner.modelRuntime,
    };
    // 容量覆盖：bot 上设过的 contextWindow / maxTokens 盖在模型自带值之上
    if (picked.model) options.model = withCapacity(picked.model, bot);
    if (picked.thinking) options.thinkingLevel = picked.thinking;

    const { session, modelFallbackMessage } = await createAgentSession(options);
    if (modelFallbackMessage) log(`[${bot.name}] 模型回退：${modelFallbackMessage}`);

    applyCompactionBudget(session, bot);

    if (!isTalkLane && session.sessionFile && session.sessionFile !== savedFile) {
      store.setSessionFile(roomId, botId, session.sessionFile);
    }
    log(
      `${isTalkLane ? '[talk] ' : ''}会话就绪 ${roomId} · ${bot.emoji ?? ''}${bot.name} → ` +
        `${path.basename(session.sessionFile ?? '(内存)')}`,
    );
    return {
      session,
      bot,
      configurationCurrent: () => roleKey ===
        roleConfigurationKey(store.getRoom(roomId), store.getBot(botId)),
    };
  };
}
