/**
 * macOS 桌面输入 —— **实现槽位**（当前是空壳，所有入口都明确返回"没实现"）。
 *
 * 这个文件存在的唯一目的：把 macOS 的改动区间**隔离**出来。
 * 判定逻辑一行都不用重写 —— 租约、接管检测、动作规划、坐标校验全部是
 * 平台无关的纯逻辑，已经在 `desktop-lease.js` / `desktop-takeover.js` /
 * `desktop-input.js` 里了，而且有 38 项测试守着。
 *
 * ## 要做什么（按这个顺序）
 *
 * 见 `docs/MACOS-DESKTOP-INPUT.md`。一句话：**只实现下面这六个函数**，
 * 签名与返回形状必须和 `desktop-input-win.js` 完全一致，否则装配层接不上。
 *
 * ```
 * probeEnvironment()   → {ok:true, screen:{x,y,width,height}, dpi, session} | {ok:false, code, text}
 * lastInputAt()        → {ok:true, lastInputAt, idleMs} | {ok:false, code, text}
 * perform({plan})      → {ok:true, at, foreground} | {ok:false, code, text}
 * cursorPosition()     → {ok:true, x, y} | {ok:false, code, text}
 * sampleInputNoise()   → {ok:true, kind, noisy, cursorStill, samples, cursor} | {ok:false, ...}
 * foregroundTitle()    → {ok:true, title} | {ok:false, code, text}
 * ```
 *
 * ## 为什么现在是空壳而不是"能跑就行"的半截实现
 *
 * 桌面输入点错了就是点了：删文件、付款、发消息都收不回来。一个"在大部分
 * 情况下能跑"的 macOS 实现比没有更危险 —— 它会让上层以为这条路通了。
 *
 * 所以这里的每个函数都返回 `not_platform`（而不是抛异常、也不是返回成功），
 * 装配层拿到它会走"交还用户"那条路，用户看到的是清楚的"macOS 还没做"。
 *
 * ## 六个函数里，三个必须先在真机上验清楚
 *
 * | 函数 | 为什么必须先验 |
 * |---|---|
 * | `probeEnvironment` | Retina 上 `CGDisplayBounds` 与 `NSScreen.frame` 差 2 倍，用错一个就整屏偏移 |
 * | `lastInputAt` | 没有辅助功能授权时 `CGEventSourceSecondsSinceLastEventType` 返回什么？会不会安静地返回 0？ |
 * | `perform` | 辅助功能授权被拒时 `CGEventPost` 是静默丢弃还是报错？这决定我们能不能"明确交还用户" |
 *
 * 其余三个（`cursorPosition` / `sampleInputNoise` / `foregroundTitle`）
 * 是诊断用的，实现难度低、出错后果也轻。
 */
import { INPUT_FAIL } from './desktop-input.js';

/** 统一返回：这个平台还没有实现。 */
function notImplemented(what) {
  return {
    ok: false,
    code: INPUT_FAIL.notPlatform,
    text: `macOS 的${what}还没实现（见 docs/MACOS-DESKTOP-INPUT.md）`,
  };
}

/** 这个模块在当前平台能不能用。**实现之后改成真正的探测**。 */
export function isSupported() {
  return false;
}

/**
 * 探一次环境：屏幕矩形、缩放、有没有可操作会话。
 *
 * ## 实现要点（踩过的地方都写在 `docs/MACOS-DESKTOP-INPUT.md`）
 *
 * ```objc
 * // ✅ 全用"点"（points）：CGDisplayBounds 与 CGEvent 位置**同一套坐标**
 * CGDirectDisplayID d = CGMainDisplayID();
 * CGRect r = CGDisplayBounds(d);          // 全局显示坐标，单位是**点**
 * size_t px = CGDisplayPixelsWide(d);     // 这个才是物理像素（Retina 上 = 2 × 点）
 *
 * // ❌ 千万不要把 pixels 当成坐标用：拿 CGDisplayPixelsWide 去算位置再发 CGEvent，
 * //    Retina 上会偏移一倍，而且不报错。
 * ```
 *
 * ## ★ 与 Windows 最大的不同：坐标系单位不一样
 *
 * | | Windows | macOS |
 * |---|---|---|
 * | `probeEnvironment().screen` | 物理像素 | **点**（points） |
 * | `perform` 接受的坐标 | 物理像素 | **点** |
 * | 缩放因子 | 125% / 150% 这类百分比 | 1x / 2x（Retina） |
 *
 * 这不是矛盾：**每个平台内部自洽就行**。`planInput()` 的屏幕内校验只要求
 * "坐标与 screen 同一套单位"，它不关心是像素还是点。所以 macOS 全程用点、
 * Windows 全程用像素，各自对得上就对。
 * **千万不要**在 macOS 里再把点乘 2 转成像素 —— 那会两倍偏移。
 *
 * @returns {{ok:true, screen:{x:number,y:number,width:number,height:number}, dpi:number, session:boolean}
 *   | {ok:false, code:string, text:string}}
 *
 * **`screen` 用点（points），不是像素** —— 与 `CGEvent` 位置同一套单位。
 * `dpi` 在 macOS 上填 `scale × 96`（Retina = 192），只为与 Windows 对齐形状；
 * 任何逻辑都不靠它做换算。
 */
