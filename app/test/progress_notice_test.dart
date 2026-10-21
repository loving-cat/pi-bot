import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pi_bot/app_state.dart';
import 'package:pi_bot/models.dart';
import 'package:pi_bot/scope.dart';
import 'package:pi_bot/widgets/blob_avatar.dart';
import 'package:pi_bot/widgets/progress_notice.dart';

void main() {
  setUp(() => BlobAvatar.animationsEnabled = false);
  tearDown(() => BlobAvatar.animationsEnabled = true);

  testWidgets('★ 部门回执收成一条「收到 X 消息」，点开是二级界面', (tester) async {
    tester.view.physicalSize = const Size(1000, 760);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);

    final state = AppState()
      ..bots = [Bot(id: 'b1', name: '验证负责人'), Bot(id: 'b2', name: '验证成员')]
      ..rooms = [
        Room(id: 'r1', name: '验证团队', kind: 'group', botIds: const []),
      ];
    addTearDown(state.dispose);

    final msgs = [
      Msg(
        id: 'm1',
        roomId: 'dm1',
        authorType: 'bot',
        authorName: '执行成员',
        text: '在「验证团队」接到活，开始处理：做一份报告',
        status: 'done',
        createdAt: 1000,
        meta: {
          'progress': true,
          'fromRoomId': 'r1',
          'phase': 'start',
          'fromId': 'b1',
          'fromName': '验证负责人',
        },
      ),
      Msg(
        id: 'm2',
        roomId: 'dm1',
        authorType: 'bot',
        authorName: '执行成员',
        text: '「验证团队」那件事做完了：报告已交付',
        status: 'done',
        createdAt: 2000,
        meta: {
          'progress': true,
          'fromRoomId': 'r1',
          'phase': 'done',
          'outcome': 'success',
          'fromId': 'b1',
          'fromName': '验证负责人',
        },
      ),
    ];

    await tester.pumpWidget(
      AppScope(
        state: state,
        child: MaterialApp(
          home: Scaffold(
            body: Center(child: ProgressNotice(messages: msgs)),
          ),
        ),
      ),
    );
    await tester.pump();

    expect(find.text('收到'), findsOneWidget);
    expect(find.text('验证负责人'), findsOneWidget);
    expect(find.text('消息 · 2 条'), findsOneWidget);

    await tester.tap(find.text('收到'));
    await tester.pumpAndSettle();
    expect(find.text('关闭'), findsOneWidget);
    expect(find.textContaining('报告已交付'), findsOneWidget);
  });
}
