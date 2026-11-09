// R45 右栏内嵌详情：打开任务详情时主对话必须仍能滚动。
//
// 用户原话：「打开右上角任务后 就没法上下滑动主对话渲染的区域了」。
// 根因是 showDialog 的模态屏障吃掉所有手势 —— 改成右栏内嵌后不该再挡。
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  testWidgets('R45a 内嵌详情不遮挡主对话滚动', (tester) async {
    final controller = ScrollController();
    // 模拟布局：左边主对话（可滚），右边内嵌详情（也可滚）
    await tester.pumpWidget(MaterialApp(
      home: Scaffold(
        body: Row(
          children: [
            Expanded(
              child: ListView.builder(
                controller: controller,
                itemCount: 100,
                itemBuilder: (_, i) => SizedBox(height: 40, child: Text('msg $i')),
              ),
            ),
            SizedBox(
              width: 380,
              child: SingleChildScrollView(
                child: Column(
                  children: [
                    for (var i = 0; i < 50; i++)
                      SizedBox(height: 30, child: Text('detail $i')),
                  ],
                ),
              ),
            ),
          ],
        ),
      ),
    ));
    await tester.pump();
    final before = controller.offset;
    // 主对话区域必须能滚（没有被模态屏障挡住）
    await tester.drag(find.byType(ListView), const Offset(0, -200));
    await tester.pumpAndSettle();
    expect(controller.offset, greaterThan(before),
        reason: '内嵌详情不能挡主对话滚动');
  });

  testWidgets('R45b 内嵌详情自己也能滚（内容长时可读全文）', (tester) async {
    await tester.pumpWidget(MaterialApp(
      home: Scaffold(
        body: SizedBox(
          width: 300,
          height: 400,
          child: SingleChildScrollView(
            child: Column(
              children: [
                for (var i = 0; i < 100; i++)
                  SizedBox(height: 30, child: Text('row $i')),
              ],
            ),
          ),
        ),
      ),
    ));
    await tester.pump();
    expect(find.text('row 0'), findsOneWidget);
    // SingleChildScrollView 会保留整棵子树，所以看滚动位置而不是"元素消失"
    final pos = tester
        .state<ScrollableState>(find.byType(Scrollable).first)
        .position;
    final before = pos.pixels;
    await tester.drag(find.byType(SingleChildScrollView), const Offset(0, -300));
    await tester.pumpAndSettle();
    expect(pos.pixels, greaterThan(before), reason: '详情面板内部应能滚动');
  });
}