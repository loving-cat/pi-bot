import 'package:characters/characters.dart';

import 'text_utils.dart';

enum MarkdownInlineKind {
  plain,
  code,
  strong,
  strike,
  link,
  url,
  emphasis,
  mention,
  email,
}

/// 行内内容的可见文字、类型，以及显式链接的目标。
class MarkdownInlineToken {
  const MarkdownInlineToken(this.kind, this.text, {this.target});

  final MarkdownInlineKind kind;
  final String text;
  final String? target;
}

const _emailAtom = r"[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+";
const _emailPattern =
    r"(?<![A-Za-z0-9.!#$%&'*+/=?^_`{|}~-])"
    '$_emailAtom(?:\\.$_emailAtom)*'
    r'@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?'
    r'(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)*'
    r'\.[A-Za-z]{2,63}(?![A-Za-z0-9_-])';
final _email = RegExp(
  '^$_emailPattern'
  r'$',
);
final _code = RegExp(r'^(`+)([^\n]*?)\1$');
final _link = RegExp(r'^\[([^\]]+)\]\(([^)\s]+)\)$');

/// 解析行内标记；代码、显式链接和网址优先于裸邮箱与成员提及。
List<MarkdownInlineToken> markdownInlineTokens(
  String source, {
  Iterable<String> mentions = const [],
}) {
  final mentionAlt = mentions
      .where((name) => name.trim().isNotEmpty)
      .map(RegExp.escape)
      .join('|');
  final pattern = RegExp(
    r'(`+)([^\n]*?)\1'
    r'|`+[^\n]*$'
    r'|\*\*[^*\n]+\*\*'
    r'|~~[^~\n]+~~'
    r'|\[[^\]\n]+\]\([^)\s]+\)'
    r'|\[[^\]\n]*\](?:\([^\n)]*)?$'
    r'|https?://[^\s<>`\u3002\uff0c\uff1b\uff1a\uff09)]+'
    '|$_emailPattern'
    r'|(?<![\w*])\*[^*\n]+\*(?![\w*])'
    r'|(?<![\w_])_[^_\n]+_(?![\w_])'
    r'|@(?:all|全体|所有人|大家|全员)'
    '|@[\\s\\p{Extended_Pictographic}\\uFE0F\\u200D]*'
    '(?:${mentionAlt.isEmpty ? '(?!)' : mentionAlt})',
    unicode: true,
  );
  final tokens = <MarkdownInlineToken>[];
  var offset = 0;
  for (final match in pattern.allMatches(source)) {
    if (match.start > offset) {
      tokens.add(
        MarkdownInlineToken(
          MarkdownInlineKind.plain,
          source.substring(offset, match.start),
        ),
      );
    }
    final raw = match.group(0)!;
    final code = _code.firstMatch(raw);
    final link = _link.firstMatch(raw);
    if (code != null) {
      tokens.add(MarkdownInlineToken(MarkdownInlineKind.code, code.group(2)!));
    } else if (raw.startsWith('`') || (raw.startsWith('[') && link == null)) {
      tokens.add(MarkdownInlineToken(MarkdownInlineKind.plain, raw));
    } else if (link != null) {
      tokens.add(
        MarkdownInlineToken(
          MarkdownInlineKind.link,
          link.group(1)!,
          target: link.group(2),
        ),
      );
    } else if (raw.startsWith('**') || raw.startsWith('~~')) {
      tokens.add(
        MarkdownInlineToken(
          raw.startsWith('**')
              ? MarkdownInlineKind.strong
              : MarkdownInlineKind.strike,
          raw.substring(2, raw.length - 2),
        ),
      );
    } else if (raw.startsWith('http://') || raw.startsWith('https://')) {
      tokens.add(MarkdownInlineToken(MarkdownInlineKind.url, raw));
    } else if (_email.hasMatch(raw)) {
      tokens.add(MarkdownInlineToken(MarkdownInlineKind.email, raw));
    } else if (raw.startsWith('@')) {
      final name = cleanMentionName(raw);
      tokens.add(
        MarkdownInlineToken(
          MarkdownInlineKind.mention,
          name.isEmpty ? raw : name,
        ),
      );
    } else {
      tokens.add(
        MarkdownInlineToken(
          MarkdownInlineKind.emphasis,
          raw.substring(1, raw.length - 1),
        ),
      );
    }
    offset = match.end;
  }
  if (offset < source.length) {
    tokens.add(
      MarkdownInlineToken(MarkdownInlineKind.plain, source.substring(offset)),
    );
  }
  return tokens;
}

