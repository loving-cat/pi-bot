import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pi_bot/app_state.dart';
import 'package:pi_bot/models.dart';
import 'package:pi_bot/screens/chat_screen.dart';
import 'package:pi_bot/scope.dart';

/// 询问卡片里的输入框必须能打字。
///
/// 以前整条消息列表被 ExcludeFocus 包住（为了防流式输出抢焦点），
/// 连带把卡片里的 TextField 也禁掉了 —— 点进去打不进字。
void main() {
  testWidgets('卡片里的「我自己说」可以输入', (tester) async {
    final state = AppState();
    addTearDown(state.dispose);
    state.rooms = [
      Room(id: 'r1', kind: 'dm', name: '甲', botIds: const ['b1'], leadBotId: 'b1'),
    ];
    state.bots = [Bot(id: 'b1', name: '甲', role: 'member')];
    state.messages['r1'] = [
      Msg(
        id: 'm1',
        roomId: 'r1',
        authorType: 'bot',
        authorId: 'b1',
        authorName: '甲',
        text: '想先从哪儿开始？',
        status: 'done',
        kind: 'ask',
        createdAt: DateTime.now().millisecondsSinceEpoch,
        meta: {
          'options': [
            {'label': '方案 A'},
            {'label': '方案 B'},
          ],
          'allowCustom': true,
        },
      ),
    ];

    await tester.pumpWidget(
      AppScope(
        state: state,
        child: MaterialApp(home: ChatScreen(room: state.rooms.first)),
      ),
    );
    await tester.pump(const Duration(seconds: 1));

    final field = find.widgetWithText(TextField, '或者我自己说一句…');
    expect(field, findsOneWidget, reason: '卡片里应该有自定义输入框');

    await tester.tap(field);
    await tester.pump();
    await tester.enterText(field, '我自己定');
    await tester.pump();

    expect(find.text('我自己定'), findsOneWidget, reason: '输入框必须收得到字');
  });
}
