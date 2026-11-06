import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../models.dart';
import '../scope.dart';
import '../l10n/l10n.dart';
import '../theme.dart';
import '../window_chrome.dart';
import 'toast.dart';
import 'attachment_view.dart';
import 'blob_avatar.dart';
import 'bot_run_section.dart';
import 'bot_appearance_section.dart';

/// 点聊天顶部的胶囊 → 从右边滑出来的面板。
///
/// 放什么进去的原则：**只放"这一屏聊天里看不到、但你会想问"的东西** ——
/// 这个会话是谁、里面有谁、上下文用得怎么样。
/// 不堆功能入口（那些归「…」菜单），面板一挤就没人看了。
///
/// 群聊多一个「成员」页：那是唯一能**把某个 bot 移出群**的地方，
/// 所以要给它一个显眼的位置。
/// 窄屏（手机）用：面板作为一整页滑进来。
/// 宽屏不要用这个 —— 那边它是**布局里的一栏**（见 HomeShell），
/// 不该有遮罩、也不该盖住聊天，应与其他区域同级，而不是有遮罩的二级菜单。
Future<void> showRoomPanel(BuildContext context, Room room) async {
  await Navigator.of(context).push(
    PageRouteBuilder(
      opaque: false,
      barrierColor: Colors.black.withValues(alpha: 0.35),
      pageBuilder: (ctx, _, __) => WindowChromeRegion(
        leading: false,
        trailing: true,
        child: RoomPanel(room: room, width: 380),
      ),
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
  /// 0 = 详情，1 = 资料库，2 = 成员（只有群才有），3 = 记忆。
  ///
  /// ★ 真正的值存在 AppState 里并落盘 —— 面板会随会话切换重新挂载，
  ///   放本地的话用户点开「资料库」、切个会话回来就又跳回「详情」了。
  int get _tab => AppScope.read(context).panelTab;

  void _selectTab(int i) {
    // 面板重挂载后要立刻用新 tab 渲染，所以这里同时 setState + 落盘
    setState(() {});
    AppScope.read(context).savePanelTab(i);
  }

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
    // 越界兜底：tab 数是按会话变的（只有群才有「成员」），
    // 在群里停在「成员」、切到私聊时要夹回合法范围，否则 switch 会落到 default。
    final tabCount = isGroup ? 4 : 3;
    final tab = _tab.clamp(0, tabCount - 1);

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
              _tabs(context, isGroup, tab),
              Container(height: 1, color: PB.borderTertiary),
              Expanded(
                child: switch (tab) {
                  0 => _detail(context, room, ctxInfo),
                  1 => _Library(room: room),
                  2 when isGroup => _members(context, room),
                  _ => _MemoryTab(room: room),
                },
              ),
            ],
          ),
        ),
      ),
    );
  }

  Widget _header(BuildContext context, Room room) {
    final s = L10n.s(context);
    final lead = room.leadName;
    final bot = _primaryBot(room);
    return ChromeSafeHeader(
      child: AvatarHoverScope(
        child: Stack(
          children: [
            const Positioned.fill(child: WindowDragArea()),
            Padding(
              padding: const EdgeInsets.fromLTRB(18, 18, 10, 14),
              child: Column(
                children: [
                  Align(
                    alignment: Alignment.centerRight,
                    child: IconButton(
                      tooltip: s.t('common.close'),
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
                    GroupBlobAvatar(
                      seeds: room.botIds,
                      size: 64,
                      animate: false,
                    )
                  else
                    BlobAvatar(
                      seed: room.botIds.isNotEmpty
                          ? room.botIds.first
                          : room.id,
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
                  if (!room.isGroup && bot != null) ...[
                    const SizedBox(height: 12),
                    BotAppearanceSection(key: ValueKey(bot.id), bot: bot),
                  ],
                  if (room.topic.isNotEmpty) ...[
                    const SizedBox(height: 6),
                    Text(
                      room.topic,
                      textAlign: TextAlign.center,
                      maxLines: 3,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(
                        fontSize: PB.fsXs,
                        color: PB.textQuaternary,
                        height: 1.5,
                      ),
                    ),
                  ],
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _tabs(BuildContext context, bool isGroup, int active) {
    final s = L10n.s(context);
    final tabs = <String>[
      s.t('room.tab.detail'),
      s.t('room.tab.library'),
      if (isGroup) s.t('room.tab.members'),
      s.t('room.tab.memory'),
    ];
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 18),
      child: Row(
        children: [
          for (var i = 0; i < tabs.length; i++)
            Padding(
              padding: const EdgeInsets.only(right: 8),
              child: InkWell(
                borderRadius: BorderRadius.circular(PB.rFull),
                onTap: () => _selectTab(i),
                child: Container(
                  padding: const EdgeInsets.symmetric(
                    horizontal: 14,
                    vertical: 6,
                  ),
                  decoration: BoxDecoration(
                    color: active == i ? PB.bgActive : Colors.transparent,
                    borderRadius: BorderRadius.circular(PB.rFull),
                  ),
                  child: Text(
                    tabs[i],
                    style: TextStyle(
                      fontSize: PB.fsXs,
                      color: active == i ? PB.textPrimary : PB.textTertiary,
                    ),
                  ),
                ),
              ),
            ),
        ],
      ),
    );
  }

  Widget _detail(BuildContext context, Room room, ContextInfo? ctx) {
    final s = L10n.s(context);
    String k(int n) => n >= 1000 ? '${(n / 1000).round()}k' : '$n';
    return SingleChildScrollView(
      padding: const EdgeInsets.fromLTRB(18, 16, 18, 24),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          if (room.isGroup) ...[
            _row(s.t('room.field.kind'), s.t('room.kind.group')),
            _row(
              s.t('room.field.members'),
              s.tf('room.members', {'n': room.botIds.length}),
            ),
            _row(s.t('room.field.lead'), room.leadName ?? '—'),
          ] else
            _row(s.t('room.field.kind'), s.t('room.kind.dm')),
          if (room.lastMessageAt > 0)
            _row(s.t('room.field.lastMessage'), _timeText(room.lastMessageAt)),
          _row(s.t('room.field.messageCount'), '${room.messageCount}'),
          if (ctx != null && ctx.known)
            _row(
              s.t('room.field.context'),
              '${k(ctx.tokens ?? 0)} / ${k(ctx.contextWindow ?? 0)}'
              '（${(ctx.percent ?? 0).round()}%）'
              '${ctx.compacting ? ' · ${s.t('room.compacting')}' : ''}',
            ),
          // ★ 运行参数只在**私聊**里给。
          //
          //   模型 / 思考等级 / 上下文预算都是 **bot 自己的属性**，不是房间的
          //   （Room 上根本没有这些字段）。群聊里有 6 个人，这里只显示负责人
          //   一个人的参数，语义就错了两处：
          //     · 用户以为在调"这个群的模型"，实际改的是负责人这个人在
          //       **所有会话**（包括它自己的私聊）的配置；
          //     · 另外 5 个人的参数完全看不到，也不知道在哪调。
          //
          //   群里要调成员参数，去「成员」页 —— 那里按人列，一行一个人才对。
          if (!room.isGroup) ...[
            if (_primaryBot(room) case final bot?) BotRunSection(bot: bot),
          ],
        ],
      ),
    );
  }

  /// 这个会话里“说了算”的那个 bot：私聊是唯一成员，群聊是负责人
  Bot? _primaryBot(Room room) {
    final state = AppScope.of(context);
    final id = room.isGroup
        ? (room.leadBotId ?? room.botIds.firstOrNull)
        : room.botIds.firstOrNull;
    return id == null ? null : state.botById(id);
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
            style: TextStyle(fontSize: PB.fsXs, color: PB.textTertiary),
          ),
        ),
        Expanded(
          child: Text(
            value,
            style: TextStyle(
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
    final s = L10n.s(context);
    final state = AppScope.of(context);
    // 花名册里还没进来的
    final outsiders = state.bots
        .where((b) => !room.botIds.contains(b.id))
        .toList();
    return ListView(
      padding: const EdgeInsets.fromLTRB(10, 8, 10, 24),
      children: [
        // 说明模型为什么不在这个页面调：它属于人，不属于群。
        // 不写这一句，用户会去详情页找"群的模型"—— 那里现在没有了。
        if (room.isGroup)
          Padding(
            padding: const EdgeInsets.fromLTRB(6, 2, 6, 10),
            child: Text(
              s.t('room.membersModelHint'),
              style: TextStyle(
                fontSize: PB.fsXxs,
                color: PB.textQuaternary,
                height: 1.5,
              ),
            ),
          ),
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
    final s = L10n.s(context);
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
              s.tf('room.addWho', {'room': room.name}),
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
                      decoration: InputDecoration(
                        isDense: true,
                        hintText: s.t('room.searchMembers'),
                      ),
                    ),
                    const SizedBox(height: 8),
                  ],
                  Flexible(
                    child: shown.isEmpty
                        ? Padding(
                            padding: const EdgeInsets.symmetric(vertical: 18),
                            child: Text(
                              s.t('room.noMatch'),
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
                                          style: TextStyle(
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
                child: Text(s.t('common.cancel')),
              ),
              FilledButton(
                onPressed: picked.isEmpty
                    ? null
                    : () => Navigator.pop(ctx, true),
                child: Text(
                  picked.isEmpty
                      ? s.t('common.add')
                      : s.tf('room.addN', {'n': picked.length}),
                ),
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
    toast(context, s.tf('room.added', {'room': room.name}));
  }

  Future<void> _confirmRemove(BuildContext context, Room room, Bot? bot) async {
    if (bot == null) return;
    final s = L10n.s(context);
    final state = AppScope.read(context);
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        backgroundColor: PB.bgElevated,
        title: Text(
          s.tf('room.removeTitle', {
            'name': '${bot.emoji ?? ''}${bot.name}',
            'room': room.name,
          }),
          style: const TextStyle(fontSize: PB.fsLg),
        ),
        content: Text(
          s.t('room.removeBody'),
          style: TextStyle(
            fontSize: PB.fsSm,
            color: PB.textSecondary,
            height: 1.6,
          ),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(ctx, false),
            child: Text(s.t('common.cancel')),
          ),
          FilledButton(
            style: FilledButton.styleFrom(backgroundColor: PB.danger),
            onPressed: () => Navigator.pop(ctx, true),
            child: Text(s.t('room.remove')),
          ),
        ],
      ),
    );
    if (ok != true || !context.mounted) return;
    await state.removeBotFromRoom(room.id, bot.id);
    if (!context.mounted) return;
    toast(context, s.tf('room.removed', {'name': bot.name}));
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
    final s = L10n.s(context);
    final b = bot;
    if (b == null) return const SizedBox.shrink();
    return AvatarHoverScope(
      child: Padding(
        padding: const EdgeInsets.symmetric(vertical: 3),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Row(
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
                    style: TextStyle(
                      fontSize: PB.fsSm,
                      color: PB.textPrimary,
                    ),
                  ),
                ),
                if (isLead)
                  Padding(
                    padding: const EdgeInsets.only(right: 8),
                    child: Text(
                      s.t('room.lead'),
                      style: TextStyle(
                        fontSize: PB.fsXxs,
                        color: PB.textQuaternary,
                      ),
                    ),
                  ),
                if (canRemove)
                  TextButton(
                    onPressed: onRemove,
                    child: Text(
                      s.t('common.remove'),
                      style: const TextStyle(
                        fontSize: PB.fsXs,
                        color: PB.danger,
                      ),
                    ),
                  ),
              ],
            ),
            Padding(
              padding: const EdgeInsets.only(left: 40, top: 6, bottom: 10),
              child: BotAppearanceSection(key: ValueKey(b.id), bot: b),
            ),
          ],
        ),
      ),
    );
  }
}

/// 「添加成员」：一条虚位以待的按钮 —— 不抢成员行的视觉权重，
/// 但一眼能看出"这里还能加人"（自己加 bot，不用先跟主控说）。
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
    final s = L10n.s(context);
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
              color: enabled && _hover ? PB.borderSecondary : PB.borderTertiary,
            ),
          ),
          child: Row(
            mainAxisAlignment: MainAxisAlignment.center,
            children: [
              Icon(LucideIcons.plus, size: 15, color: fg),
              const SizedBox(width: 7),
              Text(
                enabled ? s.t('room.addMember') : s.t('room.allMembersAdded'),
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
/// 为什么值得单独一栏：聊到第三天，要找的是"上周那份 PPT 在哪"，
/// 而不是"翻聊天记录一行行找"。附件是这条对话流里最容易丢的东西 ——
/// 消息会被刷走，资料不该。
///
/// 数据不用服务端帮忙：附件本来就挂在每条消息上（msg.attachments），
/// 按作者是不是人分两组就行。
class _Library extends StatefulWidget {
  const _Library({required this.room});

  final Room room;

  @override
  State<_Library> createState() => _LibraryState();
}

class _LibraryState extends State<_Library> {
  /// 正在勾选的附件 id。非空 = 处于「选择模式」。
  ///
  /// 选择模式不是一开始就开着：平时列表就该能直接点开文件。
  /// 只有用户主动点了右上角的选择按钮（或长按某一行）才进入，
  /// 这时每行左边出现勾选框，顶部出现「全选 / 删除 / 取消」。
  final Set<String> _selected = {};
  bool _selecting = false;

  void _toggleSelecting() {
    setState(() {
      _selecting = !_selecting;
      if (!_selecting) _selected.clear();
    });
  }

  void _toggle(String id) {
    setState(() {
      if (!_selected.remove(id)) _selected.add(id);
    });
  }

  Future<void> _deleteOne(BuildContext context, Attachment a) async {
    final s = L10n.s(context);
    final state = AppScope.of(context);
    final ok = await _confirm(
      context,
      title: s.t('room.deleteFileTitle'),
      body: s.tf('room.deleteFileBody', {'name': a.name}),
    );
    if (!ok) return;
    final n = await state.deleteAttachments([a.id]);
    if (context.mounted) {
      _toast(context, n > 0 ? s.t('room.deletedOne') : s.t('room.deleteFailed'));
    }
  }

  Future<void> _deleteSelected(BuildContext context) async {
    if (_selected.isEmpty) return;
    final s = L10n.s(context);
    final state = AppScope.of(context);
    final ids = _selected.toList();
    final ok = await _confirm(
      context,
      title: s.t('room.deleteFilesTitle'),
      body: s.tf('room.deleteFilesBody', {'n': '${ids.length}'}),
    );
    if (!ok) return;
    final n = await state.deleteAttachments(ids);
    if (!context.mounted) return;
    setState(() {
      _selected.clear();
      _selecting = false;
    });
    _toast(
      context,
      n > 0 ? s.tf('room.deletedMany', {'n': '$n'}) : s.t('room.deleteFailed'),
    );
  }

  /// 删除不可逆，必须问一次。用站内对话框而不是系统弹窗，样式才一致。
  Future<bool> _confirm(
    BuildContext context, {
    required String title,
    required String body,
  }) async {
    final s = L10n.s(context);
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        backgroundColor: PB.bgElevated,
        title: Text(title, style: const TextStyle(fontSize: PB.fsLg)),
        content: SizedBox(
          width: 360,
          child: Text(
            body,
            style: TextStyle(
              fontSize: PB.fsSm,
              color: PB.textSecondary,
              height: 1.6,
            ),
          ),
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

  void _toast(BuildContext context, String text) {
    ScaffoldMessenger.maybeOf(context)?.showSnackBar(
      SnackBar(content: Text(text), duration: const Duration(seconds: 2)),
    );
  }

  @override
  Widget build(BuildContext context) {
    final s = L10n.s(context);
    final state = AppScope.of(context);
    final msgs = state.messages[widget.room.id] ?? const <Msg>[];

    // 谁给的：用户发的 / bot 产出的。倒序遍历 —— 新的排在前面。
    final fromUser = <Attachment>[];
    final fromBot = <Attachment>[];
    for (final m in msgs.reversed) {
      if (m.attachments.isEmpty) continue;
      (m.isUser ? fromUser : fromBot).addAll(m.attachments);
    }

    if (fromUser.isEmpty && fromBot.isEmpty) {
      return Center(
        child: Padding(
          padding: const EdgeInsets.all(24),
          child: Text(
            s.t('room.noFiles'),
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

    final allCount = fromUser.length + fromBot.length;
    return Column(
      children: [
        if (allCount > 1) _toolbar(context, s, allCount),
        Expanded(
          child: ListView(
            padding: const EdgeInsets.fromLTRB(14, 10, 14, 24),
            children: [
              if (fromUser.isNotEmpty) ...[
                _groupTitle(s.t('room.fromUser'), fromUser.length),
                for (final a in fromUser) _item(context, a),
                const SizedBox(height: 16),
              ],
              if (fromBot.isNotEmpty) ...[
                _groupTitle(s.t('room.fromBot'), fromBot.length),
                for (final a in fromBot) _item(context, a),
              ],
            ],
          ),
        ),
      ],
    );
  }

  Widget _toolbar(BuildContext context, AppStrings s, int total) {
    if (!_selecting) {
      return Padding(
        padding: const EdgeInsets.fromLTRB(14, 8, 8, 0),
        child: Row(
          children: [
            const Spacer(),
            TextButton.icon(
              key: const ValueKey('library-select'),
              onPressed: _toggleSelecting,
              icon: const Icon(LucideIcons.listChecks, size: 14),
              label: Text(
                s.t('room.select'),
                style: const TextStyle(fontSize: PB.fsXs),
              ),
              style: TextButton.styleFrom(
                foregroundColor: PB.textTertiary,
                visualDensity: VisualDensity.compact,
              ),
            ),
          ],
        ),
      );
    }

    final allSelected = _selected.length == total;
    return Padding(
      padding: const EdgeInsets.fromLTRB(8, 6, 8, 0),
      child: Row(
        children: [
          TextButton(
            key: const ValueKey('library-select-all'),
            onPressed: () => setState(() {
              if (allSelected) {
                _selected.clear();
              } else {
                _selected.addAll(_allIds());
              }
            }),
            style: TextButton.styleFrom(
              visualDensity: VisualDensity.compact,
              foregroundColor: PB.textSecondary,
            ),
            child: Text(
              allSelected ? s.t('room.unselectAll') : s.t('room.selectAll'),
              style: const TextStyle(fontSize: PB.fsXs),
            ),
          ),
          Text(
            s.tf('room.selectedCount', {'n': '${_selected.length}'}),
            style: TextStyle(fontSize: PB.fsXxs, color: PB.textQuaternary),
          ),
          const Spacer(),
          TextButton(
            key: const ValueKey('library-delete'),
            onPressed: _selected.isEmpty ? null : () => _deleteSelected(context),
            style: TextButton.styleFrom(
              visualDensity: VisualDensity.compact,
              foregroundColor: PB.danger,
            ),
            child: Text(
              s.t('common.delete'),
              style: const TextStyle(fontSize: PB.fsXs),
            ),
          ),
          IconButton(
            key: const ValueKey('library-cancel'),
            tooltip: s.t('common.cancel'),
            visualDensity: VisualDensity.compact,
            onPressed: _toggleSelecting,
            icon: Icon(LucideIcons.x, size: 14, color: PB.textTertiary),
          ),
        ],
      ),
    );
  }

  List<String> _allIds() {
    final state = AppScope.of(context);
    final msgs = state.messages[widget.room.id] ?? const <Msg>[];
    final ids = <String>[];
    for (final m in msgs) {
      for (final a in m.attachments) {
        ids.add(a.id);
      }
    }
    return ids;
  }

  Widget _groupTitle(String text, int n) => Padding(
    padding: const EdgeInsets.only(bottom: 8),
    child: Text(
      '$text（$n）',
      style: TextStyle(
        fontSize: PB.fsXxs,
        fontWeight: FontWeight.w600,
        color: PB.textTertiary,
      ),
    ),
  );

  Widget _item(BuildContext context, Attachment a) {
    final s = L10n.s(context);
    final state = AppScope.of(context);
    final url = state.fileUrl(a.id);
    final picked = _selected.contains(a.id);

    // 选择模式下点整行 = 勾选，不再打开文件 ——
    // 否则用户想勾选却每次都跳去预览，很容易误操作。
    void onTap() {
      if (_selecting) {
        _toggle(a.id);
        return;
      }
      if (url == null) return;
      if (a.isImage) {
        showImageViewer(context, url, a.name);
      } else {
        openAttachmentByBestRoute(context, a, url);
      }
    }

    return Padding(
      padding: const EdgeInsets.only(bottom: 4),
      child: InkWell(
        borderRadius: BorderRadius.circular(PB.rLg),
        onTap: onTap,
        onLongPress: _selecting
            ? null
            : () => setState(() {
                _selecting = true;
                _selected.add(a.id);
              }),
        child: Container(
          padding: const EdgeInsets.fromLTRB(10, 8, 6, 8),
          decoration: BoxDecoration(
            color: picked ? PB.colors(context).accentSoft : PB.bgActive,
            borderRadius: BorderRadius.circular(PB.rLg),
            border: Border.all(
              color: picked
                  ? PB.colors(context).accent.withValues(alpha: 0.45)
                  : PB.borderTertiary,
            ),
          ),
          child: Row(
            children: [
              if (_selecting) ...[
                Icon(
                  picked ? LucideIcons.squareCheck : LucideIcons.square,
                  size: 15,
                  color: picked
                      ? PB.colors(context).accentBright
                      : PB.textQuaternary,
                ),
                const SizedBox(width: 8),
              ] else ...[
                Icon(
                  a.isImage ? LucideIcons.image : LucideIcons.fileText,
                  size: 16,
                  color: PB.textTertiary,
                ),
                const SizedBox(width: 9),
              ],
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      a.name,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(
                        fontSize: PB.fsXs,
                        color: PB.textPrimary,
                      ),
                    ),
                    if (a.sizeText.isNotEmpty)
                      Text(
                        a.sizeText,
                        style: TextStyle(
                          fontSize: PB.fsXxs,
                          color: PB.textQuaternary,
                        ),
                      ),
                  ],
                ),
              ),
              if (!_selecting && url != null)
                IconButton(
                  tooltip: s.t('room.download'),
                  visualDensity: VisualDensity.compact,
                  onPressed: () =>
                      downloadAttachment(context, file: a, url: url),
                  icon: Icon(
                    LucideIcons.download,
                    size: 15,
                    color: PB.textTertiary,
                  ),
                ),
              if (!_selecting)
                IconButton(
                  key: ValueKey('library-delete-${a.id}'),
                  tooltip: s.t('common.delete'),
                  visualDensity: VisualDensity.compact,
                  onPressed: () => _deleteOne(context, a),
                  icon: Icon(
                    LucideIcons.trash2,
                    size: 15,
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

/// 私聊右侧「记忆」页：显示这个 bot 记住的东西（记忆摘要）。
/// 点摘要卡片进二级页面看全文；有新消息时提示摘要可能过期，可手动重新整理。
class _MemoryTab extends StatefulWidget {
  const _MemoryTab({required this.room});

  final Room room;

  @override
  State<_MemoryTab> createState() => _MemoryTabState();
}

class _MemoryTabState extends State<_MemoryTab> {
  MemorySummary? _data;
  bool _loading = true;
  bool _generating = false;

  /// 群聊：当前看的是哪个 bot 的记忆
  String? _botId;

  @override
  void initState() {
    super.initState();
    _botId = widget.room.isGroup
        ? (widget.room.leadBotId ?? widget.room.botIds.firstOrNull)
        : widget.room.botIds.firstOrNull;
    WidgetsBinding.instance.addPostFrameCallback((_) => _bootstrap());
  }

  Future<void> _bootstrap() async {
    final st = AppScope.read(context);
    final m = await st.loadMemory(widget.room.id, botId: _botId);
    if (!mounted) return;
    setState(() {
      _data = m;
      _loading = false;
    });
    // 第一次进来还没有摘要 → 自动整理一份（会调模型，几秒）
    if (m == null || m.isEmpty) {
      await _refresh();
    } else if (m.stale) {
      // 有新消息：后台悄悄补一份新的，界面先显示旧的（不用用户手动点）
      await _refresh(silent: true);
    }
  }

  Future<void> _refresh({bool silent = false}) async {
    if (_generating) return;
    if (!silent) setState(() => _generating = true);
    final st = AppScope.read(context);
    final m = await st.refreshMemory(widget.room.id, botId: _botId);
    if (!mounted) return;
    setState(() {
      _data = m;
      _generating = false;
    });
  }

  void _selectBot(String botId) {
    if (botId == _botId) return;
    setState(() {
      _botId = botId;
      _data = null;
      _loading = true;
    });
    _bootstrap();
  }

  String _ago(AppStrings s, int? ms) {
    if (ms == null || ms <= 0) return '';
    final d = DateTime.fromMillisecondsSinceEpoch(ms);
    final diff = DateTime.now().difference(d);
    if (diff.inMinutes < 1) return s.t('room.justNow');
    if (diff.inHours < 1) {
      return s.tf('room.minutesAgo', {'n': diff.inMinutes});
    }
    if (diff.inDays < 1) {
      return s.tf('room.hoursAgo', {'n': diff.inHours});
    }
    return s.tf('room.daysAgo', {'n': diff.inDays});
  }

  Future<void> _showFull(MemorySummary m) async {
    final s = L10n.s(context);
    final botName =
        AppScope.read(context).botById(_botId)?.name ?? widget.room.name;
    await showDialog<void>(
      context: context,
      builder: (ctx) => Dialog(
        backgroundColor: PB.bgPane,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(PB.r3xl),
          side: BorderSide(color: PB.borderSecondary),
        ),
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 640, maxHeight: 560),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Padding(
                padding: const EdgeInsets.fromLTRB(18, 14, 10, 10),
                child: Row(
                  children: [
                    Icon(
                      LucideIcons.fileText,
                      size: 15,
                      color: PB.textTertiary,
                    ),
                    const SizedBox(width: 8),
                    Expanded(
                      child: Text(
                        s.tf('room.memoryTitle', {'bot': botName}),
                        style: TextStyle(
                          fontSize: PB.fsSm,
                          fontWeight: FontWeight.w600,
                          color: PB.textPrimary,
                        ),
                      ),
                    ),
                    IconButton(
                      tooltip: s.t('common.close'),
                      onPressed: () => Navigator.of(ctx).pop(),
                      icon: const Icon(LucideIcons.x, size: 18),
                    ),
                  ],
                ),
              ),
              Container(height: 1, color: PB.borderTertiary),
              Flexible(
                child: SingleChildScrollView(
                  padding: const EdgeInsets.fromLTRB(18, 14, 18, 18),
                  child: SelectableText(
                    m.summary,
                    style: TextStyle(
                      fontSize: PB.fsSm,
                      height: 1.7,
                      color: PB.textPrimary,
                    ),
                  ),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final s = L10n.s(context);
    final m = _data;
    final state = AppScope.of(context);
    final bots = widget.room.botIds
        .map((id) => state.botById(id))
        .whereType<Bot>()
        .toList();
    return Padding(
      padding: const EdgeInsets.fromLTRB(18, 14, 18, 18),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          // 群聊：选择看哪个成员的记忆
          if (widget.room.isGroup && bots.length > 1) ...[
            Wrap(
              spacing: 6,
              runSpacing: 6,
              children: [
                for (final b in bots)
                  InkWell(
                    borderRadius: BorderRadius.circular(PB.rFull),
                    onTap: () => _selectBot(b.id),
                    child: Container(
                      padding: const EdgeInsets.fromLTRB(6, 4, 10, 4),
                      decoration: BoxDecoration(
                        color: b.id == _botId
                            ? PB.bgActive
                            : Colors.transparent,
                        borderRadius: BorderRadius.circular(PB.rFull),
                        border: Border.all(
                          color: b.id == _botId
                              ? PB.borderHighlight
                              : PB.borderTertiary,
                        ),
                      ),
                      child: Row(
                        mainAxisSize: MainAxisSize.min,
                        children: [
                          BlobAvatar(
                            seed: b.id,
                            color: PB.colorFor(b.id),
                            size: 16,
                            animate: false,
                          ),
                          const SizedBox(width: 5),
                          Text(
                            b.name,
                            style: TextStyle(
                              fontSize: PB.fsXxs,
                              color: b.id == _botId
                                  ? PB.textPrimary
                                  : PB.textTertiary,
                            ),
                          ),
                        ],
                      ),
                    ),
                  ),
              ],
            ),
            const SizedBox(height: 10),
          ],
          Row(
            children: [
              Icon(
                LucideIcons.fileText,
                size: 15,
                color: PB.textTertiary,
              ),
              const SizedBox(width: 8),
              Expanded(
                child: Text(
                  s.t('room.memory'),
                  style: TextStyle(
                    fontSize: PB.fsSm,
                    fontWeight: FontWeight.w600,
                    color: PB.textPrimary,
                  ),
                ),
              ),
              if (_generating)
                const SizedBox(
                  width: 15,
                  height: 15,
                  child: CircularProgressIndicator(strokeWidth: 1.6),
                )
              else
                IconButton(
                  tooltip: s.t('room.regenerate'),
                  onPressed: _refresh,
                  icon: const Icon(LucideIcons.refreshCw, size: 16),
                ),
            ],
          ),
          const SizedBox(height: 6),
          if (_loading && m == null)
            Padding(
              padding: const EdgeInsets.symmetric(vertical: 16),
              child: Text(
                s.t('room.readingMemory'),
                style: TextStyle(
                  fontSize: PB.fsXs,
                  color: PB.textQuaternary,
                ),
              ),
            )
          else if (m == null || m.isEmpty)
            Container(
              padding: const EdgeInsets.all(14),
              decoration: BoxDecoration(
                color: PB.bgActive,
                borderRadius: BorderRadius.circular(PB.rXl),
                border: Border.all(color: PB.borderTertiary),
              ),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    s.t('room.noMemory'),
                    style: TextStyle(
                      fontSize: PB.fsSm,
                      color: PB.textSecondary,
                    ),
                  ),
                  const SizedBox(height: 6),
                  Text(
                    s.t('room.memoryEmptyHint'),
                    style: TextStyle(
                      fontSize: PB.fsXs,
                      color: PB.textQuaternary,
                    ),
                  ),
                  const SizedBox(height: 12),
                  InkWell(
                    onTap: _generating ? null : _refresh,
                    borderRadius: BorderRadius.circular(PB.rXl),
                    child: Container(
                      padding: const EdgeInsets.symmetric(
                        horizontal: 12,
                        vertical: 8,
                      ),
                      decoration: BoxDecoration(
                        color: PB.bgElevated,
                        borderRadius: BorderRadius.circular(PB.rFull),
                        border: Border.all(color: PB.borderSecondary),
                      ),
                      child: Text(
                        _generating
                            ? s.t('room.generating')
                            : s.t('room.generateMemory'),
                        style: TextStyle(
                          fontSize: PB.fsXs,
                          color: PB.textSecondary,
                        ),
                      ),
                    ),
                  ),
                ],
              ),
            )
          else
            GestureDetector(
              onTap: () => _showFull(m),
              child: Container(
                padding: const EdgeInsets.all(14),
                decoration: BoxDecoration(
                  color: PB.bgActive,
                  borderRadius: BorderRadius.circular(PB.rXl),
                  border: Border.all(color: PB.borderTertiary),
                ),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      m.summary,
                      maxLines: 10,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(
                        fontSize: PB.fsXs,
                        height: 1.7,
                        color: PB.textPrimary,
                      ),
                    ),
                    const SizedBox(height: 12),
                    Row(
                      children: [
                        Expanded(
                          child: Text(
                            m.stale
                                ? s.t('room.memoryStale')
                                : s.tf('room.updatedAt', {
                                    'when': _ago(s, m.at),
                                  }),
                            style: TextStyle(
                              fontSize: PB.fsXxs,
                              color: m.stale
                                  ? PB.colors(context).accentBright
                                  : PB.textQuaternary,
                            ),
                          ),
                        ),
                        Text(
                          s.t('room.viewFull'),
                          style: TextStyle(
                            fontSize: PB.fsXxs,
                            color: PB.colors(context).accentBright,
                          ),
                        ),
                      ],
                    ),
                  ],
                ),
              ),
            ),
          if (m?.error != null && m!.error!.isNotEmpty) ...[
            const SizedBox(height: 8),
            Text(
              m.error!,
              style: const TextStyle(fontSize: PB.fsXxs, color: PB.danger),
            ),
          ],
        ],
      ),
    );
  }
}