export function probeEnvironment() {
  return notImplemented('屏幕环境探测');
}

/**
 * 读「最后一次输入的时刻」（epoch 毫秒），喂给 `desktop-takeover.js`。
 *
 * ## 实现要点
 *
 * ```objc
 * // 返回的是"多少秒前"，与 Windows 的"开机 tick"不同 —— 直接反推 epoch
 * CFTimeInterval ago = CGEventSourceSecondsSinceLastEventType(
 *     kCGEventSourceStateCombinedSessionState, kCGAnyInputEventType);
 * double lastInputAt = nowMs - ago * 1000;
 * ```
 *
 * ## ★ 必须先验一件事：没有辅助功能授权时它返回什么
 *
 * 如果返回 `0`（"刚刚有输入"），接管检测会**永远判定用户在动**，
 * 于是这台 Mac 上永远发不出输入 —— 而错误文案会说"用户在动"，
 * 用户完全不知道该去开权限。本机 Windows 上踩过一模一样的坑
 * （远程控制工具持续合成输入），见 `docs/WINDOWS.md`。
 *
 * 所以实现时要做的第一件事是：**故意不开权限，看返回值**。
 * 如果是 0 或者明显不对，就改成返回 `{ok:false, code:probe_unavailable}`
 * —— 装配层拿到它会走"保守交还用户"那条路，文案才说得对。
 */
export function lastInputAt() {
  return notImplemented('输入探针');
}

/**
 * 发一个已经规划好的输入。
 *
 * `plan` 的形状由 `planInput()` 给出（纯逻辑，已测），不要在这里重新解析参数：
 *
 * ```js
 * plan = { action: 'move'|'click'|'scroll'|'key'|'keyCombo'|'type_text',
 *          point: {x,y}|null,   // **点**（不是像素）
 *          button, clicks,      // click
 *          delta,               // scroll，正=上
 *          keys: ['ctrl','v'],  // ★ macOS 用这个（原始键名）
 *          codes: [vkCode...],  // ⚠ 这是 Windows 虚拟键码，macOS 不要用
 *          text,                // type_text
 *          screen }
 * ```
 *
 * ## ★ `plan.codes` 是 Windows 虚拟键码 —— macOS 必须自己映射
 *
 * `desktop-input.js` 的 `vkCode()` 返回的是 Win32 VK 码（ctrl=0x11、v=0x56）。
 * macOS 用 `CGKeyCode`（一种硬件扫描码），**两者完全不是一回事**。
 *
 * 现在的做法（在 `desktop-input.js` 里已留好位置）：`plan` 同时带
 * `keys: ['ctrl','v']`（原始键名），macOS 侧按 `keys` 自己映射。
 * **不要**去改 `vkCode()` 让它平台化 —— 那会让 Windows 侧跟着变。
 *
 * ## 实现要点
 *
 * ```objc
 * // 鼠标：CGWarpMouseCursorPosition 移动（先移动、复核、再点击，和 Windows 一样）
 * CGWarpMouseCursorPosition(CGPointMake(x, y));
 * CGAssociateMouseAndMouseCursorPosition(true);  // ★ 移动后必须重新关联，
 *                                                //   否则光标会和物理鼠标"脱钩"
 *
 * // 点击：CGEventCreateMouseEvent + CGEventPost(kCGHIDEventTap, e)
 * // 键盘：CGEventCreateKeyboardEvent(src, keyCode, down)
 * // 文字：NSPasteboard（存原内容 → 设新内容 → ⌘V → 还原），和 Windows 一样走剪贴板
 * ```
 *
 * ## ★ 辅助功能授权被拒时怎么办
 *
 * ```objc
 * if (!AXIsProcessTrusted()) {
 *   return { ok: false, code: 'not_authorized',
 *            text: '需要在「系统设置 → 隐私与安全性 → 辅助功能」里授权 pi-bot' };
 * }
 * ```
 *
 * **不要**尝试 `AXIsProcessTrustedWithOptions` 自动弹窗然后静默重试 ——
 * 规格 §5.4 原话是「不请求绕过系统保护；明确交还用户」。
 *
 * ## 复核光标（和 Windows 一致，别省）
 *
 * 本机 Windows 上实测：`SetCursorPos` 之后光标会落在目标附近 3~26 px，
 * 所以 Windows 版做了「容差 24px + 最多重试 3 次 + 没到位绝不点击」。
 * macOS 上 `CGWarpMouseCursorPosition` 通常更精确，但**这个保护不能省** ——
 * 有些辅助工具（BetterTouchTool、远程控制）同样会碰光标。
 *
 * @param {object} p
 * @param {object} p.plan 来自 `planInput()` 的计划
 * @param {boolean} [p.verifyCursor]
 * @returns {{ok:true, at:object|null, foreground:string} | {ok:false, code:string, text:string}}
 */
