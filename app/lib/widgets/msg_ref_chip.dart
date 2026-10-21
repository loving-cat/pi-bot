import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../models.dart';
import '../motion.dart';
import '../scope.dart';
import '../theme.dart';
import 'blob_avatar.dart';
import 'conversation_people.dart';
import 'md_text.dart';

/// 展示私信接收方与往来数量，点击打开只读会话查看器。
class MsgRefChip extends StatelessWidget {
  const MsgRefChip({super.key, required this.refs, this.senderBotId});

  final List<MsgRef> refs;

  /// 发信方的 bot id（查看器标题里画"谁 ⇄ 谁"用）
  final String? senderBotId;

  @override
  Widget build(BuildContext context) {
    if (refs.isEmpty) return const SizedBox.shrink();
    final state = AppScope.of(context);
    // 仅汇总带计数的引用；全部缺失时省略数量。
    final counts = refs.map((r) => r.count).whereType<int>().toList();
    final totals = counts.isEmpty ? null : counts.reduce((a, b) => a + b);

    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 6),
      child: Center(
        child: HoverTap(
          baseColor: Colors.transparent,
          hoverColor: PB.bgHover,
          pressColor: PB.bgActive,
          borderRadius: BorderRadius.circular(PB.rFull),
          onTap: () =>
              showChatPeek(context, refs: refs, senderBotId: senderBotId),
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 5),
            child: ConversationPeople(
              prefix: '已发消息给',
              people: [
                for (final ref in refs)
                  (
                    id: ref.botId,
                    name: state.botById(ref.botId)?.name ?? 'bot',
                  ),
              ],
              suffix: totals == null ? '' : '$totals 条往来',
            ),
          ),
        ),
      ),
    );
  }
}

/// 双人对话查看器：浮出一张"聊天窗"，像正常聊天一样读 bot 之间的私聊。
///
/// 不跳转、不切会话 —— 用户看完关掉还在原地：
/// 群里的对话流不该被一次"去看看他们聊了啥"打断。
Future<void> showChatPeek(
  BuildContext context, {
  required List<MsgRef> refs,
  String? senderBotId,
}) async {
  if (refs.isEmpty) return;
  final overlay = Overlay.maybeOf(context);
  if (overlay == null) return;

  final state = AppScope.of(context);
  // 先把每个私聊的消息拉起来（没拉过才拉，loadMessages 内部有缓存）
  for (final r in refs) {
    await state.loadMessages(r.roomId);
  }
  if (!context.mounted) return;

  late OverlayEntry entry;
  entry = OverlayEntry(
    builder: (ctx) => _PeekLayer(
      refs: refs,
      senderBotId: senderBotId,
      messagesOf: (roomId) => state.messages[roomId] ?? const [],
      botNameOf: (botId) => state.botById(botId)?.name ?? 'bot',
      onClose: () => entry.remove(),
      onOpenRoom: (roomId) {
        entry.remove();
        requestRoom(context, roomId);
      },
    ),
  );
  overlay.insert(entry);
}

class _PeekLayer extends StatefulWidget {
  const _PeekLayer({
    required this.refs,
    required this.senderBotId,
    required this.messagesOf,
    required this.botNameOf,
    required this.onClose,
    required this.onOpenRoom,
  });

  final List<MsgRef> refs;
  final String? senderBotId;
  final List<Msg> Function(String roomId) messagesOf;
  final String Function(String botId) botNameOf;
  final VoidCallback onClose;
  final void Function(String roomId) onOpenRoom;

  @override
  State<_PeekLayer> createState() => _PeekLayerState();
}

