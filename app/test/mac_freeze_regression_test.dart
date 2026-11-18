import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pi_bot/app_state.dart';
import 'package:pi_bot/l10n/l10n.dart';
import 'package:pi_bot/models.dart';
import 'package:pi_bot/paste_paths.dart';
import 'package:pi_bot/scope.dart';
import 'package:pi_bot/screens/chat_screen.dart';
import 'package:pi_bot/widgets/blob_avatar.dart';
import 'package:shared_preferences/shared_preferences.dart';

class _TestAppState extends AppState {
  int notifyCalls = 0;

  @override
  Future<void> loadMessages(String roomId, {bool force = false}) async {}

  @override
  void notifyListeners() {
    notifyCalls++;
    super.notifyListeners();
  }

  void triggerNotify() => notifyListeners();
}

void main() {
  setUp(() {
    SharedPreferences.setMockInitialValues({});
    BlobAvatar.animationsEnabled = false;
  });

  tearDown(() {
    BlobAvatar.animationsEnabled = true;
  });

  group('M1: paste_paths 与 _input 监听器不累积', () {
    test('macOS autofs 陷阱路径被直接拦截，且 600 字符斜杠扫描有界', () {
      expect(isMacOSAutomountTrap('/net', isMacOS: true), isTrue);
      expect(isMacOSAutomountTrap('/Network/Servers/foo', isMacOS: true), isTrue);
      expect(isMacOSAutomountTrap('/home/user', isMacOS: true), isTrue);
      expect(isMacOSAutomountTrap('/Users/test/a.txt', isMacOS: true), isFalse);
      expect(isMacOSAutomountTrap('/home/user', isMacOS: false), isFalse);

      final hugeSlash = List.filled(300, '/a').join();
      final sw = Stopwatch()..start();
      final res = extractPastedFiles(hugeSlash);
      sw.stop();

      expect(res.files, isEmpty);
      expect(res.remainingText, hugeSlash);
      expect(sw.elapsedMilliseconds, lessThan(80));
    });

    testWidgets('多次 notifyListeners 后不重复挂载监听，单字符 / 与大段斜杠粘贴不卡顿', (tester) async {
      final dm = Room(
        id: 'dm-1',
        name: '助手',
        kind: 'dm',
        botIds: const ['b1'],
      );
      final state = _TestAppState()
        ..bots = [Bot(id: 'b1', name: '助手', role: 'main')]
        ..rooms = [dm]
        ..messages[dm.id] = [];
      addTearDown(state.dispose);

      await tester.pumpWidget(
        AppScope(
          state: state,
          child: L10n(
            controller: LocaleController(),
            child: MaterialApp(
              home: Scaffold(body: ChatScreen(room: dm, embedded: true)),
            ),
          ),
        ),
      );
      await tester.pump();

      for (var i = 0; i < 30; i++) {
        state.triggerNotify();
        await tester.pump();
      }

      // 单字符输入 / 应走输入防抖守卫并弹出快捷指令面板
      await tester.enterText(find.byType(TextField), '/');
      await tester.pump();
      expect(find.byKey(const ValueKey('composer-palette')), findsOneWidget);

      // 大段无文件斜杠文本保持完整、不卡顿
      final hugeSlash = List.filled(300, '/a').join();
      final sw = Stopwatch()..start();
      await tester.enterText(find.byType(TextField), hugeSlash);
      await tester.pump();
      sw.stop();

      final tf = tester.widget<TextField>(find.byType(TextField));
      expect(tf.controller!.text, hugeSlash);
      expect(sw.elapsedMilliseconds, lessThan(150));
    });
  });

  testWidgets('M3: overlayCovered 为 true 时失焦不会把焦点抢回输入框', (tester) async {
    final dm = Room(
      id: 'dm-3',
      name: '助手',
      kind: 'dm',
      botIds: const ['b1'],
    );
    final state = _TestAppState()
      ..bots = [Bot(id: 'b1', name: '助手', role: 'main')]
      ..rooms = [dm]
      ..messages[dm.id] = [];
    addTearDown(state.dispose);

    var covered = false;
    late StateSetter setHostState;

    await tester.pumpWidget(
      AppScope(
        state: state,
        child: L10n(
          controller: LocaleController(),
          child: MaterialApp(
            home: StatefulBuilder(
              builder: (context, setState) {
                setHostState = setState;
                return Scaffold(
                  body: ChatScreen(
                    room: dm,
                    embedded: true,
                    overlayCovered: covered,
                  ),
                );
              },
            ),
          ),
        ),
      ),
    );
    await tester.pump();

    await tester.tap(find.byType(TextField));
    await tester.pump();
    expect(
      FocusManager.instance.primaryFocus?.context
          ?.findAncestorWidgetOfExactType<TextField>(),
      isNotNull,
    );

    setHostState(() => covered = true);
    FocusManager.instance.primaryFocus?.unfocus();
    await tester.pump();

    for (var i = 0; i < 5; i++) {
      state.triggerNotify();
      await tester.pump();
    }

    expect(
      FocusManager.instance.primaryFocus?.context
          ?.findAncestorWidgetOfExactType<TextField>(),
      isNull,
    );
  });

  testWidgets('M4: bot.heartbeat 零通知，首字增量唤醒并精确隔离 streamTick', (tester) async {
    final dm = Room(
      id: 'dm-4',
      name: '助手',
      kind: 'dm',
      botIds: const ['b1'],
    );
    final state = _TestAppState()
      ..bots = [Bot(id: 'b1', name: '助手', role: 'main')]
      ..rooms = [dm]
      ..messages[dm.id] = [];
    addTearDown(state.dispose);

    await tester.pumpWidget(
      AppScope(
        state: state,
        child: L10n(
          controller: LocaleController(),
          child: MaterialApp(
            home: Scaffold(body: ChatScreen(room: dm, embedded: true)),
          ),
        ),
      ),
    );
    await tester.pump();

    state.notifyCalls = 0;
    state.handleFrameForTest({
      't': 'bot.heartbeat',
      'roomId': dm.id,
      'botId': 'b1',
      'ageMs': 15000,
    });
    expect(state.notifyCalls, 0);

    // 建出空流式占位消息
    state.handleFrameForTest({
      't': 'msg.new',
      'msg': {
        'id': 'm-stream-1',
        'roomId': dm.id,
        'authorType': 'bot',
        'authorId': 'b1',
        'authorName': '助手',
        'text': '',
        'status': 'streaming',
        'createdAt': 1000,
      },
    });
    await tester.pump();

    // 首字增量：触发一次 notifyListeners 挂载并渲染 首字▍
    state.notifyCalls = 0;
    state.handleFrameForTest({
      't': 'msg.delta',
      'roomId': dm.id,
      'msgId': 'm-stream-1',
      'text': '首字',
    });
    expect(state.notifyCalls, 1);
    await tester.pump();
    expect(state.activeStreamTickCount, 1);
    expect(find.textContaining('首字▍'), findsOneWidget);

    // 后续增量：不再 notifyListeners，仅通过该消息专属 streamTick 局部刷新
    state.notifyCalls = 0;
    state.handleFrameForTest({
      't': 'msg.delta',
      'roomId': dm.id,
      'msgId': 'm-stream-1',
      'text': '首字第二段',
    });
    expect(state.notifyCalls, 0);
    await tester.pump();
    expect(find.textContaining('首字第二段▍'), findsOneWidget);

    // 完成收尾：注销 streamTick 并渲染终态正文
    state.handleFrameForTest({
      't': 'msg.done',
      'msg': {
        'id': 'm-stream-1',
        'roomId': dm.id,
        'authorType': 'bot',
        'authorId': 'b1',
        'authorName': '助手',
        'text': '首字第二段完成',
        'status': 'done',
        'createdAt': 1000,
      },
    });
    await tester.pump();
    expect(state.activeStreamTickCount, 0);
    expect(find.textContaining('首字第二段完成'), findsOneWidget);
  });
}
