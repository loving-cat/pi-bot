import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';

import 'window_actions.dart';

const double windowChromeControlsReserve = 144;
const double windowChromeHeaderHeight = 40;

bool supportsWindowChrome(TargetPlatform platform) =>
    !kIsWeb &&
    (platform == TargetPlatform.macOS ||
        platform == TargetPlatform.windows ||
        platform == TargetPlatform.linux);

/// 整个窗口共用同一动作控制器与平台布局。
class WindowChromeScope extends InheritedWidget {
  const WindowChromeScope({
    super.key,
    required this.controller,
    required this.platform,
    required super.child,
  });

  final WindowActionsController controller;
  final TargetPlatform platform;

  static WindowChromeScope? maybeOf(BuildContext context) =>
      context.dependOnInheritedWidgetOfExactType<WindowChromeScope>();

  @override
  bool updateShouldNotify(WindowChromeScope oldWidget) =>
      !identical(controller, oldWidget.controller) ||
      platform != oldWidget.platform;
}

/// 标记当前栏是否接触窗口左右边缘，只有拥有控制角的栏需要避让。
class WindowChromeRegion extends InheritedWidget {
  const WindowChromeRegion({
    super.key,
    this.leading = true,
    this.trailing = true,
    required super.child,
  });

  final bool leading;
  final bool trailing;

  static WindowChromeRegion? maybeOf(BuildContext context) =>
      context.dependOnInheritedWidgetOfExactType<WindowChromeRegion>();

  @override
  bool updateShouldNotify(WindowChromeRegion oldWidget) =>
      leading != oldWidget.leading || trailing != oldWidget.trailing;
}

/// 标题工具区的局部预留，不改变页面主体的宽度或高度。
EdgeInsets windowChromeHeaderInsets(
  BuildContext context, {
  bool customHeader = false,
}) {
  final scope = WindowChromeScope.maybeOf(context);
  if (scope == null || !supportsWindowChrome(scope.platform)) {
    return EdgeInsets.zero;
  }
  final region = WindowChromeRegion.maybeOf(context);
  final leading = region?.leading ?? true;
  final trailing = region?.trailing ?? true;
  if (scope.platform == TargetPlatform.macOS && leading) {
    return const EdgeInsets.only(top: windowChromeHeaderHeight);
  }
  if (scope.platform != TargetPlatform.macOS && trailing) {
    return customHeader
        ? const EdgeInsets.only(top: windowChromeHeaderHeight)
        : const EdgeInsets.only(right: windowChromeControlsReserve);
  }
  return EdgeInsets.zero;
}

/// 为标准 AppBar 留出控制角；拖动背景由调用方的 flexibleSpace 提供。
PreferredSizeWidget chromeAppBar(BuildContext context, AppBar bar) {
  final insets = windowChromeHeaderInsets(context);
  return PreferredSize(
    preferredSize: Size.fromHeight(bar.preferredSize.height + insets.vertical),
    child: Padding(padding: insets, child: bar),
  );
}

/// 自定义工具栏局部避让控制角，保持窄侧栏中的操作宽度。
class ChromeSafeHeader extends StatelessWidget {
  const ChromeSafeHeader({super.key, required this.child});

  final Widget child;

  @override
  Widget build(BuildContext context) => Padding(
    padding: windowChromeHeaderInsets(context, customHeader: true),
    child: child,
  );
}

/// 现有工具区的空白背景与品牌把手可拖动窗口，双击切换原生放大状态。
class WindowDragArea extends StatelessWidget {
  const WindowDragArea({super.key, this.child = const SizedBox.expand()});

  final Widget child;

  @override
  Widget build(BuildContext context) {
    final scope = WindowChromeScope.maybeOf(context);
    if (scope == null || !supportsWindowChrome(scope.platform)) return child;
    return GestureDetector(
      behavior: HitTestBehavior.opaque,
      onPanStart: (_) => unawaited(scope.controller.startDrag()),
      onDoubleTap: () => unawaited(scope.controller.toggleMaximize()),
      child: child,
    );
  }
}
