import 'dart:async';

import 'package:flutter/gestures.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pi_bot/app_state.dart';
import 'package:pi_bot/models.dart';
import 'package:pi_bot/scope.dart';
import 'package:pi_bot/screens/chat_screen.dart';
import 'package:pi_bot/widgets/blob_avatar.dart';

final _room = Room(
  id: 'fixture-room',
  name: '验证会话',
  kind: 'dm',
  botIds: const [],
);

Msg _message(int index, {String? text, String? roomId}) => Msg(
  id: 'fixture-$index',
  roomId: roomId ?? _room.id,
  authorType: 'user',
  authorName: '验证用户',
  text: text ?? '验证消息 $index',
  status: 'done',
  createdAt: index + 1,
);

class _ChatState extends AppState {
  _ChatState({this.delayedLoad}) {
    rooms = [_room];
  }

  final Completer<List<Msg>>? delayedLoad;

  @override
  Future<void> loadMessages(String roomId, {bool force = false}) async {
    if (delayedLoad != null && !messages.containsKey(roomId)) {
      replace(roomId, await delayedLoad!.future);
    }
  }

  void replace(String roomId, List<Msg> list) {
    messages[roomId] = list;
    notifyListeners();
  }
}

Future<void> _frames(WidgetTester tester, [int count = 20]) async {
  for (var i = 0; i < count; i++) {
    await tester.pump(const Duration(milliseconds: 30));
  }
}

Future<void> _showChat(
  WidgetTester tester,
  _ChatState state, {
  Room? room,
  TargetPlatform? platform,
}) async {
  final selected = room ?? _room;
  await tester.pumpWidget(
    AppScope(
      state: state,
      child: MaterialApp(
        theme: platform == null ? null : ThemeData(platform: platform),
        home: ChatScreen(key: ValueKey(selected.id), room: selected),
      ),
    ),
  );
}

ScrollController _controller(WidgetTester tester) =>
    tester.widget<ListView>(find.byType(ListView).first).controller!;

void _expectAtBottom(WidgetTester tester) {
  final position = _controller(tester).position;
  expect(position.maxScrollExtent - position.pixels, lessThanOrEqualTo(1));
}

_ChatState _cached() =>
    _ChatState()..messages[_room.id] = List.generate(60, _message);

