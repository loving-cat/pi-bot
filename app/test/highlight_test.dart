// 代码高亮的分词器：纯函数，所以直接单测，不起 widget。
import 'package:flutter_test/flutter_test.dart';
import 'package:pi_bot/highlight.dart';

/// 找出某个字符串落在哪种类型上（测试用）
TokKind kindOf(String code, String? lang, String needle) {
  final toks = highlightCode(code, lang);
  for (final t in toks) {
    if (t.text.contains(needle)) return t.kind;
  }
  return TokKind.plain;
}

String joined(String code, String? lang) =>
    highlightCode(code, lang).map((t) => t.text).join();

void main() {
  test('拼回去必须和原文一模一样（分词不能吃掉字符）', () {
    const code = 'const a = "hi"; // 注释\nif (a) { print(a); }\n';
    expect(joined(code, 'dart'), code);
    expect(joined(code, 'python'), code);
    expect(joined(code, '不认识的语言'), code);
    expect(joined('', 'dart'), '');
  });

  test('关键字 / 字符串 / 注释 / 数字各自归位', () {
    const code = 'final x = 42; // 这是注释\nString s = "文本";';
    expect(kindOf(code, 'dart', 'final'), TokKind.keyword);
    expect(kindOf(code, 'dart', '42'), TokKind.number);
    expect(kindOf(code, 'dart', '//'), TokKind.comment);
    expect(kindOf(code, 'dart', '"文本"'), TokKind.str);
  });

  test('# 系语言的注释用 #（不是 //）', () {
    expect(kindOf('# 注释\nx = 1', 'python', '# 注释'), TokKind.comment);
    expect(kindOf('# 注释\nx = 1', 'bash', '# 注释'), TokKind.comment);
    // 同一段代码在 C 系语言里 # 不是注释
    expect(kindOf('#x', 'dart', '#'), isNot(TokKind.comment));
  });

  test('块注释整段是注释（含换行）', () {
    const code = '/* 第一行\n第二行 */\nint a;';
    expect(kindOf(code, 'dart', '第二行'), TokKind.comment);
    expect(kindOf(code, 'dart', 'int'), isNot(TokKind.comment));
  });

  test('带转义的字符串不会提前结束', () {
    const code = r'var a = "he said \"hi\""; var b = 1;';
    final toks = highlightCode(code, 'js');
    final strTok = toks.firstWhere((t) => t.text.startsWith('"he said'));
    expect(strTok.kind, TokKind.str);
    expect(strTok.text, r'"he said \"hi\""', reason: '转义没把字符串提前截断');
    expect(toks.map((t) => t.text).join(), code, reason: '拼得回去');
    expect(kindOf(code, 'js', 'var'), TokKind.keyword);
  });

  test('未闭合的字符串/注释不会把后面的全吃掉（聊天里常被截断）', () {
    expect(kindOf('var a = "没关引号', 'js', 'var'), TokKind.keyword);
    expect(kindOf('/* 没关注释', 'js', '/*'), TokKind.comment);
  });

  test('函数调用和类型名能区分开（一眼看出谁是什么）', () {
    const code = 'Widget build() { return Text("x"); }';
    expect(kindOf(code, 'dart', 'build'), TokKind.fn);
    expect(kindOf(code, 'dart', 'Widget'), TokKind.type);
    expect(kindOf(code, 'dart', 'Text'), TokKind.fn, reason: '后面紧跟 ( 就当调用');
  });

  test('认不出的语言当纯文本 —— 不猜、也不崩', () {
    const code = '这是一段奇怪的代码 123 !@';
    final toks = highlightCode(code, 'brainfuck');
    expect(toks.map((t) => t.text).join(), code, reason: 'generic 也要拼得回去');
    expect(highlightCode(code, null).single.kind, TokKind.plain);
  });

  test('语言别名要认（js/TS/language-dart/带空格）', () {
    expect(normalizeLang('JavaScript'), 'js');
    expect(normalizeLang(' language-dart '), 'dart');
    expect(normalizeLang('TS'), 'js');
    expect(normalizeLang(''), 'plain');
    expect(normalizeLang(null), 'plain');
  });

  test('超长代码不会卡住（聊天里粘一大段是常态）', () {
    final big = 'const a = 1; // x\n' * 400;
    expect(joined(big, 'js'), big);
  });
}
