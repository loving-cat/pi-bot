import 'dart:math' as math;

import 'package:flutter/foundation.dart' show listEquals;
import 'package:flutter/material.dart';

import '../motion.dart';
import '../theme.dart';

/// 思考等级滑条：从关到 max 一档一档拖过去。
///
/// 为什么不用一排 ChoiceChip：
///   · 七个档位（off/minimal/low/medium/high/xhigh/max）横排会挤成一团，
///     一眼看不出"现在到哪一档、还能往哪走"；
///   · 用户对"思考强度"的心理模型就是一根刻度尺，滑块比按钮串更贴合直觉。
///
/// 交互：
///   · 整条轨道**任意位置都能点/拖**（不用非得抓住小球），吸附到最近档位；
///   · 拖动时填充色和小球带过渡动画；到最高档（max）小球会发光呼吸 +
///     轨道跑一道流光 —— 一眼能看出"已经顶格了"。
class ThinkingSlider extends StatefulWidget {
  const ThinkingSlider({
    super.key,
    required this.levels,
    required this.value,
    required this.onChanged,
    this.enabled = true,
  });

  /// 可选档位（顺序即从低到高）。少于两档时退化成只读文案。
  final List<String> levels;

  /// 当前档位（不在 [levels] 里时，滑块停在最左但不选中任何刻度）
  final String? value;

  /// 用户停到某一档（松手后调用一次；拖动过程中不回调，避免频繁写库）
  final ValueChanged<String> onChanged;

  final bool enabled;

  @override
  State<ThinkingSlider> createState() => _ThinkingSliderState();
}

