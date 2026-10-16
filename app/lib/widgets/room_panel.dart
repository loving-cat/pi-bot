import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../models.dart';
import '../scope.dart';
import '../theme.dart';
import 'attachment_view.dart';
import 'blob_avatar.dart';

/// 点聊天顶部的胶囊 → 从右边滑出来的面板。
///
/// 放什么进去的原则：**只放"这一屏聊天里看不到、但你会想问"的东西** ——
/// 这个会话是谁、里面有谁、上下文用得怎么样。
/// 不堆功能入口（那些归「…」菜单），面板一挤就没人看了。
///
/// 群聊多一个「成员」页：那是唯一能**把某个 bot 移出群**的地方，
/// 所以要给它一个显眼的位置（用户明确提过这个需求）。
/// 窄屏（手机）用：面板作为一整页滑进来。
/// 宽屏不要用这个 —— 那边它是**布局里的一栏**（见 HomeShell），
/// 不该有遮罩、也不该盖住聊天（用户："应该跟我其他区域同级别的侧边栏，
/// 而不是一个有遮罩的二级菜单"）。
Future<void> showRoomPanel(BuildContext context, Room room) async {
  await Navigator.of(context).push(
    PageRouteBuilder(
      opaque: false,
      barrierColor: Colors.black.withValues(alpha: 0.35),
      pageBuilder: (ctx, _, __) => RoomPanel(room: room, width: 380),
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

/// 面板本体（宽屏直接当布局的一栏用，窄屏包在路由里）。
class RoomPanel extends StatefulWidget {
  const RoomPanel({super.key, required this.room, this.width});

  final Room room;

  /// 给宽（null = 撑满可用宽度，宽屏当一栏时用）
  final double? width;

  @override
  State<RoomPanel> createState() => _RoomPanelState();
}

class _RoomPanelState extends State<RoomPanel> {
  /// 0 = 详情，1 = 资料库，2 = 成员（只有群才有）
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
          width: widget.width,
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
                child: switch (_tab) {
                  0 => _detail(room, ctxInfo),
                  1 => _Library(room: room),
                  _ => _members(context, room),
                },
              ),
            ],
          ),
        ),
      ),
    );
  }

  Widget _header(BuildContext context, Room room) {
    final lead = room.leadName;
    return AvatarHoverScope(child: Padding(
      padding: const EdgeInsets.fromLTRB(18, 18, 10, 14),
      child: Column(
        children: [
          Align(
            alignment: Alignment.centerRight,
            child: IconButton(
              tooltip: '关闭',
              // 宽屏是布局里的一栏 —— 关它要走 AppState；
              // 窄屏是路由 —— 关它是 pop。两个都做，哪条路都成立。
              onPressed: () {
                final st = AppScope.read(context);
                if (st.panelOpen) {
                  st.closePanel();
                } else {
                  Navigator.of(context).maybePop();
                }
              },
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
    ));
  }

  Widget _tabs(bool isGroup) {
    final tabs = <String>['详情', '资料库', if (isGroup) '成员'];
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
    // 花名册里还没进来的
    final outsiders =
        state.bots.where((b) => !room.botIds.contains(b.id)).toList();
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
        if (room.isGroup)
          Padding(
            padding: const EdgeInsets.only(top: 6),
            child: _AddMemberButton(
              // 还剩几个能加 —— 按钮上直说，省得点开才发现花名册里没人了
              remaining: outsiders.length,
              onTap: outsiders.isEmpty
                  ? null
                  : () => _addMembers(context, room, outsiders),
            ),
          ),
      ],
    );
  }

  /// 打开"加谁进来"：花名册里还没进来的，多选 + 一个添加入口。
  ///
  /// 为什么是对话框不是底部弹层：桌面上底部弹层是从屏幕最底下窜出来的，
  /// 离用户点的那一下太远（这个项目里已经因为这件事把所有弹层换掉过一轮）。
  Future<void> _addMembers(
    BuildContext context,
    Room room,
    List<Bot> candidates,
  ) async {
    final state = AppScope.read(context);
    final picked = <String>{};
    final q = TextEditingController();
    var query = '';

    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => StatefulBuilder(
        builder: (ctx, setLocal) {
          final shown = query.isEmpty
              ? candidates
              : candidates
                    .where(
                      (b) =>
                          b.name.toLowerCase().contains(query) ||
                          b.tagline.toLowerCase().contains(query),
                    )
                    .toList();
          return AlertDialog(
            backgroundColor: PB.bgElevated,
            title: Text(
              '往「${room.name}」里加谁',
              style: const TextStyle(fontSize: PB.fsLg),
            ),
            content: SizedBox(
              width: 380,
              child: Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  if (candidates.length > 6) ...[
                    TextField(
                      controller: q,
                      autofocus: true,
                      onChanged: (v) =>
                          setLocal(() => query = v.trim().toLowerCase()),
                      decoration: const InputDecoration(
                        isDense: true,
                        hintText: '按名字 / 职责找',
                      ),
                    ),
                    const SizedBox(height: 8),
                  ],
                  Flexible(
                    child: shown.isEmpty
                        ? const Padding(
                            padding: EdgeInsets.symmetric(vertical: 18),
                            child: Text(
                              '没找到符合条件的 bot',
                              style: TextStyle(
                                fontSize: PB.fsSm,
                                color: PB.textTertiary,
                              ),
                            ),
                          )
                        : ListView(
                            shrinkWrap: true,
                            children: [
                              for (final b in shown)
                                CheckboxListTile(
                                  dense: true,
                                  contentPadding: EdgeInsets.zero,
                                  value: picked.contains(b.id),
                                  onChanged: (v) => setLocal(
                                    () => v == true
                                        ? picked.add(b.id)
                                        : picked.remove(b.id),
                                  ),
                                  secondary: BlobAvatar(
                                    seed: b.id,
                                    color: PB.colorFor(b.id),
                                    emoji: b.emoji,
                                    size: 30,
                                    animate: false,
                                  ),
                                  title: Text(
                                    b.name,
                                    style: const TextStyle(fontSize: PB.fsSm),
                                  ),
                                  subtitle: b.tagline.trim().isEmpty
                                      ? null
                                      : Text(
                                          b.tagline.trim(),
                                          maxLines: 1,
                                          overflow: TextOverflow.ellipsis,
                                          style: const TextStyle(
                                            fontSize: PB.fsXs,
                                            color: PB.textTertiary,
                                          ),
                                        ),
                                ),
                            ],
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
                onPressed: picked.isEmpty
                    ? null
                    : () => Navigator.pop(ctx, true),
                child: Text(picked.isEmpty ? '添加' : '添加 ${picked.length} 个'),
              ),
            ],
          );
        },
      ),
    );

    q.dispose();
    if (ok != true || picked.isEmpty) return;
    await state.addBotsToRoom(room.id, picked.toList());
    if (!context.mounted) return;
    ScaffoldMessenger.maybeOf(context)?.showSnackBar(
      SnackBar(
        duration: const Duration(seconds: 2),
        content: Text('已加进「${room.name}」，下次说话它就接得上。'),
      ),
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
    return AvatarHoverScope(child: Padding(
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
    ));
  }
}

/// 「添加成员」：一条虚位以待的按钮 —— 不抢成员行的视觉权重，
/// 但一眼能看出"这里还能加人"（用户要的：自己加 bot，不用先跟主控说）。
class _AddMemberButton extends StatefulWidget {
  const _AddMemberButton({required this.remaining, this.onTap});

  /// 花名册里还剩几个没进来的（0 → 置灰并说明原因）
  final int remaining;
  final VoidCallback? onTap;

  @override
  State<_AddMemberButton> createState() => _AddMemberButtonState();
}

class _AddMemberButtonState extends State<_AddMemberButton> {
  bool _hover = false;

  @override
  Widget build(BuildContext context) {
    final enabled = widget.onTap != null;
    final fg = enabled
        ? (_hover ? PB.textPrimary : PB.textSecondary)
        : PB.textQuaternary;
    return MouseRegion(
      cursor: enabled ? SystemMouseCursors.click : SystemMouseCursors.basic,
      onEnter: (_) => setState(() => _hover = true),
      onExit: (_) => setState(() => _hover = false),
      child: GestureDetector(
        onTap: widget.onTap,
        child: Container(
          height: 40,
          decoration: BoxDecoration(
            color: enabled && _hover ? PB.bgHover : Colors.transparent,
            borderRadius: BorderRadius.circular(10),
            border: Border.all(
              color: enabled && _hover
                  ? PB.borderSecondary
                  : PB.borderTertiary,
            ),
          ),
          child: Row(
            mainAxisAlignment: MainAxisAlignment.center,
            children: [
              Icon(LucideIcons.plus, size: 15, color: fg),
              const SizedBox(width: 7),
              Text(
                enabled ? '添加成员' : '花名册里的人都在这儿了',
                style: TextStyle(fontSize: PB.fsSm, color: fg),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

/// 「资料库」：这个会话里出现过的**所有附件**，按"谁给的"分两组。
///
/// 为什么值得单独一栏：聊到第三天，用户要的是"上周那份 PPT 在哪"，
/// 而不是"翻聊天记录一行行找"。附件是这条对话流里最容易丢的东西 ——
/// 消息会被刷走，资料不该。
///
/// 数据不用服务端帮忙：附件本来就挂在每条消息上（msg.attachments），
/// 按作者是不是人分两组就行。
class _Library extends StatelessWidget {
  const _Library({required this.room});

  final Room room;

  @override
  Widget build(BuildContext context) {
    final state = AppScope.of(context);
    final msgs = state.messages[room.id] ?? const <Msg>[];

    // 谁给的：用户发的 / bot 产出的。倒序遍历 —— 新的排在前面。
    final fromUser = <Attachment>[];
    final fromBot = <Attachment>[];
    for (final m in msgs.reversed) {
      if (m.attachments.isEmpty) continue;
      (m.isUser ? fromUser : fromBot).addAll(m.attachments);
    }

    if (fromUser.isEmpty && fromBot.isEmpty) {
      return const Center(
        child: Padding(
          padding: EdgeInsets.all(24),
          child: Text(
            '这个会话里还没有文件。\n\n你发的、bot 产出的，都会收在这里。',
            textAlign: TextAlign.center,
            style: TextStyle(
              fontSize: PB.fsXs,
              color: PB.textQuaternary,
              height: 1.7,
            ),
          ),
        ),
      );
    }

    return ListView(
      padding: const EdgeInsets.fromLTRB(14, 12, 14, 24),
      children: [
        if (fromUser.isNotEmpty) ...[
          _groupTitle('你发的', fromUser.length),
          for (final a in fromUser) _item(context, a),
          const SizedBox(height: 16),
        ],
        if (fromBot.isNotEmpty) ...[
          _groupTitle('bot 产出的', fromBot.length),
          for (final a in fromBot) _item(context, a),
        ],
      ],
    );
  }

  Widget _groupTitle(String text, int n) => Padding(
    padding: const EdgeInsets.only(bottom: 8),
    child: Text(
      '$text（$n）',
      style: const TextStyle(
        fontSize: PB.fsXxs,
        fontWeight: FontWeight.w600,
        color: PB.textTertiary,
      ),
    ),
  );

  Widget _item(BuildContext context, Attachment a) {
    final state = AppScope.of(context);
    final url = state.fileUrl(a.id);
    return Padding(
      padding: const EdgeInsets.only(bottom: 4),
      child: InkWell(
        borderRadius: BorderRadius.circular(PB.rLg),
        // 图片直接看图，其他弹站内预览（都是消息里那套，行为一致）
        onTap: url == null
            ? null
            : () => a.isImage
                  ? showImageViewer(context, url, a.name)
                  : showFilePreview(context, file: a, url: url),
        child: Container(
          padding: const EdgeInsets.fromLTRB(10, 8, 6, 8),
          decoration: BoxDecoration(
            color: PB.bgActive,
            borderRadius: BorderRadius.circular(PB.rLg),
            border: Border.all(color: PB.borderTertiary),
          ),
          child: Row(
            children: [
              Icon(
                a.isImage ? LucideIcons.image : LucideIcons.fileText,
                size: 16,
                color: PB.textTertiary,
              ),
              const SizedBox(width: 9),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      a.name,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: const TextStyle(
                        fontSize: PB.fsXs,
                        color: PB.textPrimary,
                      ),
                    ),
                    if (a.sizeText.isNotEmpty)
                      Text(
                        a.sizeText,
                        style: const TextStyle(
                          fontSize: PB.fsXxs,
                          color: PB.textQuaternary,
                        ),
                      ),
                  ],
                ),
              ),
              // 下载就在这儿 —— 不用点进去再找
              if (url != null)
                IconButton(
                  tooltip: '下载',
                  visualDensity: VisualDensity.compact,
                  onPressed: () =>
                      downloadAttachment(context, file: a, url: url),
                  icon: const Icon(
                    LucideIcons.download,
                    size: 15,
                    color: PB.textTertiary,
                  ),
                ),
            ],
          ),
        ),
      ),
    );
  }
}
