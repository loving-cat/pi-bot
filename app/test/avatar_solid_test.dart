// 验证头像覆盖连续性；实体体积观感仍需通过实际姿态图独立检查。
import 'dart:io';
import 'dart:convert';
import 'dart:typed_data';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pi_bot/widgets/avatar_character.dart';
import 'package:pi_bot/widgets/avatar_character_painter.dart';

class _Coverage {
  const _Coverage({
    required this.holes,
    required this.parts,
    required this.innerTranslucent,
    required this.painted,
  });
  final int holes;
  final int parts;
  final int innerTranslucent;
  final int painted;
  Map<String, int> get json => {
    'holes': holes,
    'parts': parts,
    'innerTranslucent': innerTranslucent,
    'painted': painted,
  };
}

_Coverage _coverage(ByteData pixels, int width, int height) {
  final count = width * height;
  final visible = Uint8List(count);
  final exterior = Uint8List(count);
  final seen = Uint8List(count);
  int alpha(int key) => pixels.getUint8(key * 4 + 3);
  var painted = 0;
  for (var key = 0; key < count; key++) {
    if (alpha(key) >= 16) {
      visible[key] = 1;
      painted++;
    }
  }
  Iterable<int> neighbors(int key, {bool diagonals = false}) sync* {
    final x = key % width;
    final y = key ~/ width;
    if (x > 0) yield key - 1;
    if (x + 1 < width) yield key + 1;
    if (y > 0) yield key - width;
    if (y + 1 < height) yield key + width;
    if (diagonals) {
      if (x > 0 && y > 0) yield key - width - 1;
      if (x + 1 < width && y > 0) yield key - width + 1;
      if (x > 0 && y + 1 < height) yield key + width - 1;
      if (x + 1 < width && y + 1 < height) yield key + width + 1;
    }
  }

  final queue = <int>[];
  for (var key = 0; key < count; key++) {
    final x = key % width;
    final y = key ~/ width;
    if ((x == 0 || y == 0 || x == width - 1 || y == height - 1) &&
        visible[key] == 0) {
      exterior[key] = 1;
      queue.add(key);
    }
  }
  for (var i = 0; i < queue.length; i++) {
    for (final next in neighbors(queue[i], diagonals: true)) {
      if (visible[next] == 0 && exterior[next] == 0) {
        exterior[next] = 1;
        queue.add(next);
      }
    }
  }
  var holes = 0;
  var parts = 0;
  var translucent = 0;
  for (var key = 0; key < count; key++) {
    if (visible[key] == 0) {
      if (exterior[key] == 0) holes++;
      continue;
    }
    if (seen[key] == 0) {
      parts++;
      final component = <int>[key];
      seen[key] = 1;
      for (var i = 0; i < component.length; i++) {
        for (final next in neighbors(component[i])) {
          if (visible[next] == 1 && seen[next] == 0) {
            seen[next] = 1;
            component.add(next);
          }
        }
      }
    }
    if (alpha(key) >= 245) continue;
    final x = key % width;
    final y = key ~/ width;
    var interior = true;
    for (var dy = -2; dy <= 2 && interior; dy++) {
      for (var dx = -2; dx <= 2; dx++) {
        final px = x + dx;
        final py = y + dy;
        if (px < 0 ||
            py < 0 ||
            px >= width ||
            py >= height ||
            visible[py * width + px] == 0) {
          interior = false;
          break;
        }
      }
    }
    if (interior) translucent++;
  }
  return _Coverage(
    holes: holes,
    parts: parts,
    innerTranslucent: translucent,
    painted: painted,
  );
}

Future<({ByteData bytes, ui.Image image})> _raster(
  int width,
  int height,
  void Function(Canvas) draw,
) async {
  final recorder = ui.PictureRecorder();
  draw(Canvas(recorder));
  final picture = recorder.endRecording();
  final image = await picture.toImage(width, height);
  picture.dispose();
  final bytes = (await image.toByteData(format: ui.ImageByteFormat.rawRgba))!;
  return (bytes: bytes, image: image);
}

AvatarCharacterPainter _painter(
  AvatarCharacter character,
  double side,
  Offset direction,
) => AvatarCharacterPainter(
  character: character,
  color: const Color(0xFF26B9AA),
  phase: 0,
  blink: 0,
  poke: direction.dx != 0 && direction.dy != 0 ? 1 : 0,
  gaze: direction * (side * 0.16),
);

