import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../l10n/l10n.dart';
import '../models.dart';
import '../scope.dart';
import '../theme.dart';
import 'toast.dart';

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
  State<LocalCapabilitiesSection> createState() =>
      _LocalCapabilitiesSectionState();
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
    final r = await AppScope.of(context)
        .importLocalCapabilities(kind: widget.kind, names: names);
    if (!mounted) return;
    setState(() => _busy = false);

    final strings = L10n.s(context);
    final msg = [
      if (r.imported.isNotEmpty)
        strings.tf('skills.localImported', {
          'n': r.imported.length,
          'names': r.imported.join(strings.t('conn.listSeparator')),
        }),
      if (r.skipped.isNotEmpty)
        strings.tf('skills.localSkipped', {
          'names': r.skipped.join(strings.t('conn.listSeparator')),
        }),
    ].join('\n');
    if (msg.isNotEmpty) {
      toast(context, msg, kind: ToastKind.success);
    }
  }

  @override
  Widget build(BuildContext context) {
    final strings = L10n.s(context);
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
    // 头部只放计数（名单可能很长，具体是哪些放 tooltip）。
    // ★ 这里必须写 ${pending.length} 而不是 $pending.length —— 后者会插值整个
    // List 再拼上字面量 ".length"，一行能扫出一万多像素宽（真实事故）。
    final summary = pending.isEmpty
        ? strings.tf('skills.localAllImported', {'n': entries.length})
        : strings.tf('skills.localSummary', {
            'total': entries.length,
            'pending': pending.length,
          });

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
                    _expanded
                        ? LucideIcons.chevronDown
                        : LucideIcons.chevronRight,
                    size: 15,
                    color: PB.textTertiary,
                  ),
                  const SizedBox(width: 8),
                  Icon(
                    LucideIcons.hardDriveDownload,
                    size: 14,
                    color: PB.colors(context).accentBright,
                  ),
                  const SizedBox(width: 7),
                  // 左边这段（标题 + 名单）可以缩短，右边的「全部导入」优先保位置
                  Expanded(
                    child: Tooltip(
                      message: pending.isEmpty
                          ? strings.tf('skills.localAllImported', {
                              'n': entries.length,
                            })
                          : strings.tf('skills.localPendingTip', {
                              'names': pending.join(
                                strings.t('conn.listSeparator'),
                              ),
                            }),
                      waitDuration: const Duration(milliseconds: 500),
                      child: Row(
                        children: [
                          Text(
                            strings.t('skills.localInstalled'),
                            style: TextStyle(
                              fontSize: PB.fsXs,
                              fontWeight: FontWeight.w600,
                              color: PB.textSecondary,
                            ),
                          ),
                          const SizedBox(width: 8),
                          Expanded(
                            child: Text(
                              summary,
                              maxLines: 1,
                              overflow: TextOverflow.ellipsis,
                              style: TextStyle(
                                fontSize: PB.fsXxs,
                                color: PB.textQuaternary,
                              ),
                            ),
                          ),
                        ],
                      ),
                    ),
                  ),
                  if (pending.isNotEmpty)
                    TextButton(
                      onPressed: _busy ? null : () => _import(pending),
                      child: Text(
                        _busy
                            ? strings.t('skills.localImporting')
                            : strings.t('skills.localImportAll'),
                        style: const TextStyle(fontSize: PB.fsXs),
                      ),
                    ),
                ],
              ),
            ),
          ),
          if (_expanded) ...[
            Divider(height: 1, color: PB.borderTertiary),
            Padding(
              padding: const EdgeInsets.fromLTRB(14, 10, 14, 4),
              child: Text(
                strings.tf(
                  isSkill ? 'skills.localScanSkill' : 'skills.localScanMcp',
                  {'root': root},
                ),
                style: TextStyle(
                  fontSize: PB.fsXxs,
                  color: PB.textQuaternary,
                  height: 1.6,
                ),
              ),
            ),
            for (final e in entries)
              _row(
                title: isSkill
                    ? (e as LocalSkillEntry).title
                    : (e as LocalMcpEntry).name,
                summary: isSkill
                    ? (e as LocalSkillEntry).summary
                    : [
                        if ((e as LocalMcpEntry).isHttp)
                          'HTTP'
                        else
                          strings.t('skills.localLocal'),
                        e.target,
                      ].where((x) => x.isNotEmpty).join(' · '),
                imported: isSkill
                    ? (e as LocalSkillEntry).imported
                    : (e as LocalMcpEntry).imported,
                note: isSkill && (e as LocalSkillEntry).truncated
                    ? strings.t('skills.localTruncated')
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
                    style: TextStyle(
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
              child: Text(
                L10n.s(context).t('skills.localImport'),
                style: const TextStyle(fontSize: PB.fsXs),
              ),
            )
          else
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: 12),
              child: Text(
                L10n.s(context).t('skills.localImportedBadge'),
                style: TextStyle(
                  fontSize: PB.fsXxs,
                  color: PB.textQuaternary,
                ),
              ),
            ),
        ],
      ),
    );
  }
}
