import 'dart:io' show Platform;

import 'package:flutter/foundation.dart' show kIsWeb;
import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import 'package:window_manager/window_manager.dart';

import '../theme.dart';

/// 无边框窗口顶部的**拖拽条**。
///
/// 只负责拖拽（和双击最大化/还原）—— 窗口控制按钮统一由
/// [WindowControlsOverlay] 画在整个窗口的右上角（学 同类客户端），
/// 聊天区自己不再放一套，否则会出现两套按钮。
class WindowTitleBar extends StatefulWidget {
  const WindowTitleBar({super.key, this.height = 38});

  final double height;

  static bool get isSupported =>
      !kIsWeb && (Platform.isWindows || Platform.isMacOS || Platform.isLinux);

  @override
  State<WindowTitleBar> createState() => _WindowTitleBarState();
}

class _WindowTitleBarState extends State<WindowTitleBar> {
  @override
  Widget build(BuildContext context) {
    if (!WindowTitleBar.isSupported) return const SizedBox.shrink();

    return GestureDetector(
      behavior: HitTestBehavior.translucent,
      onPanStart: (_) => windowManager.startDragging(),
      onDoubleTap: () async {
        if (await windowManager.isMaximized()) {
          await windowManager.unmaximize();
        } else {
          await windowManager.maximize();
        }
      },
      child: SizedBox(height: widget.height, width: double.infinity),
    );
  }
}

/// 整个窗口右上角的窗口控制按钮（最小化 / 最大化 / 关闭）。
///
/// ★ 图标必须用 Lucide。这个 app 的字体已经全部换成 Lucide，
///   MaterialIcons 字体被 tree-shake 成 1588 字节的空壳，
///   用 `Icons.xxx` 会渲染成**空白按钮** —— 按钮在、能点、有 hover 反馈，
///   但看不到任何图标（这个 bug 骗了我很久）。
class WindowControlsOverlay extends StatelessWidget {
  const WindowControlsOverlay({super.key});

  static bool get isSupported => WindowTitleBar.isSupported;

  @override
  Widget build(BuildContext context) {
    if (!isSupported) return const SizedBox.shrink();

    return Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        _WinBtn(
          tip: '最小化',
          icon: LucideIcons.minus,
          onTap: () => windowManager.minimize(),
        ),
        _WinBtn(
          tip: '最大化 / 还原',
          icon: LucideIcons.square,
          iconSize: 12,
          onTap: () async {
            if (await windowManager.isMaximized()) {
              await windowManager.unmaximize();
            } else {
              await windowManager.maximize();
            }
          },
        ),
        _WinBtn(
          tip: '关闭',
          icon: LucideIcons.x,
          danger: true,
          onTap: () => windowManager.close(),
        ),
      ],
    );
  }
}

/// 单个窗口按钮。hover 时浮出底色（关闭键是红色），和 Windows 原生行为一致。
class _WinBtn extends StatefulWidget {
  const _WinBtn({
    required this.tip,
    required this.icon,
    required this.onTap,
    this.iconSize = 14,
    this.danger = false,
  });

  final String tip;
  final IconData icon;
  final VoidCallback onTap;
  final double iconSize;
  final bool danger;

  @override
  State<_WinBtn> createState() => _WinBtnState();
}

class _WinBtnState extends State<_WinBtn> {
  bool _hover = false;

  @override
  Widget build(BuildContext context) {
    final bg = _hover
        ? (widget.danger ? const Color(0xFFE81123) : PB.bgHover)
        : Colors.transparent;
    final fg = _hover && widget.danger ? Colors.white : PB.textSecondary;

    return Tooltip(
      message: widget.tip,
      waitDuration: const Duration(milliseconds: 600),
      child: MouseRegion(
        cursor: SystemMouseCursors.basic,
        onEnter: (_) => setState(() => _hover = true),
        onExit: (_) => setState(() => _hover = false),
        child: GestureDetector(
          onTap: widget.onTap,
          child: Container(
            width: 44,
            height: 34,
            alignment: Alignment.center,
            color: bg,
            child: Icon(widget.icon, size: widget.iconSize, color: fg),
          ),
        ),
      ),
    );
  }
}

