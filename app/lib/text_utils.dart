/// 把 Markdown 压成纯文本，给「列表预览 / 通知 / 单行摘要」这类地方用。
///
/// 列表里出现 `**结论：…` 或者 `| 交付物 | 谁做的 |` 这种裸标记非常难看，
/// 所有"只显示一行"的地方都必须先过这里。
String stripMarkdown(String input) {
  var s = input;

  // 围栏代码块：去掉围栏本身，保留内容
  s = s.replaceAll(RegExp(r'^\s*```[a-zA-Z0-9_+-]*\s*$', multiLine: true), '');
  s = s.replaceAll('```', '');

  // 表格分隔行（| --- | --- |）整行丢掉
  s = s.replaceAll(RegExp(r'^[ \t]*\|?[ \t:|-]*-[ \t:|-]*\|[ \t:|-]*$', multiLine: true), '');
  // 表格数据行 → 用 · 连接单元格
  s = s.replaceAllMapped(RegExp(r'^[ \t]*\|(.+)\|[ \t]*$', multiLine: true), (m) {
    final cells = m
        .group(1)!
        .split('|')
        .map((c) => c.trim())
        .where((c) => c.isNotEmpty && !RegExp(r'^[-: ]+$').hasMatch(c));
    return cells.join(' · ');
  });

  // 标题 / 引用 / 分割线 / 列表符号
  s = s.replaceAll(RegExp(r'^[ \t]{0,3}#{1,6}[ \t]+', multiLine: true), '');
  s = s.replaceAll(RegExp(r'^[ \t]{0,3}>[ \t]?', multiLine: true), '');
  s = s.replaceAll(RegExp(r'^[ \t]*([-*_])[ \t]*\1[ \t]*\1[ \t]*$', multiLine: true), '');
  s = s.replaceAll(RegExp(r'^[ \t]*[-*+][ \t]+', multiLine: true), '');
  s = s.replaceAll(RegExp(r'^[ \t]*\d+[.)][ \t]+', multiLine: true), '');

  // 行内标记
  s = s.replaceAllMapped(RegExp(r'!\[([^\]]*)\]\([^)]*\)'), (m) => m.group(1) ?? '');
  s = s.replaceAllMapped(RegExp(r'\[([^\]]*)\]\([^)]*\)'), (m) => m.group(1) ?? '');
  s = s.replaceAllMapped(RegExp(r'\*\*([^*\n]+)\*\*'), (m) => m.group(1)!);
  s = s.replaceAllMapped(RegExp(r'__([^_\n]+)__'), (m) => m.group(1)!);
  s = s.replaceAllMapped(RegExp(r'~~([^~\n]+)~~'), (m) => m.group(1)!);
  s = s.replaceAllMapped(RegExp(r'`([^`\n]+)`'), (m) => m.group(1)!);
  s = s.replaceAllMapped(RegExp(r'(?<![\w*])\*([^*\n]+)\*(?![\w*])'), (m) => m.group(1)!);
  s = s.replaceAllMapped(RegExp(r'(?<![\w_])_([^_\n]+)_(?![\w_])'), (m) => m.group(1)!);

  // 收尾：换行/多余空白压成一个空格，去掉残留的孤立标记
  s = s.replaceAll(RegExp(r'[ \t]*\n[ \t]*'), ' ');
  s = s.replaceAll(RegExp(r'\s{2,}'), ' ');
  s = s.replaceAll(RegExp(r'^\s*[|·\-\s]+'), '');
  return s.trim();
}

/// 取一段文字的第一行有效内容（用来当摘要）
String firstLine(String input) {
  for (final line in input.split('\n')) {
    final t = stripMarkdown(line);
    if (t.isNotEmpty) return t;
  }
  return '';
}

/// 截断到 max 个字符，超出加省略号
String truncate(String input, int max) {
  if (input.length <= max) return input;
  return '${input.substring(0, max)}…';
}

/// 列表/通知用的一行摘要：先去 markdown，再截断
String preview(String input, int max) => truncate(stripMarkdown(input), max);

/// 把 `@🎨UI设计师` 洗成 `UI设计师`。
///
/// bot 写提及时常把 emoji 夹在 `@` 和名字之间（`@🎨UI设计师`），
/// 直接拿去匹配花名册会对不上，所以统一在这里剥掉 @、空白和 emoji。
String cleanMentionName(String raw) {
  var s = raw.trim();
  if (s.startsWith('@')) s = s.substring(1);
  // 只剥掉**开头**的 emoji/空白/标点（bot 习惯写 `@🎨UI设计师`），
  // 名字内部原样保留 —— 可能有「-」「·」这类合法字符，不能一刀切。
  // 用显式码点范围而不是 \p{Extended_Pictographic}：后者会让分析器误报 valid_regexps。
  s = s.replaceFirst(
    RegExp(r'^[^A-Za-z0-9_\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]+'),
    '',
  );
  return s.trim();
}
