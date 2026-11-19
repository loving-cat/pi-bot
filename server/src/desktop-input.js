/**
 * 桌面输入的**纯逻辑**部分：动作怎么规划、坐标怎么换算、键怎么认。
 *
 * 对应规格 `architecture-permissions-v1.0.1` §5.2 / §5.4 的输入层。
 * 这个文件不碰平台、不发输入、不读时钟 —— 平台调用在
 * `desktop-input-win.js`（Windows）里，判定在 `desktop-lease.js` 与
 * `desktop-takeover.js` 里。
 *
 * ## 为什么把"规划"和"发送"分开
 *
 * 输入这一步一旦发出去就收不回来：点错了就是点了。所以顺序是
 *
 * ```
 * 规划（纯函数，可穷举测试） → 发送（平台调用，一次）
 * ```
 *
 * 规划层负责把一切能在发之前发现的问题拦下来：
 *
 * | 拦什么 | 为什么必须在发之前 |
 * |---|---|
 * | 屏幕外的坐标 | 布局变了（拔了外接屏、改了分辨率），旧坐标会点到别处 |
 * | 不认识的键 | 猜一个键码 = 在用户文档里乱打 |
 * | 拖拽路径 | 一步到位等于"瞬移"：多数应用认不出，且中途没法中断 |
 * | 超长的连点 | 一次 20 下点击会把界面点穿 |
 *
 * 发送层拿到的是已经核对过的计划，它只做一件事：照着发。
 *
 * ## ★ 坐标是物理像素，不是逻辑像素
 *
 * 本机实测（2560x1440 / 125% 缩放 / 同一台机器）：
 *
 * ```
 * 进程未声明 DPI 感知 → SystemInformation.VirtualScreen = 2048x1152
 * 进程声明 Per-Monitor V2 → 同上接口 = 2560x1440
 * ```
 *
 * Win32 的 `SetCursorPos` / `SendInput` 认的是**物理**像素。没声明感知的
 * 进程拿到的是被系统缩小的逻辑坐标，两者差 25%（2048 → 2560），
 * 整屏偏移，而且**不报错**。所以：
 *
 *   · 这个文件只处理物理像素，不做任何缩放换算；
 *   · 平台层发输入前必须先 `SetProcessDpiAwarenessContext(-4)`，
 *     拿不到就**不发**（宁可这一轮干不了，也不能点到别处）。
 *
 * 把缩放换算写进这一层是错的：一旦这里也做除法，声明失败时就变成
 * "两次缩放抵消一半"，错得更隐蔽。
 */

/** 拒绝/失败原因码。上层据此决定是提示、排队、还是交还用户。 */
export const INPUT_FAIL = Object.freeze({
  /** 当前平台没有实现 */
  notPlatform: 'not_platform',
  /** DPI 感知声明失败 —— 坐标不可信，**不敢发** */
  notAware: 'not_dpi_aware',
  /** 目标坐标在屏幕外（布局变过） */
  outOfScreen: 'out_of_screen',
  /** 没有可操作会话（锁屏 / 断开 / 安全桌面） */
  noSession: 'no_session',
  /** 参数不合法 / 不认识的动作或键 */
  invalid: 'invalid',
  /** 平台调用本身失败 */
  callFailed: 'call_failed',
  /** 探针不可用（拿不到最后输入时间） */
  probeUnavailable: 'probe_unavailable',
  /** 这一轮被用户接管了 */
  yielded: 'yielded',
});

/**
 * 支持的动作。
 *
 * `drag` 在这里：按下—分步移动—抬起算**一个动作**，由平台层在一次调用里连着走完
 * （`desktop-input-win.js` 的 `performDrag`），中途每一步都可能被中断 —— 中断时
 * 必须先把左键松开再退出，见 `planDragPath` 的说明。
 *
 * `drag_drop` 不做别名：OLE 拖放（跨进程 DnD）跟鼠标事件不是一回事。
 */
export const INPUT_ACTIONS = Object.freeze([
  'move', 'click', 'scroll', 'key', 'keyCombo', 'type_text', 'drag',
]);

/** 一次拖拽最多分几步（再多就是 40 次平台调用，慢得没意义）。 */
export const MAX_DRAG_STEPS = 40;

