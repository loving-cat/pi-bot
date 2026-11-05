import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../app_state.dart';
import '../l10n/l10n.dart';
import '../models.dart';
import '../ime_guard.dart';
import '../theme.dart';
import 'floating_menu.dart';

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
    final strings = L10n.s(context);
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
                  strings.tf('task.title', {'room': widget.roomName}),
                  style: const TextStyle(
                    fontSize: PB.fsLg,
                    fontWeight: FontWeight.w600,
                    color: PB.textPrimary,
                  ),
                ),
                const Spacer(),
                Text(
                  strings.tf('task.openCount', {
                    'n': doing.length + open.length,
                  }),
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
                    onSubmitted: submitUnlessComposing(_input, _add),
                    decoration: InputDecoration(
                      hintText: strings.t('task.newHint'),
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
                  tooltip: strings.t('common.add'),
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
                      Padding(
                        padding: const EdgeInsets.symmetric(vertical: 18),
                        child: Text(
                          strings.t('task.empty'),
                          style: const TextStyle(
                            fontSize: PB.fsXs,
                            color: PB.textQuaternary,
                          ),
                        ),
                      ),
                    if (doing.isNotEmpty) ...[
                      _section(strings.t('task.doing')),
                      ..._grouped(doing),
                      const SizedBox(height: 8),
                    ],
                    if (open.isNotEmpty) ...[
                      _section(strings.t('task.todo')),
                      ..._grouped(open),
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
                                strings.tf('task.doneCount', {
                                  'n': done.length,
                                }),
                                style: const TextStyle(
                                  fontSize: PB.fsXs,
                                  color: PB.textTertiary,
                                ),
                              ),
                            ],
                          ),
                        ),
                      ),
                      if (_showDone) ..._grouped(done),
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

  /// 同一条指令派给多个人时，板上会出现 N 行一模一样的话。
  /// 按标题合并成一行（副标题列出执行者），比刷 5 条重复的更像"一个任务"。
  List<Widget> _grouped(List<TaskItem> list) {
    final byTitle = <String, List<TaskItem>>{};
    for (final t in list) {
      byTitle.putIfAbsent(t.title, () => []).add(t);
    }
    return [
      for (final group in byTitle.values)
        group.length == 1 ? _row(group.first) : _multiRow(group),
    ];
  }

  /// 一个任务、多个执行者
  Widget _multiRow(List<TaskItem> group) {
    final strings = L10n.s(context);
    final first = group.first;
    final color = first.isDone
        ? PB.textQuaternary
        : first.isDoing
        ? PB.colors(context).accent
        : PB.textSecondary;
    final owners = group
        .map((t) => t.ownerName)
        .whereType<String>()
        .where((n) => n.isNotEmpty)
        .toList();

    return Padding(
      padding: const EdgeInsets.only(bottom: 4),
      child: Row(
        children: [
          IconButton(
            visualDensity: VisualDensity.compact,
            padding: EdgeInsets.zero,
            constraints: const BoxConstraints(minWidth: 30, minHeight: 30),
            onPressed: () {
              for (final t in group) {
                widget.onToggleDone(t);
              }
            },
            tooltip: strings.tf(
              first.isDone ? 'task.markOpenAll' : 'task.markDoneAll',
              {'n': group.length},
            ),
            icon: Icon(
              first.isDone
                  ? LucideIcons.circleCheck
                  : first.isDoing
                  ? LucideIcons.loader
                  : LucideIcons.circle,
              size: 16,
              color: color,
            ),
          ),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  first.title,
                  maxLines: 2,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(
                    fontSize: PB.fsSm,
                    color: color,
                    decoration: first.isDone
                        ? TextDecoration.lineThrough
                        : null,
                  ),
                ),
                Text(
                  strings.tf('task.owners', {
                    'n': group.length,
                    'names': owners.join(strings.t('misc.listSeparator')),
                  }),
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
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
            onPressed: () {
              for (final t in group) {
                widget.onDelete(t);
              }
            },
            tooltip: strings.tf('task.deleteAll', {'n': group.length}),
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

  Widget _row(TaskItem task) {
    final strings = L10n.s(context);
    final color = task.isDone
        ? PB.textQuaternary
        : task.isDoing
        ? PB.colors(context).accent
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
            tooltip: strings.t(task.isDone ? 'task.markOpen' : 'task.markDone'),
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
              decoration: BoxDecoration(
                color: PB.colors(context).accent,
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
            tooltip: strings.t(task.isPinned ? 'task.unpin' : 'task.pin'),
            icon: Icon(
              task.isPinned ? LucideIcons.pin : LucideIcons.pinOff,
              size: 14,
              color: task.isPinned
                  ? PB.colors(context).accentBright
                  : PB.textQuaternary,
            ),
          ),
          IconButton(
            visualDensity: VisualDensity.compact,
            padding: EdgeInsets.zero,
            constraints: const BoxConstraints(minWidth: 30, minHeight: 30),
            onPressed: () => widget.onDelete(task),
            tooltip: strings.t('common.delete'),
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
///
/// [anchorKey] 是触发按钮：浮层贴着它弹出，而不是从屏幕底部滑上来。
/// 底部弹层是移动端手势范式，桌面上它和按钮隔着大半个屏幕，很不自然。
/// 没传锚点时退回居中弹出（窄屏/手机仍然合适）。
Future<void> showTaskBoard(
  BuildContext context,
  AppState state,
  Room room, {
  GlobalKey? anchorKey,
}) async {
  // ★ 先在 await 之前把定位需要的东西取完。
  //
  //   refreshTasks 是异步的；回来之后再用 context 找 Overlay / 量尺寸，
  //   既可能拿到已经失效的 context，也会触发 use_build_context_synchronously。
  //   浮层的落点只取决于「按钮在哪 + 屏幕多大」，这两样现在就能拿到。
  final box = anchorKey?.currentContext?.findRenderObject() as RenderBox?;
  final boxReady = box != null && box.attached;
  final anchor = boxReady ? box.localToGlobal(Offset.zero) : null;
  // 按钮的实际高度：往下开时从它的底边算起，浮层才不会盖住按钮本身
  final anchorHeight = boxReady ? box.size.height : 0.0;
  final overlay = Overlay.maybeOf(context);
  final overlayBox = overlay?.context.findRenderObject() as RenderBox?;
  final ready =
      overlayBox != null && overlayBox.attached && overlayBox.hasSize;

  await state.refreshTasks();
  if (!context.mounted) return;

  Widget build() => ListenableBuilder(
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
  );

  if (anchorKey == null || anchor == null || overlay == null) {
    // 没有锚点：居中的浮层卡片，仍然比底部弹层合适
    await showDialog<void>(
      context: context,
      barrierColor: const Color(0x99000000),
      builder: (_) => Dialog(
        backgroundColor: PB.bgPane,
        insetPadding: const EdgeInsets.all(24),
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(PB.rXl),
          side: const BorderSide(color: PB.borderTertiary),
        ),
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 560, maxHeight: 560),
          child: build(),
        ),
      ),
    );
    return;
  }

  final local = ready ? overlayBox.globalToLocal(anchor) : anchor;
  final screen = ready ? overlayBox.size : const Size(800, 600);

  const width = 420.0;
  final spot = menuPlacement(
    anchor: local,
    screen: screen,
    entryCount: 10,
    width: width,
    gap: 8,
    anchorHeight: anchorHeight,
  );

  late OverlayEntry entry;
  void close() {
    if (entry.mounted) entry.remove();
  }

  entry = OverlayEntry(
    builder: (_) => _TaskBoardPopover(
      left: spot.left,
      top: spot.top,
      bottom: spot.bottom,
      width: width,
      onClose: close,
      child: build(),
    ),
  );
  overlay.insert(entry);
}

class _TaskBoardPopover extends StatefulWidget {
  const _TaskBoardPopover({
    required this.left,
    required this.top,
    required this.bottom,
    required this.width,
    required this.onClose,
    required this.child,
  });

  final double left;
  final double? top;
  final double? bottom;
  final double width;
  final VoidCallback onClose;
  final Widget child;

  @override
  State<_TaskBoardPopover> createState() => _TaskBoardPopoverState();
}

class _TaskBoardPopoverState extends State<_TaskBoardPopover> {
  @override
  void initState() {
    super.initState();
    HardwareKeyboard.instance.addHandler(_onKey);
  }

  @override
  void dispose() {
    HardwareKeyboard.instance.removeHandler(_onKey);
    super.dispose();
  }

  bool _onKey(KeyEvent event) {
    if (event is KeyDownEvent &&
        event.logicalKey == LogicalKeyboardKey.escape) {
      widget.onClose();
      return true;
    }
    return false;
  }

  @override
  Widget build(BuildContext context) {
    return Stack(
      children: [
        Positioned.fill(
          child: GestureDetector(
            behavior: HitTestBehavior.opaque,
            onTap: widget.onClose,
          ),
        ),
        Positioned(
          left: widget.left,
          top: widget.top,
          bottom: widget.bottom,
          width: widget.width,
          child: Material(
            color: Colors.transparent,
            child: Container(
              constraints: const BoxConstraints(maxHeight: 520),
              decoration: BoxDecoration(
                color: PB.bgPane,
                borderRadius: BorderRadius.circular(PB.rXl),
                border: Border.all(color: PB.borderTertiary),
                boxShadow: PB.shadow(y: 8, blur: 28, alpha: 0.45),
              ),
              child: ClipRRect(
                borderRadius: BorderRadius.circular(PB.rXl),
                child: SingleChildScrollView(child: widget.child),
              ),
            ),
          ),
        ),
      ],
    );
  }
}
