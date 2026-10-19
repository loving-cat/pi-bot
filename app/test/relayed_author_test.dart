import 'package:flutter_test/flutter_test.dart';
import 'package:pi_bot/models.dart';
import 'package:pi_bot/screens/chat_screen.dart';

/// 「消息来自 X」的判定。
///
/// 背景：部门群里主控（mainbot）下发任务时，界面在气泡上方挂了
/// 「消息来自 主控」—— 用户会以为这是从别处转进来的二手消息。
/// 实际上主控是全局派活的人，它在哪个会话说话都是**本人**在说。
void main() {
  Room room(List<String> botIds) => Room(
    id: 'r1',
    name: '内容运营二组',
    kind: 'group',
    botIds: botIds,
  );

  Bot bot(String id, {String role = 'member'}) =>
      Bot(id: id, name: id, role: role);

  test('主控不在群里，也不算「消息来自」', () {
    final mainBot = bot('main-1', role: 'main');
    expect(isRelayedAuthor(author: mainBot, room: room(['b1', 'b2'])), isFalse);
  });

  test('群成员自己的消息不算', () {
    expect(
      isRelayedAuthor(author: bot('b1'), room: room(['b1', 'b2'])),
      isFalse,
    );
  });

  test('真·外部成员（被转进群里的）才算', () {
    expect(
      isRelayedAuthor(author: bot('other'), room: room(['b1', 'b2'])),
      isTrue,
    );
  });

  test('作者找不到（已删的 bot / 用户消息）不算', () {
    expect(isRelayedAuthor(author: null, room: room(['b1'])), isFalse);
  });

  test('单聊：房间里的那个 bot 不算', () {
    final dm = Room(id: 'dm1', name: '私聊', kind: 'dm', botIds: ['b1']);
    expect(isRelayedAuthor(author: bot('b1'), room: dm), isFalse);
  });
}
