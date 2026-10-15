import 'package:flutter/material.dart';

import '../app_state.dart';
import '../models.dart';
import '../scope.dart';
import '../theme.dart';
import '../widgets/blob_avatar.dart';
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

class _RoomsScreenState extends State<RoomsScreen> {
  bool _searching = false;
  final _searchController = TextEditingController();
  String _query = '';

  @override
  void dispose() {
    _searchController.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final state = AppScope.of(context);
    final rooms = _query.isEmpty
        ? state.rooms
        : state.rooms
              .where((r) => r.name.toLowerCase().contains(_query.toLowerCase()))
              .toList();

    return Scaffold(
      backgroundColor: PB.bgApp,
      appBar: AppBar(
        toolbarHeight: 62,
        titleSpacing: 18,
        title: _searching
            ? TextField(
                controller: _searchController,
                autofocus: true,
                style: const TextStyle(fontSize: PB.fsBase),
                decoration: const InputDecoration(
                  hintText: '搜索会话',
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
                  Text(
                    state.serverInfo?.hostname.isNotEmpty == true
                        ? state.serverInfo!.hostname
                        : (state.serverUrl ?? 'pi-bot'),
                    style: const TextStyle(
                      fontSize: PB.fsLg,
                      fontWeight: FontWeight.w500,
                    ),
                    overflow: TextOverflow.ellipsis,
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
                              ? '${state.bots.length} 个 bot · ${shortModel(state.serverInfo?.model)}'
                              : (state.link == LinkState.connecting
                                    ? '连接中…'
                                    : '离线 · 自动重连中'),
                          style: const TextStyle(
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
          _CircleIcon(
            icon: LucideIcons.plus,
            filled: true,
            onTap: () => _showCreateSheet(context),
          ),
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
      body: RefreshIndicator(
        color: PB.accent,
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
                        ? '正在连接服务端…'
                        : '连不上服务端，会自动重试',
                    icon: state.link == LinkState.connecting
                        ? LucideIcons.refreshCw
                        : LucideIcons.cloudOff,
                  ),
                if (rooms.isEmpty &&
                    _query.isEmpty &&
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
                          child: const Icon(
                            LucideIcons.sparkles,
                            size: 26,
                            color: PB.textQuaternary,
                          ),
                        ),
                        const SizedBox(height: 18),
                        Text(
                          _query.isEmpty ? '还没有会话' : '没找到「$_query」',
                          style: const TextStyle(
                            color: PB.textSecondary,
                            fontSize: PB.fsSm,
                            fontWeight: FontWeight.w500,
                          ),
                        ),
                        const SizedBox(height: 6),
                        const Text(
                          '点右上角 + 建一个团队',
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
                    room: room,
                    state: state,
                    selected: widget.selectedId == room.id,
                    onOpen: (r) {
                      if (widget.onSelect != null) {
                        widget.onSelect!(r);
                      } else {
                        Navigator.push(
                          context,
                          MaterialPageRoute(
                            builder: (_) => ChatScreen(room: r),
                          ),
                        );
                      }
                    },
                  ),
              ],
            ),
          ),
        ),
      ),
    );
  }

