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

  // ★ 开场白里的「你现在想做什么」不算「待你处理」。
  //   首开私聊时 bot 会自动自我介绍并弹一张 ask 卡片（服务端 greetDm），
  //   那不是它卡在等你，而是它刚坐下开口。用户还没在这个会话里说过话，
  //   就把这种未回答的 ask 计进待处理，右栏和列表会一直挂着「待回复」。
  final openingOnly = !msgs.any((m) => m.isUser);

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
      // 开场问候（还没聊过）或开场轮次里产生的问句：不弹待处理。
      if (openingOnly || m.meta?['opening'] == true) continue;
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
