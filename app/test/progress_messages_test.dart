import 'package:flutter_test/flutter_test.dart';
import 'package:pi_bot/models.dart';
import 'package:pi_bot/progress_messages.dart';

Msg message(
  int index, {
  int? time,
  bool progress = true,
  String roomId = 'fixture-room',
  String authorName = '验证成员',
  String? authorId,
  Map<String, dynamic>? meta,
}) => Msg(
  id: 'fixture-$index',
  roomId: roomId,
  authorType: 'bot',
  authorId: authorId,
  authorName: authorName,
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

  test('普通消息断开连续回执，窗口内的相邻回执合成一组', () {
    // 窗口从 10 分钟放宽到 6 小时：部门工作常常断断续续跨很久，
    // 10 分钟会把每段都拆成独立气泡，私聊里就成了几十行「收到 X 消息」。
    final groups = groupProgressMessages([
      message(0, progress: false),
      message(1, time: 10),
      message(2, time: 600010),
      message(3, progress: false),
      message(4, time: 600012),
      message(5, time: kProgressGroupGapMs + 600020),
    ]);
    expect(groups.keys, [1, 4, 5]);
    expect(groups[1]!.map((m) => m.id), ['fixture-1', 'fixture-2']);
    expect(groups[4]!.single.id, 'fixture-4');
    expect(groups[5]!.single.id, 'fixture-5', reason: '超出窗口就开新组');
  });

  test('★ 六小时内的部门回执收成一组，不再一行一条', () {
    // 真实场景：40 条回执跨 76 小时，旧的 10 分钟窗口会切出十几条气泡。
    final groups = groupProgressMessages([
      for (var i = 0; i < 8; i++) message(i, time: i * 20 * 60 * 1000),
    ]);
    expect(groups.length, 1, reason: '同一段工作应当收成一条');
    expect(groups[0]!.length, 8);
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

  test('★ 发信人取作者，不取派活人', () {
    // 真实语义：authorName = 干完活交出来的 bot，
    //           meta.fromName = 当初派活的负责人。
    // 弹窗要回答「我收到了谁的消息」，所以必须用作者；
    // 用 fromName 会显示成「收到负责人的消息」—— 方向反了。
    final senders = progressSenders([
      message(0, authorId: 'a', authorName: '成员甲', meta: {'fromId': 'lead', 'fromName': '负责人'}),
      message(1, authorId: 'a', authorName: '成员甲', meta: {'fromId': 'lead', 'fromName': '负责人'}),
      message(2, authorId: 'b', authorName: '成员乙', meta: {'fromId': 'lead', 'fromName': '负责人'}),
    ]);
    expect(senders.map((s) => s.name), ['成员甲', '成员乙']);
  });

  test('同名不同作者不合并，重复作者只出现一次', () {
    final senders = progressSenders([
      message(0, authorId: 'a', authorName: '同名成员'),
      message(1, authorId: 'a', authorName: '同名成员'),
      message(2, authorId: 'b', authorName: '同名成员'),
    ]);
    expect(senders.length, 2);
  });
}