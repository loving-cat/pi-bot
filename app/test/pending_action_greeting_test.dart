import 'package:flutter_test/flutter_test.dart';
import 'package:pi_bot/app_state.dart';
import 'package:pi_bot/models.dart';
import 'package:pi_bot/widgets/room_pending_banner.dart';
import 'package:shared_preferences/shared_preferences.dart';

Msg askMsg(String id, {String text = '你现在想做什么？', Map<String, dynamic>? meta}) => Msg(
      id: id,
      roomId: 'dm-1',
      authorType: 'bot',
      authorId: 'b1',
      authorName: '榜单撰写',
      text: text,
      status: 'done',
      kind: 'ask',
      createdAt: 1000,
      meta: meta ?? {'askId': 'ask-1', 'options': []},
    );

Msg botMsg(String id, String text) => Msg(
      id: id,
      roomId: 'dm-1',
      authorType: 'bot',
      authorId: 'b1',
      authorName: '榜单撰写',
      text: text,
      status: 'done',
      createdAt: 900,
    );

Msg userMsg(String id, String text) => Msg(
      id: id,
      roomId: 'dm-1',
      authorType: 'user',
      authorId: null,
      authorName: '我',
      text: text,
      status: 'done',
      createdAt: 1100,
    );

Room dm({Msg? last}) => Room(
      id: 'dm-1',
      name: '榜单撰写',
      kind: 'dm',
      botIds: const ['b1'],
      lastMessageAt: 1000,
      lastMessage: last,
    );

void main() {
  setUp(() => SharedPreferences.setMockInitialValues({}));

  test('首开私聊的开场问候 + 询问卡片不算「待你处理」', () {
    final state = AppState();
    addTearDown(state.dispose);
    final room = dm();
    state.messages[room.id] = [
      botMsg('m1', '我是榜单撰写，负责整理和建榜。你现在想做什么？'),
      askMsg('m2'),
    ];
    expect(
      detectRoomPendingAction(state, room),
      isNull,
      reason: '用户还没说过话，这是 bot 刚坐下开口，不该挂待回复',
    );
  });

  test('聊过一轮之后 bot 再问，就算「待你处理」', () {
    final state = AppState();
    addTearDown(state.dispose);
    final room = dm();
    state.messages[room.id] = [
      botMsg('m1', '我是榜单撰写，负责整理和建榜。'),
      askMsg('m2', text: '开新榜单还是续做现有的？'),
      userMsg('m3', '先看看数据'),
      askMsg('m4', text: '要 A 股还是美股？'),
    ];
    final hit = detectRoomPendingAction(state, room);
    expect(hit, isNotNull);
    expect(hit!.kind, PendingActionKind.ask);
    expect(hit.summary, contains('A 股'));
  });

  test('开场轮次标记过 opening 的问句也不弹（老数据兜底）', () {
    final state = AppState();
    addTearDown(state.dispose);
    final room = dm();
    state.messages[room.id] = [
      botMsg('m1', '我是榜单撰写。'),
      userMsg('m2', '你好'),
      askMsg('m3', meta: {'askId': 'a', 'opening': true}),
    ];
    expect(detectRoomPendingAction(state, room), isNull);
  });

  test('审批与确认不受影响，照常计入待处理', () {
    final state = AppState();
    addTearDown(state.dispose);
    final room = dm();
    state.messages[room.id] = [
      Msg(
        id: 'ap',
        roomId: room.id,
        authorType: 'bot',
        authorId: 'b1',
        authorName: '榜单撰写',
        text: '要执行 git push 吗',
        status: 'done',
        kind: 'approval',
        createdAt: 1200,
        meta: {'approvalId': 'ap-1', 'summary': 'git push origin main'},
      ),
    ];
    final hit = detectRoomPendingAction(state, room);
    expect(hit, isNotNull);
    expect(hit!.kind, PendingActionKind.approval);
    expect(hit.actionId, 'ap-1');
  });

  test('已回答过的 ask 不计入', () {
    final state = AppState();
    addTearDown(state.dispose);
    final room = dm();
    state.messages[room.id] = [
      userMsg('m0', '早'),
      askMsg('m1', meta: {'askId': 'a', 'answer': 'A 股'}),
    ];
    expect(detectRoomPendingAction(state, room), isNull);
  });
}