/// markdownPreviewText 用到的正则，提到文件顶层只建一次。
///
/// 这些正则原来在函数体里 —— 每次调用都要新建十几个 RegExp 对象，
/// 而引用条在流式回复时每帧都会重建，白白产生大量分配。
final RegExp _reFence = RegExp(r'```[^\n]*\n?');
final RegExp _reBlockMark = RegExp(
  r'^[ \t]*(#{1,6}|>|[-*+]|\d+\.)[ \t]+',
  multiLine: true,
);
final RegExp _reHr = RegExp(
  r'^[ \t]*(-{3,}|\*{3,}|_{3,})[ \t]*$',
  multiLine: true,
);
final RegExp _reCodeSpan = RegExp(r'`([^`]*)`');
final RegExp _reStrongStar = RegExp(r'\*\*([^*]+)\*\*');
final RegExp _reStrongUnderscore = RegExp(r'__([^_]+)__');
final RegExp _reStrike = RegExp(r'~~([^~]+)~~');
final RegExp _reEmStar = RegExp(r'\*([^*\n]+)\*');
final RegExp _reEmUnderscore = RegExp(
  r'(?<![A-Za-z0-9_])_([^_\n]+)_(?![A-Za-z0-9_])',
);
final RegExp _reLinkImage = RegExp(r'!?\[([^\]]*)\]\([^)]*\)');
final RegExp _reAutoLink = RegExp(r'<((?:https?|mailto):[^>]+)>');
final RegExp _reMidHash = RegExp(r'(?<=[\s。！？；：，、.,!?;:]|^)#{1,6}[ \t]+');
final RegExp _reMidQuote = RegExp(r'(?<=[\s。！？；：，、.,!?;:]|^)>[ \t]+');
final RegExp _reSpace = RegExp(r'\s+');
final RegExp _reLooseMarks = RegExp(r'(^|\s)[*#`~]+(?=\s|$)');
final RegExp _reLeadMarks = RegExp(r'^[*#`~]+');

/// 预览只需要前面一小段：引用原文可能几千字，全文跑正则没必要。
const int _previewScanLimit = 500;

/// 把一段 Markdown 压成适合「单行预览」的纯文本。
///
/// 引用条、通知这类地方只显示一行摘要，不能直接把原文丢给 MdText：
///   · 原文里的 ## 是块级标记，必须**在行首**才生效 ——
///     预览把整段压成一行后 ## 跑到句子中间，渲染器不认，就原样显示出来了；
///   · 按长度截断还可能切在 ** 中间，标记一半配对不上，也是原样显示。
/// 所以这里按「先剥标记、再截断」的顺序处理。
///
/// 只剥常见的行内/块级标记，目标是「读起来干净」，不是完整 Markdown 解析。
String markdownPreviewText(String source, {int maxChars = 60}) {
  // 先截一段再处理：引用条最多显示一行，后面上千字剥不剥都一样看不见
  var s = source.length > _previewScanLimit
      ? source.substring(0, _previewScanLimit)
      : source;

  // 1) 围栏代码块整体塌成一行（内容保留首行，后面用省略号）
  s = s.replaceAll(_reFence, ' ');

  // 2) 行首块级标记：标题、引用、列表、任务框、分隔线
  s = s.replaceAll(_reBlockMark, '');
  s = s.replaceAll(_reHr, '');

  // 3) 行内标记：行内代码、强调、删除线、链接文字
  //    注意 Dart 里引用分组要用 replaceAllMapped —— replaceAll 的 $1 是字面量。
  String unwrap(RegExp re, String input) =>
      input.replaceAllMapped(re, (m) => m.group(1) ?? '');
  s = unwrap(_reCodeSpan, s);
  s = unwrap(_reStrongStar, s);
  s = unwrap(_reStrongUnderscore, s);
  s = unwrap(_reStrike, s);
  s = unwrap(_reEmStar, s);
  s = unwrap(_reEmUnderscore, s);

  // 4) 链接/图片：留文字，丢地址
  s = unwrap(_reLinkImage, s);
  s = unwrap(_reAutoLink, s);

  // 4.5) 被压平后跑到句子中间的块级标记。
  //      原文里的「## ① 本期结论」换行被压掉后变成「实测。## ①」，
  //      前面是标点而不是空格，所以这里把常见的句子边界都算上。
  //      只在「前面像句子边界 + 后面跟空格」时剥 —— 正文里正常出现的
  //      #1、C#、#tag 这类（前面是字母数字或后面没有空格）不动。
  s = s.replaceAll(_reMidHash, '');
  s = s.replaceAll(_reMidQuote, '');

  // 5) 摊平空白（这一步放到最后：上面几步都依赖换行判断行首）
  s = s.replaceAll(_reSpace, ' ').trim();

  // 6) 残留的孤立标记符号（截断/不成对时留下的）直接去掉。
  //    ★ 这里必须用 replaceAllMapped：replaceAll 的 $1 不会展开，
  //      会把 a * b 变成 a$1b。
  s = s.replaceAllMapped(_reLooseMarks, (m) => m.group(1) ?? '');
  s = s.replaceAll(_reLeadMarks, '');
  s = s.trim();

  // 7) 截断。用 characters 而不是 substring / runes ——
  //    substring 按 UTF-16 code unit 切会切坏代理对；
  //    runes 会把组合 emoji（如 👨‍👩‍👧）拆成多个码点。
  final chars = s.characters;
  if (chars.length > maxChars) {
    s = '${chars.take(maxChars)}…';
  }
  return s;
}

/// 提取与行内渲染一致的可见文字，保留换行并以标签代替链接目标。
String markdownInlineText(
  String source, {
  Iterable<String> mentions = const [],
}) {
  return markdownInlineTokens(source, mentions: mentions).map((token) {
    return switch (token.kind) {
      MarkdownInlineKind.strong ||
      MarkdownInlineKind.strike ||
      MarkdownInlineKind.emphasis => markdownInlineText(
        token.text,
        mentions: mentions,
      ),
      _ => token.text,
    };
  }).join();
}
