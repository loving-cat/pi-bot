/**
 * 首次授权流程（规格 §13.2）—— **只算该说什么、该让用户选什么，不创建任何授权**。
 *
 * ## 为什么单独一个文件
 *
 * 规格 §13.2 是唯一"整节一步都没做"的 P0。它写的五步里有三步是**告知**
 * （这台机器上它能看到什么、哪些动作不能撤销、哪些硬隔离保证给不了），
 * 一步是**选择**（项目 + 普通 Git 范围 + 执行 Bot 的最小权限），
 * 一步是**收尾**（产物、测试边界、副作用、级联回收）。
 *
 * 这五步里没有一步是"新授权机制"。所以这个文件**不是**许可证，
 * 它是**讲解词**：输入现状，输出一段要展示的话和几个要用户选的项。
 * 真正的授权仍然只有一条路 —— 用户交互 → `grants.js` 的 `normalizeGrant`。
 *
 * ★ 规格 §16.2 明确「这些是设计默认，不是新增授权」。
 *   在这里偷偷建 grant 就等于绕过入口鉴权，那是最不该犯的错。
 *
 * ## 三条不可越过的原则
 *
 *   1. **只描述现状**：拿不到的信息就写"不知道/不可用"，不猜、不默认放行。
 *   2. **不用更宽的模式补**：规格 §13.2-4「OS 授权失败按实际结果报告，
 *      不自动切换更宽模式」。所以桌面输入没授权时，这里只会说"不可用"，
 *      不会建议改用 host 模式兜底 —— 那是**放宽**，不是兜底。
 *   3. **有些逐次确认不由 policy 决定**：外部 MCP 工具和改安全配置
 *      （`capabilities.js` 的 `SECURITY_CONFIG_TOOLS`）在任何档位都要点批准。
 *      汇总页把它们和 policy 决定的那些**分开列**，否则用户会以为
 *      "我把危险动作调成 allow 就全放行了"。
 *
 * ## 这里不做的事
 *
 *   · 不读 `store`、不写 `store`：全部入参都由调用方取好传进来（可单测）。
 *   · 不判断"这个授权该不该发"：那是 `grants.js` 的 `deriveGrant` 的活。
 *   · 不做 i18n：文案是中文，和仓库其他模块一致；App 侧只做归类与排版。
 */
import { ACTION as A, DENY, MODE, normalizeGrant, checkGrantValidity, describeGrant } from './grants.js';
import { INPUT_FAIL } from './desktop-input.js';
import { MUTATING_TOOLS, SECURITY_CONFIG_TOOLS } from './capabilities.js';
import { describeExecutionMode } from './exec-mode.js';

/** 规格 §13.2 的五步。前四步进首启页，第五步是跑完之后才出现。 */
export const STEP = Object.freeze({
  visibility: 1,
  project: 2,
  leastPrivilege: 3,
  summary: 4,
  wrapUp: 5,
});

/**
 * 普通 Git 动作范围（规格 §13.2-2「普通 Git 动作范围」）。
 *
 * 只收录**普通**动作。远端推送、worktree 共享元数据、hooks/签名、凭据使用
 * 都在 `SEPARATE_APPROVAL` 里 —— 它们"是否另需批准"是这一步要**说清楚**的事，
 * 不是这一步能顺手勾掉的事。
 */
export const GIT_SCOPE = Object.freeze({
  none: 'none',
  read: 'read',
  commit: 'commit',
  push: 'push',
});

const GIT_SCOPE_ACTIONS = Object.freeze({
  [GIT_SCOPE.none]: Object.freeze([]),
  [GIT_SCOPE.read]: Object.freeze([A.gitRead]),
  [GIT_SCOPE.commit]: Object.freeze([A.gitRead, A.gitCommit]),
  [GIT_SCOPE.push]: Object.freeze([A.gitRead, A.gitCommit, A.gitPush]),
});

const GIT_SCOPE_LABEL = Object.freeze({
  [GIT_SCOPE.none]: '不用 Git',
  [GIT_SCOPE.read]: '只读仓库（git.read）',
  [GIT_SCOPE.commit]: '读 + 本地提交（不碰远端）',
  [GIT_SCOPE.push]: '读 + 本地提交 + 推远端（远端另需批准）',
});

