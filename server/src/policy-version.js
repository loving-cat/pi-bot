/**
 * 部门规矩的**版本标识**与变更影响判定（纯函数）。
 *
 * 为什么需要"版本"这件事：
 *   一条派活指令是**按当时的规矩**发出去的 —— 当时是否允许动手、哪些命令被禁、
 *   要不要附证据。用户中途改了规矩，正在跑的活该按哪一套走？
 *
 *   两种做法都错：
 *     · 立刻中断在飞的活 —— 留下半成品，而且用户往往只是想"以后都这样"；
 *     · 完全不管 —— 那条活在旧规矩下跑完，用户已经收紧了却还在动手，无法解释。
 *
 *   所以：**给每条派活记下它依据的版本号，规矩变了只通知受影响的活，不中断。**
 *   这和"部门预算"是两件事：预算管跑多久，规矩管能不能拆家。
 */

/**
 * 版本算法的修订号。
 *
 * 改了 `policyDigest()` 的算法才动它 —— 作用相当于"算法变了，历史版本号不再可比"。
 * 不要因为加了新的规矩字段就改这个号（字段本身已经进摘要）。
 */
export const POLICY_REVISION = 'policy-v1';

/** 影响"能不能动手"的字段。其余字段（含未来新增的展示类配置）不进摘要。 */
const BEARING_KEYS = ['dangerous', 'denyCommands', 'allowCommands'];

/**
 * 稳定字符串化：对象的键排序后序列化。
 *
 * `JSON.stringify` 直接用会有坑 —— 同一份规则，键顺序不同就得到不同版本号，
 * 于是"什么都没改"也会被当成变更。这层只处理本模块会遇到的普通结构
 * （数组 / 对象 / 字符串 / 数字 / 布尔 / null），不处理 Date、Map、循环引用。
 */
function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
}

/**
 * 一条规矩里**真正影响"能不能动手"**的那部分。
 *
 * 只挑这三个字段，不是偷懒：`requireProof` 和以后可能加的展示类配置
 * 不改变"这条活当初有没有被授权"，把它们算进版本会让改一句提示文案
 * 就触发全量变更通知 —— 通知多了等于没有通知。
 */
export function policyBearing(policy = {}) {
  const out = {};
  for (const key of BEARING_KEYS) {
    const value = policy?.[key];
    if (key === 'dangerous') out[key] = typeof value === 'string' ? value : 'allow';
    else out[key] = Array.isArray(value) ? [...value] : [];
  }
  return out;
}

/**
 * 规矩的版本号。
 *
 * 同一个版本号 = 两条活依据的是同一套授权 —— 这正是"变更要不要通知"
 * 的判定依据。算法固定（修订号 + 稳定序列化），不依赖时间或随机数。
 */
export function policyVersion(policy = {}) {
  return `${POLICY_REVISION}:${stableStringify(policyBearing(policy))}`;
}

/**
 * 比较两个版本，说清楚变了什么。
 *
 * 返回的字段名直接用于给用户/模型看的说明，所以用规矩里的原名（英文键），
 * 由调用方决定怎么措辞 —— 这里不拼中文句子，免得把文案硬编码进纯逻辑层。
 *
 * @returns {{version: string, from: string, to: string, changed: string[], isChange: boolean}}
 */
export function policyChange(prev = {}, next = {}) {
  const before = policyBearing(prev);
  const after = policyBearing(next);
  const changed = BEARING_KEYS.filter(
    (key) => stableStringify(before[key]) !== stableStringify(after[key]),
  );
  const from = policyVersion(prev);
  const to = policyVersion(next);
  return { version: to, from, to, changed, isChange: from !== to };
}

/**
 * 把变更字段的名字说成人话。
 *
 * 只在这一层映射、不在调用方各拼一遍：拼到哪儿就漏到哪儿，
 * 新增字段时更难保持一致。未知键直接原文返回，不丢信息。
 */
const FIELD_LABELS = {
  dangerous: '危险动作',
  denyCommands: '禁止命令',
  allowCommands: '允许命令',
};

/** @returns {string} 例：「危险动作、禁止命令」 */
export function describePolicyChange(changed = []) {
  const names = changed.map((key) => FIELD_LABELS[key] ?? String(key));
  return names.length ? names.join('、') : '授权相关设置';
}

/**
 * 规矩变了之后，**哪些活该收到通知**。
 *
 * 判定刻意保守：只通知"受理时用的规矩，现在已经不是那一套了"的活。
 * 不做更细的判定（比如"新禁的命令它恰好没用到，那就不用通知"）——
 * 这种推断要靠模型理解活的意图，在本层做不了，猜错会漏通知。
 *
 * @param {Array<{id:string, policyVersion?:string|null, status?:string}>} assignments
 * @param {string} currentVersion
 * @returns {{notify: Array, silent: Array}} notify 要通知，silent 不用打扰
 */
export function planPolicyChangeNotices(assignments = [], currentVersion = '') {
  const notify = [];
  const silent = [];
  for (const item of assignments) {
    if (!item) continue;
    // 没记版本的（老数据、或规矩在记版本之前就派出去的）不猜：不动它。
    // 宁可少通知，也不要对着一条老活编一句"你的规矩变了"。
    if (!item.policyVersion) {
      silent.push(item);
      continue;
    }
    if (item.policyVersion === currentVersion) {
      silent.push(item);
      continue;
    }
    notify.push(item);
  }
  return { notify, silent };
}
