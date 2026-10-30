import 'package:flutter/gestures.dart';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:url_launcher/url_launcher.dart';

import '../text_utils.dart';
import '../highlight.dart';
import '../theme.dart';
import 'toast.dart';
import 'blob_avatar.dart';

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
    this.onLinkTap,
    this.mentionOf,
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

  /// 点普通链接时回调（参数是原始 url）。
  ///
  /// 不传就维持原行为：交给系统浏览器。传了的话由调用方决定去哪 ——
  /// 首页把它接到右侧内置浏览器栏（用户定的：链接全部走内置）。
  final void Function(String url)? onLinkTap;

  /// 把 @ 的名字映射成 chip 要用的信息（种子 + 一句话简介）。
  /// 传了的话，鼠标悬在 @ 上会浮出一张小卡。
  final MentionInfo? Function(String name)? mentionOf;

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
    final handler = widget.onLinkTap;
    if (handler != null) {
      return _links.putIfAbsent(
        'link:$url',
        () => TapGestureRecognizerHandle.custom(() => handler(url)),
      );
    }
    return _links.putIfAbsent(url, () => TapGestureRecognizerHandle(url));
  }

  /// 网址的"点一下复制"识别器。
  ///
  /// 行内代码里的 localhost 地址（http://127.0.0.1:8765/ 这种）点开也没用，
  /// 目的是把地址拿走 —— 点一下直接复制，比先拖选再 ⌘C 快得多。
  TapGestureRecognizerHandle _copyUrlRecognizer(String url) {
    return _links.putIfAbsent(
      'copy:$url',
      () => TapGestureRecognizerHandle.custom(() {
        Clipboard.setData(ClipboardData(text: url));
        toast(context, '链接已复制');
      }),
    );
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final base = widget.style ?? theme.textTheme.bodyMedium!;
    final code =
        widget.mono ??
        base.copyWith(
          fontFamily: PB.monoFamily,
          fontFamilyFallback: PB.monoFallback,
          fontSize: (base.fontSize ?? 14) - 1,
          height: 1.45,
          color: PB.textPrimary,
        );

    final blocks = _parse(widget.text);
    final children = <Widget>[];
    for (final block in blocks) {
      children.add(_renderBlock(context, block, base, code));
    }

    final body = children.length == 1
        ? children.first
        : Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              for (var i = 0; i < children.length; i++)
                Padding(
                  // ★ 块之间的呼吸：8 → 14。
                  //   消息里通常是"一句话 + 列表 + 一句话"这种结构，块挤在一起
                  //   读起来像一堵墙；拉开之后每一块才是独立的一段。
                  //   compact 的那档也跟着放宽（4 → 8），但保持明显更紧。
                  padding: EdgeInsets.only(
                    top: i == 0 ? 0 : (widget.compact ? 8 : 14),
                  ),
                  child: children[i],
                ),
            ],
          );
    if (!widget.selectable) return body;
    // ★ 整个消息**只有一个** SelectionArea。
    //
    //   每个段落/列表项/表格单元格各自一个 SelectionArea 时，拖动选择
    //   跨行会各选各的，复制出来断成一截一截。收成一个之后，
    //   整条消息可以一次拖选、⌘C/Ctrl+C 复制。
    return SelectionArea(child: body);
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
    // 选中交给最外层那一个 SelectionArea（见 build），这里只画文本。
    // 不用 SelectableText.rich：它不支持 WidgetSpan，而 @提及 要画头像 chip。
    return Text.rich(TextSpan(children: spans, style: base));
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
      r'|(https?://[^\s<>`\u3002\uff0c\uff1b\uff1a\uff09)]+)' // 裸网址
      r'|((?<![\w*])\*[^*\n]+\*(?![\w*]))' // 斜体 *
      r'|((?<![\w_])_[^_\n]+_(?![\w_]))' // 斜体 _
      r'|(@(?:all|全体|所有人|大家|全员))' // @全体
      '|(@[\\s\\p{Extended_Pictographic}\\uFE0F\\u200D]*(?:${mentionAlt.isEmpty ? '(?!)' : mentionAlt}))', // @某个成员
      unicode: true,
    );
    var i = 0;
    for (final match in re.allMatches(source)) {
      if (match.start > i)
        spans.add(TextSpan(text: source.substring(i, match.start)));
      final token = match.group(0)!;
      if (token.startsWith('`')) {
        final inner = token.substring(1, token.length - 1);
        spans.add(
          TextSpan(
            text: inner,
            style: code.copyWith(backgroundColor: PB.bgActive),
            // 行内代码里的网址：点一下复制（打开 localhost 没有意义）
            recognizer: RegExp(r'^https?://').hasMatch(inner)
                ? _copyUrlRecognizer(inner).value
                : null,
          ),
        );
      } else if (token.startsWith('**')) {
        spans.add(
          TextSpan(
            text: token.substring(2, token.length - 2),
            style: base.copyWith(fontWeight: FontWeight.w700),
          ),
        );
      } else if (token.startsWith('~~')) {
        spans.add(
          TextSpan(
            text: token.substring(2, token.length - 2),
            style: base.copyWith(
              decoration: TextDecoration.lineThrough,
              color: PB.textTertiary,
            ),
          ),
        );
      } else if (token.startsWith('[')) {
        final m = RegExp(r'^\[([^\]]+)\]\(([^)\s]+)\)$').firstMatch(token);
        final label = m?.group(1) ?? token;
        final url = m?.group(2) ?? '';
        spans.add(
          TextSpan(
            text: label,
            style: base.copyWith(
              color: PB.accentBright,
              decoration: TextDecoration.underline,
            ),
            recognizer: _recognizer(url).value,
          ),
        );
      } else if (token.startsWith('@')) {
        // @提及：画成「小头像 + 名字」的 chip。
        //
        // 颜色 + 头像比一段高亮文字快得多 ——
        // 群里一串 @ 排在一起时，"这活到底派给谁了"要能扫一眼看出来。
        final name = cleanMentionName(token);
        final onTap = widget.onMentionTap;
        final info = widget.mentionOf?.call(name);
        spans.add(
          WidgetSpan(
            alignment: PlaceholderAlignment.middle,
            child: _MentionChip(
              name: name.isEmpty ? token : name,
              info: info,
              onTap: onTap == null ? null : () => onTap(name),
            ),
          ),
        );
      } else if (RegExp(r'^https?://').hasMatch(token)) {
        // 裸网址：点一下复制（不自动打开，避免把用户踢出 App）
        spans.add(
          TextSpan(
            text: token,
            style: base.copyWith(color: PB.accentBright),
            recognizer: _copyUrlRecognizer(token).value,
          ),
        );
      } else {
        final inner = token.substring(1, token.length - 1);
        spans.add(
          TextSpan(
            text: inner,
            style: base.copyWith(fontStyle: FontStyle.italic),
          ),
        );
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


/// 语法着色的调色板。
///
/// 只用设计系统里已有的令牌（不另造颜色）—— 聊天窗口里代码块不该比正文更花。
/// 未知/纯文本不染色，交给基础样式（也就是"看起来没高亮"，但那是对的）。
TextStyle? _syntaxStyle(TokKind kind, TextStyle base) {
  switch (kind) {
    case TokKind.keyword:
      return base.copyWith(color: PB.accent, fontWeight: FontWeight.w500);
    case TokKind.str:
      return base.copyWith(color: PB.success);
    case TokKind.comment:
      return base.copyWith(color: PB.textQuaternary, fontStyle: FontStyle.italic);
    case TokKind.number:
      return base.copyWith(color: PB.accentBright);
    case TokKind.type:
      return base.copyWith(color: PB.textPrimary, fontWeight: FontWeight.w500);
    case TokKind.fn:
      return base.copyWith(color: PB.accentBright);
    case TokKind.punct:
    case TokKind.plain:
      return null;
  }
}

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
                      fontFamily: PB.monoFamily,
                      fontFamilyFallback: PB.monoFallback,
                    ),
                  ),
                ),
                InkWell(
                  onTap: () {
                    Clipboard.setData(ClipboardData(text: code));
                    toast(context, '代码已复制', kind: ToastKind.success);
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
              // 自己写的小分词器上色（见 lib/highlight.dart）：
              // 认不出的语言一律当纯文本，绝不猜。
              child: Text.rich(
                TextSpan(
                  children: [
                    for (final t in highlightCode(code.trimRight(), language))
                      TextSpan(text: t.text, style: _syntaxStyle(t.kind, style)),
                  ],
                ),
                style: style,
              ),
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

  // ★ 表格内边距取 14 / 11：横向 10 / 纵向 7 时两行字几乎贴在一起，
  //   密表看不动。
  static const double _padH = 14;
  static const double _padV = 11;

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
          for (final w in natural)
            w.clamp(_minCol, cap < _minCol ? _minCol : cap),
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
            ? const SizedBox(height: 22)
            : renderInline(
                text,
                style,
                style.copyWith(
                  fontFamily: PB.monoFamily,
                  fontFamilyFallback: PB.monoFallback,
                  fontSize: style.fontSize,
                ),
              ),
      ),
    );
  }
}

