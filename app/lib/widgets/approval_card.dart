import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../l10n/l10n.dart';
import '../models.dart';
import '../theme.dart';

/// 「要动手了，批不批」卡片。
///
/// 部门规矩设成"需要批准"时，bot 每一次会改文件/跑命令的调用都会先发这张卡。
/// 点批准 → 服务端放行这一次（只放一次），并让它接着做完；点拒绝 → 记一条拒绝，
/// 它不会硬来。
class ApprovalCard extends StatefulWidget {
  const ApprovalCard({super.key, required this.msg, required this.onDecide});

  final Msg msg;

  /// approve=true 批准，false 拒绝
  final void Function(bool approve) onDecide;

  @override
  State<ApprovalCard> createState() => _ApprovalCardState();
}

class _ApprovalCardState extends State<ApprovalCard> {
  bool _sent = false;

  @override
  Widget build(BuildContext context) {
    final strings = L10n.s(context);
    final decision = widget.msg.approvalDecision;
    final decided = decision != null && decision.isNotEmpty;
    final approved = decision == 'approved' || decision == 'consumed';
    // 优先用服务端下发的结构化摘要；完全没有时才退回正文。
    //
    // 不按中文前缀"想执行："去剥离：界面语言可切到英文，而服务端正文
    // 由服务端语言决定，靠字符串匹配会在另一侧失效。
    final summary = widget.msg.approvalSummary ?? widget.msg.text;
    final tool = widget.msg.approvalTool ?? '';

    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 4),
      child: ConstrainedBox(
        constraints: const BoxConstraints(maxWidth: 520),
        child: Container(
          padding: const EdgeInsets.fromLTRB(14, 12, 14, 12),
          decoration: BoxDecoration(
            color: PB.bgElevated,
            borderRadius: BorderRadius.circular(PB.rXl),
            border: Border.all(
              color: decided
                  ? (approved
                        ? PB.success.withValues(alpha: 0.25)
                        : PB.danger.withValues(alpha: 0.3))
                  : PB.warn.withValues(alpha: 0.45),
            ),
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            mainAxisSize: MainAxisSize.min,
            children: [
              Row(
                children: [
                  Icon(
                    decided
                        ? (approved
                              ? LucideIcons.shieldCheck
                              : LucideIcons.shieldX)
                        : LucideIcons.shieldAlert,
                    size: 15,
                    color: decided
                        ? (approved ? PB.success : PB.danger)
                        : PB.warn,
                  ),
                  const SizedBox(width: 7),
                  Text(
                    decided
                        ? (approved
                              ? strings.t('approval.approved')
                              : strings.t('approval.rejected'))
                        : strings.tf('approval.needsApproval', {
                            'name': widget.msg.authorName,
                          }),
                    style: TextStyle(
                      fontSize: PB.fsXxs,
                      fontWeight: FontWeight.w600,
                      color: decided
                          ? (approved ? PB.success : PB.danger)
                          : PB.warn,
                    ),
                  ),
                  if (tool.isNotEmpty) ...[
                    const SizedBox(width: 6),
                    Text(
                      tool,
                      style: const TextStyle(
                        fontFamily: PB.monoFamily,
                        fontFamilyFallback: PB.monoFallback,
                        fontSize: PB.fsXxs,
                        color: PB.textQuaternary,
                      ),
                    ),
                  ],
                ],
              ),
              const SizedBox(height: 8),
              Text(
                summary,
                maxLines: 4,
                overflow: TextOverflow.ellipsis,
                style: const TextStyle(
                  fontFamily: PB.monoFamily,
                  fontFamilyFallback: PB.monoFallback,
                  fontSize: PB.fsXs,
                  color: PB.textPrimary,
                  height: 1.5,
                ),
              ),
              if (!decided) ...[
                const SizedBox(height: 10),
                Row(
                  mainAxisAlignment: MainAxisAlignment.end,
                  children: [
                    TextButton(
                      onPressed: _sent
                          ? null
                          : () {
                              setState(() => _sent = true);
                              widget.onDecide(false);
                            },
                      child: Text(strings.t('approval.reject')),
                    ),
                    const SizedBox(width: 6),
                    FilledButton(
                      onPressed: _sent
                          ? null
                          : () {
                              setState(() => _sent = true);
                              widget.onDecide(true);
                            },
                      child: Text(strings.t('approval.approveOnce')),
                    ),
                  ],
                ),
              ] else
                Padding(
                  padding: const EdgeInsets.only(top: 8),
                  child: Text(
                    strings.t(
                      approved
                          ? 'approval.approvedHint'
                          : 'approval.rejectedHint',
                    ),
                    style: const TextStyle(
                      fontSize: PB.fsXxs,
                      color: PB.textQuaternary,
                    ),
                  ),
                ),
            ],
          ),
        ),
      ),
    );
  }
}
