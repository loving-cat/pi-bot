// R46 任务板只显示真实任务，不再把系统派活流水当成任务。
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pi_bot/models.dart';
import 'package:pi_bot/widgets/task_board.dart';

TaskItem t(String id, String title, String status, String createdBy) => TaskItem(
      id: id, title: title, status: status, createdBy: createdBy);

Widget wrap(Widget c) => MaterialApp(home: Scaffold(body: c));

void main() {
  testWidgets('R46a dispatch 流水不出现在任务板里', (tester) async {
    await tester.pumpWidget(wrap(TaskBoardSheet(
      roomName: '测试群',
      tasks: [
        // 200 条系统自动记的派活流水（以前会导致「已完成 130」这种荒谬统计）
        for (var i = 0; i < 200; i++)
          t('d$i', 'bot 回复内容 $i', 'done', 'dispatch'),
        // 用户真正关心的两条
        t('u1', '用户加的任务', 'open', 'device_1'),
        t('u2', '用户在跑的', 'doing', 'device_1'),
      ],
      onToggleDone: (_) {},
      onTogglePin: (_) {},
      onDelete: (_) {},
      onCreate: (_) {},
    )));
    await tester.pump();
    final joined = tester
        .widgetList<Text>(find.byType(Text))
        .map((x) => x.data ?? '')
        .join(' ');
    expect(joined.contains('bot 回复内容'), isFalse,
        reason: 'dispatch 流水是系统内部日志，不该当任务显示');
    expect(joined.contains('用户加的任务'), isTrue);
    expect(joined.contains('已完成 200'), isFalse,
        reason: '统计不能把派活流水算进去');
  });

  testWidgets('R46b createdBy 能从 JSON 解析', (tester) async {
    final item = TaskItem.fromJson({
      'id': 'x', 'title': 'y', 'status': 'done', 'createdBy': 'dispatch',
    });
    expect(item.createdBy, 'dispatch');
    final manual = TaskItem.fromJson({'id': 'z', 'title': 'w'});
    expect(manual.createdBy, '');
  });
}