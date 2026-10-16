import 'dart:io' show Platform;

import 'package:flutter/foundation.dart' show kIsWeb;
import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import 'package:window_manager/window_manager.dart';

import '../theme.dart';

/// 无边框窗口的自定义标题栏。
///
/// 同类客户端 那种：整条透明可拖拽，右上角三个小按钮（最小化/最大化/关闭），
/// 左边不放产品名（App 自己会显示内容，重复写一遍很土）。
///
/// 刻意用最朴素的 widget（Container + GestureDetector），
/// 不用 Tooltip / MouseRegion / AnimatedContainer —— 在无边框窗口里踩过坑，
/// 这些组合会让内容不渲染。
class WindowTitleBar extends StatefulWidget {
  const WindowTitleBar({super.key, this.height = 36});

  final double height;

  static bool get isSupported =>
      !kIsWeb && (Platform.isWindows || Platform.isMacOS || Platform.isLinux);

  @override
  State<WindowTitleBar> createState() => _WindowTitleBarState();
}

class _WindowTitleBarState extends State<WindowTitleBar> with WindowListener {
  bool _maximized = false;
  int _hover = -1;

  @override
  void initState() {
    super.initState();
    if (WindowTitleBar.isSupported) {
      windowManager.addListener(this);
      windowManager.isMaximized().then((v) {
        if (mounted) setState(() => _maximized = v);
      });
    }
  }

  @override
  void dispose() {
    if (WindowTitleBar.isSupported) windowManager.removeListener(this);
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
  Widget build(BuildContext context) {
    if (!WindowTitleBar.isSupported) return const SizedBox.shrink();

    return GestureDetector(
      behavior: HitTestBehavior.translucent,
      onPanStart: (_) => windowManager.startDragging(),
      onDoubleTap: _toggleMaximize,
      child: SizedBox(
      height: widget.height,
      child: Row(
        children: [
          const Spacer(),
          _Ctrl(
            icon: LucideIcons.minus,
            label: '最小化',
            hovered: _hover == 0,
            onHover: (v) => setState(() => _hover = v ? 0 : -1),
            onTap: () => windowManager.minimize(),
          ),
          _Ctrl(
            icon: _maximized ? LucideIcons.copy : LucideIcons.square,
            label: _maximized ? '还原' : '最大化',
            hovered: _hover == 1,
            onHover: (v) => setState(() => _hover = v ? 1 : -1),
            onTap: _toggleMaximize,
          ),
          _Ctrl(
            icon: LucideIcons.x,
            label: '关闭',
            hovered: _hover == 2,
            danger: true,
            onHover: (v) => setState(() => _hover = v ? 2 : -1),
            onTap: () => windowManager.close(),
          ),
          const SizedBox(width: 4),
        ],
      ),
      ),
    );
  }

  void _toggleMaximize() {
    if (_maximized) {
      windowManager.unmaximize();
    } else {
      windowManager.maximize();
    }
  }
}

class _Ctrl extends StatelessWidget {
  const _Ctrl({
    required this.icon,
    required this.label,
    required this.hovered,
    required this.onHover,
    required this.onTap,
    this.danger = false,
  });

  final IconData icon;
  final String label;
  final bool hovered;
  final ValueChanged<bool> onHover;
  final VoidCallback onTap;
  final bool danger;

  @override
  Widget build(BuildContext context) {
    final bg = danger && hovered
        ? const Color(0xFFE5484D)
        : (hovered ? PB.bgActive : Colors.transparent);

    return Semantics(
      label: label,
      button: true,
      child: MouseRegion(
        cursor: SystemMouseCursors.basic,
        onEnter: (_) => onHover(true),
        onExit: (_) => onHover(false),
        child: GestureDetector(
          behavior: HitTestBehavior.opaque,
          onTap: onTap,
          child: Container(
            width: 46,
            height: 30,
            alignment: Alignment.center,
            decoration: BoxDecoration(color: bg, borderRadius: BorderRadius.circular(7)),
            child: Icon(
              icon,
              size: 15,
              color: danger && hovered ? Colors.white : PB.textSecondary,
            ),
          ),
        ),
      ),
    );
  }
}

/// 三个窗口控制按钮（单独抽出来，方便塞进任意 AppBar 的 actions 里）。
///
/// 之所以不只放在顶部拖拽条里：无边框窗口下那条区域在某些 DWM 组合下
/// 不渲染子组件，放进 AppBar 更稳。
class WindowControls extends StatefulWidget {
  const WindowControls({super.key});

  @override
  State<WindowControls> createState() => _WindowControlsState();
}

class _WindowControlsState extends State<WindowControls> with WindowListener {
  bool _maximized = false;
  int _hover = -1;

  @override
  void initState() {
    super.initState();
    if (WindowTitleBar.isSupported) {
      windowManager.addListener(this);
      windowManager.isMaximized().then((v) {
        if (mounted) setState(() => _maximized = v);
      });
    }
  }

  @override
  void dispose() {
    if (WindowTitleBar.isSupported) windowManager.removeListener(this);
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
  Widget build(BuildContext context) {
    if (!WindowTitleBar.isSupported) return const SizedBox.shrink();
    return Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        _Ctrl(
          icon: LucideIcons.minus,
          label: '最小化',
          hovered: _hover == 0,
          onHover: (v) => setState(() => _hover = v ? 0 : -1),
          onTap: () => windowManager.minimize(),
        ),
        _Ctrl(
          icon: _maximized ? LucideIcons.copy : LucideIcons.square,
          label: _maximized ? '还原' : '最大化',
          hovered: _hover == 1,
          onHover: (v) => setState(() => _hover = v ? 1 : -1),
          onTap: () => _maximized ? windowManager.unmaximize() : windowManager.maximize(),
        ),
        _Ctrl(
          icon: LucideIcons.x,
          label: '关闭',
          hovered: _hover == 2,
          danger: true,
          onHover: (v) => setState(() => _hover = v ? 2 : -1),
          onTap: () => windowManager.close(),
        ),
      ],
    );
  }
}
