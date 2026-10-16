import 'dart:math' as math;

import 'package:flutter/material.dart';

import '../theme.dart';

/// 会呼吸的彩色 blob 头像 —— 照 同类客户端 那套做的。
///
/// 每个 bot 由 id 决定：颜色、blob 轮廓（三阶谐波）、眼睛位置。
/// 动画分两层：轮廓缓慢扭动（像水母），眼睛偶尔眨一下。
class BlobAvatar extends StatefulWidget {
  const BlobAvatar({
    super.key,
    required this.seed,
    required this.color,
    this.emoji,
    this.size = 44,
    this.animate = true,
    this.badge,
    this.ring = false,
  });

  final String seed;
  final Color color;
  final String? emoji;
  final double size;
  final bool animate;
  final Widget? badge;

  /// 主控那种"高一级"的身份环
  final bool ring;

  @override
  State<BlobAvatar> createState() => _BlobAvatarState();
}

class _BlobAvatarState extends State<BlobAvatar> with TickerProviderStateMixin {
  late final _BlobShape _shape = _BlobShape.fromSeed(widget.seed);
  AnimationController? _wobble;
  AnimationController? _blink;
  math.Random? _rng;

  @override
  void initState() {
    super.initState();
    if (widget.animate) {
      _wobble = AnimationController(
        vsync: this,
        duration: const Duration(seconds: 11),
      )..repeat();
      _rng = math.Random(widget.seed.hashCode);
      _blink = AnimationController(
        vsync: this,
        duration: const Duration(milliseconds: 190),
      );
      _scheduleBlink();
    }
  }

  void _scheduleBlink() {
    if (!mounted || _blink == null) return;
    final delay = Duration(milliseconds: 2600 + (_rng?.nextInt(4200) ?? 2000));
    Future<void>.delayed(delay, () async {
      if (!mounted || _blink == null) return;
      await _blink!.forward(from: 0);
      await _blink!.reverse();
      _scheduleBlink();
    });
  }

  @override
  void dispose() {
    _wobble?.dispose();
    _blink?.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return SizedBox(
      width: widget.size,
      height: widget.size,
      child: Stack(
        clipBehavior: Clip.none,
        children: [
          _content(),
          if (widget.badge != null)
            Positioned(
              right: -3,
              bottom: -3,
              child: Container(
                padding: const EdgeInsets.all(2),
                decoration: BoxDecoration(
                  color: Theme.of(context).scaffoldBackgroundColor,
                  shape: BoxShape.circle,
                ),
                child: widget.badge,
              ),
            ),
        ],
      ),
    );
  }

  Widget _content() {
    Widget paint(double phase, double blink) => CustomPaint(
      size: Size.square(widget.size),
      painter: _BlobPainter(
        shape: _shape,
        color: widget.color,
        phase: phase,
        blink: blink,
        emoji: widget.emoji,
        ring: widget.ring,
      ),
    );

    if (!widget.animate || _wobble == null) return paint(0, 0);

    return RepaintBoundary(
      child: AnimatedBuilder(
        animation: Listenable.merge([_wobble!, _blink!]),
        builder: (context, _) =>
            paint(_wobble!.value * 2 * math.pi, _blink!.value),
      ),
    );
  }
}

class _Harmonic {
  const _Harmonic(this.freq, this.amp, this.phase, this.speed);
  final int freq;
  final double amp;
  final double phase;
  final double speed;
}

/// 由 id 决定的形状参数：三阶谐波 + 眼睛位置
class _BlobShape {
  _BlobShape(this.harmonics, this.eyeY, this.eyeGap, this.eyeTilt);

  final List<_Harmonic> harmonics;
  final double eyeY;
  final double eyeGap;
  final double eyeTilt;

