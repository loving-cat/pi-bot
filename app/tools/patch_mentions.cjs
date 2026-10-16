const fs = require('fs');
const p = 'lib/widgets/md_text.dart';
let s = fs.readFileSync(p, 'utf8');

// 1) 加 mentions 参数
s = s.replace(
  "    this.selectable = true,\n    this.compact = false,\n  });",
  "    this.selectable = true,\n    this.compact = false,\n    this.mentions = const [],\n  });",
);
s = s.replace(
  "  final bool selectable;\n  final bool compact;\n",
  "  final bool selectable;\n  final bool compact;\n\n  /// 要高亮的名字（不含 @）—— 部门成员。agent 之间用 @ 派活，高亮后一眼看得出谁被点名了。\n  final List<String> mentions;\n",
);

// 2) 整个 _inline 函数替换
const startMarker = 'List<InlineSpan> _inline(String source, TextStyle base, TextStyle code) {';
const start = s.indexOf(startMarker);
if (start < 0) throw new Error('找不到 _inline');
let i = s.indexOf('{', start);
let depth = 0;
let end = -1;
for (let j = i; j < s.length; j++) {
  if (s[j] === '{') depth++;
  else if (s[j] === '}') {
    depth--;
    if (depth === 0) {
      end = j + 1;
      break;
    }
  }
}
if (end < 0) throw new Error('找不到 _inline 结尾');

const NEW = `List<InlineSpan> _inline(String source, TextStyle base, TextStyle code) {
    final spans = <InlineSpan>[];
    final mentionAlt = widget.mentions
        .where((m) => m.trim().isNotEmpty)
        .map((m) => RegExp.escape(m))
        .join('|');
    final re = RegExp(
      r'(\`[^\`\\n]+\`)' // 行内代码
      r'|(\\*\\*[^*\\n]+\\*\\*)' // 粗体
      r'|(~~[^~\\n]+~~)' // 删除线
      r'|(\\[[^\\]\\n]+\\]\\([^)\\s]+\\))' // 链接
      r'|((?<![\\w*])\\*[^*\\n]+\\*(?![\\w*]))' // 斜体 *
      r'|((?<![\\w_])_[^_\\n]+_(?![\\w_]))' // 斜体 _
      r'|(@(?:all|全体|所有人|大家|全员))' // @全体
      r'|(@[\\s\\p{Extended_Pictographic}\\uFE0F\\u200D]*(?:' +
          (mentionAlt.isEmpty ? '(?!)' : mentionAlt) +
          r'))', // @某个成员
      unicode: true,
    );
    var i = 0;
    for (final match in re.allMatches(source)) {
      if (match.start > i) spans.add(TextSpan(text: source.substring(i, match.start)));
      final token = match.group(0)!;
      if (token.startsWith('\`')) {
        spans.add(TextSpan(
          text: token.substring(1, token.length - 1),
          style: code.copyWith(backgroundColor: PB.bgActive),
        ));
      } else if (token.startsWith('**')) {
        spans.add(TextSpan(
          text: token.substring(2, token.length - 2),
          style: base.copyWith(fontWeight: FontWeight.w700),
        ));
      } else if (token.startsWith('~~')) {
        spans.add(TextSpan(
          text: token.substring(2, token.length - 2),
          style: base.copyWith(decoration: TextDecoration.lineThrough, color: PB.textTertiary),
        ));
      } else if (token.startsWith('[')) {
        final m = RegExp(r'^\\[([^\\]]+)\\]\\(([^)\\s]+)\\)\$').firstMatch(token);
        final label = m?.group(1) ?? token;
        final url = m?.group(2) ?? '';
        spans.add(TextSpan(
          text: label,
          style: base.copyWith(color: PB.accentBright, decoration: TextDecoration.underline),
          recognizer: _recognizer(url).value,
        ));
      } else if (token.startsWith('@')) {
        // @提及：让“谁被点名了”一眼可见
        spans.add(TextSpan(
          text: token,
          style: base.copyWith(
            color: PB.accentBright,
            fontWeight: FontWeight.w600,
            backgroundColor: PB.accentSoft,
          ),
        ));
      } else {
        final inner = token.substring(1, token.length - 1);
        spans.add(TextSpan(text: inner, style: base.copyWith(fontStyle: FontStyle.italic)));
      }
      i = match.end;
    }
    if (i < source.length) spans.add(TextSpan(text: source.substring(i)));
    return spans;
  }`;

s = s.slice(0, start) + NEW + s.slice(end);
fs.writeFileSync(p, s);
console.log('MdText: mentions 参数 + @提及高亮 已加');
