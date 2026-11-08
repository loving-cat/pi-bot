// R28 独立评审复核：D块（客户端任务合并与展示逻辑）。
import 'package:flutter_test/flutter_test.dart';
import 'package:pi_bot/task_run_merge.dart';
import 'package:pi_bot/task_run_models.dart';

Map<String, dynamic> _task({
  String id = 'tr_1',
  String? parentTaskId,
  int storeVersion = 1,
  int revision = 1,
  String state = 'running',
  String phase = 'active',
  String roomId = 'r_1',
  String blockedReason = '',
  Map<String, dynamic>? childrenSummary,
  String leadBotName = '',
}) =>
    {
      'id': id,
      'requestId': 'rq_$id',
      'rootTaskId': parentTaskId ?? id,
      'parentTaskId': parentTaskId,
      'revision': revision,
      'sequence': 1,
      'state': state,
      'phase': phase,
      'roomId': roomId,
      'goal': {'requirement': 'x', 'verification': []},
      'progress': {'evidence': [], 'unmet': []},
      'flags': {},
      'openGates': [],
      'attempts': [],
      'budget': {'maxRuns': null, 'usedRuns': 0},
      'blockedReason': blockedReason,
      if (childrenSummary != null) 'childrenSummary': childrenSummary,
      if (leadBotName.isNotEmpty) 'leadBotName': leadBotName,
      'storeVersion': storeVersion,
      'updatedAt': 1,
    };

void main() {
  group('D 块：任务合并', () {
    test('D1 同版本重复事件不重复应用', () {
      final m = TaskRunMerge();
      expect(m.applyEvent({'taskRun': _task(storeVersion: 1)}).changed, isTrue);
      expect(m.applyEvent({'taskRun': _task(storeVersion: 1)}).changed, isFalse);
    });

    test('D2 旧版本事件被拒（不会倒退）', () {
      final m = TaskRunMerge();
      m.applyEvent({'taskRun': _task(storeVersion: 5)});
      expect(m.applyEvent({'taskRun': _task(storeVersion: 3)}).stale, isTrue);
      expect(m.byId('tr_1')!.storeVersion, 5);
    });

    test('D3 跨度大于 1 时报告缺口（用于触发补拉）', () {
      final m = TaskRunMerge();
      m.applyEvent({'taskRun': _task(storeVersion: 1)});
      final r = m.applyEvent({'taskRun': _task(storeVersion: 4)});
      expect(r.gap, isTrue);
    });

    test('D4 快照不会因缺席推定删除', () {
      final m = TaskRunMerge();
      m.applySnapshot({'tasks': [_task(id: 'tr_a', storeVersion: 1), _task(id: 'tr_b', storeVersion: 1)]});
      m.applySnapshot({'tasks': [_task(id: 'tr_a', storeVersion: 2)]});
      expect(m.byId('tr_b'), isNotNull, reason: '快照里没出现的任务不能被当成已删除');
    });
  });

  group('D 块：任务列表只展示根任务', () {
    test('D5 子任务不出现在会话列表', () {
      final m = TaskRunMerge();
      m.applySnapshot({
        'tasks': [
          _task(id: 'tr_root', storeVersion: 1),
          _task(id: 'tr_child', parentTaskId: 'tr_root', storeVersion: 1),
        ],
      });
      final list = m.forRoom('r_1');
      expect(list.length, 1);
      expect(list.first.id, 'tr_root');
    });

    test('D6 子任务能按根查到（详情页展开）', () {
      final m = TaskRunMerge();
      m.applySnapshot({
        'tasks': [
          _task(id: 'tr_root', storeVersion: 1),
          _task(id: 'tr_c1', parentTaskId: 'tr_root', storeVersion: 1),
          _task(id: 'tr_c2', parentTaskId: 'tr_root', storeVersion: 1),
        ],
      });
      expect(m.childrenOf('tr_root').length, 2);
    });

    test('D7 已结束任务默认不出现在列表', () {
      final m = TaskRunMerge();
      m.applySnapshot({'tasks': [_task(id: 'tr_done', state: 'completed', storeVersion: 1)]});
      expect(m.forRoom('r_1').length, 0);
      expect(m.forRoom('r_1', includeDone: true).length, 1);
    });
  });

  group('D 块：状态与进度展示', () {
    test('D8 不限额时额度文案为不限，且不显示 0/0', () {
      final t = TaskRun.fromJson(_task());
      expect(t.budget.maxRuns, isNull);
      expect(t.budgetText, '不限');
    });

    test('D9 有子任务时能拿到成员进度', () {
      final t = TaskRun.fromJson(_task(childrenSummary: {
        'total': 4,
        'done': 2,
        'running': 1,
        'waiting': 1,
        'participants': [
          {'botId': 'b_a', 'name': '竞品研究员', 'state': 'completed', 'done': true},
          {'botId': 'b_b', 'name': '客户需求研究员', 'state': 'running', 'done': false},
        ],
      }));
      expect(t.childrenSummary, isNotNull);
      expect(t.childrenSummary!.total, 4);
      expect(t.childrenSummary!.done, 2);
      expect(t.childrenSummary!.progressText, '2/4 成员已交');
      expect(t.childrenSummary!.participants.length, 2);
      expect(t.childrenSummary!.participants.first.name, '竞品研究员');
    });

    test('D10 受阻原因能从投影读出来（用户要能看懂）', () {
      final t = TaskRun.fromJson(_task(state: 'blocked', phase: 'needs_user', blockedReason: '没有建子任务、没有登记文件'));
      expect(t.phase, 'needs_user');
      expect(t.blockedReason, isNotEmpty);
      expect(t.blockedReason, contains('没有建子任务'));
    });

    test('D11 根任务判定：子任务的 rootTaskId 指向父', () {
      final root = TaskRun.fromJson(_task(id: 'tr_root'));
      final child = TaskRun.fromJson(_task(id: 'tr_c', parentTaskId: 'tr_root'));
      expect(root.isRoot, isTrue);
      expect(child.isRoot, isFalse);
      expect(child.rootTaskId, 'tr_root');
    });
  });
}
