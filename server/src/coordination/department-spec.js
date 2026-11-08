/**
 * 部门规格准备：把「模板 / 直接给的成员」统一成一份可创建规格。
 *
 * ## 只做只读准备
 *
 * 展开模板、规范化名字、校验负责人、预检模型、检查同名冲突、保留能力字段。
 * **不创建 Bot、不建群** —— 副作用只在持久认领之后发生。
 *
 * ## 为什么要共用
 *
 * 模板路与正常路共用同一份成员处理：负责人规则、能力字段、模型校验
 * 只有一处实现，避免两条路分叉。
 */
import { departmentModelConflicts } from '../model-dispatch.js';
import { menuText, resolveMenu, matchMenuEntry } from '../model-menu.js';

/**
 * 只接受启用目录中可解析、且已注册成功的模型。
 *
 * 线路暂时不通**不阻止分配**（健康检查回答的是"此刻通不通"，
 * 分配回答的是"这个活该用哪个模型"），只带一句提醒。
 *
 * @returns {{ok:boolean, resolved?:string, warning?:string, suggestions?:string[]}}
 */
export function checkAssignableModel({ runner, slug, health, entries = null } = {}) {
  if (!slug) return { ok: true };
  const picked = entries ? resolveMenu(slug, health, entries) : resolveMenu(slug, health);
  if (!picked) {
    // 注入了菜单条目时只用注入内容判定，不读全局配置
    const match = entries ? { reason: 'unknown' } : matchMenuEntry(slug);
    if (match.reason === 'ambiguous') {
      return {
        ok: false,
        suggestions: ['名称对应多个模型，请选择完整标识：', ...match.candidates.slice(0, 10)],
      };
    }
    return {
      ok: false,
      suggestions: ['请从当前启用的模型组中选择：', ...menuText(health).split('\n')],
    };
  }
  const warning = picked.alive
    ? null
    : `${picked.entry.alias} 当前的线路实测不可用（${picked.slug}），已照常分配，` +
      '但运行可能失败 —— 建议检查该模型组的 key 与接口。';
  if (!runner.resolveModel(picked.slug)) {
    return { ok: false, suggestions: [`${picked.slug} 尚未注册成功，请检查模型组配置`] };
  }
  return { ok: true, resolved: picked.slug, warning };
}

const fail = (code, text, extra = {}) => ({ ok: false, code, text, ...extra });

/**
 * 把模板或直接给的成员整理成统一规格。
 *
 * @param {object} p
 * @param {object} p.store 应用 store（只读：模板、已有 Bot）
 * @param {string|null} [p.templateId] 模板 id 或名字；给了就照模板展开
 * @param {string} [p.name] 部门名（模板路可覆盖）
 * @param {string} [p.topic] 部门职责（模板路以模板为准）
 * @param {object[]|null} [p.members] 直接给的成员
 * @param {string|null} [p.lead] 负责人名字，必须是 members 里某一个
 * @param {Function} [p.checkAssignable] (slug) => checkAssignableModel 结果
 * @param {string|null} [p.modelLabel] 当前主控模型标识，用于冲突判断
 * @returns {{ok:true, spec:{name:string, topic:string, members:object[], lead:string|null, warnings:string[]}}
 *   | {ok:false, code:string, text:string}}
 */
export function prepareDepartmentSpec({
  store,
  templateId = null,
  name = '',
  topic = '',
  members = null,
  lead = null,
  checkAssignable = () => ({ ok: true }),
  modelLabel = null,
} = {}) {
  let base;
  if (templateId) {
    const tpl = store.templates().find((t) => t.id === templateId || t.name === templateId);
    if (!tpl) {
      const list = store.templates().map((t) => `${t.name}(${t.id})`).join('、') || '（还没有）';
      return fail('no_template', `没有这个模板。现有模板：${list}`);
    }
    base = {
      name: String(name || tpl.name).trim().slice(0, 60),
      topic: tpl.topic ?? '',
      members: Array.isArray(tpl.members) ? tpl.members : [],
      lead: tpl.lead ?? null,
    };
  } else {
    if (!Array.isArray(members) || members.length === 0) {
      return fail('no_members', '至少要有一个成员');
    }
    if (lead && !members.some((m) => m?.name === lead)) {
      return fail(
        'lead_not_in_members',
        'lead「' + lead + '」不在 members 里。members 有：' + members.map((m) => m.name).join('、'),
      );
    }
    base = {
      name: String(name ?? '').trim().slice(0, 60),
      topic: String(topic ?? '').trim(),
      members,
      lead: lead ?? null,
    };
  }
  if (!base.name) return fail('no_name', '部门要有名字');

  // 规范化：保留全部能力字段，只清名字空白
  const normalized = base.members
    .filter((m) => m && typeof m === 'object' && typeof m.name === 'string' && m.name.trim())
    .map((m) => ({ ...m, name: m.name.trim().slice(0, 40) }));
  if (!normalized.length) return fail('no_members', '成员名单是空的');

  // 模型预检：有一个不行就整体不动
  const bad = [];
  const warnings = [];
  const resolved = [];
  for (const m of normalized) {
    if (!m.model) {
      resolved.push({ ...m, model: null });
      continue;
    }
    const check = checkAssignable(m.model);
    if (!check.ok) {
      bad.push({ name: m.name, model: m.model, suggestions: check.suggestions ?? [] });
      continue;
    }
    if (check.warning) warnings.push(`${m.name}：${check.warning}`);
    resolved.push({ ...m, model: check.resolved });
  }
  if (bad.length) {
    return fail(
      'bad_model',
      '有成员选了不可用的模型，什么都没建：\n' +
        bad.map((b) => `  ${b.name} → ${b.model}；${b.suggestions.slice(0, 3).join('、')}`).join('\n'),
    );
  }

  // 同名/同模型冲突：保持既有判定，不另写一套
  const conflicts = departmentModelConflicts(resolved, store.listBots(), modelLabel);
  if (conflicts.length) {
    return fail('model_conflict', `成员配置存在冲突，什么都没建：\n${conflicts.join('\n')}`);
  }

  return {
    ok: true,
    spec: { name: base.name, topic: base.topic, members: resolved, lead: base.lead, warnings },
  };
}

/**
 * 构造只读规格准备器：把模型输入的原始规格翻成统一规格。
 *
 * 所有创建入口共用同一个准备器，模型可分配性检查由宿主注入，
 * 不额外调用模型、不写任何资源。
 *
 * @param {object} p
 * @param {object} p.store 应用 store（只读）
 * @param {object} p.runner PiRunner（提供 resolveModel / modelLabel）
 * @param {object} [p.health] 模型探活
 * @returns {(raw:object) => {ok:true, spec:object}|{ok:false, code:string, text:string}}
 */
export function makeSpecPreparer({ store, runner, health, entries = null } = {}) {
  return (raw = {}) => prepareDepartmentSpec({
    store,
    templateId: raw.templateId ?? null,
    name: raw.name ?? '',
    topic: raw.topic ?? '',
    members: raw.members ?? null,
    lead: raw.lead ?? null,
    checkAssignable: (slug) => checkAssignableModel({ runner, slug, health, entries }),
    modelLabel: runner.modelLabel?.() ?? null,
  });
}
