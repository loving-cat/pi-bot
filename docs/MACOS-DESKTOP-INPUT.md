# macOS 桌面输入：设计、实现与实机验收

> **状态：已实现并实机验收（2026-11-21）。**
> `server/src/desktop-input-mac.js` 是薄包装，平台调用在 Swift 原生助手
> `native/orbis-desktop-mac/` 里。`describePlatform('darwin').supported === true`，
> `drag` 明确不支持（见下方验收表第 8 项）。
>
> **本文档现在一半是设计（为什么这么做），一半是验收记录（实测到了什么）。**
> 实测环境、数字、踩的坑在 `docs/MACOS.md` 的「桌面输入（v2.0 实机验收）」一节，
> 这里保留设计与契约部分，把已被实测推翻/确认的地方就地标注。
>
> 构建助手：`./scripts/build-desktop-mac.sh`（产物不进 git）。
> 测试：`cd server && node tests/desktop-input-mac.mjs`。

---

## 0. 一页看完

| | Windows | macOS |
|---|---|---|
| 状态 | ✅ 已实机验证（`docs/WINDOWS.md`） | ⬜ **空壳，待填** |
| 文件 | `server/src/desktop-input-win.js` | `server/src/desktop-input-mac.js` |
| 平台调用 | `powershell` + `SendInput`/`SetCursorPos` | 需要原生调用（见 §3） |
| 坐标单位 | 物理像素 | **点**（points，Retina 上 = 像素 ÷ 2） |
| 探针 | `GetLastInputInfo` + `GetTickCount64` | `CGEventSourceSecondsSinceLastEventType` |
| 授权体系 | 无（但 UAC / 安全桌面会拦） | **辅助功能 / 屏幕录制两道系统授权** |
| 入口个数 | 6 | 6（签名完全相同） |

**判定逻辑一行都不用写。** 租约、接管检测、动作规划、坐标校验、PS 转义、
噪声判据全部是平台无关的纯逻辑，已经在这些文件里，且有 106 项测试守着：

```
desktop-lease.mjs          24 项   租约 / epoch / 过期 / 吊销 / 排队
desktop-takeover.mjs       21 项   接管检测 / 抖动抑制 / 探针归一化
desktop-input.mjs          38 项   动作规划 / 坐标校验 / 键码 / 噪声判据（含装配层）
desktop-tools.mjs          10 项   工具层接线与文案
desktop-input-mac.mjs      13 项   空壳纪律（实现后改成守"必须支持"）
                          ─────
                          106 项
```

你只需要实现 6 个函数。

---

## 1. 可改动区间（**只改这些，别动别的**）

### 1.1 必须改的文件

```
server/src/desktop-input-mac.js        ← 填 6 个函数
```

### 1.2 改完之后必须同步的地方

| 文件 | 改什么 | 为什么 |
|---|---|---|
| `desktop-input-mac.js` `describePlatform()` | `supported: true` + `verified:` 一行 | 状态表照实报 |
| `desktop-input.js` `describePlatform('darwin')` | 同上（两处说法必须一致，测试会查） | 纯逻辑层也要跟着 |
| `server/tests/desktop-input-mac.mjs` | 把"空壳纪律"那几条改成"实现纪律" | 现在守的是"必须说不支持"，实现后改成守"必须说支持" |
| `docs/MACOS.md` | 加一节「桌面输入」（照 `docs/WINDOWS.md` 那一节抄） | 实机记录要有地方放 |

### 1.3 **不要动**的文件（动了会让 Windows 跟着变）

```
desktop-lease.js      租约是平台无关的
desktop-takeover.js   接管检测是平台无关的
desktop-input.js      规划/校验/键码表 —— 见下面这个例外
desktop-input-session.js   装配层只认 6 个函数的签名
desktop-input-win.js  Windows 实现
tools.js              工具层只翻译参数
capabilities.js       能力声明（desktop.input 已经声明好了）
```

**唯一的例外：`desktop-input.js` 的 `VK` 表。**

