/**
 * 执行模式（规格 §8）的**运行时归属**：这个会话现在实际处于哪种模式。
 *
 * ## 为什么需要这个文件
 *
 * `grants.js` 里有完整的三档模式（`host` / `project` / `isolated`）：
 * 授权记录带 `mode` 字段、`deriveGrant` 会拒绝"子授权模式比父授权宽"、
 * `grantGate.check()` 支持按 `mode` 过滤候选授权。
 *
 * 但**没有任何调用方传它**。实测：`grep -rn "gate.check({" src/` 只有
 * `policy-hook.js:173` 一处，那一处不传 `mode`。于是：
 *
 *   · 一条 `mode: 'isolated'` 的授权，在 `host` 会话里照样能用；
 *   · 一条 `mode: 'host'` 的授权，在 `isolated` 会话里也能用（方向错得相反，但一样错）。
 *
 * 结果就是规格 §8 整节 —— 三档模式、不能自动降级、明示真实能力 ——
 * 在运行时**一条都没生效**。
 *
 * ## 这个文件只回答一个问题：现在是什么模式
 *
 * 判定放在这里、不放在 `policy-hook` 里，是因为它是**纯逻辑**（能单测），
 * 而且以后可能还有别的调用方（比如诊断接口要显示"当前模式"）。
 *
 * ## 三档怎么判（保守方向：**能证明是 host 才算 host**）
 *
 * | 模式 | 判据 | 依据 |
 * |---|---|---|
 * | `isolated` | 这个会话的命令工具已经被换成**沙箱版** | `sandboxed-shell.js` 只在挂了 MCP 的 bot 上替换；换掉了就是真在沙箱里跑 |
 * | `project` | 其余情况（默认） | 规格 §8.2：严格范围任务优先用受限适配器；这是**默认**档 |
 * | `host` | 只有主 Bot，且它的命令工具**没有**被沙箱化 | 规格 §8.1：主 Bot 可信宿主模式；§5.3：普通桌面输入默认只给主 Bot |
 *
 * ★ 为什么默认是 `project` 而不是 `host`：
 *
 *   规格 §8.2 明确「严格范围任务不可直接获得任意宿主 shell」。
 *   默认给 host 等于把"没配置"当成"全机信任"——那是放开方向。
 *   而且 `migration-grants.js` 给非主 Bot 发的就是 `project`，
 *   两边一致才不会出现"授权是 project、运行时按 host 判"这种错配。
 *
 * ★ 为什么主 Bot 挂 MCP 之后不算 host：
 *
 *   它那一刻的命令确实跑在沙箱里（`sandboxed-shell.js` 换掉了 bash/powershell）。
 *   这时它的实际能力更接近 `project`。判成 host 会让一条 host 授权
 *   在"其实被沙箱限制着"的会话里通过 —— 那是**放宽**，不是收紧。
 *
 * ## 不做的事
 *
 *   · 不读环境变量里的"我希望是什么模式"：模式是**实际能力**的描述，
 *     不是偏好。用户想要更宽就改授权（那是另一次交互），不是改一个开关。
 *   · 不做自动降级：规格 §8 原话「不能自动降级」。这里只做**如实描述**。
 */
import { MODE } from './grants.js';

/** 沙箱化的命令工具名（与 `sandboxed-shell.js` 替换的集合一致）。 */
const SHELL_TOOL_NAMES = Object.freeze(['bash', 'powershell']);

/**
 * 这个会话实际处于哪种执行模式。
 *
 * @param {object} p
 * @param {object} p.bot 当前 bot（要看 `role`）
 * @param {string[]} [p.sandboxedToolNames] 已被换成沙箱版实现的工具名
 *   （`session-factory` 在建会话时算出来的那份；不给就当没有沙箱化）
 * @returns {'isolated'|'project'|'host'}
 */
export function executionModeOf({ bot = null, sandboxedToolNames = [] } = {}) {
  const sandboxed = new Set(
    (Array.isArray(sandboxedToolNames) ? sandboxedToolNames : []).filter(Boolean),
  );
  // 命令工具被沙箱化 = 实际在隔离里跑
  if (SHELL_TOOL_NAMES.some((n) => sandboxed.has(n))) return MODE.isolated;
  // 只有主 Bot 才可能拿到可信宿主模式（规格 §5.3 / §8.1）
  if (bot?.role === 'main') return MODE.host;
  return MODE.project;
}

/**
 * 一句话解释这个模式意味着什么（给诊断/审计用，不含实现细节）。
 *
 * 写它是因为"模式不对"的排查成本很高：用户看到"被拒绝"，
 * 而真正的原因是"你手上的授权是 project，当前会话判成了 host"。
 */
export function describeExecutionMode(mode) {
  switch (mode) {
    case MODE.host:
      return '可信宿主模式：在用户当前登录身份下工作，危险动作仍要确认';
    case MODE.isolated:
      return '隔离执行模式：命令跑在沙箱里';
    case MODE.project:
      return '项目受控模式：文件/命令/Git 走受限适配器';
    default:
      return `未知执行模式：${mode}`;
  }
}
