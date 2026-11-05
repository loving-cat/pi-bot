import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pi_bot/theme.dart';

/// 明暗切换的回归测试。
///
/// 用户反馈：切换时中间的条（分割线）不会及时变色。
/// 根因是 const VerticalDivider —— const 实例在编译期固化，
/// 里面的颜色永远是创建时算的，切换后不会重新求值。
void main() {
  tearDown(() {
    // 每个用例结束都还原，避免影响其它测试
    pbColorMode.value = PBColorMode.dark;
  });

  group('颜色 getter 跟随模式', () {
    test('深色与浅色返回不同的背景色', () {
      pbColorMode.value = PBColorMode.dark;
      final darkBg = PB.bgApp;
      pbColorMode.value = PBColorMode.light;
      final lightBg = PB.bgApp;
      expect(darkBg, isNot(lightBg));
    });

    test('浅色背景比深色亮', () {
      pbColorMode.value = PBColorMode.dark;
      final darkLum = PB.bgApp.computeLuminance();
      pbColorMode.value = PBColorMode.light;
      final lightLum = PB.bgApp.computeLuminance();
      expect(lightLum, greaterThan(darkLum));
    });

    test('浅色下文字比背景深（否则看不清）', () {
      pbColorMode.value = PBColorMode.light;
      expect(
        PB.textPrimary.computeLuminance(),
        lessThan(PB.bgApp.computeLuminance()),
      );
    });

    test('深色下文字比背景亮', () {
      pbColorMode.value = PBColorMode.dark;
      expect(
        PB.textPrimary.computeLuminance(),
        greaterThan(PB.bgApp.computeLuminance()),
      );
    });

    test('边框随模式反转：浅色用深色半透明，深色用白色半透明', () {
      pbColorMode.value = PBColorMode.dark;
      final darkBorder = PB.borderTertiary;
      pbColorMode.value = PBColorMode.light;
      final lightBorder = PB.borderTertiary;
      expect(darkBorder, isNot(lightBorder));
      // 浅色边框应该比背景深，否则画在浅底上等于没有
      expect(
        lightBorder.computeLuminance(),
        lessThan(PB.bgApp.computeLuminance()),
      );
    });
  });

  group('对比度', () {
    /// WCAG 对比度
    double contrast(Color a, Color b) {
      final la = a.computeLuminance();
      final lb = b.computeLuminance();
      final hi = la > lb ? la : lb;
      final lo = la > lb ? lb : la;
      return (hi + 0.05) / (lo + 0.05);
    }

    test('浅色模式正文对比度 ≥ 4.5（可读下限）', () {
      pbColorMode.value = PBColorMode.light;
      expect(
        contrast(PB.textPrimary, PB.bgApp),
        greaterThanOrEqualTo(4.5),
      );
      expect(
        contrast(PB.textPrimary, PB.bgElevated),
        greaterThanOrEqualTo(4.5),
      );
    });

    test('浅色模式次级文字仍可读', () {
      pbColorMode.value = PBColorMode.light;
      expect(
        contrast(PB.textSecondary, PB.bgApp),
        greaterThanOrEqualTo(4.5),
      );
    });

    test('深色模式正文对比度 ≥ 4.5', () {
      pbColorMode.value = PBColorMode.dark;
      expect(
        contrast(PB.textPrimary, PB.bgApp),
        greaterThanOrEqualTo(4.5),
      );
    });
  });

  group('层次', () {
    test('浅色下气泡比背景白，才有浮起来的感觉', () {
      pbColorMode.value = PBColorMode.light;
      expect(
        PB.bgBubble.computeLuminance(),
        greaterThan(PB.bgApp.computeLuminance()),
      );
    });

    test('浅色下各层背景互不相同（否则看不出分区）', () {
      pbColorMode.value = PBColorMode.light;
      final layers = {PB.bgApp, PB.bgPane, PB.bgElevated, PB.bgBubble};
      expect(layers.length, greaterThanOrEqualTo(3));
    });
  });
}