那张表是 **Win32 虚拟键码**（ctrl=0x11、v=0x56）。macOS 用 `CGKeyCode`
（一种硬件扫描码，v=0x09），**两者完全不是一回事**，而且不能互相转换。

所以：

```js
// ✅ 现在的 plan 同时带 keys（原始键名）和 codes（Win32 码）
plan = { action: 'keyCombo', keys: ['ctrl','v'], codes: [0x11, 0x56], ... }

// macOS 侧：用 keys 自己映射成 CGKeyCode，**忽略 codes**
const CG_KEYCODE = { ctrl: 0x3B, shift: 0x38, alt: 0x3A, cmd: 0x37, v: 0x09, ... };

// ❌ 不要去改 vkCode() 让它平台化 —— 那会让 Windows 侧跟着变，
//    而 Windows 侧刚在真机上验完（改它就要重新验一遍 2560x1440/125% 那套）。
```

**如果 `keys` 不够用**（比如你想加 macOS 特有的 `cmd` 键）：在
`desktop-input.js` 的 `VK` 表里加一行 `cmd: 0x5b`（Win 键的码），并在
`docs/MACOS-DESKTOP-INPUT.md` 这一节记一笔。这是最小改动。

---

## 2. 六个函数的契约

签名与返回形状必须和 `desktop-input-win.js` **完全一致**，否则装配层接不上。
`desktop/tests/desktop-input.mjs` 里有一组用例就是靠这个形状跑的。

| 函数 | 成功返回 | 失败返回 | 难度 |
|---|---|---|---|
| `probeEnvironment()` | `{ok:true, screen:{x,y,width,height}, dpi, session:boolean}` | `{ok:false, code, text}` | ★★ |
| `lastInputAt()` | `{ok:true, lastInputAt:number, idleMs:number}` | `{ok:false, code, text}` | ★★★ |
| `perform({plan})` | `{ok:true, at:{x,y}\|null, foreground:string}` | `{ok:false, code, text}` | ★★★★ |
| `cursorPosition()` | `{ok:true, x, y}` | `{ok:false, code, text}` | ★ |
| `sampleInputNoise()` | `{ok:true, kind, noisy, cursorStill, samples, cursor}` | `{ok:false, code, text}` | ★★ |
| `foregroundTitle()` | `{ok:true, title}` | `{ok:false, code, text}` | ★ |

`code` 用 `desktop-input.js` 的 `INPUT_FAIL` 里的值，不要自造：

```js
INPUT_FAIL = {
  notPlatform,      // 平台没实现（空壳用这个）
  notAware,         // 坐标基准不可信（Windows 是 DPI 感知失败）
  outOfScreen,      // 坐标在屏幕外
  noSession,        // 锁屏 / 断开会话
  invalid,          // 参数不合法
  callFailed,       // 平台调用失败
  probeUnavailable, // 探针不可用
  yielded,          // 被用户接管
}
```

---

## 3. 平台调用怎么做（这是唯一的技术选择点）

macOS 没有 `powershell` 这种"一条命令办完事"的通道。三条路，各有代价：

| 方案 | 做法 | 代价 | 推荐度 |
|---|---|---|---|
| **A. 自写原生二进制** | 在 `native/` 下加一个 `pibot-desktop-mac`（Swift/Rust），服务端 `spawn` 它 | 多一个二进制要构建+签名+打包+版本校验 | ⭐⭐⭐ 推荐 |
| **B. osascript 调 ObjC** | `osascript -l JavaScript -e '...'`（JXA）直接调 ObjC 桥 | 慢（每次 ~200ms）、不能发 `CGEvent` 高频事件、JXA 对 CoreGraphics 支持不全 | ⭐ 只适合诊断类（光标位置、窗口标题） |
| **C. Node 原生插件** | 写 `.node` 插件（node-gyp / napi-rs） | 要为两个架构（arm64/x64）各编一份，还要跟 Node ABI 对齐；升级 Node 就得重编 | ⭐⭐ 不推荐 |