export function perform({ plan, verifyCursor = true } = {}) {
  void plan;
  void verifyCursor;
  return notImplemented('桌面输入');
}

/**
 * 读当前光标位置（**点**，左上角原点）。
 *
 * ```objc
 * // CGEvent 的鼠标位置：全局显示坐标，左上角原点，单位是点
 * CGEventRef e = CGEventCreate(NULL);
 * CGPoint p = CGEventGetLocation(e);
 * CFRelease(e);
 * ```
 *
 * ### ★ 三个坐标原点，用错哪个都会镜像
 *
 * | API | 原点 | 单位 |
 * |---|---|---|
 * | `CGEventGetLocation` / `CGEventCreateMouseEvent` | **左上角** | 点 |
 * | `NSEvent.mouseLocation` | **左下角** | 点 |
 * | `CGDisplayPixelsWide` 等 | — | **像素** |
 *
 * 混用 `NSEvent.mouseLocation` 和 CGEvent 会让 y 轴镜像 ——
 * 点窗口顶部会点到同一位置的底部，而且不报错。
 * 直接用 `CGEventGetLocation`，不要绕 AppKit。
 */
export function cursorPosition() {
  return notImplemented('光标位置读取');
}

/**
 * 采样一次「输入噪声」：这台 Mac 是不是一直在产生输入。
 *
 * 判据本身是纯逻辑（`classifyInputNoise`，在 `desktop-input.js` 里，已测），
 * 这里只负责采样：
 *
 * ```
 * 连续采 samples 次 → 每次拿到 {idleMs, cursor:{x,y}}
 * 交给 classifyInputNoise({ gaps, cursors, quietMs })
 * ```
 *
 * 为什么需要：Windows 上踩过 —— 装着远程控制工具时 `GetLastInputInfo`
 * 永远报"刚刚有人动"，接管检测于是永远让开，而错误文案说的是"用户在动"。
 * macOS 上同类程序（TeamViewer、AnyDesk、Jump Desktop）一样可能这样。
 */
export function sampleInputNoise({ samples = 5, intervalMs = 120, quietMs = 250 } = {}) {
  void samples;
  void intervalMs;
  void quietMs;
  return notImplemented('输入噪声采样');
}

/**
 * 当前前台窗口标题（审计用：记下"动的是哪个窗口"，不记窗口内容）。
 *
 * ```objc
 * // 需要「辅助功能」授权；没有授权时返回空标题（不是报错 —— 审计可以没有标题）
 * AXUIElementRef app = AXUIElementCreateSystemWide();
 * // 读 kAXFocusedApplicationAttribute → kAXTitleAttribute
 * ```
 */
export function foregroundTitle() {
  return notImplemented('前台窗口标题读取');
}

/** 平台状态表（写文档时用它，别手写"应该可以"）。 */
export function describePlatform() {
  return {
    platform: 'darwin',
    supported: false,
    verified: null,
    actions: [],
    unsupported: ['全部（未实现）'],
    probe: 'CGEventSourceSecondsSinceLastEventType（未实现）',
    todo: 'docs/MACOS-DESKTOP-INPUT.md',
  };
}
