import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../grant_view.dart';
import '../l10n/l10n.dart';
import '../scope.dart';
import '../theme.dart';
import 'toast.dart';

/// 授权面板（设置在「系统」标签页里）。
///
/// 规格 §11：「用户始终可以接管、取消、收回授权」。
///
/// 服务端从 P0-1 起就在逐条记授权（谁、什么动作、多大范围、多久有效），
/// 但界面里一个字都没有 —— 用户看不到“谁能动什么”，也就收不回：
/// 他连该收哪一条都不知道。
///
/// 这里刻意**只做只读 + 收回**，不做新建授权：
/// 新建授权是规格 §6.1 的授权根，必须来自用户在某次具体交互里的明确同意，
/// 不该是这个面板上“勾一勾”就长出来的东西。
class GrantsSection extends StatefulWidget {
  const GrantsSection({super.key});

  @override
  State<GrantsSection> createState() => _GrantsSectionState();
}

class _GrantsSectionState extends State<GrantsSection> {
  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) {
      AppScope.of(context).loadGrants();
    });
  }

  Future<void> _revoke(GrantView g, String botName) async {
    final s = L10n.s(context);
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: Text(s.t('settings.grants.revokeTitle')),
        content: Text(
          s.tf('settings.grants.revokeBody', {
            'bot': botName,
            'actions': g.actionSummary,
          }),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(ctx, false),
            child: Text(s.t('common.cancel')),
          ),
          TextButton(
            onPressed: () => Navigator.pop(ctx, true),
            child: Text(
              s.t('settings.grants.revoke'),
              style: TextStyle(color: PB.danger),
            ),
          ),
        ],
      ),
    );
    if (ok != true || !mounted) return;
    final err = await AppScope.read(context).revokeGrant(g.id);
    if (!mounted) return;
    if (err != null) {
      toast(
        context,
        s.tf('settings.grants.revokeFailed', {'error': err}),
        kind: ToastKind.error,
      );
    }
  }

  @override
  Widget build(BuildContext context) {
    final s = L10n.s(context);
    final state = AppScope.of(context);
    final list = state.grants;
    final current = state.grantPolicyRevision;
    final now = DateTime.now().millisecondsSinceEpoch;

    String botName(String id) {
      for (final b in state.bots) {
        if (b.id == id) return b.name;
      }
      return id;
    }

    return Container(
      margin: const EdgeInsets.only(top: 20),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Icon(LucideIcons.keyRound, size: 16, color: PB.textSecondary),
              const SizedBox(width: 8),
              Text(
                s.t('settings.grants.title'),
                style: TextStyle(
                  fontSize: PB.fsSm,
                  fontWeight: FontWeight.w600,
                  color: PB.textPrimary,
                ),
              ),
              const Spacer(),
              TextButton.icon(
                onPressed: () => state.loadGrants(),
                icon: const Icon(LucideIcons.refreshCw, size: 14),
                label: Text(s.t('common.refresh')),
              ),
            ],
          ),
          const SizedBox(height: 6),
          Text(
            s.t('settings.grants.hint'),
            style: TextStyle(
              fontSize: PB.fsXxs,
              height: 1.5,
              color: PB.textQuaternary,
            ),
          ),
          const SizedBox(height: 12),
          if (!state.grantsLoaded)
            _placeholder(s.t('settings.grants.loading'))
          else if (list.isEmpty)
            _placeholder(s.t('settings.grants.empty'))
          else
            for (final g in list) ...[
              Container(
                width: double.infinity,
                margin: const EdgeInsets.only(bottom: 8),
                padding: const EdgeInsets.fromLTRB(14, 12, 10, 12),
                decoration: BoxDecoration(
                  color: PB.bgBubble,
                  borderRadius: BorderRadius.circular(PB.r2xl),
                ),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Row(
                      children: [
                        Expanded(
                          child: Text(
                            botName(g.botId),
                            style: TextStyle(
                              fontSize: PB.fsSm,
                              fontWeight: FontWeight.w600,
                              color: PB.textPrimary,
                            ),
                          ),
                        ),
                        TextButton(
                          onPressed: () => _revoke(g, botName(g.botId)),
                          style: TextButton.styleFrom(
                            foregroundColor: PB.danger,
                            minimumSize: const Size(0, 30),
                            padding: const EdgeInsets.symmetric(horizontal: 10),
                          ),
                          child: Text(
                            s.t('settings.grants.revoke'),
                            style: const TextStyle(fontSize: PB.fsXs),
                          ),
                        ),
                      ],
                    ),
                    const SizedBox(height: 2),
                    Text(
                      '${g.actionSummary} · ${g.scopeSummary} · ${g.limitSummary}',
                      style: TextStyle(
                        fontSize: PB.fsXs,
                        height: 1.5,
                        color: PB.textSecondary,
                      ),
                    ),
                    if (g.staleForPolicy(current)) ...[
                      const SizedBox(height: 6),
                      _badge(
                        s.t('settings.grants.stale'),
                        color: PB.warn,
                      ),
                    ] else if (g.expiredAt(now)) ...[
                      const SizedBox(height: 6),
                      _badge(s.t('settings.grants.expired'), color: PB.warn),
                    ],
                  ],
                ),
              ),
            ],
        ],
      ),
    );
  }

  Widget _placeholder(String text) => Padding(
    padding: const EdgeInsets.symmetric(vertical: 14),
    child: Center(
      child: Text(
        text,
        textAlign: TextAlign.center,
        style: TextStyle(fontSize: PB.fsXs, color: PB.textQuaternary),
      ),
    ),
  );

  Widget _badge(String text, {required Color color}) => Container(
    padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
    decoration: BoxDecoration(
      color: color.withValues(alpha: 0.12),
      borderRadius: BorderRadius.circular(999),
    ),
    child: Text(
      text,
      style: TextStyle(fontSize: PB.fsXxs, color: color),
    ),
  );
}

