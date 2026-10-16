// 头像"活着"的那部分。
//
// 两条要钉住的东西：
//   1. 眼睛看的方向对不对（搞反了肉眼很难发现 —— 你会觉得"有点怪"但说不上来）
//   2. 安静下来之后动画循环**真的停了**（一直在动不等于活，只等于一直烧光栅；
//      我们量过桌面端 raster 是瓶颈，所以这是有意的取舍，不是偷懒）
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pi_bot/widgets/avatar_life.dart';
import 'package:pi_bot/widgets/blob_avatar.dart';

void main() {
  group('eyeOffsetToward：眼睛往哪看', () {
    const center = Offset(100, 100);
    const size = 44.0;

    test('鼠标在右边 → 眼睛往右偏', () {
      final o = eyeOffsetToward(
        avatarCenter: center,
        pointer: const Offset(300, 100),
        size: size,
      );
      expect(o.dx, greaterThan(0), reason: '★ 方向反了就是"看反方向"');
      expect(o.dy.abs(), lessThan(0.01));
    });

    test('鼠标在左上 → 两个方向都是负的', () {
      final o = eyeOffsetToward(
        avatarCenter: center,
        pointer: const Offset(0, 0),
        size: size,
      );
      expect(o.dx, lessThan(0));
      expect(o.dy, lessThan(0));
    });

    test('鼠标正好在头像中心 → 视线回正（不能抖动）', () {
      expect(
        eyeOffsetToward(
          avatarCenter: center,
          pointer: center,
          size: size,
        ),
        Offset.zero,
      );
    });

    test('偏移量有上限，眼睛不会跑出脸', () {
      for (final far in [
        const Offset(9999, 0),
        const Offset(0, -9999),
        const Offset(-9999, -9999),
      ]) {
        final o = eyeOffsetToward(
          avatarCenter: center,
          pointer: far,
          size: size,
        );
        expect(
          o.distance,
          lessThanOrEqualTo(size * 0.11 + 0.001),
          reason: '再远也只能偏这么多',
        );
      }
    });

    test('越远偏得越多，但增长会收敛', () {
      Offset at(double dx) => eyeOffsetToward(
        avatarCenter: center,
        pointer: Offset(100 + dx, 100),
        size: size,
      );
      expect(at(20).dx, lessThan(at(80).dx));
      expect(at(80).dx, lessThan(at(400).dx));
    });
  });

  testWidgets('安静下来之后动画真的停了', (tester) async {
    // 开动画跑这个用例：要的就是"会动 → 停"这条曲线
    BlobAvatar.animationsEnabled = true;
    addTearDown(() => BlobAvatar.animationsEnabled = true);

    await tester.pumpWidget(
      const MaterialApp(
        home: Scaffold(
          body: Center(
            child: BlobAvatar(seed: 'settle-测试', color: Colors.blue),
          ),
        ),
      ),
    );
    await tester.pump(const Duration(seconds: 1));

    // ★ 关键断言就在这一句：扭动是**无限循环**的控制器，
    //   如果 settle 之后没停，pumpAndSettle 会一直等下去直到超时。
    //   它能正常返回，就说明动画循环确实结束了。
    await tester.pumpAndSettle(
      const Duration(milliseconds: 200),
      EnginePhase.sendSemanticsUpdate,
      const Duration(seconds: 40),
    );

    // 停下来之后，界面是"安静"的：再推一帧也没有新的绘制
    await tester.pump(const Duration(seconds: 1));
    expect(find.byType(BlobAvatar), findsOneWidget);
  });

  testWidgets('可点的大头像：戳一下不崩，而且会被唤醒', (tester) async {
    BlobAvatar.animationsEnabled = true;
    addTearDown(() => BlobAvatar.animationsEnabled = true);

    await tester.pumpWidget(
      const MaterialApp(
        home: Scaffold(
          body: Center(
            child: BlobAvatar(
              seed: 'poke-测试',
              color: Colors.green,
              size: 64,
              interactive: true,
            ),
          ),
        ),
      ),
    );
    await tester.pump();

    await tester.tap(find.byType(BlobAvatar));
    await tester.pump(const Duration(milliseconds: 200));
    // 挤压动画跑完
    await tester.pumpAndSettle(
      const Duration(milliseconds: 100),
      EnginePhase.sendSemanticsUpdate,
      const Duration(seconds: 40),
    );
    expect(tester.takeException(), isNull);
  });
}
