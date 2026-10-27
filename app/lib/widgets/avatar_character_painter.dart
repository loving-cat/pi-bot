import 'dart:math' as math;
import 'dart:ui' as ui;

import 'package:flutter/material.dart';

import 'avatar_character.dart';
import 'avatar_life.dart';
import 'avatar_projection.dart';
import 'avatar_solid.dart';

/// 柔软几何角色：同色侧面、宽过渡明暗与平行胶囊眼。
/// 归一化轮廓和渐变按身份、颜色缓存，无裁剪、模糊或离屏图层。
class AvatarCharacterPainter extends CustomPainter {
  const AvatarCharacterPainter({
    required this.character,
    required this.color,
    required this.phase,
    required this.blink,
    required this.poke,
    required this.gaze,
    this.ring = false,
    this.mood = AvatarMood.idle,
  });

  final AvatarCharacter character;
  final Color color;
  final double phase;
  final double blink;
  final double poke;
  final Offset gaze;
  final bool ring;
  final AvatarMood mood;

  static final Map<AvatarCharacterKind, _Geometry> _geometries = {};
  static final Map<int, _Palette> _palettes = {};

  static _Palette _palette(Color color) {
    final key = color.toARGB32();
    final found = _palettes[key];
    if (found != null) return found;
    if (_palettes.length >= 128) _palettes.remove(_palettes.keys.first);
    return _palettes[key] = _Palette(color);
  }

  @override
  void paint(Canvas canvas, Size size) {
    final side = size.shortestSide;
    if (side <= 0) return;
    final geometry = _geometries.putIfAbsent(
      character.kind,
      () => _Geometry.forKind(character.kind),
    );
    final palette = _palette(color);
    final projection = AvatarProjection.fromGaze(gaze: gaze, size: side);
    final squeeze = 1 + poke.clamp(0.0, 1.0) * 0.065;
    final front = projection.planeTransform(
      depth: AvatarProjection.frontDepth,
      roll: character.restTilt,
      squeeze: squeeze,
    );
    final back = projection.planeTransform(
      depth: AvatarProjection.backDepth,
      roll: character.restTilt,
      squeeze: squeeze,
      offset: const Offset(0.030, 0.034) * (1 - projection.amount),
    );
    final transition = (projection.amount / 0.16).clamp(0.0, 1.0);
    final surfaceBlend = transition * transition * (3 - 2 * transition);
    canvas.save();
    canvas.translate((size.width - side) / 2, (size.height - side) / 2);
    canvas.scale(side);
    canvas.translate(0, math.sin(phase) * 0.003);

    canvas.save();
    canvas.transform(back);
    if (surfaceBlend < 1) canvas.drawPath(geometry.body, palette.sidePaint);
    if (surfaceBlend > 0) {
      final backPaint = surfaceBlend == 1
          ? palette.backPaint
          : (Paint()
              ..shader = palette.backPaint.shader
              ..colorFilter = palette.backPaint.colorFilter
              ..color = Colors.white.withValues(alpha: surfaceBlend));
      canvas.drawPath(geometry.body, backPaint);
    }
    canvas.restore();
    if (!projection.isNeutral) {
      final frontPoints = [
        for (final point in geometry.contour) projectAvatarPoint(point, front),
      ];
      final backPoints = [
        for (final point in geometry.contour) projectAvatarPoint(point, back),
      ];
      final edgeColors = palette.wallColors(character.kind, geometry.contour);
      final wall = AvatarSolidWall(
        front: frontPoints,
        back: backPoints,
        frontColors: surfaceBlend == 1
            ? edgeColors.front
            : [
                for (final color in edgeColors.front)
                  Color.lerp(palette.sidePaint.color, color, surfaceBlend)!,
              ],
        backColors: surfaceBlend == 1
            ? edgeColors.back
            : [
                for (final color in edgeColors.back)
                  Color.lerp(palette.sidePaint.color, color, surfaceBlend)!,
              ],
        frontDistance: [
          for (final p in geometry.contour)
            front[3] * p.dx + front[7] * p.dy + front[15],
        ],
        backDistance: [
          for (final p in geometry.contour)
            back[3] * p.dx + back[7] * p.dy + back[15],
        ],
      );
      canvas.drawPath(wall.coverage, palette.backPaint);
      final vertices = ui.Vertices.raw(
        ui.VertexMode.triangles,
        wall.positions,
        colors: wall.colors,
        indices: wall.indices,
      );
      try {
        canvas.drawVertices(vertices, BlendMode.dst, Paint());
      } finally {
        vertices.dispose();
      }
    }

    canvas.save();
    canvas.transform(front);
    canvas.drawPath(geometry.body, palette.bodyPaint);
    if (ring) {
      canvas.drawPath(
        geometry.body,
        Paint()
          ..style = PaintingStyle.stroke
          ..strokeWidth = 0.013
          ..color = palette.ring,
      );
    }

    final faceCenter = geometry.faceCenter + Offset(0, character.faceLift);
    final spacing = character.eyeSpacing * geometry.faceScale;
    final eyeWidth = math.max(
      0.066 * character.eyeScale,
      0.85 / side / projection.fit / math.cos(projection.yaw),
    );
    final eyeHeight =
        0.150 *
        character.eyeScale *
        geometry.faceScale *
        (mood == AvatarMood.busy ? 0.94 : 1.0);
    final opening = 1 - blink.clamp(0.0, 1.0) * 0.91;
    final visibleHeight = math.max(
      0.65 / side / projection.fit / math.cos(projection.pitch),
      eyeHeight * opening,
    );
    for (final sign in [-1.0, 1.0]) {
      final center = faceCenter + Offset(sign * spacing, 0);
      canvas.drawRRect(
        RRect.fromRectAndRadius(
          Rect.fromCenter(
            center: center,
            width: eyeWidth,
            height: visibleHeight,
          ),
          Radius.circular(eyeWidth * 0.5),
        ),
        palette.eyePaint,
      );
    }
    canvas.restore();
    canvas.restore();
  }