**推荐 A + B 混合**：`cginput` 二进制负责 `perform`（高频、精确），
其余四个诊断函数用 `osascript` 就够（低频、可以慢）。

`native/` 下已经有先例：`native/pibot-sandbox`（Rust，Windows 沙箱启动器）。
它的构建/版本校验/打包流程可以直接抄：

```
scripts/build-sandbox-win.ps1          → 抄成 scripts/build-cginput-mac.sh
server/tools/check-launcher-version.mjs → 抄一份 check-cginput-version.mjs
.github/workflows/ci.yml 的 native job  → 加一个 macOS 的构建步骤
```

> ⚠ **不要**为了省事直接 `spawn('cliclick')` 或者要求用户装 `brew install cliclick`。
> 那是把"能不能操作桌面"变成"用户机器上有没有装某个第三方工具"。

---

## 4. ★ 上机第一件事：验三件事（顺序别换）

这三件事决定了整个实现怎么写。**先验，再写代码**，否则会写完再推倒。

### 4.1 没有辅助功能授权时，探针返回什么？

> **实测结论（2026-11-21）：返回真实秒数，探针不看辅助功能授权。**
> 本机宿主已有授权，测到的值 25.1 / 94.9 / 175.5 秒都是合理值，不是 0 也不是 -1。
> 反证：把同一个二进制复制到另一个路径再跑，`AXIsProcessTrusted()` 仍是 true
> —— 说明 TCC 归属是**发起进程链的宿主 App**，不是二进制自身路径。
> 因此「探针是否可用」与「有没有授权」是两件事：探针可用但发不出输入，
> 正是必须在 `perform` 里单独判授权的理由。

```bash
# 故意不开授权，跑这条
osascript -l JavaScript -e 'ObjC.import("CoreGraphics"); $.CGEventSourceSecondsSinceLastEventType($.kCGEventSourceStateCombinedSessionState, $.kCGAnyInputEventType)'
```

| 结果 | 说明 | 该怎么写 |
|---|---|---|
| 返回一个合理的秒数 | 探针不看授权 | 直接用 |
| 返回 `0` 或 `-1` | **探针也不可用** | 必须返回 `{ok:false, code:probeUnavailable}`，让装配层走"保守交还用户" |
| 报错 | 探针也受限 | 同上 |

**为什么这条最重要**：本机 Windows 上踩过一模一样的坑 —— 远程控制工具持续
合成输入，`GetLastInputInfo` 永远报"刚刚有人动"，接管检测于是永远让开，
而错误文案说的是"用户在动"，用户根本不知道该去开权限。

如果 macOS 也是返回 0，而你把它当成"用户在动"，那么这台 Mac 上
**永远发不出输入**，且文案完全指错方向。所以：**探针不可用必须能被识别出来。**

### 4.2 辅助功能授权被拒时，`CGEventPost` 是静默丢弃还是报错？

```bash
# 不开授权，试发一个按键，看 CGEventPost 的返回值和屏幕反应
osascript -l JavaScript -e 'ObjC.import("CoreGraphics"); var e=$.CGEventCreateKeyboardEvent($(), 0x00, true); $.CGEventPost($.kCGHIDEventTap, e)'
```

| 结果 | 该怎么写 |
|---|---|
| 静默丢弃（无报错、屏幕无反应） | ★ **必须先 `AXIsProcessTrusted()` 判授权**，否则我们会以为发出去了 |
| 报错 | 直接上抛 `callFailed` |

**绝大多数情况下是静默丢弃** —— 这就是为什么必须在 `perform()` 一开始就查
`AXIsProcessTrusted()`，返回 `{ok:false, code:'not_authorized', text:'需要…辅助功能'}`。

规格 §5.4 原话：「不请求绕过系统保护；明确交还用户」。
所以**不要**用 `AXIsProcessTrustedWithOptions` 自动弹窗然后静默重试。

### 4.3 Retina 上坐标单位到底是哪个？

