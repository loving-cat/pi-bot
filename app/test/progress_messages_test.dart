import 'package:flutter_test/flutter_test.dart';
import 'package:pi_bot/models.dart';
import 'package:pi_bot/progress_messages.dart';

Msg message(
  int index, {
  int? time,
  bool progress = true,
  String roomId = 'fixture-room',
  Map<String, dynamic>? meta,
}) => Msg(
  id: 'fixture-$index',
  roomId: roomId,
  authorType: 'bot',
  authorName: '验证成员',
  text: '验证回执',
  status: 'done',
  createdAt: time ?? index,
  meta: {'progress': progress, ...?meta},
);

void main() {
  test('完成结果只认明确的结果字段', () {
    expect(
      progressResult(message(1, meta: {'phase': 'done', 'outcome': 'success'})),
      ProgressResult.success,
    );
    expect(
      progressResult(message(2, meta: {'phase': 'done', 'outcome': 'failure'})),
      ProgressResult.failure,
    );
    expect(
      progressResult(message(3, meta: {'phase': 'done'})),
      ProgressResult.ended,
    );
    expect(
      progressResult(message(4, meta: {'phase': 'done', 'outcome': 'unknown'})),
      ProgressResult.ended,
    );
  });

  test('开始和未知阶段不会显示已交付', () {
    expect(
      progressResult(
        message(1, meta: {'phase': 'start', 'outcome': 'success'}),
      ),
      ProgressResult.started,
    );
    expect(progressResult(message(2)), ProgressResult.ended);
    expect(progressResultLabel(ProgressResult.failure), '未完成');
    expect(progressResultLabel(ProgressResult.ended), '已结束');
  });

  test('普通消息断开连续回执，十分钟内的相邻回执保留全部明细', () {
    final groups = groupProgressMessages([
      message(0, progress: false),
      message(1, time: 10),
      message(2, time: 600010),
      message(3, progress: false),
      message(4, time: 600012),
      message(5, time: 1200013),
    ]);
    expect(groups.keys, [1, 4, 5]);
    expect(groups[1]!.map((m) => m.id), ['fixture-1', 'fixture-2']);
    expect(groups[4]!.single.id, 'fixture-4');
    expect(groups[5]!.single.id, 'fixture-5');
  });

  test('跨房间与倒序时间不并入前一组', () {
    final groups = groupProgressMessages([
      message(0, time: 100),
      message(1, time: 90),
      message(2, time: 91, roomId: 'fixture-other'),
    ]);
    expect(groups.keys, [0, 1, 2]);
    expect(groupProgressMessages([]), isEmpty);
  });

  test('同名不同身份保留，重复身份与缺少名字的记录不重复展示', () {
    final senders = progressSenders([
      message(0, meta: {'fromId': 'a', 'fromName': '同名成员'}),
      message(1, meta: {'fromId': 'a', 'fromName': '同名成员'}),
      message(2, meta: {'fromId': 'b', 'fromName': '同名成员'}),
      message(3, meta: {'fromName': '旧记录成员'}),
      message(4, meta: {'fromName': '旧记录成员'}),
      message(5, meta: {'fromId': 'c'}),
    ]);
    expect(senders.map((sender) => sender.id), ['a', 'b', '旧记录成员']);
  });
}
