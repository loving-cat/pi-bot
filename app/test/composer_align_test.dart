import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pi_bot/app_state.dart';
import 'package:pi_bot/l10n/l10n.dart';
import 'package:pi_bot/models.dart';
import 'package:pi_bot/scope.dart';
import 'package:pi_bot/screens/chat_screen.dart';

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
  await tester.pump(const Duration(milliseconds: 100));
  await tester.pump(const Duration(milliseconds: 300));
}

void main() {
  group('胶囊单行对齐', () {
    testWidgets('单行时 ➕ / 发送键 / 文字三者中心 y 对齐', (tester) async {
      final state = _State();
      await pumpChat(tester, state);

      final capsule = tester.getRect(
        find.byKey(const ValueKey('composer-capsule')),
      );
      final plus = tester.getRect(find.byKey(const ValueKey('composer-plus')));
      final send = tester.getRect(
        find.byKey(const ValueKey('composer-send')),
      );

      // 三者中心 y 与胶囊中心 y 相差 <= 1
      expect(
        (plus.center.dy - capsule.center.dy).abs(),
        lessThanOrEqualTo(1.0),
        reason: '➕ 中心 ${plus.center.dy} vs 胶囊 ${capsule.center.dy}',
      );
      expect(
        (send.center.dy - capsule.center.dy).abs(),
        lessThanOrEqualTo(1.0),
        reason: '发送键中心 ${send.center.dy} vs 胶囊 ${capsule.center.dy}',
      );
    });

    testWidgets('左右按钮到胶囊边缘的水平距离相等', (tester) async {
      final state = _State();
      await pumpChat(tester, state);

      final capsule = tester.getRect(
        find.byKey(const ValueKey('composer-capsule')),
      );
      final plus = tester.getRect(find.byKey(const ValueKey('composer-plus')));
      final send = tester.getRect(
        find.byKey(const ValueKey('composer-send')),
      );

      final leftGap = plus.left - capsule.left;
      final rightGap = capsule.right - send.right;
      expect(
        (leftGap - rightGap).abs(),
        lessThanOrEqualTo(1.0),
        reason: '左右边距应相等：左 $leftGap / 右 $rightGap',
      );
    });

    testWidgets('多行时两个按钮底边与胶囊内底边对齐', (tester) async {
      final state = _State();
      await pumpChat(tester, state);

      // 输入三行
      await tester.enterText(find.byType(TextField), '第一行\n第二行\n第三行');
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 200));
      await tester.pump(const Duration(milliseconds: 200));

      final capsule = tester.getRect(
        find.byKey(const ValueKey('composer-capsule')),
      );
      final plus = tester.getRect(find.byKey(const ValueKey('composer-plus')));
      final send = tester.getRect(
        find.byKey(const ValueKey('composer-send')),
      );

      // 胶囊内底边 = 胶囊底边 - 内边距(4)
      final innerBottom = capsule.bottom - 4;
      expect(
        (plus.bottom - innerBottom).abs(),
        lessThanOrEqualTo(1.5),
        reason: '➕ 底边 ${plus.bottom} 应对齐内底边 $innerBottom',
      );
      expect(
        (send.bottom - innerBottom).abs(),
        lessThanOrEqualTo(1.5),
        reason: '发送键底边 ${send.bottom} 应对齐内底边 $innerBottom',
      );
    });
  });
}