/** 一次拖拽最长距离（物理像素）。超过就先重新观察、分两次拖。 */
export const MAX_DRAG_DISTANCE = 2400;

/** 每步之间最少隔多久（毫秒）—— 给目标窗口处理 WM_MOUSEMOVE 的时间。 */
export const DRAG_STEP_MS = 12;

/**
 * 规划一条拖拽路径：起点 → 分步直线 → 终点。
 *
 * ## 为什么必须分步，不能"一步到位"
 *
 * `SetCursorPos(终点)` 一次跳过去，目标窗口收到的是**一个** `WM_MOUSEMOVE`，
 * 中间没有轨迹。两类实测后果：
 *
 * | 场景 | 一步到位的表现 |
 * |---|---|
 * | 文件列表 / 时间轴滑块 | 拖不动，或只跳到终点不触发拖拽语义 |
 * | 拖到一半用户接管 | 我们**没法停**——输入已经发出去了 |
 *
 * 所以路径是**离散的一串点**，平台层一段一段走，每段之间回来问一次"还要继续吗"。
 *
 * ## 为什么终点必须精确
 *
 * 中间点取整可以有误差（最多 1 像素，看不出），但最后一个点必须**逐像素等于**
 * 调用方给的终点：拖到"差不多那里"在画布 / 滑块上是可累积的偏移。
 *
 * ## 为什么最少 3 步
 *
 * 1~2 个移动事件不足以让多数应用进入拖拽状态（按下后立即抬起会被当点击）。
 * 3 步是最低门槛，实际按「每 120 像素一步」自适应。
 *
 * @param {object} p
 * @param {{x:number,y:number}} p.from 起点（物理像素）
 * @param {{x:number,y:number}} p.to 终点（物理像素）
 * @param {number|null} [p.steps] 步数，不传就按距离自适应
 * @param {number} [p.stepMs] 每步间隔毫秒（默认 `DRAG_STEP_MS`）
 * @returns {{ok:true, path:object} | {ok:false, code:string, text:string}}
 */
export function planDragPath({ from, to, steps = null, stepMs = DRAG_STEP_MS } = {}) {
  const f = { x: Number(from?.x), y: Number(from?.y) };
  const t = { x: Number(to?.x), y: Number(to?.y) };
  if (![f.x, f.y, t.x, t.y].every(Number.isFinite)) {
    return { ok: false, code: INPUT_FAIL.invalid, text: '拖拽要给起点和终点两个坐标' };
  }
  const dx = t.x - f.x;
  const dy = t.y - f.y;
  // 用最大轴距离：鼠标每步位移由较大的那个轴决定，欧氏距离会让斜向拖拽步数偏多
  const distance = Math.max(Math.abs(dx), Math.abs(dy));
  if (distance === 0) {
    return { ok: false, code: INPUT_FAIL.invalid, text: '起点和终点是同一个点（拖拽至少要移动 1 像素）' };
  }
  if (distance > MAX_DRAG_DISTANCE) {
    return {
      ok: false,
      code: INPUT_FAIL.invalid,
      text: `一次最多拖 ${MAX_DRAG_DISTANCE} 像素（这次 ${distance}）—— 分两次拖，中间重新观察一次`,
    };
  }
  const auto = Math.ceil(distance / 120);
  const want = steps === null || steps === undefined ? auto : Math.trunc(Number(steps));
  if (!Number.isFinite(want)) {
    return { ok: false, code: INPUT_FAIL.invalid, text: '步数必须是一个数字' };
  }
  const n = Math.min(MAX_DRAG_STEPS, Math.max(3, want));
  const gap = Math.min(200, Math.max(5, Math.trunc(Number(stepMs)) || DRAG_STEP_MS));

  const stops = [];
  let prev = f;
  for (let i = 1; i <= n; i += 1) {
    // ★ 最后一步**精确落在调用方给的终点上**，不做插值取整
    const p = i === n
      ? { x: t.x, y: t.y }
      : { x: Math.round(f.x + (dx * i) / n), y: Math.round(f.y + (dy * i) / n) };
    // 取整后可能和上一站重合（短距离 + 多步），重合点不发 —— 发了也只是一次原地移动
    if (p.x === prev.x && p.y === prev.y) continue;
    stops.push(p);
    prev = p;
  }
  if (!stops.length) {
    return { ok: false, code: INPUT_FAIL.invalid, text: '路径取整后没有产生任何移动（起点和终点太近）' };
  }
  return {
    ok: true,
    path: {
      from: f, to: t, stops, steps: stops.length, stepMs: gap, distance,
    },
  };
}