class _PeekLayerState extends State<_PeekLayer>
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
    final w = (screen.width * 0.68).clamp(360.0, 760.0);
    final h = (screen.height * 0.78).clamp(320.0, 720.0);

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
    // 为覆盖层内的文本提供 Material 默认样式。
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
              _header(),
              Container(height: 1, color: PB.borderTertiary),
              Expanded(
                child: ListView(
                  padding: const EdgeInsets.fromLTRB(16, 16, 16, 10),
                  children: [for (final r in widget.refs) ..._thread(r)],
                ),
              ),
              Container(height: 1, color: PB.borderTertiary),
              // 底部提供关闭查看器的操作。
              Padding(
                padding: const EdgeInsets.symmetric(vertical: 10),
                child: Row(
                  mainAxisAlignment: MainAxisAlignment.center,
                  children: [
                    HoverTap(
                      baseColor: PB.bgElevated,
                      hoverColor: PB.bgHover,
                      pressColor: PB.bgActive,
                      borderRadius: BorderRadius.circular(PB.rFull),
                      onTap: widget.onClose,
                      child: const Padding(
                        padding: EdgeInsets.symmetric(
                          horizontal: 20,
                          vertical: 8,
                        ),
                        child: Text(
                          '关闭聊天',
                          style: TextStyle(
                            fontSize: PB.fsSm,
                            color: PB.textSecondary,
                          ),
                        ),
                      ),
                    ),
                  ],
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }

  /// 顶部：谁 ⇄ 谁（单个私聊）；多个则显示"已发消息给 N 个 Bot"
  Widget _header() {
    final refs = widget.refs;
    final single = refs.length == 1;

    Widget botTag(String botId, {double size = 22}) => Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        BlobAvatar(
          seed: botId,
          color: PB.colorFor(botId),
          size: size,
          animate: false,
        ),
        const SizedBox(width: 7),
        Flexible(
          child: Tooltip(
            message: widget.botNameOf(botId),
            child: Text(
              widget.botNameOf(botId),
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: const TextStyle(
                fontSize: PB.fsSm,
                fontWeight: FontWeight.w600,
                color: PB.textPrimary,
              ),
            ),
          ),
        ),
      ],
    );

    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 12, 8, 12),
      child: Row(
        children: [
          Expanded(
            child: single
                ? Row(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      if (widget.senderBotId != null) ...[
                        Expanded(child: botTag(widget.senderBotId!)),
                        const Padding(
                          padding: EdgeInsets.symmetric(horizontal: 10),
                          child: Icon(
                            LucideIcons.arrowLeftRight,
                            size: 13,
                            color: PB.textQuaternary,
                          ),
                        ),
                      ],
                      Expanded(child: botTag(refs.first.botId)),
                    ],
                  )
                : Text(
                    '已发消息给 ${refs.length} 个 Bot',
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: const TextStyle(
                      fontSize: PB.fsSm,
                      fontWeight: FontWeight.w600,
                      color: PB.textPrimary,
                    ),
                  ),
          ),
          // 保留"直接打开这个会话"的出口（查看器是只读的）
          HoverIconButton(
            icon: LucideIcons.squareArrowOutUpRight,
            tooltip: '打开这个对话',
            onTap: () => widget.onOpenRoom(refs.first.roomId),
          ),
          HoverIconButton(
            icon: LucideIcons.x,
            tooltip: '关闭',
            onTap: widget.onClose,
          ),
        ],
      ),
    );
  }

  /// 一段私聊往来（一次 ref = 一个收信 bot 的私聊）
  List<Widget> _thread(MsgRef ref) {
    final msgs = widget.messagesOf(ref.roomId);
    final others = widget.refs.length > 1;

    return [
      if (others)
        Padding(
          padding: const EdgeInsets.only(bottom: 10, top: 2),
          child: Row(
            children: [
              BlobAvatar(
                seed: ref.botId,
                color: PB.colorFor(ref.botId),
                size: 20,
                animate: false,
              ),
              const SizedBox(width: 8),
              Expanded(
                child: Tooltip(
                  message: widget.botNameOf(ref.botId),
                  child: Text(
                    widget.botNameOf(ref.botId),
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: const TextStyle(
                      fontSize: PB.fsXs,
                      fontWeight: FontWeight.w600,
                      color: PB.textSecondary,
                    ),
                  ),
                ),
              ),
            ],
          ),
        ),
      if (msgs.isEmpty)
        const Padding(
          padding: EdgeInsets.symmetric(vertical: 16),
          child: Text(
            '（还没有内容）',
            style: TextStyle(fontSize: PB.fsXs, color: PB.textQuaternary),
          ),
        )
      else
        for (final m in msgs)
          if (m.text.trim().isNotEmpty && !m.isRef) _message(m),
    ];
  }

  /// 一条消息：头像 + 作者名 + 气泡（像正常聊天那样左对齐）
  Widget _message(Msg m) {
    final authorId = m.isUser ? 'me' : (m.authorId ?? m.authorName);
    final name = m.isUser
        ? '我'
        : (m.authorName.isEmpty ? widget.botNameOf(authorId) : m.authorName);

    return Padding(
      padding: const EdgeInsets.only(bottom: 14),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          BlobAvatar(
            seed: authorId,
            color: PB.colorFor(authorId),
            size: 22,
            animate: false,
          ),
          const SizedBox(width: 8),
          Flexible(
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 560),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                mainAxisSize: MainAxisSize.min,
                children: [
                  Padding(
                    padding: const EdgeInsets.only(bottom: 4, left: 2),
                    child: Text(
                      name,
                      style: const TextStyle(
                        fontSize: PB.fsXxs,
                        color: PB.textQuaternary,
                      ),
                    ),
                  ),
                  Container(
                    padding: const EdgeInsets.symmetric(
                      horizontal: 12,
                      vertical: 9,
                    ),
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
                      style: const TextStyle(
                        fontSize: PB.fsXs,
                        height: 1.5,
                        color: PB.textPrimary,
                      ),
                    ),
                  ),
                ],
              ),
            ),
          ),
        ],
      ),
    );
  }
}