```bash
osascript -l JavaScript -e 'ObjC.import("CoreGraphics");
var d = $.CGMainDisplayID();
"bounds=" + $.CGDisplayBounds(d) + " pixels=" + $.CGDisplayPixelsWide(d) + "x" + $.CGDisplayPixelsHigh(d)'
```

本机（假设 13" Retina，1440x900 逻辑）预期：

```
bounds = {origin:{x:0,y:0}, size:{width:1440,height:900}}   ← 点
pixels = 2880x1800                                          ← 像素
```

**结论**：`CGDisplayBounds` 给的是点，`CGEvent` 用的也是点。**全程用点**，
不要在 macOS 侧把点乘 2。`dpi` 字段填 `scale × 96`（Retina = 192）只为
与 Windows 对齐形状，任何逻辑都不靠它换算。

---

## 5. 六个函数各自的实现要点

### 5.1 `probeEnvironment()`

```objc
// 全部屏幕（多屏）
uint32_t count = 0;
CGGetActiveDisplayList(0, NULL, &count);
CGDirectDisplayID ids[16];
CGGetActiveDisplayList(count, ids, &count);

// 拼出虚拟桌面矩形（左屏在主屏左边时 x 为负，与 Windows 一致）
CGFloat minX = 1e9, minY = 1e9, maxX = -1e9, maxY = -1e9;
CGFloat maxScale = 1.0;
for (uint32_t i = 0; i < count; i++) {
  CGRect r = CGDisplayBounds(ids[i]);
  minX = MIN(minX, CGRectGetMinX(r));  maxX = MAX(maxX, CGRectGetMaxX(r));
  minY = MIN(minY, CGRectGetMinY(r));  maxY = MAX(maxY, CGRectGetMaxY(r));
  size_t pw = CGDisplayPixelsWide(ids[i]);
  if (pw > 0) maxScale = MAX(maxScale, (CGFloat)pw / CGRectGetWidth(r));
}

// 会话：锁屏 / 没有前台会话
CFDictionaryRef session = CGSessionCopyCurrentDictionary();
bool locked = CFDictionaryGetValue(session, CFSTR("CGSSessionScreenIsLocked")) == kCFBooleanTrue;
bool onConsole = CFDictionaryGetValue(session, CFSTR("kCGSSessionOnConsoleKey")) == kCFBooleanTrue;
bool hasSession = !locked && onConsole;
```

返回 `screen: {x:minX, y:minY, width:maxX-minX, height:maxY-minY}`（**点**）。

> ★ 这个函数**每次注入前都会重新调**（不缓存）—— 外接屏拔了、分辨率改了、
> 用户锁屏了都要立刻反映出来。规格 §5.4「布局变化使旧坐标失效」。

### 5.2 `lastInputAt()`

```objc
CFTimeInterval ago = CGEventSourceSecondsSinceLastEventType(
    kCGEventSourceStateCombinedSessionState, kCGAnyInputEventType);
// 与 Windows 的差别：它给的是"多少秒前"，所以直接反推 epoch
double lastInputAt = nowMs - ago * 1000.0;
```

**注意**：`age` 为 0 有两种含义 —— "刚刚有输入" 和 "探针不可用"，要按 §4.1
的结果区分。如果 §4.1 验出来探针不看授权、正常返回，那就照实返回；
如果验出来不可用，"不可用"必须能被上层看见。

**归一化交给纯逻辑**：`desktop-takeover.js` 有 `normalizeProbe({value, unit})`，
`unit` 用 `'agoSeconds'`。**不要**在 macOS 侧另写一套归一化。

### 5.3 `perform({plan})`

按 `plan.action` 分派。**先移动、复核、再点击**（和 Windows 一样，别省）：

```objc
// 移动
CGWarpMouseCursorPosition(CGPointMake(plan.point.x, plan.point.y));
// ★ 移动后必须重新关联，否则光标会和物理鼠标"脱钩"
CGAssociateMouseAndMouseCursorPosition(true);

// 复核（容差 + 重试，抄 Windows 的 moveTo）
// 见 desktop-input-win.js 的 CURSOR_TOLERANCE_PX / MOVE_ATTEMPTS

// 点击
CGEventRef down = CGEventCreateMouseEvent(NULL, kCGEventLeftMouseDown,
                                          CGPointMake(x, y), kCGMouseButtonLeft);
CGEventPost(kCGHIDEventTap, down);
CFRelease(down);
// 抬起同理（kCGEventLeftMouseUp）
```

