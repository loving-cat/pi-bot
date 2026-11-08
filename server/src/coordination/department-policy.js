/**
 * 接单路由的**纯判定**（无 IO、无时钟、无随机）。
 *
 * ## 职责
 *
 * 把一次已解析的接单意图，翻译成「这件事该往哪条路走」：
 *
 *   · `direct`   —— 主控自己就能干，或用户明确要它直接做；
 *   · `existing` —— 交给一个**已经存在且合适**的部门；
 *   · `new`      —— 需要新建部门（带部门规格）。
 *
 * ## 不做什么
 *
 *   · 不建部门、不建 Bot、不发消息 —— 那些是部门服务的事；
 *   · 不判断"哪个部门合适"的具体算法 —— 候选部门由宿主查好传进来；
 *   · 不调用模型 —— 路由只消费**这一轮已有**的理解结果。
 *
 * ## 为什么单独一层
 *
 * 路由错了会导致两种严重后果：本该直接答的请求被塞进部门（凭空造活），
 * 或本该建部门的请求被主控自己糊弄过去（用户要的班子没建）。
 * 这两种都值得单独测，所以判定必须能脱离 store 和 runner 跑。
 */
import { INTAKE, PHASE } from '../tasks/task-contract.js';

/** 路由去向。 */
export const ROUTE = Object.freeze({
  /** 主控直接用已授权工具做 */
  direct: 'direct',
  /** 交给已有部门 */
  existing: 'existing',
  /** 新建部门 */
  new: 'new',
});

/** 不做执行的原因。 */
export const NO_EXECUTION = Object.freeze({
  /** 普通问答 */
  answer: 'answer',
  /** 需要澄清 */
  clarification: 'clarification',
  /** 用户只要建部门 */
  departmentOnly: 'department_only',
  /** 请求不明确，需要补充 */
  underspecified: 'underspecified',
});

const isId = (v) => typeof v === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(v);

function ok(value) {
  return { ok: true, ...value };
}

function skip(reason, text) {
  return { ok: true, execute: false, reason, text };
}

/**
 * 决定这次请求要不要进入执行、以及走哪条路。
 *
 * @param {object} p
 * @param {object} p.intake 已通过 parseIntake 的结果
 * @param {object[]} [p.candidateDepartments] 宿主导出的候选部门（含 id/name/topic/leadBotId）
 * @param {string|null} [p.explicitRoute] 用户明确指定的去向（'direct' / 'existing' / 'new'）
 * @param {boolean} [p.userWantsDiscussion] 用户明确说只讨论
 * @returns {{ok:true, execute:boolean, ...}}
 */
export function planIntakeRoute({
  intake,
  candidateDepartments = [],
  explicitRoute = null,
  userWantsDiscussion = false,
} = {}) {
  if (!intake || typeof intake !== 'object') {
    return { ok: false, code: 'bad_intake', text: '缺少接单意图' };
  }

  // ---- 问答与澄清：不进入执行
  if (intake.kind === INTAKE.answer) {
    return skip(NO_EXECUTION.answer, '这是普通问答，直接答即可');
  }
  if (intake.kind === INTAKE.clarification) {
    return skip(NO_EXECUTION.clarification, '需要先向用户澄清关键信息');
  }

  // ---- 用户明确只要讨论
  if (userWantsDiscussion) {
    return skip(NO_EXECUTION.answer, '用户明确只讨论，不进入执行');
  }

  if (intake.kind !== INTAKE.accept_task) {
    return { ok: false, code: 'unknown_intake', text: '未知接单意图：' + String(intake.kind) };
  }

  const routing = intake.routing ?? { type: 'auto' };
  const goal = intake.goal ?? null;

  // 路由有两个来源：这一轮理解产出的 routing.type，以及调用方的显式覆盖。
  // 两者都要消费 —— 只看 explicitRoute 会让 parseIntake 出来的 direct 失效。
  const wantedRoute = explicitRoute ?? routing.type ?? 'auto';

  // ---- 主控直接做：不建部门、不排待派动作（由当前 Attempt 承接）
  if (wantedRoute === ROUTE.direct) {
    if (!goal) {
      return skip(NO_EXECUTION.underspecified, '缺少目标，不能进入执行');
    }
    return ok({ execute: true, route: ROUTE.direct, goal, reason: '这一轮明确由主控直接做' });
  }

  // ---- 已有部门：必须真的存在且合适
  if (wantedRoute === ROUTE.existing) {
    const wanted = isId(routing.departmentId) ? routing.departmentId : null;
    if (!wanted) {
      return { ok: false, code: 'no_department_id', text: '说明要交给已有部门，但没有给部门 ID', execute: false };
    }
    const hit = candidateDepartments.find((d) => d.id === wanted);
    if (!hit) {
      // 指定了 id 却找不到：不能悄悄新建一个"同名"的顶替
      return { ok: false, code: 'department_not_found', text: '找不到部门 ' + wanted, execute: false };
    }
    if (!departmentUsable(hit)) {
      return {
        ok: false,
        code: 'department_unusable',
        text: '部门 ' + hit.id + ' 缺少可用负责人，不能直接交接',
        execute: false,
      };
    }
    return ok({
      execute: true,
      route: ROUTE.existing,
      departmentId: hit.id,
      leadBotId: hit.leadBotId,
      goal,
      reason: '复用已有部门',
    });
  }

  // ---- 新建部门
  if (wantedRoute === ROUTE.new) {
    const spec = normalizeDepartmentSpec(routing.departmentSpec);
    if (!spec) {
      return {
        ok: false,
        code: 'no_department_spec',
        text: '要新建部门但没给合法规格（至少需要名称）',
        execute: false,
      };
    }
    // 只建组：**要建**，但建成即结束，不派研究任务
    if (routing.departmentOnly === true) {
      return ok({
        execute: false,
        route: ROUTE.new,
        departmentSpec: spec,
        createOnly: true,
        reason: NO_EXECUTION.departmentOnly,
        text: '用户只要求建部门，建成即结束',
      });
    }
    if (!goal) {
      return skip(NO_EXECUTION.underspecified, '缺少目标，不能进入执行');
    }
    return ok({
      execute: true,
      route: ROUTE.new,
      departmentSpec: spec,
      goal,
      reason: '需要新建部门',
    });
  }

  // ---- auto：只在**这一轮明确指定了部门**时复用
  //
  // 仅凭名称/话题的字面重合去匹配不可靠：「编写儿童绘本」和
  // 「编写接口并排查数据库故障」共享"编写"二字，但能力完全不同。
  // 低确定性时宁可新建，也不要把活派给不合适的部门。
  if (wantedRoute === 'auto') {
    const explicitId = isId(routing.departmentId) ? routing.departmentId : null;
    if (explicitId) {
      const hit = candidateDepartments.find((d) => d.id === explicitId);
      if (hit && departmentUsable(hit)) {
        return ok({
          execute: true,
          route: ROUTE.existing,
          departmentId: hit.id,
          leadBotId: hit.leadBotId,
          goal,
          reason: '这一轮指定了部门',
        });
      }
    }
    if (!goal) {
      return skip(NO_EXECUTION.underspecified, '缺少目标，不能进入执行');
    }
    const spec = normalizeDepartmentSpec(routing.departmentSpec);
    if (!spec) {
      return {
        ok: false,
        code: 'no_department_spec',
        text: '没有可复用部门，也没有合法的部门规格',
        execute: false,
      };
    }
    if (routing.departmentOnly === true) {
      return ok({
        execute: false,
        route: ROUTE.new,
        departmentSpec: spec,
        createOnly: true,
        reason: NO_EXECUTION.departmentOnly,
        text: '用户只要求建部门，建成即结束',
      });
    }
    return ok({
      execute: true,
      route: ROUTE.new,
      departmentSpec: spec,
      goal,
      reason: '没有指定可复用部门，按规格新建',
    });
  }

  return { ok: false, code: 'unknown_route', text: '未知路由：' + String(wantedRoute), execute: false };
}

