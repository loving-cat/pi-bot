import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../app_state.dart';
import '../l10n/l10n.dart';
import '../models.dart';
import '../motion.dart';
import '../progress_messages.dart';
import '../scope.dart';
import '../theme.dart';
import 'blob_avatar.dart';
import 'conversation_people.dart';
import 'md_text.dart';

/// 聚合展示部门进度回执，点击查看完整回执明细。
class ProgressNotice extends StatelessWidget {
  const ProgressNotice({super.key, required this.messages});

  final List<Msg> messages;

  @override
  Widget build(BuildContext context) {
    if (messages.isEmpty) return const SizedBox.shrink();
    final state = AppScope.of(context);
    final strings = L10n.s(context);
    final senders = progressSenders(messages);
    final dept = _deptName(state, messages, strings);

    // ★ 私聊里不能说「收到谁的消息」。
    //
    //   私聊只有用户和这个 bot 两个人，而这些回执的作者就是它自己 ——
    //   于是「收到 竞品研究员 消息」变成了「收到自己的消息」，语义反了。
    //   这些消息的实质是「它在部门里交付了什么」，所以换成陈述式。
    final roomId = messages.first.roomId;
    final isDm =
        state.rooms.where((r) => r.id == roomId).firstOrNull?.kind == 'dm';

    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 6),
      child: Center(
        child: HoverTap(
          baseColor: Colors.transparent,
          hoverColor: PB.bgHover,
          pressColor: PB.bgActive,
          borderRadius: BorderRadius.circular(PB.rFull),
          onTap: () => showProgressPeek(context, messages: messages),
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 5),
            child: isDm
                ? Row(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      Icon(
                        LucideIcons.folderInput,
                        size: 12,
                        color: PB.textTertiary,
                      ),
                      const SizedBox(width: 5),
                      Text(
                        // ★ 必须带部门名。只说「在部门里」用户不知道是哪个部门 ——
                        //   bot 可能同时挂好几个部门。
                        strings.tf('dept.dmProgressIn', {
                          'dept': dept,
                          'n': messages.length,
                        }),
                        style: TextStyle(
                          fontSize: PB.fsXs,
                          color: PB.textTertiary,
                        ),
                      ),
                    ],
                  )
                : ConversationPeople(
                    prefix: strings.t('dept.received'),
                    people: senders,
                    fallback: strings.tf('misc.quoted', {'name': dept}),
                    suffix: strings.tf('dept.messageSuffix', {
                      'n': messages.length,
                    }),
                  ),
          ),
        ),
      ),
    );
  }
}

String _deptName(AppState state, List<Msg> messages, AppStrings strings) {
  final rid = (messages.first.meta?['fromRoomId'] as String?) ?? '';
  return state.rooms.where((r) => r.id == rid).firstOrNull?.name ??
      strings.t('dept.unknown');
}

String _fmtTime(int ms) {
  if (ms <= 0) return '';
  final d = DateTime.fromMillisecondsSinceEpoch(ms);
  final now = DateTime.now();
  String two(int n) => n.toString().padLeft(2, '0');
  final hm = '${two(d.hour)}:${two(d.minute)}';
  if (d.year == now.year && d.month == now.month && d.day == now.day) {
    return hm;
  }
  return '${two(d.month)}-${two(d.day)} $hm';
}

/// 二级界面：这条「收到 X 消息」背后的全部回执明细。
Future<void> showProgressPeek(
  BuildContext context, {
  required List<Msg> messages,
}) async {
  if (messages.isEmpty) return;
  final overlay = Overlay.maybeOf(context);
  if (overlay == null) return;

  late OverlayEntry entry;
  entry = OverlayEntry(
    builder: (ctx) =>
        _ProgressPeekLayer(messages: messages, onClose: () => entry.remove()),
  );
  overlay.insert(entry);
}

