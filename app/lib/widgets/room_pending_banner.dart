import '../app_state.dart';
import '../l10n/l10n.dart';
import '../markdown_inline.dart';
import '../models.dart';

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
