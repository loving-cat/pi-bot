/**
 * 动作目录：一个动作有多危险、哪些工具会产生它、怎么从入参认出目标。
 *
 * ## 为什么要有这个文件
 *
 * 「这个动作有多危险」这件事原来被抄成了三份：
 *   · `grants.js` 的 `RISK` 枚举（只定义档位，不定义动作用哪档）
 *   · `grant-gate.js` 的 `TOOL_ACTIONS`（工具名 → 动作 + 风险档）
 *   · `confirm.js` 的 `IRREVERSIBLE_ACTIONS`（哪些动作不可撤销）
 *
 * 三份各写各的，于是实测到了这些：审计里的 `risk` 恒为 `null`
 * （`TOOL_ACTIONS` 按**工具名**建表，`check()` 却拿**动作名**去查）；
 * 新增一个动作要改三处，漏一处就静默不一致。
 *
 * 收成一份之后，加一个动作只在这里加一行，判定、审计、确认三边自动对齐。
 *
 * ## 三层结构，各管一件事
 *
 *   1. `ACTIONS`   动作本身：风险档 + 可撤销性 + **要不要目标**（fail-closed 用）
 *   2. `TOOLS`     哪些工具产生它：工具名 → 动作（这张表就是网关的覆盖面）
 *   3. `TARGETS`   怎么从入参认出目标：规则表，不写函数，方便一眼看完
 *
 * ## 「要不要目标」是用来 fail-closed 的
 *
 * 窄范围授权（`resources` 非空）本来是想说"只许动 A、不许动 B"。
 * 但目标推不出来时（`bash` 的路径埋在命令里、`ego_browser` 的 URL 埋在脚本里），
 * 原来的实现是**当成没有目标**→ 放行 —— 于是范围约束形同虚设。
 *
 * 规格 §6.1 要求资源范围是真的边界，不是装饰。所以：
 * 标注了 `needsTarget` 的动作，只要授权是窄范围的、而这次又推不出目标，
 * 就直接拒绝（`resource_not_covered`），并在拒绝文案里说清为什么。
 * 没标 `needsTarget` 的（读文件这种）不受影响。
 *
 * 本文件是**纯数据**，没有 IO，也没有对 store 的依赖 —— 要能被任何一层安全引用。
 */
import { ACTION, RISK } from './grants.js';

/**
 * 动作目录。
 *
 * - `risk`：给审计和界面看的危险度（`RISK` 四档）
 * - `irreversible`：做错了能不能撤销。**拿不准就写 true** ——
 *   误判只是多点一次确认，漏判是不可挽回的。
 * - `needsTarget`：这个动作的授权能不能只靠"动作名"就判定安全。
 *   true 表示"必须能认出目标，否则窄范围授权一律拒绝"。
 *   · 文件/仓库操作：入参里有路径，能认 → true
 *   · 跑命令 / 浏览器脚本：目标埋在字符串里，认不出来 → 也是 true
 *     （认不出来就拒绝，而不是"认不出 = 不限"，这正是要修的洞）
 *   · 对外发送、改防线：目标不是一个可枚举的资源 → false
 */
