/**
 * 动作目录（**派生层**，事实来源是 `capabilities.js`）。
 *
 * ## 这个文件为什么还留着
 *
 * 因为它是公开名字：`grant-gate.js`、`policy-hook.js`、`confirm.js`
 * 都在 import 它。改造的目标是"一个事实只写一处"，不是"改所有调用方" ——
 * 所以保留同名导出，内部改成从 `capabilities.js` 转发。
 *
 * 想加能力、改风险档、改谁能用：**去 `capabilities.js`**，不要在这里加东西。
 * 这里只允许出现纯转发的代码。
 */
import {
  ACTIONS, TOOLS, GATED_ACTIONS,
  actionInfo, riskOf, isIrreversible, needsTarget,
  actionForTool, actionsForTools, targetsForTool,
  auditCapabilities,
} from './capabilities.js';

export {
  ACTIONS, TOOLS, GATED_ACTIONS,
  actionInfo, riskOf, isIrreversible, needsTarget,
  actionForTool, actionsForTools, targetsForTool,
};

/**
 * 目录自检（兼容旧名字）。
 *
 * 真正的检查在 `capabilities.js` 的 `auditCapabilities`。
 * 这里保留原名是因为 `tests/action-catalog.mjs` 在用。
 */
export function auditCatalog({ hasTool = null } = {}) {
  return auditCapabilities({ hasTool });
}
