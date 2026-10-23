/**
 * 当前模型要用的 provider key。只交给 pi 子 agent，不进白名单。
 *
 * 模型从哪来：命令行 `--model` / `-m`，否则 `PI_BOT_MODEL`，
 * 否则 pi 的 settings.json 里的 `defaultModel`。
 * 变量名：内置 provider 的环境变量，再加上 models.json 里这个 provider
 * 写成 `$NAME` 的引用。值只从本进程环境里拿。
 *
 * 云凭证（AWS、GOOGLE_APPLICATION_CREDENTIALS 等）不在这里传。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** 跟 pi-ai 的 API key 环境变量对齐。不含云凭证。 */
const PROVIDER_ENV = {
  'github-copilot': ['COPILOT_GITHUB_TOKEN'],
  anthropic: ['ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_OAUTH_TOKEN', 'ANTHROPIC_API_KEY'],
  'ant-ling': ['ANT_LING_API_KEY'],
  'qwen-token-plan': ['QWEN_TOKEN_PLAN_API_KEY'],
  'qwen-token-plan-cn': ['QWEN_TOKEN_PLAN_CN_API_KEY'],
  'qwen-token-plan-individual': ['QWEN_TOKEN_PLAN_API_KEY'],
  openai: ['OPENAI_API_KEY'],
  azure: ['AZURE_OPENAI_API_KEY'],
  nvidia: ['NVIDIA_API_KEY'],
  deepseek: ['DEEPSEEK_API_KEY'],
  google: ['GEMINI_API_KEY'],
  'google-vertex': ['GOOGLE_CLOUD_API_KEY'],
  groq: ['GROQ_API_KEY'],
  cerebras: ['CEREBRAS_API_KEY'],
  xai: ['XAI_API_KEY'],
  typesafe: ['TYPESAFE_API_KEY'],
  radius: ['RADIUS_API_KEY'],
  openrouter: ['OPENROUTER_API_KEY'],
  'vercel-ai-gateway': ['AI_GATEWAY_API_KEY'],
  zai: ['ZAI_API_KEY'],
  'zai-coding-cn': ['ZAI_CODING_CN_API_KEY'],
  mistral: ['MISTRAL_API_KEY'],
  minimax: ['MINIMAX_API_KEY'],
  'minimax-cn': ['MINIMAX_CN_API_KEY'],
  moonshotai: ['MOONSHOT_API_KEY'],
  'moonshotai-cn': ['MOONSHOT_API_KEY'],
  huggingface: ['HF_TOKEN'],
  fireworks: ['FIREWORKS_API_KEY'],
  together: ['TOGETHER_API_KEY'],
  baseten: ['BASETEN_API_KEY'],
  opencode: ['OPENCODE_API_KEY'],
  'opencode-go': ['OPENCODE_API_KEY'],
  'kimi-coding': ['KIMI_API_KEY'],
  meta: ['META_API_KEY'],
  'cloudflare-workers-ai': ['CLOUDFLARE_API_KEY'],
  'cloudflare-ai-gateway': ['CLOUDFLARE_API_KEY'],
  xiaomi: ['XIAOMI_API_KEY'],
  'xiaomi-token-plan-cn': ['XIAOMI_TOKEN_PLAN_CN_API_KEY'],
  'xiaomi-token-plan-ams': ['XIAOMI_TOKEN_PLAN_AMS_API_KEY'],
  'xiaomi-token-plan-sgp': ['XIAOMI_TOKEN_PLAN_SGP_API_KEY'],
};

/** 这些是云凭证，模型配置里写成 $变量也不传。 */
const CLOUD_CREDENTIALS = new Set([
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'AWS_SECURITY_TOKEN',
  'AWS_BEARER_TOKEN_BEDROCK',
  'GOOGLE_APPLICATION_CREDENTIALS',
  'CLOUDSDK_AUTH_ACCESS_TOKEN',
]);

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
 * @param {string[]} argv
 * @param {string} flag
 * @returns {string}
 */
function flagValue(argv, flag) {
  for (let i = 0; i < argv.length; i++) {
    const item = argv[i];
    if (item === flag) return argv[i + 1] || '';
    if (typeof item === 'string' && item.startsWith(`${flag}=`)) return item.slice(flag.length + 1);
  }
  return '';
}

/**
 * @param {string} slug
 * @returns {string}
 */