**键映射**（用 `plan.keys`，不用 `plan.codes`）：

```js
// 只登记常用且意义确定的键，与 desktop-input.js 的 VK 表一一对应
const CG_KEYCODE = {
  ctrl: 0x3B, shift: 0x38, alt: 0x3A, cmd: 0x37,
  enter: 0x24, tab: 0x30, esc: 0x35, space: 0x31,
  backspace: 0x33, delete: 0x75, insert: 0x72,
  left: 0x7B, right: 0x7C, up: 0x7E, down: 0x7D,
  home: 0x73, end: 0x77, pageup: 0x74, pagedown: 0x79,
  f1: 0x7A, f2: 0x78, f3: 0x63, f4: 0x76, f5: 0x60, f6: 0x61,
  f7: 0x62, f8: 0x64, f9: 0x65, f10: 0x6D, f11: 0x67, f12: 0x6F,
  a: 0x00, c: 0x08, f: 0x03, s: 0x01, v: 0x09, x: 0x07, z: 0x06,
  0: 0x1D, 1: 0x12, 2: 0x13, 3: 0x14, 4: 0x15,
  5: 0x17, 6: 0x16, 7: 0x1A, 8: 0x1C, 9: 0x19,
};
// 认不出的键必须拒绝（返回 invalid），不要猜
```

**文字输入走剪贴板**（和 Windows 一样）：

```objc
NSPasteboard *pb = [NSPasteboard generalPasteboard];
// 存原内容 → 设新内容 → ⌘V → 还原
// ★ 必须还原：用户剪贴板里可能是他正在搬的东西
```

macOS 的粘贴快捷键是 **⌘V（cmd+V）**，不是 Ctrl+V。这是最容易写错的一处。

### 5.4 `cursorPosition()`

```objc
CGEventRef e = CGEventCreate(NULL);
CGPoint p = CGEventGetLocation(e);   // 左上角原点，点
CFRelease(e);
```

**不要**用 `NSEvent.mouseLocation`（左下角原点），会和 CGEvent 的 y 轴镜像。

### 5.5 `sampleInputNoise()`

采样骨架照抄 Windows 版（`desktop-input-win.js` 的同名函数），
判据交给纯逻辑 `classifyInputNoise({gaps, cursors, quietMs})`：

```
连续采 samples 次（默认 5，间隔 120ms）
每次拿 {idleMs, cursor}
→ classifyInputNoise({ gaps, cursors, quietMs: 250 })
```

判据已经在 `desktop-input.js` 里、有测试，**不要重写**。

### 5.6 `foregroundTitle()`

```objc
// 需要辅助功能授权；没有授权时返回空标题（不是报错 —— 审计可以没有标题）
AXUIElementRef system = AXUIElementCreateSystemWide();
CFTypeRef app = NULL;
AXUIElementCopyAttributeValue(system, kAXFocusedApplicationAttribute, &app);
CFTypeRef title = NULL;
AXUIElementCopyAttributeValue(app, kAXTitleAttribute, &title);
```

**只记标题，不记窗口内容**（规格 §5.5：审计不带秘密）。

---

## 6. 系统授权：两道，都要在界面上说清楚

macOS 和 Windows 最大的不同不是 API，是**授权体系**。

| 权限 | 在系统设置的哪 | 不给会怎样 | 我们要怎么做 |
|---|---|---|---|
| **辅助功能**（Accessibility） | 隐私与安全性 → 辅助功能 | `CGEventPost` **静默丢弃**：我们以为发出来了，实际什么都没发生 | `perform()` 开头查 `AXIsProcessTrusted()`，不给就返回 `not_authorized` 并说清去哪开 |
| **屏幕录制**（Screen Recording） | 隐私与安全性 → 屏幕录制 | `screencapture` 截出来是空白桌面（只有壁纸） | 观察层（`desktop-observe.js`）已经要用；截到空白要能识别并报 `not_authorized` |