/**
 * 不论 Git 范围选多宽，都**另需批准**的四件事（规格 §13.2-2 原文四类）。
 *
 * ★ 写成常量而不是"按范围算出来"是有意的：
 *   如果按范围算，某天有人把 `push` 并进 `commit`，这张表就会自动缩短，
 *   而界面上不会有任何提示。这里必须是**死数**，测试再守一遍
 *   "选最宽范围也不减少"。
 */
export const SEPARATE_APPROVAL = Object.freeze([
  Object.freeze({
    id: 'remote',
    title: '远端操作',
    actions: Object.freeze([A.gitPush, A.netFetch, A.gitDestructive]),
    note: '推到哪个远端、用哪份凭据，要单独确认；读远端也不算"只是读"——它会写本地 refs/objects',
  }),
  Object.freeze({
    id: 'shared-metadata',
    title: '共享元数据',
    actions: Object.freeze([A.fileWrite]),
    note: 'worktree 的 gitdir / commondir / alternates 在仓库之外，改它们等于影响别的 worktree',
  }),
  Object.freeze({
    id: 'hooks-signing',
    title: 'hooks 与签名',
    actions: Object.freeze([A.cmdExec]),
    note: 'Git 会执行仓库里配置的 hook，等于一次任意命令执行；签名要用到本机私钥',
  }),
  Object.freeze({
    id: 'credentials',
    title: '凭据使用',
    actions: Object.freeze([A.secretUse]),
    note: '已存的令牌/口令只在这一次动作里用，不等于把凭据交给它',
  }),
]);

/** computer use 的实际系统权限状态（如实报，不乐观推定）。 */
export const DESKTOP_STATE = Object.freeze({
  granted: 'granted',
  denied: 'denied',
  notPlatform: 'not-platform',
  unknown: 'unknown',
});

const DESKTOP_STATE_TEXT = Object.freeze({
  [DESKTOP_STATE.granted]: '可用',
  [DESKTOP_STATE.denied]: '系统拒绝了授权',
  [DESKTOP_STATE.notPlatform]: '这个平台还没实现',
  [DESKTOP_STATE.unknown]: '还不知道（没探测过）',
});

/**
 * 一次平台探针的结果 → 首启页要报的"实际系统权限"。
 *
 * 三种结果必须分开，因为它们对应三种完全不同的处置：
 *
 * | 探针 | 状态 | 界面要说的话 |
 * |---|---|---|
 * | ok | granted | 可用 |
 * | `not_platform` | not-platform | 这个平台还没实现（**不是**"系统拒绝了你"） |
 * | 其它失败（没法声明 DPI 感知 / 没有可操作会话 / 探针本身挂了） | denied | 按实际结果报，不换成更宽的模式 |
 *
 * ★ 没探过（`probe == null`）就给 `unknown`，**不乐观推定成可用**：
 *   "应该能用"和"实际能用"在桌面输入这里是两件事，猜错的方向是
 *   让用户以为它敢动他的鼠标。
 */
export function desktopStatusOf(probe = null) {
  if (!probe || typeof probe !== 'object') {
    return { observe: DESKTOP_STATE.unknown, input: DESKTOP_STATE.unknown, detail: null };
  }
  if (probe.ok === true) {
    return { observe: DESKTOP_STATE.granted, input: DESKTOP_STATE.granted, detail: null };
  }
  const code = String(probe.code ?? '');
  const detail = probe.text ? String(probe.text) : null;
  if (code === INPUT_FAIL.notPlatform) {
    return { observe: DESKTOP_STATE.notPlatform, input: DESKTOP_STATE.notPlatform, detail };
  }
  return { observe: DESKTOP_STATE.denied, input: DESKTOP_STATE.denied, detail, code: code || null };
}

/**
 * 哪些授权来源算“用户真的走过这一步”。
 *
 * ★ 为什么不能拿“有没有任何授权”当首次判据：
 *
 *   `server-main.js` 每次启动都会调 `ensureLegacyGrant()`，给每个 bot 发一条
 *   `source: 'legacy-policy'` 的迁移授权（范围 = 当前 policy 已允许的）。
 *   所以**任何一台真机器上一启动就有授权** —— 按“没有授权”判首次，
 *   这页永远不会出现，而它长得跟正常工作一模一样（只是不弹），
 *   排查时得翻到启动日志里那一行“已建立迁移授权”才看得出来。
 *
 *   迁移授权是“升级前你就批准过的口径”的**记账**，不是用户走过 §13.2。
 *   所以首次只能按**人类来源**判：`user` / `saved-rule`。
 */
