import 'dart:math' as math;

import 'package:flutter/material.dart';

import '../theme.dart';

/// 会呼吸的彩色 blob 头像。
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

  /// 单测里关掉动画。
  ///
  /// 眨眼是 `Future.delayed` 排的定时器、轮廓是无限循环的 AnimationController ——
  /// 测试结束时还挂着定时器，`testWidgets` 会直接判失败（pending timers），
  /// 而且 pumpAndSettle 永远等不到"静止"。生产代码不动它（默认 true）。
  @visibleForTesting
  static bool animationsEnabled = true;

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
    if (widget.animate && BlobAvatar.animationsEnabled) {
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

  /// emoji 降级成右上角的小角标。
  ///
  /// 只在够大的头像上画：22~32px（消息行、会话列表）放角标就是一团糊，
  /// 那时候名字就在旁边，不需要它。
  Widget? _emojiBadge() {
    final e = widget.emoji;
    if (e == null || e.trim().isEmpty || widget.size < 40) return null;
    return Text(e, style: TextStyle(fontSize: widget.size * 0.27, height: 1.0));
  }

  @override
  Widget build(BuildContext context) {
    // 调用方自己给的 badge 优先（比如主控的星标）
    final cornerBadge = widget.badge ?? _emojiBadge();
    return SizedBox(
      width: widget.size,
      height: widget.size,
      child: Stack(
        clipBehavior: Clip.none,
        children: [
          _content(),
          if (cornerBadge != null)
            Positioned(
              right: -3,
              bottom: -3,
              child: Container(
                padding: const EdgeInsets.all(2),
                decoration: BoxDecoration(
                  color: Theme.of(context).scaffoldBackgroundColor,
                  shape: BoxShape.circle,
                ),
                child: cornerBadge,
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

/// 头像轮廓的四种形状。
///
/// **每只 bot 的形状不一样**（有的圆胖、有的圆角方、有的六边形、
/// 有的胶囊）。以前全项目只有一种"有机 blob"，一屏十几个头像看过去像同一块橡皮泥
/// 捏出来的 —— 只靠换颜色区分，越看越廉价。
enum _ShapeKind {
  /// 有机 blob（三阶谐波，会缓慢扭动 —— 只有它是"活的"）
  blob,

  /// 超椭圆（iOS 图标那种圆角方）
  squircle,

  /// 圆角六边形
  hexagon,

  /// 胶囊（横向长一点的圆角矩形）
  pill,
}

/// 由 id 决定的形状参数：形状种类 + 三阶谐波 + 眼睛位置 + 倾角
class _BlobShape {
  _BlobShape(
    this.kind,
    this.harmonics,
    this.eyeY,
    this.eyeGap,
    this.eyeTilt,
    this.tilt,
  );

  final _ShapeKind kind;
  final List<_Harmonic> harmonics;
  final double eyeY;
  final double eyeGap;
  final double eyeTilt;

  /// 非 blob 形状整体转一点角度，免得看着像对齐的网格
  final double tilt;

  factory _BlobShape.fromSeed(String seed) {
    final rng = math.Random(seed.hashCode & 0x7fffffff);
    double range(double a, double b) => a + rng.nextDouble() * (b - a);
    // blob 占多数（只有它会扭动，是这套头像的"主调"），另外三种负责变化
    final roll = rng.nextDouble();
    final kind = roll < 0.40
        ? _ShapeKind.blob
        : roll < 0.63
        ? _ShapeKind.squircle
        : roll < 0.84
        ? _ShapeKind.hexagon
        : _ShapeKind.pill;
    return _BlobShape(
      kind,
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
      range(-0.22, 0.22),
    );
  }
}

class _BlobPainter extends CustomPainter {
  _BlobPainter({
    required this.shape,
    required this.color,
    required this.phase,
    required this.blink,
    this.ring = false,
  });

  final _BlobShape shape;
  final Color color;
  final double phase;
  final double blink;
  final bool ring;

  /// 按形状种类采样轮廓点（都绕中心一圈，角度递增）。
  ///
  /// 只有 blob 用 phase（会扭动）；其余三种是静的 —— 静止的形状更像"印章"，
  /// 也不动，动了反而像果冻，廉价。
  List<Offset> _outline(Offset center, double baseRadius) {
    switch (shape.kind) {
      case _ShapeKind.blob:
        const steps = 32;
        return [
          for (var i = 0; i < steps; i++)
            () {
              final theta = i / steps * 2 * math.pi;
              var r = 1.0;
              for (final h in shape.harmonics) {
                r += h.amp * math.sin(h.freq * theta + h.phase + phase * h.speed);
              }
              return center +
                  Offset(
                    math.cos(theta) * baseRadius * r,
                    math.sin(theta) * baseRadius * r,
                  );
            }(),
        ];

      case _ShapeKind.squircle:
        return _superellipse(center, baseRadius, baseRadius, 4.2);

      case _ShapeKind.pill:
        // 宽一点、扁一点 + 比 squircle 圆得多 → 看着就是颗胶囊
        return _superellipse(
          center,
          baseRadius * 1.10,
          baseRadius * 0.88,
          2.9,
        );

      case _ShapeKind.hexagon:
        // 正六边形；顶点稍多留一点，平滑那一步会把角磨圆
        return _rotate(
          [
            for (var i = 0; i < 6; i++)
              () {
                final t = i / 6 * 2 * math.pi + math.pi / 6;
                return Offset(
                  math.cos(t) * baseRadius,
                  math.sin(t) * baseRadius,
                );
              }(),
          ],
          center,
        );
    }
  }

  /// 超椭圆 |x/a|^n + |y/b|^n = 1 —— n=2 是椭圆，n=4 出头就是 iOS 那种圆角方
  List<Offset> _superellipse(
    Offset center,
    double a,
    double b,
    double n,
  ) {
    const steps = 44;
    final pts = <Offset>[];
    for (var i = 0; i < steps; i++) {
      final t = i / steps * 2 * math.pi;
      final ct = math.cos(t);
      final st = math.sin(t);
      pts.add(
        Offset(
          ct.sign * math.pow(ct.abs(), 2 / n) * a,
          st.sign * math.pow(st.abs(), 2 / n) * b,
        ),
      );
    }
    return _rotate(pts, center);
  }

  /// 按 shape.tilt 转一点角度再平移到中心
  List<Offset> _rotate(List<Offset> pts, Offset center) {
    final c = math.cos(shape.tilt);
    final s = math.sin(shape.tilt);
    return [
      for (final p in pts)
        center + Offset(p.dx * c - p.dy * s, p.dx * s + p.dy * c),
    ];
  }

  /// 采样轮廓点，再用二次贝塞尔穿过中点 —— 比直接 lineTo 顺得多
  /// ★ steps 从 48 降到 32：动画时每帧都要重算整条路径，48 段在列表里是纯浪费，
  ///   32 段在 44px 的尺寸下肉眼看不出区别。
  Path _blobPath(Offset center, double baseRadius) {
    final points = _outline(center, baseRadius);
    final steps = points.length;

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

    // 1) 主体：左上到右下的渐变
    //
    // ★ 这里以前还叠了「径向渐变落影 + 径向高光 + 渐变描边」，加上主体一共
    //   4 个 shader —— 每个头像每帧 4 次 createShader + 4 层抗锯齿填充。
    //   一屏十几个头像（群头像还是 2~4 个叠一起）全在吃光栅时间，而实测帧采样里
    //   raster 一直是瓶颈。这类头像本来就该是**接近平涂**的饱和色块，
    //   没有落影也没有高光 —— 砍掉之后既更像它，也更省。
    canvas.drawPath(
      path,
      Paint()
        ..shader =
            LinearGradient(
              begin: Alignment.topLeft,
              end: Alignment.bottomRight,
              // ★ 以前是 white 0.30 → 黑 0.26，再叠一层 white 0.26 高光 +
              //   white 0.30 描边 —— 四层白下来，调色板里的饱和色全被洗成粉彩，
              //   一屏头像看着发灰。这里只留一点体积感。
              colors: [
                Color.lerp(color, Colors.white, 0.12)!,
                color,
                Color.lerp(color, Colors.black, 0.16)!,
              ],
              stops: const [0.0, 0.52, 1.0],
            ).createShader(
              Rect.fromCircle(center: center, radius: baseRadius * 1.2),
            ),
    );

    // 2) 边缘反光（很细的一圈，出立体感）—— 纯色描边，不再开渐变 shader
    canvas.drawPath(
      path,
      Paint()
        ..style = PaintingStyle.stroke
        ..strokeWidth = math.max(1, size.shortestSide * 0.022)
        ..color = Colors.white.withValues(alpha: 0.14),
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

    // ★ 这里以前是「有 emoji 就画 emoji，不画眼睛」。
    //   结果是每个 bot 都是「一块饱和色 + 一张全彩 emoji 贴纸」——
    //   emoji 自带的白/橙/紫和 blob 的颜色互相打架，像贴歪了的贴纸。
    //   纯色块 + 两只眼睛干净得多；emoji 降级成小角标。
    //
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

/// 群头像：2-4 个小 blob 叠在一起
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
