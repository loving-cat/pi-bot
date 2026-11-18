import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../app_state.dart';
import '../l10n/l10n.dart';
import '../model_display.dart';
import '../models.dart';
import '../platform.dart';
import '../scope.dart';
import '../text_utils.dart';
import '../theme.dart';
import '../window_chrome.dart';
import '../widgets/bot_delete_confirm.dart';
import '../widgets/room_pending_banner.dart';
import '../task_kanban_model.dart';
import '../widgets/task_kanban.dart';
import '../widgets/toast.dart';
import '../widgets/avatar_life.dart';
import '../widgets/anchored_menu.dart';
import '../widgets/create_group_dialog.dart';
import 'pair_screen.dart';
import '../widgets/theme_toggle_button.dart';
import '../widgets/blob_avatar.dart';
import '../widgets/floating_menu.dart';
import '../widgets/skeleton.dart';
import 'bots_screen.dart';
import 'chat_screen.dart';
import 'settings_screen.dart';

import 'package:lucide_icons_flutter/lucide_icons.dart';

class RoomsScreen extends StatefulWidget {
  const RoomsScreen({
    super.key,
    this.embedded = false,
    this.selectedId,
    this.onSelect,
    this.initialRoomId,
  });

  final String? initialRoomId;

  /// 宽屏分栏里当左栏用：点会话不跳页，交给 onSelect
  final bool embedded;
  final String? selectedId;
  final void Function(Room room)? onSelect;

  @override
  State<RoomsScreen> createState() => _RoomsScreenState();
}

enum _RoomFilter { all, groups, bots, pending }

class _RoomsScreenState extends State<RoomsScreen> {
  /// 「新建」按钮的锚点：浮层要贴着它弹出。
  final _createAnchor = GlobalKey();

  bool _searching = false;
  final _searchController = TextEditingController();
  String _query = '';
  _RoomFilter _filter = _RoomFilter.all;

  @override
  void dispose() {
    _searchController.dispose();
    super.dispose();
  }

  void _openRoom(Room room) {
    final state = AppScope.read(context);
    if (room.unread && state.api != null) {
      unawaited(state.updateRoom(room.id, {'unread': false}));
    }
    if (widget.onSelect != null) {
      widget.onSelect!(room);
    } else {
      Navigator.push(
        context,
        MaterialPageRoute(builder: (_) => ChatScreen(room: room)),
      );
    }
  }

  bool _matchesQuery(Room r, AppState state, String q) {
    if (q.isEmpty) return true;
    final needle = q.toLowerCase();
    if (r.name.toLowerCase().contains(needle)) return true;
    if (r.topic.toLowerCase().contains(needle)) return true;
    if ((r.lastMessage?.text ?? '').toLowerCase().contains(needle)) return true;
    for (final id in r.botIds) {
      final b = state.botById(id);
      if (b == null) continue;
      if (b.name.toLowerCase().contains(needle) ||
          b.tagline.toLowerCase().contains(needle)) {
        return true;
      }
    }
    return false;
  }

  /// 被隐藏的会话：底部一行入口 + 一个能取消隐藏的弹层
  Future<void> _showHidden(BuildContext context, List<Room> hidden) async {
    final state = AppScope.read(context);
    final s = L10n.s(context);
    await showModalBottomSheet<void>(
      context: context,
      backgroundColor: PB.bgElevated,
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(PB.r3xl)),
      ),
      builder: (ctx) => SafeArea(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            const SizedBox(height: 12),
            Text(
              s.t('rooms.hiddenTitle'),
              style: TextStyle(
                fontSize: PB.fsSm,
                color: PB.textSecondary,
              ),
            ),
            const SizedBox(height: 6),
            for (final room in hidden)
              ListTile(
                leading: const Icon(LucideIcons.eye, size: 20),
                title: Text(
                  room.name,
                  style: const TextStyle(fontSize: PB.fsSm),
                ),
                trailing: Text(
                  s.t('rooms.unhide'),
                  style: TextStyle(
                    fontSize: PB.fsXs,
                    color: PB.colors(context).link,
                  ),
                ),
                onTap: () {
                  Navigator.pop(ctx);
                  state.updateRoom(room.id, {'hidden': false});
                },
              ),
            const SizedBox(height: 8),
          ],
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final s = L10n.s(context);
    final state = AppScope.of(context);

