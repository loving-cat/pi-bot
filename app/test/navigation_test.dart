// 「跳到某个会话」的回归测试。
//
// 背景：点 @提及 以前走的是 `state.openRoom(id)` —— 它只记一个字段、不发通知；
// 而宽屏分栏的选中项是 HomeShell 自己的 `_selectedId`，压根不看那个字段。
// 结果就是点了 @ 什么都不发生（用户报的 bug）。窄屏同样跳不动。
//
// 这个坑很隐蔽：回调确实执行了、函数没报错、只是界面不动。所以两种布局都钉住。
import 'package:flutter/gestures.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pi_bot/app_state.dart';
import 'package:pi_bot/models.dart';
import 'package:pi_bot/scope.dart';
import 'package:pi_bot/screens/chat_screen.dart';
import 'package:pi_bot/screens/home_shell.dart';
import 'package:pi_bot/screens/rooms_screen.dart';
import 'package:pi_bot/widgets/avatar_life.dart';
import 'package:pi_bot/widgets/blob_avatar.dart';

Room _room(String id, String name) =>
    Room(id: id, name: name, kind: 'dm', botIds: const []);

AppState _stateWith(List<Room> rooms, {List<Bot> bots = const []}) {
  final s = AppState();
  s.rooms = rooms;
  s.bots = bots;
  return s;
}

