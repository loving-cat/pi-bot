/**
 * 额外 provider 注册。
 *
 * pi 的 provider 有两种来源：
 *   1. ~/.pi/agent/models.json（静态声明，ModelRuntime.create() 能直接看到）
 *   2. 扩展运行时注册（比如 cline-provider 扩展），只有 pi CLI / dsh 进程里才有
 *
 * pi-bot server 是独立进程，拿不到第 2 种，所以这里自己注册一份。
 * 优先级：<server>/pi-bot.config.json 里的 providers  >  自动从扩展配置文件导入。
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { config } from './config.js';
import { modelGroups } from './model-groups.js';
import { readJson, log } from './util.js';

const AGENT_DIR = path.join(os.homedir(), '.pi', 'agent');

/**
 * 镜像 ~/.pi/agent/extensions/cline-provider/index.ts 的 MODELS 定义。
 * 那边改了这里也要跟着改（成本/上下文/thinkingLevelMap 都是实测值）。
 */
function clineProviderConfig(cfg) {
  const model = (id, name, input, cost) => ({
    id,
    name,
    reasoning: true,
    thinkingLevelMap: {
      off: 'minimal',
      minimal: 'minimal',
      low: 'low',
      medium: 'medium',
      high: 'high',
      xhigh: 'high',
      max: 'max',
    },
    input,
    cost,
    contextWindow: 1_000_000,
    maxTokens: 32_768,
    compat: {
      supportsDeveloperRole: false,
      supportsReasoningEffort: true,
      thinkingFormat: 'openai',
    },
  });

  return {
    name: 'ClinePass',
    baseUrl: cfg.baseUrl || 'https://api.cline.bot/api/v1',
    apiKey: cfg.apiKey,
    api: 'openai-completions',
    authHeader: true,
    models: [
      model('cline-pass/deepseek-v4.1-flash', 'DeepSeek V4.1 Flash', ['text', 'image'], {
        input: 0.3,
        output: 1.2,
        cacheRead: 0.006,
        cacheWrite: 0,
      }),
      model('cline-pass/deepseek-v4-pro', 'DeepSeek V4 Pro', ['text'], {
        input: 1.32,
        output: 3.96,
        cacheRead: 0.044,
        cacheWrite: 0,
      }),
    ],
  };
}

/** 返回 { providerId: ProviderConfigInput } */
export function loadExtraProviders() {
  const out = {};

  // 1) 服务器自带配置
  const localFile = path.join(config.pkgRoot, 'pi-bot.config.json');
  const local = readJson(localFile, null);
  if (local?.providers && typeof local.providers === 'object') {
    Object.assign(out, local.providers);
    log(`📦 从 pi-bot.config.json 载入 ${Object.keys(local.providers).length} 个 provider`);
  }

  // 2) 自动导入 cline 扩展的 key（没被 1) 覆盖时）
  if (!out.cline) {
    const clineCfg = readJson(path.join(AGENT_DIR, 'cline-provider', 'config.json'), null);
    if (clineCfg?.apiKey) {
      out.cline = clineProviderConfig(clineCfg);
      log('📦 自动导入 cline 扩展的 ClinePass provider');
    }
  }

  // 2.5) 把本机 cline 那套带成一个「正在用」的模型组（App 里能看见、不可删）
  const clineCfg = readJson(path.join(AGENT_DIR, 'cline-provider', 'config.json'), null);
  if (clineCfg?.apiKey) {
    const p = clineProviderConfig(clineCfg);
    modelGroups.seedBuiltin({
      id: 'local_cline',
      name: '本机 cline（正在用）',
      baseUrl: p.baseUrl,
      apiKey: p.apiKey,
      api: p.api,
      models: p.models.map((m) => ({
        id: m.id,
        name: m.name,
        contextWindow: m.contextWindow,
        maxTokens: m.maxTokens,
      })),
    });
  }

  // 3) 用户在设置里自己加的模型组（优先级最低 —— 前面两种是"部署方"配的，
  //    这一种是"使用者"配的，同名时让前者说了算）
  const custom = modelGroups.toProviderConfigs();
  for (const [id, cfg] of Object.entries(custom)) {
    if (!out[id]) out[id] = cfg;
  }
  if (Object.keys(custom).length) {
    log(`📦 载入 ${Object.keys(custom).length} 个自定义模型组`);
  }

  return out;
}

/** pi settings.json 里用户选的默认模型 */
export function settingsDefaultModel() {
  const settings = readJson(path.join(AGENT_DIR, 'settings.json'), null);
  return settings?.defaultModel ?? null;
}
