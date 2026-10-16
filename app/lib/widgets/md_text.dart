import 'package:flutter/gestures.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:url_launcher/url_launcher.dart';

import '../theme.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

/// Markdown 渲染（面向 agent 输出，流式友好）。
///
/// 支持：标题、有序/无序列表、引用、分割线、GFM 表格、围栏代码块（带语言标签+复制）、
/// 行内 code / 粗体 / 斜体 / 删除线 / 链接。
/// 流式输出时未闭合的 ``` 也能正常渲染。
class MdText extends StatefulWidget {
  const MdText(
    this.text, {
    super.key,
    this.style,
    this.mono,
    this.selectable = true,
    this.compact = false,
    this.mentions = const [],
  });

  final String text;
  final TextStyle? style;
  final TextStyle? mono;
  final bool selectable;
  final bool compact;

  /// 要高亮的名字（不含 @）—— 部门成员。agent 之间用 @ 派活，高亮后一眼看得出谁被点名了。
  final List<String> mentions;

  @override
  State<MdText> createState() => _MdTextState();
}

class _MdTextState extends State<MdText> {
  final Map<String, TapGestureRecognizerHandle> _links = {};

  @override
  void dispose() {
    for (final h in _links.values) {
      h.dispose();
    }
    super.dispose();
  }

