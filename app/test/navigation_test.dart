// 「跳到某个会话」的回归测试。
//
// 背景：点 @提及 以前走的是 `state.openRoom(id)` —— 它只记一个字段、不发通知；
// 而宽屏分栏的选中项是 HomeShell 自己的 `_selectedId`，压根不看那个字段。
// 结果就是点了 @ 什么都不发生（用户报的 bug）。窄屏同样跳不动。
//
// 这个坑很隐蔽：回调确实执行了、函数没报错、只是界面不动。所以两种布局都钉住。
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pi_bot/app_state.dart';
import 'package:pi_bot/models.dart';
import 'package:pi_bot/scope.dart';
import 'package:pi_bot/screens/chat_screen.dart';
import 'package:pi_bot/screens/home_shell.dart';
import 'package:pi_bot/widgets/blob_avatar.dart';

Room _room(String id, String name) =>
    Room(id: id, name: name, kind: 'dm', botIds: const []);

AppState _stateWith(List<Room> rooms) {
  final s = AppState();
  s.rooms = rooms;
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
}
