/**
 * 用户自定义覆盖层（纯逻辑，无 IO、无时钟）—— 规格 §13.1 四层配置的第②层。
 *
 * ## 四层是什么，为什么这一层必须单独存在
 *
 * 规格 §13.1 把配置拆成四层，各管一件事：
 *
 * | 层 | 是什么 | 谁写 |
 * |---|---|---|
 * | ① 版本化角色默认值 | 模板（`tpl_*`）：职责、人设、模型、技能 | 模板作者 |
 * | ② **用户自定义覆盖** | 用户改了某个 bot 的哪几项 | 用户（本文件） |
 * | ③ 运行期授权 | `grants`：谁现在能动什么 | 权限服务 |
 * | ④ 执行记录 | `grantAudit` / taskruns | 系统 |
 *
 * 把①和②分开的理由很实际：**模板会升级**。如果用户改的东西直接写进
 * bot 记录，模板一升级就被覆盖，用户改一百遍也没用 —— 而"改了又变回去"
 * 比"不能改"更让人恼火。
 *
 * ## 三条不可放宽的规则（规格 §13.1 原话）
 *
 *   1. 「保留用户修改」—— 模板升级不许碰用户改过的字段
 *   2. 「冲突需明示」——  模板改了同一个字段 → **列出来让用户选**，不静默取一方
 *   3. 「覆盖值不得突破有效授权上限」—— 覆盖不是扩权入口
 *
 * 第 3 条最容易破：覆盖看起来只是"改个人设"，但如果覆盖能改 `mcpServers`、
 * 技能里的 `tools`、或者 bot 的 `role`，它就变成了权限提升通道。所以
 * 这份文件定义一张**白名单**：只有这些字段允许被覆盖，其余一律拒绝。
 *
 * ## 不做的事
 *
 * - 不存授权。覆盖里出现 grant 相关字段 → 直接拒（那是第③层的事）。
 * - 不做合并的最终决定。冲突怎么办由 `resolve()` 给出**三种可能**，
 *   由调用方（界面/用户）选。
 */

/** 允许被用户覆盖的字段。**白名单，不是黑名单** —— 新字段默认不可覆盖。 */
export const OVERRIDABLE_FIELDS = Object.freeze([
  'persona',      // 人设：最常被用户改的一项
  'tagline',      // 一句话简介
  'emoji',        // 形象
  'model',        // 用哪个模型（用户自己配的模型组）
  'thinking',     // 思考强度
  'skills',       // 技能清单（提示词层面，不是权限）
]);

/**
 * 明确**不许**覆盖的字段。
 *
 * 它们要么属于第③层（授权），要么能间接扩权：
 *   · `role` / `departmentIds` —— 改角色等于改"能拿哪些工具"
 *   · `mcpServers` —— 挂 MCP = 起子进程 = 新执行入口
 *   · `tools` / `allowedTools` —— 直接改能力边界
 *   · `grants` / `policy*` —— 那是授权层，不允许从这里进来
 */
export const FORBIDDEN_FIELDS = Object.freeze([
  'role', 'departmentIds', 'mcpServers', 'tools', 'allowedTools',
  'grants', 'grantId', 'policy', 'policyRevision', 'canDelegate',
  'id', 'createdAt', 'createdBy',
]);

/** 冲突处理策略。 */
export const CONFLICT = Object.freeze({
  /** 保留用户的值（默认：用户意志优先） */
  keepUser: 'keep_user',
  /** 采用模板的新值（用户显式选了"跟随模板"） */
  takeTemplate: 'take_template',
  /** 还没决定 —— 界面要把它列出来让用户选 */
  undecided: 'undecided',
});

const isText = (v) => typeof v === 'string';

/**
 * 规范化一条覆盖记录。
 *
 * @param {object} raw
 * @param {string} raw.botId 覆盖针对哪个 bot（必填）
 * @param {string} raw.templateId 来自哪个模板（用来判断模板是否换过）
 * @param {string} [raw.templateVersion] 模板版本（模板内容变了就会变）
 * @param {object} [raw.values] 用户改过的字段值
 * @param {object} [raw.conflicts] 字段 → 冲突策略
 * @param {number} [raw.updatedAt]
 * @returns {{ok:true, override:object}|{ok:false, code:string, text:string}}
 */
