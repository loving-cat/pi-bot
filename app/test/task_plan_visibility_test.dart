// R42 计划可见性：负责人列的计划必须能从服务端投影到客户端模型。
import 'package:flutter_test/flutter_test.dart';
import 'package:pi_bot/task_run_models.dart';

void main() {
  test('R42a 服务端投影里的 plan 能被解析', () {
    final task = TaskRun.fromJson({
      'id': 'tr_x',
      'state': 'running',
      'phase': 'active',
      'title': '调研同类产品',
      'budget': {'maxRuns': null, 'remaining': null},
      'result': {'prepared': false, 'delivered': false},
      'plan': {
        'steps': [
          {'index': 1, 'title': '拉取竞品清单', 'owner': '竞品研究员', 'status': 'pending'},
          {'index': 2, 'title': '补齐目标用户两列', 'owner': '客户需求研究员', 'status': 'pending'},
        ],
        'at': 1762000000000,
        'revision': 1,
      },
    });
    expect(task.plan, isNotNull);
    expect(task.plan!.count, 2);
    expect(task.plan!.steps.first.title, '拉取竞品清单');
    expect(task.plan!.steps.first.owner, '竞品研究员');
    expect(task.plan!.isEmpty, isFalse);
  });

  test('R42b 没列计划时 plan 为 null（用户能看出"它没列"）', () {
    final task = TaskRun.fromJson({
      'id': 'tr_y',
      'state': 'running',
      'phase': 'active',
      'title': 'x',
      'budget': {'maxRuns': null},
      'result': {'prepared': false, 'delivered': false},
    });
    expect(task.plan, isNull);
  });

  test('R42c 空计划列表也算没列', () {
    final task = TaskRun.fromJson({
      'id': 'tr_z',
      'state': 'running',
      'phase': 'active',
      'title': 'x',
      'budget': {'maxRuns': null},
      'result': {'prepared': false, 'delivered': false},
      'plan': {'steps': [], 'at': 1, 'revision': 1},
    });
    expect(task.plan, isNotNull);
    expect(task.plan!.isEmpty, isTrue);
  });
}
