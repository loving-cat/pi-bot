/**
 * macOS 桌面输入实现 —— 薄包装，真正的平台调用在原生助手 `orbis-desktop-mac` 里。
 *
 * ## 为什么是原生二进制而不是 osascript
 *
 * macOS 没有 `powershell` 那种"一条命令办完事"的通道。osascript（JXA）能调 ObjC，
 * 但每次启动 ~200ms、发不了高频 CGEvent、对 CoreGraphics 的支持也不全。
 * 桌面输入要"先移到位、复核、再点击"，这是高频且要求精确的活，只能走原生。
 *
 * 助手源码在 `native/orbis-desktop-mac/`（Swift，零第三方依赖，只链接系统框架）。
 * 构建：`./scripts/build-desktop-mac.sh`。
 *
 * ## 坐标单位：点（points），左上角原点
 *
 *   `CGDisplayBounds` / `CGEventGetLocation` / `CGEventCreateMouseEvent` 是同一套坐标。
 *   Retina 上 1 点 = 2 像素，**但全程只用点**，不乘 2。
 *   `dpi` 字段填 `scale × 96`（Retina = 192）只为与 Windows 的返回形状对齐，
 *   任何逻辑都不拿它换算。
 *
 * ## 实机结论（macOS 15.5 / 2560x1440 / 1x 缩放 / Apple Silicon）
 *
 *   · `CGWarpMouseCursorPosition` 落位误差 **0.0 点**（5 个目标点 5/5 精确）——
 *     所以容差用 0.5，只吸收浮点抖动。Windows 那边的 24px 在 macOS 上不成立，
 *     照抄只会掩盖真问题。
 *   · `CGEventSourceSecondsSinceLastEventType` 返回**真实秒数**（不是 0 / -1）。
 *   · 组合键必须"真的按下修饰键再按主键"：只给主键设 flags 会被当成打了一个字母。
 *   · `type_text` 走剪贴板 + **cmd+V**；目标窗口必须有 Edit 菜单，否则 cmd+V
 *     不会变成 paste: 动作（实机复现：加菜单前文本框收不到，加完立刻正常）。
 *   · **不要用 `pbcopy` 传非 ASCII**：本机 C/POSIX locale 下它会静默写成空串，
 *     必须用 NSPasteboard（助手内部就是这么做的）。
 *   · `AXUIElementCreateSystemWide()` + `kAXFocusedApplicationAttribute` 在这里
 *     返回 -25204（kAXErrorCannotComplete），拿不到前台应用；改用
 *     `NSWorkspace.frontmostApplication` + 按 pid 的 AX 查询。
 *
 * ## 授权
 *
 * 辅助功能没开时 `CGEventPost` **静默丢弃**，我们会以为发出去了。
 * 所以 `perform` 在助手侧第一件事就是 `AXIsProcessTrusted()`，不给就返回
 * `not_authorized` 并说清去哪个设置页开。**不自动弹授权窗、不重试** ——
 * 规格要求「不请求绕过系统保护，明确交还用户」。
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { INPUT_FAIL, classifyInputNoise } from './desktop-input.js';
import { normalizeProbe } from './desktop-takeover.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** 助手协议版本。助手 `version` 子命令会回这个数。 */
export const HELPER_PROTOCOL = 1;

/** 助手可能的位置，按优先级。 */
export function helperCandidates() {
  const out = [];
  const env = (process.env.ORBIS_DESKTOP_MAC_BIN || '').trim();
  if (env) out.push(env);
  // 发行包：server/resources/orbis-desktop-mac（打包脚本拷进来）
  out.push(path.join(HERE, '..', 'resources', 'orbis-desktop-mac'));
  // 开发仓库：native/orbis-desktop-mac/build/orbis-desktop-mac
  out.push(path.join(HERE, '..', '..', 'native', 'orbis-desktop-mac', 'build', 'orbis-desktop-mac'));
  return out;
}