const HUMAN_SOURCES = new Set(['user', 'saved-rule']);

/**
 * 这一步/这条授权是“规格 §13.2 之前就存在”的那种。
 *
 * 界面上要把它和“你这次选的”分开说：它的范围等于旧 policy，
 * 可能比你现在想要的大 —— 而它不会因为新授权的存在而自动收窄。
 */
export function isLegacyGrant(grant) {
  return grant?.source === 'legacy-policy';
}

function isTemporary(grant) {
  return Boolean(grant.taskId) || grant.expiresAt != null || grant.maxUses != null;
}

function botLabel(bot) {
  return bot?.name || bot?.id || '未命名';
}

function isMain(bot) {
  return bot?.role === 'main';
}

/** 规格 §13.2-4：**不论档位**都要逐次确认的那几条。 */
function alwaysConfirmItems() {
  return [
    {
      id: 'security-config',
      title: '改动安全配置',
      always: true,
      tools: [...SECURITY_CONFIG_TOOLS],
      note: '挂载/新加 MCP、改规矩、改 hook、改命令规则、写凭据 —— 这一批改的是防线本身，不随危险动作档位放宽',
    },
    {
      id: 'external-mcp',
      title: '调用外部 MCP 工具',
      always: true,
      tools: null,
      note: '外部工具的行为在被调用方手里，随时可能在一次更新里变；没有"只读所以免批"这一档',
    },
  ];
}

/**
 * 这次运行要**逐次点批准**的东西。
 *
 * 分组是刻意的：`always` 那组不受 policy 影响，policy 只影响第三组。
 * 界面上把两组混在一行写，用户就会以为调宽 policy 能省掉全部点击。
 */
export function perCallConfirmItems({ policy = {}, mcpServerCount = 0 } = {}) {
  const items = alwaysConfirmItems();
  if (mcpServerCount > 0) {
    items[1].count = mcpServerCount;
    items[1].note += `（当前挂了 ${mcpServerCount} 个 MCP 服务）`;
  }
  if (policy.dangerous === 'ask') {
    items.push({
      id: 'mutating',
      title: '所有会动手的内置动作',
      always: false,
      tools: [...MUTATING_TOOLS],
      note: '当前危险动作档位是"每次都要问"：写文件、跑命令这类动作每次都要点批准',
    });
  } else if (policy.dangerous === 'deny') {
    items.push({
      id: 'mutating-denied',
      title: '所有会动手的内置动作（直接拒绝，不会问你）',
      always: false,
      tools: [...MUTATING_TOOLS],
      note: '当前档位是只读：这些动作不是"每次确认"，而是**根本不给**。要它干活得先改档位',
    });
  }
  return items;
}

/**
 * 硬隔离边界：能保证什么、**不能**保证什么（规格 §13.2-4）。
 *
 * 这一节的价值全在"不能"那一半。用户对"AI 操作我的电脑"的恐惧主要来自
 * 不知道边界在哪；写清楚"它就是你，它读得到你读得到的"，比再加十道弹窗有用。
 */
export function describeBoundaries({ mode = MODE.project, platform = process.platform, desktop = {} } = {}) {
  const can = [
    '每次执行前按当次有效授权核对动作、范围、期限，父授权一撤子授权立刻失效',
  ];
  const cannot = [];

  if (mode === MODE.isolated) {
    can.push('命令跑在沙箱里，看不到沙箱外的文件');
    cannot.push('沙箱不是虚拟机：同内核、同用户态服务，内核级漏洞可以穿透');
  } else if (mode === MODE.host) {
    cannot.push('它用的是你**当前的登录身份**：你读得到的文件、你能连的内网，它都到得了');
  } else {
    cannot.push('"项目受控模式"不是沙箱：它只是把动作限制在项目目录和放行的命令上，同用户下任何进程仍能读到别的文件');
  }

  cannot.push('不做网络隔离：它能不能出去，取决于你有没有给网络授权和本机防火墙');

  const inputState = String(desktop.input ?? DESKTOP_STATE.unknown);
  const observeState = String(desktop.observe ?? DESKTOP_STATE.unknown);
  can.push(`屏幕观察：${DESKTOP_STATE_TEXT[observeState] ?? observeState}`);
  if (inputState === DESKTOP_STATE.granted) {
    can.push(`桌面键鼠：可用，但只在主 Bot 手上（普通桌面键鼠权限**不随角色继承**）`);
    cannot.push('它点的是**同一张真实桌面**：没有虚拟桌面隔离，你鼠标动它、它动你，谁先谁后靠接管检测兜');
  } else {
    // ★ 只报告，不换模式。规格 §13.2-4 原话。
    cannot.push(
      `桌面键鼠：${DESKTOP_STATE_TEXT[inputState] ?? inputState} —— 这条不可用就是不可用，不会自动改用更宽的模式顶上`,
    );
  }
  if (platform === 'darwin') {
    cannot.push('macOS 的桌面输入目前还是空壳（见 docs/MACOS-DESKTOP-INPUT.md），只能观察');
  }
  return { can, cannot };
}

