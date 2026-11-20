import 'dart:math' as math;

import 'package:flutter/foundation.dart' show listEquals, visibleForTesting;
import 'package:flutter/material.dart';
import 'package:flutter/scheduler.dart';

import '../l10n/l10n.dart';
import '../motion.dart';
import '../theme.dart';

/// 粒子物理参数（确定性种子，避免每帧随机分配）。
class _EnergyParticle {
  const _EnergyParticle({
    required this.seed,
    required this.lane,
    required this.speedMul,
    required this.radius,
    required this.minT,
    this.orbital = false,
  });

  final double seed;
  final double lane;
  final double speedMul;
  final double radius;
  final double minT;
  final bool orbital;
}

/// 22 个确定性能量粒子：16 个沿轨道流向滑块汇聚加速，6 个在高档位环绕滑块旋转。
const List<_EnergyParticle> _kParticles = [
  // ---- 轨道流粒子（16） ----
  _EnergyParticle(seed: 0.05, lane: -0.65, speedMul: 0.72, radius: 1.0, minT: 0.08),
  _EnergyParticle(seed: 0.31, lane: 0.55, speedMul: 0.85, radius: 1.1, minT: 0.08),
  _EnergyParticle(seed: 0.62, lane: -0.20, speedMul: 0.96, radius: 1.2, minT: 0.14),
  _EnergyParticle(seed: 0.84, lane: 0.82, speedMul: 0.68, radius: 0.9, minT: 0.16),
  _EnergyParticle(seed: 0.18, lane: -0.88, speedMul: 1.08, radius: 1.3, minT: 0.24),
  _EnergyParticle(seed: 0.47, lane: 0.25, speedMul: 1.18, radius: 1.4, minT: 0.28),
  _EnergyParticle(seed: 0.73, lane: -0.45, speedMul: 0.92, radius: 1.1, minT: 0.32),
  _EnergyParticle(seed: 0.91, lane: 0.65, speedMul: 1.25, radius: 1.5, minT: 0.36),
  _EnergyParticle(seed: 0.12, lane: 0.10, speedMul: 1.32, radius: 1.6, minT: 0.46),
  _EnergyParticle(seed: 0.39, lane: -0.75, speedMul: 1.12, radius: 1.3, minT: 0.50),
  _EnergyParticle(seed: 0.56, lane: 0.92, speedMul: 1.40, radius: 1.7, minT: 0.56),
  _EnergyParticle(seed: 0.79, lane: -0.12, speedMul: 1.48, radius: 1.8, minT: 0.62),
  _EnergyParticle(seed: 0.24, lane: 0.42, speedMul: 1.36, radius: 1.6, minT: 0.70),
  _EnergyParticle(seed: 0.68, lane: -0.58, speedMul: 1.52, radius: 1.9, minT: 0.76),
  _EnergyParticle(seed: 0.43, lane: 0.78, speedMul: 1.55, radius: 2.0, minT: 0.82),
  _EnergyParticle(seed: 0.88, lane: -0.35, speedMul: 1.44, radius: 2.1, minT: 0.88),
  // ---- 滑块近地环绕粒子（6） ----
  _EnergyParticle(seed: 0.10, lane: 0.50, speedMul: 0.90, radius: 1.2, minT: 0.65, orbital: true),
  _EnergyParticle(seed: 0.28, lane: -0.65, speedMul: 1.15, radius: 1.4, minT: 0.68, orbital: true),
  _EnergyParticle(seed: 0.49, lane: 0.85, speedMul: 1.28, radius: 1.5, minT: 0.74, orbital: true),
  _EnergyParticle(seed: 0.66, lane: -0.35, speedMul: 1.38, radius: 1.6, minT: 0.78, orbital: true),
  _EnergyParticle(seed: 0.81, lane: 0.30, speedMul: 1.48, radius: 1.7, minT: 0.84, orbital: true),
  _EnergyParticle(seed: 0.95, lane: -0.90, speedMul: 1.54, radius: 1.8, minT: 0.88, orbital: true),
];

/// 思考强度归一化位置 [t]（0..1）对应的粒子推进速度：越接近 max 呈非线性飙升，顶格跃迁。
double thinkingParticleSpeed(double t) {
  final clamped = t.clamp(0.0, 1.0);
  if (clamped <= 0) return 0.0;
  if (clamped >= 0.999) return 2.45;
  return 0.18 + 1.12 * math.pow(clamped, 2.1).toDouble();
}

