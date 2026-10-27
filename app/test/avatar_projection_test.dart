import 'dart:math' as math;
import 'dart:typed_data';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pi_bot/widgets/avatar_character.dart';
import 'package:pi_bot/widgets/avatar_character_painter.dart';
import 'package:pi_bot/widgets/avatar_projection.dart';

const _pillow = AvatarCharacter(
  kind: AvatarCharacterKind.pillow,
  eyeSpacing: 0.102,
  eyeScale: 1,
  faceLift: 0,
  restTilt: 0,
);

class _Region {
  _Region(this.points);
  final List<Offset> points;
  int get area => points.length;
  double get height =>
      points.map((p) => p.dy).reduce(math.max) -
      points.map((p) => p.dy).reduce(math.min) +
      1;
  Offset get center => points.reduce((a, b) => a + b) / area.toDouble();
}

class _Raster {
  _Raster(this.bytes, this.dimension, this.side, this.margin);
  final ByteData bytes;
  final int dimension;
  final int side;
  final int margin;

  bool _eye(int x, int y) {
    final at = (y * dimension + x) * 4;
    return bytes.getUint8(at + 3) >= 160 &&
        bytes.getUint8(at) < 50 &&
        bytes.getUint8(at + 1) < 65 &&
        bytes.getUint8(at + 2) < 65;
  }

  List<_Region> get eyes {
    final visited = <int>{};
    final regions = <_Region>[];
    for (var y = 0; y < dimension; y++) {
      for (var x = 0; x < dimension; x++) {
        final key = y * dimension + x;
        if (visited.contains(key) || !_eye(x, y)) continue;
        final queue = <int>[key];
        final points = <Offset>[];
        visited.add(key);
        for (var index = 0; index < queue.length; index++) {
          final current = queue[index];
          final px = current % dimension;
          final py = current ~/ dimension;
          points.add(
            Offset((px - margin).toDouble(), (py - margin).toDouble()),
          );
          for (final delta in const [(1, 0), (-1, 0), (0, 1), (0, -1)]) {
            final nx = px + delta.$1;
            final ny = py + delta.$2;
            if (nx < 0 || ny < 0 || nx >= dimension || ny >= dimension)
              continue;
            final next = ny * dimension + nx;
            if (visited.contains(next) || !_eye(nx, ny)) continue;
            visited.add(next);
            queue.add(next);
          }
        }
        if (points.length > 4) regions.add(_Region(points));
      }
    }
    regions.sort((a, b) => a.center.dx.compareTo(b.center.dx));
    return regions;
  }

  Offset get bodyCenter {
    var xSum = 0.0;
    var ySum = 0.0;
    var area = 0;
    for (var y = 0; y < dimension; y++) {
      for (var x = 0; x < dimension; x++) {
        if (bytes.getUint8((y * dimension + x) * 4 + 3) < 160) continue;
        xSum += x - margin;
        ySum += y - margin;
        area++;
      }
    }
    return Offset(xSum / area, ySum / area);
  }

  int get escapedPixels {
    var count = 0;
    for (var y = 0; y < dimension; y++) {
      for (var x = 0; x < dimension; x++) {
        if (bytes.getUint8((y * dimension + x) * 4 + 3) < 16) continue;
        if (x < margin - 1 ||
            x >= margin + side + 1 ||
            y < margin - 1 ||
            y >= margin + side + 1)
          count++;
      }
    }
    return count;
  }
}

Future<_Raster> _render({
  required int side,
  required Offset gaze,
  AvatarCharacter character = _pillow,
  double poke = 0,
  bool ring = false,
}) async {
  const margin = 24;
  final dimension = side + margin * 2;
  final recorder = ui.PictureRecorder();
  final canvas = Canvas(recorder)
    ..translate(margin.toDouble(), margin.toDouble());
  AvatarCharacterPainter(
    character: character,
    color: const Color(0xFF26B9AA),
    phase: 0,
    blink: 0,
    poke: poke,
    gaze: gaze,
    ring: ring,
  ).paint(canvas, Size.square(side.toDouble()));
  final picture = recorder.endRecording();
  final image = await picture.toImage(dimension, dimension);
  final bytes = await image.toByteData(format: ui.ImageByteFormat.rawRgba);
  image.dispose();
  picture.dispose();
  return _Raster(bytes!, dimension, side, margin);
}

