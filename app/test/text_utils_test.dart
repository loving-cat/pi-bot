// 列表预览/通知要用的 markdown → 纯文本转换。
// 不转换的话，列表里会直接显示 `**结论：…` 和 `| 交付物 | 谁做的 |` 这类裸标记。
import 'package:flutter_test/flutter_test.dart';
import 'package:pi_bot/text_utils.dart';

void main() {
  _mentionTests();
  group('stripMarkdown', () {
    test('去掉粗体标记', () {
      expect(stripMarkdown('**结论：已交付**'), '结论：已交付');
      expect(stripMarkdown('__加粗__ 文字'), '加粗 文字');
    });

    test('去掉斜体 / 删除线 / 行内代码', () {
      expect(stripMarkdown('这是 *斜体* 和 _下划线斜体_'), '这是 斜体 和 下划线斜体');
      expect(stripMarkdown('~~删掉~~ 保留'), '删掉 保留');
      expect(stripMarkdown('用 `print()` 输出'), '用 print() 输出');
    });

    test('去掉标题标记', () {
      expect(stripMarkdown('# 一级标题'), '一级标题');
      expect(stripMarkdown('### 三级标题\n正文'), '三级标题 正文');
    });

    test('去掉列表符号', () {
      expect(stripMarkdown('- 第一项\n- 第二项'), '第一项 第二项');
      expect(stripMarkdown('1. 甲\n2. 乙'), '甲 乙');
      expect(stripMarkdown('* 星号列表'), '星号列表');
    });

    test('去掉引用和分割线', () {
      expect(stripMarkdown('> 引用内容'), '引用内容');
      expect(stripMarkdown('---'), '');
      expect(stripMarkdown('***'), '');
    });

    test('表格转成 · 连接，不留管道符', () {
      final md = [
        '| 交付物 | 谁做的 | 状态 |',
        '|---|---|---|',
        '| 小红书文案 | 文案编辑 | ✅ 通过 |',
      ].join('\n');
      final out = stripMarkdown(md);
      expect(out.contains('|'), isFalse, reason: '不该残留管道符');
      expect(out.contains('---'), isFalse, reason: '不该残留分隔行');
      expect(out, contains('交付物'));
      expect(out, contains('小红书文案'));
      expect(out, contains('·'));
    });

    test('链接保留文字，图片保留 alt', () {
      expect(stripMarkdown('见 [官方文档](https://example.com)'), '见 官方文档');
      expect(stripMarkdown('![封面](https://example.com/a.png)'), '封面');
    });

    test('代码块去掉围栏但保留内容', () {
      final out = stripMarkdown('```python\nprint(1)\n```');
      expect(out.contains('```'), isFalse);
      expect(out, contains('print(1)'));
    });

    test('多行压成一行，不留多余空白', () {
      expect(stripMarkdown('第一行\n\n\n第二行'), '第一行 第二行');
      expect(stripMarkdown('  前后有空格  '), '前后有空格');
    });

    test('真实场景：部门消息的预览不再有裸标记', () {
      final real =
          '**结论：这一单已经全部交付并通过验收。**\n\n| 交付物 | 谁做的 |\n|---|---|\n| 文案 1 稿 | ✍️文案编辑 |';
      final out = stripMarkdown(real);
      for (final bad in ['**', '|', '---', '##']) {
        expect(out.contains(bad), isFalse, reason: '不该出现 $bad');
      }
      expect(out, contains('结论'));
    });

    test('空输入不炸', () {
      expect(stripMarkdown(''), '');
      expect(stripMarkdown('\n\n'), '');
    });
  });

  group('firstLine / truncate / preview', () {
    test('firstLine 取第一行有效内容', () {
      expect(firstLine('\n\n## 标题\n正文'), '标题');
      expect(firstLine('**职责**：接需求'), '职责：接需求');
      expect(firstLine(''), '');
    });

    test('truncate 超长加省略号', () {
      expect(truncate('abcdef', 3), 'abc…');
      expect(truncate('abc', 10), 'abc');
    });

    test('preview = 去 markdown + 截断', () {
      expect(preview('**很长**的标题内容', 4), '很长的标…');
    });
  });
}

void _mentionTests() {
  test('cleanMentionName 剥掉 @ 和夹在中间的 emoji', () {
    expect(cleanMentionName('@🎨UI设计师'), 'UI设计师');
    expect(cleanMentionName('@后端工程师'), '后端工程师');
    expect(cleanMentionName('@🍊技术负责人'), '技术负责人');
    expect(cleanMentionName('@all'), 'all');
    expect(cleanMentionName('  名字  '), '名字');
  });
}
