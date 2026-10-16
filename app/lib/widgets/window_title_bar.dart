import 'dart:io' show Platform;

import 'package:flutter/foundation.dart' show kIsWeb;
import 'package:flutter/material.dart';
import 'package:window_manager/window_manager.dart';

/// 无边框窗口顶部的**拖拽条**。
///
/// 只负责拖拽（和双击最大化/还原）—— 窗口控制按钮统一由
/// `WindowControlsOverlay` 画在右上角，避免出现两套按钮。
class WindowTitleBar extends StatefulWidget {
  const WindowTitleBar({super.key, this.height = 36});

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
      child: SizedBox(
        height: widget.height,
        width: double.infinity,
        // 拖拽区不画任何东西，避免和右上角的按钮重叠
      ),
    );
  }
}

/// 右上角的窗口控制按钮：最小化 / 最大化 / 关闭。
///
/// 用最朴素的 IconButton —— 之前封装成带 MouseRegion/GestureDetector 的
/// 自定义组件时，在无边框窗口下整个子树不渲染（排查了很久）。
class WindowControlsOverlay extends StatelessWidget {
  const WindowControlsOverlay({super.key});

  static bool get isSupported => WindowTitleBar.isSupported;

  @override
  Widget build(BuildContext context) {
    if (!isSupported) return const SizedBox.shrink();
    return Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        IconButton(
          tooltip: '最小化',
          iconSize: 15,
          padding: EdgeInsets.zero,
          visualDensity: VisualDensity.compact,
          constraints: const BoxConstraints(minWidth: 32, minHeight: 32),
          onPressed: () => windowManager.minimize(),
          icon: const Icon(Icons.remove_rounded, size: 15),
        ),
        IconButton(
          tooltip: '最大化 / 还原',
          iconSize: 14,
          padding: EdgeInsets.zero,
          visualDensity: VisualDensity.compact,
          constraints: const BoxConstraints(minWidth: 32, minHeight: 32),
          onPressed: () async {
            if (await windowManager.isMaximized()) {
              await windowManager.unmaximize();
            } else {
              await windowManager.maximize();
            }
          },
          icon: const Icon(Icons.crop_square_rounded, size: 13),
        ),
        IconButton(
          tooltip: '关闭',
          iconSize: 15,
          padding: EdgeInsets.zero,
          visualDensity: VisualDensity.compact,
          constraints: const BoxConstraints(minWidth: 32, minHeight: 32),
          onPressed: () => windowManager.close(),
          icon: const Icon(Icons.close_rounded, size: 15),
        ),
        const SizedBox(width: 6),
      ],
    );
  }
}