// 排除眼睛和外轮廓后，统计实体内部相邻像素的色阶。
Map<String, int> _surfaceColor(ByteData bytes, int size) {
  bool valid(int x, int y) {
    for (var dy = -2; dy <= 2; dy++) {
      for (var dx = -2; dx <= 2; dx++) {
        final at = ((y + dy) * size + x + dx) * 4;
        if (bytes.getUint8(at + 3) < 250) return false;
        if (bytes.getUint8(at) < 50 &&
            bytes.getUint8(at + 1) < 75 &&
            bytes.getUint8(at + 2) < 75)
          return false;
      }
    }
    return true;
  }

  final histogram = <String, int>{
    'maxChannelStep': 0,
    'over8': 0,
    'over12': 0,
    'over16': 0,
    'over24': 0,
    'over32': 0,
  };
  for (var y = 3; y < size - 4; y++) {
    for (var x = 3; x < size - 4; x++) {
      if (!valid(x, y)) continue;
      for (final delta in const [Offset(1, 0), Offset(0, 1)]) {
        final nx = x + delta.dx.toInt(), ny = y + delta.dy.toInt();
        if (!valid(nx, ny)) continue;
        final a = (y * size + x) * 4, b = (ny * size + nx) * 4;
        var maximum = 0;
        for (var channel = 0; channel < 3; channel++) {
          final d = (bytes.getUint8(a + channel) - bytes.getUint8(b + channel))
              .abs();
          if (d > maximum) maximum = d;
        }
        if (maximum > histogram['maxChannelStep']!)
          histogram['maxChannelStep'] = maximum;
        for (final threshold in [8, 12, 16, 24, 32])
          if (maximum > threshold)
            histogram['over$threshold'] = histogram['over$threshold']! + 1;
      }
    }
  }
  return histogram;
}

