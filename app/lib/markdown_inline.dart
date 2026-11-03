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
