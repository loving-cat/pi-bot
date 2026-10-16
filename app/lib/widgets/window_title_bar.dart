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
