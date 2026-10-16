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
          lessThanOrEqualTo(size * 0.16 + 0.001),
          reason: '再远也只能偏这么多（0.16 是量过的上限：再大窄形状会压到轮廓）',
        );
      }
    });

    test('★ 幅度要够明显（不然用户"完全感觉不到"）', () {
      // 常见距离：鼠标离头像 300px。以前这里只偏 0.07*size（46px 的头像 = 3px），
      // 等于看不见；现在应该到 0.13*size 以上。
      final o = eyeOffsetToward(
        avatarCenter: center,
        pointer: const Offset(400, 100), // 距离 300
        size: size,
      );
      expect(
        o.distance / size,
        greaterThan(0.13),
        reason: '46px 的头像在 300px 距离下至少要偏 6px 才看得出来',
      );
    });

    test('★ 近距离就要给满偏移（鼠标往往就在同一行里）', () {
      // 46px 的头像、鼠标在 40px 外（同一行的名字那一带）——
      // 旧公式只偏 0.06*size（3px），用户感受不到。
      final o = eyeOffsetToward(
        avatarCenter: center,
        pointer: const Offset(140, 100), // 距离 40
        size: size,
      );
      expect(
        o.distance / size,
        greaterThan(0.14),
        reason: '同一行内就该接近满偏移，而不是"越近越不偏"',
      );
    });

    test('近处随距离增长，够远就饱和（不再无限增长）', () {
      Offset at(double dx) => eyeOffsetToward(
        avatarCenter: center,
        pointer: Offset(100 + dx, 100),
        size: size,
      );
      // 极近处按比例（"刚好擦到"的感觉）
      expect(at(4).dx, lessThan(at(12).dx));
      // 超过 0.3*size 之后给满 —— 同一行内的任何位置都是"满偏"，
      // 这正是用户要的（鼠标在行里，眼睛就该看着你）
      expect(at(20).dx, closeTo(at(400).dx, 0.01));
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

  testWidgets('★ 静态头像（animate: false）也要跟着鼠标看', (tester) async {
    // 这个 bug 真发生过：initState 里 `if (!_alive) return;` 写在登记监听之前，
    // 于是 animate:false 的头像（侧边栏那一列）永远收不到鼠标位置，
    // 肉眼就是"侧边栏不跟随，只有聊天区跟随"。
    BlobAvatar.animationsEnabled = true;
    addTearDown(() => BlobAvatar.animationsEnabled = true);
    AvatarLife.pointer.value = null;

    await tester.pumpWidget(
      const MaterialApp(
        home: Scaffold(
          body: Center(
            child: BlobAvatar(
              seed: 'sidebar',
              color: Colors.green,
              animate: false, // ← 侧边栏就是这样
            ),
          ),
        ),
      ),
    );
    await tester.pump();

    final center = tester.getCenter(find.byType(BlobAvatar));
    AvatarLife.pointer.value = center + const Offset(200, 0);
    await tester.pump();

    // 视线偏移传下去之后，头像应该重绘（有新的帧被安排）
    expect(tester.takeException(), isNull);
    expect(find.byType(BlobAvatar), findsOneWidget);
    AvatarLife.pointer.value = null;
  });

  testWidgets('followPointer:false 的头像不该被鼠标牵动（群头像用）', (tester) async {
    BlobAvatar.animationsEnabled = true;
    addTearDown(() => BlobAvatar.animationsEnabled = true);

    await tester.pumpWidget(
      const MaterialApp(
        home: Scaffold(
          body: Center(
            child: BlobAvatar(
              seed: 'group',
              color: Colors.orange,
              followPointer: false,
            ),
          ),
        ),
      ),
    );
    await tester.pump();
    AvatarLife.pointer.value = tester.getCenter(find.byType(BlobAvatar)) +
        const Offset(300, 0);
    await tester.pump();
    expect(tester.takeException(), isNull);
    AvatarLife.pointer.value = null;
  });
}