/**
 * 首次授权页：把规格 §13.2 的前四步算成一页要展示的内容。
 *
 * 一页而不是向导，原因写在 `docs/NEXT-SESSION.md`：五步里三步是"告知"，
 * 只有一步是"选择"。拆成向导只会让人多点四次"下一步"。
 *
 * @param {object} p
 * @param {object} [p.policy] `store.policy()`
 * @param {Array} [p.bots] 全部 bot（`[{id, name, role}]`）
 * @param {Array} [p.projects] 可选项目（`[{id, label, path}]`）
 * @param {Array} [p.grants] 现有授权（判断是不是首次、有没有越权继承）
 * @param {object} [p.desktop] 实际系统权限 `{observe, input}`（取值见 `DESKTOP_STATE`）
 * @param {number} [p.mcpServerCount] 已挂的外部 MCP 数量（用在逐次确认的说明里）
 * @param {string} [p.platform] 平台，默认当前
 * @returns {object} 展示用的整页结构（见下方 steps/warnings/blockers）
 */
export function planFirstRun({
  policy = {},
  bots = [],
  projects = [],
  grants = [],
  desktop = {},
  mcpServerCount = 0,
  platform = process.platform,
} = {}) {
  const botList = (Array.isArray(bots) ? bots : []).filter((b) => b && b.id);
  const projectList = (Array.isArray(projects) ? projects : []).filter((p) => p && (p.path || p.id));
  const grantList = (Array.isArray(grants) ? grants : []).filter((g) => g && !g.revokedAt);
  const main = botList.find(isMain) ?? null;
  const executors = botList.filter((b) => !isMain(b));

  // 用户当下想要的最小范围
  const humanRoots = grantList.filter((g) => HUMAN_SOURCES.has(String(g.source ?? '')));
  const legacyCount = grantList.filter(isLegacyGrant).length;
  // 真的“首次” = 还没有任何一条人能点出来的授权根。
  // 迁移授权不算 —— 它是旧规矩的记账（见 HUMAN_SOURCES 上面那段）。
  const firstRun = humanRoots.length === 0;

  const boundaries = describeBoundaries({ mode: MODE.project, platform, desktop });

  // ---------------------------------------------------------------- 第 1 步
  const visibilityLines = [
    main
      ? `主 Bot「${botLabel(main)}」在**你当前的登录身份**下工作，任务是全机的，不限于某个项目目录`
      : '还没有主 Bot —— 先建一个主 Bot，它才是拿全机视野的那个角色',
    `屏幕观察：${DESKTOP_STATE_TEXT[String(desktop.observe ?? DESKTOP_STATE.unknown)] ?? '未知'}`,
    `桌面键鼠：${DESKTOP_STATE_TEXT[String(desktop.input ?? DESKTOP_STATE.unknown)] ?? '未知'}`,
    policy.dangerous === 'allow'
      ? '危险动作档位是"照常放行"：写文件、跑命令不会每次问你（改安全配置和外部 MCP 除外）'
      : policy.dangerous === 'ask'
        ? '危险动作档位是"每次都要问"：每次写文件/跑命令都要你点批准'
        : '危险动作档位是"只读"：只给看，不给动手',
    '这条不会被这次选择取消：改安全配置、调用外部 MCP 工具，永远逐次确认',
  ];

  // ---------------------------------------------------------------- 第 2 步
  const gitScopes = Object.values(GIT_SCOPE).map((id) => ({
    id,
    label: GIT_SCOPE_LABEL[id],
    actions: [...GIT_SCOPE_ACTIONS[id]],
  }));
  const recommendedGitScope = GIT_SCOPE.commit;

  // ---------------------------------------------------------------- 第 3 步
  const leastPrivilegeLines = executors.length
    ? executors.map(
        (b) => `「${botLabel(b)}」：${MODE.project} —— ${describeExecutionMode(MODE.project)}`,
      )
    : ['还没有执行 Bot：下面第 2 步选的范围只会约束主 Bot 自己'];
  leastPrivilegeLines.push(
    '普通桌面键鼠权限不随角色继承：主 Bot 能用，执行 Bot 默认不能',
    '执行模式按任务给，跑完随临时授权一起回收，不会留下来变成长期能力',
  );

  // ---------------------------------------------------------------- 第 4 步
  const summaryLines = [
    projectList.length
      ? `项目范围：${projectList.map((p) => p.label || p.path || p.id).join('、')}`
      : '项目范围：还没选（选之前不能开始）',
    `Git 范围：${GIT_SCOPE_LABEL[recommendedGitScope]} —— 下面这四类仍要另批：${SEPARATE_APPROVAL.map((s) => s.title).join('、')}`,
    executors.length
      ? `执行 Bot：${executors.map((b) => botLabel(b)).join('、')}，各自 ${MODE.project} 模式`
      : '执行 Bot：无',
    '到期/撤销：默认到你手动收回为止；带任务/期限/次数的临时授权在任务结束时自动回收',
  ];

  const steps = [
    {
      id: STEP.visibility,
      kind: 'tell',
      title: '这台机器上，它能看到什么',
      lines: visibilityLines,    },
    {
      id: STEP.project,
      kind: 'choose',
      title: '负责人项目与普通 Git 动作范围',
      lines: [
        '选一个负责人项目：它的边界是这份授权能碰到的最大范围',
        '普通 Git 动作单独选一档；选多宽都不影响下面四类另批',
        // 迁移授权必须单独说：它不会因为新授权存在而自动收窄。
        ...(legacyCount > 0
          ? [`你现在手上还有 ${legacyCount} 条升级前的迁移授权（范围 = 当时那份规矩），这次选完不会自动把它收窄，要你自己收回`]
          : []),
      ],
      options: {
        projects: projectList.map((p) => ({
          id: String(p.id ?? p.path ?? ''),
          label: String(p.label ?? p.path ?? p.id ?? ''),
          path: p.path ? String(p.path) : null,
        })),
        gitScopes,
      },
      separateApproval: SEPARATE_APPROVAL.map((s) => ({ ...s, actions: [...s.actions] })),
      recommended: {
        projectId: projectList.length ? String(projectList[0].id ?? projectList[0].path ?? '') : null,
        gitScope: recommendedGitScope,
      },
    },
    {
      id: STEP.leastPrivilege,
      kind: 'choose',
      title: '执行 Bot 的任务级最小权限',
      lines: leastPrivilegeLines,
      options: {
        modes: [MODE.project, MODE.isolated],
        // ★ host 不在可选项里：规格 §8.1 的 host 是"主 Bot 可信宿主"，
        //   不给执行 Bot 选 —— 让它出现在下拉框里，迟早会有人选上。
        note: `执行 Bot 只能选 ${MODE.project} 或 ${MODE.isolated}；${MODE.host} 只属于主 Bot`,
      },
      recommended: { mode: MODE.project },
    },
    {
      id: STEP.summary,
      kind: 'confirm',
      title: '开始前的汇总',
      lines: summaryLines,
      boundaries,
    },
  ];

  // ---------------------------------------------------------------- 警告
  const warnings = [];
  if (policy.dangerous !== 'ask') {
    warnings.push({
      id: 'dangerous-not-ask',
      text:
        policy.dangerous === 'allow'
          ? '危险动作现在是"照常放行"：任务跑起来之后，写文件和跑命令不会逐次问你'
          : '危险动作现在是"只读"：Bot 只能看，做不了活；等真要用时再改档位',
    });
  }
  for (const g of grantList) {
    // 规格 §13.2-3：普通桌面通用键鼠权限**不随角色继承**。
    const subject = botList.find((b) => b.id === g.subject?.botId) ?? null;
    const role = subject?.role ?? g.subject?.role ?? '';
    const actions = Array.isArray(g.actions) ? g.actions : [];
    if (role !== 'main' && actions.includes(A.desktopInput)) {
      warnings.push({
        id: `desktop-input-inherited:${g.id}`,
        text: `「${subject ? botLabel(subject) : g.subject?.botId}」不是主 Bot，却有一条桌面键鼠授权（${describeGrant(g)}）—— 这一条不该有`,
      });
    }
    if (role !== 'main' && g.mode === MODE.host) {
      warnings.push({
        id: `host-mode-on-sub:${g.id}`,
        text: `「${subject ? botLabel(subject) : g.subject?.botId}」不是主 Bot，却有一条 host 模式授权 —— host 只该给主 Bot`,
      });
    }
  }
  const inputState = String(desktop.input ?? DESKTOP_STATE.unknown);
  if (inputState !== DESKTOP_STATE.granted && grantList.some((g) => (g.actions ?? []).includes(A.desktopInput))) {
    warnings.push({
      id: 'desktop-grant-unusable',
      text: `这台机器上桌面键鼠是"${DESKTOP_STATE_TEXT[inputState] ?? inputState}"，但已经存在桌面键鼠授权 —— 那几条现在用不上`,
    });
  }

  // ---------------------------------------------------------------- 阻断项
  const blockers = [];
  if (!main) {
    blockers.push({ id: 'no-main-bot', text: '没有主 Bot：启不来，先建一个' });
  }
  if (!projectList.length) {
    blockers.push({ id: 'no-project', text: '没有可选的项目：第 2 步选不了，也就无法确定授权边界' });
  }

  return {
    firstRun,
    // 有多少条“旧规矩”的迁移授权。界面要把它和新选的区分开说。
    legacyGrants: legacyCount,
    steps,
    perCallConfirm: perCallConfirmItems({ policy, mcpServerCount }),
    boundaries,
    warnings,
    blockers,
    startable: blockers.length === 0,
  };
}

