import 'package:flutter_test/flutter_test.dart';
import 'package:pi_bot/models.dart';
import 'package:pi_bot/reconnect_sweep.dart';

/// 断线重连：残留的 streaming 消息必须收掉。
///
/// 用户反馈：模型在跑的时候断网一阵，再连回来继续，
/// 界面上会"一直有三个正在干活，然后又出现新的三个"。
///
/// 根因：三个点画的是消息 status。断线期间服务端把消息收尾并发 msg.done，
/// 但那一刻客户端不在线，事件丢了 —— 本地那条永远停在 streaming。
// 再发一轮，新消息和旧的一起显示。
void main() {
  Msg m(
    String id, {
    String status = 'done',
    String text = '',
    List<ToolStep> steps = const [],
  }) => Msg(
    id: id,
    roomId: 'r1',
    authorType: 'bot',
    authorName: 'bot',
    text: text,
    status: status,
    createdAt: 0,
  )..steps = [...steps];

  group('roomsWithStaleStreaming', () {
    test('没有 streaming 时返回空集', () {
      final cache = <String, List<Msg>>{
        'r1': [m('a'), m('b', text: 'hi')],
      };
      expect(roomsWithStaleStreaming(cache), isEmpty);
    });

    test('有 streaming 的房间被列出来', () {
      final cache = <String, List<Msg>>{
        'r1': [m('a'), m('b', status: 'streaming')],
        'r2': [m('c')],
      };
      expect(roomsWithStaleStreaming(cache), {'r1'});
    });

    test('多个房间都残留时全部列出', () {
      final cache = <String, List<Msg>>{
        'r1': [m('a', status: 'streaming')],
        'r2': [m('b', status: 'streaming')],
        'r3': [m('c')],
      };
      expect(roomsWithStaleStreaming(cache), {'r1', 'r2'});
    });

    test('空缓存不炸', () {
      expect(roomsWithStaleStreaming({}), isEmpty);
    });
  });

  group('clearStaleStreaming', () {
    test('有内容的流式消息标记中断并保留内容', () {
      final list = [m('a', status: 'streaming', text: '已经写了一部分')];
      expect(clearStaleStreaming(list), 1);
      expect(list.single.status, 'error');
      expect(list.single.text, '已经写了一部分', reason: '不能把已写的内容丢掉');
      expect(list.single.error, isNotNull);
    });

    test('空内容的流式消息收成 error 并给原因', () {
      final list = [m('a', status: 'streaming')];
      expect(clearStaleStreaming(list), 1);
      expect(list.single.status, 'error');
      expect(list.single.error, isNotNull);
    });

    test('running 的工具步骤也要收尾 —— 否则圈一直转', () {
      final list = [
        m(
          'a',
          status: 'streaming',
          text: 'x',
          steps: [
            ToolStep(tool: 'bash', detail: 'ls', status: 'running'),
            ToolStep(tool: 'read', detail: 'f', status: 'done'),
          ],
        ),
      ];
      clearStaleStreaming(list);
      expect(list.single.steps[0].status, 'error');
      expect(list.single.steps[1].status, 'done', reason: '已完成的步骤不该被改');
    });

    test('不动非 streaming 的消息', () {
      final list = [m('a'), m('b', text: 'done one')];
      expect(clearStaleStreaming(list), 0);
      expect(list[0].status, 'done');
      expect(list[1].status, 'done');
    });

    test('aborted 的消息不受影响（用户主动终止不是中断）', () {
      final list = [m('a', status: 'aborted', text: 'x')];
      expect(clearStaleStreaming(list), 0);
      expect(list.single.status, 'aborted');
    });
  });
}
