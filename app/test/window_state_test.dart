import 'dart:ui';

import 'package:flutter_test/flutter_test.dart';
import 'package:pi_bot/window_state.dart';

void main() {
  const visible = Rect.fromLTWH(0, 0, 1920, 1080);

  test('encode/decode 往返', () {
    const bounds = WindowBounds(rect: Rect.fromLTWH(120, 80, 1200, 800), maximized: true);
    final decoded = decodeWindowBounds(encodeWindowBounds(bounds));
    expect(decoded, isNotNull);
    expect(decoded!.rect, bounds.rect);
    expect(decoded.maximized, isTrue);
  });

  test('坏数据 / 太小的尺寸一律忽略', () {
    expect(decodeWindowBounds(null), isNull);
    expect(decodeWindowBounds(''), isNull);
    expect(decodeWindowBounds('not json'), isNull);
    expect(decodeWindowBounds('{"x":1}'), isNull);
    // 比最小可用尺寸还小 → 当作没记过（避免窗口小到点不到）
    expect(
      decodeWindowBounds('{"x":0,"y":0,"w":100,"h":100}'),
      isNull,
    );
  });

  test('★ 屏幕外的位置会被夹回可见区域', () {
    // 显示器拔掉后，记忆里还在副屏（x=3000）
    final clamped = clampWindowRect(const Rect.fromLTWH(3000, 200, 1200, 800), visible);
    expect(clamped.right, lessThanOrEqualTo(visible.right));
    expect(clamped.left, greaterThanOrEqualTo(visible.left));
    expect(clamped.width, 1200);
  });

  test('★ 整个跑到左上角外面：拉回可见区，尺寸不变', () {
    final clamped = clampWindowRect(const Rect.fromLTWH(-5000, -5000, 1000, 700), visible);
    expect(clamped.left, greaterThanOrEqualTo(0));
    expect(clamped.top, greaterThanOrEqualTo(0));
    expect(clamped.width, 1000);
    expect(clamped.height, 700);
  });

  test('尺寸不超过当前屏幕', () {
    const small = Rect.fromLTWH(0, 0, 1280, 720);
    final clamped = clampWindowRect(const Rect.fromLTWH(0, 0, 2000, 1400), small);
    expect(clamped.width, lessThanOrEqualTo(1280));
    expect(clamped.height, lessThanOrEqualTo(720));
  });

  test('正常位置原样保留', () {
    const desired = Rect.fromLTWH(200, 150, 1180, 760);
    expect(clampWindowRect(desired, visible), desired);
  });
}
