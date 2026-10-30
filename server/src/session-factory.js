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
  getAgentDir,
} from '@earendil-works/pi-coding-agent';

import { config, resourceOptions } from './config.js';
import { store } from './store.js';
import { isDelegatingLead, isReadonlyPolicy, toolsForRole, customToolsForRole, roleConfigurationKey } from './role-tools.js';
import { applyCompactionBudget, withCapacity } from './context-budget.js';
import { buildAppendSystemPrompt } from './system-prompt.js';
import { buildChiefTools, buildCommonTools } from './tools.js';
import { createPolicyExtension } from './policy-hook.js';
import { createMcpExtension, mcpSectionForPrompt } from './mcp-hook.js';
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
  sessionApi = { DefaultResourceLoader, SessionManager, createAgentSession, getAgentDir },
}) {
  const { DefaultResourceLoader, SessionManager, createAgentSession, getAgentDir } = sessionApi;
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
    const room = store.getRoom(roomId);
    const isDeptLead = isDelegatingLead(room, bot);
    const policy = store.policy();
    const roleKey = roleConfigurationKey(room, bot);
    // isMain 决定要不要给 ask_user（主控不给 —— 它直接跟用户对话，不弹卡片）
    const commonTools = buildCommonTools({ runner, roomId, botId, isMain: isChief });
    const customTools = customToolsForRole([
      ...commonTools,
      ...(isChief ? buildChiefTools({ runner, health, roomId, botId }) : []),
    ], { room, bot, leadTools: config.leadTools, policy });

    const resourceLoader = new DefaultResourceLoader({
      cwd: config.workspace,
      agentDir: getAgentDir(),
      // 命令级规矩的拦截点：bash/powershell 调用前按部门规则判定
      extensionFactories: [
        createPolicyExtension({ roomId, bot }),
        // ★ 用户在「设置 → MCP」里配的服务，按这个 bot 的选择逐个注册。
        //   注意这跟 resourceOptions.noMcp 不冲突：那个开关关掉的是
        //   pi 自己的 mcp.json（终端用户的外挂），这里挂的是 pi-bot 自己的服务库，
        //   已经经过"库内启用 + bot 选中"两道门，默认一个都不连。
        createMcpExtension({ botId, roomId }),
      ],
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
        policy,
        // MCP 清单只给主控：它要知道有哪些能力可以派给成员。
        // 成员自己不拿这份清单 —— 它们要的是已经挂载的工具，不是能力目录。
        mcpLines: isChief ? mcpSectionForPrompt() : '',
        modelLines: isChief ? modelCatalogSection(menuEntries(), health) : '',
      }),
      ...resourceOptions,
      ...(isDeptLead || isReadonlyPolicy(policy) ? { noExtensions: true, noMcp: true } : {}),
    });
    await resourceLoader.reload();

    // 角色能力与行为策略共同决定内置工具；单人部门保留执行能力。
    const baseTools = toolsForRole({
      isChief,
      isDeptLead,
      chiefTools: config.chiefTools,
      leadTools: config.leadTools,
      memberTools: config.tools,
      policy,
    });

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
      // ★★★ 把 runner 的 model runtime 传进去。
      //
      //   不传的话，pi 会**另造一个** runtime（默认只认 ~/.pi/agent/auth.json
      //   和 models.json）—— 而用户在 App 里配的模型组（baseUrl + key + 模型名）
      //   是**运行时注册到这个 runtime 上**的，那个新造的 runtime 根本不知道。
      //   症状是"No API key found for local_cline."：探活和菜单（走这个
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
    return {
      session,
      bot,
      configurationCurrent: () => roleKey ===
        roleConfigurationKey(store.getRoom(roomId), store.getBot(botId)),
    };
  };
}