class _ThinkingSliderState extends State<ThinkingSlider>
    with SingleTickerProviderStateMixin {
  /// 拖动中的临时值（0..1），松手后归空、交给 value 决定
  double? _dragT;
  List<String>? _gestureLevels;
  String? _gestureValue;
  bool _dragging = false;

  /// max 档的呼吸动画
  late final AnimationController _pulse = AnimationController(
    vsync: this,
    duration: const Duration(milliseconds: 1800),
  );

  @override
  void initState() {
    super.initState();
    _syncPulse();
  }

  @override
  void didUpdateWidget(ThinkingSlider old) {
    super.didUpdateWidget(old);
    if (_gestureLevels != null && !_gestureValid) _resetGesture();
    if (old.value != widget.value || !listEquals(old.levels, widget.levels)) {
      _syncPulse();
    }
  }

  @override
  void dispose() {
    _pulse.dispose();
    super.dispose();
  }

  bool get _isMax =>
      widget.levels.isNotEmpty && widget.value == widget.levels.last;

  void _syncPulse() {
    if (_isMax) {
      if (!_pulse.isAnimating) _pulse.repeat();
    } else {
      _pulse.stop();
      _pulse.value = 0;
    }
  }

  int get _index {
    if (widget.levels.isEmpty) return -1;
    final i = widget.levels.indexOf(widget.value ?? '');
    return i;
  }

  /// 当前归一化位置（0..1）
  double get _t {
    if (_dragT != null) return _dragT!;
    if (widget.levels.length <= 1) return 0;
    final i = _index;
    if (i < 0) return 0;
    return i / (widget.levels.length - 1);
  }

  int _indexForT(double t) {
    final n = widget.levels.length;
    if (n <= 1) return 0;
    return (t * (n - 1)).round().clamp(0, n - 1);
  }

  bool get _gestureValid =>
      widget.enabled &&
      _gestureLevels != null &&
      listEquals(_gestureLevels, widget.levels) &&
      _gestureValue == widget.value;

  void _resetGesture() {
    _dragT = null;
    _gestureLevels = null;
    _gestureValue = null;
    _dragging = false;
  }

  void _cancel({bool tapOnly = false}) {
    if (tapOnly && _dragging) return;
    if (_dragT == null && _gestureLevels == null) return;
    setState(_resetGesture);
  }

  void _begin(double dx, double width, {bool dragging = false}) {
    if (!widget.enabled || widget.levels.length < 2) return;
    _gestureLevels = List.of(widget.levels);
    _gestureValue = widget.value;
    _dragging = dragging;
    _updateFromDx(dx, width);
  }

  void _updateFromDx(double dx, double width) {
    if (!_gestureValid) {
      _cancel();
      return;
    }
    final t = (dx / math.max(1, width)).clamp(0.0, 1.0);
    final idx = _indexForT(t);
    final snapped = widget.levels.length <= 1
        ? 0.0
        : idx / (widget.levels.length - 1);
    setState(() => _dragT = snapped);
  }

  void _commit() {
    final t = _dragT;
    if (t == null) return;
    if (!_gestureValid || widget.levels.length < 2) {
      _cancel();
      return;
    }
    final level = widget.levels[_indexForT(t)];
    setState(_resetGesture);
    if (level != widget.value) widget.onChanged(level);
  }

  @override
  Widget build(BuildContext context) {
    if (widget.levels.isEmpty) return const SizedBox.shrink();
    if (widget.levels.length == 1) {
      return Text(
        '思考等级：${_label(widget.levels.first)}',
        style: const TextStyle(fontSize: PB.fsXs, color: PB.textTertiary),
      );
    }

    return LayoutBuilder(
      builder: (context, constraints) {
        final width = constraints.maxWidth;
        return Listener(
          onPointerCancel: (_) => _cancel(),
          child: GestureDetector(
            behavior: HitTestBehavior.opaque,
            onTapDown: (d) => _begin(d.localPosition.dx, width),
            onTapUp: (_) => _commit(),
            onTapCancel: () => _cancel(tapOnly: true),
            onHorizontalDragStart: (d) =>
                _begin(d.localPosition.dx, width, dragging: true),
            onHorizontalDragUpdate: (d) =>
                _updateFromDx(d.localPosition.dx, width),
            onHorizontalDragEnd: (_) => _commit(),
            onHorizontalDragCancel: _cancel,
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [_track(width), const SizedBox(height: 6), _labels()],
            ),
          ),
        );
      },
    );
  }

  String _label(String level) => switch (level) {
    'off' => '关',
    'minimal' => '极低',
    'low' => '低',
    'medium' => '中',
    'high' => '高',
    'xhigh' => '很高',
    'max' => '最高',
    _ => level,
  };

  Widget _track(double width) {
    final t = _t;
    final enabled = widget.enabled;
    return SizedBox(
      height: 26,
      child: AnimatedBuilder(
        animation: _pulse,
        builder: (context, _) {
          // 到 max：小球脉动 + 轨道外发光
          final glow = _isMax ? (0.35 + 0.35 * _pulse.value) : 0.0;
          return CustomPaint(
            painter: _TrackPainter(
              t: t,
              levels: widget.levels.length,
              glow: glow,
              dim: !enabled,
            ),
            child: const SizedBox.expand(),
          );
        },
      ),
    );
  }

  Widget _labels() {
    final n = widget.levels.length;
    final idx = _index;
    return Stack(
      children: [
        Row(
          children: [
            for (var i = 0; i < n; i++)
              Expanded(
                child: Text(
                  _label(widget.levels[i]),
                  textAlign: i == 0
                      ? TextAlign.left
                      : (i == n - 1 ? TextAlign.right : TextAlign.center),
                  style: TextStyle(
                    fontSize: PB.fsXxs,
                    color: i == idx ? PB.accentBright : PB.textQuaternary,
                    fontWeight: i == idx ? FontWeight.w600 : FontWeight.w400,
                  ),
                ),
              ),
          ],
        ),
      ],
    );
  }
}

class _TrackPainter extends CustomPainter {
  _TrackPainter({
    required this.t,
    required this.levels,
    required this.glow,
    required this.dim,
  });

  final double t;
  final int levels;
  final double glow;
  final bool dim;

