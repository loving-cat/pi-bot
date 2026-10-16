import 'package:flutter/gestures.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:url_launcher/url_launcher.dart';

import '../text_utils.dart';
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
    this.onMentionTap,
  });

  final String text;
  final TextStyle? style;
  final TextStyle? mono;
  final bool selectable;
  final bool compact;

  /// 要高亮的名字（不含 @）—— 部门成员。agent 之间用 @ 派活，高亮后一眼看得出谁被点名了。
  final List<String> mentions;

  /// 点 @提及 时回调（参数是去掉 @ 和 emoji 的纯名字）。
  /// 传了就把提及变成可点链接（跳到那个 bot 的私聊），不传则只是高亮。
  final void Function(String name)? onMentionTap;

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
    for (final h in _mentionTaps.values) {
      h.dispose();
    }
    super.dispose();
  }

  TapGestureRecognizerHandle _recognizer(String url) {
    return _links.putIfAbsent(url, () => TapGestureRecognizerHandle(url));
  }

  /// @提及 的点击通道。按名字缓存，避免每帧新建 recognizer。
  final Map<String, TapGestureRecognizerHandle> _mentionTaps = {};

  TapGestureRecognizerHandle? _mentionRecognizer(String rawToken) {
    final onTap = widget.onMentionTap;
    if (onTap == null) return null;
    final name = cleanMentionName(rawToken);
    if (name.isEmpty) return null;
    return _mentionTaps.putIfAbsent(
      name,
      () => TapGestureRecognizerHandle.custom(() => onTap(name)),
    );
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
        // @提及：让“谁被点名了”一眼可见；传了 onMentionTap 就直接可点
        // （点了跳到那个 bot 的私聊 —— agent 之间 @ 派活时用户能跟过去看）
        spans.add(TextSpan(
          text: token,
          style: base.copyWith(
            color: PB.accentBright,
            fontWeight: FontWeight.w600,
            backgroundColor: PB.accentSoft,
            decoration: widget.onMentionTap != null
                ? TextDecoration.underline
                : null,
            decorationColor: PB.accentBright.withValues(alpha: 0.5),
          ),
          recognizer: _mentionRecognizer(token)?.value,
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
/// 点击手势的封装：把 recognizer 的创建/释放收在一起，
/// 避免在 build 里到处 new（每次 rebuild 都 new 一个不释放 = 内存泄漏）。
class TapGestureRecognizerHandle {
  /// 打开外部链接（失败就复制到剪贴板）
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

  /// 任意回调（@提及 跳私聊、点引用气泡等都用这个）
  TapGestureRecognizerHandle.custom(VoidCallback onTap)
    : value = (TapGestureRecognizer()..onTap = onTap);

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

  static const double _padH = 10;
  static const double _padV = 7;

  /// 单列能压到的最窄宽度（再窄就没法读了）
  static const double _minCol = 54;

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
    if (columns == 0) return const SizedBox.shrink();

    final headStyle = base.copyWith(
      fontWeight: FontWeight.w600,
      fontSize: PB.fsXs,
    );
    final bodyStyle = base.copyWith(fontSize: PB.fsXs);

    // 先量出每列的“自然宽度”（取该列最长那格，不换行时的宽度）
    final natural = List<double>.filled(columns, _minCol);
    for (var c = 0; c < columns; c++) {
      for (var r = -1; r < rows.length; r++) {
        final t = r < 0
            ? (c < header.length ? header[c] : '')
            : (c < rows[r].length ? rows[r][c] : '');
        if (t.trim().isEmpty) continue;
        final tp = TextPainter(
          text: TextSpan(text: t, style: r < 0 ? headStyle : bodyStyle),
          textDirection: TextDirection.ltr,
          maxLines: 1,
        )..layout();
        final w = tp.width + _padH * 2;
        if (w > natural[c]) natural[c] = w;
      }
    }

    return LayoutBuilder(
      builder: (context, c) {
        final avail = c.maxWidth.isFinite ? c.maxWidth : 600.0;

        // 列太多（比如 6 列 x 84px），气泡里怎么分都读不了 → 才允许横向滚
        final minReadable = columns * 84.0;
        if (minReadable > avail) {
          final w = minReadable / columns;
          return SingleChildScrollView(
            scrollDirection: Axis.horizontal,
            child: SizedBox(
              width: minReadable,
              child: _build(
                columns,
                {for (var i = 0; i < columns; i++) i: FixedColumnWidth(w)},
                headStyle,
                bodyStyle,
              ),
            ),
          );
        }

        // ★ 弹性布局：按各列“自然宽度”的比例分配整个可用宽度。
        //   FlexColumnWidth 的总和永远等于可用宽度，所以表格一定撑满气泡；
        //   短列（“项”“序号”）按内容窄，长列（“方案”“说明”）拿到剩下的全部宽度。
        //   单列上限 55%：防止一列超长文本把别的列挤成一条缝。
        final cap = avail * 0.55;
        final flex = [
          for (final w in natural) w.clamp(_minCol, cap < _minCol ? _minCol : cap),
        ];
        return _build(
          columns,
          {for (var i = 0; i < columns; i++) i: FlexColumnWidth(flex[i])},
          headStyle,
          bodyStyle,
        );
      },
    );
  }

  Widget _build(
    int columns,
    Map<int, TableColumnWidth> widths,
    TextStyle headStyle,
    TextStyle bodyStyle,
  ) {
    return Container(
      clipBehavior: Clip.antiAlias,
      decoration: BoxDecoration(
        border: Border.all(color: PB.borderTertiary),
        borderRadius: BorderRadius.circular(PB.rLg),
      ),
      child: Table(
        columnWidths: widths,
        defaultVerticalAlignment: TableCellVerticalAlignment.middle,
        border: TableBorder.symmetric(
          inside: const BorderSide(color: PB.borderTertiary),
        ),
        children: [
          TableRow(
            decoration: BoxDecoration(
              color: PB.bgActive.withValues(alpha: 0.5),
            ),
            children: [
              for (var c = 0; c < columns; c++)
                _cell(c < header.length ? header[c] : '', headStyle),
            ],
          ),
          for (var r = 0; r < rows.length; r++)
            TableRow(
              decoration: r.isOdd
                  ? BoxDecoration(color: PB.bgActive.withValues(alpha: 0.22))
                  : null,
              children: [
                for (var c = 0; c < columns; c++)
                  _cell(c < rows[r].length ? rows[r][c] : '', bodyStyle),
              ],
            ),
        ],
      ),
    );
  }

  Widget _cell(String text, TextStyle style) {
    // 单元格也要走行内 markdown：模型很爱在单元格里写 **加粗** 和 `代码`
    return TableCell(
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: _padH, vertical: _padV),
        child: text.trim().isEmpty
            ? const SizedBox(height: 18)
            : renderInline(
                text,
                style,
                style.copyWith(fontFamily: 'monospace', fontSize: style.fontSize),
              ),
      ),
    );
  }
}
