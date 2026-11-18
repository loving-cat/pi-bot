import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pi_bot/app_state.dart';
import 'package:pi_bot/l10n/l10n.dart';
import 'package:pi_bot/models.dart';
import 'package:pi_bot/scope.dart';
import 'package:pi_bot/screens/chat_screen.dart';
import 'package:pi_bot/widgets/blob_avatar.dart';
import 'package:pi_bot/widgets/message_anchor_rail.dart';
import 'package:shared_preferences/shared_preferences.dart';

class _ScrollTestState extends AppState {
  @override
  Future<void> loadMessages(String roomId, {bool force = false}) async {}

  void replace(String roomId, List<Msg> list) {
    messages[roomId] = list;
    notifyListeners();
  }
}

Room _testRoom() => Room(
  id: 'scroll-room',
  name: '长对话验证',
  kind: 'dm',
  botIds: const ['b1'],
);

List<Msg> _mixedMessages({int count = 100, int longLines = 36}) {
  final roomId = _testRoom().id;
  return List.generate(count, (i) {
    final isLong = i % 5 == 0;
    final text = isLong
        ? List.generate(longLines, (l) => '长消息 $i 第 $l 行代码块内容示例').join('\n')
        : '短消息 $i';
    return Msg(
      id: 'm-$i',
      roomId: roomId,
      authorType: i.isEven ? 'user' : 'bot',
      authorId: i.isEven ? null : 'b1',
      authorName: i.isEven ? '我' : '助手',
      text: text,
      status: 'done',
      createdAt: (i + 1) * 1000,
    );
  });
}

Future<void> _settleInitial(WidgetTester tester, [int frames = 20]) async {
  for (var i = 0; i < frames; i++) {
    await tester.pump(const Duration(milliseconds: 24));
  }
}

Future<void> _mountChat(
  WidgetTester tester,
  _ScrollTestState state, {
  TargetPlatform platform = TargetPlatform.macOS,
}) async {
  final room = state.rooms.first;
  tester.view.physicalSize = const Size(1000, 760);
  tester.view.devicePixelRatio = 1.0;
  addTearDown(tester.view.reset);

  await tester.pumpWidget(
    AppScope(
      state: state,
      child: L10n(
        controller: LocaleController(),
        child: MaterialApp(
          theme: ThemeData(platform: platform),
          home: Scaffold(body: ChatScreen(room: room, embedded: true)),
        ),
      ),
    ),
  );
  await _settleInitial(tester);
}

ScrollController _scrollCtrl(WidgetTester tester) =>
    tester.widget<ListView>(find.byType(ListView).first).controller!;