void main() {
  testWidgets('透明诊断区分封闭孔、开放凹口和实体内部半透明缝', (tester) async {
    await tester.runAsync(() async {
      final hole = await _raster(96, 96, (canvas) {
        final path = Path()
          ..fillType = PathFillType.evenOdd
          ..addRRect(
            RRect.fromRectAndRadius(
              const Rect.fromLTWH(10, 10, 76, 76),
              const Radius.circular(12),
            ),
          )
          ..addOval(const Rect.fromLTWH(35, 35, 26, 26));
        canvas.drawPath(path, Paint()..color = Colors.teal);
      });
      expect(_coverage(hole.bytes, 96, 96).holes, greaterThan(100));
      hole.image.dispose();
      final notch = await _raster(96, 96, (canvas) {
        final path = Path()
          ..moveTo(10, 10)
          ..lineTo(35, 10)
          ..lineTo(35, 48)
          ..lineTo(61, 48)
          ..lineTo(61, 10)
          ..lineTo(86, 10)
          ..lineTo(86, 86)
          ..lineTo(10, 86)
          ..close();
        canvas.drawPath(path, Paint()..color = Colors.teal);
      });
      final notchCoverage = _coverage(notch.bytes, 96, 96);
      expect(notchCoverage.holes, 0, reason: '与外部背景相通的轮廓凹口不应计为空洞');
      expect(notchCoverage.parts, 1);
      notch.image.dispose();
      final seam = await _raster(96, 96, (canvas) {
        canvas.drawRect(
          const Rect.fromLTRB(10, 10, 47, 86),
          Paint()..color = Colors.teal,
        );
        canvas.drawRect(
          const Rect.fromLTRB(49, 10, 86, 86),
          Paint()..color = Colors.teal,
        );
        canvas.drawRect(
          const Rect.fromLTRB(47, 10, 49, 86),
          Paint()..color = Colors.teal.withValues(alpha: 0.5),
        );
      });
      final seamCoverage = _coverage(seam.bytes, 96, 96);
      expect(seamCoverage.holes, 0);
      expect(seamCoverage.parts, 1);
      expect(seamCoverage.innerTranslucent, greaterThan(50));
      seam.image.dispose();
    });
  });

  testWidgets('全部角色与转头角度构成连续实体，无内部透明孔或半透明接缝', (tester) async {
    final examples = <AvatarCharacterKind, AvatarCharacter>{};
    for (var i = 0; i < 1000; i++) {
      final character = AvatarCharacter.fromSeed('solid-$i');
      examples.putIfAbsent(character.kind, () => character);
      if (examples.length == AvatarCharacterKind.values.length) break;
    }
    expect(examples.length, AvatarCharacterKind.values.length);
    const directions = [
      Offset.zero,
      Offset(-1, 0),
      Offset(1, 0),
      Offset(0, -1),
      Offset(0, 1),
      Offset(-1, -1),
      Offset(-1, 1),
      Offset(1, -1),
      Offset(1, 1),
    ];
    final results = <Map<String, Object>>[];
    await tester.runAsync(() async {
      for (final side in [14, 16, 22, 46, 96]) {
        for (final character in examples.values) {
          for (var pose = 0; pose < directions.length; pose++) {
            const margin = 12;
            final dimension = side + 2 * margin;
            final rendered = await _raster(dimension, dimension, (canvas) {
              canvas.translate(margin.toDouble(), margin.toDouble());
              _painter(
                character,
                side.toDouble(),
                directions[pose],
              ).paint(canvas, Size.square(side.toDouble()));
            });
            final coverage = _coverage(rendered.bytes, dimension, dimension);
            rendered.image.dispose();
            results.add({
              'kind': character.kind.name,
              'side': side,
              'pose': pose,
              ...coverage.json,
            });
          }
        }
      }
      final evidence = Platform.environment['AVATAR_SOLID_EVIDENCE'];
      if (evidence != null && evidence.isNotEmpty) {
        await Directory(evidence).create(recursive: true);
        await File('$evidence/coverage.json')
            .writeAsString(const JsonEncoder.withIndent('  ').convert(results));
        const cell = 136;
        final entries = examples.values.toList();
        final board = await _raster(cell * entries.length, cell * 4, (canvas) {
          for (var row = 0; row < 4; row++) {
            for (var column = 0; column < entries.length; column++) {
              canvas.save();
              canvas.translate(
                (column * cell).toDouble(),
                (row * cell).toDouble(),
              );
              for (var y = 0; y < cell; y += 8) {
                for (var x = 0; x < cell; x += 8) {
                  canvas.drawRect(
                    Rect.fromLTWH(x.toDouble(), y.toDouble(), 8, 8),
                    Paint()
                      ..color = ((x ~/ 8 + y ~/ 8) % 2 == 0
                          ? const Color(0xFFFF00CF)
                          : const Color(0xFFFFEE00)),
                  );
                }
              }
              canvas.translate(20, 20);
              _painter(
                entries[column],
                96,
                directions[row + 1],
              ).paint(canvas, const Size.square(96));
              canvas.restore();
            }
          }
        });
        final png = (await board.image.toByteData(
          format: ui.ImageByteFormat.png,
        ))!;
        await File('$evidence/checkerboard.png')
            .writeAsBytes(png.buffer.asUint8List());
        board.image.dispose();
      }
    });
    final holes = results.where((r) => (r['holes']! as int) != 0).toList();
    final disconnected = results
        .where((r) => (r['parts']! as int) != 1)
        .toList();
    final seams = results
        .where((r) => (r['innerTranslucent']! as int) != 0)
        .toList();
    debugPrint(
      'SOLID_SAMPLES=${results.length} holes=${holes.length} disconnected=${disconnected.length} seams=${seams.length}',
    );
    expect(holes, isEmpty, reason: '实体内部不得透出背景；轮廓凹处由外部洪水填充排除');
    expect(disconnected, isEmpty, reason: '前后面和侧壁必须保持同一连通实体');
    expect(seams, isEmpty, reason: '离轮廓至少两像素的内部不应出现半透明侧壁接缝');
  });
  testWidgets('圆枕转动时内部明暗连续，不出现前后片的硬色阶分界', (tester) async {
    const character = AvatarCharacter(
      kind: AvatarCharacterKind.pillow,
      eyeSpacing: 0.102,
      eyeScale: 1,
      faceLift: 0,
      restTilt: 0,
    );
    final results = <Map<String, Object>>[];
    await tester.runAsync(() async {
      const side = 192;
      const margin = 16;
      const dimension = side + margin * 2;
      for (final direction in const [
        Offset(-1, 0),
        Offset(1, 0),
        Offset(0, -1),
        Offset(0, 1),
      ]) {
        final rendered = await _raster(dimension, dimension, (canvas) {
          canvas.translate(margin.toDouble(), margin.toDouble());
          _painter(
            character,
            side.toDouble(),
            direction,
          ).paint(canvas, const Size.square(192));
        });
        results.add({
          'direction': direction.toString(),
          ..._surfaceColor(rendered.bytes, dimension),
        });
        rendered.image.dispose();
      }
      final evidence = Platform.environment['AVATAR_SOLID_EVIDENCE'];
      if (evidence != null && evidence.isNotEmpty) {
        await Directory(evidence).create(recursive: true);
        await File('$evidence/surface-steps.json')
            .writeAsString(const JsonEncoder.withIndent('  ').convert(results));
      }
    });
    debugPrint('SOLID_SURFACE_STEPS=${jsonEncode(results)}');
    for (final result in results) {
      expect(
        result['maxChannelStep'],
        lessThanOrEqualTo(16),
        reason: '${result['direction']} 的内部软体表面应避免单像素硬色阶；眼睛与外轮廓已排除',
      );
    }
  });
}
