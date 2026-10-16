import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../models.dart';
import '../scope.dart';
import '../theme.dart';
import 'blob_avatar.dart';

/// 点聊天顶部的胶囊 → 从右边滑出来的面板。
///
/// 放什么进去的原则：**只放"这一屏聊天里看不到、但你会想问"的东西** ——
/// 这个会话是谁、里面有谁、上下文用得怎么样。
/// 不堆功能入口（那些归「…」菜单），面板一挤就没人看了。
///
/// 群聊多一个「成员」页：那是唯一能**把某个 bot 移出群**的地方，
/// 所以要给它一个显眼的位置（用户明确提过这个需求）。
Future<void> showRoomPanel(BuildContext context, Room room) async {
  await Navigator.of(context).push(
    PageRouteBuilder(
      opaque: false,
      barrierColor: Colors.black.withValues(alpha: 0.35),
      pageBuilder: (ctx, _, __) => _RoomPanel(room: room),
      transitionsBuilder: (ctx, anim, _, child) => SlideTransition(
        position: Tween(
          begin: const Offset(1, 0),
          end: Offset.zero,
        ).animate(CurvedAnimation(parent: anim, curve: Curves.easeOutCubic)),
        child: child,
      ),
    ),
  );
}

class _RoomPanel extends StatefulWidget {
  const _RoomPanel({required this.room});

  final Room room;

  @override
  State<_RoomPanel> createState() => _RoomPanelState();
}

class _RoomPanelState extends State<_RoomPanel> {
  /// 0 = 详情，1 = 成员（只有群才有）
  int _tab = 0;

