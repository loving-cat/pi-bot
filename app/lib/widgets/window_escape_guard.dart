import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:window_manager/window_manager.dart';

import '../window_escape.dart';

/// 窗口逃生口：`Esc` 关最上面一层，`Ctrl/⌘ + Shift + Q` 退出应用。
///
/// 放在 `MaterialApp.builder` 里（整棵 UI 外面），所以：
///   · 走哪个页面都在；
///   · 不依赖任何业务状态；
///   · 界面坏掉时它仍然是一个纯键盘通道（Flutter 还能处理键事件的前提下）。
///
/// 注意 `CallbackShortcuts` 需要焦点：它内部是一个 `Shortcuts` + `Actions`，
/// 只要有 `FocusScope` 就有焦点（MaterialApp 自带）。而**文本框会先吃掉 Esc**
/// —— 那是期望行为：在输入框里按 Esc 通常是取消输入，不该关栏。
class WindowEscapeGuard extends StatelessWidget {
  const WindowEscapeGuard({
    super.key,
    required this.child,
    required this.canPop,
    required this.paneOpen,
    required this.onPop,
    required this.onClosePane,
  });

  final Widget child;
  final bool canPop;
  final bool paneOpen;
  final VoidCallback onPop;
  final VoidCallback onClosePane;

  @override
  Widget build(BuildContext context) {
    return CallbackShortcuts(
      bindings: {
        const SingleActivator(LogicalKeyboardKey.escape): () {
          switch (decideEscape(canPop: canPop, paneOpen: paneOpen)) {
            case WindowEscape.popRoute:
              onPop();
              break;
            case WindowEscape.closePane:
              onClosePane();
              break;
            case WindowEscape.nothing:
              // ★ 刻意什么都不做：Esc 绝不退出应用（误触代价太大）
              break;
          }
        },
        for (final chord in quitShortcuts)
          chord: () {
            // 无边框窗口没有系统菜单兜底，这条是最后一个出口。
            // 不弹确认框 —— 它是"逃命用"的，弹框等于又把路堵上。
            windowManager.close().catchError((_) {});
          },
      },
      child: child,
    );
  }
}
