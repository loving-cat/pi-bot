import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../l10n/l10n.dart';
import '../models.dart';
import '../theme.dart';

/// 「这一步不可撤销，得在手机上确认」卡片。
///
/// 和 ApprovalCard 的区别（这个区别是本卡存在的全部理由）：
///
///   · ApprovalCard 管的是**可撤销**动作（写文件、跑命令）。它在本机
///     桌面上点一下就算数 —— 因为搞坏了能重来。
///   · 这张卡管的是**不可撤销**动作（push、删除、对外发送）。规格 §9 说得
///     很硬：主 Bot 拿到宿主 shell 之后能驱动本机界面，所以"本机桌面上的
///     批准"它可以自己点。因此这张卡片在桌面端只显示"去手机上确认"，
///     **不提供批准按钮**。
///
/// 手机端（已配对的独立设备）才显示批准/拒绝。
class ConfirmationCard extends StatefulWidget {
  const ConfirmationCard({
    super.key,
    required this.msg,
    required this.onDecide,
    this.canApproveHere = false,
  });

  final Msg msg;

  /// approve=true 批准，false 拒绝
  final void Function(bool approve) onDecide;

  /// 当前这台设备够不够格确认（只有已配对的独立设备才够）。
  final bool canApproveHere;

  @override
  State<ConfirmationCard> createState() => _ConfirmationCardState();
}

class _ConfirmationCardState extends State<ConfirmationCard> {
  bool _sent = false;

  @override
  Widget build(BuildContext context) {
    final s = L10n.s(context);
    final meta = widget.msg.meta ?? const {};
    final decision = (meta['decision'] as String?) ?? '';
    final decided = decision.isNotEmpty;
    final approved = decision == 'approved' || decision == 'consumed';
    final summary = (meta['summary'] as String?) ?? widget.msg.text;
    final irreversible = meta['irreversible'] == true;

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
                  // 不可撤销的动作一律用更重的边框色 ——
                  // 视觉上要先于文字告诉用户"这条不一样"
                  : (irreversible ? PB.danger : PB.warn).withValues(alpha: 0.45),
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
                        ? (approved ? LucideIcons.shieldCheck : LucideIcons.shieldX)
                        : LucideIcons.smartphone,
                    size: 15,
                    color: decided
                        ? (approved ? PB.success : PB.danger)
                        : (irreversible ? PB.danger : PB.warn),
                  ),
                  const SizedBox(width: 7),
                  Expanded(
                    child: Text(
                      decided
                          ? (approved ? s.t('confirm.approved') : s.t('confirm.rejected'))
                          : (irreversible
                                ? s.t('confirm.needPhoneIrreversible')
                                : s.t('confirm.needPhone')),
                      style: TextStyle(
                        fontSize: PB.fsXxs,
                        fontWeight: FontWeight.w600,
                        color: decided
                            ? (approved ? PB.success : PB.danger)
                            : (irreversible ? PB.danger : PB.warn),
                      ),
                    ),
                  ),
                  if (irreversible)
                    Padding(
                      padding: const EdgeInsets.only(left: 6),
                      child: Text(
                        s.t('confirm.irreversible'),
                        style: TextStyle(fontSize: PB.fsXxs, color: PB.danger),
                      ),
                    ),
                ],
              ),
              const SizedBox(height: 8),
              Text(
                summary,
                maxLines: 5,
                overflow: TextOverflow.ellipsis,
                style: TextStyle(
                  fontFamily: PB.monoFamily,
                  fontFamilyFallback: PB.monoFallback,
                  fontSize: PB.fsXs,
                  color: PB.textPrimary,
                  height: 1.5,
                ),
              ),
              if (!decided) ...[
                const SizedBox(height: 10),
                if (widget.canApproveHere)
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
                        child: Text(s.t('approval.reject')),
                      ),
                      const SizedBox(width: 6),
                      FilledButton(
                        style: FilledButton.styleFrom(
                          backgroundColor: irreversible ? PB.danger : null,
                        ),
                        onPressed: _sent
                            ? null
                            : () {
                                setState(() => _sent = true);
                                widget.onDecide(true);
                              },
                        child: Text(s.t('confirm.approveOnPhone')),
                      ),
                    ],
                  )
                else
                  // ★ 桌面端：不画按钮。
                  //
                  //   画一个按不动的按钮会让人以为是 bug；画一个能按的
                  //   则是假的安全感 —— 服务端会 403（WEAK_CHANNEL），
                  //   而用户已经以为自己批过了。
                  Padding(
                    padding: const EdgeInsets.only(top: 2),
                    child: Text(
                      s.t('confirm.openOnPhone'),
                      style: TextStyle(fontSize: PB.fsXxs, color: PB.textQuaternary),
                    ),
                  ),
              ],
            ],
          ),
        ),
      ),
    );
  }
}
