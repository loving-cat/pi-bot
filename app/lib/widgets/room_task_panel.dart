import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../scope.dart';
import '../task_run_models.dart';
import '../theme.dart';

/// 右侧面板里的任务区：这个会话当前的根任务与跟进情况。
///
/// 放在右侧面板而不是输入框上方：任务是一条持续状态，不是每次输入都要看的东西，
/// 贴在输入框上方会随消息滚动挤占视线；放面板里可以一直挂着、点开看详情。
class RoomTaskPanel extends StatelessWidget {
  const RoomTaskPanel({
    super.key,
    required this.roomId,
    required this.onOpen,
    this.onOpenHistory,
  });

  final String roomId;
  final void Function(TaskRun task) onOpen;

  /// 打开任务历史（已结束/取消的任务）。为空时不显示入口。
  final VoidCallback? onOpenHistory;

  @override
  Widget build(BuildContext context) {
    final state = AppScope.of(context);
    return ListenableBuilder(
      listenable: state.taskRuns,
      builder: (context, _) {
        final tasks = state.taskRuns.forRoom(roomId);
        if (tasks.isEmpty) return const SizedBox.shrink();
        return Padding(
          padding: const EdgeInsets.fromLTRB(18, 12, 18, 4),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                children: [
                  Icon(LucideIcons.listChecks, size: 13, color: PB.textTertiary),
                  const SizedBox(width: 6),
                  Text(
                    '任务',
                    style: TextStyle(
                      fontSize: PB.fsXs,
                      fontWeight: FontWeight.w600,
                      color: PB.textSecondary,
                    ),
                  ),
                  const Spacer(),
                  // 历史入口：之前这个面板是死代码，没有任何调用方，
                  // 用户没法回看已经结束的任务。
                  if (onOpenHistory != null)
                    InkWell(
                      onTap: onOpenHistory,
                      borderRadius: BorderRadius.circular(4),
                      child: Padding(
                        padding: const EdgeInsets.symmetric(horizontal: 4, vertical: 2),
                        child: Text(
                          '历史',
                          style: TextStyle(fontSize: PB.fsXs, color: PB.textTertiary),
                        ),
                      ),
                    ),
                ],
              ),
              const SizedBox(height: 6),
              for (final task in tasks.take(3))
                _TaskRow(task: task, onTap: () => onOpen(task)),
            ],
          ),
        );
      },
    );
  }
}

class _TaskRow extends StatelessWidget {
  const _TaskRow({required this.task, required this.onTap});

  final TaskRun task;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final children = task.childrenSummary;
    final subtitle = <String>[task.stateText];
    if (children != null && !children.isEmpty) {
      subtitle.add(children.progressText);
      final following = children.participants
          .where((p) => !p.done && p.name.isNotEmpty)
          .map((p) => p.name)
          .take(2)
          .toList();
      if (following.isNotEmpty) subtitle.add('${following.join('、')} 在跟');
    } else if (task.leadBotName.isNotEmpty) {
      subtitle.add(task.leadBotName);
    }
    return InkWell(
      borderRadius: BorderRadius.circular(6),
      onTap: onTap,
      child: Padding(
        padding: const EdgeInsets.symmetric(vertical: 7),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              task.title.isEmpty ? '任务' : task.title,
              maxLines: 2,
              overflow: TextOverflow.ellipsis,
              style: TextStyle(fontSize: PB.fsXs, color: PB.textPrimary),
            ),
            const SizedBox(height: 2),
            Text(
              subtitle.join(' · '),
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: TextStyle(
                fontSize: PB.fsXs,
                color: task.state == 'blocked' ? PB.danger : PB.textTertiary,
              ),
            ),
          ],
        ),
      ),
    );
  }
}