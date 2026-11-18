import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../app_state.dart';
import '../l10n/l10n.dart';
import '../models.dart';
import '../task_kanban_model.dart';
import '../theme.dart';
import 'floating_menu.dart';
import 'task_run_card.dart';
import 'task_run_sheet.dart';

/// 房间顶栏的「任务」浮层 —— **只读 TaskRun，不再有旧的 TaskItem 双轨。**
///
/// ## 为什么整块换掉
///
/// 原来这里是一套独立的 `TaskItem` 清单：能加行、能勾完成、能置顶，数据源是
/// `state.tasks`（`/api/tasks`）。而全局看板读的是 `TaskRun`（受管任务的真实账本）。
/// 同一件事在两个地方有两份状态，于是出现「看板显示在跑、房间清单显示没做」这类打架。
///
/// 现在统一到 `TaskRun`：
///   · 列表 = 本房间的根任务（子任务在根卡的 childrenSummary 里看）；
///   · 勾选/置顶这些「手工状态」没有对应概念 —— 受管任务是模型+账本推进的，
///     用户能做的是 pause / resume / cancel / 批准 / 回答，全部在任务详情里；
///   · 因此「加一条任务」的输入框一并撤掉：派活走对话（主控 accept_task 建单），
///     这也是 spec 里「淘汰旧 TaskItem 独立维护链路」的落地。
class TaskBoardSheet extends StatelessWidget {
  const TaskBoardSheet({super.key, required this.roomName, required this.state, required this.roomId});

  final String roomName;
  final AppState state;
  final String roomId;

