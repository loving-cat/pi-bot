import 'package:flutter/rendering.dart' show ScrollDirection;
import 'package:flutter/scheduler.dart' show SchedulerPhase;
import 'package:flutter/widgets.dart';

/// 聊天列表的追底调度；用户离开底部时取消旧任务，布局变化按帧收敛。
class ChatScrollFollow {
  ChatScrollFollow(
    this.controller, {
    required this.onFollowingChanged,
    this.nearBottom = 140,
    this.maxFrames = 10,
  }) {
    controller.addListener(_onOffsetChanged);
  }

  final ScrollController controller;
  final ValueChanged<bool> onFollowingChanged;
  final double nearBottom;
  final int maxFrames;

  bool get following => _following;

  bool _following = true;
  bool _disposed = false;
  bool _active = false;
  bool _jumping = false;
  bool _resumeAfterDrag = false;
  int _generation = 0;
  int? _animatedGeneration;
  ScrollPosition? _lastPosition;
  double? _lastPixels;

  /// 同一轮最多安排 maxFrames 帧；重复请求不重置预算或叠加回调。
  void request() => _start(animate: false);

  /// 显式发送或回到底部时恢复跟随，动画完成后继续校准懒列表高度。
  void resume({bool animate = false}) {
    if (_disposed) return;
    _setFollowing(true);
    _start(animate: animate);
  }

  /// 取消尚未执行的补跳；手势或外部滚动负责中止正在运行的滚动活动。
  void pause() {
    if (_disposed) return;
    _generation++;
    _active = false;
    _animatedGeneration = null;
    _resumeAfterDrag = false;
    _setFollowing(false);
  }

  /// 仅处理本列表的滚动通知，嵌套预览与横向列表不改变跟随意图。
  bool handleNotification(Notification notification) {
    if (_disposed) return false;
    if (notification is ScrollMetricsNotification && notification.depth == 0) {
      request();
    } else if (notification is ScrollNotification && notification.depth == 0) {
      if (notification is ScrollStartNotification &&
          notification.dragDetails != null) {
        final wasAtBottom =
            _following &&
            (notification.metrics.maxScrollExtent - notification.metrics.pixels)
                    .abs() <=
                1;
        pause();
        _resumeAfterDrag = wasAtBottom;
      } else if (notification is UserScrollNotification &&
          notification.direction == ScrollDirection.forward) {
        pause();
      } else if (notification is ScrollEndNotification) {
        final restore = _resumeAfterDrag;
        _resumeAfterDrag = false;
        if (restore &&
            (notification.metrics.maxScrollExtent - notification.metrics.pixels)
                    .abs() <=
                1) {
          resume();
        }
      }
    }
    return false;
  }

  void _setFollowing(bool value) {
    if (_following == value) return;
    _following = value;
    onFollowingChanged(value);
  }

  void _onOffsetChanged() {
    if (_disposed || !controller.hasClients) return;
    final position = controller.position;
    final previous = identical(position, _lastPosition) ? _lastPixels : null;
    _lastPosition = position;
    _lastPixels = position.pixels;
    if (_jumping || previous == null) return;
    if (WidgetsBinding.instance.schedulerPhase ==
        SchedulerPhase.persistentCallbacks) {
      return;
    }

    final delta = position.pixels - previous;
    final remaining = position.maxScrollExtent - position.pixels;
    if (delta < -0.5 && remaining > 1) {
      pause();
    } else if (_animatedGeneration == null && delta.abs() > 0.5) {
      if (remaining > nearBottom) {
        pause();
      } else if (delta > 0) {
        _setFollowing(true);
      }
    }
  }

  void _start({required bool animate}) {
    if (_disposed || !_following || _active) return;
    _active = true;
    _schedule(_generation, maxFrames, animate);
  }

  bool _current(int generation) =>
      !_disposed && _following && generation == _generation;

  void _schedule(int generation, int remaining, bool animate) {
    WidgetsBinding.instance.addPostFrameCallback((_) {
      _step(generation, remaining, animate);
    });
    WidgetsBinding.instance.ensureVisualUpdate();
  }

  Future<void> _step(int generation, int remaining, bool animate) async {
    if (!_current(generation)) return;
    if (!controller.hasClients || remaining <= 0) {
      _active = false;
      return;
    }
    final position = controller.position;
    _lastPosition = position;
    _lastPixels = position.pixels;
    if (!position.hasContentDimensions) {
      _schedule(generation, remaining - 1, animate);
      return;
    }
    if ((position.maxScrollExtent - position.pixels).abs() <= 1) {
      _active = false;
      return;
    }

    if (animate) {
      _animatedGeneration = generation;
      try {
        await position.animateTo(
          position.maxScrollExtent,
          duration: const Duration(milliseconds: 200),
          curve: Curves.easeOut,
        );
      } finally {
        if (_animatedGeneration == generation) _animatedGeneration = null;
      }
      if (!_current(generation)) return;
    } else {
      _jumping = true;
      try {
        position.jumpTo(position.maxScrollExtent);
      } finally {
        _jumping = false;
      }
    }
    if (_current(generation)) {
      _schedule(generation, remaining - 1, false);
    }
  }

  void dispose() {
    if (_disposed) return;
    _disposed = true;
    _generation++;
    controller.removeListener(_onOffsetChanged);
  }
}
