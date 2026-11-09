/// TaskRun 详情页：状态、预算、缺项与任务级控制。
library;

import 'package:flutter/material.dart';

import '../app_state.dart';
import '../task_run_models.dart';
import '../theme.dart';
import 'task_run_card.dart';

/// 任务详情改成**屏幕中央的悬浮面板**。
///
/// 原来用 showModalBottomSheet：它是移动端手势范式，在桌面/宽屏上会从屏幕
/// 最底下窜上来，离点的那张任务卡隔着半个屏幕；展开后的二级内容还会被
/// 底部安全区截断。这里改成居中的对话框卡片 —— 固定最大宽度、可滚动、
/// 点空白或 Esc 关闭，和桌面其他浮层保持一致。
Future<void> showTaskRunSheet(BuildContext context, AppState state, TaskRun task) {
  return showDialog<void>(
    context: context,
    barrierColor: Colors.black.withValues(alpha: 0.42),
    builder: (context) => TaskRunSheet(state: state, taskRunId: task.id),
  );
}

class TaskRunSheet extends StatelessWidget {
  const TaskRunSheet({super.key, required this.state, required this.taskRunId});

  final AppState state;
  final String taskRunId;

  Future<void> _run(BuildContext context, Future<TaskRun?> Function(TaskRun) action, TaskRun task) async {
    try {
      await action(task);
    } catch (err) {
      if (context.mounted) {
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('$err')));
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    return Dialog(
      backgroundColor: PB.bgPane,
      insetPadding: const EdgeInsets.symmetric(horizontal: 40, vertical: 40),
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(14)),
      child: ConstrainedBox(
        constraints: const BoxConstraints(maxWidth: 620, maxHeight: 680),
        child: ListenableBuilder(
          listenable: state.taskRuns,
          builder: (context, _) {
            final task = state.taskRuns.merge.byId(taskRunId);
            if (task == null) {
              return const SizedBox(
                height: 160,
                child: Center(child: Text('任务不存在')),
              );
            }
            return Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                // 标题条：拖动感不需要，只给标题和关闭键
                Padding(
                  padding: const EdgeInsets.fromLTRB(18, 14, 10, 6),
                  child: Row(
                    children: [
                      Expanded(
                        child: Text(
                          task.title.isEmpty ? '任务' : task.title,
                          maxLines: 2,
                          overflow: TextOverflow.ellipsis,
                          style: const TextStyle(fontSize: 16, fontWeight: FontWeight.w600),
                        ),
                      ),
                      IconButton(
                        icon: const Icon(Icons.close, size: 18),
                        tooltip: '关闭',
                        onPressed: () => Navigator.of(context).pop(),
                        visualDensity: VisualDensity.compact,
                      ),
                    ],
                  ),
                ),
                Flexible(
                  child: SingleChildScrollView(
                    padding: const EdgeInsets.fromLTRB(18, 0, 18, 16),
                    child: _TaskRunSheetBody(state: state, task: task, onRun: _run),
                  ),
                ),
              ],
            );
          },
        ),
      ),
    );
  }
}

/// 详情主体：任务卡 + 范围/缺项/结果 + 控制按钮。
class _TaskRunSheetBody extends StatelessWidget {
  const _TaskRunSheetBody({required this.state, required this.task, required this.onRun});