void main() {
  setUp(() => BlobAvatar.animationsEnabled = false);
  tearDown(() => BlobAvatar.animationsEnabled = true);

  testWidgets('缓存长会话首次挂载后显示最新消息', (tester) async {
    final state = _cached();
    addTearDown(state.dispose);
    await _showChat(tester, state);
    await _frames(tester);

    expect(_controller(tester).position.maxScrollExtent, greaterThan(1000));
    _expectAtBottom(tester);
    expect(find.text('验证消息 59'), findsOneWidget);
  });

  testWidgets('空会话异步加载历史后首次追底', (tester) async {
    final loaded = Completer<List<Msg>>();
    final state = _ChatState(delayedLoad: loaded);
    addTearDown(state.dispose);
    await _showChat(tester, state);
    await tester.pump();
    expect(find.byType(ListView), findsNothing);

    loaded.complete(List.generate(60, _message));
    await _frames(tester);
    _expectAtBottom(tester);
    expect(find.text('验证消息 59'), findsOneWidget);
  });

  testWidgets('补跳期间上翻会取消旧任务，新消息不抢回底部', (tester) async {
    final state = _cached();
    addTearDown(state.dispose);
    await _showChat(tester, state);
    await _frames(tester);
    state.replace(_room.id, [...state.messages[_room.id]!, _message(60)]);
    await tester.pump();
    _controller(tester).jumpTo(0);
    await _frames(tester, 5);
    expect(_controller(tester).offset, 0);

    state.replace(_room.id, [...state.messages[_room.id]!, _message(61)]);
    await _frames(tester);
    expect(_controller(tester).offset, 0);
  });

  testWidgets('手动回到近底部恢复跟随并清除未读提示', (tester) async {
    final state = _cached();
    addTearDown(state.dispose);
    await _showChat(tester, state);
    await _frames(tester);
    final scroll = _controller(tester);
    scroll.jumpTo(0);
    await tester.pump();
    state.replace(_room.id, [...state.messages[_room.id]!, _message(60)]);
    await tester.pump();
    expect(find.byTooltip('回到最新（下面还有 1 条）'), findsOneWidget);

    scroll.jumpTo(scroll.position.maxScrollExtent - 50);
    await _frames(tester);
    _expectAtBottom(tester);
    expect(find.byTooltip('回到最新（下面还有 1 条）'), findsNothing);
    state.replace(_room.id, [...state.messages[_room.id]!, _message(61)]);
    await _frames(tester);
    _expectAtBottom(tester);
  });

  testWidgets('回到最新按钮恢复追底，动画被上翻打断后不再补跳', (tester) async {
    final state = _cached();
    addTearDown(state.dispose);
    await _showChat(tester, state);
    await _frames(tester);
    final scroll = _controller(tester);
    scroll.jumpTo(0);
    await tester.pump();
    await tester.tap(find.byTooltip('回到最新'));
    await _frames(tester);
    _expectAtBottom(tester);

    scroll.jumpTo(0);
    await tester.pump();
    await tester.tap(find.byTooltip('回到最新'));
    await tester.pump();
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 60));
    expect(scroll.offset, greaterThan(0));
    scroll.jumpTo(0);
    await _frames(tester);
    expect(scroll.offset, 0);
  });

  testWidgets('用户拖动上翻可以中断动画追底', (tester) async {
    final state = _cached();
    addTearDown(state.dispose);
    await _showChat(tester, state);
    await _frames(tester);
    final scroll = _controller(tester);
    scroll.jumpTo(0);
    await tester.pump();
    await tester.tap(find.byTooltip('回到最新'));
    await tester.pump();
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 60));
    expect(scroll.offset, greaterThan(0));
    await tester.drag(find.byType(ListView).first, const Offset(0, 300));
    await _frames(tester);
    expect(scroll.position.maxScrollExtent - scroll.offset, greaterThan(140));
    expect(find.byTooltip('回到最新'), findsOneWidget);
  });

  testWidgets('没有拖拽信息的滚轮上翻也取消待执行补跳', (tester) async {
    final state = _cached();
    addTearDown(state.dispose);
    await _showChat(tester, state);
    await _frames(tester);
    state.replace(_room.id, [...state.messages[_room.id]!, _message(60)]);
    await tester.pump();
    await tester.sendEventToBinding(
      PointerScrollEvent(
        position: tester.getCenter(find.byType(ListView).first),
        scrollDelta: const Offset(0, -300),
      ),
    );
    final afterWheel = _controller(tester).offset;
    await _frames(tester);
    expect(_controller(tester).offset, afterWheel);
    expect(
      _controller(tester).position.maxScrollExtent - afterWheel,
      greaterThan(140),
    );
    expect(find.byTooltip('回到最新'), findsOneWidget);
  });

  for (final platform in [TargetPlatform.windows, TargetPlatform.macOS]) {
    testWidgets('${platform.name} 底部继续向下拖动后仍跟随新消息', (tester) async {
      final state = _cached();
      addTearDown(state.dispose);
      await _showChat(tester, state, platform: platform);
      await _frames(tester);
      final scroll = _controller(tester);
      expect(
        scroll.position.physics,
        platform == TargetPlatform.windows
            ? isA<ClampingScrollPhysics>()
            : isA<BouncingScrollPhysics>(),
      );
      await tester.drag(find.byType(ListView).first, const Offset(0, -250));
      await _frames(tester);
      _expectAtBottom(tester);

      state.replace(_room.id, [
        ...state.messages[_room.id]!,
        _message(60, text: '新的长回复\n' * 15),
      ]);
      await _frames(tester);
      _expectAtBottom(tester);
      expect(find.byTooltip('回到最新'), findsNothing);
    });

    testWidgets('${platform.name} 小幅上翻结束不恢复跟随', (tester) async {
      final state = _cached();
      addTearDown(state.dispose);
      await _showChat(tester, state, platform: platform);
      await _frames(tester);
      final gesture = await tester.startGesture(
        tester.getCenter(find.byType(ListView).first),
      );
      await gesture.moveBy(const Offset(0, 70));
      await tester.pump(const Duration(seconds: 1));
      await gesture.up();
      await _frames(tester);
      final scroll = _controller(tester);
      final away = scroll.position.maxScrollExtent - scroll.offset;
      expect(away, greaterThan(1));
      expect(away, lessThan(140));
      final afterUser = scroll.offset;

      state.replace(_room.id, [
        ...state.messages[_room.id]!,
        _message(60, text: '另一条长回复\n' * 15),
      ]);
      await _frames(tester);
      expect(scroll.offset, afterUser);
    });
  }

  testWidgets('不同高度消息与正文增减后仍保持跟随', (tester) async {
    final state = _ChatState()
      ..messages[_room.id] = List.generate(
        100,
        (index) => _message(
          index,
          text: index < 60 ? '短消息 $index' : ('较长消息 $index\n' * 10),
        ),
      );
    addTearDown(state.dispose);
    await _showChat(tester, state);
    await _frames(tester, 30);
    _expectAtBottom(tester);

    final previous = state.messages[_room.id]!;
    state.replace(_room.id, [
      ...previous.take(previous.length - 1),
      _message(99, text: '流式新增正文\n' * 35),
    ]);
    await _frames(tester);
    _expectAtBottom(tester);
    state.replace(_room.id, [
      ...previous.take(previous.length - 1),
      _message(99, text: '收起的正文'),
    ]);
    await _frames(tester);
    _expectAtBottom(tester);
    expect(find.byTooltip('回到最新'), findsNothing);
  });

  testWidgets('有待执行回调时切房间或销毁不会操作旧列表', (tester) async {
    final state = _cached();
    final second = Room(
      id: 'fixture-second',
      name: '第二会话',
      kind: 'dm',
      botIds: const [],
    );
    state.rooms = [_room, second];
    state.messages[second.id] = List.generate(
      70,
      (index) => _message(index, roomId: second.id),
    );
    addTearDown(state.dispose);
    await _showChat(tester, state);
    state.replace(_room.id, [...state.messages[_room.id]!, _message(60)]);
    await tester.pump();
    await _showChat(tester, state, room: second);
    await _frames(tester);
    _expectAtBottom(tester);
    expect(tester.takeException(), isNull);

    state.replace(second.id, [
      ...state.messages[second.id]!,
      _message(70, roomId: second.id),
    ]);
    await tester.pump();
    await tester.pumpWidget(const SizedBox.shrink());
    await _frames(tester);
    expect(tester.takeException(), isNull);
  });
}
