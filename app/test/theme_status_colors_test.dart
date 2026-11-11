import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pi_bot/theme.dart';

/// WCAG 相对亮度
double _luminance(Color c) {
  double ch(double v) =>
      v <= 0.03928 ? v / 12.92 : math.pow((v + 0.055) / 1.055, 2.4).toDouble();
  return 0.2126 * ch(c.r) + 0.7152 * ch(c.g) + 0.0722 * ch(c.b);
}

/// WCAG 对比度
double _contrast(Color fg, Color bg) {
  final a = _luminance(fg);
  final b = _luminance(bg);
  final hi = math.max(a, b);
  final lo = math.min(a, b);
  return (hi + 0.05) / (lo + 0.05);
}

/// 浅色 pane 的两种底色（见 theme.dart 的 PBNeutral.lightBgPane / lightBgElevated）
const _lightPane = Color(0xFFF5F5F5);
const _lightElevated = Color(0xFFEDEDED);

void main() {
  group('浅色模式状态色对比度', () {
    setUp(() {
      // 这些断言测的是浅色下的取值，必须先切到浅色
      pbColorMode.value = PBColorMode.light;
    });

    tearDown(() {
      pbColorMode.value = PBColorMode.dark;
    });

    test('★ danger 对两种浅色底都 ≥ 4.5', () {
      for (final bg in [_lightPane, _lightElevated]) {
        final r = _contrast(PB.danger, bg);
        expect(r, greaterThanOrEqualTo(4.5),
            reason: 'danger 对 $bg 对比度 ${r.toStringAsFixed(2)}');
      }
    });

    test('★ success 对两种浅色底都 ≥ 4.5', () {
      for (final bg in [_lightPane, _lightElevated]) {
        final r = _contrast(PB.success, bg);
        expect(r, greaterThanOrEqualTo(4.5),
            reason: 'success 对 $bg 对比度 ${r.toStringAsFixed(2)}');
      }
    });

    test('★ warn 对两种浅色底都 ≥ 4.5', () {
      for (final bg in [_lightPane, _lightElevated]) {
        final r = _contrast(PB.warn, bg);
        expect(r, greaterThanOrEqualTo(4.5),
            reason: 'warn 对 $bg 对比度 ${r.toStringAsFixed(2)}');
      }
    });

    test('三个状态色在浅色下不再是深色那套值', () {
      // 深色值放到浅底只有 1.87~3.08，不能让它们漏到浅色模式
      expect(PB.danger, isNot(const Color(0xFFFB4B58)));
      expect(PB.success, isNot(const Color(0xFF22C878)));
      expect(PB.warn, isNot(const Color(0xFFF5A524)));
    });

    test('删除按钮底色 + 白字也够看（≥ 4.5）', () {
      // FilledButton(backgroundColor: PB.danger) 上压的是白字
      final r = _contrast(const Color(0xFFFFFFFF), PB.danger);
      expect(r, greaterThanOrEqualTo(4.5),
          reason: '白字压在 danger 底色上只有 ${r.toStringAsFixed(2)}');
    });
  });

  group('深色模式状态色不变', () {
    setUp(() => pbColorMode.value = PBColorMode.dark);

    test('深色仍是原来的亮色值', () {
      expect(PB.danger, const Color(0xFFFB4B58));
      expect(PB.success, const Color(0xFF22C878));
      expect(PB.warn, const Color(0xFFF5A524));
    });

    test('深色下对深底仍有足够对比度', () {
      const darkBg = Color(0xFF161618);
      for (final c in [PB.danger, PB.success, PB.warn]) {
        final r = _contrast(c, darkBg);
        expect(r, greaterThanOrEqualTo(4.5),
            reason: '$c 对深底只有 ${r.toStringAsFixed(2)}');
      }
    });
  });
}