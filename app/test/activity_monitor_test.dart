import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pi_bot/app_state.dart';
import 'package:pi_bot/l10n/l10n.dart';
import 'package:pi_bot/models.dart';
import 'package:pi_bot/scope.dart';
import 'package:pi_bot/widgets/activity_monitor.dart';
import 'package:pi_bot/widgets/blob_avatar.dart';
import 'package:shared_preferences/shared_preferences.dart';

Msg streamingMsg({
  String id = 'm1',
  String? authorId = 'b1',
  String text = '',
  String status = 'streaming',
  List<ToolStep> steps = const [],
}) =>
    Msg(
      id: id,
      roomId: 'r1',
      authorType: 'bot',
      authorId: authorId,
      authorName: '抓数员',
      text: text,
      status: status,
      createdAt: 1000,
      steps: steps,
    );

ToolStep step(String tool, {String status = 'running'}) =>
    ToolStep(tool: tool, status: status, detail: '');

void main() {
  setUp(() {
    SharedPreferences.setMockInitialValues({});
    BlobAvatar.animationsEnabled = false;
  });

  tearDown(() => BlobAvatar.animationsEnabled = true);

  group('工具名说人话', () {
    test('常用工具都有中文说法，认不出来的统一「正在干活」', () {
      expect(toolPhrase('bash'), '正在跑命令');
      expect(toolPhrase('write'), '正在写文件');
      expect(toolPhrase('web_search'), '正在搜索');
      expect(toolPhrase('some_future_tool'), '正在干活');
    });
  });

  group('这一轮在干什么', () {
    test('只挂了流式占位 → 正在思考', () {
      expect(liveActivityOf([streamingMsg()]), '正在思考');
    });

    test('有在跑的工具 → 说工具', () {
      expect(
        liveActivityOf([
          streamingMsg(steps: [step('bash'), step('grep', status: 'done')]),
        ]),
        '正在跑命令',
      );
    });

    test('工具都跑完了、开始出字 → 正在回复', () {
      expect(
        liveActivityOf([
          streamingMsg(text: '我看了下，结论是', steps: [step('bash', status: 'done')]),
        ]),
        '正在回复',
      );
    });

    test('没有在跑的这轮 → 空串，交给调用方回退', () {
      expect(liveActivityOf([streamingMsg(status: 'done', text: '完成')]), '');
      expect(liveActivityOf(const []), '');
    });

    test('多条流式消息时以最新那条为准', () {
      expect(
        liveActivityOf([
          streamingMsg(id: 'old', text: '旧', status: 'done'),
          streamingMsg(id: 'new', steps: [step('web_fetch')]),
        ]),
        '正在读网页',
      );
    });
  });

  group('胶囊文案', () {
    Future<AppState> pump(WidgetTester tester, List<Msg> msgs) async {
      final state = AppState();
      state.bots = [Bot(id: 'b1', name: '抓数员')];
      state.messages['r1'] = msgs;
      state.typingBots['r1'] = {'b1'};
      addTearDown(state.dispose);
      await tester.pumpWidget(
        AppScope(
          state: state,
          child: L10n(
            controller: LocaleController(),
            child: const MaterialApp(
              home: Scaffold(
                body: SizedBox(width: 600, height: 80, child: ActivityMonitor(roomId: 'r1')),
              ),
            ),
          ),
        ),
      );
      await tester.pump();
      return state;
    }

    testWidgets('刚开轮 → 正在思考', (tester) async {
      await pump(tester, [streamingMsg()]);
      expect(find.text('抓数员 正在思考'), findsOneWidget);
    });

    testWidgets('工具跑起来 → 文案跟着变（不需要整树重建）', (tester) async {
      final state = await pump(tester, [streamingMsg()]);
      expect(find.text('抓数员 正在思考'), findsOneWidget);

      // Msg 里的 steps/text 是不可变快照：换一条新消息，再 bump 一次
      state.messages['r1'] = [streamingMsg(steps: [step('bash')])];
      state.streamTick.value++;
      await tester.pump();
      expect(find.text('抓数员 正在跑命令'), findsOneWidget);

      state.messages['r1'] = [streamingMsg(text: '结果在这里')];
      state.streamTick.value++;
      await tester.pump();
      expect(find.text('抓数员 正在回复'), findsOneWidget);
    });

    testWidgets('多个 bot 同时在跑：一屏并列显示，不再轮播覆盖', (tester) async {
      final state = AppState();
      state.bots = [
        Bot(id: 'b1', name: '负责人'),
        Bot(id: 'b2', name: '资料检索员'),
      ];
      state.messages['r1'] = [
        streamingMsg(id: 'm1', authorId: 'b1'),
        streamingMsg(id: 'm2', authorId: 'b2', steps: [step('bash')]),
      ];
      state.typingBots['r1'] = {'b1', 'b2'};
      addTearDown(state.dispose);
      await tester.pumpWidget(
        AppScope(
          state: state,
          child: L10n(
            controller: LocaleController(),
            child: const MaterialApp(
              home: Scaffold(
                body: SizedBox(width: 700, height: 80, child: ActivityMonitor(roomId: 'r1')),
              ),
            ),
          ),
        ),
      );
      await tester.pump();
      // 两个人都看得见（轮播时只会出现一个）
      expect(find.textContaining('负责人'), findsOneWidget);
      expect(find.textContaining('资料检索员'), findsOneWidget);
      expect(find.textContaining('正在跑命令'), findsOneWidget);
    });

    testWidgets('没人在跑就整块隐藏', (tester) async {
      final state = AppState();
      addTearDown(state.dispose);
      await tester.pumpWidget(
        AppScope(
          state: state,
          child: L10n(
            controller: LocaleController(),
            child: const MaterialApp(
              home: Scaffold(body: ActivityMonitor(roomId: 'r1')),
            ),
          ),
        ),
      );
      await tester.pump();
      expect(find.textContaining('正在'), findsNothing);
    });
  });
}
