import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:pi_bot/paste_paths.dart';

void main() {
  late Directory tmp;
  late String plain;
  late String spaced;

  setUp(() {
    tmp = Directory.systemTemp.createTempSync('pi_paste_');
    plain = File('${tmp.path}/a.txt').path;
    spaced = File('${tmp.path}/b c.txt').path;
    File(plain).writeAsStringSync('hello');
    File(spaced).writeAsStringSync('world');
  });

  tearDown(() {
    if (tmp.existsSync()) tmp.deleteSync(recursive: true);
  });

  group('整段就是路径', () {
    test('单个路径收成附件，输入框清空', () {
      final r = extractPastedFiles(plain);
      expect(r.files.single.path, plain);
      expect(r.remainingText, isEmpty);
    });

    test('多个路径（多行，资源管理器一次复制多个）', () {
      final r = extractPastedFiles('$plain\n$spaced');
      expect(r.files.length, 2);
      expect(r.remainingText, isEmpty);
    });

    test('被引号包住的路径也能认', () {
      final r = extractPastedFiles('"$spaced"');
      expect(r.files.single.path, spaced);
      expect(r.remainingText, isEmpty);
    });

    test('文件不存在时不认，原文保留', () {
      final missing = '${tmp.path}/nope.txt';
      final r = extractPastedFiles(missing);
      expect(r.files, isEmpty);
      expect(r.remainingText, missing);
    });
  });

  group('路径混在文字里（本次修复的重点）', () {
    test('句子中间的路径被摘走，文字保留', () {
      final r = extractPastedFiles('看下 $plain 这个');
      expect(r.files.single.path, plain);
      expect(r.remainingText, '看下  这个'.replaceAll('  ', ' ').trim());
    });

    test('路径在句尾', () {
      final r = extractPastedFiles('帮我读 $plain');
      expect(r.files.length, 1);
      expect(r.remainingText, '帮我读');
    });

    test('一行里两个路径', () {
      final r = extractPastedFiles('对比 $plain 和 $spaced 的差异');
      expect(r.files.length, 2);
      expect(r.remainingText, contains('对比'));
      expect(r.remainingText, contains('差异'));
    });

    test('带空格的路径用引号包住也能摘出来', () {
      final r = extractPastedFiles('打开 "$spaced" 看看');
      expect(r.files.single.path, spaced);
      expect(r.remainingText, contains('打开'));
      expect(r.remainingText, contains('看看'));
    });

    test('多行：路径行被收走，文字行保留', () {
      final r = extractPastedFiles('第一行说明\n$plain\n第三行');
      expect(r.files.single.path, plain);
      expect(r.remainingText, '第一行说明\n第三行');
    });
  });

  group('不该误伤正常文字', () {
    test('普通句子原样保留', () {
      const text = '这是一段普通的话，没有路径';
      final r = extractPastedFiles(text);
      expect(r.files, isEmpty);
      expect(r.remainingText, text);
    });

    test('斜杠但不是路径（分数、日期）不误伤', () {
      final r = extractPastedFiles('比例是 1/2，日期 2026/11/05');
      expect(r.files, isEmpty);
      expect(r.remainingText, contains('1/2'));
    });

    test('URL 不当本地文件', () {
      final r = extractPastedFiles('看 https://example.com/a/b 这个');
      expect(r.files, isEmpty);
    });

    test('空文本安全', () {
      expect(extractPastedFiles('').files, isEmpty);
      expect(extractPastedFiles('   ').hasFiles, isFalse);
    });

    test('超长文本不解析（避免拖慢输入）', () {
      final long = '$plain ${'x' * 9000}';
      final r = extractPastedFiles(long);
      expect(r.files, isEmpty);
      expect(r.remainingText, long);
    });
  });
}
