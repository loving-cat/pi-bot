import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pi_bot/widgets/avatar_character.dart';
import 'package:pi_bot/widgets/avatar_character_painter.dart';
import 'package:pi_bot/widgets/avatar_life.dart';
import 'package:pi_bot/widgets/blob_avatar.dart';

Widget _host(Widget child) => MaterialApp(
  home: Scaffold(body: Center(child: child)),
);

Finder _avatar(String seed) => find.byWidgetPredicate(
  (widget) => widget is BlobAvatar && widget.seed == seed,
);

AvatarCharacterPainter _paint(WidgetTester tester, Finder avatar) =>
    tester
            .widget<CustomPaint>(
              find.descendant(
                of: avatar,
                matching: find.byWidgetPredicate(
                  (widget) =>
                      widget is CustomPaint &&
                      widget.painter is AvatarCharacterPainter,
                ),
              ),
            )
            .painter!
        as AvatarCharacterPainter;

Future<void> _frames(WidgetTester tester, [int count = 60]) async {
  for (var i = 0; i < count; i++) {
    await tester.pump(const Duration(milliseconds: 16));
  }
}

Future<void> _unmount(WidgetTester tester) async {
  await tester.pumpWidget(const SizedBox.shrink());
  await tester.pump();
  expect(tester.takeException(), isNull);
}

int _tickerCount(State state) {
  final property = state
      .toDiagnosticsNode()
      .getProperties()
      .where((property) => property.name == 'tickers')
      .firstOrNull;
  return (property?.value as Set?)?.length ?? 0;
}

