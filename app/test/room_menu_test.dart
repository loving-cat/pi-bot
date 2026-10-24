// 侧边栏会话的右键菜单。
//
// 背景：菜单要能隐藏和删除侧边栏那一列 bot 私聊（恰恰是最想清掉的一堆），
// 服务端 deleteRoom 也不能把 dm 挡住。这个文件把菜单的每一项和隐藏/删除的行为钉住。
//
// 用组件测试而不是截图：合成鼠标事件要跟 DPI/焦点较劲，而且不防回归。
import 'package:flutter/gestures.dart';
import 'package:flutter/material.dart';
import 'package:pi_bot/widgets/avatar_life.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pi_bot/app_state.dart';
import 'package:pi_bot/models.dart';
import 'package:pi_bot/scope.dart';
import 'package:pi_bot/screens/chat_screen.dart';
import 'package:pi_bot/screens/home_shell.dart';
import 'package:pi_bot/screens/rooms_screen.dart';
import 'package:pi_bot/widgets/ask_card.dart';
import 'package:pi_bot/widgets/blob_avatar.dart';
import 'package:pi_bot/widgets/model_picker_field.dart';
import 'package:pi_bot/widgets/room_panel.dart';
import 'package:pi_bot/widgets/md_text.dart';
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
    AppScope(
      state: state,
      child: MaterialApp(home: RoomsScreen()),
    ),
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
    // ★ 私聊必须能删
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
    final state = _stateWith([
      _room('r1', '甲'),
      _room('r2', '乙', hidden: true),
    ]);
    await _pump(tester, state);

    expect(find.text('甲'), findsOneWidget);
    expect(find.text('乙'), findsNothing, reason: '隐藏了就不该在列表里');
    expect(find.text('已隐藏 1 个会话'), findsOneWidget, reason: '否则隐藏就是个陷阱');

    await tester.tap(find.text('已隐藏 1 个会话'));
    await tester.pumpAndSettle();
    expect(find.text('取消隐藏'), findsOneWidget);
  });

  // 回归：菜单是**贴着鼠标**弹的，不能被窗口外层的东西再推开一段。
  //
  // main.dart 的 MaterialApp.builder 在 Navigator 上面加了一条 38px 的标题条，
  // 于是 Overlay 自己的坐标系比窗口全局坐标低 38px。右键事件给的是全局坐标
  // （DragDownDetails.globalPosition），直接交给 Overlay 里的 Positioned 就会
  // 整体下移一条标题条的高度 —— 表现就是“菜单离鼠标特别远”。
  testWidgets('标题条在 Navigator 上方时，菜单依然贴着鼠标', (tester) async {
    tester.view.physicalSize = const Size(1200, 900);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.reset);
    final state = _stateWith([
      for (var i = 0; i < 8; i++) _room('r$i', '房间$i'),
    ]);
    addTearDown(state.dispose);

    await tester.pumpWidget(
      AppScope(
        state: state,
        child: MaterialApp(
          // 和真实 app 一样的层级：标题条压在 Navigator 上面
          builder: (context, child) => Column(
            children: [
              const SizedBox(height: 38),
              Expanded(child: child ?? const SizedBox.shrink()),
            ],
          ),
          home: const RoomsScreen(),
        ),
      ),
    );
    await tester.pump();

    for (final i in [1, 4, 6]) {
      final at =
          tester.getRect(find.text('房间$i')).centerLeft + const Offset(30, 0);
      await tester.tapAt(at, buttons: kSecondaryButton);
      await tester.pumpAndSettle();

      final first = tester.getRect(find.text('置顶'));
      // 卡片顶边 = 鼠标下方 gap(10)，文字再往里一点；上限 40 就不会把
      // 标题条高度（38）叠进去 —— 叠进去时这里会变成 64 左右。
      expect(first.top - at.dy, lessThan(40), reason: '垂直方向贴鼠标下方，不能被标题条再推下去');
      expect(first.left - at.dx, lessThan(80), reason: '水平方向贴鼠标左边缘');

      await tester.tapAt(const Offset(1100, 850));
      await tester.pumpAndSettle();
    }
  });

  group('menuPlacement：菜单别被顶出可视区', () {
    const screen = Size(1180, 760);
    const anchorMid = Offset(140, 380);

    test('空间够就贴着鼠标往下开', () {
      final p = menuPlacement(anchor: anchorMid, screen: screen, entryCount: 6);
      expect(p.top, isNotNull, reason: '往下开用 top 定位');
      expect(p.bottom, isNull);
      expect(p.top, 380 + 10);
    });

    test('★ 靠近窗口上边（右键的那一行在最上面）→ 必须往下开', () {
      // 不能一律往上开：锚点在 y=20 时菜单底边在 y=10，前五项全在窗口外
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
    // 菜单是插进 Overlay 的，而 Overlay 不在 app 的 Material 之下。
    // 没有 Material 祖先时 Flutter 会**故意**给所有 Text 画黄色双下划线提示主题
    // 没接上 —— 表现就是每一项文字下面挂两条杠，颜色也不受本组件控制。
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
    // 后者把人从花名册除名。后者也要能在菜单里点到。
    final state = _stateWith(
      [
        _room('r1', '甲', botIds: const ['b1']),
      ],
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
    expect(
      find.textContaining('撤不回来'),
      findsOneWidget,
      reason: '要把后果说清楚：学过的东西和记忆都会没',
    );
    await tester.tap(find.text('取消'));
    await tester.pumpAndSettle();
    expect(state.bots.length, 1, reason: '取消了就不该动数据');
  });

  testWidgets('主控不给删（服务端也挡，界面就别给这个选项）', (tester) async {
    final state = _stateWith(
      [
        _room('r1', 'Pi', botIds: const ['chief']),
      ],
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
    final state = _stateWith(
      [
        Room(id: 'g1', name: '开发组', kind: 'group', botIds: ['b1']),
      ],
      bots: [Bot(id: 'b1', name: '甲')],
    );
    await _pump(tester, state);

    await tester.tapAt(
      tester.getCenter(find.text('开发组')),
      buttons: kSecondaryButton,
    );
    await tester.pumpAndSettle();
    expect(find.text('解散这个群'), findsOneWidget);
    expect(find.text('删除这个 Bot'), findsNothing);
  });

  testWidgets('@ 提及：只点击跳转，不做悬停卡、不给"可拖"的指针', (tester) async {
    // 悬停卡浮出来会挡住旁边正在读的字，鼠标变手型又看着像"可以拖"，
    // 所以两条都不做，并在这里钉住 —— 这种"多出来的东西"很容易被好心加回去。
    var tapped = '';
    tester.view.physicalSize = const Size(700, 500);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.reset);
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: MdText(
            '@测试工程师 你好',
            mentions: const ['测试工程师'],
            selectable: false,
            onMentionTap: (n) => tapped = n,
          ),
        ),
      ),
    );
    await tester.pump();

    // 指针是普通箭头（不是 click/hand）
    final regions = tester.widgetList<MouseRegion>(find.byType(MouseRegion));
    expect(
      regions.any((m) => m.cursor == SystemMouseCursors.click),
      isFalse,
      reason: '不该给"可拖/可点"的手型暗示',
    );

    // 悬停一会儿，也不该浮出任何卡片（浮层里没有额外文字）
    final gesture = await tester.createGesture(kind: PointerDeviceKind.mouse);
    await gesture.addPointer(location: tester.getCenter(find.byType(MdText)));
    await gesture.moveBy(const Offset(2, 0));
    await tester.pump(const Duration(milliseconds: 500));
    expect(find.textContaining('点一下开私聊'), findsNothing);

    // 点一下要跳
    await tester.tap(find.byType(MdText));
    await tester.pump();
    expect(tapped, '测试工程师');
  });

  testWidgets('宽屏点胶囊 → 右侧多一栏，不是带遮罩的弹层', (tester) async {
    // 要的是跟其他区域同级的侧边栏，而不是有遮罩的二级菜单。
    // 所以这里除了"面板出来了"，还要断言**没有模态遮罩** ——
    // 有遮罩就说明又变成弹层了。
    tester.view.physicalSize = const Size(1400, 900);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.reset);
    final state = _stateWith(
      [
        Room(id: 'g1', name: '开发组', kind: 'group', botIds: ['b1', 'b2']),
      ],
      bots: [
        Bot(id: 'b1', name: '甲'),
        Bot(id: 'b2', name: '乙'),
      ],
    );
    addTearDown(state.dispose);
    await tester.pumpWidget(
      AppScope(
        state: state,
        child: const MaterialApp(home: HomeShell()),
      ),
    );
    await tester.pump();

    expect(find.text('详情'), findsNothing, reason: '默认不开');

    await tester.tap(find.text('开发组').last); // 顶上那个胶囊（body 先于 appBar 建树）
    await tester.pumpAndSettle();

    expect(find.text('详情'), findsOneWidget);
    expect(find.text('成员'), findsOneWidget, reason: '群才有这一页');

    // ★ 关键区别：点面板以外的地方**不该关掉它**。
    //   弹层会（有遮罩、点遮罩就关），侧边栏不会 —— 这是"同级一栏"和
    //   "二级菜单"最本质的差别，比断言某个 ModalBarrier 存在与否可靠得多
    //   （每个路由都带一个 ModalBarrier，拿它当判据会误判）。
    await tester.tapAt(const Offset(500, 500)); // 聊天区
    await tester.pumpAndSettle();
    expect(find.text('详情'), findsOneWidget, reason: '点别处不该关掉它（那是弹层的行为）');
    // 聊天区还在（不是被面板盖住/替换掉）
    expect(find.textContaining('说点什么'), findsWidgets);

    // 成员页能移除 bot（要二次确认）
    await tester.tap(find.text('成员'));
    await tester.pumpAndSettle();
    expect(find.text('甲'), findsWidgets);
    await tester.tap(find.text('移除').first);
    await tester.pumpAndSettle();
    expect(find.textContaining('移出「开发组」'), findsOneWidget);
    await tester.tap(find.text('取消'));
    await tester.pumpAndSettle();
    expect(state.rooms.first.botIds.length, 2, reason: '取消了就不该动数据');

    // 关掉之后那一栏应该消失
    await tester.tap(find.byIcon(LucideIcons.x).first);
    await tester.pumpAndSettle();
    expect(find.text('详情'), findsNothing);
  });

  testWidgets('窄屏（手机）点胶囊才走整页滑入', (tester) async {
    tester.view.physicalSize = const Size(500, 900);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.reset);
    final state = _stateWith(
      [
        Room(id: 'r1', name: '甲', kind: 'dm', botIds: ['b1']),
      ],
      bots: [Bot(id: 'b1', name: '甲')],
    );
    addTearDown(state.dispose);
    await tester.pumpWidget(
      AppScope(
        state: state,
        child: const MaterialApp(home: HomeShell()),
      ),
    );
    await tester.pump();

    // 窄屏初始是会话列表，先进聊天
    await tester.tap(find.text('甲').first);
    await tester.pumpAndSettle();
    await tester.tap(find.text('甲').last);
    await tester.pumpAndSettle();

    expect(find.text('详情'), findsOneWidget);
    expect(find.text('成员'), findsNothing, reason: '私聊没有成员页');
  });

  testWidgets('私聊里气泡上不挂名字（顶上的胶囊已经说清是谁了）', (tester) async {
    tester.view.physicalSize = const Size(1200, 800);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.reset);
    final state = _stateWith(
      [
        Room(id: 'r1', name: '甲', kind: 'dm', botIds: ['b1']),
      ],
      bots: [Bot(id: 'b1', name: '甲')],
    );
    addTearDown(state.dispose);
    state.messages['r1'] = [
      Msg(
        id: 'm1',
        roomId: 'r1',
        authorType: 'bot',
        authorId: 'b1',
        authorName: '甲',
        text: '第一条',
        status: 'done',
        createdAt: DateTime.now().millisecondsSinceEpoch,
      ),
      Msg(
        id: 'm2',
        roomId: 'r1',
        authorType: 'bot',
        authorId: 'b1',
        authorName: '甲',
        text: '第二条',
        status: 'done',
        createdAt: DateTime.now().millisecondsSinceEpoch + 2000,
      ),
    ];
    await tester.pumpWidget(
      AppScope(
        state: state,
        child: MaterialApp(home: ChatScreen(room: state.rooms.first)),
      ),
    );
    await tester.pump();

    // 胶囊里有名字（这是允许的）
    expect(find.text('甲'), findsWidgets);
    // 但气泡区域里不该再挂一份名字：正文两条都在，名字只出现在顶部胶囊
    expect(find.text('第一条'), findsOneWidget);
    expect(find.text('第二条'), findsOneWidget);
    final nameRects = <Rect>[
      for (var i = 0; i < tester.widgetList(find.text('甲')).length; i++)
        tester.getRect(find.text('甲').at(i)),
    ];
    final inBody = nameRects.where((r) => r.top > 100).toList();
    expect(inBody, isEmpty, reason: '正文里不该再出现作者名字（顶部胶囊之外）');
  });

  testWidgets('★ 输入框不会"发完就丢焦点"（没人的时候要自己拿回来）', (tester) async {
    // 发送第一条后，输入框要保持焦点，什么时候都能直接接着输入。
    // 回车提交时框架会先把焦点收走，如果没人接管，就得靠这个兜底拿回来。
    tester.view.physicalSize = const Size(1200, 800);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.reset);
    final state = _stateWith(
      [
        Room(id: 'r1', name: '甲', kind: 'dm', botIds: ['b1']),
      ],
      bots: [Bot(id: 'b1', name: '甲')],
    );
    addTearDown(state.dispose);
    await tester.pumpWidget(
      AppScope(
        state: state,
        child: MaterialApp(home: ChatScreen(room: state.rooms.first)),
      ),
    );
    await tester.pump();
    await tester.pump(); // 让帧后回调跑一轮

    final field = find.byType(TextField);
    expect(field, findsWidgets, reason: '要有输入框');
    // 进来就该是聚焦的（autofocus + 兜底）
    expect(
      tester.widget<TextField>(field.first).focusNode?.hasFocus,
      isTrue,
      reason: '进会话就该能直接打字',
    );

    // 模拟"没人持有焦点"（就是发完消息后的状态），再走一帧
    FocusManager.instance.primaryFocus?.unfocus();
    await tester.pump();
    await tester.pump();
    expect(
      tester.widget<TextField>(field.first).focusNode?.hasFocus,
      isTrue,
      reason: '★ 焦点落在空处时要自己拿回来 —— 用户不该"发一句、再点一下"',
    );
  });

  testWidgets('★ 鼠标进到胶囊里（不在头像上）头像就跟随', (tester) async {
    // 头像要在自己负责的范围跟随鼠标，例如胶囊内的 bot 头像，鼠标挪到胶囊内时跟随。
    // 胶囊里除了头像还有会话名 —— 鼠标落在**名字**上也算"在胶囊里"。
    tester.view.physicalSize = const Size(900, 700);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.reset);
    BlobAvatar.animationsEnabled = true;
    addTearDown(() => BlobAvatar.animationsEnabled = true);
    AvatarLife.pointer.value = null;
    addTearDown(() => AvatarLife.pointer.value = null);

    final state = _stateWith(
      [
        Room(id: 'r1', name: '甲', kind: 'dm', botIds: ['b1']),
      ],
      bots: [Bot(id: 'b1', name: '甲')],
    );
    addTearDown(state.dispose);
    state.messages['r1'] = [];

    await tester.pumpWidget(
      AppScope(
        state: state,
        child: MaterialApp(
          // watchPointer 是真实 App 里把鼠标位置送进来的那层
          home: Scaffold(
            body: AvatarLife.watchPointer(
              child: ChatScreen(room: state.rooms.first),
            ),
          ),
        ),
      ),
    );
    await tester.pump();

    // ★ 只量**胶囊里**那个头像 —— 空会话中间还有一个 64px 的大头像，
    //   find.byType(BlobAvatar).first 会拿到它。
    Offset gazeOf() {
      final cp = tester
          .widgetList<CustomPaint>(
            find.descendant(
              of: find.descendant(
                of: find.byType(AvatarHoverScope),
                matching: find.byType(BlobAvatar),
              ),
              matching: find.byType(CustomPaint),
            ),
          )
          .first;
      return (cp.painter as dynamic).gaze as Offset;
    }

    expect(gazeOf(), Offset.zero);

    final g = await tester.createGesture(kind: PointerDeviceKind.mouse);
    await g.addPointer(location: const Offset(5, 5));
    await tester.pump();
    // 移到胶囊里的**名字**上（不是头像）
    await g.moveTo(
      tester.getCenter(
        find.descendant(
          of: find.byType(AvatarHoverScope),
          matching: find.text('甲'),
        ),
      ),
    );
    await tester.pump();
    await tester.pump();

    expect(
      gazeOf().distance,
      greaterThan(3),
      reason: '★ 鼠标进到胶囊里（哪怕落在名字上）头像就该跟随',
    );
  });

  test('把新成员接在名单后面：去重、不乱序', () {
    expect(mergeMemberIds(const ['a'], const ['b']), const ['a', 'b']);
    expect(mergeMemberIds(const ['a', 'b'], const ['b', 'c']), const [
      'a',
      'b',
      'c',
    ]);
    expect(mergeMemberIds(const ['a'], const []), const ['a']);
    // 已经在里面的不能再加一遍（多选时容易重复点）
    expect(mergeMemberIds(const ['a'], const ['a', 'a']), const ['a']);
  });

  testWidgets('★ 成员面板能自己加 bot：按钮 + 选人对话框', (tester) async {
    // 成员面板要允许用户自己增加 bot，不用再跟主控说。
    tester.view.physicalSize = const Size(1200, 900);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.reset);
    final state = _stateWith(
      [
        Room(
          id: 'g1',
          name: '内容运营组',
          kind: 'group',
          botIds: const ['b1'],
          leadBotId: 'b1',
        ),
      ],
      bots: [
        Bot(id: 'b1', name: '运营总监'),
        Bot(id: 'b2', name: '文案编辑', tagline: '写文案'),
        Bot(id: 'b3', name: '视觉设计', tagline: '配图'),
      ],
    );
    addTearDown(state.dispose);

    await tester.pumpWidget(
      AppScope(
        state: state,
        child: MaterialApp(
          home: Scaffold(body: RoomPanel(room: state.rooms.first)),
        ),
      ),
    );
    await tester.pump();
    // 切到「成员」
    await tester.tap(find.text('成员').first);
    await tester.pumpAndSettle();

    // 按钮上写明还能加几个（花名册里没进来的有 2 个）
    expect(find.text('添加成员'), findsOneWidget, reason: '群成员面板要有入口');

    await tester.tap(find.text('添加成员'));
    await tester.pumpAndSettle();

    // 对话框里只列**还没进来**的（已在群里的运营总监不该出现在列表里）
    Finder inDialog(Finder f) =>
        find.descendant(of: find.byType(AlertDialog), matching: f);
    expect(find.text('往「内容运营组」里加谁'), findsOneWidget);
    expect(inDialog(find.text('文案编辑')), findsOneWidget);
    expect(inDialog(find.text('视觉设计')), findsOneWidget);
    expect(
      inDialog(find.text('运营总监')),
      findsNothing,
      reason: '已经在群里的不该再列（面板后面的成员行不算）',
    );

    // 没选人时"添加"是禁用的
    final btn = tester.widget<FilledButton>(
      find.ancestor(of: find.text('添加'), matching: find.byType(FilledButton)),
    );
    expect(btn.onPressed, isNull, reason: '一个都没选时不能点添加');

    // 勾两个 → 按钮变成"添加 2 个"
    await tester.tap(find.text('文案编辑'));
    await tester.pump();
    await tester.tap(find.text('视觉设计'));
    await tester.pump();
    expect(find.text('添加 2 个'), findsOneWidget);
  });

  testWidgets('私聊没有「成员」页（一个私聊就一个人）', (tester) async {
    tester.view.physicalSize = const Size(1200, 900);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.reset);
    final state = _stateWith(
      [
        Room(id: 'r1', name: '甲', kind: 'dm', botIds: const ['b1']),
      ],
      bots: [
        Bot(id: 'b1', name: '甲'),
        Bot(id: 'b2', name: '乙'),
      ],
    );
    addTearDown(state.dispose);
    await tester.pumpWidget(
      AppScope(
        state: state,
        child: MaterialApp(
          home: Scaffold(body: RoomPanel(room: state.rooms.first)),
        ),
      ),
    );
    await tester.pump();
    // 第三个页签只有群才有 —— 私聊里想加人，就是"新建一个群"
    expect(find.text('详情'), findsOneWidget);
    expect(find.text('资料库'), findsOneWidget);
    expect(find.text('成员'), findsNothing);
  });

  testWidgets('★ 发完第一条、bot 正在回 —— 第二条还能点能打', (tester) async {
    // 发完第一条想接着输入第二条时，输入框要保持可点击、可输入。
    // 这是**空房间 → 有消息**那一下的结构切换（空态换成消息栈），
    // 而且 bot 正在流式回复（消息上会挂一条"已打断它"的提示）。
    tester.view.physicalSize = const Size(900, 700);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.reset);
    final state = _stateWith(
      [
        Room(id: 'r1', name: '甲', kind: 'dm', botIds: const ['b1']),
      ],
      bots: [Bot(id: 'b1', name: '甲')],
    );
    addTearDown(state.dispose);
    state.messages['r1'] = [];
    state.typing['r1'] = false;

    await tester.pumpWidget(
      AppScope(
        state: state,
        child: MaterialApp(home: ChatScreen(room: state.rooms.first)),
      ),
    );
    await tester.pump();

    final field = find.byType(TextField);
    expect(field, findsOneWidget);

    // ① 空房间先打一条
    await tester.enterText(field, '第一条');
    await tester.pump();
    expect(find.text('第一条'), findsOneWidget);

    // ② 等价于"发出去了"：消息进列表 + bot 开始流式回 + typing 亮起
    state.messages['r1'] = [
      Msg(
        id: 'm1',
        roomId: 'r1',
        authorType: 'user',
        authorName: '我',
        text: '第一条',
        status: 'done',
        createdAt: 1,
      ),
      Msg(
        id: 'm2',
        roomId: 'r1',
        authorType: 'bot',
        authorId: 'b1',
        authorName: '甲',
        text: '收到',
        status: 'streaming',
        createdAt: 2,
      ),
    ];
    state.typing['r1'] = true;
    state.notifyListeners();
    await tester.pump();
    await tester.pump();

    // ③ 点一下输入框 —— 必须能命中、能聚焦
    await tester.tap(field);
    await tester.pump();
    final node = tester.widget<TextField>(field).focusNode;
    expect(node?.hasFocus, isTrue, reason: '★ 点一下就该聚焦到输入框');

    // ④ 再打一条
    await tester.enterText(field, '第二条');
    await tester.pump();
    expect(
      tester.widget<TextField>(field).controller?.text,
      '第二条',
      reason: '★ 第二条必须能打进去',
    );
  });

  testWidgets('★ 在已聚焦的输入框上再点一下 —— 会把输入连接重开一次', (tester) async {
    // 有一种状态是：Dart 侧 hasFocus=true，但引擎那边的文本输入连接断了，
    // 键盘事件到不了 Dart。这时"再点一下"本来没有状态变化（已经聚焦了），
    // 引擎不会重连，点击也没用。
    // 点一下走一次真正的 unfocus → 下一帧 requestFocus 才能重开连接。
    tester.view.physicalSize = const Size(900, 700);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.reset);
    final state = _stateWith(
      [
        Room(id: 'r1', name: '甲', kind: 'dm', botIds: const ['b1']),
      ],
      bots: [Bot(id: 'b1', name: '甲')],
    );
    addTearDown(state.dispose);
    state.messages['r1'] = [
      Msg(
        id: 'm1',
        roomId: 'r1',
        authorType: 'user',
        authorName: '我',
        text: '第一条',
        status: 'done',
        createdAt: 1,
      ),
    ];

    await tester.pumpWidget(
      AppScope(
        state: state,
        child: MaterialApp(home: ChatScreen(room: state.rooms.first)),
      ),
    );
    await tester.pump();

    final field = find.byType(TextField);
    await tester.tap(field);
    await tester.pump();
    final node = tester.widget<TextField>(field).focusNode!;
    expect(node.hasFocus, isTrue, reason: '第一下点要聚焦');

    var dropped = false;
    node.addListener(() {
      if (!node.hasFocus) dropped = true;
    });

    // 再点一下（同一点、没拖动）
    await tester.tap(field);
    await tester.pump();
    await tester.pump();

    expect(dropped, isTrue, reason: '★ 再点一下必须真的重开一次连接（先放下再拿起）');
    expect(node.hasFocus, isTrue, reason: '重开完还得聚焦着，别把用户晾在那儿');
  });

  testWidgets('★★ 发出第一条之后，输入框**不能被重建**（重建＝打字就没反应）', (tester) async {
    // 关键：发出第一条后输入框不能被重建 —— 否则想接着输入第二条时会没焦点，
    // 点击也不行，直接没法输入。
    //
    // 失效链条：
    //   发出去的一瞬间 → 消息上多出"已打断它"那条提示（busy 变了）
    //   → Column 凭空多一个孩子 → Flutter 按位置配对错位
    //   → 整个输入行被**重建** → 新的 EditableText 拿着一个**已经聚焦**的
    //     FocusNode 初始化 → 它永远不会打开文本输入连接
    //   → 表现：光标在闪、打字没反应；而且"再点一下"也没用，
    //     因为焦点本来就在它身上、没有状态变化，引擎不会重连。
    //
    // 修法是给 composer 的几个孩子加 key（Flutter 按 key 配对，
    // 插入新兄弟不会挤掉别人）。所以这条测试盯的就是"EditableText 还是不是同一个"。
    tester.view.physicalSize = const Size(900, 700);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.reset);
    final state = _stateWith(
      [
        Room(id: 'r1', name: '甲', kind: 'dm', botIds: const ['b1']),
      ],
      bots: [Bot(id: 'b1', name: '甲')],
    );
    addTearDown(state.dispose);
    state.messages['r1'] = [];
    state.typing['r1'] = false;

    await tester.pumpWidget(
      AppScope(
        state: state,
        child: MaterialApp(home: ChatScreen(room: state.rooms.first)),
      ),
    );
    await tester.pump();

    final field = find.byType(TextField);
    await tester.tap(field);
    await tester.pump();
    final node = tester.widget<TextField>(field).focusNode!;
    final before = tester.state(find.byType(EditableText));

    // 等价于"发出去了"：typing 亮起（composer 上方会多一条提示）+ 消息进列表
    state.typing['r1'] = true;
    state.messages['r1'] = [
      Msg(
        id: 'm1',
        roomId: 'r1',
        authorType: 'user',
        authorName: '我',
        text: '第一条',
        status: 'done',
        createdAt: 1,
      ),
    ];
    state.notifyListeners();
    await tester.pump();
    await tester.pump();

    final after = tester.state(find.byType(EditableText));
    expect(
      identical(before, after),
      isTrue,
      reason:
          '★ 输入框被重建 = 新的 EditableText 带着已聚焦的 FocusNode 初始化 → '
          '文本输入连接不会重新打开 → 打字没反应，点一下也没用',
    );
    expect(node.hasFocus, isTrue, reason: '焦点还得在输入框上');

    // 而且真的还能接着打
    await tester.enterText(field, '第二条');
    await tester.pump();
    expect(tester.widget<TextField>(field).controller?.text, '第二条');

    // busy 退掉也不能把它弄丢（提示消失也是同一种结构变化）
    state.typing['r1'] = false;
    state.notifyListeners();
    await tester.pump();
    await tester.pump();
    expect(
      identical(tester.state(find.byType(EditableText)), after),
      isTrue,
      reason: '提示消失时同样不能重建输入框',
    );
  });

  testWidgets('★ 连着插三句，只挂**一个**"它下一步会看到"', (tester) async {
    // 闪电那行"下一步会看到"只挂一条，不需要每句话都有。
    tester.view.physicalSize = const Size(900, 700);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.reset);
    final state = _stateWith(
      [
        Room(id: 'r1', name: '甲', kind: 'dm', botIds: const ['b1']),
      ],
      bots: [Bot(id: 'b1', name: '甲')],
    );
    addTearDown(state.dispose);
    Msg queued(int i) => Msg(
      id: 'm$i',
      roomId: 'r1',
      authorType: 'user',
      authorName: '我',
      text: '第$i句',
      status: 'done',
      meta: {'queued': 'steer'},
      createdAt: i,
    );
    state.messages['r1'] = [queued(1), queued(2), queued(3)];
    state.typing['r1'] = true;

    await tester.pumpWidget(
      AppScope(
        state: state,
        child: MaterialApp(home: ChatScreen(room: state.rooms.first)),
      ),
    );
    await tester.pump();
    await tester.pump();

    expect(
      find.text('已打断它，按这条重新开始'),
      findsOneWidget,
      reason: '★ 三句排队只该挂一个提示（挂在最后一条上）',
    );
  });

  testWidgets('★ 询问卡片要有入场动效（不是直接出现）', (tester) async {
    // 询问卡片要有入场动效，没有动画就没有触发的感觉。
    tester.view.physicalSize = const Size(900, 700);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.reset);
    final state = _stateWith(
      [
        Room(id: 'r1', name: '甲', kind: 'dm', botIds: const ['b1']),
      ],
      bots: [Bot(id: 'b1', name: '甲')],
    );
    addTearDown(state.dispose);
    state.messages['r1'] = [
      Msg(
        id: 'a1',
        roomId: 'r1',
        authorType: 'bot',
        authorId: 'b1',
        authorName: '甲',
        text: '选一个',
        status: 'done',
        kind: 'ask',
        meta: {
          'options': [
            {'label': '行情看板', 'detail': '自选股、大盘'},
            {'label': '盯盘提醒', 'detail': '异动推给你'},
          ],
          'allowCustom': true,
        },
        createdAt: 1,
      ),
    ];

    await tester.pumpWidget(
      AppScope(
        state: state,
        child: MaterialApp(home: ChatScreen(room: state.rooms.first)),
      ),
    );
    // 第一帧：卡片应该还是"没到位"的状态
    await tester.pump();
    final fades = tester
        .widgetList<FadeTransition>(
          find.descendant(
            of: find.byType(AskCard),
            matching: find.byType(FadeTransition),
          ),
        )
        .toList();
    expect(fades, isNotEmpty, reason: '卡片里应该有 FadeTransition');
    final firstOpacity = fades.first.opacity.value;
    expect(firstOpacity, lessThan(1.0), reason: '★ 第一帧不该是"已经全部到位"（那就是没有动画）');

    await tester.pumpAndSettle();
    expect(find.text('行情看板'), findsOneWidget);
    expect(find.text('盯盘提醒'), findsOneWidget);
    expect(find.text('或者我自己说一句…'), findsOneWidget);
    // 走完动画后所有元素都到位
    final done = tester
        .widgetList<FadeTransition>(
          find.descendant(
            of: find.byType(AskCard),
            matching: find.byType(FadeTransition),
          ),
        )
        .map((f) => f.opacity.value)
        .toList();
    expect(
      done.every((v) => v > 0.99),
      isTrue,
      reason: '动画结束后每一条都该完全不透明：$done',
    );
  });

  testWidgets('★ 面板「详情」里能就地改运行参数（模型 / 思考等级 / 上下文预算）', (tester) async {
    // 胶囊点击后的右侧侧边栏要能调模型、上下文窗口、思考等级，
    // 而不是只能跑去 bot 花名册里改。
    tester.view.physicalSize = const Size(1200, 900);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.reset);
    final state = _stateWith(
      [
        Room(id: 'r1', name: '甲', kind: 'dm', botIds: const ['b1']),
      ],
      bots: [Bot(id: 'b1', name: '甲', model: 'grp1/flash', thinking: 'medium')],
    );
    addTearDown(state.dispose);

    await tester.pumpWidget(
      AppScope(
        state: state,
        child: MaterialApp(
          home: Scaffold(body: RoomPanel(room: state.rooms.first)),
        ),
      ),
    );
    await tester.pump();

    // 详情是默认页
    expect(find.text('运行参数'), findsOneWidget, reason: '面板详情里要有运行参数');
    expect(find.text('思考等级'), findsOneWidget);
    expect(find.text('上下文预算'), findsOneWidget);
    expect(find.text('保存模型'), findsOneWidget);
    expect(find.text('保存预算'), findsOneWidget);

    // 模型输入框里是当前模型
    final field = tester.widget<TextField>(
      find.descendant(
        of: find.byType(ModelPickerField),
        matching: find.byType(TextField),
      ),
    );
    expect(field.controller?.text, 'grp1/flash');

    // 五个思考等级都在，且当前那个是选中的
    for (final lv in ['off', 'low', 'medium', 'high', 'max']) {
      expect(find.widgetWithText(ChoiceChip, lv), findsOneWidget);
    }
    final medium = tester.widget<ChoiceChip>(
      find.widgetWithText(ChoiceChip, 'medium'),
    );
    expect(medium.selected, isTrue, reason: '当前等级要选中');
  });

  testWidgets('★ 「消息来自 X」：转进来的消息才挂，自己人说的不挂', (tester) async {
    // 转进来的消息要有一行"消息来自 X"，点开是只读窥视。
    tester.view.physicalSize = const Size(900, 800);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.reset);
    final state = _stateWith(
      [
        Room(id: 'g1', name: '研发组', kind: 'group', botIds: const ['b1']),
      ],
      bots: [
        Bot(id: 'b1', name: '组员甲'),
        Bot(id: 'b2', name: '评分汇总官'),
      ],
    );
    addTearDown(state.dispose);
    state.messages['g1'] = [
      Msg(
        id: 'm1',
        roomId: 'g1',
        authorType: 'bot',
        authorId: 'b1', // 自己人 → 不该挂
        authorName: '组员甲',
        text: '我自己说的',
        status: 'done',
        createdAt: 1,
      ),
      Msg(
        id: 'm2',
        roomId: 'g1',
        authorType: 'bot',
        authorId: 'b2', // 不在这个会话名单里 → 转进来的
        authorName: '评分汇总官',
        text: '转进来的报告',
        status: 'done',
        createdAt: 2,
      ),
    ];

    await tester.pumpWidget(
      AppScope(
        state: state,
        child: MaterialApp(home: ChatScreen(room: state.rooms.first)),
      ),
    );
    await tester.pump();
    await tester.pump();

    expect(
      find.text('消息来自'),
      findsOneWidget,
      reason: '★ 只有转进来的那条该挂标记（自己人说的不该挂）',
    );
    expect(find.text('评分汇总官'), findsWidgets, reason: '标记里要写是谁说的');
  });
}
