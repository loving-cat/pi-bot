import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pi_bot/app_state.dart';
import 'package:pi_bot/models.dart';
import 'package:pi_bot/scope.dart';
import 'package:pi_bot/screens/chat_screen.dart';
import 'package:pi_bot/widgets/blob_avatar.dart';
import 'package:pi_bot/widgets/msg_ref_chip.dart';
import 'package:pi_bot/widgets/progress_notice.dart';

const names = ['部门负责人甲', '数据核验员乙', '报告设计师丙', '接口测试员丁'];
final dm = Room(id: 'fixture-dm', name: '验证私聊', kind: 'dm', botIds: const []);

class _State extends AppState {
  final loaded = <String>[];
  String? requested;

  @override
  Future<void> loadMessages(String roomId, {bool force = false}) async {
    loaded.add(roomId);
  }

  @override
  void requestRoom(String roomId) => requested = roomId;

  void replace(List<Msg> next) {
    messages[dm.id] = next;
    notifyListeners();
  }
}

_State _state({bool longNames = false}) => _State()
  ..rooms = [
    dm,
    Room(
      id: 'fixture-group',
      name: longNames ? '验证部门名称' * 12 : '验证部门',
      kind: 'group',
      botIds: const [],
    ),
  ]
  ..bots = [
    for (var i = 0; i < names.length; i++)
      Bot(id: 'b$i', name: longNames ? names[i] * 12 : names[i]),
  ];

Msg receipt(
  int index, {
  String phase = 'start',
  String? outcome,
  String? name,
  int? time,
}) => Msg(
  id: 'receipt-$index',
  roomId: dm.id,
  authorType: 'bot',
  authorId: 'worker',
  authorName: '执行成员',
  text: phase == 'done'
      ? outcome == 'success'
            ? '验证任务已经完成'
            : '验证任务没跑通，需要重新检查'
      : '开始处理验证任务 $index',
  status: 'done',
  createdAt: time ?? 1000 + index,
  meta: {
    'progress': true,
    'fromRoomId': 'fixture-group',
    'fromId': 'b${index % 4}',
    'fromName': name ?? names[index % 4],
    'phase': phase,
    if (outcome != null) 'outcome': outcome,
  },
);

Future<void> _host(
  WidgetTester tester,
  _State state,
  Widget child, {
  double width = 420,
}) async {
  tester.view.physicalSize = const Size(1000, 760);
  tester.view.devicePixelRatio = 1;
  addTearDown(tester.view.reset);
  addTearDown(state.dispose);
  await tester.pumpWidget(
    AppScope(
      state: state,
      child: MaterialApp(
        home: Scaffold(
          body: Center(
            child: SizedBox(width: width, child: child),
          ),
        ),
      ),
    ),
  );
  await tester.pumpAndSettle();
}

