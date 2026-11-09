import 'package:flutter_test/flutter_test.dart';
import 'package:pi_bot/models.dart';
import 'package:pi_bot/widgets/progress_notice.dart';

Msg receipt(String id, {String? re}) => Msg(
  id: id,
  roomId: 'r1',
  authorType: 'bot',
  authorId: 'b_$id',
  authorName: '成员$id',
  text: '回执 $id',
  status: 'done',
  createdAt: 1,
  meta: {'progress': true, 'phase': 'done', if (re != null) 're': re},
);

/// 回执弹窗必须把每一条都渲染出来，一条都不能凭空消失。
void main() {
  test('★ 循环引用不能让消息消失', () {
    // A.re = B 且 B.re = A：两条都进不了 roots（各自都有 re），
    // 老实现下整个弹窗渲染出 0 条 —— 没有报错，只是消息不见了。
    final layout = threadLayout([
      receipt('A', re: 'B'),
      receipt('B', re: 'A'),
    ]);
    expect(layout.length, 2, reason: '两条都得出现');
  });

  test('★ 循环 + 正常根，全部渲染', () {
    final layout = threadLayout([
      receipt('R'),
      receipt('A', re: 'B'),
      receipt('B', re: 'A'),
    ]);
    expect(layout.length, 3);
  });

  test('正常引用链保持缩进层级', () {
    final layout = threadLayout([
      receipt('R'),
      receipt('A', re: 'R'),
      receipt('B', re: 'A'),
    ]);
    expect(layout.length, 3);
    expect(layout[0].depth, 0, reason: '根不缩进');
    expect(layout[1].depth, 1, reason: '直接回应缩进一层');
    expect(layout[2].depth, 2, reason: '再回应缩进两层');
  });
}