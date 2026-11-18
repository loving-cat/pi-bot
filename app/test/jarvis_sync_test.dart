import 'package:flutter_test/flutter_test.dart';
import 'package:pi_bot/app_state.dart';
import 'package:pi_bot/models.dart';

class _SyncState extends AppState {
  _SyncState() {
    final bot = Bot(id: 'chief', name: 'Pi', emoji: 'π', role: 'main', persona: '');
    final room = Room(id: 'r_chief', name: 'Pi', kind: 'dm', botIds: [bot.id]);
    bots = [bot];
    rooms = [room];
    messages['r_chief'] = [
      Msg(
        id: 'm_key',
        roomId: 'r_chief',
        authorType: 'user',
        authorName: '我',
        text: 'key=sk-${List.filled(24, 'K').join()}',
        status: 'done',
        createdAt: 1000,
      ),
    ];
  }

  @override
  Future<void> loadMessages(String roomId, {bool force = false}) async {}
}

void main() {
  test('AppState 实时同步 Jarvis 变更事件（定时任务、技能库、聊天 Key 打码刷新）', () {
    final state = _SyncState();

    // 1. automation.updated 新增与更新
    state.handleFrameForTest({
      't': 'automation.updated',
      'automation': {
        'id': 'au_1',
        'title': '日报汇总',
        'roomId': 'r_chief',
        'prompt': '汇总今日事项',
        'everyMinutes': 30,
        'enabled': true,
      },
    });
    expect(state.automations.length, 1);
    expect(state.automations.first.title, '日报汇总');

    state.handleFrameForTest({
      't': 'automation.updated',
      'automation': {
        'id': 'au_1',
        'title': '日报汇总（已改）',
        'roomId': 'r_chief',
        'prompt': '汇总今日事项',
        'dailyAt': '18:00',
        'enabled': false,
      },
    });
    expect(state.automations.length, 1);
    expect(state.automations.first.dailyAt, '18:00');
    expect(state.automations.first.enabled, isFalse);

    // 2. automation.deleted 移除
    state.handleFrameForTest({'t': 'automation.deleted', 'id': 'au_1'});
    expect(state.automations, isEmpty);

    // 3. skills.updated 实时刷新技能列表
    state.handleFrameForTest({
      't': 'skills.updated',
      'skills': [
        {'id': 'sk_1', 'title': '快速排障', 'summary': '两步定位', 'howto': '查日志'},
      ],
    });
    expect(state.skillsLoaded, isTrue);
    expect(state.skills.single.title, '快速排障');

    // 4. msg.updated 实时覆盖明文密钥消息气泡
    state.handleFrameForTest({
      't': 'msg.updated',
      'msg': {
        'id': 'm_key',
        'roomId': 'r_chief',
        'authorType': 'user',
        'authorName': '我',
        'text': 'key=sk-KKK…KKKK',
        'status': 'done',
        'createdAt': 1000,
        'meta': {'secretRedacted': true},
      },
    });
    expect(state.messages['r_chief']!.single.text, 'key=sk-KKK…KKKK');

    // 5. models.changed 递增版本号
    final beforeRev = state.connectionsRevision;
    state.handleFrameForTest({'t': 'models.changed'});
    expect(state.connectionsRevision, beforeRev + 1);
  });
}
