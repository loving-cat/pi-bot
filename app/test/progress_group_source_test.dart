import 'package:flutter_test/flutter_test.dart';
import 'package:pi_bot/models.dart';
import 'package:pi_bot/progress_messages.dart';

Msg receipt(
  int index, {
  int? time,
  String fromRoomId = 'room-a',
  String dispatchId = 'dispatch-1',
}) => Msg(
  id: 'r$index',
  roomId: 'dm',
  authorType: 'bot',
  authorName: '成员',
  text: '回执',
  status: 'done',
  createdAt: time ?? index * 1000,
  meta: {
    'progress': true,
    'phase': 'done',
    'fromRoomId': fromRoomId,
    'dispatchId': dispatchId,
  },
);

void main() {
  test('★ 不同部门的事件不能被并成一条', () {
    // bot 同时挂「研发」「市场」：09:00 在研发交付、13:00 在市场交付。
    // 4 小时 < 6 小时窗口，会并成一条 —— 标题只取首条部门，
    // 显示「在「研发」那边 2 件事」，但明细第二条写的是「市场」。
    // 标题和内容自相矛盾。
    final groups = groupProgressMessages([
      receipt(0, time: 0, fromRoomId: 'dept-rnd'),
      receipt(1, time: 4 * 3600 * 1000, fromRoomId: 'dept-market'),
    ]);
    expect(groups.length, 2, reason: '来源不同必须断组');
  });

  test('★ 不同派活（dispatchId 不同）也不能并', () {
    final groups = groupProgressMessages([
      receipt(0, time: 0, dispatchId: 'd1'),
      receipt(1, time: 60 * 1000, dispatchId: 'd2'),
    ]);
    expect(groups.length, 2);
  });

  test('同一来源、同一派活的连续回执仍然收成一条', () {
    // 6 小时窗口的意义就在这里：部门工作断断续续跨很久，
    // 但要收成一条避免私聊里一长串「收到 X 消息」。
    final groups = groupProgressMessages([
      receipt(0, time: 0),
      receipt(1, time: 2 * 3600 * 1000),
      receipt(2, time: 5 * 3600 * 1000),
    ]);
    expect(groups.length, 1);
    expect(groups[0]!.length, 3);
  });

  test('超窗口仍然断组', () {
    final groups = groupProgressMessages([
      receipt(0, time: 0),
      receipt(1, time: kProgressGroupGapMs + 1000),
    ]);
    expect(groups.length, 2);
  });
}
