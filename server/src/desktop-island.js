/**
 * 独立桌面（island，规格 §5.6 的 T1 档）的**纯逻辑**部分。
 *
 * 这个文件只回答四件事，全部可穷举测试，不碰系统调用：
 *
 *   1. 这次该用哪一档（T0 程序化 / T1 独立桌面 / T2 共享桌面）；
 *   2. 允许在岛上起什么应用、命令行怎么拼（**不经过 shell**）；
 *   3. 一次点击/一段打字该变成哪几条窗口消息；
 *   4. 截回来的图算不算"看得见"。
 *
 * ## 为什么这四条必须在这里、而不是散在平台层
 *
 * 平台层（`desktop-island-win.js`）只有一种测法：真起一个桌面、真点一下。
 * 那些测试慢、依赖交互会话、在 CI 上还得跳过。而上面四条里，
 * **错任何一条的方向都是"以为做成了"**：
 *
 *   · 静默从 T1 退回 T2 → 任务在用户屏幕上乱点，而日志里看不出来；
 *   · 命令行拼给 shell → `notepad.exe & format` 这种就不再是"起个记事本"；
 *   · 坐标越界还发出去 → 点在目标窗口外面，谁也不知道点到了哪；
 *   · 全黑截帧当成功 → 模型拿着一张黑图开始瞎点（实测真的出现过，见
 *     `docs/WINDOWS-HIDDEN-DESKTOP.md` 的"一个必须承认的不稳定"）。
 *
 * ## 不在这里做的事
 *
 *   · 不判断授权（那是 `grant-gate` + `policy-hook` 的活，按 §6 走）；
 *   · 不做重试策略（那是平台层，因为"要等多久"取决于真窗口）；
 *   · 不碰 DPI —— 岛上的坐标是**目标窗口的客户区坐标**，不是屏幕坐标。
 */

/** 三档 GUI 执行（规格 §5.6）。名字带 T 前缀，日志里一眼能对上规格。 */
export const TIER = Object.freeze({
  /** T0：没有 UI。文件、命令、HTTP、浏览器 CDP/DOM 点击 */
  programmatic: 'T0',
  /** T1：独立 desktop 对象，窗口消息驱动，OS 层面碰不到用户输入 */
  island: 'T1',
  /** T2：用户当前会话的 SendInput —— 会真的动用户的鼠标 */
  shared: 'T2',
});

export const ALL_TIERS = Object.freeze(Object.values(TIER));

/** 失败原因码。调用方据此决定是重试、换档还是交还用户。 */
export const ISLAND_FAIL = Object.freeze({
  /** 这个平台没有等价 API（macOS） */
  notPlatform: 'not_platform',
  /** 目标不存在 / 没有可见窗口 */
  noWindow: 'no_window',
  /** 截回来全黑或尺寸不可信 —— **必须当失败**，不许把图交出去 */
  blankFrame: 'blank_frame',
  /** 目标窗口里没有可打的 Win32 控件（现代合成应用常见） */
  noControl: 'no_control',
  /** 可执行体不在放行名单里 */
  appNotAllowed: 'app_not_allowed',
  /** 参数里出现了 shell 元字符 */
  shellMetachar: 'shell_metachar',
  /** 坐标越界 / 数值不可信 */
  badPoint: 'bad_point',
  /** 文本太长或含代理项以外的非法内容 */
  badText: 'bad_text',
  /** 同一个岛上已有任务在操作（串行） */
  busy: 'island_busy',
});

/**
 * 允许在岛上启动的可执行体（只写 basename，小写）。
 *
 * ★ 为什么是白名单而不是黑名单：
 *   这个工具的能力**就是"以当前用户身份起一个进程"** —— 和 `cmd.exec` 同级。
 *   写黑名单等于放弃，因为绕过方式无穷；写白名单则"加一个应用"必须改代码、
 *   过一次评审、过一遍测试。列表里放的是"有 GUI、且我们真的需要操作它"的东西。
 *
 * ★ 为什么浏览器在里面：岛上的浏览器是**不带用户登录态**的干净实例 ——
 *   需要登录态的抓取走 ego-browser（用户自己的 profile），不需要的两条都行。
 */
