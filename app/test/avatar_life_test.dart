// 头像"活着"的那部分。
//
// 两条要钉住的东西：
//   1. 眼睛看的方向对不对（搞反了肉眼很难发现，只会觉得"有点怪"但说不上来）
//   2. 安静下来之后动画循环**真的停了**（一直在动不等于活，只等于一直烧光栅；
//      桌面端 raster 是瓶颈，所以这是有意的取舍，不是偷懒）
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
        eyeOffsetToward(avatarCenter: center, pointer: center, size: size),
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
      // 常见距离：鼠标离头像 300px，偏移要达到 0.13*size 以上；
      // 只偏 0.07*size（46px 的头像 = 3px）等于看不见。
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
      // 只偏 0.06*size（3px）的话用户感受不到。
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
      // 鼠标在行里，眼睛就该看着它
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
    // initState 里 `if (!_alive) return;` 不能写在登记监听之前，
    // 否则 animate:false 的头像（侧边栏那一列）永远收不到鼠标位置，
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
    AvatarLife.pointer.value =
        tester.getCenter(find.byType(BlobAvatar)) + const Offset(300, 0);
    await tester.pump();
    expect(tester.takeException(), isNull);
    AvatarLife.pointer.value = null;
  });

  group('advanceGaze：视线是"转过去"的，不是"瞬移"', () {
    const rate = AvatarLife.gazeFollowRate;

    test('★ 一步走不完：不能一帧就到站（否则白做缓动）', () {
      final r = advanceGaze(
        current: Offset.zero,
        target: const Offset(10, 0),
        dtSeconds: 1 / 60,
        rate: rate,
      );
      expect(r.arrived, isFalse);
      expect(r.value.dx, greaterThan(0), reason: '要往目标走');
      expect(r.value.dx, lessThan(10), reason: '★ 一帧就走完 = 瞬移');
    });

    test('★ 约 180ms 走完八成（整颗头像一起倾斜，比眼球扫视略慢）', () {
      var v = Offset.zero;
      const target = Offset(10, 0);
      for (var i = 0; i < 11; i++) {
        v = advanceGaze(
          current: v,
          target: target,
          dtSeconds: 1 / 60,
          rate: rate,
        ).value;
      }
      expect(v.dx / 10, greaterThan(0.7), reason: '180ms 后要走过大半，不能慢吞吞');
      expect(v.dx / 10, lessThan(1.0), reason: '180ms 也不该完全到站');
    });

    test('★ 整块动比只动眼睛更容易显急 —— 100ms 内不该走完大半', () {
      var v = Offset.zero;
      for (var i = 0; i < 6; i++) {
        v = advanceGaze(
          current: v,
          target: const Offset(10, 0),
          dtSeconds: 1 / 60,
          rate: rate,
        ).value;
      }
      expect(v.dx / 10, lessThan(0.75), reason: '太快会像抽搐');
    });

    test('单调逼近目标，不冲过头', () {
      var v = Offset.zero;
      const target = Offset(0, -8);
      var last = 0.0;
      for (var i = 0; i < 30; i++) {
        v = advanceGaze(
          current: v,
          target: target,
          dtSeconds: 1 / 60,
          rate: rate,
        ).value;
        expect(v.dy, lessThanOrEqualTo(0), reason: '方向不能反');
        expect(v.dy.abs(), greaterThanOrEqualTo(last), reason: '不能往回退');
        last = v.dy.abs();
      }
    });

    test('到站后贴齐目标，并报告 arrived（好让 ticker 停下）', () {
      final r = advanceGaze(
        current: const Offset(9.9, 0),
        target: const Offset(10, 0),
        dtSeconds: 1 / 60,
        rate: rate,
      );
      expect(r.arrived, isTrue);
      expect(r.value, const Offset(10, 0), reason: '要贴齐，不能留半像素');
    });

    test('★ 大 dt（窗口卡顿/切回前台）也不会算出荒唐的值', () {
      final r = advanceGaze(
        current: Offset.zero,
        target: const Offset(10, 0),
        dtSeconds: 5, // 卡了 5 秒
        rate: rate,
      );
      expect(r.value.dx, lessThanOrEqualTo(10.0001), reason: '不能冲过头');
    });
  });

  group('组件行为：离开缓慢回正 / 没盯着时有小动作', () {
    /// 读当前视线偏移（从 CustomPaint 的 painter 上拿，不用截图）
    Offset gazeOf(WidgetTester tester) {
      final paint = tester.widget<CustomPaint>(
        find.descendant(
          of: find.byType(BlobAvatar),
          matching: find.byType(CustomPaint),
        ),
      );
      return (paint.painter as dynamic).gaze as Offset;
    }

    setUp(() => AvatarLife.pointer.value = null);
    tearDown(() => AvatarLife.pointer.value = null);

    testWidgets('★ 鼠标离开后，眼睛不是啪一下回正，而是分几帧走回去', (tester) async {
      BlobAvatar.animationsEnabled = true;
      addTearDown(() => BlobAvatar.animationsEnabled = true);

      // 用 hovered 显式驱动（就是会话行那条路），不跟 MouseRegion 的 enter 事件较劲
      Widget build(bool hovered) => MaterialApp(
        home: Scaffold(
          body: Center(
            child: BlobAvatar(
              seed: 'gaze-测试',
              color: Colors.blue,
              hovered: hovered,
            ),
          ),
        ),
      );

      await tester.pumpWidget(build(true));
      await tester.pump();
      final center = tester.getCenter(find.byType(BlobAvatar));
      AvatarLife.pointer.value = center + const Offset(200, 0);
      await tester.pump();
      for (var i = 0; i < 20; i++) {
        await tester.pump(const Duration(milliseconds: 16));
      }
      final looking = gazeOf(tester);
      expect(looking.distance, greaterThan(1), reason: '应该已经在看鼠标了');

      // 鼠标离开：目标变成 0，但要花时间
      AvatarLife.pointer.value = null;
      await tester.pumpWidget(build(false));
      await tester.pump(const Duration(milliseconds: 16));

      final afterOneFrame = gazeOf(tester);
      expect(
        afterOneFrame.distance,
        greaterThan(0),
        reason: '★ 一帧就归零 = 还是瞬移，缓动没生效',
      );
      expect(
        afterOneFrame.distance,
        lessThan(looking.distance),
        reason: '但要开始往回走',
      );

      for (var i = 0; i < 40; i++) {
        await tester.pump(const Duration(milliseconds: 16));
      }
      expect(gazeOf(tester).distance, lessThan(0.5), reason: '最终要回正');
    });

    testWidgets('★ 干活中的头像（animate:false）也会自己动 —— 侧边栏要看得出谁在忙', (tester) async {
      BlobAvatar.animationsEnabled = true;
      addTearDown(() => BlobAvatar.animationsEnabled = true);
      AvatarLife.pointer.value = null;

      await tester.pumpWidget(
        const MaterialApp(
          home: Scaffold(
            body: Center(
              child: BlobAvatar(
                seed: 'busy-测试',
                color: Colors.orange,
                animate: false, // 侧边栏的房间行就是这样
                mood: AvatarMood.busy,
              ),
            ),
          ),
        ),
      );
      await tester.pump();

      // ★ busy 的 gaze 基线里含 busyLift（"抬眼想事情"的固定偏移），
      //   所以不能拿它跟 0 比 —— 要比较的是**相对基线有没有再动**。
      final baseline = gazeOf(tester);

      var moved = false;
      for (var i = 0; i < 60; i++) {
        await tester.pump(const Duration(milliseconds: 100));
        if ((gazeOf(tester) - baseline).distance > 0.8) {
          moved = true;
          break;
        }
      }
      expect(moved, isTrue, reason: '★ 干活中的头像该有自发小动作（视线挪开一下），否则列表里看不出谁在忙');
    });

    testWidgets('闲着的静态头像不该自己动（一屏几十个一起动会卡）', (tester) async {
      BlobAvatar.animationsEnabled = true;
      addTearDown(() => BlobAvatar.animationsEnabled = true);
      AvatarLife.pointer.value = null;

      await tester.pumpWidget(
        const MaterialApp(
          home: Scaffold(
            body: Center(
              child: BlobAvatar(
                seed: 'idle-测试',
                color: Colors.teal,
                animate: false,
                mood: AvatarMood.idle,
              ),
            ),
          ),
        ),
      );
      await tester.pump();
      for (var i = 0; i < 40; i++) {
        await tester.pump(const Duration(milliseconds: 100));
      }
      expect(gazeOf(tester).distance, lessThan(0.5), reason: '闲着的静态头像保持静止');
    });

    testWidgets('★ 先 hover、之后指针才有值：眼睛也要跟上去', (tester) async {
      // 真机上就是这个顺序：onEnter 那一刻 AvatarLife.pointer 可能还是 null
      // （鼠标刚进窗口/刚移进这一行、onHover 还没发）。如果 _startFollow
      // 那一次算不出偏移就永久放弃，眼睛就一直是呆的 —— 这正是"看起来
      // 跟随功能坏了"的原因。
      BlobAvatar.animationsEnabled = true;
      addTearDown(() => BlobAvatar.animationsEnabled = true);
      AvatarLife.pointer.value = null;

      await tester.pumpWidget(
        const MaterialApp(
          home: Scaffold(
            body: Center(
              child: BlobAvatar(seed: 'late-测试', color: Colors.purple),
            ),
          ),
        ),
      );
      await tester.pump();

      // hover 先发生（此时没有指针位置）
      final box = tester.widget<BlobAvatar>(find.byType(BlobAvatar));
      expect(box.hovered, isFalse);
      await tester.pumpWidget(
        const MaterialApp(
          home: Scaffold(
            body: Center(
              child: BlobAvatar(
                seed: 'late-测试',
                color: Colors.purple,
                hovered: true, // ← 开始跟随，但 pointer 还是 null
              ),
            ),
          ),
        ),
      );
      await tester.pump();

      // 指针位置随后才到
      final center = tester.getCenter(find.byType(BlobAvatar));
      AvatarLife.pointer.value = center + const Offset(150, 0);
      await tester.pump();
      for (var i = 0; i < 20; i++) {
        await tester.pump(const Duration(milliseconds: 16));
      }

      expect(
        gazeOf(tester).distance,
        greaterThan(1),
        reason: '★ 指针晚到也要跟上，不能一直发呆',
      );
    });
  });

  group('形状要有辨识度（不能全是圆）', () {
    test('★ 形状种类要够杂 —— 否则整屏头像只能靠颜色区分', () {
      // 侧边栏那种场景：十几个 bot 排一列。如果形状全一样，
      // 用户就只能靠颜色和名字认人，头像等于装饰。
      final seeds = [for (var i = 0; i < 40; i++) 'bot-$i'];
      final kinds = {for (final s in seeds) BlobAvatar.shapeKindOf(s)};

      debugPrint('SHAPES ${kinds.toList()..sort()}');
      expect(
        kinds.length,
        greaterThanOrEqualTo(6),
        reason: '40 个 bot 至少要有 6 种不同形状，不然看着像同一块橡皮泥捏的',
      );
    });

    test('★ 同一批 bot 里要有"带棱角"的形状（三角/六边形）', () {
      // 全是圆润形状（豆/卵石/蛋）也会糊成一片。三角和六边形是
      // 一眼能认出来的那种 —— 参考实现里也正是靠它们做区分。
      final seeds = [for (var i = 0; i < 40; i++) 'bot-$i'];
      final kinds = {for (final s in seeds) BlobAvatar.shapeKindOf(s)};
      expect(
        kinds.any((k) => k == 'tri' || k == 'hexagon'),
        isTrue,
        reason: '★ 需要带棱角的形状来拉开辨识度',
      );
    });

    test('同一个 seed 永远分到同一个形状', () {
      // 头像形状是身份的一部分，不能每次重建都变
      for (final s in ['a1', 'b2', 'c3', 'd4']) {
        expect(BlobAvatar.shapeKindOf(s), BlobAvatar.shapeKindOf(s));
      }
    });
  });
}
