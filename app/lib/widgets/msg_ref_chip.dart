import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../models.dart';
import '../motion.dart';
import '../scope.dart';
import '../theme.dart';
import 'blob_avatar.dart';
import 'md_text.dart';
/// 「已发送消息给 @A 和 @B」的小浮动条。
///
/// bot 之间用 `message_bot` 私信时，服务端会在**来源房间**留一条 `kind == 'ref'`
/// 的记录。用户因此能看到"它把活派给了谁"，而不是只看到"我发了"。
///
/// 点一下 → 弹出 [showChatPeek]，直接看他们俩聊了什么。
///
/// 抽成独立组件的原因：群聊、私聊、以及窥视弹层内部都会用到，
/// 三处的样式和行为必须完全一致。
class MsgRefChip extends StatelessWidget {
  const MsgRefChip({
    super.key,
    required this.refs,
    this.alignEnd = true,
  });

  final List<MsgRef> refs;

  /// 贴右（bot 自己发的）/ 贴左
  final bool alignEnd;

  @override
  Widget build(BuildContext context) {
    if (refs.isEmpty) return const SizedBox.shrink();
    final state = AppScope.of(context);

    return Align(
      alignment: alignEnd ? Alignment.centerRight : Alignment.centerLeft,
      child: Padding(
        padding: const EdgeInsets.symmetric(vertical: 3),
        child: HoverTap(
          baseColor: PB.bgElevated,
          hoverColor: PB.bgHover,
          pressColor: PB.bgActive,
          borderRadius: BorderRadius.circular(PB.rFull),
          onTap: () => showChatPeek(context, refs: refs),
          child: Container(
            padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 7),
            decoration: BoxDecoration(
              borderRadius: BorderRadius.circular(PB.rFull),
              border: Border.all(color: PB.borderSecondary),
            ),
            child: Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                const Icon(
                  LucideIcons.send,
                  size: 13,
                  color: PB.textTertiary,
                ),
                const SizedBox(width: 7),
                Flexible(
                  child: Text.rich(
                    TextSpan(
                      children: [
                        const TextSpan(text: '已发送消息给 '),
                        for (var i = 0; i < refs.length; i++) ...[
                          if (i > 0)
                            TextSpan(
                              text: i == refs.length - 1 ? ' 和 ' : '、',
                            ),
                          TextSpan(
                            text: '@${state.botById(refs[i].botId)?.name ?? 'bot'}',
                            style: const TextStyle(
                              color: PB.accentBright,
                              fontWeight: FontWeight.w600,
                            ),
                          ),
                        ],
                      ],
                    ),
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
        ),
      ),
    );
  }
}

/// 窥视弹层：在当前位置浮出一张卡片，显示某个私聊里的往来。
///
/// 不跳转、不切会话 —— 用户看完关掉还在原地。这是 同类客户端 的做法：
/// 群里的对话流不该被一次"去看看他们聊了啥"打断。
Future<void> showChatPeek(
  BuildContext context, {
  required List<MsgRef> refs,
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
      messagesOf: (roomId) => state.messages[roomId] ?? const [],
      nameOf: (botId) => state.botById(botId)?.name ?? 'bot',
      onClose: () => entry.remove(),
    ),
  );
  overlay.insert(entry);
}

class _PeekLayer extends StatefulWidget {
  const _PeekLayer({
    required this.refs,
    required this.messagesOf,
    required this.nameOf,
    required this.onClose,
  });

  final List<MsgRef> refs;
  final List<Msg> Function(String roomId) messagesOf;
  final String Function(String botId) nameOf;
  final VoidCallback onClose;

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
    final w = (screen.width * 0.62).clamp(320.0, 620.0);
    final h = (screen.height * 0.72).clamp(280.0, 620.0);

    return Stack(
      children: [
        Positioned.fill(
          child: GestureDetector(
            behavior: HitTestBehavior.opaque,
            onTap: widget.onClose,
            child: AnimatedBuilder(
              animation: _c,
              builder: (context, _) => Container(
                color: Colors.black.withValues(alpha: 0.5 * _c.value),
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
                child: Transform.scale(scale: 0.95 + 0.05 * t, child: child),
              );
            },
          ),
        ),
      ],
    );
  }

