// R44 打开任务详情后，主对话必须仍能滚动（回归用户报告的交互 bug）。
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  testWidgets('R44a 弹窗关闭后主列表能滚动', (tester) async {
    final controller = ScrollController();
    await tester.pumpWidget(MaterialApp(
      home: Scaffold(
        body: Builder(
          builder: (context) => Column(
            children: [
              TextButton(
                onPressed: () => showDialog<void>(
                  context: context,
                  builder: (_) => const AlertDialog(title: Text('详情')),
                ),
                child: const Text('打开'),
              ),
              Expanded(
                child: ListView.builder(
                  controller: controller,
                  itemCount: 100,
                  itemBuilder: (_, i) => SizedBox(height: 40, child: Text('item $i')),
                ),
              ),
            ],
          ),
        ),
      ),
    ));
    await tester.pump();
    final before = controller.offset;
    await tester.tap(find.text('打开'));
    await tester.pumpAndSettle();
    expect(find.text('详情'), findsOneWidget);
    // 关掉弹窗
    await tester.tapAt(const Offset(5, 5));
    await tester.pumpAndSettle();
    // 主列表必须还能滚
    await tester.drag(find.byType(ListView), const Offset(0, -200));
    await tester.pumpAndSettle();
    expect(controller.offset, greaterThan(before), reason: '关掉详情后主对话必须还能滚');
  });
}