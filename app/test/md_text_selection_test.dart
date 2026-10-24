import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pi_bot/widgets/md_text.dart';

void main() {
  testWidgets('★ 整条消息只有一个 SelectionArea（跨段拖选 + ⌘C 复制）', (tester) async {
    await tester.pumpWidget(
      const MaterialApp(
        home: Scaffold(
          body: MdText(
            '第一段内容\n\n第二段内容\n\n- 列表一\n- 列表二\n\n| A | B |\n| - | - |\n| 1 | 2 |',
          ),
        ),
      ),
    );
    await tester.pump();

    // 每个段落/列表项/表格单元格各一个 SelectionArea 会让选中断成多截。
    expect(find.byType(SelectionArea), findsOneWidget);
  });
}
