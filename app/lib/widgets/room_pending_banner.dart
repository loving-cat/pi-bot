import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../app_state.dart';
import '../l10n/l10n.dart';
import '../markdown_inline.dart';
import '../models.dart';
import '../platform.dart';
import '../scope.dart';
import '../theme.dart';

enum PendingActionKind { confirmation, approval, ask, taskNeedsUser }

class PendingRoomAction {
  const PendingRoomAction({
    required this.room,
    required this.kind,
    required this.summary,
    this.actionId,
    this.irreversible = false,
  });

  final Room room;
  final PendingActionKind kind;
  final String summary;
  final String? actionId;
  final bool irreversible;

  bool get canInlineDecide {
    if (actionId == null || actionId!.isEmpty) return false;
    if (kind == PendingActionKind.approval) return true;
    if (kind == PendingActionKind.confirmation) return isMobilePlatform;
    return false;
  }

  String badgeLabel(AppStrings s) => switch (kind) {
        PendingActionKind.confirmation => s.t('rooms.badgeConfirm'),
        PendingActionKind.approval => s.t('rooms.badgeApproval'),
        PendingActionKind.ask || PendingActionKind.taskNeedsUser =>
          s.t('rooms.badgeAsk'),
      };
}

/// 检测单个会话是否存在待用户确认 / 审批 / 回复的阻塞项。
PendingRoomAction? detectRoomPendingAction(AppState state, Room room) {
  final loaded = state.messages[room.id];
  final msgs = (loaded != null && loaded.isNotEmpty)
      ? loaded
      : [if (room.lastMessage != null) room.lastMessage!];

  for (var i = msgs.length - 1; i >= 0; i--) {
    final m = msgs[i];
    if (m.isConfirmation) {
      final decision = (m.meta?['decision'] as String?) ?? '';
      if (decision.isEmpty) {
        final raw = (m.meta?['summary'] as String?) ?? m.text;
        return PendingRoomAction(
          room: room,
          kind: PendingActionKind.confirmation,
          summary: markdownPreviewText(raw, maxChars: 72),
          actionId: m.confirmationId,
          irreversible: m.meta?['irreversible'] == true,
        );
      }
    }
    if (m.isApproval) {
      final decision = m.approvalDecision ?? '';
      if (decision.isEmpty) {
        final raw = m.approvalSummary ?? m.text;
        return PendingRoomAction(
          room: room,
          kind: PendingActionKind.approval,
          summary: markdownPreviewText(raw, maxChars: 72),
          actionId: m.approvalId,
        );
      }
    }
    if (m.isAsk && !m.askAnswered) {
      return PendingRoomAction(
        room: room,
        kind: PendingActionKind.ask,
        summary: markdownPreviewText(m.text, maxChars: 72),
      );
    }
  }

  for (final task in state.taskRuns.forRoom(room.id)) {
    if (task.phase == 'needs_user' ||
        task.state == 'waiting_approval' ||
        task.state == 'waiting_input') {
      return PendingRoomAction(
        room: room,
        kind: task.state == 'waiting_approval'
            ? PendingActionKind.approval
            : PendingActionKind.taskNeedsUser,
        summary: task.title.isNotEmpty ? task.title : room.name,
      );
    }
  }

  return null;
}

/// 收集可见会话中的所有待处理项。
List<PendingRoomAction> collectPendingRoomActions(AppState state) {
  final out = <PendingRoomAction>[];
  for (final room in state.rooms) {
    if (room.hidden) continue;
    final hit = detectRoomPendingAction(state, room);
    if (hit != null) out.add(hit);
  }
  return out;
}

/// 会话列表顶部的「待你处理」聚合条：支持移动端/桌面端一键审批或直达上下文。
class PendingActionsBanner extends StatefulWidget {
  const PendingActionsBanner({
    super.key,
    required this.items,
    required this.onOpenRoom,
  });

  final List<PendingRoomAction> items;
  final void Function(Room room) onOpenRoom;

  @override
  State<PendingActionsBanner> createState() => _PendingActionsBannerState();
}

class _PendingActionsBannerState extends State<PendingActionsBanner> {
  String? _sendingKey;

  Future<void> _decide(PendingRoomAction item, bool approve) async {
    final id = item.actionId;
    if (id == null || id.isEmpty) return;
    final key = '${item.kind.name}:$id';
    if (_sendingKey == key) return;
    setState(() => _sendingKey = key);
    HapticFeedback.mediumImpact();
    final state = AppScope.read(context);
    try {
      if (item.kind == PendingActionKind.confirmation) {
        await state.decideConfirmation(id, approve: approve);
      } else if (item.kind == PendingActionKind.approval) {
        await state.decideApproval(id, approve: approve);
      }
    } finally {
      if (mounted) setState(() => _sendingKey = null);
    }
  }

