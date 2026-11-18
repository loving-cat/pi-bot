import 'package:flutter/gestures.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import 'package:pi_bot/app_state.dart';
import 'package:pi_bot/l10n/l10n.dart';
import 'package:pi_bot/models.dart';
import 'package:pi_bot/scope.dart';
import 'package:pi_bot/screens/chat_screen.dart';
import 'package:pi_bot/screens/home_shell.dart';
import 'package:pi_bot/screens/rooms_screen.dart';
import 'package:pi_bot/widgets/blob_avatar.dart';
import 'package:pi_bot/widgets/msg_quote_strip.dart';
import 'package:shared_preferences/shared_preferences.dart';

class _TestAppState extends AppState {
  final List<(String roomId, String text)> sent = [];
  final Map<String, Room> dmByBot = {};

  void triggerNotify() => notifyListeners();

  @override
  Future<void> loadMessages(String roomId, {bool force = false}) async {}

  @override
  Future<Room?> ensureDm(String botId) async => dmByBot[botId];

  @override
  Future<void> sendMessage(
    String roomId,
    String text, {
    String mode = 'steer',
    List<Attachment> attachments = const [],
    bool flushMerge = true,
  }) async {
    sent.add((roomId, text));
  }
}

void main() {
  setUp(() {
    SharedPreferences.setMockInitialValues({});
    BlobAvatar.animationsEnabled = false;
  });

  tearDown(() {
    BlobAvatar.animationsEnabled = true;
  });

  testWidgets('宽屏 HomeShell 点击新建私聊保持多栏，不盖全屏路由', (tester) async {
    tester.view.physicalSize = const Size(1400, 900);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.reset);

    final dm1 = Room(
      id: 'dm-b1',
      name: '助手甲',
      kind: 'dm',
      botIds: const ['b1'],
      lastMessageAt: 200,
    );
    final dm2 = Room(
      id: 'dm-b2',
      name: '助手乙',
      kind: 'dm',
      botIds: const ['b2'],
      lastMessageAt: 100,
    );
    final state = _TestAppState()
      ..bots = [
        Bot(id: 'b1', name: '助手甲', role: 'main'),
        Bot(id: 'b2', name: '助手乙', role: 'member'),
      ]
      ..rooms = [dm1, dm2]
      ..dmByBot['b1'] = dm1
      ..dmByBot['b2'] = dm2;
    addTearDown(state.dispose);

    await tester.pumpWidget(
      AppScope(
        state: state,
        child: L10n(
          controller: LocaleController(),
          child: const MaterialApp(home: HomeShell()),
        ),
      ),
    );
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 200));

    expect(tester.widget<ChatScreen>(find.byType(ChatScreen)).room.id, 'dm-b1');

    await tester.tap(
      find.descendant(
        of: find.byType(RoomsScreen),
        matching: find.byIcon(LucideIcons.plus),
      ),
    );
    await tester.pumpAndSettle();

    await tester.tap(find.text('助手乙').last);
    await tester.pumpAndSettle();

    expect(find.byType(RoomsScreen), findsOneWidget);
    expect(find.byType(ChatScreen), findsOneWidget);
    expect(tester.widget<ChatScreen>(find.byType(ChatScreen)).room.id, 'dm-b2');
  });

  testWidgets('RoomsScreen 取消左上角大提醒条，改为独立「待处理」Tab 并保留置顶/未读角标', (tester) async {
    tester.view.physicalSize = const Size(480, 900);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.reset);

    final approvalMsg = Msg(
      id: 'm-appr',
      roomId: 'r-work',
      authorType: 'bot',
      authorId: 'b1',
      authorName: '工程师',
      text: '请求执行构建命令',
      status: 'done',
      kind: 'approval',
      createdAt: 300,
      meta: {'approvalId': 'ap-1', 'summary': 'flutter test'},
    );
    final workRoom = Room(
      id: 'r-work',
      name: '普通工作群',
      kind: 'group',
      botIds: const ['b1'],
      lastMessageAt: 300,
      lastMessage: approvalMsg,
    );
    final pinnedRoom = Room(
      id: 'r-pin',
      name: '核心置顶群',
      kind: 'group',
      botIds: const ['b1'],
      lastMessageAt: 100,
      pinned: true,
      unread: true,
    );

    final state = _TestAppState()
      ..bots = [Bot(id: 'b1', name: '工程师')]
      ..rooms = [workRoom, pinnedRoom]
      ..messages['r-work'] = [approvalMsg];
    // 通过 room.updated 触发 _roomOrder 排序
    state.handleFrameForTest({
      't': 'room.updated',
      'room': {
        'id': 'r-pin',
        'name': '核心置顶群',
        'kind': 'group',
        'botIds': ['b1'],
        'lastMessageAt': 100,
        'pinned': true,
        'unread': true,
      },
    });
    addTearDown(state.dispose);

    await tester.pumpWidget(
      AppScope(
        state: state,
        child: L10n(
          controller: LocaleController(),
          child: const MaterialApp(home: RoomsScreen()),
        ),
      ),
    );
    await tester.pump();

    expect(find.byKey(const ValueKey('pending-actions-banner')), findsNothing);
    expect(find.byKey(const ValueKey('rooms-tab-pending')), findsOneWidget);
    expect(find.byKey(const ValueKey('rooms-pending-count')), findsOneWidget);
    expect(find.text('1'), findsOneWidget);
    expect(find.byKey(const ValueKey('pending-r-work')), findsOneWidget);
    expect(find.byKey(const ValueKey('pin-r-pin')), findsOneWidget);
    expect(find.byKey(const ValueKey('unread-r-pin')), findsOneWidget);

    final pinY = tester.getTopLeft(find.text('核心置顶群')).dy;
    final workY = tester.getTopLeft(find.byKey(const ValueKey('pending-r-work'))).dy;
    expect(pinY, lessThan(workY), reason: '置顶群应排在普通群前面');

    // 点击独立「待处理」Tab，仅保留存在待处理事项的会话
    await tester.tap(find.byKey(const ValueKey('rooms-tab-pending')));
    await tester.pump();
    expect(find.text('普通工作群'), findsOneWidget);
    expect(find.text('核心置顶群'), findsNothing);

    // 审批解决后仍停留在「待处理」Tab，展示空态且计数徽标消失
    approvalMsg.meta!['decision'] = 'allow';
    state.triggerNotify();
    await tester.pump();
    expect(find.byKey(const ValueKey('rooms-pending-count')), findsNothing);
    expect(find.text('没有待处理的事项'), findsOneWidget);
  });

  testWidgets('输入框支持 @成员补全、/快捷指令与空会话成员点击', (tester) async {
    final group = Room(
      id: 'g-collab',
      name: '研发团队',
      kind: 'group',
      botIds: const ['b1', 'b2'],
      botNames: const ['研发', '设计'],
    );
    final state = _TestAppState()
      ..bots = [
        Bot(id: 'b1', name: '研发', tagline: '写代码'),
        Bot(id: 'b2', name: '设计', tagline: '做界面'),
      ]
      ..rooms = [group]
      ..messages[group.id] = [];
    addTearDown(state.dispose);

    await tester.pumpWidget(
      AppScope(
        state: state,
        child: L10n(
          controller: LocaleController(),
          child: MaterialApp(
            home: SizedBox(
              width: 900,
              height: 700,
              child: ChatScreen(room: group),
            ),
          ),
        ),
      ),
    );
    await tester.pump();

    // 1. 点击空会话成员胶囊 → 插入 @设计
    await tester.tap(find.text('设计'));
    await tester.pump();
    final tf = tester.widget<TextField>(find.byType(TextField));
    expect(tf.controller!.text, contains('@设计 '));

    // 2. 输入 @ → 弹出成员候选面板，点选 研发
    await tester.enterText(find.byType(TextField), '@');
    await tester.pump();
    expect(find.byKey(const ValueKey('composer-palette')), findsOneWidget);
    await tester.tap(
      find.descendant(
        of: find.byKey(const ValueKey('composer-palette')),
        matching: find.text('研发'),
      ),
    );
    await tester.pump();
    expect(tf.controller!.text, '@研发 ');

    // 3. 输入 / → 弹出快捷指令；输入路径 /Users/test → 不误触发
    await tester.enterText(find.byType(TextField), '/');
    await tester.pump();
    expect(find.byKey(const ValueKey('composer-palette')), findsOneWidget);
    await tester.enterText(find.byType(TextField), '/Users/test');
    await tester.pump();
    expect(find.byKey(const ValueKey('composer-palette')), findsNothing);
  });

  testWidgets('桌面悬停引用回复附带引用格式，点击引用条可安全跳转高亮', (tester) async {
    tester.view.physicalSize = const Size(1100, 800);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.reset);

    final group = Room(
      id: 'g-quote',
      name: '讨论群',
      kind: 'group',
      botIds: const ['b1'],
      botNames: const ['架构师'],
    );
    final m1 = Msg(
      id: 'm1',
      roomId: group.id,
      authorType: 'bot',
      authorId: 'b1',
      authorName: '架构师',
      text: '建议先收敛接口契约',
      status: 'done',
      createdAt: 1000,
    );
    final m2 = Msg(
      id: 'm2',
      roomId: group.id,
      authorType: 'bot',
      authorId: 'b1',
      authorName: '架构师',
      text: '已补充到第二版方案',
      status: 'done',
      createdAt: 2000,
      meta: {'re': 'm1', 'reFrom': 'b1'},
    );
    final state = _TestAppState()
      ..bots = [Bot(id: 'b1', name: '架构师')]
      ..rooms = [group]
      ..messages[group.id] = [m1, m2];
    addTearDown(state.dispose);

    await tester.pumpWidget(
      AppScope(
        state: state,
        child: L10n(
          controller: LocaleController(),
          child: MaterialApp(
            home: SizedBox(
              width: 900,
              height: 700,
              child: ChatScreen(room: group),
            ),
          ),
        ),
      ),
    );
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 300));

    // 点击引用条跳转定位不报错
    await tester.tap(find.byType(MsgQuoteStrip).first);
    await tester.pump();
    expect(tester.takeException(), isNull);

    // 桌面鼠标悬停 m1 气泡 → 点引用回复图标
    final mouse = await tester.createGesture(kind: PointerDeviceKind.mouse);
    await mouse.addPointer(location: Offset.zero);
    addTearDown(mouse.removePointer);
    await mouse.moveTo(tester.getCenter(find.text('建议先收敛接口契约').first));
    await tester.pump();

    await tester.tap(find.byIcon(LucideIcons.reply));
    await tester.pump();
    expect(find.byKey(const ValueKey('composer-reply-bar')), findsOneWidget);

    await tester.enterText(find.byType(TextField), '@架构师 同意这个方案');
    await tester.pump();
    await tester.tap(find.byKey(const ValueKey('composer-send')));
    await tester.pump();

    expect(state.sent, isNotEmpty);
    expect(state.sent.single.$2, contains('> 架构师：建议先收敛接口契约'));
    expect(state.sent.single.$2, contains('@架构师 同意这个方案'));
  });
}