  Future<void> _showCreateSheet(BuildContext context) async {
    final state = AppScope.read(context);
    final mainBot = state.mainBot;

    await showModalBottomSheet<void>(
      context: context,
      backgroundColor: PB.bgElevated,
      isScrollControlled: true,
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(PB.r3xl)),
      ),
      builder: (ctx) => SafeArea(
        child: Padding(
          padding: const EdgeInsets.only(top: 10, bottom: 10),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Center(
                child: Container(
                  width: 36,
                  height: 4,
                  decoration: BoxDecoration(
                    color: PB.borderPrimary,
                    borderRadius: BorderRadius.circular(2),
                  ),
                ),
              ),
              const SizedBox(height: 14),
              const Padding(
                padding: EdgeInsets.symmetric(horizontal: 20),
                child: Text(
                  '新建',
                  style: TextStyle(
                    fontSize: PB.fsSm,
                    fontWeight: FontWeight.w600,
                    color: PB.textTertiary,
                  ),
                ),
              ),
              const SizedBox(height: 6),
              _SheetRow(
                icon: LucideIcons.users,
                title: '让主控建一个团队',
                subtitle: '一句话说清要干什么，主控会造好几个有分工的 bot 并建群',
                highlight: true,
                onTap: () {
                  Navigator.pop(ctx);
                  _talkToMain(context, '帮我建一个团队，成员分工明确。任务是：');
                },
              ),
              _SheetRow(
                icon: LucideIcons.messagesSquare,
                title: '新建空群',
                subtitle: '先建群，之后再把 bot 拉进来',
                onTap: () {
                  Navigator.pop(ctx);
                  _createGroup(context);
                },
              ),
              _SheetRow(
                icon: LucideIcons.bot,
                title: '花名册',
                subtitle: '${state.bots.length} 个 bot：看人设 / 换模型 / 调思考等级',
                onTap: () {
                  Navigator.pop(ctx);
                  Navigator.push(
                    context,
                    MaterialPageRoute(builder: (_) => const BotsScreen()),
                  );
                },
              ),
              const Divider(height: 22),
              const Padding(
                padding: EdgeInsets.symmetric(horizontal: 20),
                child: Text(
                  '私聊某个 bot',
                  style: TextStyle(
                    fontSize: PB.fsSm,
                    fontWeight: FontWeight.w600,
                    color: PB.textTertiary,
                  ),
                ),
              ),
              const SizedBox(height: 4),
              ConstrainedBox(
                constraints: BoxConstraints(
                  maxHeight: MediaQuery.sizeOf(context).height * 0.36,
                ),
                child: ListView(
                  shrinkWrap: true,
                  children: [
                    for (final bot in state.bots)
                      ListTile(
                        leading: BlobAvatar(
                          seed: bot.id,
                          color: PB.colorFor(bot.id),
                          emoji: bot.emoji,
                          size: 34,
                          animate: false,
                        ),
                        title: Text(
                          bot.name,
                          style: const TextStyle(fontSize: PB.fsSm),
                        ),
                        subtitle: Text(
                          bot.isMain
                              ? '主控（superroot）'
                              : '${bot.model ?? '默认模型'} · ${bot.thinking}',
                          style: const TextStyle(
                            fontSize: PB.fsXs,
                            color: PB.textQuaternary,
                          ),
                        ),
                        onTap: () async {
                          Navigator.pop(ctx);
                          final room = await state.ensureDm(bot.id);
                          if (room != null && context.mounted) {
                            Navigator.push(
                              context,
                              MaterialPageRoute(
                                builder: (_) => ChatScreen(room: room),
                              ),
                            );
                          }
                        },
                      ),
                  ],
                ),
              ),
              const SizedBox(height: 6),
              Padding(
                padding: const EdgeInsets.symmetric(horizontal: 20),
                child: Text(
                  mainBot == null ? '' : '提示：直接和主控说「建个 XX 团队」最快。',
                  style: const TextStyle(
                    fontSize: PB.fsXxs,
                    color: PB.textQuaternary,
                  ),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }

  Future<void> _talkToMain(BuildContext context, String prefill) async {
    final state = AppScope.read(context);
    final mainBot = state.mainBot;
    if (mainBot == null) return;
    final room = await state.ensureDm(mainBot.id);
    if (room == null || !context.mounted) return;
    Navigator.push(
      context,
      MaterialPageRoute(
        builder: (_) => ChatScreen(room: room, initialText: prefill),
      ),
    );
  }

  Future<void> _createGroup(BuildContext context) async {
    final nameController = TextEditingController();
    final topicController = TextEditingController();
    final state = AppScope.read(context);
    final selected = <String>{};

    final created = await showDialog<bool>(
      context: context,
      builder: (ctx) => StatefulBuilder(
        builder: (ctx, setLocal) => AlertDialog(
          title: const Text('新建群'),
          content: SingleChildScrollView(
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                TextField(
                  controller: nameController,
                  autofocus: true,
                  decoration: const InputDecoration(labelText: '群名'),
                ),
                const SizedBox(height: 10),
                TextField(
                  controller: topicController,
                  decoration: const InputDecoration(labelText: '这个群要干嘛（可选）'),
                ),
                const SizedBox(height: 16),
                const Text(
                  '拉谁进来',
                  style: TextStyle(fontSize: PB.fsXs, color: PB.textTertiary),
                ),
                const SizedBox(height: 4),
                for (final bot in state.bots)
                  CheckboxListTile(
                    dense: true,
                    contentPadding: EdgeInsets.zero,
                    value: bot.isMain || selected.contains(bot.id),
                    onChanged: bot.isMain
                        ? null
                        : (v) => setLocal(
                            () => v == true
                                ? selected.add(bot.id)
                                : selected.remove(bot.id),
                          ),
                    secondary: BlobAvatar(
                      seed: bot.id,
                      color: PB.colorFor(bot.id),
                      emoji: bot.emoji,
                      size: 28,
                      animate: false,
                    ),
                    title: Text(
                      bot.name,
                      style: const TextStyle(fontSize: PB.fsSm),
                    ),
                  ),
              ],
            ),
          ),
          actions: [
            TextButton(
              onPressed: () => Navigator.pop(ctx, false),
              child: const Text('取消'),
            ),
            FilledButton(
              onPressed: () => Navigator.pop(ctx, true),
              child: const Text('创建'),
            ),
          ],
        ),
      ),
    );

    if (created != true ||
        nameController.text.trim().isEmpty ||
        !context.mounted)
      return;
    final room = await state.createGroup(
      nameController.text.trim(),
      topic: topicController.text.trim(),
      botIds: selected.toList(),
    );
    if (room != null && context.mounted) {
      Navigator.push(
        context,
        MaterialPageRoute(builder: (_) => ChatScreen(room: room)),
      );
    }
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
      color: filled ? PB.accent : PB.bgElevated,
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

class _SheetRow extends StatelessWidget {
  const _SheetRow({
    required this.icon,
    required this.title,
    required this.subtitle,
    required this.onTap,
    this.highlight = false,
  });

  final IconData icon;
  final String title;
  final String subtitle;
  final VoidCallback onTap;
  final bool highlight;

  @override
  Widget build(BuildContext context) {
    return ListTile(
      onTap: onTap,
      leading: Container(
        width: 36,
        height: 36,
        decoration: BoxDecoration(
          color: highlight ? PB.accentSoft : PB.bgActive,
          borderRadius: BorderRadius.circular(10),
        ),
        child: Icon(
          icon,
          size: 18,
          color: highlight ? PB.accent : PB.textSecondary,
        ),
      ),
      title: Text(
        title,
        style: const TextStyle(
          fontSize: PB.fsBase,
          fontWeight: FontWeight.w500,
        ),
      ),
      subtitle: Text(
        subtitle,
        style: const TextStyle(fontSize: PB.fsXs, color: PB.textQuaternary),
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
              style: const TextStyle(fontSize: PB.fsXs, color: PB.textTertiary),
            ),
          ),
        ],
      ),
    );
  }
}

