// 侧边栏会话的右键菜单。
//
// 背景：以前只有「长按 → 底部弹窗」，而且**只给群一个"解散这个群"** ——
// 侧边栏那一列 bot 私聊（恰恰是最想清掉的一堆）根本删不掉，因为服务端
// deleteRoom 也把 dm 挡住了。这个文件把菜单的每一项和隐藏/删除的行为钉住。
//
// 用组件测试而不是截图：合成鼠标事件要跟 DPI/焦点较劲，而且不防回归。
import 'package:flutter/gestures.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pi_bot/app_state.dart';
import 'package:pi_bot/models.dart';
import 'package:pi_bot/scope.dart';
import 'package:pi_bot/screens/rooms_screen.dart';
import 'package:pi_bot/widgets/blob_avatar.dart';
import 'package:pi_bot/widgets/floating_menu.dart';

Room _room(
  String id,
  String name, {
  bool hidden = false,
  List<String> botIds = const [],
}) => Room(
  id: id,
  name: name,
  kind: 'dm',
  // 注意要给可变列表：Room.botIds 是 final 但元素可变，
  // 传 const [] 进去再 add 会抛 UnsupportedError
  botIds: [...botIds],
  hidden: hidden,
);

AppState _stateWith(List<Room> rooms, {List<Bot> bots = const []}) {
  final s = AppState();
  s.rooms = rooms;
  s.bots = bots;
  return s;
}

Future<void> _pump(WidgetTester tester, AppState state) async {
  tester.view.physicalSize = const Size(1200, 900);
  tester.view.devicePixelRatio = 1.0;
  addTearDown(tester.view.reset);
  addTearDown(state.dispose);
  await tester.pumpWidget(
    AppScope(state: state, child: MaterialApp(home: RoomsScreen())),
  );
  await tester.pump();
}