  final AppState state;
  final TaskRun task;
  final Future<void> Function(BuildContext, Future<TaskRun?> Function(TaskRun), TaskRun) onRun;

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      mainAxisSize: MainAxisSize.min,
      children: [
        TaskRunCard(task: task, onOpen: null),
        // 谁在带这件事、谁在跟：用户要能一眼分辨任务归属。
        if (task.leadBotName.isNotEmpty || task.childrenSummary != null) ...[
          const SizedBox(height: 8),
          Text(
            [
              if (task.leadBotName.isNotEmpty) '负责人：${task.leadBotName}',
              if (task.childrenSummary != null)
                '成员 ${task.childrenSummary!.done}/${task.childrenSummary!.total} 已交',
            ].join(' · '),
            style: TextStyle(fontSize: 12, color: PB.textSecondary),
          ),
          if (task.childrenSummary != null)
            for (final p in task.childrenSummary!.participants)
              Text(
                '· ${p.name}　${p.done ? '已交' : _childStateText(p.state)}',
                style: TextStyle(
                  fontSize: 12,
                  color: p.done ? PB.success : PB.textTertiary,
                ),
              ),
          // ★ 必须判空：外层是 "leadBotName 非空 || childrenSummary 非空"，
          //   所以走到这里时 childrenSummary 完全可能是 null。
          //   原来直接 .! 解包，取消任务把子任务清空后这一行就抛异常，
          //   整块渲染变成灰色错误占位。
          if (task.childrenSummary?.truncatedHint.isNotEmpty ?? false)
            Text(
              "· ${task.childrenSummary!.truncatedHint}",
              style: TextStyle(fontSize: 12, color: PB.textTertiary),
            ),
        ],
        if (task.scope.isNotEmpty) ...[
          const SizedBox(height: 8),
          Text('范围：${task.scope}', style: TextStyle(fontSize: 12, color: PB.textSecondary)),
        ],
        // ★ 分工计划：让用户看得出模型有没有先列计划、列了什么、谁负责哪步。
        //   以前计划只存在服务端记录里，界面上完全没有 —— 等于不可验证。
        if (task.plan != null && !task.plan!.isEmpty) ...[
          const SizedBox(height: 12),
          Row(
            children: [
              const Text('分工计划',
                  style: TextStyle(fontSize: 14, fontWeight: FontWeight.w600)),
              const SizedBox(width: 6),
              Text('共 ${task.plan!.count} 步',
                  style: TextStyle(fontSize: 12, color: PB.textTertiary)),
            ],
          ),
          const SizedBox(height: 4),
          for (final step in task.plan!.steps)
            Padding(
              padding: const EdgeInsets.only(bottom: 2),
              child: Text(
                '${step.owner.isEmpty ? '' : '${step.owner}：'}${step.title}',
                style: TextStyle(fontSize: 13, color: PB.textSecondary),
              ),
            ),
        ],
        if (task.unmet.isNotEmpty) ...[
          const SizedBox(height: 8),
          const Text('缺项：', style: TextStyle(fontSize: 14, fontWeight: FontWeight.w600)),
          for (final item in task.unmet) Text('· $item', style: const TextStyle(fontSize: 14)),
        ],
        if (task.result.prepared) ...[
          const SizedBox(height: 8),
          const Text('结果（服务端已准备）', style: TextStyle(fontSize: 14, fontWeight: FontWeight.w600)),
          Text(task.result.summary, style: const TextStyle(fontSize: 14)),
        ],
        const SizedBox(height: 14),
        Wrap(
          spacing: 8,
          runSpacing: 8,
          children: [
            if (task.needsUser && task.waiting?.kind == 'input')
              FilledButton(
                onPressed: () => _openInput(context, task),
                child: const Text('补充信息'),
              ),
            if (task.needsUser && task.waiting?.kind == 'approval')
              FilledButton(
                onPressed: () => onRun(context, (t) => state.taskRuns.control(t, type: 'approval', ref: t.waiting?.ref, decision: 'approved'), task),
                child: const Text('批准'),
              ),
            if (task.needsUser && task.waiting?.kind == 'approval')
              OutlinedButton(
                onPressed: () => onRun(context, (t) => state.taskRuns.control(t, type: 'approval', ref: t.waiting?.ref, decision: 'rejected'), task),
                child: const Text('拒绝'),
              ),
            if (task.canPause)
              OutlinedButton(
                onPressed: () => onRun(context, (t) => state.taskRuns.control(t, type: 'pause'), task),
                child: const Text('暂停'),
              ),
            if (task.canResume)
              FilledButton(
                onPressed: () => onRun(context, (t) => state.taskRuns.control(t, type: 'resume'), task),
                child: const Text('继续'),
              ),
            // 受阻不是终态：外部原因消失或已确认可继续时，允许直接放行。
            // 只清阻塞事实，不改目标、不绕过验收。
            if (task.state == 'blocked')
              FilledButton(
                onPressed: () => onRun(context, (t) => state.taskRuns.control(t, type: 'unblock', reason: '用户在任务详情里解除阻塞'), task),
                child: const Text('解除阻塞'),
              ),
            // 只有用户显式设了上限、且真用完了，才提供追加。默认不限额时不会有这个按钮。
            if (task.phase == 'needs_user' &&
                (task.state == 'paused_budget' ||
                    (task.budget.maxRuns != null &&
                        (task.budget.remaining ?? 0) <= 0)))
              FilledButton(
                onPressed: () => _openExtend(context, task),
                child: const Text('追加额度'),
              ),
            // 受阻常见原因提示：让用户知道下一步能做什么，而不是只看到一个红点。
            if (task.state == 'blocked')
              Text(
                '常见原因：负责人这一轮没有建子任务、没有登记交付。可以解除阻塞让它重试，'
                '或在群里直接说明要谁做什么。',
                style: TextStyle(fontSize: 12, color: PB.textTertiary),
              ),
            if (task.isActive)
              TextButton(
                onPressed: () => onRun(context, (t) => state.taskRuns.control(t, type: 'cancel', reason: '用户取消'), task),
                child: const Text('取消任务'),
              ),
          ],
        ),
      ],
    );
  }

  /// 追加额度：用户输入要加多少次，走同一条幂等命令通道。
  Future<void> _openExtend(BuildContext context, TaskRun task) async {
    final controller = TextEditingController(text: '5');
    final value = await showDialog<int>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('追加额度'),
        content: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              '当前已执行 ${task.budget.usedRuns ?? 0} 次，上限 ${task.budget.maxRuns ?? '不限'}。',
              style: TextStyle(fontSize: 12, color: PB.textTertiary),
            ),
            const SizedBox(height: 12),
            TextField(
              controller: controller,
              autofocus: true,
              keyboardType: TextInputType.number,
              decoration: const InputDecoration(labelText: '增加多少次执行'),
            ),
          ],
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(context), child: const Text('取消')),
          FilledButton(
            onPressed: () => Navigator.pop(context, int.tryParse(controller.text.trim())),
            child: const Text('追加'),
          ),
        ],
      ),
    );
    if (value == null || value <= 0) return;
    if (!context.mounted) return;
    await onRun(
      context,
      (t) => state.taskRuns.control(t, type: 'extend', extraRuns: value, reason: '用户追加额度'),
      task,
    );
  }

  static String _childStateText(String state) {
    switch (state) {
      case 'running':
        return '在做';
      case 'queued':
        return '排队';
      case 'verifying':
        return '验收中';
      case 'blocked':
        return '受阻';
      case 'paused_budget':
        return '额度用尽';
      default:
        return state;
    }
  }

  Future<void> _openInput(BuildContext context, TaskRun task) async {
    final controller = TextEditingController();
    final text = await showDialog<String>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('补充信息'),
        content: TextField(controller: controller, autofocus: true, maxLines: 3),
        actions: [
          TextButton(onPressed: () => Navigator.pop(context), child: const Text('取消')),
          FilledButton(onPressed: () => Navigator.pop(context, controller.text.trim()), child: const Text('提交')),
        ],
      ),
    );
    if (text == null || text.isEmpty) return;
    if (!context.mounted) return;
    await onRun(context, (t) => state.taskRuns.control(t, type: 'input', ref: t.waiting?.ref, text: text), task);
  }
}