/// 授权判定记录面板（与 GrantsSection 同页）。
///
/// 为什么和「授权列表」分开放：一个回答“现在谁能动什么”，
/// 一个回答“最近谁动过、被拦了没有”。混在一起时，用户想查
/// “这活为什么被拒”要在一长串授权里翻。
class GrantAuditSection extends StatefulWidget {
  const GrantAuditSection({super.key});

  @override
  State<GrantAuditSection> createState() => _GrantAuditSectionState();
}

class _GrantAuditSectionState extends State<GrantAuditSection> {
  bool _deniedOnly = false;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) {
      AppScope.of(context).loadGrantAudit();
    });
  }

  @override
  Widget build(BuildContext context) {
    final s = L10n.s(context);
    final state = AppScope.of(context);
    final rows = state.grantAudit;

    return Container(
      margin: const EdgeInsets.only(top: 20),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Icon(LucideIcons.scrollText, size: 16, color: PB.textSecondary),
              const SizedBox(width: 8),
              Text(
                s.t('settings.audit.title'),
                style: TextStyle(
                  fontSize: PB.fsSm,
                  fontWeight: FontWeight.w600,
                  color: PB.textPrimary,
                ),
              ),
              const Spacer(),
              TextButton.icon(
                onPressed: () => state.loadGrantAudit(deniedOnly: _deniedOnly),
                icon: const Icon(LucideIcons.refreshCw, size: 14),
                label: Text(s.t('common.refresh')),
              ),
            ],
          ),
          const SizedBox(height: 6),
          Text(
            s.t('settings.audit.hint'),
            style: TextStyle(
              fontSize: PB.fsXxs,
              height: 1.5,
              color: PB.textQuaternary,
            ),
          ),
          const SizedBox(height: 10),
          Row(
            children: [
              _chip(s.t('settings.audit.all'), !_deniedOnly, () {
                setState(() => _deniedOnly = false);
                state.loadGrantAudit();
              }),
              const SizedBox(width: 8),
              _chip(s.t('settings.audit.deniedOnly'), _deniedOnly, () {
                setState(() => _deniedOnly = true);
                state.loadGrantAudit(deniedOnly: true);
              }),
            ],
          ),
          const SizedBox(height: 10),
          if (!state.grantAuditLoaded)
            _line(s.t('settings.audit.loading'))
          else if (rows.isEmpty)
            _line(s.t('settings.audit.empty'))
          else
            for (final e in rows)
              Padding(
                padding: const EdgeInsets.only(bottom: 6),
                child: Row(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Padding(
                      padding: const EdgeInsets.only(top: 3),
                      child: Icon(
                        e.allowed ? LucideIcons.check : LucideIcons.ban,
                        size: 13,
                        color: e.allowed ? PB.success : PB.danger,
                      ),
                    ),
                    const SizedBox(width: 7),
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(
                            e.summary,
                            style: TextStyle(
                              fontSize: PB.fsXs,
                              color: PB.textSecondary,
                            ),
                          ),
                          if (!e.allowed && e.detail.isNotEmpty)
                            Text(
                              e.detail,
                              style: TextStyle(
                                fontSize: PB.fsXxs,
                                height: 1.4,
                                color: PB.textQuaternary,
                              ),
                            ),
                        ],
                      ),
                    ),
                    if (e.risk.isNotEmpty)
                      Padding(
                        padding: const EdgeInsets.only(left: 6),
                        child: Text(
                          e.risk,
                          style: TextStyle(
                            fontSize: PB.fsXxs,
                            color: e.risk == 'critical' || e.risk == 'high'
                                ? PB.warn
                                : PB.textQuaternary,
                          ),
                        ),
                      ),
                  ],
                ),
              ),
        ],
      ),
    );
  }

  Widget _line(String text) => Padding(
    padding: const EdgeInsets.symmetric(vertical: 12),
    child: Center(
      child: Text(
        text,
        style: TextStyle(fontSize: PB.fsXs, color: PB.textQuaternary),
      ),
    ),
  );

  Widget _chip(String label, bool selected, VoidCallback onTap) => InkWell(
    onTap: onTap,
    borderRadius: BorderRadius.circular(999),
    child: Container(
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 5),
      decoration: BoxDecoration(
        color: selected
            ? PB.accent.withValues(alpha: 0.14)
            : Colors.transparent,
        border: Border.all(
          color: selected ? PB.accent.withValues(alpha: 0.45) : PB.borderSecondary,
        ),
        borderRadius: BorderRadius.circular(999),
      ),
      child: Text(
        label,
        style: TextStyle(
          fontSize: PB.fsXxs,
          color: selected ? PB.accent : PB.textSecondary,
        ),
      ),
    ),
  );
}