**两件事必须做**：

1. **`Info.plist` 加用途说明**（不加，系统弹窗里显示的是空白，用户不知道凭什么给）：

```xml
<key>NSAppleEventsUsageDescription</key>
<string>用于操作窗口与读取窗口标题（桌面输入）</string>
```

（辅助功能没有 `NS*UsageDescription` 键 —— 它由 `AXIsProcessTrusted` 的
系统弹窗触发，或直接引导用户去设置页。）

2. **`AXIsProcessTrustedWithOptions` 的用法**：

```objc
// ✅ 先判，不判就不发
if (!AXIsProcessTrusted()) return not_authorized();

// ⚠ 只有在用户**明确要求**"帮我打开设置"时才弹这条
NSDictionary *opts = @{(__bridge id)kAXTrustedCheckOptionPrompt: @YES};
AXIsProcessTrustedWithOptions((__bridge CFDictionaryRef)opts);

// ❌ 不要在 perform() 里自动弹窗然后静默重试 ——
//    规格 §5.4：「不请求绕过系统保护；明确交还用户」
```

---

## 7. 验收清单（填完代码，照这个逐条跑）

**规则：没跑过的行不许打勾。** 每条都要写环境与证据。

### 7.1 纯逻辑（不需要 Mac，CI 在 ubuntu/windows/macos 三端都会跑）

```bash
cd server
node tests/desktop-input.mjs        # 38 项
node tests/desktop-input-mac.mjs    # 13 项（实现后改成守"必须支持"）
node tests/desktop-input-session.mjs  # 35 项
node tests/desktop-tools.mjs        # 10 项
node tests/all.mjs                  # 116 个文件
```

### 7.2 实机（必须有 Mac）

| # | 场景 | 怎么验 | 预期 |
|---|---|---|---|
| 1 | 探针可用性 | §4.1 那条命令，**故意不开授权** | 能明确区分"没实现授权"和"刚有输入" |
| 2 | 授权被拒时不发 | 不开辅助功能，调 `desktop_input` | 返回 `not_authorized`，**文案说清去哪开** |
| 3 | 移动精确 | 移到 (400,300)，`cursorPosition()` 复核 | 点内一致（容差见下） |
| 4 | 点击位置 | 靶子窗口记录 `mouseDown` 坐标 | 与目标一致（Retina 上也是点） |
| 5 | 中文输入 | 往 TextBox 粘 `中文 ✅ $HOME \`tick\`` | 逐字相符，且**原剪贴板已还原** |
| 6 | ⌘V 不是 Ctrl+V | 同上，但故意把键写错成 ctrl | 应当**失败**（说明键映射真的生效了） |
| 7 | 屏幕外坐标 | 传 `(99999, 100)` | `out_of_screen`，**不夹到边缘** |
| 8 | 拖拽 | 传 `action:'drag'` | `invalid`，文案说清"没做完之前不上线" |
| 9 | 锁屏 | 锁屏后调 `desktop_input` | `no_session`，且**租约被自动吊销** |
| 10 | 用户接管 | 跑长动作时手动碰鼠标 | 停下、交还，且**不当成工具故障** |
| 11 | 多屏 | 外接一块不同缩放的屏 | 负坐标能落对位置；布局变化后旧坐标被拒 |
| 12 | 降级路径 | 撤掉辅助功能授权再跑 | 明确失败，**不静默成功** |

**容差先别抄 Windows 的 24px。** Windows 上那个容差是因为实测
`SetCursorPos` 会落偏 3~26px。macOS 的 `CGWarpMouseCursorPosition`
通常更准，先按 **0 容差**跑第 3 项，落偏了再按实测值调，并在注释里记下测出来的数字。

### 7.3 填完之后

