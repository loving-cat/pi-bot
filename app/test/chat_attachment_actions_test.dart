import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pi_bot/app_state.dart';
import 'package:pi_bot/models.dart';
import 'package:pi_bot/scope.dart';
import 'package:pi_bot/screens/chat_screen.dart';
import 'package:pi_bot/widgets/blob_avatar.dart';

void main() {
  setUp(() => BlobAvatar.animationsEnabled = false);
  tearDown(() => BlobAvatar.animationsEnabled = true);

  for (final authorType in ['user', 'bot']) {
    testWidgets('$authorType 的纯附件消息保留长按菜单', (tester) async {
      tester.view.physicalSize = const Size(1000, 760);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.reset);
      final room = Room(
        id: 'fixture-room',
        name: 'fixture-room',
        kind: 'dm',
        botIds: const [],
      );
      final state = AppState()
        ..rooms = [room]
        ..messages[room.id] = [
          Msg(
            id: 'fixture-attachment-message',
            roomId: room.id,
            authorType: authorType,
            authorName: 'fixture-author',
            text: '',
            status: 'done',
            createdAt: 1,
            attachments: [
              Attachment(
                id: 'fixture-attachment',
                name: 'fixture.txt',
                mime: 'text/plain',
                size: 100,
              ),
            ],
          ),
        ];
      addTearDown(state.dispose);

      await tester.pumpWidget(
        AppScope(
          state: state,
          child: MaterialApp(home: ChatScreen(room: room)),
        ),
      );
      await tester.pumpAndSettle();
      await tester.longPress(find.text('fixture.txt'));
      await tester.pumpAndSettle();

      expect(find.text('复制消息 id'), findsOneWidget);
      expect(find.text('复制内容'), findsOneWidget);
      expect(tester.takeException(), isNull);
    });
  }
}
