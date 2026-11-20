import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../app_state.dart';
import '../l10n/l10n.dart';
import '../models.dart';
import '../scope.dart';
import '../theme.dart';

/// 主控总汇总的右上角浮窗（规格 `docs/SPEC-CHIEF-SUMMARY.md` §4）。
///
/// 三种视觉态：
///   1. `ready_blocked` → 展开卡片（最多渲 1 张，其余只报数量）：是 · 发送 / 否 · 暂不 / 忽略；
///   2. `deferred` → 右上角小角标「汇总待看 (n)」，点一下就地展开；
///   3. `queued_send` / `sending` → 只读胶囊「本轮结束后发送汇总」/「正在汇总…」。
///
/// ## 动效红线
///
/// 静止态**不许有常驻 Ticker**：这里没有任何 `AnimationController`
/// （`docs/SPEC-MOTION-V1.md` 要求空闲 6 秒归零）。点按反馈交给 Material 自带的 InkWell。
class ChiefSummaryCard extends StatefulWidget {
  const ChiefSummaryCard({super.key});

  @override
  State<ChiefSummaryCard> createState() => _ChiefSummaryCardState();
}

class _ChiefSummaryCardState extends State<ChiefSummaryCard> {
  /// `deferred` 时用户点开小角标 → 就地展开；换批次时重置
  bool _expanded = false;
  String? _expandedFor;

  /// 防连点：三选一是写操作，重复点会重复打 `/resolve`
  bool _submitting = false;

