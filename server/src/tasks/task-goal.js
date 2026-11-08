/**
 * 目标与验收条件的**统一校验**（纯逻辑）。
 *
 * ## 为什么单独一个文件
 *
 * 审查 R05 实测到四个入口各判一套：
 *
 *   · `createTaskRun` 不带验收条件也成功；
 *   · `parseIntake` 和 `validateTaskRun` 接受 `verification: [null]`；
 *   · 改目标能写进非法验收条件；
 *   · 重复的验收 ID 也被接受。
 *
 * 结果是同一份数据从一个入口进去合法、从另一个入口进去非法，
 * 甚至能造出"改完就再也归约不动"的任务（目标变空串 → 之后连取消都失败）。
 *
 * 所以把目标校验收到这里，**创建 / 接单 / 加载 / 修改目标四个入口都走它**。
 * 本层只管结构合法性；文件格式等真正的验收留到批次 03。
 */
import {
  ALL_VERIFY_KINDS,
  REJECT,
  reject,
  ok,
} from './task-contract.js';

const MAX_REQUIREMENT = 4000;
const MAX_SCOPE = 2000;
const MAX_DELIVERABLE = 300;
const MAX_DESCRIPTION = 500;
const MAX_ID = 80;

const isText = (v) => typeof v === 'string' && v.trim().length > 0;

/**
 * 校验并规范化验收条件数组。
 *
 * 规则：
 *   · 必须是数组（可以是空数组 —— "只问方案"的任务没有验收条件也合法）；
 *   · 每条必须是对象，kind 属于已知集合，description 非空；
 *   · id 必须唯一、合法；缺省时按位置生成；
 *   · `null` / 非对象条目一律拒绝（不能"跳过坏条目继续"）。
 *
 * @param {unknown} raw
 * @param {{required?: boolean}} [opts] required=true 时至少一条
 * @returns {{ok:true, verification:object[]}|{ok:false, code:string, field:string, text:string}}
 */
export function validateVerification(raw, { required = false } = {}) {
  if (raw === undefined || raw === null) {
    if (required) {
      return reject(REJECT.missingField, 'goal.verification', '要接单必须给出至少一条验收条件');
    }
    return ok({ verification: [] });
  }
  if (!Array.isArray(raw)) {
    return reject(REJECT.badField, 'goal.verification', '验收条件必须是数组');
  }
  if (required && raw.length === 0) {
    return reject(REJECT.missingField, 'goal.verification', '要接单必须给出至少一条验收条件');
  }

  const out = [];
  const seen = new Set();
  for (const [index, item] of raw.entries()) {
    const field = `goal.verification[${index}]`;
    // ★ null / 字符串 / 数字都拒绝。原来直接 `item?.kind` 会把 null 变成
    //   一条 kind 为空的记录混进数组，加载时才发现非法。
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      return reject(REJECT.badField, field, '每条验收条件必须是对象');
    }
    const kind = String(item.kind ?? '').trim();
    if (!ALL_VERIFY_KINDS.includes(kind)) {
      return reject(REJECT.badField, `${field}.kind`, `未知验收种类：${kind || '(空)'}`);
    }
    const description = String(item.description ?? '').trim();
    if (!description) {
      return reject(REJECT.missingField, `${field}.description`, '验收条件必须说清"怎么算做完"');
    }
    if (description.length > MAX_DESCRIPTION) {
      return reject(REJECT.badField, `${field}.description`, `描述不能超过 ${MAX_DESCRIPTION} 字`);
    }
    const id = String(item.id ?? `vc${index + 1}`).trim();
    if (!isText(id) || id.length > MAX_ID) {
      return reject(REJECT.badField, `${field}.id`, '验收条件 ID 不合法');
    }
    if (seen.has(id)) {
      return reject(REJECT.badField, `${field}.id`, `验收条件 ID 重复：${id}`);
    }
    seen.add(id);
    out.push({
      id,
      kind,
      description,
      spec: item.spec && typeof item.spec === 'object' && !Array.isArray(item.spec) ? { ...item.spec } : {},
      required: item.required !== false,
    });
  }
  return ok({ verification: out });
}