/// @ 提及 chip 要用的信息。
class MentionInfo {
  const MentionInfo({required this.seed, this.subtitle, this.emoji});

  /// 稳定种子（一般是 botId）—— 颜色按它算，保证和花名册/头像一致
  final String seed;

  /// 一句话简介（职位/在做什么），悬停卡里显示
  final String? subtitle;
  final String? emoji;
}

/// 回复气泡里的「@某人」—— 小头像 + 名字。
///
/// 比纯文字高亮多花不了几个像素，但一眼就能认出是谁；一串 @ 排在一起时差别很明显。
///
/// **只做一件事：点一下跳到那个人的私聊。**
/// 曾经在它上面挂过悬停信息卡，结果：
///   · 卡片浮出来挡住旁边正在读的字
///   · 鼠标移上去变手型，看着像"可以拖"
///   · 而它比点击只多了"提前看到一句话简介"这点信息 —— 不划算
/// 所以去掉了。要看他是谁，点进去就是了。
class _MentionChip extends StatelessWidget {
  const _MentionChip({required this.name, this.info, this.onTap});

  final String name;
  final MentionInfo? info;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final seed = info?.seed ?? name;
    final color = PB.colorFor(seed);
    final chip = Container(
      padding: const EdgeInsets.fromLTRB(3, 2, 7, 2),
      decoration: BoxDecoration(
        color: color.withValues(alpha: 0.16),
        borderRadius: BorderRadius.circular(PB.rFull),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          BlobAvatar(seed: seed, color: color, size: 15, animate: false),
          const SizedBox(width: 5),
          Text(
            name,
            style: const TextStyle(
              fontSize: PB.fsXs,
              fontWeight: FontWeight.w600,
              color: PB.textPrimary,
              height: 1.1,
            ),
          ),
        ],
      ),
    );
    if (onTap == null) return chip;
    return GestureDetector(
      onTap: onTap,
      // 普通箭头：这里只是"点一下"，不该给出"能拖"的暗示
      child: MouseRegion(cursor: SystemMouseCursors.basic, child: chip),
    );
  }
}