export const ISLAND_APPS = Object.freeze([
  'notepad.exe',
  'write.exe',      // WordPad：最稳的 GDI 靶子
  'mspaint.exe',
  'calc.exe',
  'charmap.exe',
  // ★ 刻意**没有** explorer.exe：它能用 `shell:` / `/root,` 这类参数把任意东西
  //   拉起来，等于把白名单整个绕过去（典型的 LOLBin）。要开文件夹窗口的需
  //   求，用一个专门的、参数受约束的工具去做，而不是放一个万能启动器进来。
  'chrome.exe',
  'msedge.exe',
  'firefox.exe',
]);

/**
 * 参数里绝对不许出现的东西。
 *
 * 我们不把命令行交给 shell（`CreateProcess` 直接收），所以这些字符**技术上**
 * 不会被解释。但它们在参数里出现时，几乎总是因为上游把用户/模型给的字符串
 * 当成了一段命令 —— 那种拼接本身就该被拦下来，而不是"反正 shell 不解释"。
 *
 * 顺带挡住 `cmd.exe /c` 这类"用参数启动解释器"的写法：解释器不在白名单里。
 */
const SHELL_META = /[&|<>^;`$\r\n\t]/;

/** 文本上限。一次输入 4000 字已经远超"点开菜单、填个搜索框"的量。 */
export const MAX_TEXT_CHARS = 4_000;

/** 一次点击/打字的坐标上限（客户区坐标，超出说明上游算错了）。 */
const MAX_COORD = 100_000;

/**
 * 这次任务该用哪一档。
 *
 * 顺序是 **T0 → T1 → T2**，判据是"能不能保证不打扰用户"，不是能力多少。
 *
 * ★ 关键：**T1 不可用时不会自动退到 T2**。返回 `tier: null` 加原因，
 *   让调用方去要一次明确授权（或在界面上说"这一步得你同意"）。
 *   静默回退是整个功能里最坏的失败方式：任务在用户的屏幕上动起来，
 *   而所有人以为它跑在后台。
 *
 * @param {object} p
 * @param {boolean} p.needsGui 这件事非得有 GUI 吗（有 CLI/API 就别走 GUI）
 * @param {boolean} [p.islandSupported] 平台有没有等价 API（macOS = false）
 * @param {boolean} [p.islandAuthorized] 有 `desktop.observe` + `desktop.input` 授权
 * @param {boolean} [p.sharedSupported] 同桌面输入可用（会话可交互）
 * @param {boolean} [p.sharedAuthorized] 有 `desktop.input` 授权
 * @returns {{tier:string|null, why:string[], silentFallback:false}}
 */
export function chooseTier({
  needsGui = true,
  islandSupported = false,
  islandAuthorized = false,
  sharedSupported = false,
  sharedAuthorized = false,
} = {}) {
  const why = [];
  if (!needsGui) {
    return { tier: TIER.programmatic, why: ['这件事不需要 GUI：走文件/命令/HTTP/CDP'], silentFallback: false };
  }
  if (islandSupported && islandAuthorized) {
    return { tier: TIER.island, why: ['独立桌面可用且已授权'], silentFallback: false };
  }
  if (!islandSupported) why.push('这个平台没有独立桌面（macOS 无等价 API）');
  else if (!islandAuthorized) why.push('独立桌面没有被授权');
  if (sharedSupported && sharedAuthorized) {
    // 不在这里替用户做这个决定：T2 会动到他的鼠标，必须由调用方明确要一次。
    why.push('同桌面输入可用，但它会动用户的鼠标 —— 需要一次明确的授权/确认');
    return { tier: null, why, silentFallback: false };
  }
  if (!sharedSupported) why.push('同桌面输入不可用（无交互会话）');
  else why.push('同桌面输入没有被授权');
  return { tier: null, why, silentFallback: false };
}

/**
 * 允许在岛上起什么、命令行怎么拼。
 *
 * 只接受 `exe` + `args` 数组，**不接受一整行现成的命令字符串**：
 * 后者没法分辨"哪个词是程序、哪个词是参数"，最后一定会拼给 shell。
 *
 * @returns {{ok:true, commandLine:string, exe:string} | {ok:false, code:string, text:string}}
 */
export function planIslandLaunch({ exe = '', args = [] } = {}) {
  const raw = String(exe ?? '').trim();
  if (!raw) return { ok: false, code: ISLAND_FAIL.appNotAllowed, text: '没给可执行文件' };
  // 只认 basename：允许 `C:\Windows\System32\notepad.exe`，拒绝 `..\..\evil.exe`
  const base = raw.replace(/\\/g, '/').split('/').pop().toLowerCase();
  if (!ISLAND_APPS.includes(base)) {
    return {
      ok: false,
      code: ISLAND_FAIL.appNotAllowed,
      text: `「${base}」不在独立桌面的放行名单里（要加得改代码并过评审）`,
    };
  }
  if (raw.includes('..')) {
    return { ok: false, code: ISLAND_FAIL.appNotAllowed, text: '路径里不许出现 ..' };
  }
  const list = Array.isArray(args) ? args : [];
  const clean = [];
  for (const a of list) {
    const s = String(a ?? '');
    if (SHELL_META.test(s)) {
      return {
        ok: false,
        code: ISLAND_FAIL.shellMetachar,
        text: `参数里出现了 shell 元字符（${s.slice(0, 40)}）—— 这个工具不接命令串，只接参数`,
      };
    }
    if (s.length > 400) return { ok: false, code: ISLAND_FAIL.shellMetachar, text: '单个参数过长' };
    clean.push(s);
  }
  // 引号只用来包住含空格的参数；这里不做 shell 转义，只做最朴素的包裹。
  const quoted = clean.map((s) => (/\s/.test(s) ? `"${s.replace(/"/g, '')}"` : s));
  return {
    ok: true,
    exe: raw,
    commandLine: [`"${raw}"`, ...quoted].join(' '),
  };
}

