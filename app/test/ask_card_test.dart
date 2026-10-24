import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pi_bot/app_state.dart';
import 'package:pi_bot/models.dart';
import 'package:pi_bot/screens/chat_screen.dart';
import 'package:pi_bot/scope.dart';

/// 询问卡片里的输入框必须能打字。
///
/// 消息列表不能整体用 ExcludeFocus 包住（那是防流式输出抢焦点的做法）：
/// 会连带把卡片里的 TextField 也禁掉，点进去打不进字。
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

  /// 回归：卡片用过一次就该收起来。
  ///
  /// 点了选项/自己说了一句后卡片还摊在那里、按钮还能再点的话，
  /// 用户会怀疑「我刚才到底点上没有」，误点还会把进程带偏。
  testWidgets('回答过的卡片收起，不再给可点的选项', (tester) async {
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
        text: '现在想让我做点什么？',
        status: 'done',
        kind: 'ask',
        createdAt: DateTime.now().millisecondsSinceEpoch,
        meta: {
          'options': [
            {'label': '设计一个新接口'},
            {'label': '排查线上问题'},
          ],
          'allowCustom': true,
          // 服务端已经写回回答
          'answer': '没事 打个招呼',
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

    // 卡片正文不该再出现，选项也不该再能点
    expect(find.text('现在想让我做点什么？'), findsNothing,
        reason: '回答后卡片正文应收起');
    expect(find.text('设计一个新接口'), findsNothing,
        reason: '回答后选项不应再展示');
    expect(find.text('排查线上问题'), findsNothing);
    expect(find.widgetWithText(TextField, '或者我自己说一句…'), findsNothing,
        reason: '回答后不该再给输入框');

    // 但历史里要留一行痕迹
    expect(find.textContaining('已回答'), findsOneWidget,
        reason: '收起后要留一行回答记录');
  });
}