  factory _BlobShape.fromSeed(String seed) {
    final rng = math.Random(seed.hashCode & 0x7fffffff);
    double range(double a, double b) => a + rng.nextDouble() * (b - a);
    return _BlobShape(
      [
        _Harmonic(
          2,
          range(0.05, 0.12),
          rng.nextDouble() * 6.28,
          range(0.5, 1.0),
        ),
        _Harmonic(
          3,
          range(0.03, 0.085),
          rng.nextDouble() * 6.28,
          range(-0.9, -0.4),
        ),
        _Harmonic(
          4,
          range(0.015, 0.045),
          rng.nextDouble() * 6.28,
          range(0.7, 1.4),
        ),
      ],
      range(0.40, 0.48),
      range(0.19, 0.235),
      range(-0.16, 0.16),
    );
  }
}

class _BlobPainter extends CustomPainter {
  _BlobPainter({
    required this.shape,
    required this.color,
    required this.phase,
    required this.blink,
    this.emoji,
    this.ring = false,
  });

  final _BlobShape shape;
  final Color color;
  final double phase;
  final double blink;
  final String? emoji;
  final bool ring;

  /// 采样轮廓点，再用二次贝塞尔穿过中点 —— 比直接 lineTo 顺得多
  /// ★ steps 从 48 降到 32：动画时每帧都要重算整条路径，48 段在列表里是纯浪费，
  ///   32 段在 44px 的尺寸下肉眼看不出区别。
  Path _blobPath(Offset center, double baseRadius) {
    const steps = 32;
    final points = <Offset>[];
    for (var i = 0; i < steps; i++) {
      final theta = i / steps * 2 * math.pi;
      var r = 1.0;
      for (final h in shape.harmonics) {
        r += h.amp * math.sin(h.freq * theta + h.phase + phase * h.speed);
      }
      points.add(
        center +
            Offset(
              math.cos(theta) * baseRadius * r,
              math.sin(theta) * baseRadius * r,
            ),
      );
    }

    final path = Path();
    Offset mid(Offset a, Offset b) =>
        Offset((a.dx + b.dx) / 2, (a.dy + b.dy) / 2);
    path.moveTo(
      mid(points[steps - 1], points[0]).dx,
      mid(points[steps - 1], points[0]).dy,
    );
    for (var i = 0; i < steps; i++) {
      final p = points[i];
      final next = points[(i + 1) % steps];
      final m = mid(p, next);
      path.quadraticBezierTo(p.dx, p.dy, m.dx, m.dy);
    }
    path.close();
    return path;
  }