export function normalizeOverride(raw = {}) {
  const botId = String(raw?.botId ?? '').trim();
  if (!botId) return { ok: false, code: 'invalid', text: '覆盖必须绑定到具体 bot' };
  const templateId = String(raw?.templateId ?? '').trim();

  const values = {};
  const conflicts = {};
  for (const [key, value] of Object.entries(raw?.values ?? {})) {
    if (FORBIDDEN_FIELDS.includes(key)) {
      return {
        ok: false,
        code: 'forbidden_field',
        text: `字段「${key}」不允许被覆盖 —— 它属于授权层或能间接扩权`,
      };
    }
    if (!OVERRIDABLE_FIELDS.includes(key)) {
      return {
        ok: false,
        code: 'unknown_field',
        text: `字段「${key}」不在可覆盖白名单里（允许：${OVERRIDABLE_FIELDS.join('、')}）`,
      };
    }
    // 值为 undefined = 用户想"恢复默认"（删掉这一项覆盖）
    if (value === undefined) continue;
    if (value === null) { values[key] = null; continue; }
    if (key === 'skills') {
      if (!Array.isArray(value)) return { ok: false, code: 'invalid', text: 'skills 必须是数组' };
      values[key] = value.slice(0, 40).map((s) => String(s?.id ?? s)).filter(Boolean);
      continue;
    }
    if (!isText(value)) return { ok: false, code: 'invalid', text: `字段「${key}」必须是字符串` };
    values[key] = String(value).slice(0, key === 'persona' ? 4000 : 200);
  }

  for (const [key, policy] of Object.entries(raw?.conflicts ?? {})) {
    if (!Object.values(CONFLICT).includes(policy)) continue;
    conflicts[key] = policy;
  }

  return {
    ok: true,
    override: Object.freeze({
      botId,
      templateId,
      templateVersion: String(raw?.templateVersion ?? ''),
      values: Object.freeze(values),
      conflicts: Object.freeze(conflicts),
      updatedAt: Number(raw?.updatedAt) || 0,
    }),
  };
}

/**
 * 把「模板给的」和「用户覆盖的」合成最终配置。
 *
 * ★ 这个函数的输出必须能解释清楚：每个字段的值来自哪一层。
 *   不给出处的话，"为什么这个 bot 的人设不是模板里的"没人答得上来。
 *
 * @param {object} p
 * @param {object} p.templateValues 模板给的字段（`{ persona, tagline, ... }`）
 * @param {object} p.override 用户覆盖（`normalizeOverride` 的产物）
 * @param {string} [p.templateVersion] 当前模板版本
 * @returns {{
 *   values: object,
 *   sources: object,
 *   conflicts: Array<{field:string, template:any, user:any, policy:string}>,
 *   staleTemplate: boolean,
 * }}
 */
export function resolve({ templateValues = {}, override = null, templateVersion = '' } = {}) {
  const values = {};
  const sources = {};
  const conflicts = [];

  // 先铺模板
  for (const [key, value] of Object.entries(templateValues ?? {})) {
    values[key] = value;
    sources[key] = 'template';
  }
  if (!override) return { values, sources, conflicts, staleTemplate: false };

  // 再盖用户覆盖
  for (const [key, value] of Object.entries(override.values ?? {})) {
    const policy = override.conflicts?.[key] ?? CONFLICT.keepUser;
    const fromTemplate = Object.prototype.hasOwnProperty.call(templateValues ?? {}, key);
    const templateValue = templateValues?.[key];

    // 模板没给这个字段：直接用用户的，不算冲突
    if (!fromTemplate) {
      values[key] = value;
      sources[key] = 'user';
      continue;
    }

    // 模板和用户一致：没有冲突，标成 both
    if (sameValue(templateValue, value)) {
      values[key] = value;
      sources[key] = 'both';
      continue;
    }

    // 真的冲突：按策略处理，同时**一律列出来**
    switch (policy) {
      case CONFLICT.takeTemplate:
        values[key] = templateValue;
        sources[key] = 'template';
        break;
      case CONFLICT.keepUser:
      case CONFLICT.undecided:
      default:
        values[key] = value;
        sources[key] = 'user';
        break;
    }
    // undecided 的也列出来 —— 界面要让人选
    if (policy === CONFLICT.undecided || policy === CONFLICT.keepUser) {
      conflicts.push({ field: key, template: templateValue, user: value, policy });
    }
  }

  return {
    values,
    sources,
    conflicts,
    // 模板版本变过 = 用户的覆盖可能已经不适用了，界面该提示
    staleTemplate: Boolean(
      override.templateVersion && templateVersion && override.templateVersion !== templateVersion,
    ),
  };
}