  @override
  bool shouldRepaint(AvatarCharacterPainter oldDelegate) =>
      oldDelegate.character != character ||
      oldDelegate.color != color ||
      oldDelegate.phase != phase ||
      oldDelegate.blink != blink ||
      oldDelegate.poke != poke ||
      oldDelegate.gaze != gaze ||
      oldDelegate.ring != ring ||
      oldDelegate.mood != mood;
}

class _Palette {
  _Palette(Color requested) {
    final hsl = HSLColor.fromColor(requested);
    final base = hsl
        .withSaturation(
          hsl.saturation > 0.15
              ? hsl.saturation.clamp(0.40, 0.90)
              : hsl.saturation,
        )
        .withLightness(hsl.lightness.clamp(0.40, 0.68))
        .toColor();
    sidePaint = Paint()
      ..color = Color.lerp(base, const Color(0xFF182129), 0.25)!;
    ring = Color.lerp(base, Colors.white, 0.58)!.withValues(alpha: 0.80);
    eyePaint = Paint()..color = const Color(0xFF10201F);
    surfaceColors = [
      Color.lerp(base, Colors.white, 0.14)!,
      Color.lerp(base, Colors.white, 0.025)!,
      Color.lerp(base, const Color(0xFF17212B), 0.045)!,
      Color.lerp(base, const Color(0xFF17212B), 0.20)!,
    ];
    final shader = RadialGradient(
      center: const Alignment(-0.62, -0.80),
      radius: 1.05,
      colors: surfaceColors,
      stops: stops,
    ).createShader(const Rect.fromLTWH(0.10, 0.12, 0.80, 0.76));
    bodyPaint = Paint()..shader = shader;
    backPaint = Paint()
      ..shader = shader
      ..colorFilter = const ColorFilter.matrix([
        rearShade,
        0,
        0,
        0,
        0,
        0,
        rearShade,
        0,
        0,
        0,
        0,
        0,
        rearShade,
        0,
        0,
        0,
        0,
        0,
        1,
        0,
      ]);
  }

  static const rearShade = 0.91;
  static const stops = [0.0, 0.35, 0.70, 1.0];
  late final Color ring;
  late final Paint bodyPaint;
  late final Paint backPaint;
  late final Paint sidePaint;
  late final Paint eyePaint;
  late final List<Color> surfaceColors;
  final Map<AvatarCharacterKind, ({List<Color> front, List<Color> back})>
  _wallColors = {};

  ({List<Color> front, List<Color> back}) wallColors(
    AvatarCharacterKind kind,
    List<Offset> contour,
  ) => _wallColors.putIfAbsent(kind, () {
    final front = contour.map(_surfaceColor).toList();
    return (front: front, back: front.map(_dim).toList());
  });

  Color _surfaceColor(Offset point) {
    final t = ((point - const Offset(0.252, 0.196)).distance / 0.798).clamp(
      0.0,
      1.0,
    );
    for (var i = 1; i < stops.length; i++) {
      if (t <= stops[i]) {
        return Color.lerp(
          surfaceColors[i - 1],
          surfaceColors[i],
          (t - stops[i - 1]) / (stops[i] - stops[i - 1]),
        )!;
      }
    }
    return surfaceColors.last;
  }

  Color _dim(Color color) {
    final argb = color.toARGB32();
    return Color.fromARGB(
      argb >> 24,
      (((argb >> 16) & 255) * rearShade).round(),
      (((argb >> 8) & 255) * rearShade).round(),
      ((argb & 255) * rearShade).round(),
    );
  }
}

class _Geometry {
  _Geometry({
    required this.body,
    this.faceCenter = const Offset(0.55, 0.43),
    this.faceScale = 1,
  }) {
    final metric = body.computeMetrics().single;
    contour = List.generate(
      32,
      (index) =>
          metric.getTangentForOffset(metric.length * index / 32)!.position,
    );
  }

  final Path body;
  late final List<Offset> contour;
  final Offset faceCenter;
  final double faceScale;