/// 粒子尾迹拉伸长度（px）：高档位逐步拉出光丝，到 max 形成跃迁拖尾。
double thinkingParticleStreak(double t) {
  final clamped = t.clamp(0.0, 1.0);
  if (clamped <= 0.15) return 0.0;
  if (clamped >= 0.999) return 19.0;
  return 11.0 * math.pow((clamped - 0.15) / 0.85, 1.8).toDouble();
}

/// 当前强度下激活的粒子数（off 为 0，max 全亮 22）。
int thinkingActiveParticleCount(double t) {
  final clamped = t.clamp(0.0, 1.0);
  if (clamped <= 0) return 0;
  var count = 0;
  for (final p in _kParticles) {
    if (clamped >= p.minT) count++;
  }
  return count;
}

/// 思考等级滑条：从关到 max 一档一档拖过去。
///
/// 为什么不用一排 ChoiceChip：
///   · 七个档位（off/minimal/low/medium/high/xhigh/max）横排会挤成一团，
///     一眼看不出"现在到哪一档、还能往哪走"；
///   · 用户对"思考强度"的心理模型就是一根刻度尺，滑块比按钮串更贴合直觉。
///
/// 交互：
///   · 整条轨道**任意位置都能点/拖**（不用非得抓住小球），吸附到最近档位；
///   · 拖动或悬停高档位时轨道粒子向滑块汇聚加速；到最高档（max）触发跃迁冲击环、
///     能量粒子拉出光丝高速环绕冲刺 —— 一眼能看出"已经顶格全速运转"。
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

  late final Ticker _ticker = createTicker(_onTick);
  Duration _lastTick = Duration.zero;
  double _phase = 0.0;
  double _maxBurst = 0.0;
  bool _wasAtMax = false;
  bool _hovered = false;
  bool _reduceMotion = false;
  late final ValueNotifier<int> _frame = ValueNotifier<int>(0);

  @override
  void initState() {
    super.initState();
    _wasAtMax = _isEffectiveMax;
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    _reduceMotion = MediaQuery.maybeOf(context)?.disableAnimations ?? false;
    _syncTicker();
  }

  @override
  void didUpdateWidget(ThinkingSlider old) {
    super.didUpdateWidget(old);
    if (_gestureLevels != null && !_gestureValid) _resetGesture();
    _syncTicker();
  }

  @override
  void dispose() {
    _ticker.dispose();
    _frame.dispose();
    super.dispose();
  }

  bool get _isEffectiveMax => widget.levels.length >= 2 && _t >= 0.999;

  /// 供测试关掉动画（`max` 档是常驻加速，测试里 `pumpAndSettle()` 否则永远等不到静止）
  @visibleForTesting
  static bool animationsEnabled = true;

  bool get _shouldAnimate =>
      animationsEnabled &&
      !_reduceMotion &&
      widget.enabled &&
      widget.levels.length >= 2 &&
      (_isEffectiveMax || ((_dragT != null || _hovered) && _t > 0));

  void _syncTicker() {
    final atMax = _isEffectiveMax;
    if (atMax && !_wasAtMax && !_reduceMotion && widget.enabled) {
      _maxBurst = 1.0;
    }
    _wasAtMax = atMax;

    if (_shouldAnimate) {
      if (!_ticker.isActive) {
        _lastTick = Duration.zero;
        _ticker.start();
      }
    } else {
      if (_ticker.isActive) _ticker.stop();
      _lastTick = Duration.zero;
      _phase = 0.0;
      _maxBurst = 0.0;
    }
  }

  void _onTick(Duration elapsed) {
    final dt = _lastTick == Duration.zero
        ? 0.016
        : ((elapsed - _lastTick).inMicroseconds / 1e6).clamp(0.0, 0.05);
    _lastTick = elapsed;
    final speed = thinkingParticleSpeed(_t);
    _phase = (_phase + dt * speed) % 1000.0;
    if (_maxBurst > 0) {
      _maxBurst = math.max(0.0, _maxBurst - dt * 2.2);
    }
    _frame.value++;
  }

  void _setHover(bool on) {
    if (_hovered == on) return;
    _hovered = on;
    _syncTicker();
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
    _syncTicker();
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
    _syncTicker();
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
    _syncTicker();
    if (level != widget.value) widget.onChanged(level);
  }

  @override
  Widget build(BuildContext context) {
    if (widget.levels.isEmpty) return const SizedBox.shrink();
    if (widget.levels.length == 1) {
      return Text(
        L10n.s(context).tf('think.levelWith', {
          'level': _label(L10n.s(context), widget.levels.first),
        }),
        style: TextStyle(fontSize: PB.fsXs, color: PB.textTertiary),
      );
    }

    return LayoutBuilder(
      builder: (context, constraints) {
        final width = constraints.maxWidth;
        return MouseRegion(
          cursor: widget.enabled
              ? SystemMouseCursors.click
              : SystemMouseCursors.basic,
          onEnter: (_) => _setHover(true),
          onExit: (_) => _setHover(false),
          child: Listener(
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
                children: [_track(), const SizedBox(height: 6), _labels()],
              ),
            ),
          ),
        );
      },
    );
  }

  /// 档位标签；未知档位原样返回（服务端可能下发新档位）。
  String _label(AppStrings strings, String level) => switch (level) {
    'off' => strings.t('think.off'),
    'minimal' => strings.t('think.minimal'),
    'low' => strings.t('think.low'),
    'medium' => strings.t('think.medium'),
    'high' => strings.t('think.high'),
    'xhigh' => strings.t('think.xhigh'),
    'max' => strings.t('think.max'),
    _ => level,
  };

  Widget _track() {
    final t = _t;
    final enabled = widget.enabled;
    final isMax = _isEffectiveMax;
    final dragging = _dragT != null && _dragging;
    return SizedBox(
      height: 34,
      child: AnimatedBuilder(
        animation: _frame,
        builder: (context, _) {
          return CustomPaint(
            painter: _TrackPainter(
              t: t,
              levels: widget.levels.length,
              phase: _phase,
              burst: _maxBurst,
              isMax: isMax,
              dragging: dragging,
              dim: !enabled,
              accent: PB.colors(context).accent,
              bright: PB.colors(context).accentBright,
            ),
            child: const SizedBox.expand(),
          );
        },
      ),
    );
  }

  Widget _labels() {
    final strings = L10n.s(context);
    final n = widget.levels.length;
    final activeIdx = _dragT != null ? _indexForT(_t) : _index;
    return Stack(
      children: [
        Row(
          children: [
            for (var i = 0; i < n; i++)
              Expanded(
                child: Text(
                  _label(strings, widget.levels[i]),
                  textAlign: i == 0
                      ? TextAlign.left
                      : (i == n - 1 ? TextAlign.right : TextAlign.center),
                  style: TextStyle(
                    fontSize: PB.fsXxs,
                    color: i == activeIdx
                        ? PB.colors(context).accentBright
                        : PB.textQuaternary,
                    fontWeight:
                        i == activeIdx ? FontWeight.w600 : FontWeight.w400,
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
    required this.phase,
    required this.burst,
    required this.isMax,
    required this.dragging,
    required this.dim,
    required this.accent,
    required this.bright,
  });

  final double t;
  final int levels;
  final double phase;
  final double burst;
  final bool isMax;
  final bool dragging;
  final bool dim;
  final Color accent;
  final Color bright;

  @override
  void paint(Canvas canvas, Size size) {
    const h = 6.0;
    const knob = 9.0;
    final cy = size.height / 2;
    // 左右各留 3px：滑块半径 9，贴边时圆和冲击环会碰到容器边缘被裁掉
    final left = knob + 3;
    final right = size.width - knob - 3;
    final usable = math.max(1.0, right - left);
    final x = left + usable * t;

    // 1. 轨道底槽
    final rect = RRect.fromLTRBR(
      left - knob,
      cy - h / 2,
      right + knob,
      cy + h / 2,
      const Radius.circular(h),
    );
    final base = Paint()
      ..color = dim ? PB.bgActive : PB.bgActive.withValues(alpha: 0.92);
    canvas.drawRRect(rect, base);
    canvas.drawRRect(
      rect,
      Paint()
        ..color = PB.textQuaternary.withValues(alpha: dim ? 0.12 : 0.20)
        ..style = PaintingStyle.stroke
        ..strokeWidth = 0.6,
    );

    // 2. 已走部分：渐变能量条 + 扫掠光波（零 saveLayer）
    if (t > 0 || dim) {
      final fillRect = RRect.fromLTRBR(
        left - knob,
        cy - h / 2,
        math.max(left + knob, x),
        cy + h / 2,
        const Radius.circular(h),
      );
      final fillColors = dim
          ? [PB.textQuaternary, PB.textTertiary]
          : isMax
              ? [
                  accent.withValues(alpha: 0.72),
                  bright,
                  Color.lerp(bright, Colors.white, 0.45)!,
                ]
              : [accent.withValues(alpha: 0.55), bright];
      final fillPaint = Paint()
        ..shader = LinearGradient(
          colors: fillColors,
        ).createShader(
          Rect.fromLTWH(
            left - knob,
            0,
            math.max(1, x - left + knob * 2),
            size.height,
          ),
        );
      canvas.drawRRect(fillRect, fillPaint);

      if (!dim && t > 0 && (phase > 0 || isMax)) {
        final wavePos = (phase * 0.85) % 1.0;
        final span = math.max(1.0, x - (left - knob));
        final wx = (left - knob) + span * wavePos;
        final bandW = math.max(22.0, span * 0.28);
        canvas.save();
        canvas.clipRRect(fillRect);
        final wavePaint = Paint()
          ..shader = LinearGradient(
            colors: [
              Colors.white.withValues(alpha: 0),
              Colors.white.withValues(alpha: isMax ? 0.42 : 0.24),
              Colors.white.withValues(alpha: 0),
            ],
          ).createShader(Rect.fromLTWH(wx - bandW / 2, cy - h, bandW, h * 2));
        canvas.drawRect(
          Rect.fromLTWH(wx - bandW / 2, cy - h / 2, bandW, h),
          wavePaint,
        );
        canvas.restore();
      }
    }

    // 3. 刻度点：每一档一个，经过的点微亮
    for (var i = 0; i < levels; i++) {
      final tt = levels <= 1 ? 0.0 : i / (levels - 1);
      final passed = !dim && tt <= t + 0.001;
      canvas.drawCircle(
        Offset(left + usable * tt, cy),
        passed ? 1.25 : 1.05,
        Paint()
          ..color = passed
              ? Colors.white.withValues(alpha: 0.72)
              : PB.bgPane.withValues(alpha: 0.85),
      );
    }

    // 4. 动态加速能量粒子（仅非禁用且强度 > 0 时）
    if (!dim && t > 0) {
      final streakBase = thinkingParticleStreak(t);
      final particleColor =
          Color.lerp(bright, Colors.white, (0.35 + 0.55 * t).clamp(0.0, 1.0))!;
      final trackSpan = math.max(1.0, x - left);
      // 复用 Paint：粒子最多几十个，每帧 new 一次就是几十个临时对象
      final streakPaint = Paint()..strokeCap = StrokeCap.round;
      final dotPaint = Paint();

      for (final p in _kParticles) {
        if (t < p.minT) continue;
        if (!p.orbital) {
          final u = (p.seed + phase * p.speedMul) % 1.0;
          final px = left + trackSpan * u;
          final spread = (2.0 + 8.5 * t) * (1.0 - 0.58 * u);
          final py = cy + p.lane * spread;
          final fadeIn = (u / 0.14).clamp(0.0, 1.0);
          final alpha =
              fadeIn * (0.28 + 0.68 * t) * (isMax ? 1.0 : 0.85);
          final r = p.radius * (0.7 + 0.35 * t);
          final streak = streakBase * p.speedMul * (0.45 + 0.55 * u);
          if (streak > 1.0 && trackSpan > 2.0) {
            final tailX = math.max(left - knob * 0.5, px - streak);
            canvas.drawLine(
              Offset(tailX, py),
              Offset(px, py),
              streakPaint
                ..color = particleColor.withValues(alpha: alpha * 0.72)
                ..strokeWidth = p.radius * (0.75 + 0.3 * t),
            );
          }
          canvas.drawCircle(
            Offset(px, py),
            r,
            dotPaint..color = particleColor.withValues(alpha: alpha),
          );
        } else {
          final dir = p.lane >= 0 ? 1.0 : -1.0;
          final a =
              p.seed * math.pi * 2 + phase * dir * p.speedMul * (isMax ? 5.2 : 2.6);
          final rx = knob + 2.6 + 2.4 * (p.seed % 0.6); // 收敛到 13 内，环绕粒子不再贴边
          final ry = knob * 0.55 + 3.0 * p.lane.abs();
          final rot = p.lane * 0.45;
          final cosR = math.cos(rot);
          final sinR = math.sin(rot);

          Offset orbitAt(double angle) {
            final lx = rx * math.cos(angle);
            final ly = ry * math.sin(angle);
            return Offset(x + lx * cosR - ly * sinR, cy + lx * sinR + ly * cosR);
          }

          final head = orbitAt(a);
          final alpha = (0.35 + 0.65 * t) * (isMax ? 1.0 : 0.78);
          if (isMax) {
            final tail = orbitAt(a - 0.35 * dir);
            canvas.drawLine(
              tail,
              head,
              streakPaint
                ..color = particleColor.withValues(alpha: alpha * 0.68)
                ..strokeWidth = p.radius * 0.9,
            );
          }
          canvas.drawCircle(
            head,
            p.radius * (0.75 + 0.25 * t),
            dotPaint..color = particleColor.withValues(alpha: alpha),
          );
        }
      }
    }

    // 5. 高档 / max 顶格能量环 + 锁档扩散冲击环（纯矢量圆，零 MaskFilter.blur）
    if (!dim && t >= 0.75) {
      final breath = 0.5 + 0.5 * math.sin(phase * 3.6);
      final intensity = isMax ? (0.65 + 0.35 * breath) : 0.35;
      canvas.drawCircle(
        Offset(x, cy),
        knob + 4.0 + (isMax ? 2.5 * breath : 0.0), // 最大 15.5，仍在 17 半高内
        Paint()..color = bright.withValues(alpha: 0.16 * intensity),
      );
      canvas.drawCircle(
        Offset(x, cy),
        knob + 2.2 + (isMax ? 1.4 * breath : 0.0),
        Paint()..color = bright.withValues(alpha: 0.26 * intensity),
      );
    }
    if (!dim && burst > 0) {
      canvas.drawCircle(
        Offset(x, cy),
        knob + 7.5 * (1.0 - burst), // 冲击环最大 16.5（原来 24，明显出框）
        Paint()
          ..color = Color.lerp(bright, Colors.white, 0.5)!
              .withValues(alpha: 0.55 * burst)
          ..style = PaintingStyle.stroke
          ..strokeWidth = 1.6 * burst,
      );
    }

    // 6. 滑块球体
    final knobRadius = knob + (dragging ? 1.0 : 0.0);
    canvas.drawCircle(Offset(x, cy), knobRadius, Paint()..color = PB.bgPane);
    canvas.drawCircle(
      Offset(x, cy),
      knobRadius - 1.6,
      Paint()
        ..color = dim ? PB.textTertiary : Colors.white
        ..style = PaintingStyle.fill,
    );
    final coreColor = dim
        ? PB.textQuaternary
        : (isMax ? Color.lerp(bright, Colors.white, 0.35)! : accent);
    canvas.drawCircle(
      Offset(x, cy),
      knobRadius - 4.6,
      Paint()..color = coreColor,
    );
  }

  @override
  bool shouldRepaint(_TrackPainter old) =>
      old.t != t ||
      old.levels != levels ||
      old.phase != phase ||
      old.burst != burst ||
      old.isMax != isMax ||
      old.dragging != dragging ||
      old.dim != dim ||
      old.accent != accent ||
      old.bright != bright;
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

  /// 档位标签：跟随当前语言，未知档位原样返回。
  static String labelOf(AppStrings strings, String level) => switch (level) {
    'off' => strings.t('think.off'),
    'minimal' => strings.t('think.minimal'),
    'low' => strings.t('think.low'),
    'medium' => strings.t('think.medium'),
    'high' => strings.t('think.high'),
    'xhigh' => strings.t('think.xhigh'),
    'max' => strings.t('think.max'),
    _ => level,
  };

  @override
  Widget build(BuildContext context) {
    if (levels.isEmpty) return const SizedBox.shrink();
    final strings = L10n.s(context);
    final current = labelOf(strings, value ?? levels.first);
    final isMax = value != null && levels.isNotEmpty && value == levels.last;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Row(
          children: [
            Text(
              strings.t('think.level'),
              style: TextStyle(fontSize: PB.fsXs, color: PB.textTertiary),
            ),
            const Spacer(),
            AnimatedSwitcher(
              duration: Motion.fast,
              child: Text(
                isMax
                    ? strings.tf('think.capped', {'level': current})
                    : current,
                key: ValueKey(current),
                style: TextStyle(
                  fontSize: PB.fsXs,
                  fontWeight: FontWeight.w600,
                  color: isMax
                      ? PB.colors(context).accentBright
                      : PB.textSecondary,
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