class _ProgressPeekLayer extends StatefulWidget {
  const _ProgressPeekLayer({required this.messages, required this.onClose});

  final List<Msg> messages;
  final VoidCallback onClose;

  @override
  State<_ProgressPeekLayer> createState() => _ProgressPeekLayerState();
}

class _ProgressPeekLayerState extends State<_ProgressPeekLayer>
    with SingleTickerProviderStateMixin {
  late final AnimationController _c = AnimationController(
    vsync: this,
    duration: Motion.slow,
  )..forward();

  @override
  void dispose() {
    _c.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final screen = MediaQuery.sizeOf(context);
    final w = (screen.width * 0.62).clamp(360.0, 680.0);
    final h = (screen.height * 0.74).clamp(320.0, 680.0);

    return Stack(
      children: [
        Positioned.fill(
          child: GestureDetector(
            behavior: HitTestBehavior.opaque,
            onTap: widget.onClose,
            child: AnimatedBuilder(
              animation: _c,
              builder: (context, _) => Container(
                color: Colors.black.withValues(alpha: 0.55 * _c.value),
              ),
            ),
          ),
        ),
        Center(
          child: AnimatedBuilder(
            animation: _c,
            child: _card(w, h),
            builder: (context, child) {
              final t = Motion.inC.transform(_c.value);
              return Opacity(
                opacity: t,
                child: Transform.scale(scale: 0.96 + 0.04 * t, child: child),
              );
            },
          ),
        ),
      ],
    );
  }

  Widget _card(double w, double h) {
    final strings = L10n.s(context);
    final state = AppScope.of(context);
    final senders = progressSenders(widget.messages);
    final dept = _deptName(state, widget.messages, strings);
    // 私聊里回执的作者就是会话对象自己，
    // 说「收到它的消息」等于说「收到自己的消息」。
    final roomId = widget.messages.first.roomId;
    final isDm =
        state.rooms.where((r) => r.id == roomId).firstOrNull?.kind == 'dm';

    return Material(
      type: MaterialType.transparency,
      child: SizedBox(
        width: w,
        height: h,
        child: Container(
          decoration: BoxDecoration(
            color: PB.bgPane,
            borderRadius: BorderRadius.circular(PB.r3xl),
            border: Border.all(color: PB.borderSecondary),
            boxShadow: [
              BoxShadow(
                color: Colors.black.withValues(alpha: 0.6),
                blurRadius: 40,
                offset: const Offset(0, 16),
              ),
            ],
          ),
          child: Column(
            children: [
              Padding(
                padding: const EdgeInsets.fromLTRB(16, 12, 8, 12),
                child: Row(
                  children: [
                    Icon(LucideIcons.inbox, size: 15, color: PB.textTertiary),
                    const SizedBox(width: 8),
                    Expanded(
                      child: Text(
                        // 私聊里同样不能说「收到谁的消息」——
                        // 那些回执的作者就是会话对象自己。
                        isDm
                            ? strings.tf('dept.dmProgressMore', {'dept': dept})
                            : (senders.isEmpty
                                  ? strings.tf('dept.fromRoom', {'room': dept})
                                  : strings.tf('dept.fromPeople', {
                                      'names': senders
                                          .map((s) => s.name)
                                          .join(
                                            strings.t('misc.listSeparator'),
                                          ),
                                    })),
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: TextStyle(
                          fontSize: PB.fsSm,
                          fontWeight: FontWeight.w600,
                          color: PB.textPrimary,
                        ),
                      ),
                    ),
                    HoverIconButton(
                      icon: LucideIcons.x,
                      tooltip: strings.t('common.close'),
                      onTap: widget.onClose,
                    ),
                  ],
                ),
              ),
              Container(height: 1, color: PB.borderTertiary),
              Expanded(
                child: ListView(
                  padding: const EdgeInsets.fromLTRB(16, 14, 16, 10),
                  children: _threads(state, widget.messages),
                ),
              ),
              Container(height: 1, color: PB.borderTertiary),
              Padding(
                padding: const EdgeInsets.symmetric(vertical: 10),
                child: Center(
                  child: HoverTap(
                    baseColor: PB.bgElevated,
                    hoverColor: PB.bgHover,
                    pressColor: PB.bgActive,
                    borderRadius: BorderRadius.circular(PB.rFull),
                    onTap: widget.onClose,
                    child: Padding(
                      padding: const EdgeInsets.symmetric(
                        horizontal: 20,
                        vertical: 8,
                      ),
                      child: Text(
                        strings.t('common.close'),
                        style: TextStyle(
                          fontSize: PB.fsSm,
                          color: PB.textSecondary,
                        ),
                      ),
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

  /// 把一批回执按「谁在回应谁」排成线程。
  ///
  /// 平铺成一排独立卡片时，读的人找不出谁在接谁的话 —— 那看起来像
  /// 播报。有引用关系就缩进一层，视觉上就是「A 说 → B 接」的对话。
  List<Widget> _threads(AppState state, List<Msg> messages) {
    return [
      for (final entry in threadLayout(messages))
        _receipt(state, entry.message, depth: entry.depth),
    ];
  }

  Widget _receipt(AppState state, Msg m, {int depth = 0}) {
    final fromName = ((m.meta?['fromName'] as String?) ?? '').trim();
    final dept = _deptName(state, [m], L10n.s(context));
    final result = progressResult(m);
    final resultColor = switch (result) {
      ProgressResult.success => PB.success,
      ProgressResult.failure => PB.danger,
      _ => PB.textQuaternary,
    };
    // ★ 卡片头部显示「谁说的」，也就是这条消息的作者。
    //
    //   原来用 meta.fromName（派活人），于是每条都写着负责人的名字，
    //   正文明明是成员交的活 —— 读者会以为是负责人自己在汇报。
    //   派活人改在下面一行用「↳ 派给」标出来。
    final who = m.authorName.trim().isNotEmpty ? m.authorName.trim() : dept;
    final author = m.authorId ?? m.authorName;
    // 副标题：部门；如果这条是别人派的活，再标一句「派给」。
    // ★ 方向别写反：who 是干活的（作者），fromName 是派活的。
    //   写「派给 fromName」等于说 fromName 是接收方，正好搞反了。
    final subline = fromName.isNotEmpty && fromName != who
        ? '$dept · 由 $fromName 派'
        : dept;

    final body = Padding(
      padding: const EdgeInsets.only(bottom: 14),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              // 头像跟着作者走：颜色和名字必须同源，
              // 否则会出现「名字是成员、头像颜色是负责人」的错位。
              BlobAvatar(
                seed: author,
                color: PB.colorFor(author),
                size: 18,
                animate: false,
              ),
              const SizedBox(width: 7),
              Expanded(
                child: Tooltip(
                  message: who,
                  child: Text(
                    who,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: TextStyle(
                      fontSize: PB.fsXs,
                      fontWeight: FontWeight.w600,
                      color: PB.textSecondary,
                    ),
                  ),
                ),
              ),
              const SizedBox(width: 8),
              Container(
                padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 1),
                decoration: BoxDecoration(
                  color: resultColor.withValues(alpha: 0.12),
                  borderRadius: BorderRadius.circular(PB.rFull),
                ),
                child: Text(
                  progressResultLabel(result),
                  style: TextStyle(fontSize: PB.fsXxs, color: resultColor),
                ),
              ),
            ],
          ),
          const SizedBox(height: 4),
          Row(
            children: [
              Expanded(
                child: Tooltip(
                  message: subline,
                  child: Text(
                    subline,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: TextStyle(
                      fontSize: PB.fsXxs,
                      color: PB.textQuaternary,
                    ),
                  ),
                ),
              ),
              const SizedBox(width: 8),
              Text(
                _fmtTime(m.createdAt),
                style: TextStyle(fontSize: PB.fsXxs, color: PB.textQuaternary),
              ),
            ],
          ),
          const SizedBox(height: 6),
          Container(
            width: double.infinity,
            padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 9),
            decoration: BoxDecoration(
              color: PB.bgBubble,
              borderRadius: BorderRadius.circular(PB.rXl),
              border: Border.all(color: PB.borderTertiary),
            ),
            child: MdText(
              m.text,
              selectable: true,
              compact: true,
              mentions: const [],
              style: TextStyle(
                fontSize: PB.fsXs,
                height: 1.5,
                color: PB.textPrimary,
              ),
            ),
          ),
        ],
      ),
    );

    // ★ 有引用关系就缩进一层，并在左侧画一条竖线。
    //   这是「A 说 → B 接」的唯一视觉依据；不缩进的话，
    //   读者只能看到两张并列的卡片，读不出因果关系。
    if (depth == 0) return body;
    // ★ 用边框画竖线，不要用 IntrinsicHeight + Row(stretch)。
    //
    //   MdText 渲染表格时内部是 LayoutBuilder，而 LayoutBuilder 的
    //   computeMaxIntrinsicHeight 直接抛 "does not support returning
    //   intrinsic dimensions"：debug 下红屏，release 下返回 0 把整块
    //   高度压扁、内容溢出。而且 intrinsic 是 O(N²) 级布局代价。
    //
    //   Border 跟着容器高度走，零额外代价，也不怕表格。
    return Padding(
      padding: EdgeInsets.only(left: 18.0 * depth),
      child: DecoratedBox(
        decoration: BoxDecoration(
          border: Border(
            left: BorderSide(color: PB.borderSecondary, width: 2),
          ),
        ),
        child: Padding(
          padding: const EdgeInsets.only(left: 10),
          child: body,
        ),
      ),
    );
  }
}

/// 一条回执在弹窗里的位置：消息本身 + 缩进层级。
class ThreadEntry {
  const ThreadEntry(this.message, this.depth);
  final Msg message;
  final int depth;
}

/// 把一批回执按「谁在回应谁」排成线程（纯函数，便于测试）。
///
/// 平铺成一排独立卡片时，读的人找不出谁在接谁的话 —— 那看起来像播报。
/// 有引用关系就缩进一层，视觉上就是「A 说 → B 接」的对话。
///
/// ★ 必须记已渲染的 id：如果有人把两条消息互相标成"在回应对方"
///   （A.re=B 且 B.re=A），它们都进不了 roots（各自都有 re），
///   于是永远不会被渲染 —— 弹窗少几条，而且没有任何报错。
///   实测纯循环时两条消息会渲染出 0 条。宁可平铺，也不能让消息消失。
List<ThreadEntry> threadLayout(List<Msg> messages) {
  final byId = <String, Msg>{for (final m in messages) m.id: m};
  final childrenOf = <String, List<Msg>>{};
  final roots = <Msg>[];
  for (final m in messages) {
    final re = m.replyToId;
    if (re != null && byId.containsKey(re) && re != m.id) {
      childrenOf.putIfAbsent(re, () => []).add(m);
    } else {
      roots.add(m);
    }
  }

  final out = <ThreadEntry>[];
  final emitted = <String>{};
  void emit(Msg m, int depth) {
    if (!emitted.add(m.id)) return;
    out.add(ThreadEntry(m, depth));
    for (final child in childrenOf[m.id] ?? const <Msg>[]) {
      // 缩进最多两层：再深就没有横向空间了
      emit(child, depth < 2 ? depth + 1 : 2);
    }
  }

  for (final r in roots) {
    emit(r, 0);
  }
  // 兜底：循环里的节点没有 root 可达，单独补上
  for (final m in messages) {
    if (!emitted.contains(m.id)) emit(m, 0);
  }
  return out;
}