    return Scaffold(
      backgroundColor: PB.bgApp,
      appBar: chromeAppBar(
        context,
        AppBar(
          flexibleSpace: const WindowDragArea(),
          toolbarHeight: 62,
          titleSpacing: 18,
          title: _searching
              ? TextField(
                  controller: _searchController,
                  autofocus: true,
                  style: const TextStyle(fontSize: PB.fsBase),
                  decoration: InputDecoration(
                    hintText: s.t('rooms.searchHint'),
                    border: InputBorder.none,
                    enabledBorder: InputBorder.none,
                    focusedBorder: InputBorder.none,
                    filled: false,
                    contentPadding: EdgeInsets.zero,
                  ),
                  onChanged: (v) => setState(() => _query = v),
                )
              : Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  mainAxisAlignment: MainAxisAlignment.center,
                  children: [
                    // ★ 显示**用户自己**的名字，不是主机名。
                    //   主机名对用户没意义，而 bot 们要称呼的正是这个名字。
                    //   主机名在「设置 → 服务端」里查看。
                    Row(
                      children: [
                        Flexible(
                          child: Text(
                            state.userName.isNotEmpty
                                ? state.userName
                                : (state.serverUrl ?? 'Orbis'),
                            style: const TextStyle(
                              fontSize: PB.fsLg,
                              fontWeight: FontWeight.w500,
                            ),
                            overflow: TextOverflow.ellipsis,
                          ),
                        ),
                        const SizedBox(width: 8),
                        // 明暗切换：放在用户名旁边，一进来就能看到
                        const ThemeToggleButton(),
                      ],
                    ),
                    const SizedBox(height: 3),
                    Row(
                      children: [
                        Container(
                          width: 6,
                          height: 6,
                          decoration: BoxDecoration(
                            color: switch (state.link) {
                              LinkState.online => PB.success,
                              LinkState.connecting => PB.warn,
                              LinkState.offline => PB.danger,
                            },
                            shape: BoxShape.circle,
                          ),
                        ),
                        const SizedBox(width: 6),
                        Expanded(
                          child: Text(
                            state.link == LinkState.online
                                ? s.tf('rooms.botsModel', {
                                    'n': state.bots.length,
                                    'model': () {
                                      final info = compactModelDisplay(
                                        state.serverInfo?.model,
                                        state.modelGroups,
                                      );
                                      return info.isEmpty
                                          ? ''
                                          : info.combined;
                                    }(),
                                  })
                                : (state.link == LinkState.connecting
                                      ? s.t('rooms.connecting')
                                      : s.t('rooms.offline')),
                            style: TextStyle(
                              fontSize: PB.fsXs,
                              color: PB.textQuaternary,
                            ),
                            overflow: TextOverflow.ellipsis,
                          ),
                        ),
                      ],
                    ),
                  ],
                ),
          actions: [
            // 窗口控制角的局部预留由 chromeAppBar 统一处理。
            _CircleIcon(
              icon: _searching ? LucideIcons.x : LucideIcons.search,
              onTap: () => setState(() {
                if (_searching) {
                  _searching = false;
                  _query = '';
                  _searchController.clear();
                } else {
                  _searching = true;
                }
              }),
            ),
            const SizedBox(width: 10),
            // KeyedSubtree 挂锚点：_CircleIcon 没有 key 参数，
            // 而浮层需要它的位置，包一层就能拿到 RenderBox。
            KeyedSubtree(
              key: _createAnchor,
              child: _CircleIcon(
                icon: LucideIcons.plus,
                filled: true,
                onTap: () => _showCreateSheet(context),
              ),
            ),
            // 手机端：直接在首页换电脑。
            //
            // 为什么放在这儿：手机一旦连上某台电脑，登录页就没了；电脑关机/换网络之后
            // 用户想换一台，原来只能进设置翻（而且那页的入口当时还坏了）。
            // 这是"我在连哪台"的最短路径 —— 一步打开附近的电脑列表。
            if (isMobilePlatform) ...[
              const SizedBox(width: 10),
              _CircleIcon(
                icon: LucideIcons.laptop,
                onTap: () => Navigator.push(
                  context,
                  MaterialPageRoute(builder: (_) => const PairScreen()),
                ),
              ),
            ],
            const SizedBox(width: 10),
            _CircleIcon(
              icon: LucideIcons.settings,
              onTap: () => Navigator.push(
                context,
                MaterialPageRoute(builder: (_) => const SettingsScreen()),
              ),
            ),
            const SizedBox(width: 18),
          ],
        ),
      ),
      body: ListenableBuilder(
        listenable: state.taskRuns,
        builder: (context, _) {
          final visibleAll = state.rooms.where((r) => !r.hidden).toList();
          final pendingList = collectPendingRoomActions(state);
          final pendingMap = {
            for (final item in pendingList) item.room.id: item,
          };
          final showFilters = visibleAll.isNotEmpty || _filter != _RoomFilter.all;

          final matched = state.rooms.where(
            (r) => _matchesQuery(r, state, _query),
          );
          final rooms = matched.where((r) {
            if (r.hidden) return false;
            return switch (_filter) {
              _RoomFilter.all => true,
              _RoomFilter.groups => r.isGroup,
              _RoomFilter.bots => !r.isGroup,
              _RoomFilter.pending => pendingMap.containsKey(r.id),
            };
          }).toList();
          final hidden = matched.where((r) => r.hidden).toList();

          return RefreshIndicator(
            color: PB.colors(context).accent,
            backgroundColor: PB.bgElevated,
            onRefresh: () => state.refresh(),
            child: Center(
              child: ConstrainedBox(
                constraints: const BoxConstraints(maxWidth: 680),
                child: ListView(
                  physics: const AlwaysScrollableScrollPhysics(),
                  padding: const EdgeInsets.fromLTRB(8, 2, 8, 40),
                  children: [
                    if (state.link != LinkState.online)
                      _Banner(
                        text: state.link == LinkState.connecting
                            ? s.t('rooms.serverConnecting')
                            : s.t('rooms.serverUnreachable'),
                        icon: state.link == LinkState.connecting
                            ? LucideIcons.refreshCw
                            : LucideIcons.cloudOff,
                      ),
                    _KanbanEntry(
                      onTap: () => showTaskKanban(context, state),
                      total: state.taskRuns.tasks.length,
                      needsYou:
                          buildKanbanCards(state.taskRuns.tasks, onlyNeedsYou: true).length,
                    ),
                    if (showFilters)
                      _FilterStrip(
                        selected: _filter,
                        pendingCount: pendingList.length,
                        onSelect: (next) => setState(() => _filter = next),
                      ),
                    if (rooms.isEmpty &&
                        _query.isEmpty &&
                        _filter == _RoomFilter.all &&
                        state.link != LinkState.online)
                      const RoomListSkeleton()
                    else if (rooms.isEmpty)
                      Padding(
                        padding: const EdgeInsets.only(top: 110),
                        child: Column(
                          children: [
                            Container(
                              width: 64,
                              height: 64,
                              decoration: BoxDecoration(
                                color: PB.bgBubble,
                                borderRadius: BorderRadius.circular(20),
                                border: Border.all(color: PB.borderTertiary),
                              ),
                              child: Icon(
                                LucideIcons.sparkles,
                                size: 26,
                                color: PB.textQuaternary,
                              ),
                            ),
                            const SizedBox(height: 18),
                            Text(
                              _query.isNotEmpty
                                  ? s.tf('rooms.noMatch', {'query': _query})
                                  : _filter == _RoomFilter.pending
                                  ? s.t('rooms.pendingEmpty')
                                  : (_filter != _RoomFilter.all &&
                                            visibleAll.isNotEmpty
                                        ? s.t('rooms.filterEmpty')
                                        : s.t('rooms.empty')),
                              style: TextStyle(
                                color: PB.textSecondary,
                                fontSize: PB.fsSm,
                                fontWeight: FontWeight.w500,
                              ),
                            ),
                            const SizedBox(height: 6),
                            Text(
                              _query.isEmpty && _filter == _RoomFilter.pending
                                  ? s.t('rooms.pendingEmptyHint')
                                  : s.t('rooms.emptyHint'),
                              style: TextStyle(
                                color: PB.textQuaternary,
                                fontSize: PB.fsXs,
                              ),
                            ),
                          ],
                        ),
                      ),
                    for (final room in rooms)
                      _RoomRow(
                        // 按会话 id 加 key：列表重排（新消息把会话顶上来）时
                        // 元素跟着挪，而不是整行销毁重建（会重播 hover/动画状态）
                        key: ValueKey(room.id),
                        room: room,
                        state: state,
                        pending: pendingMap[room.id],
                        selected: widget.selectedId == room.id,
                        onOpen: _openRoom,
                      ),
                    if (hidden.isNotEmpty)
                      _HiddenRow(
                        count: hidden.length,
                        onTap: () => _showHidden(context, hidden),
                      ),
                  ],
                ),
              ),
            ),
          );
        },
      ),
    );
  }

  /// 「新建」浮层：贴着加号按钮弹出，不是从屏幕底部滑上来。
  ///
  /// 原来的 showModalBottomSheet 在桌面上会从屏幕最底下窜到中间，
  /// 和点的那颗加号隔着大半个屏幕，既不好看也不符合就近反馈。
  Future<void> _showCreateSheet(BuildContext context) async {
    final s = L10n.s(context);
    final state = AppScope.read(context);
    final mainBot = state.mainBot;

    final items = <AnchoredMenuItem>[
      // ★ 这里原来有一条「让助手建一个团队」。
      //
      //   它做的只是跳到 mainbot 私聊并预填一句话 ——
      //   用户本来就随时能直接跟 mainbot 说要建什么，
      //   多一个入口只是让人以为还有其他含义（点进去发现就是聊天）。
      //   真要说清楚该建什么都得自己打字，这个快捷方式是空的。
      AnchoredMenuItem(
        icon: LucideIcons.messagesSquare,
        title: s.t('rooms.newGroup'),
        subtitle: s.t('rooms.newGroupSubtitle'),
        onTap: () => _createGroup(context),
      ),
      AnchoredMenuItem(
        icon: LucideIcons.bot,
        title: s.t('bots.title'),
        subtitle: s.tf('rooms.membersSubtitle', {'n': '${state.bots.length}'}),
        onTap: () => Navigator.push(
          context,
          MaterialPageRoute(builder: (_) => const BotsScreen()),
        ),
      ),
      if (mainBot != null)
        AnchoredMenuItem(
          icon: LucideIcons.atSign,
          title: mainBot.name,
          subtitle: mainBot.tagline.isEmpty
              ? s.t('bots.manager')
              : preview(mainBot.tagline, 34),
          sectionLabel: s.t('rooms.dmSection'),
          onTap: () async {
            final room = await state.ensureDm(mainBot.id);
            if (room != null && mounted) {
              _openRoom(room);
            }
          },
        ),
      // 其余同事只列前几个：浮层太长就失去了「就近选一个」的意义
      for (final bot in state.bots.where((b) => !b.isMain).take(4))
        AnchoredMenuItem(
          icon: LucideIcons.bot,
          title: bot.name,
          subtitle: bot.tagline.isEmpty
              ? s.t('rooms.member')
              : preview(bot.tagline, 34),
          onTap: () async {
            final room = await state.ensureDm(bot.id);
            if (room != null && mounted) {
              _openRoom(room);
            }
          },
        ),
    ];

    await showAnchoredMenu(
      context: context,
      anchorKey: _createAnchor,
      title: s.t('rooms.newTitle'),
      items: items,
    );
  }

  Future<void> _createGroup(BuildContext context) async {
    final state = AppScope.read(context);
    // mainbot 不列进候选（它是对用户的负责人，本来就在群里）
    final bots = [for (final b in state.bots) if (!b.isMain) b].toList();

    // 用 GlobalKey 拿回用户填的内容 —— 对话框自己管理生命周期，
    // 调用方只关心结果，不需要替它保存几个 controller。
    final key = GlobalKey<CreateGroupDialogState>();
    final created = await showDialog<bool>(
      context: context,
      builder: (_) => CreateGroupDialog(key: key, bots: bots),
    );
    final form = key.currentState;
    if (created != true || form == null || form.name.isEmpty || !context.mounted) {
      return;
    }
    final room = await state.createGroup(
      form.name,
      topic: form.topic,
      botIds: form.botIds,
    );
    if (room != null && mounted) {
      _openRoom(room);
    }
  }
}

