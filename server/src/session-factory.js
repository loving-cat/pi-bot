/**
 * 建会话（执行层）：把一个 bot 在某房间里"跑起来"需要的全部准备工作。
 *
 * 从 pi-runner.js 搬出来。这里最容易出错的地方不是代码复杂，而是**配置的来路**：
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
  getAgentDir,
} from '@earendil-works/pi-coding-agent';

import { config, resourceOptions } from './config.js';
import { store, toolsForPolicy } from './store.js';
import { applyCompactionBudget, withCapacity } from './context-budget.js';
import { buildAppendSystemPrompt } from './system-prompt.js';
import { buildChiefTools, buildCommonTools } from './tools.js';
import { createPolicyExtension } from './policy-hook.js';
import { log } from './util.js';

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
 */
export function createSessionBuilder({ runner, health, resolveModel, modelLabel }) {
  return async function buildSession(roomId, botId) {
    const bot = store.getBot(botId);
    if (!bot) throw new Error(`找不到 bot ${botId}`);

    const sessionDir = path.join(config.dataDir, 'sessions');
    const savedFile = store.sessionFileFor(roomId, botId);
    // 有历史文件就接着用（记忆/上下文都在里面），没有就开新的
    const sessionManager =
      savedFile && fs.existsSync(savedFile)
        ? SessionManager.open(savedFile)
        : SessionManager.create(config.workspace, sessionDir);

    const isChief = bot.role === 'main';
    const commonTools = buildCommonTools({ runner, roomId, botId });
    const customTools = [
      ...commonTools,
      ...(isChief ? buildChiefTools({ runner, health, roomId }) : []),
    ];

    const resourceLoader = new DefaultResourceLoader({
      cwd: config.workspace,
      agentDir: getAgentDir(),
      // 命令级规矩的拦截点：bash/powershell 调用前按部门规则判定
      extensionFactories: [createPolicyExtension({ roomId, bot })],
      // ★ bot 会话不加载 pi 侧的任何"外挂"：扩展、MCP、skills、提示模板。
      //
      //   它们会起子进程（派子 agent / MCP 客户端 / 控制台窗口）、把工具塞进提示词，
      //   而 bot 是长驻的、几十个并存 —— 全挂上会互相打架、把机器拖死。
      //   开关见 config.js 的 resourceSwitches()（PI_BOT_EXTENSIONS / PI_BOT_MCP /
      //   PI_BOT_SKILLS）。这里再按名字挡一遍 context-mode：万一有人手动开了扩展，
      //   这个每会话拉 bun 子进程的家伙也不该进来。
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
      appendSystemPrompt: buildAppendSystemPrompt(bot, {
        userName: store.userName(),
        // 部门规矩跟着会话走：工具集和提示都是建会话时定的，规矩变了会作废重建
        policy: store.policy(),
      }),
      ...resourceOptions,
    });
    await resourceLoader.reload();

    // ★ 部门规矩：只读部门不给"能拆家"的工具。
    //   这是**能真拦住**的那种约束 —— 不给工具，它就干不了；
    //   靠系统提示里写"请先征求同意"是拦不住的（模型忙起来就忘了）。
    const rawTools = isChief ? config.chiefTools : config.tools;
    const baseTools = toolsForPolicy(rawTools, store.policy());

    const botModel = bot.model ? resolveModel(bot.model) : null;
    const picked = pickModelAndThinking({
      bot,
      botModel,
      fallbackModel: runner.model,
      safeLevel: (slug, level) => health?.safeLevel(slug, level),
      modelLabel: modelLabel(),
    });

    const options = {
      cwd: config.workspace,
      sessionManager,
      resourceLoader,
      tools: [...baseTools, ...customTools.map((t) => t.name)],
      customTools,
      // ★★★ 把我们自己的 model runtime 传进去。
      //
      //   不传的话，pi 会**另造一个** runtime（默认只认 ~/.pi/agent/auth.json
      //   和 models.json）—— 而用户在 App 里配的模型组（baseUrl + key + 模型名）
      //   是**运行时注册到我们这个 runtime 上**的，那个新造的 runtime 根本不知道。
      //   症状是"No API key found for local_cline."：探活和菜单（走我们的
      //   runtime）一直显示可用，一到真跑就找不到 key。
      modelRuntime: runner.modelRuntime,
    };
    // 容量覆盖：bot 上设过的 contextWindow / maxTokens 盖在模型自带值之上
    if (picked.model) options.model = withCapacity(picked.model, bot);
    if (picked.thinking) options.thinkingLevel = picked.thinking;

    const { session, modelFallbackMessage } = await createAgentSession(options);
    if (modelFallbackMessage) log(`[${bot.name}] 模型回退：${modelFallbackMessage}`);

    // 上下文预算：bot 自己设过的优先，其次全局默认，都没有就听 pi 的。
    // 用 applyOverrides 而不是写 settings.json —— 那个是全局的，
    // 而"每个 bot 一套预算"必须在会话级别生效。
    applyCompactionBudget(session, bot);

    if (session.sessionFile && session.sessionFile !== savedFile) {
      store.setSessionFile(roomId, botId, session.sessionFile);
    }
    log(
      `会话就绪 ${roomId} · ${bot.emoji ?? ''}${bot.name} → ` +
        `${path.basename(session.sessionFile ?? '(内存)')}`,
    );
    return { session, bot };
  };
}