/**
 * 第 4 步的"本次有效权限"汇总 —— 从**真的会生效**的那些授权算出来。
 *
 * ★ 为什么不能直接把 `state.grants` 过滤掉 revoked 就展示：
 *   规矩一变，`checkGrantValidity` 就会按 `policyChanged` 把它们拒掉。
 *   界面上还画成正常授权，用户会以为"我明明授权了"（`grant_view.dart`
 *   里踩过同一个坑）。所以这里必须**真的调一次有效性判定**，
 *   并且把失效的单独列出来说清楚原因。
 */
export function summarizeEffectivePermissions({
  grants = [],
  bots = [],
  policy = {},
  policyRevision = null,
  now = Date.now(),
  mcpServerCount = 0,
} = {}) {
  const byId = new Map((Array.isArray(bots) ? bots : []).filter((b) => b?.id).map((b) => [b.id, b]));
  const entries = [];
  const stale = [];
  const invalid = [];
  let temporary = 0;

  for (const raw of Array.isArray(grants) ? grants : []) {
    const n = normalizeGrant(raw);
    if (!n.ok) {
      invalid.push({ id: raw?.id ?? null, code: n.code, text: n.text });
      continue;
    }
    const v = checkGrantValidity({ grant: n.grant, now, policyRevision });
    if (!v.ok) {
      if (v.code === DENY.policyChanged) {
        stale.push({ id: n.grant.id, text: v.text, actions: [...n.grant.actions] });
      }
      continue;
    }
    const bot = byId.get(n.grant.subject.botId) ?? null;
    const temp = isTemporary(n.grant);
    if (temp) temporary += 1;
    entries.push({
      id: n.grant.id,
      botId: n.grant.subject.botId,
      botName: bot ? botLabel(bot) : n.grant.subject.botId,
      role: bot?.role ?? n.grant.subject.role ?? '',
      mode: n.grant.mode,
      modeText: describeExecutionMode(n.grant.mode),
      actions: [...n.grant.actions],
      resources: n.grant.resources.map((r) => `${r.kind}:${r.ref}`),
      taskId: n.grant.taskId,
      expiresAt: n.grant.expiresAt,
      maxUses: n.grant.maxUses,
      temporary: temp,
      canDelegate: n.grant.canDelegate,
    });
  }

  return {
    entries,
    stale,
    invalid,
    temporary,
    empty: entries.length === 0,
    perCallConfirm: perCallConfirmItems({ policy, mcpServerCount }),
  };
}

