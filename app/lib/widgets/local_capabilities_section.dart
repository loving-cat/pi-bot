import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../models.dart';
import '../scope.dart';
import '../theme.dart';

/// 「本机已装」区块：把用户在终端 pi 里已经装好的东西一键导进来。
///
/// 为什么要有：用户早就有一堆 skill 和 MCP 了，pi-bot 却让他重新手抄一遍 ——
/// 这没有道理。这里扫一遍 `~/.pi/agent`，能导的直接点一下。
///
/// 两个必须说清楚的点（都写在界面上）：
///   · 只读扫描，不会改用户在终端里的配置
///   · 导入是复制一份过来，之后两边独立（改了不会互相影响）
class LocalCapabilitiesSection extends StatefulWidget {
  const LocalCapabilitiesSection({
    super.key,
    required this.kind,
    required this.title,
  });

  /// 'skill' 或 'mcp'
  final String kind;
  final String title;

  @override
  State<LocalCapabilitiesSection> createState() => _LocalCapabilitiesSectionState();
}

class _LocalCapabilitiesSectionState extends State<LocalCapabilitiesSection> {
  bool _expanded = false;
  bool _busy = false;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) {
      AppScope.of(context).loadLocalCapabilities();
    });
  }

  Future<void> _import(List<String> names) async {
    if (names.isEmpty || _busy) return;
    setState(() => _busy = true);
    final r = await AppScope.of(context).importLocalCapabilities(
      kind: widget.kind,
      names: names,
    );
    if (!mounted) return;
    setState(() => _busy = false);

    final msg = [
      if (r.imported.isNotEmpty) '导入了 ${r.imported.length} 个：${r.imported.join('、')}',
      if (r.skipped.isNotEmpty) '跳过：${r.skipped.join('；')}',
    ].join('\n');
    if (msg.isNotEmpty) {
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text(msg, style: const TextStyle(fontSize: PB.fsXs)),
          duration: const Duration(seconds: 4),
        ),
      );
    }
  }

  @override
  Widget build(BuildContext context) {
    final state = AppScope.of(context);
    final caps = state.localCapabilities;
    if (caps == null) return const SizedBox.shrink();

    final isSkill = widget.kind == 'skill';
    final entries = isSkill ? caps.skills : caps.mcpServers;
    if (entries.isEmpty) return const SizedBox.shrink();

    final pending = <String>[
      for (final e in entries)
        if (isSkill
            ? !(e as LocalSkillEntry).imported
            : !(e as LocalMcpEntry).imported)
          isSkill ? (e as LocalSkillEntry).title : (e as LocalMcpEntry).name,
    ];
    final root = isSkill ? caps.skillsRoot : caps.mcpFile;

    return Container(
      margin: const EdgeInsets.only(bottom: 12),
      decoration: BoxDecoration(
        color: PB.bgPane,
        borderRadius: BorderRadius.circular(PB.rXl),
        border: Border.all(color: PB.borderTertiary),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          InkWell(
            borderRadius: BorderRadius.circular(PB.rXl),
            onTap: () => setState(() => _expanded = !_expanded),
            child: Padding(
              padding: const EdgeInsets.fromLTRB(14, 12, 14, 12),
              child: Row(
                children: [
                  Icon(
                    _expanded ? LucideIcons.chevronDown : LucideIcons.chevronRight,
                    size: 15,
                    color: PB.textTertiary,
                  ),
                  const SizedBox(width: 8),
                  Icon(LucideIcons.hardDriveDownload, size: 14, color: PB.accent),
                  const SizedBox(width: 7),
                  Text(
                    '本机已装',
                    style: const TextStyle(
                      fontSize: PB.fsXs,
                      fontWeight: FontWeight.w600,
                      color: PB.textSecondary,
                    ),
                  ),
                  const SizedBox(width: 8),
                  Text(
                    pending.isEmpty
                        ? '${entries.length} 个，都导入了'
                        : '${entries.length} 个 · $pending.length 个可导入',
                    style: const TextStyle(
                      fontSize: PB.fsXxs,
                      color: PB.textQuaternary,
                    ),
                  ),
                  const Spacer(),
                  if (pending.isNotEmpty)
                    TextButton(
                      onPressed: _busy ? null : () => _import(pending),
                      child: Text(
                        _busy ? '导入中…' : '全部导入',
                        style: const TextStyle(fontSize: PB.fsXs),
                      ),
                    ),
                ],
              ),
            ),
          ),
          if (_expanded) ...[
            const Divider(height: 1),
            Padding(
              padding: const EdgeInsets.fromLTRB(14, 10, 14, 4),
              child: Text(
                isSkill
                    ? '扫的是 $root。只读，不会改你终端里的 pi 配置；'
                        '导入是复制一份过来，之后两边独立。'
                    : '扫的是 $root。只读，不会改你终端里的 pi 配置；'
                        '导入后默认**不启用**（MCP 会起进程）。',
                style: const TextStyle(
                  fontSize: PB.fsXxs,
                  color: PB.textQuaternary,
                  height: 1.6,
                ),
              ),
            ),
            for (final e in entries)
              _row(
                title: isSkill ? (e as LocalSkillEntry).title : (e as LocalMcpEntry).name,
                summary: isSkill
                    ? (e as LocalSkillEntry).summary
                    : [if ((e as LocalMcpEntry).isHttp) 'HTTP' else '本地', e.target]
                        .where((x) => x.isNotEmpty)
                        .join(' · '),
                imported: isSkill
                    ? (e as LocalSkillEntry).imported
                    : (e as LocalMcpEntry).imported,
                note: isSkill && (e as LocalSkillEntry).truncated
                    ? '正文较长，已截断到上限'
                    : '',
              ),
            const SizedBox(height: 6),
          ],
        ],
      ),
    );
  }

  Widget _row({
    required String title,
    required String summary,
    required bool imported,
    String note = '',
  }) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(14, 6, 8, 6),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Icon(
            imported ? LucideIcons.check : LucideIcons.circle,
            size: 13,
            color: imported ? PB.success : PB.textQuaternary,
          ),
          const SizedBox(width: 8),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  title,
                  style: TextStyle(
                    fontSize: PB.fsXs,
                    color: imported ? PB.textQuaternary : PB.textPrimary,
                  ),
                ),
                if (summary.isNotEmpty) ...[
                  const SizedBox(height: 2),
                  Text(
                    summary,
                    maxLines: 2,
                    overflow: TextOverflow.ellipsis,
                    style: const TextStyle(
                      fontSize: PB.fsXxs,
                      color: PB.textQuaternary,
                      height: 1.5,
                    ),
                  ),
                ],
                if (note.isNotEmpty) ...[
                  const SizedBox(height: 2),
                  Text(
                    note,
                    style: const TextStyle(fontSize: 9, color: PB.warn),
                  ),
                ],
              ],
            ),
          ),
          if (!imported)
            TextButton(
              onPressed: _busy ? null : () => _import([title]),
              child: const Text('导入', style: TextStyle(fontSize: PB.fsXs)),
            )
          else
            const Padding(
              padding: EdgeInsets.symmetric(horizontal: 12),
              child: Text(
                '已导入',
                style: TextStyle(fontSize: PB.fsXxs, color: PB.textQuaternary),
              ),
            ),
        ],
      ),
    );
  }
}
