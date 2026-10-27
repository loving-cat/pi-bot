import 'dart:isolate';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pi_bot/widgets/avatar_character.dart';
import 'package:pi_bot/widgets/avatar_character_painter.dart';
import 'package:pi_bot/widgets/avatar_life.dart';

List<Object> _identity(String seed) {
  final character = AvatarCharacter.fromSeed(seed);
  return [
    character.kind.name,
    character.eyeSpacing,
    character.eyeScale,
    character.faceLift,
    character.restTilt,
  ];
}

AvatarCharacterPainter _painter(
  AvatarCharacter character, {
  bool ring = false,
  AvatarMood mood = AvatarMood.idle,
  Offset gaze = Offset.zero,
  double poke = 0,
  double blink = 0,
}) => AvatarCharacterPainter(
  character: character,
  color: const Color(0xFF5EA69C),
  phase: 0,
  blink: blink,
  poke: poke,
  gaze: gaze,
  ring: ring,
  mood: mood,
);

void main() {
  test('角色身份在不同 isolate 中一致，包含空串和非拉丁种子', () async {
    const seeds = ['', 'chief', 'bot-128', '测试成员', '成员🪴'];
    final first = [for (final seed in seeds) _identity(seed)];
    final other = await Isolate.run(
      () => [for (final seed in seeds) _identity(seed)],
    );
    expect(other, first);
    for (final identity in first) {
      for (final value in identity.skip(1).cast<double>()) {
        expect(value.isFinite, isTrue);
      }
    }
  });

  test('一批成员拥有多种轮廓，成员重新排序不改变身份', () {
    final seeds = [for (var i = 0; i < 80; i++) 'member-$i'];
    final original = {for (final seed in seeds) seed: _identity(seed)};
    final reversed = {for (final seed in seeds.reversed) seed: _identity(seed)};
    expect(reversed, original);
    expect(
      original.values.map((value) => value.first).toSet().length,
      greaterThanOrEqualTo(6),
    );
  });

  test('身份环和忙闲变化要求重绘，未变化的委托不额外重绘', () {
    final character = AvatarCharacter.fromSeed('repaint-member');
    final original = _painter(character);
    expect(_painter(character).shouldRepaint(original), isFalse);
    expect(_painter(character, ring: true).shouldRepaint(original), isTrue);
    expect(
      _painter(character, mood: AvatarMood.busy).shouldRepaint(original),
      isTrue,
    );
    expect(
      _painter(character, gaze: const Offset(2, -1)).shouldRepaint(original),
      isTrue,
    );
  });

  testWidgets('全部角色在14至96像素及极限表情下可绘制且不越过头像槽', (tester) async {
    final examples = <AvatarCharacterKind, AvatarCharacter>{};
    for (var i = 0; i < 1000; i++) {
      final character = AvatarCharacter.fromSeed('render-$i');
      examples.putIfAbsent(character.kind, () => character);
      if (examples.length == AvatarCharacterKind.values.length) break;
    }
    expect(examples.length, AvatarCharacterKind.values.length);

    await tester.runAsync(() async {
      for (final side in [14, 16, 22, 46, 96]) {
        for (final character in examples.values) {
          for (final pose in [0, 1, 2]) {
            const margin = 12;
            final dimension = side + margin * 2;
            final recorder = ui.PictureRecorder();
            final canvas = Canvas(recorder)
              ..translate(margin.toDouble(), margin.toDouble());
            _painter(
              character,
              ring: true,
              mood: pose == 0 ? AvatarMood.idle : AvatarMood.busy,
              gaze: pose == 0
                  ? Offset.zero
                  : Offset(side * 0.16 * (pose == 1 ? 1 : -1), -side * 0.16),
              poke: pose == 2 ? 1 : 0,
              blink: pose == 1 ? 1 : 0,
            ).paint(canvas, Size.square(side.toDouble()));
            final picture = recorder.endRecording();
            final image = await picture.toImage(dimension, dimension);
            final data = await image.toByteData(
              format: ui.ImageByteFormat.rawRgba,
            );
            image.dispose();
            picture.dispose();
            expect(data, isNotNull);
            var painted = 0;
            var escaped = 0;
            for (var y = 0; y < dimension; y++) {
              for (var x = 0; x < dimension; x++) {
                final alpha = data!.getUint8((y * dimension + x) * 4 + 3);
                if (alpha <= 8) continue;
                painted++;
                if (x < margin - 1 ||
                    x >= margin + side + 1 ||
                    y < margin - 1 ||
                    y >= margin + side + 1) {
                  escaped++;
                }
              }
            }
            final scenario = '${character.kind.name} / $side px / pose $pose';
            expect(painted, greaterThan(side * side * 0.1), reason: scenario);
            expect(escaped, 0, reason: '$scenario 应保留头像槽边界');
          }
        }
      }
    });
  });
}
