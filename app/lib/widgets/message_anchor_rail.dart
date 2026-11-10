import 'dart:math' as math;

import 'package:flutter/material.dart';

/// 聊天区右侧的滑轮式滚动条（可拖拽）。
///
/// ## 为什么位置算不准 / 为什么会抖 —— 两难与解法
///
/// 直接按 pixels / maxScrollExtent 算：**准，但抖**。
/// ListView.builder 懒渲染，滚动经过未布局的长消息时
/// maxScrollExtent 会突然跳变，比值跟着跳。
///
/// 只用增量累积：**不抖，但漂**。
/// 长时间滚动后和真实位置对不上，首尾也对不齐。
///
/// 这里用混合方案：
///   · 滚动过程中按增量走（不读总高度，所以不跳）；
///   · 滚动停下 120ms 后，用真实比例校准一次（静止时校准不会被看见）；
///   · 两个端点永远精确对齐：滚到顶=0，滚到底=1。
///
/// 拖拽时则完全走真实比例（拖动是用户主动操作，必须跟手准确）。
class MessageAnchorRail extends StatefulWidget {
  const MessageAnchorRail({
    super.key,
    required this.controller,
    this.gutter = 18,
  });

  final ScrollController controller;
  final double gutter;

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

  static const double _thumbW = 3;
  static const double _thumbH = 40;
  static const double _padT = 12;
  static const double _padB = 12;

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
    widget.controller.removeListener(_onScroll);
    super.dispose();
  }

  void _onScroll() {
    if (_dragging) return; // 拖拽期间以手指位置为准
    final c = widget.controller;
    if (!mounted || !c.hasClients) return;
    final p = c.position;
    if (!p.hasContentDimensions) return;

    final pixels = p.pixels;
    final prev = _lastPixels;
    _lastPixels = pixels;
    if (!prev.isFinite) return;

    final delta = pixels - prev;
    // 滚动中：按增量走
    if (delta.abs() >= 0.5) {
      // ★ 换算基准必须是**实际可滚动范围**，不是一屏高度。
      //
      //   原来用 (delta / viewport) * 0.18：内容是 10 屏时真实比例是
      //   delta / (10*viewport)，却按 0.18 走 —— 滑块以 1.8 倍速跑，
      //   往上滚五六屏就撞到顶并一直贴边，误差一路累积。
      //
      //   只有内容≈1 屏时那个系数才碰巧对。
      final max = p.maxScrollExtent;
      final span = max.isFinite && max > 0 ? max : p.viewportDimension;
      if (span.isFinite && span > 0) {
        final step = delta / span;
        var next = (_thumbOffset + step).clamp(0.0, 1.0);
        // 端点精确对齐
        if (pixels <= 0.5) next = 0;
        if ((max - pixels).abs() < 8) next = 1;
        if ((next - _thumbOffset).abs() >= 0.0004) {
          setState(() => _thumbOffset = next);
        }
      }
    }
  }

  /// 由外层（真正包着 ListView 的那个 NotificationListener）转发滚动通知。
  ///
  /// ★ 不能靠组件内部自己套 NotificationListener —— 这条轨在 Stack 里
  ///   和 ListView 是**兄弟节点**，而 Scroll 通知只沿祖先链向上冒泡，
  ///   兄弟永远收不到。自己套的结果就是滚动结束检测从不触发，
  ///   校准一次都不执行，误差一路累积到下次手动拖拽。
  ///
  /// 用 ScrollEndNotification 而不是定时器：定时器在惯性还没停时就会
  /// 触发，那时位置还在变，校准会表现为轻微跳一下。
  void handleNotification(Notification n) {
    if (n is ScrollStartNotification && n.depth == 0) {
      if (!_scrolling) setState(() => _scrolling = true);
    } else if (n is ScrollEndNotification && n.depth == 0) {
      if (_scrolling) setState(() => _scrolling = false);
      _recalibrate();
    }
  }

  /// 用真实比例校准滑块位置（只在静止时调用）。
  void _recalibrate() {
    if (!mounted) return;
    final c = widget.controller;
    if (!c.hasClients) return;
    final p = c.position;
    if (!p.hasContentDimensions) return;

    final max = p.maxScrollExtent;
    double next;
    if (max <= 0) {
      next = 1; // 内容不足一屏，视为在底部
    } else if (p.pixels <= 0.5) {
      next = 0;
    } else if ((max - p.pixels).abs() < 8) {
      next = 1;
    } else {
      next = (p.pixels / max).clamp(0.0, 1.0);
    }

    if ((next - _thumbOffset).abs() < 0.002) return;
    setState(() => _thumbOffset = next);
  }

  /// 拖拽：按指针纵向位置换算真实比例并跳转。
  void _dragTo(double localY, double height) {
    final c = widget.controller;
    if (!c.hasClients) return;
    final p = c.position;
    if (!p.hasContentDimensions) return;
    final usable = math.max(1.0, height - _padT - _padB - _thumbH);
    final t = ((localY - _padT - _thumbH / 2) / usable).clamp(0.0, 1.0);
    setState(() => _thumbOffset = t);
    c.jumpTo(t * p.maxScrollExtent);
  }

  @override
  Widget build(BuildContext context) {
    final positionText = '${(_thumbOffset * 100).round()}%';
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
            onVerticalDragStart: (d) {
              _dragging = true;
              final h = context.size?.height ?? 0;
              _dragTo(d.localPosition.dy, h);
            },
            onVerticalDragUpdate: (d) {
              final h = context.size?.height ?? 0;
              _dragTo(d.localPosition.dy, h);
            },
            onVerticalDragEnd: (_) {
              _dragging = false;
              _lastPixels = double.nan; // 重新初始化增量基准
              _recalibrate();
            },
            onVerticalDragCancel: () {
              _dragging = false;
              _lastPixels = double.nan;
            },
            onTapDown: (d) {
              // 点轨道也能跳过去（鼠标用户常用）
              _dragTo(d.localPosition.dy, context.size?.height ?? 0);
            },
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
                              color: Colors.white.withValues(
                                // macOS 原生的 overlay 手感：
                                // 平时几乎不可见（余光可感知，但不抢视线），
                                // 鼠标进入热区才显形。常驻 20% 太扎眼。
                                // 拖动 55% > 滚动中 30% > 悬停 42% > 静置 8%。
                                // 滚动中特意提亮：那时用户最需要知道自己在哪。
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
