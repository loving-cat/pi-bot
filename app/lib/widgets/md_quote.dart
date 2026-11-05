import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../l10n/l10n.dart';
import '../theme.dart';
import 'toast.dart';

/// 带独立复制入口的引用正文；复制内容由行内解析层提供。
class MarkdownQuote extends StatefulWidget {
  const MarkdownQuote({super.key, required this.text, required this.child});

  final String text;
  final Widget child;

  @override
  State<MarkdownQuote> createState() => _MarkdownQuoteState();
}

class _MarkdownQuoteState extends State<MarkdownQuote> {
  Timer? _reset;
  bool _copied = false;
  bool _copying = false;

  @override
  void didUpdateWidget(MarkdownQuote oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.text != widget.text) {
      _reset?.cancel();
      _copied = false;
    }
  }

  @override
  void dispose() {
    _reset?.cancel();
    super.dispose();
  }

  Future<void> _copy() async {
    if (_copying || widget.text.isEmpty) return;
    _copying = true;
    final text = widget.text;
    try {
      await Clipboard.setData(ClipboardData(text: text));
      if (!mounted) return;
      _reset?.cancel();
      setState(() => _copied = text == widget.text);
      toast(context, L10n.s(context).t('copy.quote'), kind: ToastKind.success);
      _reset = Timer(const Duration(seconds: 2), () {
        if (mounted) setState(() => _copied = false);
      });
    } catch (_) {
      if (mounted)
        toast(context, L10n.s(context).t('copy.failed'), kind: ToastKind.error);
    } finally {
      _copying = false;
    }
  }

  @override
  Widget build(BuildContext context) {
    final colors = PB.colors(context);
    return Container(
      padding: const EdgeInsets.fromLTRB(14, 9, 6, 9),
      decoration: BoxDecoration(
        color: colors.quoteBackground,
        border: Border(left: BorderSide(color: colors.quoteBorder, width: 2)),
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Expanded(child: widget.child),
          const SizedBox(width: 6),
          SelectionContainer.disabled(
            child: IconButton(
              tooltip: L10n.s(context)
                  .t(_copied ? 'copy.quoteCopied' : 'copy.copyQuote'),
              visualDensity: VisualDensity.compact,
              constraints: const BoxConstraints(minWidth: 28, minHeight: 28),
              padding: const EdgeInsets.all(5),
              onPressed: widget.text.isEmpty ? null : _copy,
              icon: Icon(
                _copied ? LucideIcons.check : LucideIcons.copy,
                size: 14,
                color: _copied ? colors.link : PB.textQuaternary,
              ),
            ),
          ),
        ],
      ),
    );
  }
}
