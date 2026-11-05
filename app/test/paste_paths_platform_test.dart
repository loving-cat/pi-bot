import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:pi_bot/paste_paths.dart';

/// Windows 路径形态的识别。
///
/// 这些用例在 macOS 上也会跑 —— 用 `D:\\...` 这种字符串验证**识别逻辑**，
/// 不依赖真实文件是否存在（asExistingFile 会返回 null，这里只测起始判定）。
///
/// 为什么必须有这组：早先 extractInlinePaths 只认 `/` 和 `~/` 开头，
/// Windows 上「文字里夹路径」一条都识别不出来，而 macOS 单元测试全绿，
/// 只有 CI 跑 Windows 才暴露。
void main() {
  group('路径起始判定', () {
    test('POSIX 绝对路径会被识别为路径起点', () {
      // 不存在也没关系：这里验证的是「有没有去尝试」
      final r = extractPastedFiles('看下 /nonexistent/a.txt 这个');
      // 不存在所以文件为空，但文本会原样保留（没被误删）
      expect(r.files, isEmpty);
      expect(r.remainingText, contains('/nonexistent/a.txt'));
    });

    test('Windows 盘符反斜杠路径被识别（不会当成普通文字）', () {
      const text = r'看下 D:\work\report.txt 这个';
      final r = extractPastedFiles(text);
      // 文件不存在 → 不收；但关键是**没有崩溃、文本保留**
      expect(r.files, isEmpty);
      expect(r.remainingText, contains(r'D:\work\report.txt'));
    });

    test('Windows 盘符正斜杠也算路径', () {
      final r = extractPastedFiles('打开 C:/data/a.csv 看看');
      expect(r.files, isEmpty);
      expect(r.remainingText, contains('C:/data/a.csv'));
    });

    test('UNC 路径 \\\\server\\share 不会让解析崩', () {
      final r = extractPastedFiles(r'从 \\nas\share\a.doc 拿的');
      expect(r.files, isEmpty);
      // 文本仍完整保留
      expect(r.remainingText, contains('nas'));
    });

    test('盘符后面没有分隔符时不当路径（如 "比例 A:1"）', () {
      final r = extractPastedFiles('比例 A:1 和 B:2');
      expect(r.files, isEmpty);
      expect(r.remainingText, contains('A:1'));
    });

    test('单字母开头的普通词不误判', () {
      final r = extractPastedFiles('这是 A 方案，不是 B 方案');
      expect(r.files, isEmpty);
      expect(r.remainingText, '这是 A 方案，不是 B 方案');
    });
  });

  group('真实文件：跨平台', () {
    late Directory tmp;

    setUp(() {
      tmp = Directory.systemTemp.createTempSync('pi_paste_plat_');
    });

    tearDown(() {
      if (tmp.existsSync()) tmp.deleteSync(recursive: true);
    });

    test('当前平台的真实路径能被认出来（macOS/Linux/Windows 各自成立）', () {
      final f = File('${tmp.path}${Platform.pathSeparator}real.txt')
        ..writeAsStringSync('x');
      final r = extractPastedFiles('读一下 ${f.path} 内容');
      expect(r.files.length, 1, reason: '当前平台路径必须能识别：${f.path}');
      expect(r.files.first.path, f.path);
    });

    test('当前平台的多个真实路径在同一行', () {
      final a = File('${tmp.path}${Platform.pathSeparator}a.txt')
        ..writeAsStringSync('a');
      final b = File('${tmp.path}${Platform.pathSeparator}b.txt')
        ..writeAsStringSync('b');
      final r = extractPastedFiles('对比 ${a.path} 和 ${b.path} 的差异');
      expect(r.files.length, 2, reason: '平台=${Platform.operatingSystem}');
    });
  });
}