  Widget _card(double w, double h) {
    final state = AppScope.of(context);
    return SizedBox(
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
            // 标题：已发送消息给 @A 和 @B
            Padding(
              padding: const EdgeInsets.fromLTRB(18, 14, 10, 10),
              child: Row(
                children: [
                  const Icon(
                    LucideIcons.send,
                    size: 15,
                    color: PB.textTertiary,
                  ),
                  const SizedBox(width: 8),
                  Expanded(
                    child: Text.rich(
                      TextSpan(
                        children: [
                          const TextSpan(text: '已发送消息给 '),
                          for (var i = 0; i < widget.refs.length; i++) ...[
                            if (i > 0)
                              TextSpan(
                                text: i == widget.refs.length - 1 ? ' 和 ' : '、',
                              ),
                            TextSpan(
                              text: '@${widget.nameOf(widget.refs[i].botId)}',
                              style: const TextStyle(
                                color: PB.accentBright,
                                fontWeight: FontWeight.w600,
                              ),
                            ),
                          ],
                        ],
                      ),
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: const TextStyle(
                        fontSize: PB.fsSm,
                        color: PB.textSecondary,
                      ),
                    ),
                  ),
                  HoverIconButton(
                    icon: LucideIcons.x,
                    tooltip: '关闭',
                    onTap: widget.onClose,
                  ),
                ],
              ),
            ),
            Container(height: 1, color: PB.borderTertiary),
            Expanded(
              child: ListView(
                padding: const EdgeInsets.fromLTRB(16, 14, 16, 14),
                children: [
                  for (final r in widget.refs) ...[
                    _thread(r),
                  ],
                ],
              ),
            ),
            Container(height: 1, color: PB.borderTertiary),
            Padding(
              padding: const EdgeInsets.all(10),
              child: HoverTap(
                baseColor: PB.bgElevated,
                hoverColor: PB.bgHover,
                borderRadius: BorderRadius.circular(PB.rXl),
                onTap: () {
                  widget.onClose();
                  // 跳进那个 bot 的私聊，用户想接着聊就接着聊
                  state.openRoom(widget.refs.first.roomId);
                },
                child: const Padding(
                  padding: EdgeInsets.symmetric(vertical: 9),
                  child: Center(
                    child: Text(
                      '打开这个对话',
                      style: TextStyle(fontSize: PB.fsSm, color: PB.textSecondary),
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

  /// 一段私聊往来（一次 ref = 一个 bot 的私聊）
  Widget _thread(MsgRef ref) {
    final msgs = widget.messagesOf(ref.roomId);
    final name = widget.nameOf(ref.botId);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        if (widget.refs.length > 1)
          Padding(
            padding: const EdgeInsets.only(bottom: 8, top: 4),
            child: Row(
              children: [
                BlobAvatar(seed: ref.botId, color: PB.colorFor(ref.botId), size: 22, animate: false),
                const SizedBox(width: 8),
                Text(
                  name,
                  style: const TextStyle(
                    fontSize: PB.fsXs,
                    fontWeight: FontWeight.w600,
                    color: PB.textSecondary,
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
            if (m.text.trim().isNotEmpty && !m.isRef)
              Padding(
                padding: const EdgeInsets.only(bottom: 10),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      m.isUser ? '我' : (m.authorName.isEmpty ? name : m.authorName),
                      style: const TextStyle(
                        fontSize: PB.fsXxs,
                        color: PB.textQuaternary,
                      ),
                    ),
                    const SizedBox(height: 3),
                    Container(
                      width: double.infinity,
                      padding: const EdgeInsets.symmetric(
                        horizontal: 12,
                        vertical: 9,
                      ),
                      decoration: BoxDecoration(
                        color: PB.bgBubble,
                        borderRadius: BorderRadius.circular(PB.rXl),
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
      ],
    );
  }
}
