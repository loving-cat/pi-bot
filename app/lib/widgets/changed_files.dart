import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../models.dart';
import '../theme.dart';

/// 一轮回复下面那一行「改了哪些文件」。
///
/// 用户看回复时最想确认的是"它有没有动我的文件、动了哪些"。默认收起成一行，
/// 点开看清单（新增 / 修改 / 删除各带标记）。和工具调用一样：不展开不占视线，
/// 但**一定要看得见**。
class ChangedFilesView extends StatefulWidget {
  const ChangedFilesView({super.key, required this.summary});

  final ChangedSummary summary;

  @override
  State<ChangedFilesView> createState() => _ChangedFilesViewState();
}

class _ChangedFilesViewState extends State<ChangedFilesView> {
  bool _open = false;

  @override
  Widget build(BuildContext context) {
    final s = widget.summary;
    if (s.isEmpty) return const SizedBox.shrink();

    final parts = <String>[
      if (s.added.isNotEmpty) '新增 ${s.added.length}',
      if (s.modified.isNotEmpty) '修改 ${s.modified.length}',
      if (s.removed.isNotEmpty) '删除 ${s.removed.length}',
    ];

    final rows = <(String, ChangedFile)>[
      for (final f in s.added) ('+', f),
      for (final f in s.modified) ('~', f),
      for (final f in s.removed) ('-', f),
    ];
    final shown = rows.take(20).toList();

    return Padding(
      padding: const EdgeInsets.only(bottom: 7),
      child: Container(
        decoration: BoxDecoration(
          color: PB.bgBubble.withValues(alpha: 0.55),
          borderRadius: BorderRadius.circular(PB.rXl),
          border: Border.all(color: PB.borderTertiary),
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            InkWell(
              onTap: () => setState(() => _open = !_open),
              borderRadius: BorderRadius.circular(PB.rXl),
              child: Padding(
                padding: const EdgeInsets.fromLTRB(10, 7, 8, 7),
                child: Row(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    const Icon(
                      LucideIcons.fileDiff,
                      size: 11,
                      color: PB.textQuaternary,
                    ),
                    const SizedBox(width: 5),
                    Text(
                      '改动 ${s.total} 个文件',
                      style: const TextStyle(
                        fontSize: PB.fsXxs,
                        fontWeight: FontWeight.w600,
                        letterSpacing: 0.3,
                        color: PB.textTertiary,
                      ),
                    ),
                    const SizedBox(width: 6),
                    Flexible(
                      child: Text(
                        _open ? parts.join(' · ') : '${parts.join(' · ')} · 点开看',
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: const TextStyle(
                          fontSize: PB.fsXxs,
                          color: PB.textQuaternary,
                        ),
                      ),
                    ),
                    const SizedBox(width: 2),
                    Icon(
                      _open ? LucideIcons.chevronUp : LucideIcons.chevronDown,
                      size: 12,
                      color: PB.textQuaternary,
                    ),
                  ],
                ),
              ),
            ),
            if (_open) ...[
              for (final (mark, file) in shown)
                Padding(
                  padding: const EdgeInsets.fromLTRB(10, 0, 10, 3),
                  child: Row(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      SizedBox(
                        width: 12,
                        child: Text(
                          mark,
                          style: TextStyle(
                            fontFamily: PB.monoFamily,
                            fontFamilyFallback: PB.monoFallback,
                            fontSize: PB.fsTinyCjk,
                            fontWeight: FontWeight.w600,
                            color: mark == '+'
                                ? const Color(0xFF4CC38A)
                                : mark == '~'
                                ? const Color(0xFFE2B93B)
                                : PB.danger,
                          ),
                        ),
                      ),
                      const SizedBox(width: 5),
                      Flexible(
                        child: Text(
                          file.path,
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: const TextStyle(
                            fontFamily: PB.monoFamily,
                            fontFamilyFallback: PB.monoFallback,
                            fontSize: PB.fsTinyCjk,
                            color: PB.textQuaternary,
                          ),
                        ),
                      ),
                    ],
                  ),
                ),
              if (rows.length > shown.length)
                Padding(
                  padding: const EdgeInsets.fromLTRB(10, 0, 10, 4),
                  child: Text(
                    '还有 ${rows.length - shown.length} 个'
                    '${s.truncated ? '（本次改动过多，只统计了一部分）' : ''}',
                    style: const TextStyle(
                      fontSize: PB.fsXxs,
                      color: PB.textQuaternary,
                    ),
                  ),
                ),
              const SizedBox(height: 3),
            ],
          ],
        ),
      ),
    );
  }
}
