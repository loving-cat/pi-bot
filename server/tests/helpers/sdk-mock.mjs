/**
 * SDK 测试用的模型 / 会话桩（`sdk-lifecycle.mjs` 用）。
 *
 * 为什么单独一个文件：生命周期相关的用例都需要"能跑一轮、但完全不碰真模型"的
 * runtime，复制第三份 90 行的桩只会让三个文件里的桩慢慢长得不一样。
 * （`sdk-runtime.mjs` / `sdk-errors.mjs` 里的桩是先写的，暂不动它们。）
 */
import fs from 'node:fs';

/** 最小可用的模型运行时：只有一个 mock/fast-1 */
export function makeMockModelRuntimeFactory() {
  const providers = new Map([
    ['mock', { models: [{ id: 'fast-1', contextWindow: 128000, reasoning: false }] }],
  ]);
  const listModels = () => {
    const out = [];
    for (const [provider, cfg] of providers.entries()) {
      for (const m of cfg?.models ?? []) {
        if (!m?.id) continue;
        out.push({
          provider,
          id: m.id,
          contextWindow: m.contextWindow ?? 128000,
          reasoning: Boolean(m.reasoning),
        });
      }
    }
    return out;
  };
  return async () => ({
    registerProvider(id, cfg) {
      providers.set(id, { ...(cfg ?? {}), models: cfg?.models ?? [] });
    },
    unregisterProvider(id) {
      providers.delete(id);
    },
    getModels: listModels,
    getModel(provider, id) {
      return listModels().find((m) => m.provider === provider && m.id === id) ?? null;
    },
    async getAvailable() {
      return listModels();
    },
    async completeSimple() {
      return { content: [{ type: 'text', text: '{}' }] };
    },
  });
}

/**
 * 会话桩：`state.behavior` 控制 `prompt` 的行为。
 *   reply（默认）/ throw / hang（250ms，用来做超时）
 */
export function makeMockSessionApi(state, agentDir) {
  fs.mkdirSync(agentDir, { recursive: true });
  class MockResourceLoader {
    constructor(opts) {
      this.opts = opts;
    }
    async reload() {}
  }
  return {
    DefaultResourceLoader: MockResourceLoader,
    SessionManager: { inMemory: () => ({}), open: () => ({}), create: () => ({}) },
    createBashTool: () => ({
      name: 'bash',
      description: 'mock bash',
      parameters: {},
      async execute() {
        return { content: [] };
      },
    }),
    createPowerShellTool: () => ({
      name: 'powershell',
      description: 'mock powershell',
      parameters: {},
      async execute() {
        return { content: [] };
      },
    }),
    getAgentDir: () => agentDir,
    async createAgentSession(options = {}) {
      const listeners = new Set();
      const messages = [];
      const emit = (ev) => {
        for (const fn of [...listeners]) {
          try {
            fn(ev);
          } catch {
            // 桩里的监听器失败不该影响主流程
          }
        }
      };
      const session = {
        model: options.model ?? { provider: 'mock', id: 'fast-1', contextWindow: 128000 },
        messages,
        state: { messages },
        subscribe(fn) {
          listeners.add(fn);
          return () => listeners.delete(fn);
        },
        dispose() {
          listeners.clear();
        },
        async abort() {},
        async followUp(text) {
          return this.prompt(text);
        },
        async steer(text) {
          return this.prompt(text);
        },
        getContextUsage() {
          return { tokens: 1, contextWindow: 128000, percent: 0.1 };
        },
        async prompt() {
          if (state.behavior === 'throw') throw new Error('模型炸了：mock');
          if (state.behavior === 'hang') await new Promise((resolve) => setTimeout(resolve, 250));
          const assistantMsg = {
            role: 'assistant',
            content: [{ type: 'text', text: '好的' }],
            usage: { input: 1, output: 1, totalTokens: 2 },
          };
          messages.push(assistantMsg);
          emit({ type: 'message_start', message: { role: 'assistant' } });
          emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: '好的' } });
          emit({ type: 'message_end', message: assistantMsg });
          emit({ type: 'turn_end' });
          emit({ type: 'agent_end' });
        },
      };
      return { session };
    },
  };
}