/** 客户区坐标 → `PostMessage` 的 lParam（低 16 位 x，高 16 位 y）。 */
export function pointToLParam({ x, y } = {}) {
  const nx = Number(x);
  const ny = Number(y);
  if (!Number.isFinite(nx) || !Number.isFinite(ny)) return null;
  const ix = Math.trunc(nx);
  const iy = Math.trunc(ny);
  if (ix < 0 || iy < 0 || ix > MAX_COORD || iy > MAX_COORD) return null;
  return ((iy & 0xffff) << 16) | (ix & 0xffff);
}

const WM_LBUTTONDOWN = 0x0201;
const WM_LBUTTONUP = 0x0202;
const WM_CHAR = 0x0102;
const WM_SETTEXT = 0x000c;

/**
 * 一次操作 → 一串窗口消息。
 *
 * `type` 用 UTF-16 **码元**逐字拆（`WM_CHAR` 收的就是码元，不是码点）：
 * emoji 会被拆成代理对，两个 WM_CHAR —— 这是对的，`Notepad` 和 `RichEdit`
 * 都按码元处理。
 *
 * @param {object} p
 * @param {'click'|'type'|'setText'} p.kind
 * @param {{x:number,y:number}} [p.point] click 用
 * @param {string} [p.text] type/setText 用
 * @param {{width:number,height:number}} [p.clientSize] 给了就当越界校验用
 */
