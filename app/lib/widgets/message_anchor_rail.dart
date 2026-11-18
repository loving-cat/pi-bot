import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:flutter/scheduler.dart';

import '../theme.dart';

/// 聊天区右侧的滑轮式滚动条（可拖拽）。
///
/// ## 为什么传统写法会抖或抽搐 —— 原因与解法
///
/// 1) `ListView` 懒渲染且聊天内容在流式输出时高度高频变化：若直接用
///    `pixels = t * maxScrollExtent`，`maxScrollExtent` 突变会乘出
///    `t * ΔM` 的脉冲项，表现就是拖在中间时画面反方向抽搐；
/// 2) 改为「导引微分方程」推动位置：每次只按当前剩余可滚行程与剩余轨道
///    比例推进（`Δp = remScroll * (Δt / remTrack)`），手指不动时画面稳如磐石，
///    向下/向上拖动严格单调，且在端点仍精确收敛到 `0` 和 `maxScrollExtent`；
/// 3) 到达顶/底极值时配合帧后收敛检查，并在外部拖拽期关闭物理回弹，
///    消除按住上下端拖拽时因 `SliverList` 补布局或 `BouncingScrollPhysics`
///    造成的来回反弹抽搐。
class MessageAnchorRail extends StatefulWidget {
  const MessageAnchorRail({
    super.key,
    required this.controller,
    this.gutter = 18,
    this.dragActiveNotifier,
    this.onDragStart,
    this.onDragEnd,
  });

  final ScrollController controller;
  final double gutter;
  final ValueNotifier<bool>? dragActiveNotifier;
  final VoidCallback? onDragStart;
  final ValueChanged<bool>? onDragEnd;

  @override
  State<MessageAnchorRail> createState() => MessageAnchorRailState();
}

/// 公开是为了让外层（包着 ListView 的 NotificationListener）
/// 能把滚动通知转发进来 —— 这条轨在 Stack 里是 ListView 的兄弟节点，
/// 自己收不到 Scroll 通知（它只沿祖先链冒泡）。
class MessageAnchorRailState extends State<MessageAnchorRail> {
  bool _hovering = false;

  /// 滑块位置：0 = 轨道顶部，1 = 轨道底部。
  double _thumbOffset = 1;

  double _lastPixels = double.nan;

  /// 是否处于滚动中（由 ScrollNotification 驱动）。
  bool _scrolling = false;

  /// 是否正在被用户拖拽（此时以拖拽位置为准）。
  bool _dragging = false;

  /// 抓住滑块时的纵向内部偏移，避免刚按下瞬间滑块中心对齐鼠标造成跳变。
  double _grabOffset = _thumbH / 2;

  /// 顶/底极值静默收敛代数，用于取消过期帧后回调。
  int _edgeSettleGen = 0;

  static const double _thumbW = 3;
  static const double _thumbH = 40;
  static const double _padT = 12;
  static const double _padB = 12;
  static const int _maxEdgeSettleFrames = 12;

  @override
  void initState() {
    super.initState();
    widget.controller.addListener(_onScroll);
  }