/** 部门能不能承接：必须有负责人。 */
export function departmentUsable(department) {
  return Boolean(department && isId(department.id) && isId(department.leadBotId));
}

/**
 * 从候选里挑一个可复用部门。
 *
 * ★ 只做**保守匹配**：名称/话题有词重叠才算。宁可不复用去新建，
 *   也不要把活塞进不相关的部门 —— 后者会让用户看到一堆莫名其妙的产出。
 */
export function pickReusableDepartment(candidates, words = []) {
  const usable = (candidates ?? []).filter(departmentUsable);
  if (!usable.length) return null;
  if (!words.length) return null;

  let best = null;
  let bestScore = 0;
  for (const d of usable) {
    const hay = `${d.name ?? ''} ${d.topic ?? ''}`.toLowerCase();
    const score = words.filter((w) => hay.includes(w.toLowerCase())).length;
    if (score > bestScore) {
      best = d;
      bestScore = score;
    }
  }
  return bestScore > 0 ? best : null;
}

/**
 * 从目标里抽几个可比较的词。
 *
 * 中文没有空格，整段切分会得到一个长串，匹配不上部门名/话题。
 * 这里额外产出二字片段（bigram），让「整理对照报告」能命中
 * 话题里的「对照报告」。只做保守的包含匹配，不引入分词库。
 */
function topicWords(goal) {
  const text = `${goal?.requirement ?? ''} ${(goal?.deliverables ?? []).join(' ')}`.toLowerCase();
  const chunks = text.split(/[^a-z0-9\u4e00-\u9fa5]+/).filter(Boolean);
  const words = new Set();
  for (const chunk of chunks) {
    if (chunk.length >= 2) words.add(chunk);
    // 中文二字片段：只在含中文时切，避免纯英文被拆碎
    if (/[\u4e00-\u9fa5]/.test(chunk)) {
      for (let i = 0; i + 2 <= chunk.length; i += 1) {
        words.add(chunk.slice(i, i + 2));
      }
    }
  }
  return [...words].filter((w) => w.length >= 2).slice(0, 40);
}

/**
 * 规整部门规格。
 *
 * 只去掉不合法输入，不补默认值、不裁剪已选能力：
 * 成员的人设、tagline、thinking、skills、mcpServers 等都是用户/主控
 * 已经选定的东西，归一化不能把它们弄丢。
 */
export function normalizeDepartmentSpec(spec) {
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) return null;
  const name = typeof spec.name === 'string' ? spec.name.trim().slice(0, 60) : '';
  const topic = typeof spec.topic === 'string' ? spec.topic.trim().slice(0, 300) : '';
  // 负责人是**名字字符串**：Store.createDepartment 按 name 匹配。
  const lead = typeof spec.lead === 'string' ? spec.lead.trim().slice(0, 40) : '';
  const members = Array.isArray(spec.members)
    ? spec.members
        .filter((m) => m && typeof m === 'object' && typeof m.name === 'string' && m.name.trim())
        .map((m) => ({ ...m, name: m.name.trim().slice(0, 40) }))
        .slice(0, 12)
    : [];
  if (!name) return null;
  return { name, topic, lead, members };
}

export { INTAKE, PHASE };
