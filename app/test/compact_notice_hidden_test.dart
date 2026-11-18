import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pi_bot/app_state.dart';
import 'package:pi_bot/l10n/l10n.dart';
import 'package:pi_bot/models.dart';
import 'package:pi_bot/screens/chat_screen.dart';
import 'package:pi_bot/scope.dart';
import 'package:pi_bot/widgets/blob_avatar.dart';
import 'package:shared_preferences/shared_preferences.dart';

Msg msg({
  required String id,
  required String authorType,
  String text = '',
  String kind = 'text',
  Map<String, dynamic>? meta,
  int createdAt = 1000,
}) =>
    Msg(
      id: id,
      roomId: 'r1',
      authorType: authorType,
      authorId: authorType == 'bot' ? 'b1' : null,
      authorName: authorType == 'bot' ? '负责人' : '我',
      text: text,
      status: 'done',
      kind: kind,
      createdAt: createdAt,
      meta: meta,
    );

void main() {
  setUp(() {
    SharedPreferences.setMockInitialValues({});
    BlobAvatar.animationsEnabled = false;
  });

  tearDown(() => BlobAvatar.animationsEnabled = true);

  testWidgets('上下文压缩提示不再出现在对话里，正文照常显示', (tester) async {
    tester.view.physicalSize = const Size(900, 700);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.reset);

    final room = Room(
      id: 'r1',
      name: '调研组',
      kind: 'group',
      botIds: const ['b1'],
      lastMessageAt: 3000,
    );
    final state = AppState()
      ..bots = [Bot(id: 'b1', name: '负责人', role: 'lead')]
      ..rooms = [room]
      ..messages['r1'] = [
        msg(id: 'm1', authorType: 'user', text: '继续调研', createdAt: 1000),
        msg(
          id: 'm2',
          authorType: 'system',
          kind: 'compact',
          meta: {'tokensBefore': 115000, 'saved': 62000},
          createdAt: 2000,
        ),
        msg(
          id: 'm3',
          authorType: 'bot',
          text: '报告写完了，三份交付物都在。',
          createdAt: 3000,
        ),
      ];
    addTearDown(state.dispose);

    await tester.pumpWidget(
      AppScope(
        state: state,
        child: L10n(
          controller: LocaleController(),
          child: MaterialApp(home: ChatScreen(room: room)),
        ),
      ),
    );
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 300));

    // 正文还在
    expect(find.textContaining('报告写完了'), findsOneWidget);
    // 压缩提示不再刷屏（压缩是后台行为，读数在顶栏胶囊里）
    expect(find.textContaining('上下文压缩了'), findsNothing);
    expect(find.textContaining('省下'), findsNothing);
  });
}