/** 一次动作最多连点几下（防"把界面点穿"）。 */
export const MAX_CLICKS = 3;

/** 一次滚轮最多几格（防"一脚滚到底"）。 */
export const MAX_SCROLL_NOTCHES = 10;

/** 一次输入文本最多多少字符（防把整篇文档粘进去）。 */
export const MAX_TEXT_CHARS = 4_000;

/** 鼠标键名 → 平台无关的语义。 */
export const BUTTONS = Object.freeze(['left', 'right', 'middle']);

/**
 * 虚拟键码表（Windows 语义，但键名是平台无关的）。
 *
 * 只登记**常用且意义确定**的键。故意不做"任意字符 → 键码"的映射：
 * 那要靠键盘布局表，做半套会在中文输入法下乱打。要输入文字就走 `type_text`。
 */
const VK = Object.freeze({
  ctrl: 0x11, control: 0x11, shift: 0x10, alt: 0x12, win: 0x5b, meta: 0x5b,
  enter: 0x0d, return: 0x0d, tab: 0x09, esc: 0x1b, escape: 0x1b,
  space: 0x20, backspace: 0x08, delete: 0x2e, del: 0x2e, insert: 0x2d,
  left: 0x25, up: 0x26, right: 0x27, down: 0x28,
  home: 0x24, end: 0x23, pageup: 0x21, pagedown: 0x22,
  f1: 0x70, f2: 0x71, f3: 0x72, f4: 0x73, f5: 0x74, f6: 0x75,
  f7: 0x76, f8: 0x77, f9: 0x78, f10: 0x79, f11: 0x7a, f12: 0x7b,
  // 组合键里最常用的几个单字母（ctrl+v 粘贴、ctrl+s 保存、ctrl+f 查找…）
  a: 0x41, c: 0x43, f: 0x46, s: 0x53, v: 0x56, x: 0x58, z: 0x5a,
  ...Object.fromEntries('0123456789'.split('').map((d, i) => [d, 0x30 + i])),
});

/**
 * 键名 → 虚拟键码；不认识返回 0。
 *
 * 只认单字母（A-Z）与小写键名。多字符的字符串不会被猜成"按顺序打"——
 * 那是 `type_text` 的活，猜错会在用户文档里乱打字。
 */
export function vkCode(name) {
  const k = String(name ?? '').trim().toLowerCase();
  if (!k) return 0;
  if (VK[k]) return VK[k];
  if (k.length === 1) {
    const c = k.toUpperCase().charCodeAt(0);
    if (c >= 0x41 && c <= 0x5a) return c;
  }
  return 0;
}

