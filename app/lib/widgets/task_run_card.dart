/// TaskRun 状态卡与详情：只展示状态与回调，不持状态机。
library;

import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../task_run_controller.dart';
import '../task_run_models.dart';
import '../theme.dart';

Color _stateColor(String state) {
  switch (state) {
    case 'running':
    case 'verifying':
      return PB.accent;
    case 'waiting_approval':
    case 'waiting_input':
    case 'waiting_dependency':
      return PB.warn;
    case 'blocked':
      return PB.danger;
    case 'completed':
      return PB.success;
    case 'cancelled':
      return PB.textTertiary;
    case 'paused_user':
    case 'paused_budget':
      return PB.textTertiary;
    default:
      return PB.accent;
  }
}

IconData _stateIcon(String state) {
  switch (state) {
    case 'completed':
      return LucideIcons.circleCheck;
    case 'blocked':
      return LucideIcons.circle;
    case 'waiting_approval':
    case 'waiting_input':
      return LucideIcons.clock;
    case 'paused_user':
    case 'paused_budget':
      return LucideIcons.clock;
    default:
      return LucideIcons.listChecks;
  }
}

/// 输入框上方的一条任务状态带（窄屏也放得下）。
class TaskRunStrip extends StatelessWidget {
  const TaskRunStrip({
    super.key,
    required this.controller,
    required this.roomId,
    required this.onOpen,
    this.onOpenHistory,
  });

  final TaskRunController controller;
  final String roomId;
  final void Function(TaskRun task) onOpen;
  final VoidCallback? onOpenHistory;

  @override
  Widget build(BuildContext context) {
    return ListenableBuilder(
      listenable: controller,
      builder: (context, _) {
        final tasks = controller.forRoom(roomId);
        final allRoom = controller.forRoom(roomId, includeDone: true);
        final hasHistory = allRoom.any((t) => !t.isActive);
        final hasOverflow = allRoom.length > tasks.take(2).length;
        if (tasks.isEmpty && !hasHistory && !hasOverflow) return const SizedBox.shrink();
        return Padding(
          padding: const EdgeInsets.fromLTRB(12, 4, 12, 0),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              for (final task in tasks.take(2))
                TaskRunCard(
                  key: ValueKey(task.id),
                  task: task,
                  compact: true,
                  onOpen: () => onOpen(task),
                ),
              if ((hasHistory || hasOverflow) && onOpenHistory != null)
                Align(
                  alignment: Alignment.centerLeft,
                  child: TextButton.icon(
                    onPressed: onOpenHistory,
                    icon: const Icon(LucideIcons.listChecks, size: 14),
                    label: const Text('任务记录', style: TextStyle(fontSize: 12)),
                  ),
                ),
            ],
          ),
        );
      },
    );
  }
}

class TaskRunCard extends StatelessWidget {
  const TaskRunCard({
    super.key,
    required this.task,
    this.compact = false,
    this.onOpen,
  });

  final TaskRun task;
  final bool compact;
  final VoidCallback? onOpen;

  @override
  Widget build(BuildContext context) {
    final accent = PB.colors(context).accent;
    final color = task.state == 'running' || task.state == 'verifying'
        ? accent
        : _stateColor(task.state);
    return Padding(
      padding: const EdgeInsets.only(bottom: 6),
      child: Material(
        color: PB.bgElevated,
        borderRadius: BorderRadius.circular(PB.rXl),
        child: InkWell(
          borderRadius: BorderRadius.circular(PB.rXl),
          onTap: onOpen,
          child: Container(
            decoration: BoxDecoration(
              borderRadius: BorderRadius.circular(PB.rXl),
              border: Border.all(color: color.withValues(alpha: 0.35)),
            ),
            padding: EdgeInsets.symmetric(horizontal: 12, vertical: compact ? 8 : 12),
            child: Row(
              children: [
                Icon(_stateIcon(task.state), size: 16, color: color),
                const SizedBox(width: 8),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      Text(
                        task.title.isEmpty ? '任务' : task.title,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: const TextStyle(fontSize: 14, fontWeight: FontWeight.w600),
                      ),
                      if (!compact || task.waiting != null) ...[
                        const SizedBox(height: 2),
                        Text(
                          _subtitle(task),
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: TextStyle(fontSize: 12, color: color),
                        ),
                      ],
                    ],
                  ),
                ),
                const SizedBox(width: 8),
                // 默认不限额：只有用户自己设了硬上限时才显示，避免多一个没用的数字。
                if (!compact && task.budget.maxRuns != null)
                  Text(
                    '上限 ${task.budgetText}',
                    style: TextStyle(fontSize: 12, color: PB.textTertiary),
                  ),
              ],
            ),
          ),
        ),
      ),
    );
  }

  static String _subtitle(TaskRun task) {
    // 需要人处理的先说明原因：用户最想知道的是「为什么停了、我该做什么」。
    if (task.state == 'blocked') {
      final why = task.blockedReason;
      return why.isEmpty ? '已受阻，可在详情里解除' : '受阻：$why';
    }
    if (task.waiting != null) {
      final kind = task.waiting!.kind == 'approval'
          ? '等待批准'
          : task.waiting!.kind == 'input'
              ? '等待补充信息'
              : '等待成员交付';
      return kind;
    }
    // 有子任务时优先显示团队进度 + 谁在跟，比内部状态名有用。
    final children = task.childrenSummary;
    if (children != null && !children.isEmpty) {
      final parts = <String>[task.stateText, children.progressText];
      final following = children.participants
          .where((p) => !p.done && p.name.isNotEmpty)
          .map((p) => p.name)
          .take(3)
          .toList();
      if (following.isNotEmpty) parts.add('${following.join('、')} 在跟');
      return parts.join(' · ');
    }
    if (task.unmet.isNotEmpty) return '还缺：${task.unmet.first}';
    if (task.result.prepared) return '结果已准备，待送达';
    return task.stateText;
  }
}
