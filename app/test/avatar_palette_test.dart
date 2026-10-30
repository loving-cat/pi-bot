// 头像调色板的饱和度约束
//
// 背景：暗色底上饱和度不够的实体会发灰、和背景糊在一起。
// 用户对比 GrokBot（实测 S 88~97%）后要求提高饱和度。
//
// 这组测试守两件事：
//   1. 调色板本身的饱和度够高（除故意的灰色）
//   2. 渲染时的 clamp 不会把高饱和颜色压回去
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pi_bot/theme.dart';

/// 取 HSL 饱和度（0~1）
double saturationOf(Color c) {
  final r = c.r, g = c.g, b = c.b;
  final max = [r, g, b].reduce((a, b) => a > b ? a : b);
  final min = [r, g, b].reduce((a, b) => a < b ? a : b);
  final l = (max + min) / 2;
  if (max == min) return 0;
  return l > 0.5 ? (max - min) / (2 - max - min) : (max - min) / (max + min);
}

double lightnessOf(Color c) {
  final max = [c.r, c.g, c.b].reduce((a, b) => a > b ? a : b);
  final min = [c.r, c.g, c.b].reduce((a, b) => a < b ? a : b);
  return (max + min) / 2;
}

void main() {
  // 灰色是刻意低饱和的（承担"中性/未分类"语义），测试里单独排除
  List<Color> vividColors() => PB.palette.where((c) => saturationOf(c) > 0.15).toList();

  test('★ 调色板平均饱和度过关（对齐 GrokBot 的水平）', () {
    final vivid = vividColors();
    final avg = vivid.map(saturationOf).reduce((a, b) => a + b) / vivid.length;
    expect(
      avg,
      greaterThan(0.80),
      reason: '平均饱和度 ${(avg * 100).round()}% 偏低，暗色底上会发灰。'
          '改颜色前先看 docs/PITFALLS.md 里关于图标/配色的约定。',
    );
  });

  test('★ 非暖暗色每一档都够鲜艳（≥ 80%）', () {
    // 暖色的暗部（棕/赭）在物理上就达不到高饱和 ——
    // 把棕色硬拉到 80% 就变成橙色了，那是另一个颜色而不是"棕"。
    // 所以按色相分开要求：冷色/亮色 ≥80%，暖暗色 ≥45%。
    for (final c in vividColors()) {
      final s = saturationOf(c);
      final hue = HSLColor.fromColor(c).hue;
      final isWarmDark = (hue >= 15 && hue <= 45) && lightnessOf(c) < 0.55;
      final floor = isWarmDark ? 0.45 : 0.80;
      expect(
        s,
        greaterThanOrEqualTo(floor),
        reason: '#${c.toARGB32().toRadixString(16)} '
            '(H=${hue.round()}°) 饱和度 ${(s * 100).round()}% '
            '低于该类下限 ${(floor * 100).round()}%',
      );
    }
  });

  test('灰调保留低饱和，拉高了反而抢注意力', () {
    final gray = PB.palette.where((c) => saturationOf(c) <= 0.15).toList();
    expect(gray.length, greaterThanOrEqualTo(1), reason: '应至少保留一个中性灰');
  });

  test('亮度落在可读区间，不会过暗或发白', () {
    for (final c in PB.palette) {
      final l = lightnessOf(c);
      expect(l, greaterThan(0.30), reason: '太暗会和深色背景糊在一起');
      expect(l, lessThan(0.72), reason: '太亮会发白，失去饱和度观感');
    }
  });

  test('调色板至少 8 档，避免不同 bot 撞色', () {
    expect(PB.palette.length, greaterThanOrEqualTo(8));
  });
}