/**
 * 模板升级时，哪些用户覆盖需要重新看一遍。
 *
 * 规格要求「冲突需明示」—— 所以升级不能静默覆盖，也不能静默保留：
 * 要把"模板这个字段改了、而你之前改过它"的清单交出来。
 *
 * @param {object} p
 * @param {object} p.override 用户覆盖
 * @param {object} p.oldTemplate 升级前的模板值
 * @param {object} p.newTemplate 升级后的模板值
 * @returns {{changed: Array<{field:string, before:any, after:any, userValue:any}>}}
 */
export function diffOnUpgrade({ override = null, oldTemplate = {}, newTemplate = {} } = {}) {
  const changed = [];
  const userFields = new Set(Object.keys(override?.values ?? {}));
  for (const key of userFields) {
    const before = oldTemplate?.[key];
    const after = newTemplate?.[key];
    if (sameValue(before, after)) continue; // 模板没改这个字段
    changed.push({ field: key, before, after, userValue: override.values[key] });
  }
  return { changed };
}

/**
 * 覆盖值有没有越界（规格 §13.1 第三条）。
 *
 * 两层检查：
 *   1. 字段级：不允许的字段已经在 `normalizeOverride` 拒了
 *   2. **值级**：技能清单不能借覆盖变长/变宽到超过允许上限
 *
 * 第 2 条是"覆盖不得突破有效授权上限"的落点。技能是提示词层面的，
 * 但它决定模型"会不会去调某个能力"，所以数量要有界。
 *
 * @param {object} p
 * @param {object} p.override
 * @param {number} [p.maxSkills] 技能上限
 * @returns {{ok:true}|{ok:false, code:string, text:string}}
 */
export function checkOverrideBounds({ override = null, maxSkills = 12 } = {}) {
  if (!override) return { ok: true };
  const skills = override.values?.skills;
  if (Array.isArray(skills) && skills.length > maxSkills) {
    return {
      ok: false,
      code: 'too_wide',
      text: `覆盖里给了 ${skills.length} 个技能，超过上限 ${maxSkills} —— 覆盖不能扩大能力范围`,
    };
  }
  return { ok: true };
}

/** 结构化相等（数组按内容比，不按引用比）。 */
function sameValue(a, b) {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b)) return false;
    if (a.length !== b.length) return false;
    return a.every((x, i) => String(x) === String(b[i]));
  }
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const ka = Object.keys(a).sort();
    const kb = Object.keys(b).sort();
    if (ka.length !== kb.length) return false;
    return ka.every((k, i) => k === kb[i] && sameValue(a[k], b[k]));
  }
  return false;
}

/** 一眼看清（日志/界面用，不含凭据）。 */
export function describeOverride(override) {
  if (!override) return '(没有用户覆盖)';
  const fields = Object.keys(override.values ?? {});
  const conflicts = Object.keys(override.conflicts ?? {}).length;
  const parts = [`${override.botId}：用户改了 ${fields.length ? fields.join('、') : '（无）'}`];
  if (conflicts) parts.push(`${conflicts} 个字段有冲突策略`);
  if (override.templateVersion) parts.push(`基于模板版本 ${override.templateVersion}`);
  return parts.join('；');
}