/** 一个点是不是在屏幕矩形里（左闭右开，与 Win32 一致）。 */
export function insideScreen({ point, screen } = {}) {
  if (!point || !screen) return false;
  const x = Number(point.x);
  const y = Number(point.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
  const sx = Number(screen.x) || 0;
  const sy = Number(screen.y) || 0;
  const w = Number(screen.width) || 0;
  const h = Number(screen.height) || 0;
  if (!(w > 0 && h > 0)) return false;
  return x >= sx && x < sx + w && y >= sy && y < sy + h;
}

/**
 * 把物理坐标夹/拒到屏幕内。
 *
 * 刻意**不做静默夹取**：坐标落到屏幕外说明"我们记的布局和现在的布局不一样"，
 * 夹到边缘然后点下去，等于在错误的元素上点。规格 §5.4 原话是
 * 「布局变化使旧坐标失效」—— 失效就该拒绝，让上层重新观察一次。
 */
export function checkPoint({ point, screen } = {}) {
  if (!point) return { ok: false, code: INPUT_FAIL.invalid, text: '没有给目标坐标' };
  if (!insideScreen({ point, screen })) {
    const size = screen ? `${screen.width}x${screen.height}` : '未知';
    return {
      ok: false,
      code: INPUT_FAIL.outOfScreen,
      text: `目标点 (${point.x},${point.y}) 不在当前屏幕 ${size} 内 —— 布局变过，先重新观察一次`,
    };
  }
  return { ok: true, point: { x: Math.round(Number(point.x)), y: Math.round(Number(point.y)) } };
}

/**
 * 规划一次输入：**发之前**把能查的都查掉。
 *
 * @param {object} p
 * @param {string} p.action move / click / drag / scroll / key / keyCombo / type_text
 * @param {{x:number,y:number}} [p.point] 物理像素坐标（drag 时是**起点**）
 * @param {{x:number,y:number}} [p.to] drag 的终点（物理像素）
 * @param {number} [p.steps] drag 分几步走
 * @param {number} [p.stepMs] drag 每步间隔毫秒
 * @param {{x:number,y:number,width:number,height:number}} p.screen 当前屏幕矩形（平台层探到的）
 * @param {'left'|'right'|'middle'} [p.button]
 * @param {number} [p.clicks]
 * @param {number} [p.delta] 滚轮格数（正 = 向上）
 * @param {string} [p.key]
 * @param {string[]} [p.keyCombo]
 * @param {string} [p.text]
 * @returns {{ok:true, plan:object} | {ok:false, code:string, text:string}}
 */
export function planInput({
  action, point = null, screen = null, button = 'left', clicks = 1,
  delta = 0, key = null, keyCombo = null, text = '', to = null, steps = null, stepMs = null,
} = {}) {
  const act = String(action ?? '').trim();
  if (!act) return { ok: false, code: INPUT_FAIL.invalid, text: '没说要做什么（action）' };
  if (act === 'drag_drop') {
    // OLE 拖放不是鼠标事件：要起拖放源、拿 IDataObject、跳进程投递，
    // 这里只做鼠标层面的"按住拖过去再松开"，所以不做这个别名。
    return {
      ok: false,
      code: INPUT_FAIL.invalid,
      text: '没有 drag_drop 这个动作：鼠标拖拽用 drag（给起点 + 终点）；跳进程拖放（OLE）不支持',
    };
  }
  if (!INPUT_ACTIONS.includes(act)) {
    return {
      ok: false,
      code: INPUT_FAIL.invalid,
      text: `不认识的动作「${act}」（支持 ${INPUT_ACTIONS.join(' / ')}）`,
    };
  }
  if (!screen || !(Number(screen.width) > 0)) {
    // 没有屏幕基准就发输入 = 闭眼点。这一条必须排在坐标检查前面。
    return { ok: false, code: INPUT_FAIL.invalid, text: '没有屏幕基准（先探一次环境：锁屏/无会话时也会走到这里）' };
  }
  const needPoint = act === 'move' || act === 'click';
  if (needPoint) {
    const chk = checkPoint({ point, screen });
    if (!chk.ok) return chk;
    point = chk.point;
  }
  if (act === 'click') {
    if (!BUTTONS.includes(String(button))) {
      return { ok: false, code: INPUT_FAIL.invalid, text: `不认识的鼠标键「${button}」（支持 ${BUTTONS.join(' / ')}）` };
    }
    // ★ 不能写成 `Number(clicks) || 1`：那样显式传 0 会被**静默改成 1**，
    //   调用方以为“什么都没点”，实际点了一下。参数不合法就要报错。
    const n = clicks === undefined || clicks === null ? 1 : Math.trunc(Number(clicks));
    if (!Number.isFinite(n) || n < 1) return { ok: false, code: INPUT_FAIL.invalid, text: '连点次数必须是 ≥ 1 的整数' };
    if (n > MAX_CLICKS) {
      return { ok: false, code: INPUT_FAIL.invalid, text: `一次最多连点 ${MAX_CLICKS} 下（要更多就分几次，中间重新观察）` };
    }
    return { ok: true, plan: { action: 'click', point, button: String(button), clicks: n, screen } };
  }
  if (act === 'move') return { ok: true, plan: { action: 'move', point, screen } };

  if (act === 'drag') {
    if (!to) {
      return { ok: false, code: INPUT_FAIL.invalid, text: '拖拽要给终点（to：拖到哪个坐标）；起点用 point' };
    }
    // 起点和终点**都要**在屏幕内：只查终点等于允许"从屏幕外飞进来"，
    // 那中途的轨迹会落在屏幕上别的地方。
    const a = checkPoint({ point, screen });
    if (!a.ok) return a;
    const b = checkPoint({ point: to, screen });
    if (!b.ok) return b;
    const path = planDragPath({ from: a.point, to: b.point, steps, stepMs: stepMs ?? DRAG_STEP_MS });
    if (!path.ok) return path;
    return {
      ok: true,
      plan: {
        action: 'drag',
        button: String(button),
        from: path.path.from,
        to: path.path.to,
        stops: path.path.stops,
        steps: path.path.steps,
        stepMs: path.path.stepMs,
        screen,
      },
    };
  }
  if (act === 'scroll') {
    const n = Math.trunc(Number(delta) || 0);
    if (!n) return { ok: false, code: INPUT_FAIL.invalid, text: 'scroll 要给 delta（正数向上，负数向下）' };
    if (Math.abs(n) > MAX_SCROLL_NOTCHES) {
      return {
        ok: false,
        code: INPUT_FAIL.invalid,
        text: `一次最多滚 ${MAX_SCROLL_NOTCHES} 格（要更多就分几次，每滚一段重新观察）`,
      };
    }
    // 滚动可以带坐标（先把鼠标移过去再滚），也可以不带（在当前位置滚）
    let at = null;
    if (point) {
      const chk = checkPoint({ point, screen });
      if (!chk.ok) return chk;
      at = chk.point;
    }
    return { ok: true, plan: { action: 'scroll', point: at, delta: n, screen } };
  }
  if (act === 'key' || act === 'keyCombo') {
    const keys = act === 'key' ? [String(key ?? '')] : (Array.isArray(keyCombo) ? keyCombo.map(String) : []);
    const trimmed = keys.map((k) => k.trim()).filter(Boolean);
    if (!trimmed.length) {
      return { ok: false, code: INPUT_FAIL.invalid, text: act === 'key' ? 'key 要给键名' : 'keyCombo 要给一组键（如 ["ctrl","v"]）' };
    }
    if (trimmed.length > 4) {
      return { ok: false, code: INPUT_FAIL.invalid, text: `组合键最多 4 个（给了 ${trimmed.length} 个，键盘也按不过来）` };
    }
    const codes = [];
    for (const k of trimmed) {
      const c = vkCode(k);
      if (!c) return { ok: false, code: INPUT_FAIL.invalid, text: `不认识的键「${k}」（要输入文字请用 type_text）` };
      codes.push(c);
    }
    return {
      ok: true,
      plan: { action: act === 'key' ? 'key' : 'keyCombo', keys: trimmed, codes, screen },
    };
  }
  // type_text
  const body = String(text ?? '');
  if (!body) return { ok: false, code: INPUT_FAIL.invalid, text: 'type_text 要给文字' };
  if (body.length > MAX_TEXT_CHARS) {
    return {
      ok: false,
      code: INPUT_FAIL.invalid,
      text: `一次最多输入 ${MAX_TEXT_CHARS} 字（给了 ${body.length}）—— 长文本分几段，每段之间重新确认焦点`,
    };
  }
  return { ok: true, plan: { action: 'type_text', text: body, screen } };
}

/**
 * 把要输入的文字转义成能安全嵌进 PowerShell 双引号字符串的形式。
 *
 * ★ 这不是"顺手防注入"，是**必须**：文字来自模型，里面完全可能有
 *   `` ` `` `$` `"` 这些 PS 里能改变语义的字符。一次没转义，
 *   整段脚本就变成"执行模型写的东西" —— 那就等于把 shell 交给了它。
 *
 * 反引号必须在最前面换（否则后面换出来的反引号又会被当成转义符）。
 */
export function escapeForPsDoubleQuotes(text) {
  return String(text ?? '')
    .replace(/`/g, '``')
    .replace(/\$/g, '`$')
    .replace(/"/g, '`"');
}

/**
 * 判断采样到的「输入噪声」属于哪一种（纯逻辑，平台只负责采样）。
 *
 * ## 为什么要区分三种，而不是一句"有输入"
 *
 * `GetLastInputInfo` 只说"最后一次输入发生在什么时候"，它分不清：
 *
 * | 情况 | 证据 | 该怎么办 |
 * |---|---|---|
 * | 真有人在用 | 输入很新 **且** 光标在动 | 让开（那是用户） |
 * | 有别的东西在合成输入 | 输入一直很新 **但** 光标不动 | 让开，并且**告诉用户是谁** |
 * | 有人远程在操作 | 输入很新 **且** 光标在动 | 让开（等同"真有人在用"） |
 *
 * 本机实测的合成输入源是远程控制工具的心跳：它不断重置最后输入时间，
 * 但从不移动光标。如果只判"输入新"，结论会是"用户正在动"，用户会以为
 * 自己碰了鼠标 —— 排查方向就错了。
 *
 * @param {object} p
 * @param {number[]} p.gaps 每次采样的 `idleMs`
 * @param {Array<{x:number,y:number}>} [p.cursors] 每次采样的光标位置
 * @param {number} [p.quietMs] 多新算"刚刚"
 * @returns {{kind:'quiet'|'phantom'|'moving', noisy:boolean, cursorStill:boolean}}
 */
export function classifyInputNoise({ gaps = [], cursors = [], quietMs = 250 } = {}) {
  const list = (Array.isArray(gaps) ? gaps : []).map((g) => Math.max(0, Number(g) || 0));
  if (!list.length) return { kind: 'quiet', noisy: false, cursorStill: true };
  const tight = list.filter((g) => g < Math.max(1, Number(quietMs) || 250)).length;
  // 多数采样都"刚刚有输入"才算噪声：人不会以毫秒精度连续动，但采样也会被
  // 系统拖慢，所以用"多数"抗住偶发的调度抖动。
  const noisy = tight * 2 > list.length;
  const pts = Array.isArray(cursors) ? cursors.filter(Boolean) : [];
  const cursorStill = pts.length < 2
    ? true
    : pts.every((c) => c.x === pts[0].x && c.y === pts[0].y);
  if (!noisy) return { kind: 'quiet', noisy: false, cursorStill };
  return { kind: cursorStill ? 'phantom' : 'moving', noisy: true, cursorStill };
}

/** 平台无关的动作摘要（审计/日志用，不含输入内容原文）。 */
export function describePlan(plan) {
  if (!plan) return '(空计划)';
  const at = plan.point ? ` @${plan.point.x},${plan.point.y}` : '';
  switch (plan.action) {
    case 'move': return `移动鼠标${at}`;
    case 'drag': {
      const from = plan.from ? `(${plan.from.x},${plan.from.y})` : '';
      const to = plan.to ? `(${plan.to.x},${plan.to.y})` : '';
      const held = plan.button === 'right' ? '右键' : plan.button === 'middle' ? '中键' : '左键';
      return `按住${held}从 ${from} 拖到 ${to}（${plan.steps} 步）`;
    }
    case 'click': return `${plan.button} 键点 ${plan.clicks} 下${at}`;
    case 'scroll': return `滚轮 ${plan.delta > 0 ? '上' : '下'} ${Math.abs(plan.delta)} 格${at}`;
    case 'key': return `按键 ${plan.keys.join('')}`;
    case 'keyCombo': return `组合键 ${plan.keys.join('+')}`;
    case 'type_text': return `输入文字 ${plan.text.length} 字`;
    default: return String(plan.action);
  }
}

/**
 * 平台状态表（写进文档时用它，别手写"应该可以"）。
 *
 * @param {string} platform `process.platform`
 */
export function describePlatform(platform) {
  if (platform === 'win32') {
    return {
      platform,
      supported: true,
      verified: '本机 Windows 11 / 2560x1440 / 125% 缩放（见 docs/WINDOWS.md）',
      actions: [...INPUT_ACTIONS],
      unsupported: ['drag'],
      probe: 'GetLastInputInfo + GetTickCount64',
    };
  }
  if (platform === 'darwin') {
    // ★ 照实标 false。macOS 实现现在是空壳（desktop-input-mac.js），
    //   每个入口返回 not_platform。改成 true 的唯一时机是：
    //   docs/MACOS-DESKTOP-INPUT.md 的验收清单全部实机跑过。
    return {
      platform,
      supported: false,
      verified: null,
      actions: [],
      unsupported: ['全部（空壳实现已就位，待填）'],
      probe: 'CGEventSourceSecondsSinceLastEventType（未实现）',
      todo: 'docs/MACOS-DESKTOP-INPUT.md',
    };
  }
  return { platform, supported: false, verified: null, actions: [], unsupported: ['全部'], probe: null };
}
