import 'package:flutter_test/flutter_test.dart';
import 'package:pi_bot/models.dart';
import 'package:pi_bot/progress_messages.dart';
import 'package:pi_bot/widgets/progress_notice.dart';

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

  test('★ 同一部门、不同派活：仍要合成一组并累加计数（P0-1）', () {
    // 每次派活都是新的 dispatchId，而 done 回执每个 dispatchId 只有 1 条。
    // 以前拿 dispatchId 当断组条件 → 满屏「1 件事」。现在按来源 + 时间窗合并，
    // 新回执到达时计数就地累加。
    final groups = groupProgressMessages([
      receipt(0, time: 0, dispatchId: 'd1'),
      receipt(1, time: 60 * 1000, dispatchId: 'd2'),
      receipt(2, time: 2 * 60 * 1000, dispatchId: 'd3'),
    ]);
    expect(groups.length, 1, reason: '同来源、窗口内、dispatchId 不同也要合并');
    expect(groups[0]!.length, 3, reason: '计数要累加到 3 件事');
  });

  test('★ 中间穿插普通聊天消息必须断组', () {
    // 否则「在研发那边 2 件事」会把用户和 bot 的一段正常对话夹进去。
    final chat = Msg(
      id: 'chat-1',
      roomId: 'dm',
      authorType: 'user',
      authorName: '我',
      text: '在吗',
      status: 'done',
      createdAt: 30 * 1000,
    );
    final groups = groupProgressMessages([
      receipt(0, time: 0),
      chat,
      receipt(1, time: 60 * 1000),
    ]);
    expect(groups.length, 2, reason: '聊天消息要把回执切成两组');
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

  test('★ 弹窗按派活批次分段：dispatchId 变了才算新批次', () {
    // 折叠层不再按 dispatchId 分组，所以「同一次派活 / 下一次派活」的区分
    // 挪到点开的明细里做视觉分段。
    expect(
      startsNewDispatchBatch(receipt(0, dispatchId: 'd1'), receipt(1, dispatchId: 'd1')),
      isFalse,
    );
    expect(
      startsNewDispatchBatch(receipt(0, dispatchId: 'd1'), receipt(1, dispatchId: 'd2')),
      isTrue,
    );
    // 第一条没有前驱：不分段
    expect(startsNewDispatchBatch(null, receipt(0)), isFalse);
    // 老数据没有 dispatchId：不分段（不能凭空多一条缝）
    final legacy = Msg(
      id: 'legacy',
      roomId: 'dm',
      authorType: 'bot',
      authorName: '成员',
      text: '老回执',
      status: 'done',
      createdAt: 1000,
      meta: {'progress': true, 'phase': 'done', 'fromRoomId': 'room-a'},
    );
    expect(startsNewDispatchBatch(receipt(0), legacy), isFalse);
  });
}