/// 无边框窗口的**八向缩放热区**。
///
/// `setAsFrameless()` 去掉了系统标题栏，Windows 的窗口过程就不再给边框做命中
/// 测试 —— 窗口属性上仍然"可缩放"，但四个边、四个角全拖不动，看着像被锁死了。
/// 这里在窗口四周铺一层透明热区，把拖动转给 windowManager.startResizing：
///
///   四个角 = 斜着等比缩放（`resizeUpLeft` 那种对角光标）
///   四条边 = 单方向拉伸/压缩
///
/// 铺在最上层但**在窗口控制按钮下面**（main.dart 里的 Stack 顺序），
/// 所以右上角"关闭"按钮的右上角不会被角热区抢走点击。
class WindowResizeOverlay extends StatefulWidget {
  const WindowResizeOverlay({super.key, this.edge = 5, this.corner = 11});

  /// 四条边的热区厚度。太薄点不中，太厚会盖住贴边的按钮
  final double edge;

  /// 四个角的热区边长 —— 比边厚一点，斜着拖更容错
  final double corner;

  static bool get isSupported => WindowTitleBar.isSupported;

  @override
  State<WindowResizeOverlay> createState() => _WindowResizeOverlayState();
}

class _WindowResizeOverlayState extends State<WindowResizeOverlay>
    with WindowListener {
  bool _maximized = false;

  @override
  void initState() {
    super.initState();
    if (!WindowResizeOverlay.isSupported) return;
    windowManager.addListener(this);
    // 启动时窗口可能已经是最大化（比如上次退出时就是）
    windowManager.isMaximized().then((m) {
      if (mounted && m != _maximized) setState(() => _maximized = m);
    }).catchError((_) {
      // 平台没实现（比如跑单测时没有插件）就当"没最大化"：
      // 铺上热区最多是多余，不铺就是彻底不能缩放
    });
  }

  @override
  void dispose() {
    if (WindowResizeOverlay.isSupported) windowManager.removeListener(this);
    super.dispose();
  }

  @override
  void onWindowMaximize() {
    if (mounted) setState(() => _maximized = true);
  }

  @override
  void onWindowUnmaximize() {
    if (mounted) setState(() => _maximized = false);
  }

  @override
  void onWindowRestore() {
    if (mounted) setState(() => _maximized = false);
  }

  @override
  Widget build(BuildContext context) {
    // 最大化时铺热区只会挡住边缘的按钮，而且系统本来也不让拉
    if (!WindowResizeOverlay.isSupported || _maximized) {
      return const SizedBox.shrink();
    }
    final t = widget.edge;
    final c = widget.corner;
    return Stack(
      children: [
        // 四个角：斜着等比缩放
        _zone(
          left: 0,
          top: 0,
          width: c,
          height: c,
          edge: ResizeEdge.topLeft,
          cursor: SystemMouseCursors.resizeUpLeft,
        ),
        _zone(
          right: 0,
          top: 0,
          width: c,
          height: c,
          edge: ResizeEdge.topRight,
          cursor: SystemMouseCursors.resizeUpRight,
        ),
        _zone(
          left: 0,
          bottom: 0,
          width: c,
          height: c,
          edge: ResizeEdge.bottomLeft,
          cursor: SystemMouseCursors.resizeDownLeft,
        ),
        _zone(
          right: 0,
          bottom: 0,
          width: c,
          height: c,
          edge: ResizeEdge.bottomRight,
          cursor: SystemMouseCursors.resizeDownRight,
        ),
        // 四条边：单方向拉伸（左右两端让开角热区，免得抢）
        _zone(
          left: c,
          right: c,
          top: 0,
          height: t,
          edge: ResizeEdge.top,
          cursor: SystemMouseCursors.resizeUp,
        ),
        _zone(
          left: c,
          right: c,
          bottom: 0,
          height: t,
          edge: ResizeEdge.bottom,
          cursor: SystemMouseCursors.resizeDown,
        ),
        _zone(
          left: 0,
          top: c,
          bottom: c,
          width: t,
          edge: ResizeEdge.left,
          cursor: SystemMouseCursors.resizeLeft,
        ),
        _zone(
          right: 0,
          top: c,
          bottom: c,
          width: t,
          edge: ResizeEdge.right,
          cursor: SystemMouseCursors.resizeRight,
        ),
      ],
    );
  }

  Widget _zone({
    double? left,
    double? top,
    double? right,
    double? bottom,
    double? width,
    double? height,
    required ResizeEdge edge,
    required MouseCursor cursor,
  }) {
    return Positioned(
      left: left,
      top: top,
      right: right,
      bottom: bottom,
      width: width,
      height: height,
      child: MouseRegion(
        cursor: cursor,
        child: GestureDetector(
          behavior: HitTestBehavior.translucent,
          onPanStart: (_) => windowManager.startResizing(edge),
        ),
      ),
    );
  }
}