  @override
  void paint(Canvas canvas, Size size) {
    const h = 5.0;
    const knob = 9.0;
    final cy = size.height / 2;
    final left = knob;
    final right = size.width - knob;
    final usable = math.max(1.0, right - left);
    final x = left + usable * t;

    final rect = RRect.fromLTRBR(
      left - knob,
      cy - h / 2,
      right + knob,
      cy + h / 2,
      const Radius.circular(h),
    );
    final base = Paint()
      ..color = dim ? PB.bgActive : PB.bgActive.withValues(alpha: 0.9);
    canvas.drawRRect(rect, base);

    // 已走部分：accent 渐变（越往右越亮）
    final fillRect = RRect.fromLTRBR(
      left - knob,
      cy - h / 2,
      math.max(left + knob, x),
      cy + h / 2,
      const Radius.circular(h),
    );
    final fillPaint = Paint()
      ..shader =
          LinearGradient(
            colors: dim
                ? [PB.textQuaternary, PB.textTertiary]
                : [PB.accent.withValues(alpha: 0.55), PB.accentBright],
          ).createShader(
            Rect.fromLTWH(
              left - knob,
              0,
              math.max(1, x - left + knob * 2),
              size.height,
            ),
          );
    canvas.drawRRect(fillRect, fillPaint);

    // 刻度点：每一档一个
    final tick = Paint()..color = PB.bgPane.withValues(alpha: 0.85);
    for (var i = 0; i < levels; i++) {
      final tt = levels <= 1 ? 0.0 : i / (levels - 1);
      canvas.drawCircle(Offset(left + usable * tt, cy), 1.1, tick);
    }

    // 顶格光晕
    if (glow > 0) {
      canvas.drawCircle(
        Offset(x, cy),
        knob + 7 * glow,
        Paint()..color = PB.accentBright.withValues(alpha: 0.22 * glow),
      );
    }

    // 小球
    canvas.drawCircle(Offset(x, cy), knob, Paint()..color = PB.bgPane);
    canvas.drawCircle(
      Offset(x, cy),
      knob - 1.6,
      Paint()
        ..color = dim ? PB.textTertiary : Colors.white
        ..style = PaintingStyle.fill,
    );
    // 小球内圈一点 accent，让"当前档位"更明确
    canvas.drawCircle(
      Offset(x, cy),
      knob - 4.6,
      Paint()..color = dim ? PB.textQuaternary : PB.accent,
    );
  }

  @override
  bool shouldRepaint(_TrackPainter old) =>
      old.t != t || old.glow != glow || old.dim != dim || old.levels != levels;
}

/// 带"已选档位"文案的整块控件（面板里直接用这个）
class ThinkingLevelField extends StatelessWidget {
  const ThinkingLevelField({
    super.key,
    required this.levels,
    required this.value,
    required this.onChanged,
    this.enabled = true,
  });

  final List<String> levels;
  final String? value;
  final ValueChanged<String> onChanged;
  final bool enabled;

  static String labelOf(String level) => switch (level) {
    'off' => '关',
    'minimal' => '极低',
    'low' => '低',
    'medium' => '中',
    'high' => '高',
    'xhigh' => '很高',
    'max' => '最高',
    _ => level,
  };

  @override
  Widget build(BuildContext context) {
    if (levels.isEmpty) return const SizedBox.shrink();
    final current = labelOf(value ?? levels.first);
    final isMax = value != null && levels.isNotEmpty && value == levels.last;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Row(
          children: [
            const Text(
              '思考等级',
              style: TextStyle(fontSize: PB.fsXs, color: PB.textTertiary),
            ),
            const Spacer(),
            AnimatedSwitcher(
              duration: Motion.fast,
              child: Text(
                isMax ? '$current · 顶格' : current,
                key: ValueKey(current),
                style: TextStyle(
                  fontSize: PB.fsXs,
                  fontWeight: FontWeight.w600,
                  color: isMax ? PB.accentBright : PB.textSecondary,
                ),
              ),
            ),
          ],
        ),
        const SizedBox(height: 8),
        ThinkingSlider(
          levels: levels,
          value: value,
          onChanged: onChanged,
          enabled: enabled,
        ),
      ],
    );
  }
}
