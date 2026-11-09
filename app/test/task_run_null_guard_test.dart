import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pi_bot/app_state.dart';

import 'package:pi_bot/widgets/task_run_sheet.dart';

/// 取消后的任务：有负责人，但没有子任务摘要。
Map<String, dynamic> cancelledTask({String leadBotName = '商业研究主管'}) => {
  'id': 'tr_probe',
  'roomId': 'r_probe',
  'rootTaskId': 'tr_probe',
  'parentTaskId': null,
  'revision': 1,
  'sequence': 1,
  'storeVersion': 1,
  'state': 'cancelled',
  'stateText': '已取消',
  'title': '探测任务',
  'scope': '',
  'deliverables': <String>[],
  'verificationCount': 0,
  'unmet': <String>[],
  'waiting': null,
  'blockedReason': null,
  'phase': 'needs_user',
  'leadBotName': leadBotName,
  'childrenSummary': null,
  'budget': {'extraRuns': 0, 'maxRuns': null, 'remaining': null},
  'result': null,
  'admissionStatus': 'accepted',
  'updatedAt': 1,
};

void main() {
  testWidgets('★ 有负责人但没有子任务摘要：详情不得抛异常变灰块', (tester) async {
    // 复现用户场景：取消任务后子任务被清空，childrenSummary 变成 null，
    // 但 leadBotName 还在。
    //
    // 详情页的条件是「leadBotName.isNotEmpty || childrenSummary != null」——
    // 或条件成立，进入分支后却无条件 .! 解包 childrenSummary，
    // 于是整块渲染抛异常，Flutter 把它画成灰色错误占位。
    final state = AppState();
    state.taskRuns.applyHello({
      'serverInstanceId': 'probe-server',
      'cursor': 1,
      'taskRuns': [cancelledTask()],
    });
    await tester.pump();

    final task = state.taskRuns.merge.byId('tr_probe');
    expect(task, isNotNull, reason: '任务应当已注入');
    expect(task!.leadBotName.isNotEmpty, isTrue);
    expect(task.childrenSummary, isNull, reason: '这正是触发条件');

    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: SizedBox(
            width: 420,
            height: 700,
            child: TaskRunDetailInline(state: state, taskRunId: 'tr_probe'),
          ),
        ),
      ),
    );
    await tester.pump();

    expect(tester.takeException(), isNull, reason: '渲染不得抛异常');
    // 详情里应当能看到标题，说明整块真的渲染出来了
    expect(find.textContaining('探测任务'), findsWidgets);
  });
}
