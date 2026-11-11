import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pi_bot/app_state.dart';
import 'package:pi_bot/l10n/l10n.dart';
import 'package:pi_bot/models.dart';
import 'package:pi_bot/scope.dart';
import 'package:pi_bot/screens/chat_screen.dart';
import 'package:pi_bot/widgets/activity_monitor.dart';

final room = Room(id: 'fx-room', name: '验证会话', kind: 'dm', botIds: const []);

class _State extends AppState {
  _State() {
    rooms = [room];
    bots = [Bot(id: 'b1', name: '数据工程师', persona: '')];
    messages[room.id] = [
      for (var i = 0; i < 40; i++)
        Msg(
          id: 'm$i',
          roomId: room.id,
          authorType: i.isEven ? 'user' : 'bot',
          authorId: i.isEven ? null : 'b1',
          authorName: i.isEven ? '我' : '数据工程师',
          text: '第 $i 条消息',
          status: 'done',
          createdAt: DateTime.now().millisecondsSinceEpoch + i,
        ),
    ];
  }
  @override
  Future<void> loadMessages(String roomId, {bool force = false}) async {}
}

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
  group('回到底部不改变高度', () {
    testWidgets('showJump 变化时 composer 与消息区高度都不变', (tester) async {
      final state = _State();
      await pumpChat(tester, state);

      // 初始在底部 → 没有「回到最新」按钮
      expect(find.byTooltip('回到最新'), findsNothing);

      final composerBefore = tester.getSize(find.byType(TextField));
      final listBefore = tester.getSize(
        find.byType(Scrollable).first,
      );

      // 往上翻 → 出现按钮
      final scrollable = find.byType(Scrollable).first;
      await tester.drag(scrollable, const Offset(0, 400));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 300));

      expect(find.byTooltip('回到最新'), findsOneWidget,
          reason: '上翻后应出现「回到最新」');

      final composerAfter = tester.getSize(find.byType(TextField));
      final listAfter = tester.getSize(find.byType(Scrollable).first);

      expect(composerAfter.height, composerBefore.height,
          reason: '输入框高度不该变');
      expect(listAfter.height, listBefore.height,
          reason: '消息区高度不该变');
    });
  });

  group('ActivityMonitor 命中与悬停', () {
testWidgets('悬停胶囊弹的是状态说明，不是任务内容', (tester) async {
      final state = _State();
      state.typingBots[room.id] = {'b1'};

      await tester.pumpWidget(
        AppScope(
          state: state,
          child: MaterialApp(
            home: Scaffold(
              body: SizedBox(
                width: 900,
                child: ActivityMonitor(roomId: room.id),
              ),
            ),
          ),
        ),
      );
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 100));

      // ★ Tooltip 只说状态，不复述任务内容。
      //   typing 事件只带 botId，服务端没下发「这一轮在答什么」；
      //   把 TaskRun 的 title 塞进去只会显示一段和当前提问无关的旧任务。
      final tips = find.byType(Tooltip);
      expect(tips, findsOneWidget);
      final msg = tester.widget<Tooltip>(tips).message!;
      expect(msg, contains('正在处理'));
      expect(msg, isNot(contains('任务')), reason: '不该复述任务标题');

      expect(tips.hitTestable(), findsOneWidget,
          reason: '胶囊必须可命中，否则悬停收不到');
    });

        testWidgets('胶囊两侧空白不拦事件', (tester) async {
      final state = _State();
      state.typingBots[room.id] = {'b1'};

      await tester.pumpWidget(
        AppScope(
          state: state,
          child: MaterialApp(
            home: Scaffold(
              body: Stack(
                children: [
                  Positioned.fill(
                    child: GestureDetector(
                      onTap: () => tapped = true,
                      child: Container(key: const ValueKey('under'), color: Colors.white),
                    ),
                  ),
                  Positioned(
                    left: 0,
                    right: 0,
                    bottom: 0,
                    child: ActivityMonitor(
                      roomId: room.id,
                    ),
                  ),
                ],
              ),
            ),
          ),
        ),
      );
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 100));

      // 点胶囊**右侧**的空白处。用胶囊自身的矩形定位，
      // 避免坐标恰好落在胶囊上（那会被 GestureDetector 吃掉）。
      final capsule = tester.getRect(find.byType(Tooltip).first);
      final under = tester.getRect(find.byKey(const ValueKey('under')));
      final blankX = (capsule.right + under.right) / 2;
      final blankY = capsule.center.dy;
      expect(blankX, greaterThan(capsule.right),
          reason: '测试点必须落在胶囊右边');

      await tester.tapAt(Offset(blankX, blankY));
      await tester.pump();
      expect(tapped, isTrue,
          reason: '胶囊外的空白必须把点击透传给下面的层');
    });
  });
}

bool tapped = false;