export const ACTIONS = Object.freeze({
  [ACTION.fileRead]: { risk: RISK.low, irreversible: false, needsTarget: true },
  [ACTION.fileWrite]: { risk: RISK.low, irreversible: false, needsTarget: true },
  // 删除不可撤销：文件没有回收站可用，脚本删掉的目录也回不来
  [ACTION.fileDelete]: { risk: RISK.medium, irreversible: true, needsTarget: true },
  [ACTION.cmdExec]: { risk: RISK.medium, irreversible: false, needsTarget: true },
  [ACTION.cmdBackground]: { risk: RISK.medium, irreversible: false, needsTarget: true },
  [ACTION.gitRead]: { risk: RISK.low, irreversible: false, needsTarget: true },
  [ACTION.gitCommit]: { risk: RISK.medium, irreversible: false, needsTarget: true },
  // push 出了本机就收不回来
  [ACTION.gitPush]: { risk: RISK.high, irreversible: true, needsTarget: true },
  [ACTION.gitDestructive]: { risk: RISK.critical, irreversible: true, needsTarget: true },
  // 观察只读，但看得到整个屏幕 —— 风险是隐私面，不是破坏面
  [ACTION.desktopObserve]: { risk: RISK.medium, irreversible: false, needsTarget: false },
  // 输入等于把当前登录身份交出去
  [ACTION.desktopInput]: { risk: RISK.critical, irreversible: true, needsTarget: false },
  [ACTION.netFetch]: { risk: RISK.medium, irreversible: false, needsTarget: true },
  // 对外发送与 netFetch 差一个数量级：发出去的东西收不回来
  [ACTION.netSend]: { risk: RISK.high, irreversible: true, needsTarget: false },
  [ACTION.secretUse]: { risk: RISK.high, irreversible: true, needsTarget: false },
  // 改的是防线本身
  [ACTION.policyChange]: { risk: RISK.high, irreversible: true, needsTarget: false },
  [ACTION.mcpAdd]: { risk: RISK.critical, irreversible: true, needsTarget: false },
});

/**
 * 「目标」的认法。
 *
 * 写成规则表而不是函数：一眼能看完有哪些工具会带目标、从哪个字段读，
 * 新增工具时照着加一行即可。值按顺序尝试，第一个非空的就是目标。
 *
 * `kind` 是 `grants.js` 里 `normalizeResource` 认得的种类。
 */
const TARGET_RULES = Object.freeze([
  // 文件类：入参里就是路径
  { tools: ['write', 'edit', 'read'], fields: ['path', 'file_path', 'filePath'], kind: 'path' },
  { tools: ['send_image'], fields: ['path'], kind: 'path' },
  { tools: ['extract_file'], fields: ['path', 'file_path'], kind: 'path' },
  // Git：仓库目录
  {
    tools: ['git_status', 'git_diff', 'git_log', 'git_show', 'git_branches', 'git_add', 'git_commit', 'git_push'],
    fields: ['repo'],
    kind: 'path',
  },
  // 抓网页：主机名就够判（同主机不同路径的风险差别不在这里判）
  { tools: ['web_fetch'], fields: ['url'], kind: 'host' },
  { tools: ['query_site'], fields: ['site', 'name'], kind: 'host' },
]);

/**
 * 由哪些工具产生哪个动作。**这张表就是网关的覆盖面本身**：
 * 不在表里的工具不经过授权判定（它要么纯读、要么走自己的专用校验）。
 *
 * ★ 新增一个能产生副作用的工具就必须在这里登记。漏登记 = 网关看不见的执行入口。
 */
export const TOOLS = Object.freeze({
  bash: ACTION.cmdExec,
  powershell: ACTION.cmdExec,
  run_background: ACTION.cmdBackground,
  write_stdin: ACTION.cmdBackground,
  kill_shell: ACTION.cmdBackground,
  write: ACTION.fileWrite,
  edit: ACTION.fileWrite,
  ego_browser: ACTION.netFetch,
  web_fetch: ACTION.netFetch,
  web_search: ACTION.netFetch,
  send_image: ACTION.netSend,
  message_bot: ACTION.netSend,
  reply_bot: ACTION.netSend,
  announce: ACTION.netSend,
  dispatch_to_department: ACTION.netSend,
  add_mcp_server: ACTION.mcpAdd,
  git_status: ACTION.gitRead,
  git_diff: ACTION.gitRead,
  git_log: ACTION.gitRead,
  git_show: ACTION.gitRead,
  git_branches: ACTION.gitRead,
  git_add: ACTION.gitCommit,
  git_commit: ACTION.gitCommit,
  git_push: ACTION.gitPush,
  desktop_observe: ACTION.desktopObserve,
  desktop_screenshot: ACTION.desktopObserve,
  stage_site: ACTION.fileWrite,
  commit_site: ACTION.netSend,
  discard_site: ACTION.fileDelete,
});

/** 这个动作的目录条目（没登记过就返回 null，调用方据此决定是警告还是放行）。 */
export function actionInfo(action) {
  const info = ACTIONS[String(action ?? '')];
  return info ? { action: String(action), ...info } : null;
}