/**
 * 校验并规范化目标。
 *
 * 四个入口（创建 / 接单 / 加载 / 改目标）都调这个，不允许各判一套。
 *
 * @param {unknown} raw { requirement, scope, deliverables, verification }
 * @param {{requireVerification?: boolean}} [opts]
 * @returns {{ok:true, goal:object}|{ok:false, code:string, field:string, text:string}}
 */
export function validateGoal(raw, { requireVerification = false } = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return reject(REJECT.missingField, 'goal', '没有目标就不算任务');
  }
  const requirement = String(raw.requirement ?? '').trim();
  if (!requirement) {
    // ★ 这条也挡住了 R05 的"改成空串"：改目标时同样走这里。
    return reject(REJECT.missingField, 'goal.requirement', '目标不能为空');
  }
  if (requirement.length > MAX_REQUIREMENT) {
    return reject(REJECT.badField, 'goal.requirement', `目标不能超过 ${MAX_REQUIREMENT} 字`);
  }
  const scope = String(raw.scope ?? '').trim();
  if (scope.length > MAX_SCOPE) {
    return reject(REJECT.badField, 'goal.scope', `范围不能超过 ${MAX_SCOPE} 字`);
  }
  const rawDeliverables = raw.deliverables === undefined || raw.deliverables === null ? [] : raw.deliverables;
  if (!Array.isArray(rawDeliverables)) {
    return reject(REJECT.badField, 'goal.deliverables', '交付项必须是数组');
  }
  const deliverables = [];
  for (const [index, item] of rawDeliverables.entries()) {
    if (typeof item !== 'string') {
      return reject(REJECT.badField, `goal.deliverables[${index}]`, '交付项必须是字符串');
    }
    const clean = item.trim();
    if (!clean) continue;
    if (clean.length > MAX_DELIVERABLE) {
      return reject(REJECT.badField, `goal.deliverables[${index}]`, `交付项不能超过 ${MAX_DELIVERABLE} 字`);
    }
    deliverables.push(clean);
  }
  const verification = validateVerification(raw.verification, { required: requireVerification });
  if (!verification.ok) return verification;

  return ok({
    goal: { requirement, scope, deliverables, verification: verification.verification },
  });
}

/**
 * 目标是否被这次修改真的改动过（用于"没变就别升版本"）。
 */
export function goalChanged(before, after) {
  if (!before || !after) return true;
  if (before.requirement !== after.requirement) return true;
  if (before.scope !== after.scope) return true;
  if ((before.deliverables ?? []).length !== (after.deliverables ?? []).length) return true;
  for (let i = 0; i < (before.deliverables ?? []).length; i++) {
    if (before.deliverables[i] !== after.deliverables[i]) return true;
  }
  const a = before.verification ?? [];
  const b = after.verification ?? [];
  if (a.length !== b.length) return true;
  for (let i = 0; i < a.length; i++) {
    if (a[i].id !== b[i].id) return true;
    if (a[i].kind !== b[i].kind) return true;
    if (a[i].description !== b[i].description) return true;
    if (Boolean(a[i].required) !== Boolean(b[i].required)) return true;
    // ★ F05：spec 的变化也算目标变化 —— 把"两份"改成"三份"是改要求，
    //   原来只比 id/kind/description，spec 改了会被判成"没有实际变化"。
    if (!deepEqual(a[i].spec, b[i].spec)) return true;
  }
  return false;
}

/**
 * 结构深比较（对象键顺序无关）。
 *
 * 只用 JSON.stringify 比会因键顺序不同产生假变化；
 * 只比一层又会漏掉嵌套的 spec 差异。
 */
function deepEqual(a, b) {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    if (a.length !== b.length) return false;
    return a.every((item, i) => deepEqual(item, b[i]));
  }
  const ka = Object.keys(a).sort();
  const kb = Object.keys(b).sort();
  if (ka.length !== kb.length) return false;
  if (ka.some((k, i) => k !== kb[i])) return false;
  return ka.every((k) => deepEqual(a[k], b[k]));
}