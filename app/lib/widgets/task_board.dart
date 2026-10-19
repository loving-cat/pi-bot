import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../app_state.dart';
import '../models.dart';
import '../theme.dart';

/// 任务板：一个房间里"要做什么 / 在做 / 做完"的清单。
///
/// 只负责展示与交互回调，数据与请求在 AppState 里（这样能单测）。
class TaskBoardSheet extends StatefulWidget {
  const TaskBoardSheet({
    super.key,
    required this.roomName,
    required this.tasks,
    required this.onToggleDone,
    required this.onTogglePin,
    required this.onDelete,
    required this.onCreate,
  });

  final String roomName;
  final List<TaskItem> tasks;
  final ValueChanged<TaskItem> onToggleDone;
  final ValueChanged<TaskItem> onTogglePin;
  final ValueChanged<TaskItem> onDelete;
  final ValueChanged<String> onCreate;

  @override
  State<TaskBoardSheet> createState() => _TaskBoardSheetState();
}

class _TaskBoardSheetState extends State<TaskBoardSheet> {
  final _input = TextEditingController();
  bool _showDone = false;

  @override
  void dispose() {
    _input.dispose();
    super.dispose();
  }

  void _add() {
    final title = _input.text.trim();
    if (title.isEmpty) return;
    widget.onCreate(title);
    _input.clear();
    setState(() {});
  }

