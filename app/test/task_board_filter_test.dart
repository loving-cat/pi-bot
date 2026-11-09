// R46 TaskItem 的 createdBy 字段：区分用户建的任务与系统派活流水。
import 'package:flutter_test/flutter_test.dart';
import 'package:pi_bot/models.dart';

void main() {
  test('createdBy 能从 JSON 解析', () {
    final item = TaskItem.fromJson({
      'id': 'x', 'title': 'y', 'status': 'done', 'createdBy': 'dispatch',
    });
    expect(item.createdBy, 'dispatch');
  });

  test('没有 createdBy 时为空串（用户自己建的）', () {
    final manual = TaskItem.fromJson({'id': 'z', 'title': 'w'});
    expect(manual.createdBy, '');
  });
}