void main() {
  setUp(() => BlobAvatar.animationsEnabled = false);
  tearDown(() => BlobAvatar.animationsEnabled = true);

  for (final (outcome, expected) in [
    ('success', '已交付'),
    ('failure', '未完成'),
    (null, '已结束'),
    ('unrecognized', '已结束'),
  ]) {
    testWidgets('完成回执结果 $outcome 显示 $expected', (tester) async {
      await _host(
        tester,
        _state(),
        ProgressNotice(
          messages: [receipt(0, phase: 'done', outcome: outcome)],
        ),
      );
      await tester.tap(find.text('收到'));
      await tester.pumpAndSettle();
      expect(find.text(expected), findsOneWidget);
      if (outcome != 'success') expect(find.text('已交付'), findsNothing);
      expect(
        find.textContaining(outcome == 'success' ? '验证任务已经完成' : '验证任务没跑通'),
        findsOneWidget,
      );
      expect(tester.takeException(), isNull);
    });
  }

  testWidgets('420px聊天列四位发送人折叠，点击仍可查看全部回执', (tester) async {
    await _host(
      tester,
      _state(),
      ProgressNotice(messages: [for (var i = 0; i < 4; i++) receipt(i)]),
    );
    expect(find.text('+2'), findsOneWidget);
    expect(tester.takeException(), isNull);
    await tester.tap(find.text('+2'));
    await tester.pumpAndSettle();
    expect(find.textContaining('开始处理验证任务 3'), findsOneWidget);
    expect(find.text(names[3]), findsOneWidget);
    expect(tester.takeException(), isNull);
    await tester.tap(find.text('关闭'));
    await tester.pumpAndSettle();
    expect(find.textContaining('开始处理验证任务 3'), findsNothing);
  });

  testWidgets('回执长名字和部门名在缩窄窗口后仍可显示并关闭', (tester) async {
    final s = _state(longNames: true);
    await _host(
      tester,
      s,
      ProgressNotice(messages: [receipt(0, name: s.bots.first.name)]),
    );
    await tester.tap(find.text('收到'));
    await tester.pumpAndSettle();
    for (final width in [420.0, 360.0, 760.0]) {
      tester.view.physicalSize = Size(width, 620);
      await tester.pumpAndSettle();
      expect(tester.takeException(), isNull);
    }
    expect(find.byTooltip(s.bots.first.name), findsNWidgets(2));
    await tester.tap(find.text('关闭'));
    await tester.pumpAndSettle();
    expect(find.text('关闭'), findsNothing);
  });

  testWidgets('多人引用行限宽，普通点击加载并展示所有目标会话', (tester) async {
    final s = _state();
    for (var i = 0; i < 4; i++) {
      s.messages['target-$i'] = [
        Msg(
          id: 'reply-$i',
          roomId: 'target-$i',
          authorType: 'bot',
          authorName: names[i],
          text: '来自第${i + 1}份会话的内容',
          status: 'done',
          createdAt: i + 1,
        ),
      ];
    }
    await _host(
      tester,
      s,
      MsgRefChip(
        refs: [
          for (var i = 0; i < 4; i++)
            MsgRef(botId: 'b$i', roomId: 'target-$i', count: 2),
        ],
      ),
    );
    expect(find.text('+2'), findsOneWidget);
    expect(tester.takeException(), isNull);
    await tester.tap(find.text('已发消息给'));
    await tester.pumpAndSettle();
    expect(s.loaded, ['target-0', 'target-1', 'target-2', 'target-3']);
    await tester.scrollUntilVisible(
      find.textContaining('来自第4份会话的内容'),
      200,
      scrollable: find.byType(Scrollable).last,
    );
    expect(tester.takeException(), isNull);
    await tester.tap(find.text('关闭聊天'));
    await tester.pumpAndSettle();
    expect(find.text('关闭聊天'), findsNothing);
  });

  testWidgets('双人查看器长标题在小窗口不溢出并保留打开会话操作', (tester) async {
    final s = _state(longNames: true);
    await _host(
      tester,
      s,
      MsgRefChip(
        senderBotId: 'b0',
        refs: [MsgRef(botId: 'b1', roomId: 'target')],
      ),
    );
    await tester.tap(find.text('已发消息给'));
    await tester.pumpAndSettle();
    for (final width in [420.0, 360.0, 760.0]) {
      tester.view.physicalSize = Size(width, 620);
      await tester.pumpAndSettle();
      expect(tester.takeException(), isNull);
    }
    expect(find.byTooltip(s.bots[0].name), findsOneWidget);
    expect(find.byTooltip(s.bots[1].name), findsWidgets);
    await tester.tap(find.byTooltip('打开这个对话'));
    await tester.pumpAndSettle();
    expect(s.requested, 'target');
    expect(find.text('关闭聊天'), findsNothing);
  });

  testWidgets('完整聊天聚合连续回执，普通消息分隔，失败明细可打开', (tester) async {
    final s = _state();
    s.messages[dm.id] = [
      receipt(0),
      receipt(1, phase: 'done', outcome: 'failure'),
      Msg(
        id: 'user-message',
        roomId: dm.id,
        authorType: 'user',
        authorName: '验证用户',
        text: '用户的正常消息',
        status: 'done',
        createdAt: 1002,
      ),
      receipt(2, time: 1003),
    ];
    await _host(tester, s, ChatScreen(room: dm), width: 700);
    expect(find.byType(ProgressNotice), findsNWidgets(2));
    expect(find.text('消息 · 2 条'), findsOneWidget);
    expect(find.text('消息 · 1 条'), findsOneWidget);
    expect(find.textContaining('用户的正常消息'), findsOneWidget);
    expect(find.textContaining('验证任务没跑通'), findsNothing);

    await tester.tap(find.text('消息 · 2 条'));
    await tester.pumpAndSettle();
    expect(find.text('未完成'), findsOneWidget);
    expect(find.text('已交付'), findsNothing);
    expect(find.textContaining('验证任务没跑通'), findsOneWidget);
    await tester.tap(find.text('关闭'));
    await tester.pumpAndSettle();

    s.replace([...s.messages[dm.id]!, receipt(3, time: 1004)]);
    await tester.pumpAndSettle();
    expect(find.byType(ProgressNotice), findsNWidgets(2));
    expect(find.text('消息 · 2 条'), findsNWidgets(2));
    expect(tester.takeException(), isNull);
  });
}