  Future<void> _resolve(
    AppState state,
    ChiefSummary summary,
    String action, {
    bool notifyOnSend = false,
  }) async {
    if (_submitting) return;
    setState(() => _submitting = true);
    try {
      final err = await state.resolveSummary(summary.id, action);
      if (!mounted) return;
      final messenger = ScaffoldMessenger.maybeOf(context);
      if (err != null) {
        messenger?.showSnackBar(SnackBar(content: Text(err)));
        return;
      }
      // 跨房间：在部门群里点了「是」，汇总落到主控私聊 —— 得给一条可点的路径，
      // 否则用户会觉得"点了没反应"（规格 §4.3）。
      if (notifyOnSend && summary.originRoomId.isNotEmpty) {
        messenger?.showSnackBar(
          SnackBar(
            content: Text(L10n.s(context).t('chat.summarySentHint')),
            action: SnackBarAction(
              label: L10n.s(context).t('chat.summaryGoCheck'),
              onPressed: () => requestRoom(context, summary.originRoomId),
            ),
          ),
        );
      }
    } finally {
      if (mounted) setState(() => _submitting = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final state = AppScope.of(context);
    final strings = L10n.s(context);
    final items = state.summaries;
    if (items.isEmpty) return const SizedBox.shrink();

    final ready = items.where((s) => s.isReady).toList();
    final deferred = items.where((s) => s.isDeferred).toList();
    final busy = items.where((s) => s.isBusySending).toList();

    // 1. 有就绪的：渲队列头，其余只报数量（防刷屏）
    if (ready.isNotEmpty) {
      final head = ready.first;
      return _card(
        context,
        strings: strings,
        summary: head,
        others: ready.length - 1 + deferred.length,
        busy: _submitting,
        onSend: () => _resolve(state, head, 'send', notifyOnSend: true),
        onDefer: () => _resolve(state, head, 'defer'),
        onIgnore: () => _resolve(state, head, 'ignore'),
      );
    }

    // 2. 全部「暂不」：小角标，点开就地展开
    if (deferred.isNotEmpty) {
      final head = deferred.first;
      final isOpen = _expanded && _expandedFor == head.id;
      if (!isOpen) {
        return _pill(
          context,
          icon: LucideIcons.inbox,
          label: strings.tf('chat.summaryPill', {'n': deferred.length}),
          onTap: () => setState(() {
            _expanded = true;
            _expandedFor = head.id;
          }),
        );
      }
      return _card(
        context,
        strings: strings,
        summary: head,
        others: deferred.length - 1,
        busy: _submitting,
        onSend: () => _resolve(state, head, 'send', notifyOnSend: true),
        onDefer: () => setState(() => _expanded = false),
        onIgnore: () => _resolve(state, head, 'ignore'),
        deferLabel: strings.t('chat.summaryCollapse'),
      );
    }

    // 3. 正在发 / 已排队：只读，不打扰用户
    if (busy.isNotEmpty) {
      final head = busy.first;
      final label = head.state == 'sending'
          ? strings.t('chat.summarySending')
          : strings.t('chat.summaryQueued');
      return _pill(context, icon: LucideIcons.hourglass, label: label);
    }

    return const SizedBox.shrink();
  }

  Widget _pill(
    BuildContext context, {
    required IconData icon,
    required String label,
    VoidCallback? onTap,
  }) {
    final content = Container(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
      decoration: BoxDecoration(
        color: PB.bgPane,
        borderRadius: BorderRadius.circular(PB.rFull),
        border: Border.all(color: PB.borderSecondary),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(icon, size: 13, color: PB.textTertiary),
          const SizedBox(width: 6),
          Text(label, style: TextStyle(fontSize: PB.fsXxs, color: PB.textSecondary)),
        ],
      ),
    );
    if (onTap == null) return content;
    return GestureDetector(onTap: onTap, child: content);
  }

  Widget _card(
    BuildContext context, {
    required AppStrings strings,
    required ChiefSummary summary,
    required bool busy,
    required int others,
    required VoidCallback onSend,
    required VoidCallback onDefer,
    required VoidCallback onIgnore,
    String? deferLabel,
  }) {
    final accent = PB.colors(context).accentBright;
    return Container(
      padding: const EdgeInsets.fromLTRB(12, 10, 12, 8),
      decoration: BoxDecoration(
        color: PB.bgPane,
        borderRadius: BorderRadius.circular(PB.rXl),
        border: Border.all(color: accent.withValues(alpha: 0.45)),
        boxShadow: [
          BoxShadow(
            color: Colors.black.withValues(alpha: 0.16),
            blurRadius: 18,
            offset: const Offset(0, 6),
          ),
        ],
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        mainAxisSize: MainAxisSize.min,
        children: [
          Text(
            strings.tf('chat.summaryReadyTitle', {
              'title': summary.taskTitle.isEmpty
                  ? strings.t('chat.summaryUntitled')
                  : summary.taskTitle,
            }),
            maxLines: 2,
            overflow: TextOverflow.ellipsis,
            style: TextStyle(
              fontSize: PB.fsXs,
              fontWeight: FontWeight.w600,
              color: PB.textPrimary,
            ),
          ),
          const SizedBox(height: 4),
          Text(
            _progressLine(strings, summary),
            maxLines: 2,
            overflow: TextOverflow.ellipsis,
            style: TextStyle(fontSize: PB.fsXxs, color: PB.textTertiary),
          ),
          if (summary.lastError.isNotEmpty) ...[
            const SizedBox(height: 4),
            Text(
              strings.tf('chat.summaryLastError', {'error': summary.lastError}),
              maxLines: 2,
              overflow: TextOverflow.ellipsis,
              style: TextStyle(fontSize: PB.fsXxs, color: PB.warn),
            ),
          ],
          const SizedBox(height: 8),
          Wrap(
            spacing: 6,
            runSpacing: 6,
            children: [
              _action(
                context,
                label: strings.t('chat.summarySend'),
                primary: true,
                enabled: !busy,
                onTap: onSend,
              ),
              _action(
                context,
                label: deferLabel ?? strings.t('chat.summaryDefer'),
                enabled: !busy,
                onTap: onDefer,
              ),
              _action(
                context,
                label: strings.t('chat.summaryIgnore'),
                enabled: !busy,
                onTap: onIgnore,
              ),
            ],
          ),
          if (others > 0) ...[
            const SizedBox(height: 6),
            Text(
              strings.tf('chat.summaryMore', {'n': others}),
              style: TextStyle(fontSize: PB.fsXxs, color: PB.textQuaternary),
            ),
          ],
        ],
      ),
    );
  }

  String _progressLine(AppStrings strings, ChiefSummary summary) {
    if (summary.failedCount > 0) {
      return strings.tf('chat.summaryProgressMixed', {
        'done': summary.doneCount,
        'failed': summary.failedCount,
      });
    }
    return strings.tf('chat.summaryProgressDone', {'done': summary.doneCount});
  }

  Widget _action(
    BuildContext context, {
    required String label,
    required VoidCallback onTap,
    bool primary = false,
    bool enabled = true,
  }) {
    final accent = PB.colors(context).accentBright;
    final color = primary ? accent : PB.textSecondary;
    // Material + InkWell：之前 InkWell 包不透明 Container，水波纹被盖住、点了没反馈
    return Material(
      color: primary ? accent.withValues(alpha: 0.16) : PB.bgActive,
      borderRadius: BorderRadius.circular(PB.rFull),
      child: InkWell(
        onTap: enabled ? onTap : null,
        borderRadius: BorderRadius.circular(PB.rFull),
        child: Container(
          padding: const EdgeInsets.symmetric(horizontal: 9, vertical: 5),
          decoration: BoxDecoration(
            borderRadius: BorderRadius.circular(PB.rFull),
            border: Border.all(
              color: primary ? accent.withValues(alpha: 0.55) : PB.borderTertiary,
            ),
          ),
          child: Text(
            label,
            style: TextStyle(
              fontSize: PB.fsXxs,
              color: enabled ? color : PB.textQuaternary,
              fontWeight: primary ? FontWeight.w600 : FontWeight.w400,
            ),
          ),
        ),
      ),
    );
  }
}