/** 找到可执行的助手；找不到返回 null。 */
export function resolveHelper() {
  for (const candidate of helperCandidates()) {
    try {
      const st = fs.statSync(candidate);
      if (!st.isFile()) continue;
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch { /* 继续找下一个 */ }
  }
  return null;
}

/** 这个模块在当前平台能不能用：必须是 darwin，且助手二进制在。 */
export function isSupported() {
  if (process.platform !== 'darwin') return false;
  return resolveHelper() !== null;
}

function notPlatform(what) {
  return {
    ok: false,
    code: INPUT_FAIL.notPlatform,
    text: `当前平台（${process.platform}）没有 ${what} 的 macOS 实现`,
  };
}

/**
 * 调一次助手：把请求 JSON 从 stdin 送进去，读 stdout 的 JSON。
 *
 * [run] 可注入，方便在 Windows / Linux CI 上覆盖参数拼装与错误码映射 ——
 * 那两个平台没有助手二进制，但**参数怎么拼、返回值怎么翻译**是可以测的。
 */
function callHelper(command, payload = {}, { run = defaultRun, timeoutMs = 15000 } = {}) {
  // ★ 注入了 runner 就**不要求真实二进制存在**：那是在测"参数怎么拼、
  //   返回值怎么翻译"，不是测助手本身。CI（ubuntu / windows / macos 的干净
  //   clone）上没有构建产物，若这里硬要文件，所有注入用例都会退化成
  //   not_platform，看起来像"平台守卫生效"，实际什么都没验到。
  const injected = run !== defaultRun;
  const helper = resolveHelper() ?? (injected ? 'orbis-desktop-mac' : null);
  if (!helper) {
    return { ok: false, code: INPUT_FAIL.notPlatform, text: '找不到 orbis-desktop-mac（先跑 npm run build:desktop-mac）' };
  }
  let raw;
  try {
    raw = run(helper, [command], JSON.stringify(payload ?? {}), { timeoutMs });
  } catch (err) {
    return { ok: false, code: INPUT_FAIL.callFailed, text: `助手调用失败：${String(err?.message || err).slice(0, 300)}` };
  }
  return parseHelperOutput(raw);
}

/** 默认 runner：同步执行，stdin 写 JSON，stdout 收 JSON。 */
function defaultRun(helper, args, input, { timeoutMs }) {
  return execFileSync(helper, args, {
    input,
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: 4 * 1024 * 1024,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

/** 把助手的 stdout 解析成统一返回；解析不出来就是 call_failed，绝不猜。 */
export function parseHelperOutput(raw) {
  const text = String(raw ?? '').trim();
  if (!text) {
    return { ok: false, code: INPUT_FAIL.callFailed, text: '助手没有输出（可能被系统杀掉或崩溃）' };
  }
  const lastLine = text.split('\n').filter(Boolean).pop() || '';
  let value;
  try {
    value = JSON.parse(lastLine);
  } catch {
    return { ok: false, code: INPUT_FAIL.callFailed, text: `助手输出不是 JSON：${lastLine.slice(0, 200)}` };
  }
  if (!value || typeof value !== 'object') {
    return { ok: false, code: INPUT_FAIL.callFailed, text: '助手返回的不是对象' };
  }
  if (value.ok === true) return value;
  return {
    ok: false,
    code: typeof value.code === 'string' ? value.code : INPUT_FAIL.callFailed,
    text: typeof value.text === 'string' ? value.text : '助手返回了失败但没有说明原因',
  };
}

// ---------------------------------------------------------------- 六个入口

/**
 * 探一次环境：虚拟桌面矩形（**点**）、缩放、有没有可操作会话、授权状态。
 *
 * 每次注入前都要重新调（不缓存）—— 外接屏拔了、分辨率改了、用户锁屏了
 * 都要立刻反映出来。规格 §5.4「布局变化使旧坐标失效」。
 *
 * @returns {{ok:true, screen:{x:number,y:number,width:number,height:number}, dpi:number, session:boolean}
 *   | {ok:false, code:string, text:string}}
 */
export function probeEnvironment({ run } = {}) {
  if (process.platform !== 'darwin') return notPlatform('屏幕环境探测');
  const r = callHelper('probe', {}, { run });
  if (!r.ok) return r;
  const screen = r.screen;
  if (!screen || !(Number(screen.width) > 0) || !(Number(screen.height) > 0)) {
    return { ok: false, code: INPUT_FAIL.callFailed, text: '屏幕尺寸为 0 —— 可能没有登录会话' };
  }
  return {
    ok: true,
    screen: {
      x: Number(screen.x) || 0,
      y: Number(screen.y) || 0,
      width: Number(screen.width),
      height: Number(screen.height),
    },
    dpi: Number(r.dpi) || 96,
    session: r.session === true,
    locked: r.locked === true,
    authorized: r.authorized !== false,
  };
}

/**
 * 读「最后一次输入的时刻」（epoch 毫秒），喂给 `desktop-takeover.js` 的 `classify`。
 *
 * 助手给的是**距最后一次输入多少秒**（`CGEventSourceSecondsSinceLastEventType`），
 * 与 Windows 的"开机 tick"不同 —— 反推 epoch 的换算交给纯逻辑
 * `normalizeProbe({ value, unit: 'agoSeconds' })`，这里不另写一套。
 *
 * ★ 实机结论：macOS 上这个探针**不看辅助功能授权**，返回真实秒数。
 *   但它仍可能返回不可用的值（助手会先挡掉负数/非有限值），那种情况
 *   必须原样上抛 `probe_unavailable` —— 上层要走"保守交还用户"，
 *   绝不能把"探针坏了"当成"用户刚动过"（那样这台机器上永远发不出输入）。
 *
 * @returns {{ok:true, lastInputAt:number, idleMs:number} | {ok:false, code:string, text:string}}
 */
export function lastInputAt({ run, now = Date.now() } = {}) {
  if (process.platform !== 'darwin') return notPlatform('输入探针');
  const r = callHelper('last-input', {}, { run });
  if (!r.ok) return r;
  const ago = Number(r.agoSeconds);
  if (!Number.isFinite(ago) || ago < 0) {
    return { ok: false, code: INPUT_FAIL.probeUnavailable, text: `输入探针返回了不可用的值（${r.agoSeconds}）` };
  }
  const lastInputAtValue = normalizeProbe({ value: ago, unit: 'agoSeconds', now });
  if (lastInputAtValue === null) {
    return { ok: false, code: INPUT_FAIL.probeUnavailable, text: '输入探针的时间换算失败' };
  }
  return { ok: true, lastInputAt: lastInputAtValue, idleMs: Math.max(0, Math.round(ago * 1000)) };
}

/**
 * 把 `planInput()` 给出的计划翻译成助手的请求。
 *
 * ★ 用 `plan.keys`（原始键名），**不用** `plan.codes`（Win32 虚拟键码）。
 *   两者完全不是一回事：Win32 里 v=0x56，macOS 的 CGKeyCode 里 v=0x09。
 *   助手自己有一张全量 CGKeyCode 表，认不出的键直接拒，不猜。
 */
export function toHelperRequest(plan) {
  if (!plan || !plan.action) return null;
  switch (plan.action) {
    case 'move':
      return plan.point ? { action: 'move', point: { x: plan.point.x, y: plan.point.y } } : null;
    case 'click':
      if (!plan.point) return null;
      return {
        action: 'click',
        point: { x: plan.point.x, y: plan.point.y },
        button: plan.button || 'left',
        clicks: Number(plan.clicks) || 1,
      };
    case 'scroll': {
      const req = { action: 'scroll', delta: Number(plan.delta) || 0 };
      // 可选坐标：先把光标移过去再滚。
      //
      // ★ macOS 的滚轮事件发给「鼠标指针下那个窗口」，不先移动就会滚到
      //   光标上次停留的无关窗口 —— 用户在 A 窗口让 bot 看着，bot 滚了 B。
      //   `planInput` 对 scroll 本来就允许带 point（叫 at），这里原样透传。
      if (plan.point) req.point = { x: plan.point.x, y: plan.point.y };
      return req;
    }
    case 'key':
      if (!Array.isArray(plan.keys) || !plan.keys.length) return null;
      return { action: 'key', key: String(plan.keys[0]) };
    case 'keyCombo':
      if (!Array.isArray(plan.keys) || !plan.keys.length) return null;
      return { action: 'keyCombo', keys: plan.keys.map(String) };
    case 'type_text':
      return { action: 'type_text', text: String(plan.text ?? '') };
    case 'drag':
      // 拖拽要按下—分步移动—每步检测接管—中断必松键，本轮没做完实机验证，
      // 所以整条链路一起拒 —— 绝不留半截按着鼠标不放的拖拽。
      return { action: 'drag' };
    default:
      return null;
  }
}

/**
 * 发一个已经规划好的输入。
 *
 * 调用方（工具层）必须先过租约、接管检测、`planInput`。这里**不做判定**，
 * 只负责：翻成助手请求 → 执行 → 把结果翻译回来。
 *
 * [verifyCursor] 由助手实现：移动类动作由助手自己复核光标位置，
 * 没到位就不点击（它返回 `call_failed` 并说明"可能有别的程序在动光标"）。
 *
 * @returns {{ok:true, at:object|null, foreground:string} | {ok:false, code:string, text:string}}
 */
export function perform({ plan, verifyCursor = true, run } = {}) {
  if (process.platform !== 'darwin') return notPlatform('桌面输入');
  const req = toHelperRequest(plan);
  if (!req) return { ok: false, code: INPUT_FAIL.invalid, text: '没有可执行的输入计划' };
  if (req.action === 'scroll' && !req.delta) {
    return { ok: false, code: INPUT_FAIL.invalid, text: '滚动量不能是 0' };
  }
  if (req.action === 'drag') {
    return {
      ok: false,
      code: INPUT_FAIL.invalid,
      text: 'macOS 的拖拽还没有完整实现（按下—移动—抬起的中断恢复未验证），本轮明确不支持',
    };
  }
  const r = callHelper('perform', req, { run });
  if (!r.ok) return r;
  return {
    ok: true,
    at: r.at ?? null,
    foreground: typeof r.foreground === 'string' ? r.foreground : '',
  };
}

/**
 * 读当前光标位置（**点**，左上角原点）。
 *
 * 助手里用 `CGEventGetLocation(CGEventCreate(nil))` —— 与
 * `CGEventCreateMouseEvent` 同一套坐标。**不用** `NSEvent.mouseLocation`
 * （左下原点，y 轴镜像：点窗口顶部会点到同一位置的底部）。
 */
export function cursorPosition({ run } = {}) {
  if (process.platform !== 'darwin') return notPlatform('光标位置读取');
  const r = callHelper('cursor', {}, { run });
  if (!r.ok) return r;
  const x = Number(r.x);
  const y = Number(r.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    return { ok: false, code: INPUT_FAIL.callFailed, text: '助手返回的光标位置不是数字' };
  }
  return { ok: true, x, y };
}

/**
 * 采样一次「输入噪声」：这台 Mac 是不是一直在产生输入。
 *
 * 判据是纯逻辑 `classifyInputNoise()`（平台无关、已测），这里只负责把
 * 「每次采样的 idleMs + 光标位置」凑齐。两个平台共用同一套判断，
 * 不会出现"Windows 判 phantom、macOS 判 moving"这种漂移。
 *
 * 为什么需要：装着远程控制 / 虚拟显示驱动时，探针会一直报"刚刚有人动"，
 * 接管检测于是永远让开 —— macOS 上同类程序（TeamViewer、AnyDesk）一样可能这样。
 */
export function sampleInputNoise({ samples = 5, intervalMs = 120, quietMs = 250, run } = {}) {
  if (process.platform !== 'darwin') return notPlatform('输入噪声采样');
  const n = Math.max(2, Math.min(20, Math.trunc(Number(samples) || 5)));
  const gap = Math.max(20, Math.min(2000, Math.trunc(Number(intervalMs) || 120)));
  const r = callHelper('noise', { samples: n, intervalMs: gap }, { run, timeoutMs: 15000 });
  if (!r.ok) return r;
  const list = Array.isArray(r.samples) ? r.samples : [];
  if (!list.length) {
    return { ok: false, code: INPUT_FAIL.callFailed, text: '助手没有采到样本' };
  }
  const gaps = list.map((s) => Math.max(0, Math.round(Number(s?.idleMs) || 0)));
  const cursors = list.map((s) => ({
    x: Number(s?.cursor?.x) || 0,
    y: Number(s?.cursor?.y) || 0,
  }));
  const cls = classifyInputNoise({ gaps, cursors, quietMs });
  return {
    ok: true,
    kind: cls.kind,
    phantom: cls.kind === 'phantom',
    noisy: cls.noisy,
    cursorStill: cls.cursorStill,
    samples: gaps,
    cursor: cursors[0],
    min: Math.min(...gaps),
    max: Math.max(...gaps),
  };
}

/**
 * 当前前台窗口标题（审计用：记下"动的是哪个窗口"，不记窗口内容）。
 *
 * 没有辅助功能授权时助手只报应用名、不报错 —— 审计允许没有窗口标题。
 */
export function foregroundTitle({ run } = {}) {
  if (process.platform !== 'darwin') return notPlatform('前台窗口标题读取');
  const r = callHelper('foreground', {}, { run });
  if (!r.ok) return r;
  const title = typeof r.title === 'string' ? r.title : '';
  return { ok: true, title: title.slice(0, 200) };
}

/**
 * 一次完整动作的便捷入口：探环境 → 规划 → 发送。
 *
 * 工具层要的通常是这个（它已经把租约和接管检查做完了）。
 *
 * @returns {{ok:true, at:object|null, foreground:string, plan:object, screen:object}
 *   | {ok:false, code:string, text:string}}
 */
export function performAction({ action, point = null, button = 'left', clicks = 1, delta = 0, key = null, keyCombo = null, text = '' } = {}) {
  if (process.platform !== 'darwin') return notPlatform('桌面输入');
  const env = probeEnvironment();
  if (!env.ok) return env;
  if (!env.session) {
    return { ok: false, code: INPUT_FAIL.noSession, text: '当前没有可操作会话（可能锁屏或已断开），交还用户' };
  }
  const planned = planInput({
    action, point, screen: env.screen, button, clicks, delta, key, keyCombo, text,
  });
  if (!planned.ok) return planned;
  const sent = perform({ plan: planned.plan });
  if (!sent.ok) return sent;
  return { ok: true, at: sent.at, foreground: sent.foreground, plan: planned.plan, screen: env.screen };
}

/**
 * 平台状态表（写文档时用它，别手写"应该可以"）。
 *
 * 本机的实测环境写在 `verified` 里；没做的事写进 `unsupported`。
 * 这份表必须和 `desktop-input.js` 的 `describePlatform('darwin')` 说的一致：
 * 一处说"支持"、另一处说"空壳"，上层会按各自看到的版本做不同的事。
 */
export function describePlatform() {
  return {
    platform: 'darwin',
    supported: true,
    verified: 'macOS 15.5 / Apple Silicon (arm64) / 2560x1440 / 1x 缩放（docs/MACOS.md「桌面输入」）',
    actions: ['move', 'click', 'scroll', 'key', 'keyCombo', 'type_text'],
    unsupported: ['drag' ],
    probe: 'CGEventSourceSecondsSinceLastEventType（实机：返回真实秒数，不看辅助功能授权）',
    move: 'CGWarpMouseCursorPosition + CGAssociateMouseAndMouseCursorPosition，改完立即复核；实机落位误差 0.0 点',
    buttons: 'CGEventCreateMouseEvent（left / right / middle，单击 / 双击 / 三击）',
    text: 'NSPasteboard 写入 + cmd+V，等待后还原原剪贴板（目标窗口需有 Edit 菜单）',
    authorization: '辅助功能（AXIsProcessTrusted）；未授权时 CGEventPost 静默丢弃，所以发之前就判',
    knownIssue: '远程控制 / 虚拟显示驱动会让探针一直报"刚刚有人动"，用 sampleInputNoise() 区分' +
      '这种环境与真人操作；type_text 依赖目标窗口的 Edit 菜单，纯画布类应用可能收不到粘贴',
  };
}