function providerId(slug) {
  const text = String(slug ?? '').trim();
  const cut = text.indexOf('/');
  if (cut <= 0 || cut === text.length - 1) return '';
  return text.slice(0, cut);
}

/**
 * @param {NodeJS.ProcessEnv|Record<string, string|undefined|null>} env
 * @returns {string}
 */
function agentDir(env) {
  const configured = String(env?.PI_CODING_AGENT_DIR ?? '').trim();
  if (configured) return configured;
  return path.join(os.homedir(), '.pi', 'agent');
}

/**
 * @param {NodeJS.ProcessEnv|Record<string, string|undefined|null>} env
 * @returns {string}
 */
function defaultModelSlug(env) {
  try {
    const raw = fs.readFileSync(path.join(agentDir(env), 'settings.json'), 'utf8');
    const model = JSON.parse(raw)?.defaultModel;
    return typeof model === 'string' ? model.trim() : '';
  } catch {
    return '';
  }
}

/**
 * @param {string[]} argv
 * @param {NodeJS.ProcessEnv|Record<string, string|undefined|null>} env
 * @returns {string}
 */
export function currentModelSlug(argv = [], env = process.env) {
  const fromArgv = flagValue(argv, '--model') || flagValue(argv, '-m');
  if (fromArgv.trim()) return fromArgv.trim();
  const fromEnv = String(env?.PI_BOT_MODEL ?? '').trim();
  if (fromEnv) return fromEnv;
  return defaultModelSlug(env);
}

/**
 * @param {unknown} value
 * @returns {string[]}
 */
function configEnvNames(value) {
  if (typeof value !== 'string' || value.startsWith('!')) return [];
  const names = [];
  const re = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g;
  for (const match of value.matchAll(re)) names.push(match[1] || match[2]);
  return names;
}

/**
 * @param {Record<string, unknown>|undefined|null} provider
 * @returns {string[]}
 */
function namesFromProviderConfig(provider) {
  if (!provider || typeof provider !== 'object') return [];
  const names = configEnvNames(provider.apiKey);
  const headers = provider.headers;
  if (headers && typeof headers === 'object') {
    for (const value of Object.values(headers)) names.push(...configEnvNames(value));
  }
  return names;
}

/**
 * @param {string} provider
 * @param {NodeJS.ProcessEnv|Record<string, string|undefined|null>} env
 * @returns {string[]}
 */
function namesFromModelsJson(provider, env) {
  try {
    const raw = fs.readFileSync(path.join(agentDir(env), 'models.json'), 'utf8');
    const providers = JSON.parse(raw)?.providers;
    return namesFromProviderConfig(providers?.[provider]);
  } catch {
    return [];
  }
}

/**
 * @param {NodeJS.ProcessEnv|Record<string, string|undefined|null>} env
 * @param {string[]} argv
 * @returns {Record<string, string>}
 */
export function providerKeys(env = process.env, argv = []) {
  const provider = providerId(currentModelSlug(argv, env));
  if (!provider) return {};
  const names = new Set([
    ...(PROVIDER_ENV[provider] ?? []),
    ...namesFromModelsJson(provider, env),
  ]);
  /** @type {Record<string, string>} */
  const out = {};
  for (const name of names) {
    const upper = name.toUpperCase();
    if (CLOUD_CREDENTIALS.has(upper)) continue;
    const value = env?.[name];
    if (value == null || value === '') continue;
    out[name] = String(value);
  }
  return out;
}

/**
 * 扩展派子 agent 时先起 `node <入口>/index.js --mode json ...`。
 * 这一跳如果也被滤掉，runPiCli 所在的进程里就没有 provider key 可传。
 * 只认入口脚本，普通 bash / node 命令不走这里。
 *
 * @param {NodeJS.ProcessEnv|Record<string, string|undefined|null>} env
 * @param {string[]|undefined|null} args spawn 的完整 argv，第 0 项是可执行文件
 * @returns {Record<string, string>}
 */
export function providerKeysForEntry(env = process.env, args = []) {
  const argv = Array.isArray(args) ? args.slice(1).map((item) => String(item)) : [];
  const entry = argv.some((arg) => /(?:^|[\\/])index\.js$/.test(arg));
  if (!entry) return {};
  const hasPiFlag = argv.includes('--mode') || argv.includes('-p') || argv.includes('--print');
  if (!hasPiFlag) return {};
  if (!argv.some((arg) => PI_FLAGS.has(arg))) return {};
  return providerKeys(env, argv);
}