/** 这个动作有多危险（审计/界面用）。 */
export function riskOf(action) {
  return ACTIONS[String(action ?? '')]?.risk ?? RISK.medium;
}

/** 做错了能不能撤销（确认框架用）。没登记过按"不可撤销"算 —— 保守方向。 */
export function isIrreversible(action) {
  const info = ACTIONS[String(action ?? '')];
  return info ? info.irreversible === true : true;
}

/** 窄范围授权要不要先认出目标。没登记过按"要"算 —— 保守方向。 */
export function needsTarget(action) {
  const info = ACTIONS[String(action ?? '')];
  return info ? info.needsTarget === true : true;
}

/** 工具 → 动作。没登记的工具返回 null（= 网关不判）。 */
export function actionForTool(toolName) {
  const action = TOOLS[String(toolName ?? '')];
  return action ? { action, risk: riskOf(action) } : null;
}

/**
 * 从工具入参里认出目标资源。
 *
 * **只认确定能认的**：读字段名，不解析命令字符串、不解析脚本内容。
 * 认不出来就返回空数组 —— 至于"认不出来时该放行还是拒绝"，由调用方按
 * `needsTarget()` 决定（网关那边对窄范围授权是拒绝）。
 *
 * @returns {Array<{kind:string, ref:string}>}
 */
export function targetsForTool(toolName, input = {}) {
  const names = Object.freeze([String(toolName ?? '')]);
  const pick = (fields) => {
    for (const f of fields) {
      const v = input?.[f];
      if (typeof v === 'string' && v.trim()) return v.trim();
    }
    return '';
  };
  for (const rule of TARGET_RULES) {
    if (!rule.tools.includes(names[0])) continue;
    const raw = pick(rule.fields);
    if (!raw) continue;
    if (rule.kind === 'host') {
      try {
        return [{ kind: 'host', ref: new URL(raw).hostname }];
      } catch {
        // 不是完整 URL：可能是站点名（query_site 的入参就是这样），原样当主机名
        return [{ kind: 'host', ref: raw }];
      }
    }
    return [{ kind: rule.kind, ref: raw }];
  }
  return [];
}

/**
 * 「眼不经过网关、但入参里有目标」的只读工具。
 *
 * 它们现在不走授权判定（读文件、抓站点是只读的），所以 `TOOLS` 里没它们。
 * 但它们的入参里确实有路径/主机，留着目标认法有两个好处：
 *   · 以后要把它们接上网关时不用重新找字段名；
 *   · 自检时能把“拼错工具名”和“故意不判”区分开（见 `auditCatalog`）。
 */
export const GATE_FREE_TOOLS = Object.freeze([
  'read', 'ls', 'grep', 'find', 'extract_file', 'query_site', 'list_sites',
]);

/**
 * 目录自检：找“表与表对不上”的漂移。
 *
 * 只查**确定是错**的东西，不查“做不到”：
 *   · 工具指向的动作不在目录里 —— 说明动作名写错或忘了登记
 *   · 目标规则里写的工具不在 TOOLS 里 —— 说明工具名拼错（真实踩过：
 *     `egp_browser` 拼错成这个样子，那条分支从来没生效过，也没人发现）
 *
 * “动作需要目标但没有认法”（如 bash 的路径埋在命令里）**不算错**：
 * 那是已知限制，网关对窄范围授权会 fail-closed 拒掉。
 *
 * @returns {string[]} 人话描述的问题列表，空 = 干净
 */
export function auditCatalog() {
  const problems = [];
  for (const [tool, action] of Object.entries(TOOLS)) {
    if (!ACTIONS[action]) problems.push(`工具 ${tool} 指向未登记的动作 ${action}`);
  }
  for (const rule of TARGET_RULES) {
    for (const tool of rule.tools) {
      if (TOOLS[tool] || GATE_FREE_TOOLS.includes(tool)) continue;
      problems.push(`目标规则里的 ${tool} 既不在工具表也不在免检名单里（名字拼错？这条规则永远不会生效）`);
    }
  }
  return problems;
}