/**
 * 这条授权能不能在任务结束后**保留**（规格 §13.2-5）。
 *
 * 返回拒绝理由，`null` 表示可以保留。
 *
 * ★ 判据是"它描述的是不是一件项目内的事"，不是"风险高不高"：
 *   用户保留项目授权是合理的（下次还要干同一个仓库的活），
 *   但"因为项目授权还在，所以可以对外发消息/付款"是不能推的 ——
 *   这两件事的风险量级完全不同，必须各自单独批准。
 */
export function retentionRefusal(grant) {
  if (!grant) return '没有这条授权';
  const actions = Array.isArray(grant.actions) ? grant.actions : [];
  if (actions.includes(A.netSend)) return '对外发送/发布/上传不能靠"保留项目"推出，每次都要单独批';
  if (actions.includes(A.secretUse)) return '凭据使用不能长期保留，每次都要单独批';
  if (grant.mode !== MODE.project) {
    return `${grant.mode} 模式授权不能长期保留：它描述的不是项目范围内的事`;
  }
  const kinds = (Array.isArray(grant.resources) ? grant.resources : []).map((r) => r?.kind);
  if (kinds.some((k) => k !== 'path' && k !== 'repo')) {
    return '范围里含非项目资源（主机/凭据/桌面），不能当成项目授权保留';
  }
  return null;
}