  @override
  void paint(Canvas canvas, Size size) {
    final center = Offset(size.width / 2, size.height / 2);
    final baseRadius = size.shortestSide / 2 * 0.9;
    final path = _blobPath(center, baseRadius);

    // 1) 落影：让它"浮"起来
    // ★ 这里以前用 MaskFilter.blur —— 那是每帧重算的卷积模糊，
    //   一屏 15 个头像 = 每帧 15 次模糊，直接掉到 20 帧。
    //   换成径向渐变的椭圆（纯光栅化，快一个数量级），视觉上几乎看不出差别。
    final shadowRect = Rect.fromCenter(
      center: center.translate(0, size.shortestSide * 0.085),
      width: baseRadius * 1.78,
      height: baseRadius * 1.12,
    );
    canvas.drawOval(
      shadowRect,
      Paint()
        ..shader = RadialGradient(
          colors: [
            Colors.black.withValues(alpha: 0.40),
            Colors.black.withValues(alpha: 0.0),
          ],
          stops: const [0.42, 1.0],
        ).createShader(shadowRect),
    );

    // 2) 主体：左上到右下的渐变
    canvas.drawPath(
      path,
      Paint()
        ..shader =
            LinearGradient(
              begin: Alignment.topLeft,
              end: Alignment.bottomRight,
              colors: [
                Color.lerp(color, Colors.white, 0.30)!,
                color,
                Color.lerp(color, Colors.black, 0.26)!,
              ],
              stops: const [0.0, 0.52, 1.0],
            ).createShader(
              Rect.fromCircle(center: center, radius: baseRadius * 1.2),
            ),
    );

    // 3) 左上柔光
    canvas.drawPath(
      path,
      Paint()
        ..shader = RadialGradient(
          center: const Alignment(-0.5, -0.55),
          radius: 1.0,
          colors: [Colors.white.withValues(alpha: 0.26), Colors.transparent],
        ).createShader(Rect.fromCircle(center: center, radius: baseRadius)),
    );

    // 4) 边缘反光（很细的一圈，出立体感）
    canvas.drawPath(
      path,
      Paint()
        ..style = PaintingStyle.stroke
        ..strokeWidth = math.max(1, size.shortestSide * 0.022)
        ..shader = LinearGradient(
          begin: Alignment.topCenter,
          end: Alignment.bottomCenter,
          colors: [
            Colors.white.withValues(alpha: 0.30),
            Colors.white.withValues(alpha: 0.02),
          ],
        ).createShader(Rect.fromCircle(center: center, radius: baseRadius)),
    );

    if (ring) {
      canvas.drawPath(
        path,
        Paint()
          ..style = PaintingStyle.stroke
          ..strokeWidth = math.max(1.2, size.shortestSide * 0.035)
          ..color = Colors.white.withValues(alpha: 0.85),
      );
    }

    if (emoji != null && emoji!.isNotEmpty) {
      final tp = TextPainter(
        text: TextSpan(
          text: emoji,
          style: TextStyle(fontSize: size.shortestSide * 0.44, height: 1.0),
        ),
        textDirection: TextDirection.ltr,
      )..layout();
      tp.paint(canvas, center - Offset(tp.width / 2, tp.height / 2));
      return;
    }

    // 眼睛：两个圆角竖条，眨眼时压扁
    final eyeW = size.shortestSide * 0.112;
    final eyeH = size.shortestSide * 0.195 * (1 - blink * 0.84);
    final eyePaint = Paint()
      ..color = Color.lerp(color, Colors.black, 0.84)!.withValues(alpha: 0.95);
    for (final side in [-1.0, 1.0]) {
      final cx = center.dx + side * size.shortestSide * shape.eyeGap;
      final cy = center.dy + size.shortestSide * (shape.eyeY - 0.5);
      canvas.save();
      canvas.translate(cx, cy);
      canvas.rotate(side * shape.eyeTilt);
      canvas.drawRRect(
        RRect.fromRectAndRadius(
          Rect.fromCenter(center: Offset.zero, width: eyeW, height: eyeH),
          Radius.circular(eyeW / 2),
        ),
        eyePaint,
      );
      canvas.restore();
    }
  }

  @override
  bool shouldRepaint(_BlobPainter old) =>
      old.phase != phase ||
      old.blink != blink ||
      old.color != color ||
      old.shape != shape;
}

/// 群头像：2-4 个小 blob 叠在一起（照 同类客户端 那个群头像）
class GroupBlobAvatar extends StatelessWidget {
  const GroupBlobAvatar({
    super.key,
    required this.seeds,
    required this.size,
    this.animate = true,
  });

  final List<String> seeds;
  final double size;
  final bool animate;

  @override
  Widget build(BuildContext context) {
    final shown = seeds.take(4).toList();
    if (shown.isEmpty) shown.add('pi');
    final inner = size * (shown.length == 1 ? 1.0 : 0.64);
    const layout = <Offset>[
      Offset(-0.17, -0.17),
      Offset(0.18, -0.13),
      Offset(-0.13, 0.19),
      Offset(0.20, 0.20),
    ];
    return SizedBox(
      width: size,
      height: size,
      child: Stack(
        clipBehavior: Clip.none,
        children: [
          for (var i = 0; i < shown.length; i++)
            Positioned(
              left: size / 2 + layout[i].dx * size - inner / 2,
              top: size / 2 + layout[i].dy * size - inner / 2,
              child: BlobAvatar(
                seed: shown[i],
                color: PB.colorFor(shown[i]),
                size: inner,
                animate: animate,
              ),
            ),
        ],
      ),
    );
  }
}
