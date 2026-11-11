import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pi_bot/app_state.dart';
import 'package:pi_bot/l10n/l10n.dart';
import 'package:pi_bot/models.dart';
import 'package:pi_bot/scope.dart';
import 'package:pi_bot/screens/chat_screen.dart';
import 'package:pi_bot/widgets/activity_monitor.dart';
import 'package:pi_bot/widgets/blob_avatar.dart';

final room = Room(id: 'fx-room', name: '验证会话', kind: 'dm', botIds: const []);

class _State extends AppState {
  _State({List<Msg> msgs = const []}) {
    rooms = [room];
    bots = [
      Bot(id: 'b1', name: '商业研究主管', emoji: '📊', persona: ''),
      Bot(id: 'b2', name: '数据核验员', emoji: '🔍', persona: ''),
    ];
    messages[room.id] = List.of(msgs);
  }
  @override
  Future<void> loadMessages(String roomId, {bool force = false}) async {}
}

Msg streamMsg({String text = '', String status = 'streaming'}) => Msg(
  id: 'm1',
  roomId: room.id,
  authorType: 'bot',
  authorId: 'b1',
  authorName: '商业研究主管',
  authorEmoji: '📊',
  text: text,
  status: status,
  createdAt: DateTime.now().millisecondsSinceEpoch,
);

Future<void> pumpChat(WidgetTester tester, AppState state) async {
  await tester.pumpWidget(
    AppScope(
      state: state,
      child: L10n(
        controller: LocaleController(),
        child: MaterialApp(
          home: Scaffold(
            body: SizedBox(width: 900, height: 700, child: ChatScreen(room: room)),
          ),
        ),
      ),
    ),
  );
  await tester.pump();
  await tester.pump(const Duration(milliseconds: 200));
  await tester.pump(const Duration(milliseconds: 300));
}

void main() {
  group('思考期不再画空气泡', () {
    testWidgets('★ 流式中但正文为空 → 不渲染气泡', (tester) async {
      final state = _State(msgs: [streamMsg(text: '')]);
      await pumpChat(tester, state);

      expect(find.byType(TextField), findsOneWidget,
          reason: '输入框还在（确认整页渲染了）');

      // 空 streaming 消息不该占一个气泡：用消息的 key 判定 ——
      // 消息列表里那条消息的 _Appear 容器不该出现。
      // （不能断言 find.text('')：输入框自己的 text 也是空串。）
      expect(find.byKey(const ValueKey('m1')), findsNothing,
          reason: '正文为空时整条消息不该渲染出来');
    });

    testWidgets('★ 首字到达后气泡出现并带流式光标', (tester) async {
      final state = _State(msgs: [streamMsg(text: '正在整理结论')]);
      await pumpChat(tester, state);

      expect(find.textContaining('正在整理结论'), findsOneWidget);
      expect(find.textContaining('▍'), findsOneWidget,
          reason: '流式中应带光标');
    });
  });

  group('活动胶囊：形象与状态', () {
    Widget monitor({
      bool needsUser = false,
      bool streaming = false,
    }) =>
        ActivityMonitor(
          roomId: room.id,
          needsUser: needsUser,
          streaming: streaming,
        );

    testWidgets('★ 胶囊显示 bot 的 emoji 形象', (tester) async {
      final state = _State();
      state.typingBots[room.id] = {'b1'};

      await tester.pumpWidget(
        AppScope(
          state: state,
          child: MaterialApp(
            home: Scaffold(
              body: SizedBox(width: 900, child: monitor()),
            ),
          ),
        ),
      );
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 100));

      // 用 BlobAvatar（用户给 bot 创造的 3D 形象），不是 emoji
      expect(find.byType(BlobAvatar), findsOneWidget,
          reason: '应显示 BlobAvatar 形象');
      expect(find.text('📊'), findsNothing,
          reason: '不该把 emoji 当头像用');
      expect(find.textContaining('商业研究主管'), findsOneWidget);
    });

    testWidgets('★ 等你确认时文案变化', (tester) async {
      final state = _State();
      state.typingBots[room.id] = {'b1'};

      await tester.pumpWidget(
        AppScope(
          state: state,
          child: MaterialApp(
            home: Scaffold(
              body: SizedBox(
                width: 900,
                child: monitor(needsUser: true),
              ),
            ),
          ),
        ),
      );
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 100));

      expect(find.textContaining('等你确认'), findsOneWidget);
    });

    testWidgets('正在输出时文案变化', (tester) async {
      final state = _State();
      state.typingBots[room.id] = {'b1'};

      await tester.pumpWidget(
        AppScope(
          state: state,
          child: MaterialApp(
            home: Scaffold(
              body: SizedBox(
                width: 900,
                child: monitor(streaming: true),
              ),
            ),
          ),
        ),
      );
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 100));

      expect(find.textContaining('正在回复'), findsOneWidget);
    });

    testWidgets('没 emoji 时退回小圆点，不报错', (tester) async {
      final state = _State();
      state.bots = [Bot(id: 'b1', name: '无表情成员', persona: '')];
      state.typingBots[room.id] = {'b1'};

      await tester.pumpWidget(
        AppScope(
          state: state,
          child: MaterialApp(
            home: Scaffold(
              body: SizedBox(width: 900, child: monitor()),
            ),
          ),
        ),
      );
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 100));

      expect(find.textContaining('无表情成员'), findsOneWidget);
    });
  });

  group('activityVerb 纯函数', () {
    test('优先级：等你确认 > 正在回复 > 正在处理', () {
      expect(
        activityVerb(needsUser: true, streaming: true),
        '等你确认',
      );
      expect(
        activityVerb(needsUser: false, streaming: true),
        '正在回复',
      );
      expect(
        activityVerb(needsUser: false, streaming: false),
        '正在处理',
      );
      expect(
        activityVerb(needsUser: false, streaming: false),
        '正在处理',
      );
    });
  });
}