void main() {
  setUp(() {
    BlobAvatar.animationsEnabled = true;
    AvatarLife.pointer.value = null;
  });
  tearDown(() {
    AvatarLife.pointer.value = null;
    BlobAvatar.animationsEnabled = true;
  });

  testWidgets('复用同一个头像元素时，换成员会更新造型身份', (tester) async {
    const initial = 'identity-0';
    final initialKind = AvatarCharacter.fromSeed(initial).kind;
    final next = List.generate(
      100,
      (i) => 'identity-${i + 1}',
    ).firstWhere((seed) => AvatarCharacter.fromSeed(seed).kind != initialKind);
    Widget scene(String seed) => _host(
      BlobAvatar(
        key: const ValueKey('same-avatar-slot'),
        seed: seed,
        color: Colors.teal,
        animate: false,
      ),
    );
    await tester.pumpWidget(scene(initial));
    final state = tester.state(_avatar(initial));
    await tester.pumpWidget(scene(next));
    expect(tester.state(_avatar(next)), same(state));
    expect(
      _paint(tester, _avatar(next)).character.kind,
      AvatarCharacter.fromSeed(next).kind,
    );
    await _unmount(tester);
  });

  testWidgets('静态头像能启用动画，再关闭时停止安排动画帧', (tester) async {
    Widget scene(bool animate) => _host(
      BlobAvatar(
        seed: 'mode-member',
        color: Colors.teal,
        animate: animate,
        followPointer: false,
      ),
    );
    await tester.pumpWidget(scene(false));
    expect(tester.binding.transientCallbackCount, 0);
    await tester.pumpWidget(scene(true));
    await tester.pump(const Duration(milliseconds: 120));
    expect(_paint(tester, _avatar('mode-member')).phase, greaterThan(0));
    await tester.pumpWidget(scene(false));
    await tester.pump(const Duration(milliseconds: 400));
    expect(tester.binding.transientCallbackCount, 0);
    final phase = _paint(tester, _avatar('mode-member')).phase;
    await tester.pump(const Duration(seconds: 1));
    expect(_paint(tester, _avatar('mode-member')).phase, phase);
    await _unmount(tester);
  });

  testWidgets('忙碌结束后重新进入休眠，停止形变与自发动作', (tester) async {
    Widget scene(AvatarMood mood) => _host(
      BlobAvatar(
        seed: 'busy-transition',
        color: Colors.orange,
        animate: true,
        followPointer: false,
        mood: mood,
      ),
    );
    await tester.pumpWidget(scene(AvatarMood.busy));
    await tester.pump(const Duration(milliseconds: 200));
    expect(tester.binding.transientCallbackCount, greaterThan(0));
    await tester.pumpWidget(scene(AvatarMood.idle));
    await tester.pumpAndSettle(
      const Duration(milliseconds: 100),
      EnginePhase.sendSemanticsUpdate,
      const Duration(seconds: 20),
    );
    expect(tester.binding.transientCallbackCount, 0);
    final resting = _paint(tester, _avatar('busy-transition'));
    await tester.pump(const Duration(seconds: 8));
    expect(tester.binding.transientCallbackCount, 0);
    expect(_paint(tester, _avatar('busy-transition')).phase, resting.phase);
    expect(_paint(tester, _avatar('busy-transition')).gaze, resting.gaze);
    await _unmount(tester);
  });

  testWidgets('跟随开关在持续悬停时立即生效，关闭后回正且不再接收指针', (tester) async {
    Widget scene(bool follow) => _host(
      BlobAvatar(
        seed: 'follow-switch',
        color: Colors.blue,
        animate: false,
        hovered: true,
        followPointer: follow,
      ),
    );
    await tester.pumpWidget(scene(true));
    final center = tester.getCenter(_avatar('follow-switch'));
    AvatarLife.pointer.value = center + const Offset(200, 0);
    await _frames(tester);
    expect(_paint(tester, _avatar('follow-switch')).gaze.dx, greaterThan(1));
    await tester.pumpWidget(scene(false));
    await _frames(tester);
    expect(
      _paint(tester, _avatar('follow-switch')).gaze.distance,
      lessThan(0.5),
    );
    AvatarLife.pointer.value = center - const Offset(200, 0);
    await _frames(tester);
    expect(
      _paint(tester, _avatar('follow-switch')).gaze.distance,
      lessThan(0.5),
    );
    await tester.pumpWidget(scene(true));
    await _frames(tester);
    expect(_paint(tester, _avatar('follow-switch')).gaze.dx, lessThan(-1));
    await _unmount(tester);
  });

  testWidgets('持续跟随时缩小头像会重新约束视线幅度', (tester) async {
    Widget scene(double size) => _host(
      BlobAvatar(
        seed: 'resized-member',
        color: Colors.green,
        animate: false,
        hovered: true,
        size: size,
      ),
    );
    await tester.pumpWidget(scene(96));
    AvatarLife.pointer.value =
        tester.getCenter(_avatar('resized-member')) + const Offset(200, 0);
    await _frames(tester);
    expect(
      _paint(tester, _avatar('resized-member')).gaze.distance,
      greaterThan(10),
    );
    await tester.pumpWidget(scene(16));
    await _frames(tester);
    expect(
      _paint(tester, _avatar('resized-member')).gaze.distance,
      lessThanOrEqualTo(16 * 0.16 + 0.01),
    );
    await _unmount(tester);
  });

  testWidgets('多次视线移动复用同一ticker，到站后不保留活动帧', (tester) async {
    await tester.pumpWidget(
      _host(
        const BlobAvatar(
          seed: 'ticker-member',
          color: Colors.purple,
          animate: false,
          hovered: true,
        ),
      ),
    );
    final finder = _avatar('ticker-member');
    final state = tester.state(finder);
    final center = tester.getCenter(finder);
    for (var i = 0; i < 12; i++) {
      AvatarLife.pointer.value = center + Offset(i.isEven ? 200 : -200, 30);
      await _frames(tester, 80);
      expect(tester.binding.transientCallbackCount, 0);
      expect(_tickerCount(state), 1, reason: '到站后保留可复用ticker，不累计旧ticker');
    }
    await _unmount(tester);
    expect(_tickerCount(state), 0);
  });

  testWidgets('动画与指针跟随中移除头像不会遗留ticker或定时回调', (tester) async {
    await tester.pumpWidget(
      _host(
        const BlobAvatar(
          seed: 'dispose-member',
          color: Colors.indigo,
          mood: AvatarMood.busy,
          hovered: true,
          interactive: true,
        ),
      ),
    );
    AvatarLife.pointer.value =
        tester.getCenter(_avatar('dispose-member')) + const Offset(200, 0);
    await tester.pump(const Duration(milliseconds: 16));
    await tester.tap(_avatar('dispose-member'));
    await _unmount(tester);
    AvatarLife.pointer.value = const Offset(500, 100);
    await tester.pump(const Duration(seconds: 12));
    expect(tester.binding.transientCallbackCount, 0);
    expect(tester.takeException(), isNull);
  });

  testWidgets('空群、单人、双人和四人群头像布局有界且不跟随指针', (tester) async {
    for (final seeds in <List<String>>[
      [],
      ['a'],
      ['a', 'b'],
      ['a', 'b', 'c', 'd'],
    ]) {
      await tester.pumpWidget(
        _host(GroupBlobAvatar(seeds: seeds, size: 46, animate: false)),
      );
      final group = tester.getRect(find.byType(GroupBlobAvatar));
      final children = tester.widgetList<BlobAvatar>(find.byType(BlobAvatar));
      expect(children.length, seeds.isEmpty ? 1 : seeds.length);
      for (final child in children) {
        expect(child.followPointer, isFalse);
        final rect = tester.getRect(_avatar(child.seed));
        expect(rect.left, greaterThanOrEqualTo(group.left - 0.01));
        expect(rect.top, greaterThanOrEqualTo(group.top - 0.01));
        expect(rect.right, lessThanOrEqualTo(group.right + 0.01));
        expect(rect.bottom, lessThanOrEqualTo(group.bottom + 0.01));
        if (children.length == 1) {
          expect((rect.center - group.center).distance, lessThan(0.01));
        }
      }
    }
    await _unmount(tester);
  });

  testWidgets('群成员去重、最多四人，重排时保留对应成员状态和造型', (tester) async {
    Widget scene(List<String> seeds) =>
        _host(GroupBlobAvatar(seeds: seeds, size: 96, animate: false));
    await tester.pumpWidget(scene(['a', 'a', 'b', 'c', 'd', 'e']));
    expect(
      tester.widgetList<BlobAvatar>(find.byType(BlobAvatar)).map((w) => w.seed),
      ['a', 'b', 'c', 'd'],
    );
    final states = {
      for (final seed in ['a', 'b', 'c', 'd'])
        seed: tester.state(_avatar(seed)),
    };
    await tester.pumpWidget(scene(['d', 'b', 'a', 'c']));
    for (final seed in states.keys) {
      expect(tester.state(_avatar(seed)), same(states[seed]));
      expect(
        _paint(tester, _avatar(seed)).character.kind,
        AvatarCharacter.fromSeed(seed).kind,
      );
    }
    await _unmount(tester);
  });

  testWidgets('主控角标按尺寸显示，显式badge优先且身份环可切换', (tester) async {
    Widget scene(double size, bool ring, {Widget? badge}) => _host(
      BlobAvatar(
        seed: 'chief-badge',
        color: Colors.teal,
        emoji: 'X',
        animate: false,
        size: size,
        ring: ring,
        badge: badge,
      ),
    );
    await tester.pumpWidget(scene(22, true));
    expect(find.text('X'), findsNothing);
    await tester.pumpWidget(scene(46, true));
    expect(find.text('X'), findsOneWidget);
    expect(_paint(tester, _avatar('chief-badge')).ring, isTrue);
    await tester.pumpWidget(scene(46, false));
    expect(find.text('X'), findsNothing);
    expect(_paint(tester, _avatar('chief-badge')).ring, isFalse);
    await tester.pumpWidget(scene(46, true, badge: const Icon(Icons.star)));
    expect(find.byIcon(Icons.star), findsOneWidget);
    expect(find.text('X'), findsNothing);
    await _unmount(tester);
  });

  testWidgets('默认头像不吞掉整行点击，区域悬停仍能驱动视线', (tester) async {
    var taps = 0;
    await tester.pumpWidget(
      _host(
        SizedBox(
          width: 300,
          child: AvatarHoverScope(
            forceHovered: true,
            child: GestureDetector(
              behavior: HitTestBehavior.opaque,
              onTap: () => taps++,
              child: const Row(
                children: [
                  BlobAvatar(
                    seed: 'row-member',
                    color: Colors.blue,
                    animate: false,
                  ),
                  SizedBox(width: 12),
                  Text('打开会话'),
                ],
              ),
            ),
          ),
        ),
      ),
    );
    AvatarLife.pointer.value = tester.getCenter(find.text('打开会话'));
    await _frames(tester);
    expect(_paint(tester, _avatar('row-member')).gaze.dx, greaterThan(0));
    await tester.tap(_avatar('row-member'));
    await tester.tap(find.text('打开会话'));
    expect(taps, 2);
    await _unmount(tester);
  });
}