void main() {
  test('正面保留静态形体，各深度投影均有限且视线角度有界', () {
    final front = AvatarProjection.fromGaze(gaze: Offset.zero, size: 46);
    for (final depth in [
      AvatarProjection.frontDepth,
      0.0,
      AvatarProjection.backDepth,
    ]) {
      for (final point in const [
        Offset(0.18, 0.24),
        Offset(0.49, 0.5),
        Offset(0.81, 0.78),
      ]) {
        final projected = front.project(point, depth: depth);
        expect(projected.dx, closeTo(point.dx, 1e-9));
        expect(projected.dy, closeTo(point.dy, 1e-9));
      }
    }
    final extreme = AvatarProjection.fromGaze(
      gaze: const Offset(100000, -100000),
      size: 14,
    );
    expect(extreme.yaw.abs(), lessThanOrEqualTo(35 * math.pi / 180));
    expect(extreme.pitch.abs(), lessThanOrEqualTo(25 * math.pi / 180));
    for (final point in const [Offset.zero, Offset(1, 1)]) {
      final projected = extreme.project(
        point,
        depth: AvatarProjection.frontDepth,
      );
      expect(projected.dx.isFinite && projected.dy.isFinite, isTrue);
    }
  });

  test('左右转头让前后深度分离，反向转头交换可见侧面', () {
    const center = Offset(0.49, 0.5);
    final right = AvatarProjection.fromGaze(
      gaze: const Offset(7.36, 0),
      size: 46,
    );
    final left = AvatarProjection.fromGaze(
      gaze: const Offset(-7.36, 0),
      size: 46,
    );
    Offset depthDelta(AvatarProjection pose) =>
        pose.project(center, depth: AvatarProjection.frontDepth) -
        pose.project(center, depth: AvatarProjection.backDepth);
    expect(depthDelta(right).dx, greaterThan(0.04));
    expect(depthDelta(left).dx, lessThan(-0.04));
    expect(depthDelta(right).dy.abs(), lessThan(0.02));
    expect(depthDelta(left).dy.abs(), lessThan(0.02));
  });

  test('上下俯仰同样改变前后深度投影，不退化成竖直平移', () {
    const center = Offset(0.49, 0.5);
    final down = AvatarProjection.fromGaze(
      gaze: const Offset(0, 7.36),
      size: 46,
    );
    final up = AvatarProjection.fromGaze(
      gaze: const Offset(0, -7.36),
      size: 46,
    );
    Offset depthDelta(AvatarProjection pose) =>
        pose.project(center, depth: AvatarProjection.frontDepth) -
        pose.project(center, depth: AvatarProjection.backDepth);
    expect(depthDelta(down).dy, greaterThan(0.03));
    expect(depthDelta(up).dy, lessThan(-0.03));
    expect(depthDelta(down).dx.abs(), lessThan(0.02));
  });

  test('近远局部比例随左右转向交换，偏离中心时仍连续', () {
    const leftEye = Offset(0.39, 0.43);
    const rightEye = Offset(0.59, 0.43);
    final right = AvatarProjection.fromGaze(
      gaze: const Offset(7.36, 0),
      size: 46,
    );
    final left = AvatarProjection.fromGaze(
      gaze: const Offset(-7.36, 0),
      size: 46,
    );
    double ratio(AvatarProjection pose) =>
        pose.scaleAt(leftEye, depth: AvatarProjection.frontDepth) /
        pose.scaleAt(rightEye, depth: AvatarProjection.frontDepth);
    expect(ratio(right), greaterThan(1.01));
    expect(ratio(left), lessThan(0.99));
    final nearZero = AvatarProjection.fromGaze(
      gaze: const Offset(0.0001, 0.0001),
      size: 46,
    );
    expect(
      (nearZero.project(leftEye, depth: AvatarProjection.frontDepth) - leftEye)
          .distance,
      lessThan(0.001),
    );
  });

  testWidgets('真实Canvas前后平面位置与侧壁点投影一致', (tester) async {
    await tester.runAsync(() async {
      const side = 240;
      const margin = 24;
      const dimension = side + margin * 2;
      const points = [
        Offset(0.18, 0.24),
        Offset(0.49, 0.5),
        Offset(0.81, 0.78),
      ];
      for (final gaze in const [
        Offset(7.36, 0),
        Offset(-7.36, 0),
        Offset(0, 7.36),
        Offset(0, -7.36),
        Offset(7.36, -7.36),
      ]) {
        final pose = AvatarProjection.fromGaze(gaze: gaze, size: 46);
        for (final depth in [
          AvatarProjection.frontDepth,
          AvatarProjection.backDepth,
        ]) {
          final matrix = pose.planeTransform(depth: depth);
          final recorder = ui.PictureRecorder();
          final canvas = Canvas(recorder)
            ..translate(margin.toDouble(), margin.toDouble())
            ..scale(side.toDouble())
            ..transform(matrix);
          for (final point in points) {
            canvas.drawCircle(
              point,
              0.012,
              Paint()..color = const Color(0xFF10201F),
            );
          }
          final picture = recorder.endRecording();
          final image = await picture.toImage(dimension, dimension);
          final bytes = await image.toByteData(
            format: ui.ImageByteFormat.rawRgba,
          );
          image.dispose();
          picture.dispose();
          final actual = _Raster(bytes!, dimension, side, margin).eyes;
          final expected =
              points
                  .map(
                    (point) =>
                        pose.project(point, depth: depth) * side.toDouble(),
                  )
                  .toList()
                ..sort((a, b) => a.dx.compareTo(b.dx));
          expect(actual.length, expected.length);
          for (var i = 0; i < actual.length; i++) {
            expect(
              (actual[i].center - expected[i]).distance,
              lessThan(1.2),
              reason: '$gaze / depth $depth / point $i',
            );
          }
        }
      }
    });
  });

  testWidgets('实际绘制的横向转头压缩双眼间距，头像中心保持在槽内', (tester) async {
    await tester.runAsync(() async {
      const side = 240;
      final front = await _render(side: side, gaze: Offset.zero);
      final right = await _render(
        side: side,
        gaze: const Offset(side * 0.16, 0),
      );
      final left = await _render(
        side: side,
        gaze: const Offset(-side * 0.16, 0),
      );
      for (final image in [front, right, left]) expect(image.eyes.length, 2);
      double spacing(_Raster image) =>
          (image.eyes.last.center - image.eyes.first.center).distance;
      final initial = spacing(front);
      debugPrint(
        'TURN_SPACING front=$initial right=${spacing(right)} left=${spacing(left)}',
      );
      expect(
        spacing(right),
        lessThan(initial * 0.94),
        reason: '转头须产生横向透视压缩，刚性平移或平面旋转不会缩短双眼间距',
      );
      expect(spacing(left), lessThan(initial * 0.94));
      for (final image in [right, left]) {
        expect(
          (image.bodyCenter - front.bodyCenter).distance,
          lessThan(side * 0.12),
          reason: '转头不应靠大幅平移离开自己的头像槽',
        );
        expect(image.escapedPixels, 0);
      }
    });
  });

  testWidgets('实际绘制包含近远眼透视，左右转头会交换较大的那只眼', (tester) async {
    await tester.runAsync(() async {
      const side = 240;
      final right = await _render(
        side: side,
        gaze: const Offset(side * 0.16, 0),
      );
      final left = await _render(
        side: side,
        gaze: const Offset(-side * 0.16, 0),
      );
      expect(right.eyes.length, 2);
      expect(left.eyes.length, 2);
      final rightRatio = right.eyes.first.area / right.eyes.last.area;
      final leftRatio = left.eyes.first.area / left.eyes.last.area;
      debugPrint('TURN_EYE_AREA right=$rightRatio left=$leftRatio');
      expect(
        math.max(rightRatio, 1 / rightRatio),
        greaterThan(1.05),
        reason: '同尺寸、同平面平移的两只眼不构成透视转头',
      );
      expect(math.max(leftRatio, 1 / leftRatio), greaterThan(1.05));
      expect(
        (rightRatio - 1) * (leftRatio - 1),
        lessThan(0),
        reason: '转向反转时近远关系应交换',
      );
    });
  });

  testWidgets('实际俯仰会缩短眼睛高度，前脸不是整体竖直平移', (tester) async {
    await tester.runAsync(() async {
      const side = 240;
      final front = await _render(side: side, gaze: Offset.zero);
      final down = await _render(
        side: side,
        gaze: const Offset(0, side * 0.16),
      );
      final up = await _render(side: side, gaze: const Offset(0, -side * 0.16));
      for (final image in [front, down, up]) expect(image.eyes.length, 2);
      double height(_Raster image) =>
          image.eyes.map((eye) => eye.height).reduce((a, b) => a + b) / 2;
      debugPrint(
        'TURN_PITCH_HEIGHT front=${height(front)} down=${height(down)} up=${height(up)}',
      );
      expect(height(down), lessThan(height(front) * 0.95));
      expect(height(up), lessThan(height(front) * 0.95));
      for (final image in [down, up]) {
        expect(
          (image.bodyCenter - front.bodyCenter).distance,
          lessThan(side * 0.12),
        );
        expect(image.escapedPixels, 0);
      }
    });
  });

  testWidgets('全部轮廓在小尺寸与四个最大斜向转头及按压下保持有界', (tester) async {
    final examples = <AvatarCharacterKind, AvatarCharacter>{};
    for (var i = 0; i < 1000; i++) {
      final character = AvatarCharacter.fromSeed('turn-bound-$i');
      examples.putIfAbsent(character.kind, () => character);
      if (examples.length == AvatarCharacterKind.values.length) break;
    }
    expect(examples.length, AvatarCharacterKind.values.length);
    await tester.runAsync(() async {
      for (final side in [14, 16, 22, 46, 96]) {
        for (final character in examples.values) {
          for (final direction in const [
            Offset(-1, -1),
            Offset(1, -1),
            Offset(-1, 1),
            Offset(1, 1),
          ]) {
            final image = await _render(
              side: side,
              gaze: direction * (side * 0.16),
              character: character,
              poke: 1,
              ring: true,
            );
            final scenario = '${character.kind.name} / $side px / $direction';
            expect(
              image.bodyCenter.dx.isFinite && image.bodyCenter.dy.isFinite,
              isTrue,
              reason: scenario,
            );
            expect(image.escapedPixels, 0, reason: scenario);
          }
        }
      }
    });
  });
}
