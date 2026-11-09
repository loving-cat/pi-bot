// R46 TaskItem 的 createdBy 字段：区分用户建的任务与系统派活流水。
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pi_bot/models.dart';
import 'package:pi_bot/widgets/task_board.dart';

TaskItem t(String id, String title, String status, String createdBy) => TaskItem(
      id: id, title: title, status: status, createdBy: createdBy);

Widget wrap(Widget c) => MaterialApp(home: Scaffold(body: c));

void main() {
  testWidgets('R46b createdBy 能从 JSON 解析', (tester) async {
    final item = TaskItem.fromJson({
      'id': 'x', 'title': 'y', 'status': 'done', 'createdBy': 'dispatch',
    });
    expect(item.createdBy, 'dispatch');
    final manual = TaskItem.fromJson({'id': 'z', 'title': 'w'});
    expect(manual.createdBy, '');
  });
}