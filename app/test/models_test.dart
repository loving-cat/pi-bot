// 模型层单测：服务端 JSON ↔ App 模型。
//
// 这几条是「引用气泡」和「教它做任务」两条新链路的地基 ——
// 解析错了界面上不会报错，只会安静地什么都不显示，最难查。
import 'package:flutter_test/flutter_test.dart';
import 'package:pi_bot/models.dart';

void main() {
  group('Msg.kind / refs（跨会话引用气泡）', () {
    test('kind=ref + refs → isRef 为真，能拿到收信人和私聊房间', () {
      final m = Msg.fromJson({
        'id': 'm1',
        'roomId': 'r1',
        'authorType': 'bot',
        'authorId': 'b1',
        'kind': 'ref',
        'refs': [
          {'botId': 'b2', 'roomId': 'dm_b2', 'at': 123},
        ],
      });
      expect(m.isRef, isTrue);
      expect(m.refs.length, 1);
      expect(m.refs.first.botId, 'b2');
      expect(m.refs.first.roomId, 'dm_b2');
    });

    test('普通消息没有 kind/refs 字段也不该炸，isRef 为假', () {
      final m = Msg.fromJson({'id': 'm2', 'text': '你好'});
      expect(m.kind, 'text');
      expect(m.refs, isEmpty);
      expect(m.isRef, isFalse);
    });

    test('kind=ref 但 refs 空 → 不算引用（避免画出空气泡）', () {
      final m = Msg.fromJson({'id': 'm3', 'kind': 'ref'});
      expect(m.isRef, isFalse);
    });

    test('refs 里的脏数据被跳过，不整条消息报废', () {
      final m = Msg.fromJson({
        'id': 'm4',
        'kind': 'ref',
        'refs': [
          'not-a-map',
          {'botId': 'b9', 'roomId': 'dm9'},
        ],
      });
      expect(m.refs.length, 1);
      expect(m.refs.first.botId, 'b9');
    });
  });

  group('BotSkill / Bot.skills（教它做一项任务）', () {
    test('Bot.fromJson 能读出 skills', () {
      final b = Bot.fromJson({
        'id': 'b1',
        'name': '文案编辑',
        'skills': [
          {'id': 'sk_1', 'title': '发日报', 'howto': '18:00 整理'},
        ],
      });
      expect(b.skills.length, 1);
      expect(b.skills.first.title, '发日报');
      expect(b.skills.first.howto, '18:00 整理');
    });

    test('没有 skills 字段时是空列表，不是 null', () {
      final b = Bot.fromJson({'id': 'b2', 'name': '后端工程师'});
      expect(b.skills, isEmpty);
    });

    test('BotSkill.toJson 往返不丢字段（教学弹窗保存走这条路）', () {
      final s = BotSkill(id: 'sk_9', title: '改样式', howto: '先看规范');
      final back = BotSkill.fromJson(s.toJson());
      expect(back.id, 'sk_9');
      expect(back.title, '改样式');
      expect(back.howto, '先看规范');
    });
  });
}