  @override
  Widget build(BuildContext context) {
    final s = L10n.s(context);
    return SafeArea(
      child: Padding(
        padding: const EdgeInsets.fromLTRB(18, 14, 18, 16),
        child: ListenableBuilder(
          listenable: state.taskRuns,
          builder: (context, _) {
            final cards = buildKanbanCards(
              state.taskRuns.forRoom(roomId),
              nameOf: (id) => state.botById(id)?.name ?? '',
            );
            final open = cards.where((c) => c.column != KanbanColumn.done).length;
            return Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Row(
                  children: [
                    Icon(LucideIcons.listChecks, size: 16, color: PB.textSecondary),
                    const SizedBox(width: 8),
                    Expanded(
                      child: Text(
                        s.tf('task.title', {'room': roomName}),
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: TextStyle(
                          fontSize: PB.fsLg,
                          fontWeight: FontWeight.w600,
                          color: PB.textPrimary,
                        ),
                      ),
                    ),
                    Text(
                      s.tf('task.openCount', {'n': open}),
                      style: TextStyle(fontSize: PB.fsXs, color: PB.textQuaternary),
                    ),
                  ],
                ),
                const SizedBox(height: 10),
                if (cards.isEmpty)
                  Padding(
                    padding: const EdgeInsets.symmetric(vertical: 26),
                    child: Column(
                      children: [
                        Text(
                          s.t('task.empty'),
                          style: TextStyle(fontSize: PB.fsSm, color: PB.textSecondary),
                        ),
                        const SizedBox(height: 6),
                        Text(
                          s.t('task.emptyHint'),
                          textAlign: TextAlign.center,
                          style: TextStyle(fontSize: PB.fsXs, color: PB.textQuaternary, height: 1.6),
                        ),
                      ],
                    ),
                  )
                else
                  Flexible(
                    child: SingleChildScrollView(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.stretch,
                        children: [
                          for (final card in cards)
                            _Row(
                              card: card,
                              onOpen: () => showTaskRunSheet(context, state, card.run),
                            ),
                        ],
                      ),
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

class _Row extends StatelessWidget {
  const _Row({required this.card, required this.onOpen});

  final KanbanCard card;
  final VoidCallback onOpen;

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        // 卡片本体复用看板/详情用同一个组件，状态色与图标不会再飘
        TaskRunCard(task: card.run, compact: true, onOpen: onOpen),
        Padding(
          padding: const EdgeInsets.only(left: 6, right: 6, bottom: 6),
          child: Row(
            children: [
              Icon(LucideIcons.userRound, size: 11, color: PB.textQuaternary),
              const SizedBox(width: 4),
              Expanded(
                child: Text(
                  card.leadName.isEmpty
                      ? L10n.s(context).t('kanban.unassigned')
                      : card.leadName,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(fontSize: PB.fsXxs, color: PB.textQuaternary),
                ),
              ),
              if (card.cancelled)
                Text(
                  L10n.s(context).t('kanban.cancelled'),
                  style: TextStyle(fontSize: PB.fsXxs, color: PB.textTertiary),
                ),
            ],
          ),
        ),
      ],
    );
  }
}

/// 打开房间任务浮层（锚定在顶栏那颗按钮上）。
Future<void> showTaskBoard(
  BuildContext context,
  AppState state,
  Room room, {
  GlobalKey? anchorKey,
  void Function(VoidCallback close)? onHandle,
  VoidCallback? onClosed,
}) async {
  // 会话标识与名字在 await 之前先取出来（避免 await 后用已失效的 context）。
  final roomId = room.id;
  final roomName = room.name;
  final box = anchorKey?.currentContext?.findRenderObject() as RenderBox?;
  final boxReady = box != null && box.attached;
  final anchor = boxReady ? box.localToGlobal(Offset.zero) : null;
  final anchorHeight = boxReady ? box.size.height : 0.0;
  final overlay = Overlay.maybeOf(context);
  final overlayBox = overlay?.context.findRenderObject() as RenderBox?;
  final ready = overlayBox != null && overlayBox.attached && overlayBox.hasSize;

  Widget build() => TaskBoardSheet(roomName: roomName, state: state, roomId: roomId);

  if (anchorKey == null || anchor == null || overlay == null) {
    onHandle?.call(() => Navigator.of(context, rootNavigator: true).pop());
    await showDialog<void>(
      context: context,
      barrierColor: const Color(0x99000000),
      builder: (_) => Dialog(
        backgroundColor: PB.bgPane,
        insetPadding: const EdgeInsets.all(24),
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(PB.rXl),
          side: BorderSide(color: PB.borderTertiary),
        ),
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 520, maxHeight: 560),
          child: build(),
        ),
      ),
    );
    onClosed?.call();
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
  var closed = false;
  void close() {
    if (closed) return;
    closed = true;
    if (entry.mounted) entry.remove();
    onClosed?.call();
  }

  entry = OverlayEntry(
    builder: (_) => _RoomTaskPopover(
      left: spot.left,
      top: spot.top,
      bottom: spot.bottom,
      width: width,
      onClose: close,
      anchorRect: anchorHeight > 0
          ? Rect.fromLTWH(anchor.dx, anchor.dy, box?.size.width ?? 0, anchorHeight)
          : null,
      child: build(),
    ),
  );
  overlay.insert(entry);
  onHandle?.call(close);
}

class _RoomTaskPopover extends StatefulWidget {
  const _RoomTaskPopover({
    required this.left,
    required this.top,
    required this.bottom,
    required this.width,
    required this.onClose,
    required this.child,
    this.anchorRect,
  });

  final double left;
  final double? top;
  final double? bottom;
  final double width;
  final VoidCallback onClose;
  final Widget child;

  /// 锚点（顶栏那颗按钮）的屏幕矩形：点它也算"再点一下"。
  final Rect? anchorRect;

  @override
  State<_RoomTaskPopover> createState() => _RoomTaskPopoverState();
}

class _RoomTaskPopoverState extends State<_RoomTaskPopover> {
  /// 量浮层自己的真实矩形。不能用 left/top/bottom 推演：向下弹出时 bottom 为空，
  /// 那套判定会把浮层正下方一直到窗口底都当成"里面"，点那儿关不掉。
  final GlobalKey _sheetKey = GlobalKey();

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
    if (event is KeyDownEvent && event.logicalKey == LogicalKeyboardKey.escape) {
      widget.onClose();
      return true;
    }
    return false;
  }

  @override
  Widget build(BuildContext context) {
    return Stack(
      children: [
        Listener(
          behavior: HitTestBehavior.translucent,
          onPointerDown: (event) {
            final sheetBox = _sheetKey.currentContext?.findRenderObject() as RenderBox?;
            if (sheetBox != null && sheetBox.attached && sheetBox.hasSize) {
              final rect = sheetBox.localToGlobal(Offset.zero) & sheetBox.size;
              final inSheet = rect.contains(event.position);
              final onAnchor = widget.anchorRect?.contains(event.position) ?? false;
              if (!inSheet || onAnchor) widget.onClose();
            }
          },
          child: const SizedBox.expand(),
        ),
        Positioned(
          left: widget.left,
          top: widget.top,
          bottom: widget.bottom,
          width: widget.width,
          child: Material(
            key: _sheetKey,
            color: Colors.transparent,
            child: Container(
              constraints: const BoxConstraints(maxHeight: 520),
              decoration: BoxDecoration(
                color: PB.bgPane,
                borderRadius: BorderRadius.circular(PB.rXl),
                border: Border.all(color: PB.borderTertiary),
                boxShadow: PB.shadow(y: 12, blur: 32, alpha: 0.45),
              ),
              child: widget.child,
            ),
          ),
        ),
      ],
    );
  }
}
