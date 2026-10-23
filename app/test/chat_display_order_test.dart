import 'package:flutter_test/flutter_test.dart';
import 'package:pi_bot/models.dart';
import 'package:pi_bot/screens/chat_screen.dart';

Msg _m(String id, {bool streaming = false, String text = ''}) => Msg(
  id: id,
  roomId: 'r1',
  authorType: 'bot',
  authorName: 'bot',
  text: text,
  status: streaming ? 'streaming' : 'done',
  createdAt: 1,
);

void main() {
  test('★ 还在思考的占位（streaming 且无字）统一排到列表最底部', () {
    final ordered = displayOrderMsgs([
      _m('a', streaming: true), // 先派、还在想
      _m('b', text: '已经产出的大段内容'), // 后派、先做完
      _m('c', streaming: true), // 还在想
      _m('d', text: '另一条完成内容'),
      _m('e', streaming: true, text: '开始输出了'), // 有字的不算"还在思考"
    ]);
    expect(ordered.map((m) => m.id).toList(), ['b', 'd', 'e', 'a', 'c']);
  });
}
