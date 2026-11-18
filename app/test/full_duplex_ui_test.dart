import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pi_bot/app_state.dart';
import 'package:pi_bot/l10n/l10n.dart';
import 'package:pi_bot/models.dart';
import 'package:pi_bot/scope.dart';
import 'package:pi_bot/screens/chat_screen.dart';
import 'package:pi_bot/widgets/activity_monitor.dart';
import 'package:pi_bot/widgets/avatar_life.dart';
import 'package:pi_bot/widgets/blob_avatar.dart';

class _StubState extends AppState {
  _StubState({List<Msg> initial = const []}) {
    final bot = Bot(id: 'b1', name: '全双工助手', emoji: '🤖', persona: '');
    final room = Room(id: 'r1', name: '全双工助手', kind: 'dm', botIds: [bot.id]);
    bots = [bot];
    rooms = [room];
    messages['r1'] = List.of(initial);
  }

  @override
  Future<void> loadMessages(String roomId, {bool force = false}) async {}
}

Widget _host(AppState state) => AppScope(
  state: state,
  child: L10n(
    controller: LocaleController(),
    child: MaterialApp(
      home: Scaffold(
        body: SizedBox(
          width: 900,
          height: 700,
          child: ChatScreen(room: state.rooms.first),
        ),
      ),
    ),
  ),
);

void main() {
  testWidgets('移除输入框上方黑边排队横条：queued > 0 且忙碌时不渲染 composer-busy-hint', (
    tester,
  ) async {
    final state = _StubState();
    state.typing['r1'] = true;
    state.workingBots['r1'] = {'b1'};
    state.typingBots['r1'] = {'b1'};
    state.queued['r1'] = 3;

    await tester.pumpWidget(_host(state));
    await tester.pump();

    expect(find.byKey(const ValueKey('composer-busy-hint')), findsNothing);
    expect(find.textContaining('发出去它会立刻停下来看'), findsNothing);
    expect(find.byType(TextField), findsOneWidget);
  });

  testWidgets('AppState 分轨 typing：Talk 结束不误抹后台 Work 忙碌态与头像情绪', (
    tester,
  ) async {
    final state = _StubState(
      initial: [
        Msg(
          id: 'u0',
          roomId: 'r1',
          authorType: 'user',
          authorName: '我',
          text: '开始执行',
          status: 'done',
          createdAt: DateTime.now().millisecondsSinceEpoch,
        ),
      ],
    );
    await tester.pumpWidget(_host(state));
    await tester.pump();

    Finder headerAvatar() => find.descendant(
      of: find.byType(AppBar),
      matching: find.byType(BlobAvatar),
    );

    // 1. Work 启动 -> AvatarMood.busy + ActivityMonitor 显示
    state.handleFrameForTest({
      't': 'typing',
      'roomId': 'r1',
      'botId': 'b1',
      'active': true,
      'lane': 'work',
      'msgId': 'm_work',
    });
    await tester.pump();
    expect(state.workingBots['r1'], {'b1'});
    expect(state.typing['r1'], isTrue);
    expect(find.byType(ActivityMonitor), findsOneWidget);
    expect(tester.widget<BlobAvatar>(headerAvatar()).mood, AvatarMood.busy);

    // 2. Talk 启动 -> 头像切为 speaking
    state.handleFrameForTest({
      't': 'typing',
      'roomId': 'r1',
      'botId': 'b1',
      'active': true,
      'lane': 'talk',
      'msgId': 'm_talk',
    });
    await tester.pump();
    expect(state.talkingBots['r1'], {'b1'});
    expect(tester.widget<BlobAvatar>(headerAvatar()).mood, AvatarMood.speaking);

    // 3. Talk 结束发 active: false -> Work 与 queued 保持完整，头像平滑回落 busy
    state.queued['r1'] = 1;
    state.handleFrameForTest({
      't': 'typing',
      'roomId': 'r1',
      'botId': 'b1',
      'active': false,
      'lane': 'talk',
      'msgId': 'm_talk',
    });
    await tester.pump();
    expect(state.talkingBots['r1'], isNull);
    expect(state.workingBots['r1'], {'b1'});
    expect(state.typing['r1'], isTrue);
    expect(state.queued['r1'], 1);
    expect(tester.widget<BlobAvatar>(headerAvatar()).mood, AvatarMood.busy);

    // 4. Work 真正结束 -> 彻底归零回 idle
    state.handleFrameForTest({
      't': 'typing',
      'roomId': 'r1',
      'botId': 'b1',
      'active': false,
      'lane': 'work',
      'msgId': 'm_work',
    });
    await tester.pump();
    expect(state.workingBots['r1'], isNull);
    expect(state.typing['r1'], isFalse);
    expect(state.queued['r1'], isNull);
    expect(tester.widget<BlobAvatar>(headerAvatar()).mood, AvatarMood.idle);
  });

  testWidgets('同一房间 Work(msg.steps) 与 Talk(msg.delta) 并行流式更新互不覆盖', (
    tester,
  ) async {
    final now = DateTime.now().millisecondsSinceEpoch;
    final state = _StubState(
      initial: [
        Msg(
          id: 'm_work',
          roomId: 'r1',
          authorType: 'bot',
          authorId: 'b1',
          authorName: '全双工助手',
          text: '',
          status: 'streaming',
          createdAt: now,
        ),
        Msg(
          id: 'u_ask',
          roomId: 'r1',
          authorType: 'user',
          authorName: '我',
          text: '跑到哪了？',
          status: 'done',
          createdAt: now + 1,
        ),
        Msg(
          id: 'm_talk',
          roomId: 'r1',
          authorType: 'bot',
          authorId: 'b1',
          authorName: '全双工助手',
          text: '',
          status: 'streaming',
          meta: const {'duplex': 'side_reply', 'duringMsgId': 'm_work'},
          createdAt: now + 2,
        ),
      ],
    );
    await tester.pumpWidget(_host(state));
    await tester.pump();

    state.handleFrameForTest({
      't': 'msg.steps',
      'roomId': 'r1',
      'msgId': 'm_work',
      'steps': [
        {'tool': 'bash', 'detail': 'npm test', 'status': 'running'},
      ],
    });
    state.handleFrameForTest({
      't': 'msg.delta',
      'roomId': 'r1',
      'msgId': 'm_talk',
      'text': '后台正在跑测试脚本',
    });
    await tester.pump();

    final workMsg = state.messages['r1']!.firstWhere((m) => m.id == 'm_work');
    final talkMsg = state.messages['r1']!.firstWhere((m) => m.id == 'm_talk');
    expect(workMsg.steps.length, 1);
    expect(workMsg.steps.first.detail, 'npm test');
    expect(talkMsg.text, '后台正在跑测试脚本');
    expect(find.textContaining('后台正在跑测试脚本'), findsOneWidget);

    // 验证 duplex.routed 事件能落入用户消息 meta
    state.handleFrameForTest({
      't': 'duplex.routed',
      'roomId': 'r1',
      'messageId': 'u_ask',
      'kind': 'side_reply',
      'decidedBy': 'rules',
      'duringMsgId': 'm_work',
    });
    final uMsg = state.messages['r1']!.firstWhere((m) => m.id == 'u_ask');
    expect(uMsg.meta?['duplex'], 'side_reply');
    expect(uMsg.meta?['duringMsgId'], 'm_work');
  });
}