  @override
  void didUpdateWidget(MessageAnchorRail oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.controller != widget.controller) {
      oldWidget.controller.removeListener(_onScroll);
      widget.controller.addListener(_onScroll);
    }
  }

  @override
  void dispose() {
    _edgeSettleGen++;
    if (widget.dragActiveNotifier?.value == true) {
      widget.dragActiveNotifier?.value = false;
    }
    widget.controller.removeListener(_onScroll);
    super.dispose();
  }

  double _trackSpan(double height) {
    final usable = math.max(1.0, height - _padT - _padB);
    return math.max(1.0, usable - _thumbH);
  }

  /// 避免在 Viewport layout/persistentCallbacks 阶段派发滚动通知时直接触发 setState 报错。
  void _safeSetState(VoidCallback fn) {
    if (!mounted) return;
    if (SchedulerBinding.instance.schedulerPhase ==
        SchedulerPhase.persistentCallbacks) {
      fn();
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (mounted) setState(() {});
      });
    } else {
      setState(fn);
    }
  }

  void _onScroll() {
    if (_dragging) return; // 拖拽期间以滑块导引位置为准
    final c = widget.controller;
    if (!mounted || !c.hasClients) return;
    final p = c.position;
    if (!p.hasContentDimensions) return;

    final min = p.minScrollExtent;
    final max = p.maxScrollExtent;
    // 屏蔽触控板/惯性在顶底极值的越界回弹值，防止滑块跟着回弹抖动
    final clamped = p.pixels.clamp(min, max).toDouble();
    final prev = _lastPixels;
    _lastPixels = clamped;

    if (max <= min) {
      if (_thumbOffset != 1.0) _safeSetState(() => _thumbOffset = 1.0);
      return;
    }
    if (clamped <= min + 0.5) {
      if (_thumbOffset != 0.0) _safeSetState(() => _thumbOffset = 0.0);
      return;
    }
    if ((max - clamped).abs() <= 2.0) {
      if (_thumbOffset != 1.0) _safeSetState(() => _thumbOffset = 1.0);
      return;
    }

    if (!prev.isFinite) return;
    final delta = clamped - prev;
    if (delta.abs() < 0.5) return;

    // 对偶导引微分更新：滑块仅随真实可视位移推进，不因未布局估算变化而反跳
    final double next;
    if (delta > 0) {
      final remScroll = math.max(1.0, max - prev);
      next = (_thumbOffset + (1.0 - _thumbOffset) * (delta / remScroll))
          .clamp(0.0, 1.0);
    } else {
      final remScroll = math.max(1.0, prev - min);
      next = (_thumbOffset + _thumbOffset * (delta / remScroll))
          .clamp(0.0, 1.0);
    }
    if ((next - _thumbOffset).abs() >= 0.0004) {
      _safeSetState(() => _thumbOffset = next);
    }
  }

  /// 由外层（真正包着 ListView 的那个 NotificationListener）转发滚动通知。
  void handleNotification(Notification n) {
    if (n is ScrollStartNotification && n.depth == 0) {
      if (!_scrolling) _safeSetState(() => _scrolling = true);
    } else if (n is ScrollEndNotification && n.depth == 0) {
      if (_scrolling) _safeSetState(() => _scrolling = false);
      if (!_dragging) _syncBoundaryOnRest();
    }
  }

  /// 静止时仅在贴顶/贴底时精确对齐端点，不在中段瞬移滑块。
  void _syncBoundaryOnRest() {
    if (!mounted) return;
    final c = widget.controller;
    if (!c.hasClients) return;
    final p = c.position;
    if (!p.hasContentDimensions) return;

    final min = p.minScrollExtent;
    final max = p.maxScrollExtent;
    final clamped = p.pixels.clamp(min, max).toDouble();
    double? snap;
    if (max <= min || (max - clamped).abs() <= 2.0) {
      snap = 1.0;
    } else if (clamped <= min + 0.5) {
      snap = 0.0;
    }
    if (snap != null && (snap - _thumbOffset).abs() >= 0.002) {
      _safeSetState(() => _thumbOffset = snap!);
    }
  }

  void _scheduleEdgeSettle({required bool toTop, required int remaining}) {
    if (remaining <= 0) return;
    final gen = _edgeSettleGen;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted || !_dragging || gen != _edgeSettleGen) return;
      if (toTop && _thumbOffset > 0.001) return;
      if (!toTop && _thumbOffset < 0.999) return;
      final c = widget.controller;
      if (!c.hasClients) return;
      final p = c.position;
      if (!p.hasContentDimensions) return;

      final target = toTop ? p.minScrollExtent : p.maxScrollExtent;
      if ((p.pixels - target).abs() > 0.5) {
        c.jumpTo(target);
        _scheduleEdgeSettle(toTop: toTop, remaining: remaining - 1);
      }
    });
  }

  void _beginDrag(double localY, double height) {
    _edgeSettleGen++;
    _dragging = true;
    widget.dragActiveNotifier?.value = true;
    widget.onDragStart?.call();

    final trackSpan = _trackSpan(height);
    final thumbTop = _padT + trackSpan * _thumbOffset;
    if (localY >= thumbTop - 8 && localY <= thumbTop + _thumbH + 8) {
      // 直接抓到滑块本体：保留手指在滑块内的相对偏移，0 跳变起手
      _grabOffset = localY - thumbTop;
      if (_thumbOffset <= 0.001) {
        _scheduleEdgeSettle(toTop: true, remaining: _maxEdgeSettleFrames);
      } else if (_thumbOffset >= 0.999) {
        _scheduleEdgeSettle(toTop: false, remaining: _maxEdgeSettleFrames);
      }
      return;
    }

    _grabOffset = _thumbH / 2;
    _dragStep(localY, height);
  }

  void _dragStep(double localY, double height) {
    final c = widget.controller;
    if (!c.hasClients || height <= 0) return;
    final p = c.position;
    if (!p.hasContentDimensions) return;

    final trackSpan = _trackSpan(height);
    final nextT = ((localY - _padT - _grabOffset) / trackSpan).clamp(0.0, 1.0);
    final prevT = _thumbOffset;
    final dt = nextT - prevT;
    final min = p.minScrollExtent;
    final max = p.maxScrollExtent;

    if (nextT <= 0.0) {
      if (_thumbOffset != 0.0) setState(() => _thumbOffset = 0.0);
      if (p.pixels > min + 0.5) c.jumpTo(min);
      if (prevT > 0.0 || p.pixels > min + 0.5) {
        _edgeSettleGen++;
        _scheduleEdgeSettle(toTop: true, remaining: _maxEdgeSettleFrames);
      }
      return;
    }

    if (nextT >= 1.0) {
      if (_thumbOffset != 1.0) setState(() => _thumbOffset = 1.0);
      if (max - p.pixels > 0.5) c.jumpTo(max);
      if (prevT < 1.0 || max - p.pixels > 0.5) {
        _edgeSettleGen++;
        _scheduleEdgeSettle(toTop: false, remaining: _maxEdgeSettleFrames);
      }
      return;
    }

    _edgeSettleGen++;
    // 手指停在中段不动时，即使后台流式输出让内容迅速变长，画面也绝不跳动
    if (dt.abs() < 1e-5) return;

    setState(() => _thumbOffset = nextT);

    final double target;
    if (dt > 0) {
      final remScroll = math.max(0.0, max - p.pixels);
      final remTrack = math.max(1e-4, 1.0 - prevT);
      final step = remScroll * (dt / remTrack);
      target = (p.pixels + step).clamp(min, max).toDouble();
    } else {
      final remScroll = math.max(0.0, p.pixels - min);
      final remTrack = math.max(1e-4, prevT);
      final step = remScroll * (dt / remTrack);
      target = (p.pixels + step).clamp(min, max).toDouble();
    }

    if ((target - p.pixels).abs() >= 0.5) {
      c.jumpTo(target);
    }
  }

  void _finishDrag() {
    _edgeSettleGen++;
    final wasDragging = _dragging;
    _dragging = false;
    _lastPixels = double.nan;

    var atBottom = _thumbOffset >= 0.995;
    final c = widget.controller;
    if (c.hasClients && c.position.hasContentDimensions) {
      final p = c.position;
      if ((p.maxScrollExtent - p.pixels) <= 24) {
        atBottom = true;
      }
    }

    // 推迟到下一帧解锁物理边界，让尾帧 jumpTo 的 layout pass 也保持无回弹
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted && !_dragging) {
        widget.dragActiveNotifier?.value = false;
      }
    });
    if (wasDragging) {
      widget.onDragEnd?.call(atBottom);
    }
  }

  void _tapTrackTo(double localY, double height) {
    if (_dragging) return;
    final c = widget.controller;
    if (!c.hasClients || height <= 0) return;
    final p = c.position;
    if (!p.hasContentDimensions) return;

    final trackSpan = _trackSpan(height);
    final thumbTop = _padT + trackSpan * _thumbOffset;
    if (localY >= thumbTop - 4 && localY <= thumbTop + _thumbH + 4) {
      return;
    }

    _dragging = true;
    widget.dragActiveNotifier?.value = true;
    widget.onDragStart?.call();
    _grabOffset = _thumbH / 2;
    try {
      _dragStep(localY, height);
    } finally {
      _finishDrag();
    }
  }

  @override
  Widget build(BuildContext context) {
    final positionText = '${(_thumbOffset * 100).round()}%';
    final thumbBase = isLightMode ? Colors.black : Colors.white;
    return MouseRegion(
      opaque: false,
      cursor: SystemMouseCursors.basic,
      onEnter: (_) => setState(() => _hovering = true),
      onExit: (_) => setState(() => _hovering = false),
      child: Semantics(
        label: '对话滚动条',
        value: positionText,
        child: GestureDetector(
          behavior: HitTestBehavior.translucent,
          onVerticalDragStart: (d) =>
              _beginDrag(d.localPosition.dy, context.size?.height ?? 0),
          onVerticalDragUpdate: (d) =>
              _dragStep(d.localPosition.dy, context.size?.height ?? 0),
          onVerticalDragEnd: (_) => _finishDrag(),
          onVerticalDragCancel: _finishDrag,
          onTapUp: (d) =>
              _tapTrackTo(d.localPosition.dy, context.size?.height ?? 0),
          child: SizedBox(
            width: widget.gutter,
            child: LayoutBuilder(
              builder: (context, box) {
                final h = box.maxHeight;
                if (!h.isFinite || h <= 0) return const SizedBox.shrink();
                final usable = math.max(1.0, h - _padT - _padB);
                final top = (_padT + (usable - _thumbH) * _thumbOffset)
                    .clamp(_padT, math.max(_padT, h - _padB - _thumbH))
                    .toDouble();

                return Stack(
                  clipBehavior: Clip.none,
                  children: [
                    Positioned(
                      right: 4,
                      top: top,
                      child: MouseRegion(
                        cursor: _dragging
                            ? SystemMouseCursors.grabbing
                            : SystemMouseCursors.click,
                        child: AnimatedContainer(
                          duration: const Duration(milliseconds: 140),
                          curve: const Cubic(0.2, 0, 0, 1),
                          width: (_hovering || _dragging) ? 5 : _thumbW,
                          height: _thumbH,
                          decoration: BoxDecoration(
                            color: thumbBase.withValues(
                              // macOS 原生的 overlay 手感：
                              // 平时几乎不可见（余光可感知，但不抢视线），
                              // 鼠标进入热区才显形；浅色模式下用黑底透明适配。
                              alpha: _dragging
                                  ? 0.55
                                  : (_scrolling
                                        ? 0.30
                                        : (_hovering ? 0.42 : 0.08)),
                            ),
                            borderRadius: BorderRadius.circular(2.5),
                          ),
                        ),
                      ),
                    ),
                  ],
                );
              },
            ),
          ),
        ),
      ),
    );
  }
}