  factory _Geometry.forKind(AvatarCharacterKind kind) {
    Path round(Rect rect, double radius) =>
        Path()
          ..addRRect(RRect.fromRectAndRadius(rect, Radius.circular(radius)));
    switch (kind) {
      case AvatarCharacterKind.bean:
        return _Geometry(
          body: Path()
            ..moveTo(0.34, 0.23)
            ..cubicTo(0.47, 0.20, 0.73, 0.14, 0.83, 0.32)
            ..cubicTo(0.94, 0.51, 0.80, 0.72, 0.60, 0.75)
            ..cubicTo(0.43, 0.78, 0.21, 0.85, 0.12, 0.64)
            ..cubicTo(0.035, 0.44, 0.14, 0.28, 0.34, 0.23)
            ..close(),
          faceCenter: const Offset(0.555, 0.435),
        );
      case AvatarCharacterKind.pillow:
        return _Geometry(
          body: round(const Rect.fromLTWH(0.13, 0.16, 0.73, 0.70), 0.24),
          faceCenter: const Offset(0.55, 0.43),
        );
      case AvatarCharacterKind.pebble:
        return _Geometry(
          body: Path()
            ..moveTo(0.46, 0.14)
            ..cubicTo(0.67, 0.10, 0.86, 0.27, 0.87, 0.48)
            ..cubicTo(0.89, 0.69, 0.71, 0.86, 0.49, 0.85)
            ..cubicTo(0.26, 0.87, 0.10, 0.70, 0.11, 0.49)
            ..cubicTo(0.10, 0.30, 0.25, 0.17, 0.46, 0.14)
            ..close(),
        );
      case AvatarCharacterKind.capsule:
        return _Geometry(
          body: round(const Rect.fromLTWH(0.085, 0.245, 0.81, 0.545), 0.27),
          faceCenter: const Offset(0.56, 0.45),
        );
      case AvatarCharacterKind.cloud:
        return _Geometry(
          body: _softCloud(),
          faceCenter: const Offset(0.55, 0.445),
        );
      case AvatarCharacterKind.wedge:
        return _Geometry(
          body: Path()
            ..moveTo(0.27, 0.19)
            ..cubicTo(0.33, 0.15, 0.39, 0.17, 0.44, 0.20)
            ..lineTo(0.74, 0.35)
            ..cubicTo(0.83, 0.40, 0.89, 0.47, 0.85, 0.56)
            ..lineTo(0.76, 0.69)
            ..cubicTo(0.73, 0.74, 0.66, 0.77, 0.60, 0.78)
            ..lineTo(0.30, 0.84)
            ..cubicTo(0.20, 0.86, 0.14, 0.81, 0.16, 0.69)
            ..lineTo(0.21, 0.32)
            ..quadraticBezierTo(0.22, 0.22, 0.27, 0.19)
            ..close(),
          faceCenter: const Offset(0.49, 0.475),
          faceScale: 0.91,
        );
      case AvatarCharacterKind.hexagon:
        return _Geometry(
          body: Path()
            ..moveTo(0.34, 0.17)
            ..lineTo(0.61, 0.17)
            ..quadraticBezierTo(0.68, 0.17, 0.72, 0.24)
            ..lineTo(0.86, 0.45)
            ..quadraticBezierTo(0.89, 0.51, 0.85, 0.57)
            ..lineTo(0.70, 0.79)
            ..quadraticBezierTo(0.66, 0.85, 0.59, 0.85)
            ..lineTo(0.33, 0.85)
            ..quadraticBezierTo(0.27, 0.85, 0.23, 0.79)
            ..lineTo(0.10, 0.58)
            ..quadraticBezierTo(0.06, 0.51, 0.10, 0.45)
            ..lineTo(0.24, 0.23)
            ..quadraticBezierTo(0.28, 0.17, 0.34, 0.17)
            ..close(),
          faceCenter: const Offset(0.54, 0.44),
        );
      case AvatarCharacterKind.egg:
        return _Geometry(
          body: Path()
            ..moveTo(0.49, 0.13)
            ..cubicTo(0.65, 0.12, 0.77, 0.32, 0.83, 0.51)
            ..cubicTo(0.90, 0.71, 0.75, 0.86, 0.49, 0.86)
            ..cubicTo(0.26, 0.86, 0.09, 0.72, 0.15, 0.53)
            ..cubicTo(0.21, 0.33, 0.32, 0.14, 0.49, 0.13)
            ..close(),
          faceCenter: const Offset(0.535, 0.455),
        );
    }
  }

  /// 三瓣固定轮廓，以中点曲线连续连接；仅在首次创建此种轮廓时计算。
  static Path _softCloud() {
    const count = 30;
    final points = List<Offset>.generate(count, (index) {
      final angle = index / count * 2 * math.pi;
      final radius = 0.335 * (1 + 0.20 * math.cos(3 * angle + math.pi / 2));
      return Offset(
        0.49 + math.cos(angle) * radius * 1.06,
        0.49 + math.sin(angle) * radius * 0.95,
      );
    });
    final first = (points.last + points.first) / 2;
    final path = Path()..moveTo(first.dx, first.dy);
    for (var index = 0; index < count; index++) {
      final current = points[index];
      final next = points[(index + 1) % count];
      final midpoint = (current + next) / 2;
      path.quadraticBezierTo(current.dx, current.dy, midpoint.dx, midpoint.dy);
    }
    return path..close();
  }
}
