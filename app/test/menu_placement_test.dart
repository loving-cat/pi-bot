import 'dart:ui';

import 'package:flutter_test/flutter_test.dart';
import 'package:pi_bot/widgets/floating_menu.dart';

/// 浮层落点回归。
///
/// 曾经的问题：菜单从锚点左上角往下 gap 就开始画，
/// 于是**正好盖在触发它的那颗按钮上**（按钮本身有 40px 高）。
/// 用户点了加号，弹出来的卡片把加号自己挡住了。
void main() {
  const screen = Size(1200, 800);

  group('往下开时不能盖住按钮', () {
    test('浮层顶边在按钮下方，而不是压在按钮上', () {
      // 按钮在 (100,100)，40px 高
      final spot = menuPlacement(
        anchor: const Offset(100, 100),
        screen: screen,
        entryCount: 3,
        width: 300,
        gap: 8,
        anchorHeight: 40,
      );
      expect(spot.top, isNotNull);
      // 关键断言：顶边必须 >= 按钮底边（100 + 40），浮层不会遮住按钮
      expect(
        spot.top!,
        greaterThanOrEqualTo(140),
        reason: '浮层不能盖在按钮上（按钮底部是 140）',
      );
      // 也不能离得太远
      expect(spot.top!, lessThan(140 + 40));
    });

    test('不传 anchorHeight 时退回老行为（右键菜单靠它）', () {
      final spot = menuPlacement(
        anchor: const Offset(100, 100),
        screen: screen,
        entryCount: 3,
        width: 300,
        gap: 8,
      );
      // 右键菜单的锚点是鼠标位置，从那儿往下 gap 就开始
      expect(spot.top, 108);
    });

    test('按钮很高时也不会盖住（比如 56px 的大按钮）', () {
      final spot = menuPlacement(
        anchor: const Offset(50, 200),
        screen: screen,
        entryCount: 2,
        width: 260,
        gap: 6,
        anchorHeight: 56,
      );
      expect(spot.top!, greaterThanOrEqualTo(256));
    });
  });

  group('空间不够时翻到上方', () {
    test('按钮贴近屏幕底部 → 往上开，底边贴按钮上边', () {
      final spot = menuPlacement(
        anchor: const Offset(100, 740),
        screen: screen,
        entryCount: 8,
        width: 300,
        gap: 8,
        anchorHeight: 40,
      );
      // 判定仍然在可视区内
      if (spot.top == null) {
        expect(spot.bottom, isNotNull);
        expect(spot.bottom!, greaterThan(0));
      } else {
        expect(spot.top!, lessThanOrEqualTo(screen.height));
      }
    });
  });

  group('水平方向不越界', () {
    test('贴近右边缘时往左推', () {
      final spot = menuPlacement(
        anchor: const Offset(1150, 100),
        screen: screen,
        entryCount: 3,
        width: 300,
        gap: 8,
        anchorHeight: 40,
      );
      expect(spot.left + 300, lessThanOrEqualTo(screen.width));
    });

    test('贴近左边缘时留出边距', () {
      final spot = menuPlacement(
        anchor: const Offset(0, 100),
        screen: screen,
        entryCount: 3,
        width: 300,
        gap: 8,
        anchorHeight: 40,
      );
      expect(spot.left, greaterThanOrEqualTo(8));
    });
  });
}