/// 会话列表里的「任务看板」入口。
///
/// 为什么不做成标题栏按钮：四栏全开时左栏只有两百多像素，
/// 再塞一个 34px 圆钮就会把标题行挤破（有专门的宽度预算测试守着）。
/// 所以它占一行纵向空间 —— 顺带还能把「待处理」数量写在右边。
class _KanbanEntry extends StatelessWidget {
  const _KanbanEntry({
    required this.onTap,
    required this.total,
    required this.needsYou,
  });

  final VoidCallback onTap;
  final int total;
  final int needsYou;

  @override
  Widget build(BuildContext context) {
    final s = L10n.s(context);
    final colors = PB.colors(context);
    return Padding(
      padding: const EdgeInsets.fromLTRB(4, 4, 4, 6),
      child: Material(
        color: PB.bgElevated,
        borderRadius: BorderRadius.circular(PB.rXl),
        child: InkWell(
          borderRadius: BorderRadius.circular(PB.rXl),
          onTap: onTap,
          child: Container(
            padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 8),
            decoration: BoxDecoration(
              borderRadius: BorderRadius.circular(PB.rXl),
              border: Border.all(color: PB.borderSecondary),
            ),
            child: Row(
              children: [
                Icon(LucideIcons.layoutGrid, size: 14, color: colors.accentBright),
                const SizedBox(width: 8),
                Expanded(
                  child: Text(
                    s.t('kanban.title'),
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: TextStyle(
                      fontSize: PB.fsSm,
                      fontWeight: FontWeight.w500,
                      color: PB.textPrimary,
                    ),
                  ),
                ),
                if (needsYou > 0)
                  Container(
                    key: const ValueKey('rooms-kanban-needs-you'),
                    margin: const EdgeInsets.only(right: 6),
                    padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 1),
                    decoration: BoxDecoration(
                      color: PB.warn.withValues(alpha: 0.16),
                      borderRadius: BorderRadius.circular(PB.rFull),
                    ),
                    child: Text(
                      '$needsYou',
                      style: TextStyle(
                        fontSize: 10,
                        fontWeight: FontWeight.w700,
                        color: PB.warn,
                        height: 1.2,
                      ),
                    ),
                  ),
                Text(
                  '$total',
                  style: TextStyle(fontSize: PB.fsXs, color: PB.textQuaternary),
                ),
                const SizedBox(width: 4),
                Icon(LucideIcons.chevronRight, size: 13, color: PB.textQuaternary),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

class _FilterStrip extends StatelessWidget {
  const _FilterStrip({
    required this.selected,
    required this.pendingCount,
    required this.onSelect,
  });

  final _RoomFilter selected;
  final int pendingCount;
  final void Function(_RoomFilter) onSelect;

  Key _tabKey(_RoomFilter kind) => switch (kind) {
    _RoomFilter.all => const ValueKey('rooms-tab-all'),
    _RoomFilter.groups => const ValueKey('rooms-tab-groups'),
    _RoomFilter.bots => const ValueKey('rooms-tab-bots'),
    _RoomFilter.pending => const ValueKey('rooms-tab-pending'),
  };

  @override
  Widget build(BuildContext context) {
    final s = L10n.s(context);
    final colors = PB.colors(context);
    final items = <(_RoomFilter, String)>[
      (_RoomFilter.all, s.t('rooms.filterAll')),
      (_RoomFilter.groups, s.t('rooms.filterGroups')),
      (_RoomFilter.bots, s.t('rooms.filterBots')),
      (_RoomFilter.pending, s.t('rooms.filterPending')),
    ];
    return Padding(
      padding: const EdgeInsets.fromLTRB(4, 2, 4, 8),
      child: SingleChildScrollView(
        scrollDirection: Axis.horizontal,
        child: Row(
          children: [
            for (final (kind, label) in items)
              Padding(
                padding: const EdgeInsets.only(right: 6),
                child: Material(
                  key: _tabKey(kind),
                  color: selected == kind
                      ? colors.accentSoft
                      : Colors.transparent,
                  borderRadius: BorderRadius.circular(PB.rFull),
                  child: InkWell(
                    borderRadius: BorderRadius.circular(PB.rFull),
                    onTap: () {
                      if (isMobilePlatform) HapticFeedback.selectionClick();
                      onSelect(kind);
                    },
                    child: Container(
                      padding: const EdgeInsets.symmetric(
                        horizontal: 11,
                        vertical: 5,
                      ),
                      decoration: BoxDecoration(
                        borderRadius: BorderRadius.circular(PB.rFull),
                        border: Border.all(
                          color: selected == kind
                              ? colors.accent.withValues(alpha: 0.45)
                              : PB.borderTertiary,
                        ),
                      ),
                      child: Row(
                        mainAxisSize: MainAxisSize.min,
                        children: [
                          Text(
                            label,
                            style: TextStyle(
                              fontSize: PB.fsXxs,
                              fontWeight: selected == kind
                                  ? FontWeight.w600
                                  : FontWeight.w500,
                              color: selected == kind
                                  ? colors.link
                                  : PB.textTertiary,
                            ),
                          ),
                          if (kind == _RoomFilter.pending && pendingCount > 0)
                            Container(
                              key: const ValueKey('rooms-pending-count'),
                              margin: const EdgeInsets.only(left: 5),
                              padding: const EdgeInsets.symmetric(
                                horizontal: 5,
                                vertical: 0.5,
                              ),
                              decoration: BoxDecoration(
                                color: PB.warn.withValues(alpha: 0.16),
                                borderRadius: BorderRadius.circular(PB.rFull),
                              ),
                              child: Text(
                                '$pendingCount',
                                style: TextStyle(
                                  fontSize: 10,
                                  fontWeight: FontWeight.w700,
                                  color: PB.warn,
                                  height: 1.2,
                                ),
                              ),
                            ),
                        ],
                      ),
                    ),
                  ),
                ),
              ),
          ],
        ),
      ),
    );
  }
}

class _CircleIcon extends StatelessWidget {
  const _CircleIcon({
    required this.icon,
    required this.onTap,
    this.filled = false,
  });

  final IconData icon;
  final VoidCallback onTap;
  final bool filled;

  @override
  Widget build(BuildContext context) {
    return Material(
      color: filled ? PB.colors(context).accent : PB.bgElevated,
      shape: const CircleBorder(),
      clipBehavior: Clip.antiAlias,
      child: InkWell(
        onTap: onTap,
        child: SizedBox(
          width: 34,
          height: 34,
          child: Icon(
            icon,
            size: 18,
            color: filled ? Colors.white : PB.textSecondary,
          ),
        ),
      ),
    );
  }
}


class _Banner extends StatelessWidget {
  const _Banner({required this.text, required this.icon});

  final String text;
  final IconData icon;

  @override
  Widget build(BuildContext context) {
    return Container(
      margin: const EdgeInsets.fromLTRB(4, 8, 4, 8),
      padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 11),
      decoration: BoxDecoration(
        color: PB.bgBubble,
        borderRadius: BorderRadius.circular(PB.rXl),
        border: Border.all(color: PB.borderTertiary),
      ),
      child: Row(
        children: [
          Icon(icon, size: 15, color: PB.warn),
          const SizedBox(width: 10),
          Expanded(
            child: Text(
              text,
              style: TextStyle(fontSize: PB.fsXs, color: PB.textTertiary),
            ),
          ),
        ],
      ),
    );
  }
}

class _RoomRow extends StatefulWidget {
  const _RoomRow({
    super.key,
    required this.room,
    required this.state,
    required this.onOpen,
    this.pending,
    this.selected = false,
  });

  final Room room;
  final AppState state;
  final void Function(Room room) onOpen;
  final PendingRoomAction? pending;
  final bool selected;

  @override
  State<_RoomRow> createState() => _RoomRowState();
}

class _RoomRowState extends State<_RoomRow> {
  bool _pressed = false;

  /// 整行是否被鼠标指着（由外面包一层 MouseRegion 设置）
  bool _hovered = false;

  // 说明：_pressed 由 InkWell.onHighlightChanged 驱动 —— 它**同时**覆盖
  // "鼠标悬停"和"按下"两种状态。头像的眼睛跟随就用它当"这一行被指到了"的信号
  // （见下面 BlobAvatar 的 hovered），所以不用再包一层 MouseRegion。

  @override
  Widget build(BuildContext context) {
    final room = widget.room;
    final state = widget.state;
    final last = room.lastMessage;
    final busy = state.typing[room.id] == true;
    final bot = state.botById(
      room.botIds.isNotEmpty ? room.botIds.first : null,
    );
    final s = L10n.s(context);
    final noMessages = s.t('rooms.noMessages');
    final previewText = busy
        ? s.t('rooms.working')
        : last == null
        ? (room.topic.isNotEmpty
              ? preview(room.topic, 46)
              : (!room.isGroup && bot != null
                    ? (bot.tagline.isNotEmpty
                          ? preview(bot.tagline, 40)
                          : noMessages)
                    : (room.isGroup && room.leadName != null
                          ? s.tf('rooms.leadMembers', {
                              'lead': room.leadName!,
                              'n': room.botIds.length,
                            })
                          : noMessages)))
        // 名字现查，别用消息里存的那份快照 ——
        // bot 改名之前发过的消息里存的还是旧名字。
        : s.tf('rooms.previewLine', {
            'who': last.isUser
                ? s.t('rooms.me')
                : (state.botById(last.authorId)?.name ?? last.authorName),
            'text': preview(last.text, 46),
          });

    return MouseRegion(
      onEnter: (_) => setState(() => _hovered = true),
      onExit: (_) => setState(() => _hovered = false),
      child: Padding(
        padding: const EdgeInsets.symmetric(vertical: 1),
        child: Stack(
          children: [
            AnimatedContainer(
              duration: const Duration(milliseconds: 140),
              curve: Curves.easeOut,
              decoration: BoxDecoration(
                color: (widget.selected || _pressed)
                    ? PB.bgHover
                    : Colors.transparent,
                borderRadius: BorderRadius.circular(12),
              ),
              child: Material(
                color: Colors.transparent,
                borderRadius: BorderRadius.circular(12),
                child: InkWell(
                  borderRadius: BorderRadius.circular(12),
                  onTap: () => widget.onOpen(room),
                  // 桌面右键：贴着鼠标弹；手机长按：贴着这一行弹。
                  // （InkWell 没有 onLongPressStart，拿不到手指坐标，就用行的中心当锚点。）
                  onSecondaryTapDown: (d) =>
                      _roomMenu(context, room, d.globalPosition),
                  onLongPress: () {
                    if (isMobilePlatform) HapticFeedback.selectionClick();
                    _roomMenu(context, room, _rowAnchor());
                  },
                  onHighlightChanged: (v) => setState(() => _pressed = v),
                  child: Padding(
                    padding: const EdgeInsets.symmetric(
                      horizontal: 10,
                      vertical: 9,
                    ),
                    child: Row(
                      children: [
                        if (room.isGroup)
                          SizedBox(
                            width: 46,
                            height: 46,
                            child: Stack(
                              clipBehavior: Clip.none,
                              children: [
                                GroupBlobAvatar(
                                  seeds: room.botIds,
                                  size: 46,
                                  animate: false,
                                  mood: busy
                                      ? AvatarMood.busy
                                      : AvatarMood.idle,
                                ),
                                if (busy)
                                  Positioned(
                                    right: -3,
                                    bottom: -3,
                                    child: Container(
                                      padding: const EdgeInsets.all(2),
                                      decoration: BoxDecoration(
                                        color: Theme.of(
                                          context,
                                        ).scaffoldBackgroundColor,
                                        shape: BoxShape.circle,
                                      ),
                                      child: SizedBox(
                                        width: 12,
                                        height: 12,
                                        child: CircularProgressIndicator(
                                          strokeWidth: 1.8,
                                          color: PB
                                              .colors(context)
                                              .accentBright,
                                        ),
                                      ),
                                    ),
                                  ),
                              ],
                            ),
                          )
                        else
                          BlobAvatar(
                            seed: room.botIds.isNotEmpty
                                ? room.botIds.first
                                : room.id,
                            color: PB.colorFor(
                              room.botIds.isNotEmpty
                                  ? room.botIds.first
                                  : room.id,
                            ),
                            emoji: state
                                .botById(
                                  room.botIds.isNotEmpty
                                      ? room.botIds.first
                                      : null,
                                )
                                ?.emoji,
                            size: 46,
                            animate: false,
                            // ★ 聊天头部一直传了 mood，侧边栏没传 —— 于是"哪个群/同事
                            //   正在干活"这个状态在列表里完全看不到，要在所有行里
                            //   长得一模一样。busy 从 state.typing 拿（和预览行的"正在干活…"同源）。
                            //   animate:false 不影响小动作：干活中的头像不靠呼吸也会自己动
                            //   （见 BlobAvatar._ambientAllowed）。
                            mood: busy ? AvatarMood.busy : AvatarMood.idle,
                            // 整行被指到（悬停/按下）就让它跟着鼠标看 ——
                            // 用户的心智是"我进到这条会话上，它就该看着我"，
                            // 而不是"鼠标必须精确压在头像那 46px 里"。
                            hovered: _hovered || _pressed,
                            ring:
                                state
                                    .botById(
                                      room.botIds.isNotEmpty
                                          ? room.botIds.first
                                          : null,
                                    )
                                    ?.isMain ??
                                false,
                            badge: busy
                                ? SizedBox(
                                    width: 12,
                                    height: 12,
                                    child: CircularProgressIndicator(
                                      strokeWidth: 1.8,
                                      color: PB.colors(context).accentBright,
                                    ),
                                  )
                                : null,
                          ),
                        const SizedBox(width: 12),
                        Expanded(
                          child: Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              Row(
                                children: [
                                  Expanded(
                                    child: Text(
                                      room.name,
                                      style: TextStyle(
                                        fontSize: PB.fsBase,
                                        fontWeight: room.unread
                                            ? FontWeight.w700
                                            : FontWeight.w600,
                                        letterSpacing: -0.1,
                                        color: PB.textPrimary,
                                      ),
                                      overflow: TextOverflow.ellipsis,
                                    ),
                                  ),
                                  if (room.pinned) ...[
                                    const SizedBox(width: 6),
                                    Icon(
                                      LucideIcons.pin,
                                      key: ValueKey('pin-${room.id}'),
                                      size: 12,
                                      color: PB.textQuaternary,
                                    ),
                                  ],
                                  if (widget.pending != null) ...[
                                    const SizedBox(width: 6),
                                    Container(
                                      key: ValueKey('pending-${room.id}'),
                                      padding: const EdgeInsets.symmetric(
                                        horizontal: 6,
                                        vertical: 1.5,
                                      ),
                                      decoration: BoxDecoration(
                                        color: (widget.pending!.irreversible
                                                ? PB.danger
                                                : PB.warn)
                                            .withValues(alpha: 0.14),
                                        borderRadius: BorderRadius.circular(
                                          PB.rFull,
                                        ),
                                      ),
                                      child: Text(
                                        widget.pending!.badgeLabel(s),
                                        style: TextStyle(
                                          fontSize: 10,
                                          fontWeight: FontWeight.w600,
                                          color: widget.pending!.irreversible
                                              ? PB.danger
                                              : PB.warn,
                                        ),
                                      ),
                                    ),
                                  ],
                                  const SizedBox(width: 8),
                                  Text(
                                    formatTime(room.lastMessageAt),
                                    style: TextStyle(
                                      fontSize: PB.fsXxs,
                                      color: PB.textQuaternary,
                                      fontFeatures: [
                                        FontFeature.tabularFigures(),
                                      ],
                                    ),
                                  ),
                                ],
                              ),
                              const SizedBox(height: 4),
                              Row(
                                children: [
                                  Expanded(
                                    child: Text(
                                      previewText,
                                      maxLines: 1,
                                      overflow: TextOverflow.ellipsis,
                                      style: TextStyle(
                                        fontSize: PB.fsSm,
                                        height: 1.3,
                                        color: busy
                                            ? PB.colors(context).link
                                            : (room.unread
                                                  ? PB.textSecondary
                                                  : PB.textTertiary),
                                      ),
                                    ),
                                  ),
                                  if (room.unread) ...[
                                    const SizedBox(width: 8),
                                    Container(
                                      key: ValueKey('unread-${room.id}'),
                                      width: 7,
                                      height: 7,
                                      decoration: BoxDecoration(
                                        color: PB.colors(context).accent,
                                        shape: BoxShape.circle,
                                      ),
                                    ),
                                  ],
                                ],
                              ),
                            ],
                          ),
                        ),
                      ],
                    ),
                  ),
                ),
              ),
            ),
            if (widget.selected)
              Positioned(
                left: 0,
                top: 12,
                bottom: 12,
                child: Container(
                  width: 3,
                  decoration: BoxDecoration(
                    color: PB.colors(context).accent,
                    borderRadius: BorderRadius.circular(2),
                  ),
                ),
              ),
          ],
        ),
      ),
    );
  }

  /// 这一行在屏幕上的中心点 —— 长按弹菜单时的锚点
  Offset _rowAnchor() {
    final box = context.findRenderObject() as RenderBox?;
    if (box == null || !box.hasSize) return Offset.zero;
    return box.localToGlobal(box.size.center(Offset.zero));
  }

  /// 会话菜单：置顶 / 标为未读 / 重命名 / 复制 ID /
  /// 隐藏 / 删除。
  ///
  /// 桌面右键和手机长按共用这一个菜单，只是弹出位置不同（都贴着触发点）。
  /// 不用 `showModalBottomSheet`：桌面上它会从屏幕最底下窜出来、离点的那行
  /// 半个屏幕远；而且它只给群一个"解散这个群"，**私聊删不掉**
  /// （服务端 deleteRoom 也把 dm 挡住了）。
  /// 把一个部门存成模板（只存班子，不存聊天记录）
  Future<void> _saveAsTemplate(BuildContext context, Room room) async {
    final s = L10n.s(context);
    final controller = TextEditingController(text: room.name);
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        backgroundColor: PB.bgElevated,
        title: Text(
          s.tf('rooms.saveTemplateTitle', {'name': room.name}),
          style: const TextStyle(fontSize: PB.fsLg),
        ),
        content: SizedBox(
          width: 380,
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                s.t('rooms.saveTemplateBody'),
                style: TextStyle(
                  fontSize: PB.fsXs,
                  color: PB.textTertiary,
                  height: 1.6,
                ),
              ),
              const SizedBox(height: 12),
              TextField(
                controller: controller,
                autofocus: true,
                decoration: InputDecoration(
                  labelText: s.t('rooms.templateName'),
                ),
              ),
            ],
          ),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(ctx, false),
            child: Text(s.t('common.cancel')),
          ),
          FilledButton(
            onPressed: () => Navigator.pop(ctx, true),
            child: Text(s.t('common.save')),
          ),
        ],
      ),
    );
    if (ok != true) return;
    final name = controller.text.trim();
    controller.dispose();
    if (name.isEmpty) return;
    if (!context.mounted) return;
    final state = AppScope.read(context);
    final err = await state.saveTemplateFromRoom(room.id, name);
    if (!context.mounted) return;
    toast(context, err ?? s.tf('rooms.templateSaved', {'name': name}));
  }

  Future<void> _roomMenu(BuildContext context, Room room, Offset at) async {
    final s = L10n.s(context);
    final state = widget.state;
    final bot = state.botById(
      room.botIds.isNotEmpty ? room.botIds.first : null,
    );
    await showFloatingMenu(
      context: context,
      at: at,
      entries: [
        FloatingMenuEntry(
          icon: room.pinned ? LucideIcons.pinOff : LucideIcons.pin,
          label: room.pinned ? s.t('rooms.unpin') : s.t('rooms.pin'),
          onTap: () => state.updateRoom(room.id, {'pinned': !room.pinned}),
        ),
        FloatingMenuEntry(
          icon: room.unread ? LucideIcons.bellOff : LucideIcons.bell,
          label: room.unread ? s.t('rooms.markRead') : s.t('rooms.markUnread'),
          onTap: () => state.updateRoom(room.id, {'unread': !room.unread}),
        ),
        FloatingMenuEntry(
          icon: LucideIcons.pencil,
          // 私聊的标题就是那个 bot 的名字，改的是 bot 本身；群改的是群名
          label: room.isGroup ? s.t('rooms.rename') : s.t('rooms.renameBot'),
          onTap: () => _rename(context, room, bot),
        ),
        FloatingMenuEntry(
          icon: LucideIcons.copy,
          label: s.t('rooms.copyId'),
          onTap: () async {
            await Clipboard.setData(ClipboardData(text: room.id));
            if (!context.mounted) return;
            toast(context, s.t('rooms.idCopied'));
          },
        ),
        FloatingMenuEntry(
          icon: room.hidden ? LucideIcons.eye : LucideIcons.eyeOff,
          label: room.hidden ? s.t('rooms.unhide') : s.t('rooms.hide'),
          onTap: () => state.updateRoom(room.id, {'hidden': !room.hidden}),
        ),
        // ★ 「这个班子不错，再来一个一样的」——存成部门模板。
        //   只存班子（人 + 人设 + 模型 + 技能）和谁当老大，不存聊天记录。
        if (room.isGroup)
          FloatingMenuEntry(
            icon: LucideIcons.packagePlus,
            label: s.t('rooms.saveAsTemplate'),
            onTap: () => _saveAsTemplate(context, room),
          ),
        FloatingMenuEntry(
          icon: LucideIcons.trash2,
          label: room.isGroup ? s.t('rooms.disband') : s.t('rooms.deleteChat'),
          danger: true,
          onTap: () async {
            if (!await _confirmDelete(context, room)) return;
            if (context.mounted) await state.deleteRoom(room.id);
          },
        ),
        // ★ 「删对话」和「删 bot」是两件事，分开放：
        //   前者只是清掉聊天记录（人还在，下次点它还能聊），
        //   后者是把这个同事**从花名册里除名**。
        //   群没有"这一个 bot"可删；主控也删不了（服务端也挡）。
        if (!room.isGroup && bot != null && !bot.isMain)
          FloatingMenuEntry(
            icon: LucideIcons.userMinus,
            label: s.t('rooms.deleteBot'),
            danger: true,
            onTap: () => _confirmDeleteBot(context, bot),
          ),
      ],
    );
  }

  Future<void> _rename(BuildContext context, Room room, Bot? bot) async {
    final s = L10n.s(context);
    final state = widget.state;
    final isDm = !room.isGroup;
    final next = await _askName(
      context,
      title: isDm ? s.t('rooms.renameBot') : s.t('rooms.renameChat'),
      initial: isDm ? (bot?.name ?? room.name) : room.name,
    );
    if (next == null || next.isEmpty) return;
    if (isDm) {
      if (bot == null) return;
      // 改 bot 名，服务端会同步把私聊标题一起改掉
      await state.updateBot(bot.id, {'name': next});
    } else {
      await state.updateRoom(room.id, {'name': next});
    }
  }

  /// 删除助手前必须问一次 —— 这个动作没有撤销。
  ///
  /// 具体弹窗在 widgets/bot_delete_confirm.dart：助手编辑页也要用同一套，
  /// 两处行为必须一致（原来是各写各的，编辑页那个干脆不问）。
  Future<void> _confirmDeleteBot(BuildContext context, Bot bot) async {
    await confirmDeleteBot(context, bot, delete: widget.state.deleteBot);
  }

  Future<bool> _confirmDelete(BuildContext context, Room room) async {
    final s = L10n.s(context);
    final isGroup = room.isGroup;
    final name = room.name;
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        backgroundColor: PB.bgElevated,
        title: Text(
          isGroup
              ? s.tf('rooms.disbandTitle', {'name': name})
              : s.tf('rooms.deleteChatTitle', {'name': name}),
          style: const TextStyle(fontSize: PB.fsLg),
        ),
        content: Text(
          isGroup ? s.t('rooms.disbandBody') : s.t('rooms.deleteChatBody'),
          style: TextStyle(fontSize: PB.fsSm, color: PB.textSecondary),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(ctx, false),
            child: Text(s.t('common.cancel')),
          ),
          FilledButton(
            style: FilledButton.styleFrom(backgroundColor: PB.danger),
            onPressed: () => Navigator.pop(ctx, true),
            child: Text(s.t('common.delete')),
          ),
        ],
      ),
    );
    return ok == true;
  }

  Future<String?> _askName(
    BuildContext context, {
    required String title,
    required String initial,
  }) {
    final controller = TextEditingController(text: initial);
    return showDialog<String>(
      context: context,
      builder: (ctx) => AlertDialog(
        backgroundColor: PB.bgElevated,
        title: Text(title, style: const TextStyle(fontSize: PB.fsLg)),
        content: TextField(
          controller: controller,
          autofocus: true,
          style: const TextStyle(fontSize: PB.fsSm),
          onSubmitted: (v) => Navigator.pop(ctx, v.trim()),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(ctx),
            child: Text(L10n.s(ctx).t('common.cancel')),
          ),
          FilledButton(
            onPressed: () => Navigator.pop(ctx, controller.text.trim()),
            child: Text(L10n.s(ctx).t('common.save')),
          ),
        ],
      ),
    );
  }
}

/// 列表底部那一行「已隐藏 N 个会话」—— 隐藏功能的出口
class _HiddenRow extends StatelessWidget {
  const _HiddenRow({required this.count, required this.onTap});

  final int count;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(10, 10, 10, 16),
      child: InkWell(
        borderRadius: BorderRadius.circular(10),
        onTap: onTap,
        child: Padding(
          padding: const EdgeInsets.symmetric(vertical: 9),
          child: Row(
            children: [
              Icon(
                LucideIcons.eyeOff,
                size: 16,
                color: PB.textQuaternary,
              ),
              const SizedBox(width: 8),
              Text(
                L10n.s(context).tf('rooms.hiddenCount', {'n': count}),
                style: TextStyle(
                  fontSize: PB.fsXs,
                  color: PB.textQuaternary,
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