export function planIslandMessages({ kind, point = null, text = '', clientSize = null } = {}) {
  if (kind === 'click') {
    if (!point) return { ok: false, code: ISLAND_FAIL.badPoint, text: '缺坐标' };
    const lp = pointToLParam(point);
    if (lp == null) {
      return { ok: false, code: ISLAND_FAIL.badPoint, text: `坐标不合法：${point.x},${point.y}` };
    }
    if (clientSize) {
      const w = Number(clientSize.width);
      const h = Number(clientSize.height);
      if (!(w > 0) || !(h > 0)) {
        return { ok: false, code: ISLAND_FAIL.badPoint, text: '客户区尺寸不可信' };
      }
      if (Number(point.x) >= w || Number(point.y) >= h) {
        return {
          ok: false,
          code: ISLAND_FAIL.badPoint,
          text: `坐标 ${point.x},${point.y} 在窗口外（客户区 ${w}x${h}）—— 会点在别的东西上`,
        };
      }
    }
    return {
      ok: true,
      ops: [
        { msg: 'WM_LBUTTONDOWN', code: WM_LBUTTONDOWN, wParam: 1, lParam: lp },
        { msg: 'WM_LBUTTONUP', code: WM_LBUTTONUP, wParam: 0, lParam: lp },
      ],
    };
  }

  if (kind === 'type' || kind === 'setText') {
    const s = String(text ?? '');
    if (!s) return { ok: false, code: ISLAND_FAIL.badText, text: '没有要输入的文字' };
    if (s.length > MAX_TEXT_CHARS) {
      return { ok: false, code: ISLAND_FAIL.badText, text: `一次输入上限 ${MAX_TEXT_CHARS} 字` };
    }
    if (kind === 'setText') {
      // WM_SETTEXT 一次性替换控件内容（比逐字打快，且不依赖焦点）
      return { ok: true, ops: [{ msg: 'WM_SETTEXT', code: WM_SETTEXT, text: s }] };
    }
    const ops = [];
    for (let i = 0; i < s.length; i += 1) {
      ops.push({ msg: 'WM_CHAR', code: WM_CHAR, wParam: s.charCodeAt(i), lParam: 0 });
    }
    return { ok: true, ops };
  }

  return { ok: false, code: ISLAND_FAIL.badText, text: `不认识的操作：${kind}` };
}

/**
 * 截回来的图算不算"看得见"。
 *
 * ★ 这条规则是**实测逼出来的**：同一台机器上同一个记事本，取帧出现过
 *   一次全黑（`dark_ratio=1.000`）和六次正常（`0.025`），原因没查清。
 *   所以不能假设"截得到"，只能**判**：黑就重试，还黑就报失败。
 *
 * 阈值取 0.98 而不是 0.9：纯文字窗口（黑色终端、深色主题）本来就大面积很暗，
 * 卡太严会把正常的深色界面判成失败。
 *
 * @param {object} p
 * @param {number} p.darkRatio 暗像素占比 0..1
 * @param {number} p.width
 * @param {number} p.height
 * @param {number} [p.minDimension] 小于这个边长就认为窗口没画出来，默认 80
 */
export function captureVerdict({ darkRatio = 1, width = 0, height = 0, minDimension = 80 } = {}) {
  const w = Number(width);
  const h = Number(height);
  if (!(w >= minDimension) || !(h >= minDimension)) {
    return {
      ok: false,
      code: ISLAND_FAIL.blankFrame,
      text: `截到的图只有 ${w}x${h}，窗口多半还没画出来`,
    };
  }
  const dr = Number(darkRatio);
  if (!Number.isFinite(dr)) {
    return { ok: false, code: ISLAND_FAIL.blankFrame, text: '没算出暗像素占比，不敢当成功' };
  }
  if (dr > 0.98) {
    return {
      ok: false,
      code: ISLAND_FAIL.blankFrame,
      text: '截到的是一片全黑（现代合成应用常见），不能拿这张图去判断界面',
    };
  }
  return { ok: true, darkRatio: dr };
}

/**
 * T1 档**给不了的**东西（规格 §5.6 硬要求 2）。
 *
 * 这些话要出现在给用户的说明里，而不是只写在文档里：
 * 用户看到"在独立桌面上跑"，最容易误以为那是沙箱。
 */
export const ISLAND_LIMITS = Object.freeze([
  '独立桌面隔的是窗口和输入，不是权限：里面的程序仍以你的身份读写同一份文件、走同一张网卡',
  '它截不到你没授权观察的窗口；现代合成应用可能截成黑帧，那时会如实报失败，不会硬点',
  'macOS 没有等价 API，那边只能上虚拟机，或者退回"动你鼠标"的那一档',
  '它不会替你登录：岛上是干净的浏览器/应用，没有你现在的登录态',
]);

/** 给诊断/审计用的一句话。 */
export function describeTier(tier) {
  switch (tier) {
    case TIER.programmatic:
      return 'T0 程序化：文件/命令/HTTP，不碰界面';
    case TIER.island:
      return 'T1 独立桌面：在自己的 desktop 里跑，OS 层面碰不到用户输入';
    case TIER.shared:
      return 'T2 共享桌面：直接打进用户当前会话（会移动用户的指针）';
    default:
      return '未选定档位';
  }
}
