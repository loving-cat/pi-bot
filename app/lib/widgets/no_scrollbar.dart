import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';

/// 不画滚动条（滚动本身照常可用）。
///
/// ★ 只给**聊天消息列表**用，不要挂到 MaterialApp 上。
///
///   聊天内容在流式输出时高度高频变化，系统滑块跟着反复重算 ——
///   观感就是「抽搐」，所以那一处要关掉。
///
///   但挂到 MaterialApp 会影响**所有**可滚动组件：设置页、日志、
///   文件列表、回执二级页全都失去滚动条，长列表再也判断不了
///   「下面还有多少」。那是功能倒退，不是优化。
class NoScrollbarBehavior extends MaterialScrollBehavior {
  const NoScrollbarBehavior({this.clampOverscroll});

  /// 右侧滑块拖拽期间锁死物理越界（避免 BouncingScrollPhysics 反复回弹抽搐）。
  final ValueListenable<bool>? clampOverscroll;

  @override
  Widget buildScrollbar(
    BuildContext context,
    Widget child,
    ScrollableDetails details,
  ) {
    // 直接返回内容，不套 Scrollbar
    return child;
  }

  @override
  ScrollPhysics getScrollPhysics(BuildContext context) {
    final base = super.getScrollPhysics(context);
    final lock = clampOverscroll;
    if (lock == null) return base;
    if (base is BouncingScrollPhysics) {
      return _DragClampedBouncingPhysics(
        clampOverscroll: lock,
        decelerationRate: base.decelerationRate,
        parent: base.parent,
      );
    }
    if (base is ClampingScrollPhysics) {
      return _DragClampedClampingPhysics(
        clampOverscroll: lock,
        parent: base.parent,
      );
    }
    return base;
  }

  @override
  bool shouldNotify(covariant NoScrollbarBehavior oldDelegate) =>
      oldDelegate.clampOverscroll != clampOverscroll ||
      super.shouldNotify(oldDelegate);
}

double _clampToNewDimensions(
  ScrollPhysics self,
  double raw,
  ScrollMetrics newPosition,
  ValueListenable<bool> clampOverscroll,
) {
  if (!clampOverscroll.value) return raw;
  return clampDouble(raw, newPosition.minScrollExtent, newPosition.maxScrollExtent);
}

double _clampingBoundaryOffset(ScrollMetrics position, double value) {
  if (value < position.pixels && position.pixels <= position.minScrollExtent) {
    return value - position.pixels;
  }
  if (position.maxScrollExtent <= position.pixels && position.pixels < value) {
    return value - position.pixels;
  }
  if (value < position.minScrollExtent && position.minScrollExtent < position.pixels) {
    return value - position.minScrollExtent;
  }
  if (position.pixels < position.maxScrollExtent && position.maxScrollExtent < value) {
    return value - position.maxScrollExtent;
  }
  return 0.0;
}

class _DragClampedBouncingPhysics extends BouncingScrollPhysics {
  const _DragClampedBouncingPhysics({
    required this.clampOverscroll,
    super.decelerationRate,
    super.parent,
  });

  final ValueListenable<bool> clampOverscroll;

  @override
  _DragClampedBouncingPhysics applyTo(ScrollPhysics? ancestor) {
    return _DragClampedBouncingPhysics(
      clampOverscroll: clampOverscroll,
      decelerationRate: decelerationRate,
      parent: buildParent(ancestor),
    );
  }

  @override
  double adjustPositionForNewDimensions({
    required ScrollMetrics oldPosition,
    required ScrollMetrics newPosition,
    required bool isScrolling,
    required double velocity,
  }) {
    final raw = super.adjustPositionForNewDimensions(
      oldPosition: oldPosition,
      newPosition: newPosition,
      isScrolling: isScrolling,
      velocity: velocity,
    );
    return _clampToNewDimensions(this, raw, newPosition, clampOverscroll);
  }

  @override
  double applyBoundaryConditions(ScrollMetrics position, double value) {
    if (clampOverscroll.value) {
      return _clampingBoundaryOffset(position, value);
    }
    return super.applyBoundaryConditions(position, value);
  }

  @override
  Simulation? createBallisticSimulation(ScrollMetrics position, double velocity) {
    if (clampOverscroll.value &&
        position.pixels >= position.minScrollExtent &&
        position.pixels <= position.maxScrollExtent) {
      return null;
    }
    return super.createBallisticSimulation(position, velocity);
  }
}

class _DragClampedClampingPhysics extends ClampingScrollPhysics {
  const _DragClampedClampingPhysics({
    required this.clampOverscroll,
    super.parent,
  });

  final ValueListenable<bool> clampOverscroll;

  @override
  _DragClampedClampingPhysics applyTo(ScrollPhysics? ancestor) {
    return _DragClampedClampingPhysics(
      clampOverscroll: clampOverscroll,
      parent: buildParent(ancestor),
    );
  }

  @override
  double adjustPositionForNewDimensions({
    required ScrollMetrics oldPosition,
    required ScrollMetrics newPosition,
    required bool isScrolling,
    required double velocity,
  }) {
    final raw = super.adjustPositionForNewDimensions(
      oldPosition: oldPosition,
      newPosition: newPosition,
      isScrolling: isScrolling,
      velocity: velocity,
    );
    return _clampToNewDimensions(this, raw, newPosition, clampOverscroll);
  }

  @override
  double applyBoundaryConditions(ScrollMetrics position, double value) {
    if (clampOverscroll.value) {
      return _clampingBoundaryOffset(position, value);
    }
    return super.applyBoundaryConditions(position, value);
  }

  @override
  Simulation? createBallisticSimulation(ScrollMetrics position, double velocity) {
    if (clampOverscroll.value &&
        position.pixels >= position.minScrollExtent &&
        position.pixels <= position.maxScrollExtent) {
      return null;
    }
    return super.createBallisticSimulation(position, velocity);
  }
}
