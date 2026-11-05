import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';

import '../window_actions.dart';
import '../window_chrome.dart';
import 'window_buttons.dart';

/// 页面保持全尺寸，只在控制角绘制窗口操作；缩放热区由 child 装配。
class DesktopWindowFrame extends StatefulWidget {
  const DesktopWindowFrame({
    super.key,
    required this.child,
    this.controller,
    this.platform,
  });

  final Widget child;
  final WindowActionsController? controller;
  final TargetPlatform? platform;

  static bool get isSupported => supportsWindowChrome(defaultTargetPlatform);

  @override
  State<DesktopWindowFrame> createState() => _DesktopWindowFrameState();
}

class _DesktopWindowFrameState extends State<DesktopWindowFrame> {
  late WindowActionsController _controller;
  late bool _ownsController;

  TargetPlatform get _platform => widget.platform ?? defaultTargetPlatform;

  void _attach() {
    _ownsController = widget.controller == null;
    _controller = widget.controller ?? WindowActionsController();
    if (supportsWindowChrome(_platform)) unawaited(_controller.initialize());
  }

  @override
  void initState() {
    super.initState();
    _attach();
  }

  @override
  void didUpdateWidget(DesktopWindowFrame oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (!identical(oldWidget.controller, widget.controller)) {
      if (_ownsController) _controller.dispose();
      _attach();
    } else if (supportsWindowChrome(_platform)) {
      unawaited(_controller.initialize());
    }
  }

  @override
  void dispose() {
    if (_ownsController) _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    if (!supportsWindowChrome(_platform)) return widget.child;
    return WindowChromeScope(
      controller: _controller,
      platform: _platform,
      child: WindowChromeRegion(
        child: Stack(
          fit: StackFit.expand,
          children: [
            widget.child,
            Positioned(
              top: 8,
              left: _platform == TargetPlatform.macOS ? 12 : null,
              right: _platform == TargetPlatform.macOS ? null : 12,
              child: WindowButtons(
                controller: _controller,
                platform: _platform,
              ),
            ),
          ],
        ),
      ),
    );
  }
}