void main() {
  setUp(() => BlobAvatar.animationsEnabled = false);
  tearDown(() => BlobAvatar.animationsEnabled = true);

  testWidgets('右键弹会话菜单，六项都在（含私聊的"删除这个对话"）', (tester) async {
    final state = _stateWith([_room('r1', '甲'), _room('r2', '乙')]);
    await _pump(tester, state);

    await tester.tapAt(
      tester.getCenter(find.text('甲')),
      buttons: kSecondaryButton,
    );
    await tester.pumpAndSettle();

    expect(find.text('置顶'), findsOneWidget);
    expect(find.text('标为未读'), findsOneWidget);
    expect(find.text('重命名 Bot'), findsOneWidget, reason: '私聊改的是 bot 名');
    expect(find.text('复制对话 ID'), findsOneWidget);
    expect(find.text('从侧边栏隐藏'), findsOneWidget);
    // ★ 这一条就是当初缺的：私聊必须能删
    expect(find.text('删除这个对话'), findsOneWidget);
  });

  testWidgets('删除要点确认，点"取消"不会删', (tester) async {
    final state = _stateWith([_room('r1', '甲')]);
    await _pump(tester, state);

    await tester.tapAt(
      tester.getCenter(find.text('甲')),
      buttons: kSecondaryButton,
    );
    await tester.pumpAndSettle();
    await tester.tap(find.text('删除这个对话'));
    await tester.pumpAndSettle();

    // 二次确认弹窗
    expect(find.text('删除和 甲 的对话？'), findsOneWidget);
    await tester.tap(find.text('取消'));
    await tester.pumpAndSettle();

    expect(state.rooms.length, 1, reason: '取消了就不该动数据');
  });

  testWidgets('隐藏的会话不进列表，底部留一个入口能翻出来', (tester) async {
    final state = _stateWith([_room('r1', '甲'), _room('r2', '乙', hidden: true)]);
    await _pump(tester, state);

    expect(find.text('甲'), findsOneWidget);
    expect(find.text('乙'), findsNothing, reason: '隐藏了就不该在列表里');
    expect(find.text('已隐藏 1 个会话'), findsOneWidget, reason: '否则隐藏就是个陷阱');

    await tester.tap(find.text('已隐藏 1 个会话'));
    await tester.pumpAndSettle();
    expect(find.text('取消隐藏'), findsOneWidget);
  });

  group('menuPlacement：菜单别被顶出可视区', () {
    const screen = Size(1180, 760);
    const anchorMid = Offset(140, 380);

    test('空间够就贴着鼠标往下开', () {
      final p = menuPlacement(
        anchor: anchorMid,
        screen: screen,
        entryCount: 6,
      );
      expect(p.top, isNotNull, reason: '往下开用 top 定位');
      expect(p.bottom, isNull);
      expect(p.top, 380 + 10);
    });

    test('★ 靠近窗口上边（右键的那一行在最上面）→ 必须往下开', () {
      // 以前一律往上开：锚点在 y=20，菜单底边在 y=10，前五项全在窗口外
      final p = menuPlacement(
        anchor: const Offset(140, 20),
        screen: screen,
        entryCount: 6,
      );
      expect(p.bottom, isNull, reason: '往上开就会被顶出窗口，看不到');
      expect(p.top, isNotNull);
      expect(p.top! >= 20, isTrue, reason: '顶边要在鼠标下方，不能跑上去');
    });

    test('靠近窗口下边 → 翻上去', () {
      final p = menuPlacement(
        anchor: const Offset(140, 740),
        screen: screen,
        entryCount: 6,
      );
      expect(p.top, isNull);
      expect(p.bottom, isNotNull);
      expect(p.bottom! <= 30, isTrue, reason: '底边应该贴在窗口底部附近');
    });

    test('靠近右边 → 往左推，不能超出屏幕', () {
      final p = menuPlacement(
        anchor: const Offset(1170, 300),
        screen: screen,
        entryCount: 6,
      );
      expect(p.left + 214 <= screen.width, isTrue);
    });

    test('靠近左边 → 不越出 8px 边距', () {
      final p = menuPlacement(
        anchor: const Offset(2, 300),
        screen: screen,
        entryCount: 6,
      );
      expect(p.left, 8);
    });

    test('上下都放不下时挑空间大的一边，而不是硬往上顶', () {
      final p = menuPlacement(
        anchor: const Offset(140, 700),
        screen: const Size(1180, 760),
        entryCount: 6,
      );
      expect(p.bottom, isNotNull, reason: '下边只剩 50px，上边有 690px，该翻上去');
    });
  });

  testWidgets('菜单文字不能被 Flutter 画上"缺 Material"的黄色双下划线', (tester) async {
    // 这个坑很隐蔽：菜单是插进 Overlay 的，而 Overlay 不在 app 的 Material 之下。
    // 没有 Material 祖先时 Flutter 会**故意**给所有 Text 画黄色双下划线提示主题
    // 没接上 —— 表现就是每一项文字下面挂两条杠，而且颜色不受我们控制。
    // 修法是在卡片外面套一层 Material(type: MaterialType.transparency)。
    final state = _stateWith([_room('r1', '甲')]);
    await _pump(tester, state);
    await tester.tapAt(
      tester.getCenter(find.text('甲')),
      buttons: kSecondaryButton,
    );
    await tester.pumpAndSettle();

    for (final label in [
      '置顶',
      '标为未读',
      '重命名 Bot',
      '复制对话 ID',
      '从侧边栏隐藏',
      '删除这个对话',
    ]) {
      final style = DefaultTextStyle.of(tester.element(find.text(label))).style;
      expect(
        style.decorationStyle,
        isNot(TextDecorationStyle.double),
        reason: '$label 中招了：Overlay 里没有 Material 祖先',
      );
      expect(
        style.decoration,
        isNot(TextDecoration.underline),
        reason: '$label 被加了下划线',
      );
    }
  });

  testWidgets('私聊菜单能删掉这个 bot（但要二次确认）', (tester) async {
    // 「删对话」和「删 bot」是两件事：前者清聊天记录（人还在），
    // 后者把人从花名册除名。用户明确要后者也能在菜单里点到。
    final state = _stateWith(
      [_room('r1', '甲', botIds: const ['b1'])],
      bots: [Bot(id: 'b1', name: '甲', role: 'member')],
    );
    await _pump(tester, state);

    await tester.tapAt(
      tester.getCenter(find.text('甲')),
      buttons: kSecondaryButton,
    );
    await tester.pumpAndSettle();

    expect(find.text('删除这个对话'), findsOneWidget);
    expect(find.text('删除这个 Bot'), findsOneWidget);

    await tester.tap(find.text('删除这个 Bot'));
    await tester.pumpAndSettle();
    // 二级确认
    expect(find.text('确认删除'), findsOneWidget);
    expect(find.textContaining('撤不回来'), findsOneWidget,
        reason: '要把后果说清楚：学过的东西和记忆都会没');
    await tester.tap(find.text('取消'));
    await tester.pumpAndSettle();
    expect(state.bots.length, 1, reason: '取消了就不该动数据');
  });

  testWidgets('主控不给删（服务端也挡，界面就别给这个选项）', (tester) async {
    final state = _stateWith(
      [_room('r1', 'Pi', botIds: const ['chief'])],
      bots: [Bot(id: 'chief', name: 'Pi', role: 'main')],
    );
    await _pump(tester, state);

    await tester.tapAt(
      tester.getCenter(find.text('Pi')),
      buttons: kSecondaryButton,
    );
    await tester.pumpAndSettle();
    expect(find.text('删除这个对话'), findsOneWidget);
    expect(find.text('删除这个 Bot'), findsNothing);
  });

  testWidgets('群没有"这一个 bot"可删', (tester) async {
    final state = _stateWith([
      Room(id: 'g1', name: '开发组', kind: 'group', botIds: ['b1']),
    ], bots: [Bot(id: 'b1', name: '甲')]);
    await _pump(tester, state);

    await tester.tapAt(
      tester.getCenter(find.text('开发组')),
      buttons: kSecondaryButton,
    );
    await tester.pumpAndSettle();
    expect(find.text('解散这个群'), findsOneWidget);
    expect(find.text('删除这个 Bot'), findsNothing);
  });
}
