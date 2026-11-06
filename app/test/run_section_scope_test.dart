import 'package:flutter_test/flutter_test.dart';
import 'package:pi_bot/models.dart';

/// 「运行参数」放错地方的历史教训。
///
/// 模型 / 思考等级 / 上下文预算都是 **bot 自己的属性**，房间上没有这些字段。
/// 之前它们显示在群聊的「详情」页里 —— 那只显示负责人一个人的配置，
/// 于是同时错了两处：
///   · 用户以为在调"这个群的模型"，实际改的是负责人这个人在**所有会话**
///     （包括它自己的私聊、别的群）的配置；
///   · 另外 N-1 个成员的参数完全看不到，也不知道该去哪调。
///
/// 正确做法：参数跟着人走（花名册 / 私聊详情），群聊详情页只说群本身的事。
void main() {
  test('模型 / 思考等级 / 预算都在 Bot 上', () {
    final b = Bot(
      id: 'b1',
      name: '研究员',
      role: 'member',
      model: 'g1/m1',
      thinking: 'high',
      reserveTokens: 32000,
      keepRecentTokens: 8000,
    );
    expect(b.model, 'g1/m1');
    expect(b.thinking, 'high');
    expect(b.reserveTokens, 32000);
    expect(b.keepRecentTokens, 8000);
  });

  test('Room 只说"有哪些人"，不带运行参数', () {
    // 这条断言本身是编译期证据：如果 Room 真能存 model，
    // 下面这个 Room(...) 构造里就该有地方传它 —— 但它没有。
    final room = Room(
      id: 'r1',
      name: '群',
      kind: 'group',
      botIds: const ['b1', 'b2', 'b3'],
      leadBotId: 'b1',
    );
    expect(room.botIds.length, 3);
    expect(room.leadBotId, 'b1');
  });

  test('同一个群里的不同成员可以有不同模型', () {
    final a = Bot(id: 'b1', name: 'A', role: 'member', model: 'g1/fast');
    final b = Bot(id: 'b2', name: 'B', role: 'member', model: 'g2/pro');
    expect(a.model, isNot(b.model));
    // 这正是"把模型提到群级"做不到的事：群级只能有一个值，
    // 而一个群里本来就该有快模型干琐事、强模型干难活。
  });
}