Future<void> showTaskRunHistorySheet(BuildContext context, AppState state, String roomId) {
  // 历史记录也走同一个居中悬浮面板，避免桌面端从屏幕底部窜上来。
  return showDialog<void>(
    context: context,
    barrierColor: Colors.black.withValues(alpha: 0.42),
    builder: (context) => Dialog(
      backgroundColor: PB.bgPane,
      insetPadding: const EdgeInsets.symmetric(horizontal: 40, vertical: 40),
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(14)),
      child: ConstrainedBox(
        constraints: const BoxConstraints(maxWidth: 560, maxHeight: 620),
        child: ListenableBuilder(
          listenable: state.taskRuns,
          builder: (context, _) {
        final tasks = state.taskRuns.tasks.where((t) => t.roomId == roomId).toList();
        return SafeArea(
          child: ListView(
            shrinkWrap: true,
            padding: const EdgeInsets.fromLTRB(16, 0, 16, 20),
            children: [
              Row(
                children: [
                  const Text('任务记录', style: TextStyle(fontSize: 17, fontWeight: FontWeight.w600)),
                  const Spacer(),
                  TextButton(
                    onPressed: () => state.taskRuns.refreshHistory(),
                    child: const Text('刷新'),
                  ),
                ],
              ),
              if (tasks.isEmpty) const Padding(padding: EdgeInsets.all(12), child: Text('还没有任务记录')),
              for (final task in tasks)
                TaskRunCard(
                  key: ValueKey('history_${task.id}'),
                  task: task,
                  onOpen: () => showTaskRunSheet(context, state, task),
                ),
            ],
          ),
        );
          },
        ),
      ),
    ),
  );
}
/// 右栏内嵌的任务详情。
///
/// ★ 与弹出式 TaskRunSheet 的区别：它不占模态屏障，
///   用户看详情时主对话仍然能正常上下滚动。
class TaskRunDetailInline extends StatelessWidget {
  const TaskRunDetailInline({super.key, required this.state, required this.taskRunId});

  final AppState state;
  final String taskRunId;

  Future<void> _run(
    BuildContext context,
    Future<TaskRun?> Function(TaskRun) action,
    TaskRun task,
  ) async {
    try {
      await action(task);
    } catch (err) {
      if (context.mounted) {
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('$err')));
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    return ListenableBuilder(
      listenable: state.taskRuns,
      builder: (context, _) {
        final task = state.taskRuns.merge.byId(taskRunId);
        if (task == null) {
          return Center(
            child: Text('任务不存在', style: TextStyle(fontSize: PB.fsXs, color: PB.textTertiary)),
          );
        }
        return SingleChildScrollView(
          padding: const EdgeInsets.fromLTRB(14, 10, 14, 16),
          child: _TaskRunSheetBody(state: state, task: task, onRun: _run),
        );
      },
    );
  }
}