  TapGestureRecognizerHandle _recognizer(String url) {
    return _links.putIfAbsent(url, () => TapGestureRecognizerHandle(url));
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final base = widget.style ?? theme.textTheme.bodyMedium!;
    final code =
        widget.mono ??
        base.copyWith(
          fontFamily: 'monospace',
          fontSize: (base.fontSize ?? 14) - 1,
          height: 1.45,
          color: PB.textPrimary,
        );

    final blocks = _parse(widget.text);
    final children = <Widget>[];
    for (final block in blocks) {
      children.add(_renderBlock(context, block, base, code));
    }

    if (children.length == 1) return children.first;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        for (var i = 0; i < children.length; i++)
          Padding(
            padding: EdgeInsets.only(
              top: i == 0 ? 0 : (widget.compact ? 4 : 8),
            ),
            child: children[i],
          ),
      ],
    );
  }

  Widget _renderBlock(
    BuildContext context,
    _Block block,
    TextStyle base,
    TextStyle code,
  ) {
    switch (block) {
      case _Heading(:final level, :final text):
        final size = switch (level) {
          1 => PB.fsXxl - 2,
          2 => PB.fsXl,
          3 => PB.fsLg + 1,
          _ => PB.fsBase + 0.5,
        };
        return Padding(
          padding: EdgeInsets.only(top: level <= 2 ? 6 : 3, bottom: 1),
          child: _rich(
            text,
            base.copyWith(
              fontSize: size,
              fontWeight: FontWeight.w600,
              height: 1.35,
            ),
            code,
          ),
        );

      case _Hr():
        return Padding(
          padding: const EdgeInsets.symmetric(vertical: 6),
          child: Container(height: 1, color: PB.borderTertiary),
        );

      case _Code(:final language, :final code_):
        return _CodeBlock(language: language, code: code_, style: code);

      case _Quote(:final text):
        return Container(
          padding: const EdgeInsets.fromLTRB(12, 6, 10, 6),
          decoration: const BoxDecoration(
            border: Border(left: BorderSide(color: PB.accent, width: 2.5)),
          ),
          child: _rich(
            text,
            base.copyWith(color: PB.textSecondary, height: 1.5),
            code,
          ),
        );

      case _ListBlock(:final items):
        return Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            for (final item in items)
              Padding(
                padding: EdgeInsets.only(
                  left: item.indent * 16.0,
                  top: 2,
                  bottom: 2,
                ),
                child: Row(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    SizedBox(
                      width: item.ordered ? 22 : 16,
                      child: Text(
                        item.ordered ? item.marker : '•',
                        style: base.copyWith(
                          color: PB.textTertiary,
                          height: 1.5,
                        ),
                      ),
                    ),
                    Expanded(child: _rich(item.text, base, code)),
                  ],
                ),
              ),
          ],
        );

      case _Table(:final header, :final rows):
        return _TableView(
          header: header,
          rows: rows,
          base: base,
          renderInline: _rich,
        );

      case _Para(:final text):
        return _rich(text, base, code);
    }
  }

  Widget _rich(String source, TextStyle base, TextStyle code) {
    final spans = _inline(source, base, code);
    return widget.selectable
        ? SelectableText.rich(TextSpan(children: spans, style: base))
        : Text.rich(TextSpan(children: spans, style: base));
  }

  List<InlineSpan> _inline(String source, TextStyle base, TextStyle code) {
    final spans = <InlineSpan>[];
    final mentionAlt = widget.mentions
        .where((m) => m.trim().isNotEmpty)
        .map((m) => RegExp.escape(m))
        .join('|');
    final re = RegExp(
      r'(`[^`\n]+`)' // 行内代码
      r'|(\*\*[^*\n]+\*\*)' // 粗体
      r'|(~~[^~\n]+~~)' // 删除线
      r'|(\[[^\]\n]+\]\([^)\s]+\))' // 链接
      r'|((?<![\w*])\*[^*\n]+\*(?![\w*]))' // 斜体 *
      r'|((?<![\w_])_[^_\n]+_(?![\w_]))' // 斜体 _
      r'|(@(?:all|全体|所有人|大家|全员))' // @全体
      '|(@[\\s\\p{Extended_Pictographic}\\uFE0F\\u200D]*(?:${mentionAlt.isEmpty ? '(?!)' : mentionAlt}))', // @某个成员
      unicode: true,
    );
    var i = 0;
    for (final match in re.allMatches(source)) {
      if (match.start > i) spans.add(TextSpan(text: source.substring(i, match.start)));
      final token = match.group(0)!;
      if (token.startsWith('`')) {
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
        final m = RegExp(r'^\[([^\]]+)\]\(([^)\s]+)\)$').firstMatch(token);
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
  }
}

/// 链接点击：包一层，避免在 build 里到处 new recognizer
class TapGestureRecognizerHandle {
  TapGestureRecognizerHandle(String url)
    : value = (TapGestureRecognizer()
        ..onTap = () async {
          final uri = Uri.tryParse(url);
          if (uri == null) return;
          try {
            await launchUrl(uri, mode: LaunchMode.externalApplication);
          } catch (_) {
            await Clipboard.setData(ClipboardData(text: url));
          }
        });

  final TapGestureRecognizer value;

  void dispose() => value.dispose();
}

// ---------------------------------------------------------------------------
// 块级解析
// ---------------------------------------------------------------------------

sealed class _Block {
  const _Block();
}

class _Heading extends _Block {
  const _Heading(this.level, this.text);
  final int level;
  final String text;
}

class _Para extends _Block {
  const _Para(this.text);
  final String text;
}

class _Code extends _Block {
  const _Code(this.language, this.code_, this.closed);
  final String language;
  final String code_;
  final bool closed;
}

class _Hr extends _Block {
  const _Hr();
}

class _Quote extends _Block {
  const _Quote(this.text);
  final String text;
}

class _ListItem {
  const _ListItem(this.indent, this.marker, this.text, this.ordered);
  final int indent;
  final String marker;
  final String text;
  final bool ordered;
}

class _ListBlock extends _Block {
  const _ListBlock(this.items);
  final List<_ListItem> items;
}

class _Table extends _Block {
  const _Table(this.header, this.rows);
  final List<String> header;
  final List<List<String>> rows;
}

final _fence = RegExp(r'^\s*```(.*)$');
final _fenceEnd = RegExp(r'^\s*```\s*$');
final _heading = RegExp(r'^(#{1,6})\s+(.*)$');
final _hr = RegExp(r'^\s*(-{3,}|\*{3,}|_{3,})\s*$');
final _quote = RegExp(r'^\s*>\s?');
final _listItem = RegExp(r'^(\s*)([-*+]|\d+[.)])\s+(.*)$');
final _tableSep = RegExp(r'^\s*\|?[\s:|-]*-[\s:|-]*\|?[\s:|-]*$');

List<String> _splitRow(String line) {
  var s = line.trim();
  if (s.startsWith('|')) s = s.substring(1);
  if (s.endsWith('|')) s = s.substring(0, s.length - 1);
  return s.split('|').map((c) => c.trim()).toList();
}

List<_Block> _parse(String src) {
  final lines = src.split('\n');
  final blocks = <_Block>[];
  final para = <String>[];
  var i = 0;

  void flush() {
    if (para.isEmpty) return;
    blocks.add(_Para(para.join('\n')));
    para.clear();
  }

  while (i < lines.length) {
    final line = lines[i];

    final fence = _fence.firstMatch(line);
    if (fence != null) {
      flush();
      final language = fence.group(1)!.trim();
      final buf = <String>[];
      var closed = false;
      i++;
      while (i < lines.length) {
        if (_fenceEnd.hasMatch(lines[i])) {
          closed = true;
          i++;
          break;
        }
        buf.add(lines[i]);
        i++;
      }
      blocks.add(_Code(language, buf.join('\n'), closed));
      continue;
    }

    final heading = _heading.firstMatch(line);
    if (heading != null) {
      flush();
      blocks.add(_Heading(heading.group(1)!.length, heading.group(2)!.trim()));
      i++;
      continue;
    }

    if (_hr.hasMatch(line)) {
      flush();
      blocks.add(const _Hr());
      i++;
      continue;
    }

    // GFM 表格：当前行有 |，下一行是分隔行
    if (line.contains('|') &&
        i + 1 < lines.length &&
        _tableSep.hasMatch(lines[i + 1])) {
      flush();
      final header = _splitRow(line);
      final rows = <List<String>>[];
      i += 2;
      while (i < lines.length &&
          lines[i].contains('|') &&
          lines[i].trim().isNotEmpty) {
        rows.add(_splitRow(lines[i]));
        i++;
      }
      blocks.add(_Table(header, rows));
      continue;
    }

    if (_quote.hasMatch(line)) {
      flush();
      final buf = <String>[];
      while (i < lines.length && _quote.hasMatch(lines[i])) {
        buf.add(lines[i].replaceFirst(_quote, ''));
        i++;
      }
      blocks.add(_Quote(buf.join('\n')));
      continue;
    }

    final item = _listItem.firstMatch(line);
    if (item != null) {
      flush();
      final items = <_ListItem>[];
      while (i < lines.length) {
        final m = _listItem.firstMatch(lines[i]);
        if (m == null) break;
        items.add(
          _ListItem(
            (m.group(1)!.length / 2).floor(),
            m.group(2)!,
            m.group(3)!,
            RegExp(r'\d').hasMatch(m.group(2)!),
          ),
        );
        i++;
      }
      blocks.add(_ListBlock(items));
      continue;
    }

    if (line.trim().isEmpty) {
      flush();
      i++;
      continue;
    }

    para.add(line);
    i++;
  }
  flush();
  return blocks;
}

// ---------------------------------------------------------------------------
// 代码块 / 表格
// ---------------------------------------------------------------------------

class _CodeBlock extends StatelessWidget {
  const _CodeBlock({
    required this.language,
    required this.code,
    required this.style,
  });

  final String language;
  final String code;
  final TextStyle style;

  @override
  Widget build(BuildContext context) {
    return Container(
      width: double.infinity,
      decoration: BoxDecoration(
        color: PB.bgApp,
        borderRadius: BorderRadius.circular(PB.rXl),
        border: Border.all(color: PB.borderTertiary),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(12, 8, 6, 0),
            child: Row(
              children: [
                Expanded(
                  child: Text(
                    language.isEmpty ? 'code' : language,
                    style: const TextStyle(
                      fontSize: PB.fsXxs,
                      color: PB.textQuaternary,
                      fontFamily: 'monospace',
                    ),
                  ),
                ),
                InkWell(
                  onTap: () {
                    Clipboard.setData(ClipboardData(text: code));
                    ScaffoldMessenger.of(context).showSnackBar(
                      const SnackBar(
                        content: Text('代码已复制'),
                        duration: Duration(milliseconds: 1200),
                      ),
                    );
                  },
                  borderRadius: BorderRadius.circular(PB.rSm),
                  child: const Padding(
                    padding: EdgeInsets.all(5),
                    child: Icon(
                      LucideIcons.copy,
                      size: 13,
                      color: PB.textQuaternary,
                    ),
                  ),
                ),
              ],
            ),
          ),
          Padding(
            padding: const EdgeInsets.fromLTRB(12, 6, 12, 10),
            child: SingleChildScrollView(
              scrollDirection: Axis.horizontal,
              child: SelectableText(code.trimRight(), style: style),
            ),
          ),
        ],
      ),
    );
  }
}

