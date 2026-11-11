import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
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
    typingBots[room.id] = {'b1'};
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
  // 不能用 pumpAndSettle：忙时输入区有持续的转圈动画，永远 settle 不了
  await tester.pump();                                  // 首帧
  await tester.pump(const Duration(milliseconds: 100)); // 让 AnimatedContainer 起步
  await tester.pump(const Duration(milliseconds: 300)); // 动画跑完
}

void main() {
  group('一体式胶囊输入框', () {
    testWidgets('★ ➕ 和发送键都在输入框容器内部', (tester) async {
      final state = _State();
      await pumpChat(tester, state);

      final capsule = find.byKey(const ValueKey('composer-capsule'));
      expect(capsule, findsOneWidget, reason: '应有胶囊容器');

      // ➕ 在胶囊里
      final plus = find.byIcon(LucideIcons.plus);
      expect(plus, findsOneWidget, reason: '➕ 应存在');
      expect(
        find.descendant(of: capsule, matching: plus),
        findsOneWidget,
        reason: '➕ 必须在胶囊内部，不能在外面',
      );

      // 发送键在胶囊里（不忙时显示）
      final send = find.byKey(const ValueKey('composer-send'));
      expect(send, findsOneWidget);
      expect(
        find.descendant(of: capsule, matching: send),
        findsOneWidget,
        reason: '发送键必须在胶囊内部',
      );

      // 输入框也在胶囊里
      expect(
        find.descendant(of: capsule, matching: find.byType(TextField)),
        findsOneWidget,
      );
    });

    testWidgets('不忙时没有停止键', (tester) async {
      final state = _State();
      await pumpChat(tester, state);
      expect(find.byKey(const ValueKey('composer-stop')), findsNothing);
    });
  });

  group('忙时的发送/停止键', () {
    testWidgets('★ 忙且没字：只有停止键，没有发送键', (tester) async {
      final state = _State();
      state.typing[room.id] = true;   // 助手正在跑
      await pumpChat(tester, state);

      expect(find.byKey(const ValueKey('composer-stop')), findsOneWidget,
          reason: '忙时应有停止键');
      expect(find.byKey(const ValueKey('composer-send')), findsNothing,
          reason: '忙且没字时不该显示发送键');
      // 不再是闪电
      expect(find.byIcon(LucideIcons.zap), findsNothing,
          reason: '发送键不该变成闪电图标');
    });

    testWidgets('★ 忙且有字：发送键是向上箭头，不是闪电', (tester) async {
      final state = _State();
      state.typing[room.id] = true;
      await pumpChat(tester, state);

      // 往输入框里打字
      await tester.enterText(find.byType(TextField), '补充一句');
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 100));

      final send = find.byKey(const ValueKey('composer-send'));
      expect(send, findsOneWidget, reason: '有字时应有发送键');

      // 图标必须是 arrowUp
      final icon = tester.widget<Icon>(
        find.descendant(of: send, matching: find.byType(Icon)),
      );
      expect(icon.icon, LucideIcons.arrowUp,
          reason: '发送键永远是向上箭头，不能是闪电');
      expect(icon.icon, isNot(LucideIcons.zap));

      // 停止键仍在
      expect(find.byKey(const ValueKey('composer-stop')), findsOneWidget);
    });
  });

}