class _RoomRow extends StatefulWidget {
  const _RoomRow({
    required this.room,
    required this.state,
    required this.onOpen,
    this.selected = false,
  });

  final Room room;
  final AppState state;
  final void Function(Room room) onOpen;
  final bool selected;

  @override
  State<_RoomRow> createState() => _RoomRowState();
}

class _RoomRowState extends State<_RoomRow> {
  bool _pressed = false;

  @override
  Widget build(BuildContext context) {
    final room = widget.room;
    final state = widget.state;
    final last = room.lastMessage;
    final busy = state.typing[room.id] == true;
    final bot = state.botById(room.botIds.isNotEmpty ? room.botIds.first : null);
    final preview = busy
        ? '正在干活…'
        : last == null
        ? (room.topic.isNotEmpty
              ? room.topic
              : (!room.isGroup && bot != null
                    ? '${bot.model ?? '默认模型'} · thinking ${bot.thinking ?? '-'}'
                    : (room.isGroup && room.leadName != null
                          ? '老大 ${room.leadName} · ${room.botIds.length} 人'
                          : '还没有消息')))
        : '${last.isUser ? '我' : last.authorName}：${shortText(last.text, 46)}';

    return Padding(
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
                onLongPress: () => _roomMenu(context, room),
                onHighlightChanged: (v) => setState(() => _pressed = v),
                child: Padding(
                  padding: const EdgeInsets.symmetric(
                    horizontal: 10,
                    vertical: 9,
                  ),
                  child: Row(
                    children: [
                      if (room.isGroup)
                        GroupBlobAvatar(
                          seeds: room.botIds,
                          size: 46,
                          animate: false,
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
                              ? const SizedBox(
                                  width: 12,
                                  height: 12,
                                  child: CircularProgressIndicator(
                                    strokeWidth: 1.8,
                                    color: PB.accent,
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
                                    style: const TextStyle(
                                      fontSize: PB.fsBase,
                                      fontWeight: FontWeight.w600,
                                      letterSpacing: -0.1,
                                      color: PB.textPrimary,
                                    ),
                                    overflow: TextOverflow.ellipsis,
                                  ),
                                ),
                                const SizedBox(width: 8),
                                Text(
                                  formatTime(room.lastMessageAt),
                                  style: const TextStyle(
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
                            Text(
                              preview,
                              maxLines: 1,
                              overflow: TextOverflow.ellipsis,
                              style: TextStyle(
                                fontSize: PB.fsSm,
                                height: 1.3,
                                color: busy ? PB.accent : PB.textTertiary,
                              ),
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
                  color: PB.accent,
                  borderRadius: BorderRadius.circular(2),
                ),
              ),
            ),
        ],
      ),
    );
  }

  Future<void> _roomMenu(BuildContext context, Room room) async {
    final state = widget.state;
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
            const SizedBox(height: 10),
            Container(
              width: 36,
              height: 4,
              decoration: BoxDecoration(
                color: PB.borderPrimary,
                borderRadius: BorderRadius.circular(2),
              ),
            ),
            ListTile(
              leading: const Icon(LucideIcons.messageSquare, size: 20),
              title: Text(room.name, style: const TextStyle(fontSize: PB.fsSm)),
              subtitle: Text(
                room.isGroup ? '群 · ${room.botIds.length} 个 bot' : '私聊',
                style: const TextStyle(
                  fontSize: PB.fsXs,
                  color: PB.textQuaternary,
                ),
              ),
            ),
            const Divider(height: 1),
            if (room.isGroup)
              ListTile(
                leading: const Icon(
                  LucideIcons.trash2,
                  size: 20,
                  color: PB.danger,
                ),
                title: const Text(
                  '解散这个群',
                  style: TextStyle(fontSize: PB.fsSm, color: PB.danger),
                ),
                onTap: () async {
                  Navigator.pop(ctx);
                  await state.deleteRoom(room.id);
                },
              ),
            const SizedBox(height: 8),
          ],
        ),
      ),
    );
  }
}