class _TableView extends StatelessWidget {
  const _TableView({
    required this.header,
    required this.rows,
    required this.base,
    required this.renderInline,
  });

  final List<String> header;
  final List<List<String>> rows;
  final TextStyle base;
  final Widget Function(String, TextStyle, TextStyle) renderInline;

  @override
  Widget build(BuildContext context) {
    // 列数按表头来；数据行多出来的空单元格直接丢掉，不要在右边留一空列
    var columns = header.length;
    for (final r in rows) {
      var n = r.length;
      while (n > 0 && r[n - 1].trim().isEmpty) {
        n--;
      }
      if (n > columns) columns = n;
    }
    return SingleChildScrollView(
      scrollDirection: Axis.horizontal,
      child: Container(
        decoration: BoxDecoration(
          border: Border.all(color: PB.borderTertiary),
          borderRadius: BorderRadius.circular(PB.rLg),
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Container(
              color: PB.bgActive.withValues(alpha: 0.5),
              child: Row(
                children: [
                  for (var c = 0; c < columns; c++)
                    _cell(
                      c < header.length ? header[c] : '',
                      base.copyWith(
                        fontWeight: FontWeight.w600,
                        fontSize: PB.fsXs,
                      ),
                    ),
                ],
              ),
            ),
            for (var r = 0; r < rows.length; r++)
              Container(
                decoration: BoxDecoration(
                  border: const Border(
                    top: BorderSide(color: PB.borderTertiary),
                  ),
                  color: r.isEven
                      ? Colors.transparent
                      : PB.bgActive.withValues(alpha: 0.25),
                ),
                child: Row(
                  children: [
                    for (var c = 0; c < columns; c++)
                      _cell(
                        c < rows[r].length ? rows[r][c] : '',
                        base.copyWith(fontSize: PB.fsXs),
                      ),
                  ],
                ),
              ),
          ],
        ),
      ),
    );
  }

  Widget _cell(String text, TextStyle style) {
    return Container(
      constraints: const BoxConstraints(minWidth: 72, maxWidth: 240),
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 7),
      // 单元格也要走行内 markdown：模型很爱在单元格里写 **加粗** 和 `代码`
      child: text.trim().isEmpty
          ? const SizedBox(height: 18)
          : renderInline(text, style, style.copyWith(fontFamily: 'monospace', fontSize: style.fontSize)),
    );
  }
}