  @override
  Widget build(BuildContext context) {
    if (widget.items.isEmpty) return const SizedBox.shrink();
    final s = L10n.s(context);
    final first = widget.items.first;
    final tone = first.irreversible ? PB.danger : PB.warn;
    final busy =
        _sendingKey == '${first.kind.name}:${first.actionId ?? ''}';

    return Container(
      key: const ValueKey('pending-actions-banner'),
      margin: const EdgeInsets.fromLTRB(4, 6, 4, 8),
      decoration: BoxDecoration(
        color: PB.bgElevated,
        borderRadius: BorderRadius.circular(PB.rXl),
        border: Border.all(color: tone.withValues(alpha: 0.42)),
      ),
      child: Material(
        color: Colors.transparent,
        borderRadius: BorderRadius.circular(PB.rXl),
        child: InkWell(
          borderRadius: BorderRadius.circular(PB.rXl),
          onTap: () => widget.onOpenRoom(first.room),
          child: Padding(
            padding: const EdgeInsets.fromLTRB(12, 10, 12, 10),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Row(
                  children: [
                    Icon(
                      first.kind == PendingActionKind.confirmation
                          ? LucideIcons.smartphone
                          : first.kind == PendingActionKind.approval
                              ? LucideIcons.shieldAlert
                              : LucideIcons.messageCircleQuestionMark,
                      size: 15,
                      color: tone,
                    ),
                    const SizedBox(width: 7),
                    Expanded(
                      child: Text(
                        s.tf('rooms.pendingTitle', {'n': widget.items.length}),
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: TextStyle(
                          fontSize: PB.fsXs,
                          fontWeight: FontWeight.w600,
                          color: tone,
                        ),
                      ),
                    ),
                    const SizedBox(width: 6),
                    Flexible(
                      flex: 0,
                      child: Container(
                        padding: const EdgeInsets.symmetric(
                          horizontal: 7,
                          vertical: 2,
                        ),
                        decoration: BoxDecoration(
                          color: PB.bgBubble,
                          borderRadius: BorderRadius.circular(PB.rFull),
                          border: Border.all(color: PB.borderTertiary),
                        ),
                        child: Text(
                          first.room.name,
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: TextStyle(
                            fontSize: PB.fsXxs,
                            color: PB.textSecondary,
                          ),
                        ),
                      ),
                    ),
                  ],
                ),
                const SizedBox(height: 6),
                Text(
                  first.summary.isEmpty
                      ? first.badgeLabel(s)
                      : first.summary,
                  maxLines: 2,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(
                    fontSize: PB.fsXs,
                    color: PB.textPrimary,
                    height: 1.4,
                  ),
                ),
                const SizedBox(height: 8),
                Wrap(
                  spacing: 6,
                  runSpacing: 6,
                  alignment: WrapAlignment.end,
                  children: [
                    if (first.canInlineDecide) ...[
                      OutlinedButton(
                        onPressed: busy ? null : () => _decide(first, false),
                        style: OutlinedButton.styleFrom(
                          visualDensity: VisualDensity.compact,
                          padding: const EdgeInsets.symmetric(
                            horizontal: 10,
                            vertical: 4,
                          ),
                          minimumSize: Size.zero,
                          tapTargetSize: MaterialTapTargetSize.shrinkWrap,
                        ),
                        child: Text(
                          s.t('approval.reject'),
                          style: const TextStyle(fontSize: PB.fsXxs),
                        ),
                      ),
                      FilledButton(
                        onPressed: busy ? null : () => _decide(first, true),
                        style: FilledButton.styleFrom(
                          backgroundColor:
                              first.irreversible ? PB.danger : null,
                          visualDensity: VisualDensity.compact,
                          padding: const EdgeInsets.symmetric(
                            horizontal: 10,
                            vertical: 4,
                          ),
                          minimumSize: Size.zero,
                          tapTargetSize: MaterialTapTargetSize.shrinkWrap,
                        ),
                        child: Text(
                          s.t('approval.approveOnce'),
                          style: const TextStyle(fontSize: PB.fsXxs),
                        ),
                      ),
                    ],
                    TextButton(
                      onPressed: () => widget.onOpenRoom(first.room),
                      style: TextButton.styleFrom(
                        visualDensity: VisualDensity.compact,
                        padding: const EdgeInsets.symmetric(
                          horizontal: 8,
                          vertical: 4,
                        ),
                        minimumSize: Size.zero,
                        tapTargetSize: MaterialTapTargetSize.shrinkWrap,
                      ),
                      child: Text(
                        s.t('rooms.pendingOpen'),
                        style: TextStyle(
                          fontSize: PB.fsXxs,
                          color: PB.colors(context).link,
                        ),
                      ),
                    ),
                  ],
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}