  @override
  Widget build(BuildContext context) {
    final doing = widget.tasks.where((t) => t.isDoing).toList();
    final open = widget.tasks.where((t) => !t.isDone && !t.isDoing).toList();
    final done = widget.tasks.where((t) => t.isDone).toList();

    return SafeArea(
      child: Padding(
        padding: const EdgeInsets.fromLTRB(20, 14, 20, 18),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                const Icon(
                  LucideIcons.listChecks,
                  size: 16,
                  color: PB.textSecondary,
                ),
                const SizedBox(width: 8),
                Text(
                  '任务 · ${widget.roomName}',
                  style: const TextStyle(
                    fontSize: PB.fsLg,
                    fontWeight: FontWeight.w600,
                    color: PB.textPrimary,
                  ),
                ),
                const Spacer(),
                Text(
                  '${doing.length + open.length} 个未完成',
                  style: const TextStyle(
                    fontSize: PB.fsXs,
                    color: PB.textQuaternary,
                  ),
                ),
              ],
            ),
            const SizedBox(height: 12),
            // 新任务输入
            Row(
              children: [
                Expanded(
                  child: TextField(
                    controller: _input,
                    style: const TextStyle(fontSize: PB.fsSm),
                    onSubmitted: (_) => _add(),
                    decoration: InputDecoration(
                      hintText: '加一条任务（回车添加）',
                      hintStyle: const TextStyle(
                        fontSize: PB.fsXs,
                        color: PB.textQuaternary,
                      ),
                      isDense: true,
                      filled: true,
                      fillColor: PB.bgApp,
                      contentPadding: const EdgeInsets.symmetric(
                        horizontal: 12,
                        vertical: 10,
                      ),
                      border: OutlineInputBorder(
                        borderRadius: BorderRadius.circular(PB.rLg),
                        borderSide: BorderSide(color: PB.borderTertiary),
                      ),
                    ),
                  ),
                ),
                const SizedBox(width: 8),
                IconButton(
                  onPressed: _add,
                  icon: const Icon(LucideIcons.plus, size: 18),
                  tooltip: '添加',
                ),
              ],
            ),
            const SizedBox(height: 10),
            Flexible(
              child: SingleChildScrollView(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    if (doing.isEmpty && open.isEmpty && done.isEmpty)
                      const Padding(
                        padding: EdgeInsets.symmetric(vertical: 18),
                        child: Text(
                          '还没有任务。部门里派的活会自动出现在这里。',
                          style: TextStyle(
                            fontSize: PB.fsXs,
                            color: PB.textQuaternary,
                          ),
                        ),
                      ),
                    if (doing.isNotEmpty) ...[
                      _section('进行中'),
                      for (final t in doing) _row(t),
                      const SizedBox(height: 8),
                    ],
                    if (open.isNotEmpty) ...[
                      _section('待办'),
                      for (final t in open) _row(t),
                      const SizedBox(height: 8),
                    ],
                    if (done.isNotEmpty) ...[
                      InkWell(
                        onTap: () => setState(() => _showDone = !_showDone),
                        child: Padding(
                          padding: const EdgeInsets.symmetric(vertical: 6),
                          child: Row(
                            mainAxisSize: MainAxisSize.min,
                            children: [
                              Icon(
                                _showDone
                                    ? LucideIcons.chevronUp
                                    : LucideIcons.chevronDown,
                                size: 13,
                                color: PB.textQuaternary,
                              ),
                              const SizedBox(width: 6),
                              Text(
                                '已完成 ${done.length}',
                                style: const TextStyle(
                                  fontSize: PB.fsXs,
                                  color: PB.textTertiary,
                                ),
                              ),
                            ],
                          ),
                        ),
                      ),
                      if (_showDone)
                        for (final t in done) _row(t),
                    ],
                  ],
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _section(String title) => Padding(
    padding: const EdgeInsets.only(top: 4, bottom: 4),
    child: Text(
      title,
      style: const TextStyle(
        fontSize: PB.fsXxs,
        fontWeight: FontWeight.w600,
        letterSpacing: 0.4,
        color: PB.textTertiary,
      ),
    ),
  );

  Widget _row(TaskItem task) {
    final color = task.isDone
        ? PB.textQuaternary
        : task.isDoing
        ? PB.accent
        : PB.textSecondary;
    return Padding(
      padding: const EdgeInsets.only(bottom: 4),
      child: Row(
        children: [
          IconButton(
            visualDensity: VisualDensity.compact,
            padding: EdgeInsets.zero,
            constraints: const BoxConstraints(minWidth: 30, minHeight: 30),
            onPressed: () => widget.onToggleDone(task),
            tooltip: task.isDone ? '标为未完成' : '标为完成',
            icon: Icon(
              task.isDone
                  ? LucideIcons.circleCheck
                  : task.isDoing
                  ? LucideIcons.loader
                  : LucideIcons.circle,
              size: 16,
              color: color,
            ),
          ),
          if (task.isUnread && !task.isDone)
            Container(
              width: 5,
              height: 5,
              margin: const EdgeInsets.only(right: 6),
              decoration: const BoxDecoration(
                color: PB.accent,
                shape: BoxShape.circle,
              ),
            ),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  task.title,
                  maxLines: 2,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(
                    fontSize: PB.fsSm,
                    color: color,
                    decoration: task.isDone ? TextDecoration.lineThrough : null,
                  ),
                ),
                if (task.ownerName != null)
                  Text(
                    task.ownerName!,
                    style: const TextStyle(
                      fontSize: PB.fsXxs,
                      color: PB.textQuaternary,
                    ),
                  ),
              ],
            ),
          ),
          IconButton(
            visualDensity: VisualDensity.compact,
            padding: EdgeInsets.zero,
            constraints: const BoxConstraints(minWidth: 30, minHeight: 30),
            onPressed: () => widget.onTogglePin(task),
            tooltip: task.isPinned ? '取消置顶' : '置顶',
            icon: Icon(
              task.isPinned ? LucideIcons.pin : LucideIcons.pinOff,
              size: 14,
              color: task.isPinned ? PB.accent : PB.textQuaternary,
            ),
          ),
          IconButton(
            visualDensity: VisualDensity.compact,
            padding: EdgeInsets.zero,
            constraints: const BoxConstraints(minWidth: 30, minHeight: 30),
            onPressed: () => widget.onDelete(task),
            tooltip: '删除',
            icon: const Icon(
              LucideIcons.trash2,
              size: 14,
              color: PB.textQuaternary,
            ),
          ),
        ],
      ),
    );
  }
}

/// 打开某个房间的任务板（装配放在这里，聊天页只留一行调用）。
Future<void> showTaskBoard(
  BuildContext context,
  AppState state,
  Room room,
) async {
  await state.refreshTasks();
  if (!context.mounted) return;
  await showModalBottomSheet<void>(
    context: context,
    backgroundColor: PB.bgPane,
    isScrollControlled: true,
    constraints: const BoxConstraints(maxWidth: 560),
    builder: (_) => ListenableBuilder(
      listenable: state,
      builder: (context, child) => TaskBoardSheet(
        roomName: room.name,
        tasks: state.tasksFor(room.id),
        onToggleDone: (t) => state.updateTask(t.id, {
          'status': t.isDone ? 'open' : 'done',
          'read': true,
        }),
        onTogglePin: (t) => state.updateTask(t.id, {'pinned': !t.isPinned}),
        onDelete: (t) => state.deleteTask(t.id),
        onCreate: (title) => state.createTask(roomId: room.id, title: title),
      ),
    ),
  );
}