```bash
cd server && node tests/all.mjs        # 必须仍然全绿
node scripts/check-capability-drift.mjs
node scripts/check-consistency.mjs
cd .. && node scripts/check-secrets.mjs # 别把本机路径写进提交
```

然后把 `docs/MACOS.md` 加一节「桌面输入」，格式抄 `docs/WINDOWS.md` 的同名节：
先写"实测过什么"，再写"什么还没实测"，最后写踩过的坑。

---

## 8. 已经踩过、别再踩的坑（Windows 上的记录，多半同样适用）

| 坑 | 表现 | 怎么防 |
|---|---|---|
| **坐标单位混用** | Retina 上整屏偏移一倍，**不报错** | macOS 全程用点；不要乘 2；`planInput` 的校验只要求"坐标与 screen 同单位" |
| **原点镜像** | 点窗口顶部点到同一位置的底部 | 只用 `CGEventGetLocation`，不碰 `NSEvent.mouseLocation` |
| **`SendInput` 绝对坐标偏移**（Windows 特有） | 期望 (1280,720) 落在 (1611,1114) | Windows 已改用 `SetCursorPos`；macOS 用 `CGWarpMouseCursorPosition`，但**复核+重试**这套保护照抄 |
| **光标被别的程序碰** | 移动后复核偏差 3~26px | 容差 + 重试；**没到位绝不点击** |
| **漏了 noteInjection** | 下一次检测把自己的输入当成用户接管 | 装配层已经做了（`desktop-input-session.js` 第 ⑦ 步），别绕开它直接调 `perform` |
| **探针不可用被当成"用户在动"** | 永远发不出去，文案还指错方向 | 探针失败要返回 `ok:false`，不要返回一个假的数 |
| **剪贴板不还原** | 用户下次粘贴粘到我们打的字 | `type_text` 必须存原内容并还原 |
| **半截拖拽** | 桌面上留下"鼠标按着不放" | 拖拽要整块做完（按下—移动—抬起 + 中断恢复），没做完就明确拒绝 |
| **自动弹授权窗** | 用户不知道凭什么给 | 只在用户明确要求时弹；`perform()` 里只判不发 |

---

## 9. 明确的边界（别顺手扩）

| 不做 | 理由 |
|---|---|
| 让 macOS 实现也管租约/接管判定 | 那是平台无关的，重复实现必然两边漂移（Windows 严、macOS 松） |
| 改 `vkCode()` 让它平台化 | 会让 Windows 侧跟着变，而 Windows 刚在真机上验完 |
| 用 `cliclick` 之类的第三方工具 | 把"能不能操作桌面"变成"用户机器上装没装某个工具" |
| 在空壳里返回 `{ok:true}` | 上层会以为发出去了。这是本文档存在的全部理由 |
| 自动弹系统授权窗并静默重试 | 规格 §5.4：「不请求绕过系统保护；明确交还用户」 |
| 加拖拽 | 要"按下—移动—抬起"持续持租约 + 中断恢复（规格 §5.2 要求纳入验收），单独一项做 |

---

## 10. 参考：Windows 实现里可以直接抄的部分

`server/src/desktop-input-win.js` 里有这些**与平台无关**的思路，建议直接抄结构：

| 抄什么 | 在哪 | 为什么值得抄 |
|---|---|---|
| 脚本 prelude 的组织方式 | 文件头 `WIN_PRELUDE` | 把"必须最先做的一件事"（声明 DPI 感知）固定在第一句 |
| `moveTo()` 的容差 + 重试 | `moveTo()` | 复核失败不许点击，重试有上限 |
| 五个动作的分派骨架 | `perform()` | 形状一致，装配层才接得上 |
| `sampleInputNoise()` 的采样骨架 | 同名函数 | 判据是纯逻辑，采样只要把数据凑齐 |
| 文件头的「实测记录」写法 | 文件头 | 写清"验过什么、没验什么"，比写"应该可以"有用 |

---

*本文档只描述待办。macOS 实现为空壳，`describePlatform('darwin').supported === false`，
`server/tests/desktop-input-mac.mjs` 的 13 项测试守着这一点。*
