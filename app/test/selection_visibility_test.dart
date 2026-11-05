import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pi_bot/theme.dart';

/// 选区可见性回归。
///
/// 曾经的 bug：选区底色用主控色 14% 透明度，主控色设成蓝色之后，
/// 蓝色 14% 叠在深色背景上几乎和背景同色 —— 拖选半天看不见选中了什么。
/// 选区是「可见性」，不该跟品牌色走。
void main() {
  group('选区底色', () {
    test('不同主控色下选区颜色保持一致（不随主题漂移）', () {
      const seeds = <int>[
        0xFF2E8CF6, // 蓝
        0xFFFB3A9C, // 玫红
        0xFF12C878, // 绿
        0xFFF0901A, // 橙
      ];
      Color? first;
      for (final seed in seeds) {
        final theme = PB.theme(seed: Color(seed));
        final color = theme.textSelectionTheme.selectionColor;
        expect(color, isNotNull, reason: 'seed=${seed.toRadixString(16)}');
        if (first == null) {
          first = color;
        } else {
          expect(color, first, reason: '选区颜色不该随主控色变化');
        }
      }
    });

    test('选区颜色不透明度过低（至少 30%，否则深色底看不见）', () {
      final theme = PB.theme(seed: const Color(0xFF2E8CF6));
      final color = theme.textSelectionTheme.selectionColor!;
      expect(color.a, greaterThanOrEqualTo(0.3), reason: '太淡会看不见');
    });

    test('选区颜色在深色背景上有足够亮度差', () {
      final theme = PB.theme(seed: const Color(0xFF2E8CF6));
      final sel = theme.textSelectionTheme.selectionColor!;
      // 与气泡底色混合后，应该比原底色明显更亮
      final blended = Color.alphaBlend(sel, PB.bgBubble);
      final delta =
          (blended.computeLuminance() - PB.bgBubble.computeLuminance()).abs();
      expect(delta, greaterThan(0.02), reason: '和气泡底色差别太小，看不清');
    });
  });
}