void main() {
  // blob 的眨眼是定时器 + 无限循环动画：测试结束时挂着定时器会直接判失败
  setUp(() => BlobAvatar.animationsEnabled = false);
  tearDown(() => BlobAvatar.animationsEnabled = true);

  test('requestRoom 是一次性的：取走即清空', () {
    final s = _stateWith([_room('r1', '甲')]);
    expect(s.takePendingRoom(), isNull, reason: '一开始没有待处理的请求');
    s.requestRoom('r2');
    expect(s.takePendingRoom(), 'r2');
    expect(s.takePendingRoom(), isNull, reason: '不该被消费两次（否则会反复跳）');
    s.dispose();
  });

  testWidgets('宽屏分栏：requestRoom 会把左侧选中项切过去', (tester) async {
    tester.view.physicalSize = const Size(1400, 900);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.reset);

    final state = _stateWith([_room('r1', '甲'), _room('r2', '乙')]);
    addTearDown(state.dispose);

    await tester.pumpWidget(
      AppScope(state: state, child: const MaterialApp(home: HomeShell())),
    );
    await tester.pump();

    // 没指定就默认选第一个
    expect(tester.widget<ChatScreen>(find.byType(ChatScreen)).room.id, 'r1');

    state.requestRoom('r2');
    await tester.pump();

    // ★ 这一条就是 bug 的回归点：以前这里还是 r1
    expect(tester.widget<ChatScreen>(find.byType(ChatScreen)).room.id, 'r2');
  });

  testWidgets('窄屏单页：requestRoom 会 push 出新会话页', (tester) async {
    tester.view.physicalSize = const Size(500, 900);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.reset);

    final state = _stateWith([_room('r1', '甲'), _room('r2', '乙')]);
    addTearDown(state.dispose);

    await tester.pumpWidget(
      AppScope(state: state, child: const MaterialApp(home: HomeShell())),
    );
    await tester.pump();

    // 窄屏初始是会话列表，没有聊天页
    expect(find.byType(ChatScreen), findsNothing);

    state.requestRoom('r2');
    await tester.pump(); // 让 HomeShell 消费请求（它用 postFrame 再 push）
    await tester.pumpAndSettle();

    expect(tester.widget<ChatScreen>(find.byType(ChatScreen)).room.id, 'r2');
  });

  testWidgets('★ 先把左栏拖宽、再把窗口缩小 —— 布局不能崩', (tester) async {
    // 用户报的"偶发会整个布局混乱"。原因：两栏宽度**只在拖动分隔条时**被
    // 夹进合法范围 —— 于是"先拖宽、再缩小窗口"时，固定宽度会超过窗口总宽，
    // Expanded 拿到负空间，整个布局崩坏，而且**一直保持**（不拖回去恢复不了）。
    // 现在改成渲染前按可用宽度夹一次。
    tester.view.physicalSize = const Size(1400, 900);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.reset);
    final state = _stateWith([_room('r1', '甲'), _room('r2', '乙')]);
    addTearDown(state.dispose);
    await tester.pumpWidget(
      AppScope(state: state, child: const MaterialApp(home: HomeShell())),
    );
    await tester.pump();

    // 抓住左边那条分隔条，往右拖 300px（想把它拖到 480 的上限）
    final handle = find
        .byWidgetPredicate(
          (w) => w is MouseRegion && w.cursor == SystemMouseCursors.resizeLeftRight,
        )
        .first;
    await tester.drag(handle, const Offset(300, 0));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 300));
    expect(tester.takeException(), isNull);

    // 再把右侧面板打开（点顶部胶囊）—— 左栏 480 + 面板 340 = 820，
    // 这时候窗口一缩就必然超宽
    await tester.tap(find.text('甲').last);
    await tester.pumpAndSettle();

    // 缩小到 800 逻辑宽（仍在分栏阈值 760 之上）：
    // 480 + 6 + 6 + 340 = 832 > 800 → 不夹的话必然溢出
    tester.view.physicalSize = const Size(800, 700);
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 300));

    // ★ 关键断言：不能出现布局溢出
    expect(
      tester.takeException(),
      isNull,
      reason: '缩窗口后固定宽度超了总宽 → 会报 RenderFlex overflow（布局崩坏）',
    );

    // 而且缩回去之后左栏不该还赖着 480
    final sidebar = tester.getSize(find.byType(RoomsScreen).first);
    expect(sidebar.width, lessThan(560), reason: '左栏要按可用宽度让出来（不能还赖着 480）');
  });

  testWidgets('★ 鼠标进到会话行上（不在头像里）就立刻跟随，不用再动一下', (tester) async {
    // 这条是踩了三轮才找到的：眼睛偏移只在**鼠标移动**时才算，而"鼠标进入
    // 这一行"那一下不算移动事件 → 必须再动一下才跟随。用户鼠标停在行上不动时
    // 眼睛就是呆的，表现成"只有鼠标在头像里面时（本来就在动）才跟随"。
    //
    // 所以这条测试必须走**完整链路**：真实鼠标事件 → watchPointer → 指针通知
    // → 头像 → painter 的 gaze。以前只验到"hovered 变 true"，验不到这一层。
    tester.view.physicalSize = const Size(400, 700);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.reset);
    BlobAvatar.animationsEnabled = true;
    addTearDown(() => BlobAvatar.animationsEnabled = true);
    AvatarLife.pointer.value = null;
    addTearDown(() => AvatarLife.pointer.value = null);

    final state = _stateWith([
      Room(id: 'r1', name: '甲', kind: 'dm', botIds: const ['b1']),
    ], bots: [Bot(id: 'b1', name: '甲')]);
    addTearDown(state.dispose);
    await tester.pumpWidget(
      AppScope(
        state: state,
        child: MaterialApp(
          // 真实 App 里就是它把鼠标位置送进来的
          home: Scaffold(
            body: AvatarLife.watchPointer(child: const RoomsScreen()),
          ),
        ),
      ),
    );
    await tester.pump();

    Offset gazeOf() {
      final cp = tester
          .widgetList<CustomPaint>(
            find.descendant(
              of: find.byType(BlobAvatar),
              matching: find.byType(CustomPaint),
            ),
          )
          .first;
      return (cp.painter as dynamic).gaze as Offset;
    }

    expect(gazeOf(), Offset.zero, reason: '一开始没看着谁');

    final g = await tester.createGesture(kind: PointerDeviceKind.mouse);
    await g.addPointer(location: const Offset(5, 5));
    await tester.pump();
    // 移到**行的文字**上 —— 不在头像那 46px 里
    await g.moveTo(tester.getCenter(find.text('甲').first));
    await tester.pump();
    await tester.pump();

    expect(
      gazeOf().distance,
      greaterThan(3),
      reason: '★ 进到行上就该立刻看着鼠标，不该"再动一下才跟"',
    );
  });
}