  @override
  Widget build(BuildContext context) {
    // 面板也要跟着 state 刷新（移出成员之后名单要立刻变）
    final state = AppScope.of(context);
    final room = state.rooms.firstWhere(
      (r) => r.id == widget.room.id,
      orElse: () => widget.room,
    );
    final isGroup = room.isGroup;
    final ctxInfo = state.contextFor(room.id);

    return Align(
      alignment: Alignment.centerRight,
      child: Material(
        // Overlay/路由里没有 Material 祖先的话，Flutter 会给文字画黄色双下划线
        type: MaterialType.transparency,
        child: Container(
          width: 380,
          height: double.infinity,
          decoration: BoxDecoration(
            color: PB.bgPane,
            border: Border(left: BorderSide(color: PB.borderSecondary)),
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              _header(context, room),
              _tabs(isGroup),
              Container(height: 1, color: PB.borderTertiary),
              Expanded(
                child: _tab == 0
                    ? _detail(room, ctxInfo)
                    : _members(context, room),
              ),
            ],
          ),
        ),
      ),
    );
  }

  Widget _header(BuildContext context, Room room) {
    final lead = room.leadName;
    return Padding(
      padding: const EdgeInsets.fromLTRB(18, 18, 10, 14),
      child: Column(
        children: [
          Align(
            alignment: Alignment.centerRight,
            child: IconButton(
              tooltip: '关闭',
              onPressed: () => Navigator.of(context).pop(),
              icon: const Icon(LucideIcons.x, size: 18),
            ),
          ),
          if (room.isGroup)
            GroupBlobAvatar(seeds: room.botIds, size: 64, animate: false)
          else
            BlobAvatar(
              seed: room.botIds.isNotEmpty ? room.botIds.first : room.id,
              color: PB.colorFor(
                room.botIds.isNotEmpty ? room.botIds.first : room.id,
              ),
              size: 64,
              animate: false,
            ),
          const SizedBox(height: 12),
          Text(
            room.isGroup ? room.name : (lead ?? room.name),
            textAlign: TextAlign.center,
            style: const TextStyle(
              fontSize: PB.fsLg,
              fontWeight: FontWeight.w600,
            ),
          ),
          if (room.topic.isNotEmpty) ...[
            const SizedBox(height: 6),
            Text(
              room.topic,
              textAlign: TextAlign.center,
              maxLines: 3,
              overflow: TextOverflow.ellipsis,
              style: const TextStyle(
                fontSize: PB.fsXs,
                color: PB.textQuaternary,
                height: 1.5,
              ),
            ),
          ],
        ],
      ),
    );
  }

  Widget _tabs(bool isGroup) {
    final tabs = <String>['详情', if (isGroup) '成员'];
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 18),
      child: Row(
        children: [
          for (var i = 0; i < tabs.length; i++)
            Padding(
              padding: const EdgeInsets.only(right: 8),
              child: InkWell(
                borderRadius: BorderRadius.circular(PB.rFull),
                onTap: () => setState(() => _tab = i),
                child: Container(
                  padding: const EdgeInsets.symmetric(
                    horizontal: 14,
                    vertical: 6,
                  ),
                  decoration: BoxDecoration(
                    color: _tab == i ? PB.bgActive : Colors.transparent,
                    borderRadius: BorderRadius.circular(PB.rFull),
                  ),
                  child: Text(
                    tabs[i],
                    style: TextStyle(
                      fontSize: PB.fsXs,
                      color: _tab == i ? PB.textPrimary : PB.textTertiary,
                    ),
                  ),
                ),
              ),
            ),
        ],
      ),
    );
  }

  Widget _detail(Room room, ContextInfo? ctx) {
    String k(int n) => n >= 1000 ? '${(n / 1000).round()}k' : '$n';
    return SingleChildScrollView(
      padding: const EdgeInsets.fromLTRB(18, 16, 18, 24),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          if (room.isGroup) ...[
            _row('类型', '部门（群）'),
            _row('人数', '${room.botIds.length} 人'),
            _row('负责人', room.leadName ?? '—'),
          ] else
            _row('类型', '私聊'),
          if (room.lastMessageAt > 0)
            _row('最后消息', _timeText(room.lastMessageAt)),
          _row('消息条数', '${room.messageCount}'),
          if (ctx != null && ctx.known)
            _row(
              '上下文',
              '${k(ctx.tokens ?? 0)} / ${k(ctx.contextWindow ?? 0)}'
                  '（${(ctx.percent ?? 0).round()}%）'
                  '${ctx.compacting ? ' · 正在压缩' : ''}',
            ),
        ],
      ),
    );
  }

  String _timeText(int ms) {
    final d = DateTime.fromMillisecondsSinceEpoch(ms);
    String two(int n) => n.toString().padLeft(2, '0');
    return '${d.month}/${d.day} ${two(d.hour)}:${two(d.minute)}';
  }

  Widget _row(String label, String value) => Padding(
    padding: const EdgeInsets.only(bottom: 12),
    child: Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        SizedBox(
          width: 72,
          child: Text(
            label,
            style: const TextStyle(fontSize: PB.fsXs, color: PB.textTertiary),
          ),
        ),
        Expanded(
          child: Text(
            value,
            style: const TextStyle(
              fontSize: PB.fsXs,
              color: PB.textSecondary,
              height: 1.5,
            ),
          ),
        ),
      ],
    ),
  );

  Widget _members(BuildContext context, Room room) {
    final state = AppScope.of(context);
    return ListView(
      padding: const EdgeInsets.fromLTRB(10, 8, 10, 24),
      children: [
        for (final id in room.botIds)
          _MemberRow(
            bot: state.botById(id),
            isLead: id == room.leadBotId,
            // 移出群：留一个人在里面（空群没有意义），而且服务端会顺手改掉老大
            canRemove: room.botIds.length > 1,
            onRemove: () => _confirmRemove(context, room, state.botById(id)),
          ),
      ],
    );
  }

  Future<void> _confirmRemove(BuildContext context, Room room, Bot? bot) async {
    if (bot == null) return;
    final state = AppScope.read(context);
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        backgroundColor: PB.bgElevated,
        title: Text(
          '把 ${bot.emoji ?? ''}${bot.name} 移出「${room.name}」？',
          style: const TextStyle(fontSize: PB.fsLg),
        ),
        content: const Text(
          '它会不再参与这个部门的活。\n\n'
          'bot 本身还在花名册里，你和它的私聊、你教过它的东西都留着 —— '
          '以后想加回来，跟主控说一声就行。',
          style: TextStyle(
            fontSize: PB.fsSm,
            color: PB.textSecondary,
            height: 1.6,
          ),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(ctx, false),
            child: const Text('取消'),
          ),
          FilledButton(
            style: FilledButton.styleFrom(backgroundColor: PB.danger),
            onPressed: () => Navigator.pop(ctx, true),
            child: const Text('移出'),
          ),
        ],
      ),
    );
    if (ok != true || !context.mounted) return;
    await state.removeBotFromRoom(room.id, bot.id);
    if (!context.mounted) return;
    ScaffoldMessenger.maybeOf(context)
        ?.showSnackBar(SnackBar(content: Text('已把 ${bot.name} 移出这个群')));
  }
}

class _MemberRow extends StatelessWidget {
  const _MemberRow({
    required this.bot,
    required this.isLead,
    required this.canRemove,
    required this.onRemove,
  });

  final Bot? bot;
  final bool isLead;
  final bool canRemove;
  final VoidCallback onRemove;

  @override
  Widget build(BuildContext context) {
    final b = bot;
    if (b == null) return const SizedBox.shrink();
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 3),
      child: Row(
        children: [
          BlobAvatar(
            seed: b.id,
            color: PB.colorFor(b.id),
            size: 30,
            animate: false,
            followPointer: false,
          ),
          const SizedBox(width: 10),
          Expanded(
            child: Text(
              b.name,
              style: const TextStyle(fontSize: PB.fsSm, color: PB.textPrimary),
            ),
          ),
          if (isLead)
            const Padding(
              padding: EdgeInsets.only(right: 8),
              child: Text(
                '负责人',
                style: TextStyle(fontSize: PB.fsXxs, color: PB.textQuaternary),
              ),
            ),
          if (canRemove)
            TextButton(
              onPressed: onRemove,
              child: const Text(
                '移除',
                style: TextStyle(fontSize: PB.fsXs, color: PB.danger),
              ),
            ),
        ],
      ),
    );
  }
}