/**
 * 第 5 步的收尾：产物、测试边界、副作用、级联回收。
 *
 * `implemented: false` 是**如实的**：级联回收的机制在（`store` 删 bot /
 * `grant-gate.revoke`），但"任务结束时自动收割"要靠 TaskRun 的收尾钩子，
 * 那部分还没接。这里给出该收哪些，调用方接上以后把 `implemented` 翻成 true。
 */
export function planWrapUp({
  grants = [],
  bots = [],
  artifacts = [],
  testedBoundaries = [],
  sideEffects = [],
  now = Date.now(),
  keepRequested = [],
} = {}) {
  const byId = new Map((Array.isArray(bots) ? bots : []).filter((b) => b?.id).map((b) => [b.id, b]));
  const alive = [];
  for (const raw of Array.isArray(grants) ? grants : []) {
    const n = normalizeGrant(raw);
    if (!n.ok) continue;
    if (!checkGrantValidity({ grant: n.grant, now }).ok) continue;
    alive.push(n.grant);
  }

  const revokeNow = [];
  const keepable = [];
  const refused = [];

  for (const grant of alive) {
    const temp = isTemporary(grant);
    const refusal = retentionRefusal(grant);
    if (temp) {
      // 临时授权：任务结束就该收，不管它本身是不是项目范围
      revokeNow.push({
        id: grant.id,
        why: grant.taskId
          ? `任务 ${grant.taskId} 的临时授权`
          : grant.expiresAt != null
            ? '带期限的临时授权'
            : '带次数的临时授权',
      });
      continue;
    }
    if (refusal) {
      refused.push({ id: grant.id, why: refusal });
      continue;
    }
    const bot = byId.get(grant.subject.botId);
    keepable.push({
      id: grant.id,
      botName: bot ? botLabel(bot) : grant.subject.botId,
      actions: [...grant.actions],
      resources: grant.resources.map((r) => `${r.kind}:${r.ref}`),
    });
  }

  // 用户点名要保留、但留着就出事的那几条 —— 要说清"为什么不能"
  const requested = new Set((Array.isArray(keepRequested) ? keepRequested : []).map(String));
  const deniedKeep = refused
    .filter((r) => requested.has(r.id))
    .map((r) => ({ ...r, text: `你勾了"保留"，但这条不能保留：${r.why}` }));

  return {
    step: STEP.wrapUp,
    artifacts: (Array.isArray(artifacts) ? artifacts : []).map(String),
    testedBoundaries: (Array.isArray(testedBoundaries) ? testedBoundaries : []).map(String),
    sideEffects: (Array.isArray(sideEffects) ? sideEffects : []).map(String),
    revokeNow,
    keepable,
    refused,
    deniedKeep,
    /**
     * 自动收割是否已接线。没接的时候界面要按"请你手动点回收"来说，
     * 不能说着"已自动回收"其实什么都没做。
     */
    cascadeImplemented: false,
    note: '临时授权该在这里回收；在收尾钩子接上之前，界面上要如实说"还要你手动收回"',
  };
}

export { GIT_SCOPE_ACTIONS, GIT_SCOPE_LABEL };
