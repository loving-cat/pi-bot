/// 窗口的**逃生口**（规格 `spec-intent-and-habits-v1.md` §2 第 3 条）。
///
/// ## 为什么需要这个文件
///
/// pi-bot 的窗口是**无边框**的（`setAsFrameless()`）：标题栏、关闭按钮都是
/// 我们自己画的。这带来一个硬后果 —— **界面一旦没画出来，用户就没有任何出口**：
/// 没有标题栏可拖、没有关闭按钮可点、Alt+Space 的系统菜单也没有。
///
/// 这真的发生过：一次页面全屏之后，窗口铺满屏幕、内容是黑的，
/// 用户既拖不动也关不掉，只能等我们远程把进程杀掉。
///
/// 所以这里补两条**键盘层**的出口，它不依赖界面画得好不好：
///
/// | 键 | 做什么 | 什么时候 |
/// |---|---|---|
/// | `Esc` | 关掉最上面那一层（对话框 / 附件预览 / 浏览器栏） | 只在该关东西的时候 |
/// | `Ctrl+Shift+Q`（Mac: `⌘⇧Q`） | **退出应用** | 任何时候 |
///
/// ## 为什么 Esc 不直接退出应用
///
/// Esc 是最容易误触的键。用户只是想取消一个对话框，结果整个 App 关了 ——
/// 那比"关不掉"更糟。所以 Esc 只做"关最上面一层"，退应用单独给一个组合键。
library;

import 'package:flutter/services.dart';
import 'package:flutter/widgets.dart' show SingleActivator;

/// Esc 该做什么。
enum WindowEscape {
  /// 关掉最上面的路由（对话框、附件预览……）
  popRoute,

  /// 关掉浏览器/预览栏
  closePane,

  /// 什么都不做（没有可关的东西 —— **绝不退出应用**）
  nothing,
}

/// 决定 Esc 的行为。纯函数，便于单测。
///
/// 优先级：先关最上面一层路由（那是用户**眼前**的东西），
/// 再关栏；都没有就什么都不做。
WindowEscape decideEscape({bool canPop = false, bool paneOpen = false}) {
  if (canPop) return WindowEscape.popRoute;
  if (paneOpen) return WindowEscape.closePane;
  return WindowEscape.nothing;
}

/// 退出应用的组合键：`Ctrl+Shift+Q`（Mac 用 `⌘⇧Q`）。
///
/// 用两个键而不是 F 键：功能键在部分键盘/布局上被占用；
/// 而 `Ctrl+Shift+Q` 在 Windows 与 macOS 上都没有系统级冲突
/// （macOS 的 `⌘Q` 是退出，我们加了 Shift，避开用户肌肉记忆的误触）。
List<SingleActivator> get quitShortcuts => const [
  SingleActivator(LogicalKeyboardKey.keyQ, control: true, shift: true),
  SingleActivator(LogicalKeyboardKey.keyQ, meta: true, shift: true),
];

/// 这是不是"退出应用"的组合键（收到 RawKeyEvent 时用）。
///
/// 单独抽出来是因为有些平台（WebView 抢焦点时）`CallbackShortcuts` 收不到键，
/// 需要在更外层再判一次。
bool isQuitChord({required bool control, required bool meta, required bool shift, required LogicalKeyboardKey key}) {
  if (!shift) return false;
  if (key != LogicalKeyboardKey.keyQ) return false;
  return control || meta;
}