void main() {
  setUp(() {
    SharedPreferences.setMockInitialValues({});
    BlobAvatar.animationsEnabled = false;
  });

  tearDown(() {
    BlobAvatar.animationsEnabled = true;
  });

  for (final platform in [TargetPlatform.macOS, TargetPlatform.windows]) {
    testWidgets('${platform.name}: 滑块拖出上下极值不越界、不反弹抽搐', (tester) async {
      final state = _ScrollTestState()
        ..bots = [Bot(id: 'b1', name: '助手', role: 'main')]
        ..rooms = [_testRoom()]
        ..messages[_testRoom().id] = _mixedMessages(count: 100, longLines: 30);
      addTearDown(state.dispose);

      await _mountChat(tester, state, platform: platform);
      final ctrl = _scrollCtrl(tester);
      final railRect = tester.getRect(find.byType(MessageAnchorRail));
      expect(ctrl.position.maxScrollExtent, greaterThan(2000));

      // 从底部滑块附近起手，持续拖过顶部边界
      final startPt = Offset(railRect.center.dx, railRect.bottom - 30);
      final gesture = await tester.startGesture(startPt);
      await tester.pump();

      double lastPixels = ctrl.position.pixels;
      for (var step = 1; step <= 14; step++) {
        final y = startPt.dy - step * (railRect.height / 8);
        await gesture.moveTo(Offset(startPt.dx, y));
        await tester.pump(const Duration(milliseconds: 16));
        final p = ctrl.position;
        expect(p.pixels, greaterThanOrEqualTo(p.minScrollExtent));
        expect(p.pixels, lessThanOrEqualTo(p.maxScrollExtent));
        expect(p.pixels, lessThanOrEqualTo(lastPixels + 0.5));
        lastPixels = p.pixels;
      }

      // 在顶部外继续按住拉扯几帧：不能反弹离开顶部
      for (var hold = 0; hold < 5; hold++) {
        await gesture.moveTo(Offset(startPt.dx, railRect.top - 120 - hold * 20));
        await tester.pump(const Duration(milliseconds: 16));
        expect(ctrl.position.pixels, lessThanOrEqualTo(0.5));
      }

      // 再一路拖到底部极值并拉出底边界：不能越界或回弹
      for (var step = 1; step <= 14; step++) {
        final y = railRect.top + step * (railRect.height / 8);
        await gesture.moveTo(Offset(startPt.dx, y));
        await tester.pump(const Duration(milliseconds: 16));
        final p = ctrl.position;
        expect(p.pixels, greaterThanOrEqualTo(p.minScrollExtent));
        expect(p.pixels, lessThanOrEqualTo(p.maxScrollExtent));
        expect(p.pixels, greaterThanOrEqualTo(lastPixels - 0.5));
        lastPixels = p.pixels;
      }

      for (var hold = 0; hold < 5; hold++) {
        await gesture.moveTo(
          Offset(startPt.dx, railRect.bottom + 120 + hold * 20),
        );
        await tester.pump(const Duration(milliseconds: 16));
        final p = ctrl.position;
        expect(p.pixels, greaterThanOrEqualTo(p.minScrollExtent));
        expect(p.pixels, lessThanOrEqualTo(p.maxScrollExtent));
        expect((p.maxScrollExtent - p.pixels).abs(), lessThanOrEqualTo(1.5));
      }

      await gesture.up();
      await _settleInitial(tester, 6);
      expect(
        (ctrl.position.maxScrollExtent - ctrl.position.pixels).abs(),
        lessThanOrEqualTo(1.5),
      );
    });
  }

  testWidgets('长短悬殊消息快速上下拖动滑块严格单调，无中段抽搐', (tester) async {
    final state = _ScrollTestState()
      ..bots = [Bot(id: 'b1', name: '助手', role: 'main')]
      ..rooms = [_testRoom()]
      ..messages[_testRoom().id] = _mixedMessages(count: 100, longLines: 55);
    addTearDown(state.dispose);

    await _mountChat(tester, state, platform: TargetPlatform.macOS);
    final ctrl = _scrollCtrl(tester);
    final railRect = tester.getRect(find.byType(MessageAnchorRail));
    final dx = railRect.center.dx;

    // 先点击轨道 15% 处进入上段，再从该处按下并越过拖拽阈值起手
    final topY = railRect.top + railRect.height * 0.15;
    final bottomY = railRect.top + railRect.height * 0.85;
    await tester.tapAt(Offset(dx, topY));
    await tester.pump(const Duration(milliseconds: 16));

    final gesture = await tester.startGesture(Offset(dx, topY - 24));
    await gesture.moveTo(Offset(dx, topY));
    await tester.pump(const Duration(milliseconds: 16));

    var prev = ctrl.position.pixels;
    const steps = 14;
    // 快速往下拖：每一步都严格单调递增
    for (var i = 1; i <= steps; i++) {
      final y = topY + (bottomY - topY) * (i / steps);
      await gesture.moveTo(Offset(dx, y));
      await tester.pump(const Duration(milliseconds: 16));
      final cur = ctrl.position.pixels;
      expect(cur, greaterThanOrEqualTo(prev - 0.5), reason: '向下拖动禁止回跳');
      prev = cur;
    }

    // 快速往上拖：每一步都严格单调递减
    for (var i = steps - 1; i >= 0; i--) {
      final y = topY + (bottomY - topY) * (i / steps);
      await gesture.moveTo(Offset(dx, y));
      await tester.pump(const Duration(milliseconds: 16));
      final cur = ctrl.position.pixels;
      expect(cur, lessThanOrEqualTo(prev + 0.5), reason: '向上拖动禁止回跳');
      prev = cur;
    }

    await gesture.up();
    await _settleInitial(tester, 4);
  });

  testWidgets('流式内容快速增多期间按住/拖动滑块不抽搐，不被追底抢走', (tester) async {
    final room = _testRoom();
    final state = _ScrollTestState()
      ..bots = [Bot(id: 'b1', name: '助手', role: 'main')]
      ..rooms = [room]
      ..messages[room.id] = _mixedMessages(count: 60, longLines: 16);
    addTearDown(state.dispose);

    await _mountChat(tester, state, platform: TargetPlatform.macOS);
    final ctrl = _scrollCtrl(tester);
    final railRect = tester.getRect(find.byType(MessageAnchorRail));
    final dx = railRect.center.dx;

    // 服务端推入正在流式输出的新消息
    state.handleFrameForTest({
      't': 'msg.new',
      'msg': {
        'id': 'm-live',
        'roomId': room.id,
        'authorType': 'bot',
        'authorId': 'b1',
        'authorName': '助手',
        'text': '开始输出',
        'status': 'streaming',
        'createdAt': 999999,
      },
    });
    await tester.pump();

    // 用户将滑块拖到中段（约 45% 位置）并跨过触控阈值保持按住不动
    final holdY = railRect.top + railRect.height * 0.45;
    await tester.tapAt(Offset(dx, holdY));
    await tester.pump(const Duration(milliseconds: 16));
    final gesture = await tester.startGesture(Offset(dx, holdY - 24));
    await gesture.moveTo(Offset(dx, holdY));
    await tester.pump(const Duration(milliseconds: 16));
    final heldPixels = ctrl.position.pixels;

    // 期间后台高频流式暴增 5 次（每次多 12 行，总高剧烈增加）
    var liveText = '开始输出';
    for (var b = 0; b < 5; b++) {
      liveText = '$liveText\n${List.generate(12, (k) => '流式突发增量 $b-$k').join('\n')}';
      state.handleFrameForTest({
        't': 'msg.delta',
        'roomId': room.id,
        'msgId': 'm-live',
        'text': liveText,
      });
      await tester.pump(const Duration(milliseconds: 16));
      expect(
        (ctrl.position.pixels - heldPixels).abs(),
        lessThan(1.0),
        reason: '手指在中段停住时，后台内容暴增不应拖动当前阅读位置',
      );
    }

    // 随后一边继续暴增流式内容、一边慢慢向下拖动到 75% 处：保持单调推进
    final dragEndY = railRect.top + railRect.height * 0.75;
    var prev = ctrl.position.pixels;
    for (var s = 1; s <= 8; s++) {
      liveText = '$liveText\n${List.generate(10, (k) => '拖动期增量 $s-$k').join('\n')}';
      state.handleFrameForTest({
        't': 'msg.delta',
        'roomId': room.id,
        'msgId': 'm-live',
        'text': liveText,
      });
      final y = holdY + (dragEndY - holdY) * (s / 8);
      await gesture.moveTo(Offset(dx, y));
      await tester.pump(const Duration(milliseconds: 16));
      final cur = ctrl.position.pixels;
      expect(cur, greaterThanOrEqualTo(prev - 0.5));
      prev = cur;
    }

    await gesture.up();
    await _settleInitial(tester, 5);
    // 松手停在中段后仍停在用户阅读处，没被追底拉回底部
    expect(ctrl.position.maxScrollExtent - ctrl.position.pixels, greaterThan(50));
  });
}
