// Markdown 渲染回归测试。
// 之前踩过的坑：表格单元格用了纯 Text，模型写在单元格里的 **加粗** / `代码` 会原样漏出来。
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pi_bot/widgets/md_text.dart';

/// 把渲染树里所有 RichText 的纯文本拼起来（忽略样式，只看"漏没漏标记"）
String renderedPlainText(WidgetTester tester) {
  final buffer = StringBuffer();
  for (final w in tester.widgetList<RichText>(find.byType(RichText))) {
    buffer.write(w.text.toPlainText());
    buffer.write('\n');
  }
  return buffer.toString();
}

Future<void> pumpMd(WidgetTester tester, String md) async {
  await tester.pumpWidget(
    MaterialApp(
      home: Scaffold(
        body: SingleChildScrollView(
          child: MdText(md, selectable: false),
        ),
      ),
    ),
  );
  await tester.pumpAndSettle();
}

void main() {
  testWidgets('表格单元格里的加粗要渲染，不能漏出 ** 标记', (tester) async {
    final md = [
      '| 成员 | 分工 |',
      '|---|---|',
      '| 🧭 技术负责人（**负责人**） | 拆活、派活 |',
    ].join('\n');
    await pumpMd(tester, md);
    final plain = renderedPlainText(tester);
    expect(plain.contains('**'), isFalse, reason: '单元格里的 ** 应该被吃掉');
    expect(plain, contains('技术负责人'));
    expect(plain, contains('负责人'));
  });

  testWidgets('表格单元格里的行内代码要渲染', (tester) async {
    await pumpMd(tester, '| 命令 | 说明 |\n|---|---|\n| `npm test` | 跑测试 |');
    final plain = renderedPlainText(tester);
    expect(plain.contains('`'), isFalse, reason: '反引号应该被吃掉');
    expect(plain, contains('npm test'));
  });

  testWidgets('表格里的链结保留文字', (tester) async {
    await pumpMd(tester, '| 文档 |\n|---|\n| [官方文档](https://example.com) |');
    final plain = renderedPlainText(tester);
    expect(plain, contains('官方文档'));
    expect(plain.contains('https://example.com'), isFalse, reason: 'URL 不该直接显示');
  });

  testWidgets('数据行多出来的空单元格不该产生空列', (tester) async {
    // 表头 3 列，数据行末尾多一个空单元格
    const md = '| A | B | C |\n|---|---|---|\n| 1 | 2 | 3 | |';
    await pumpMd(tester, md);
    final plain = renderedPlainText(tester);
    expect(plain, contains('A'));
    expect(plain, contains('3'));
    expect(plain.contains('**'), isFalse);
    expect(plain.contains('|'), isFalse, reason: '不该残留管道符');
  });

  testWidgets('没有表格时也不残留裸标记', (tester) async {
    await pumpMd(tester, '# 标题\n\n- 一项\n- 二项\n\n**加粗** 和 `代码`');
    final plain = renderedPlainText(tester);
    for (final bad in ['**', '##', '- 一项']) {
      expect(plain.contains(bad), isFalse, reason: '不该出现 $bad');
    }
    expect(plain, contains('标题'));
    expect(plain, contains('加粗'));
  });
}
