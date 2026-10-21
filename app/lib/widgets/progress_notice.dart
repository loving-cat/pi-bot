import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../app_state.dart';
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
    final senders = progressSenders(messages);
    final dept = _deptName(state, messages);

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
            child: ConversationPeople(
              prefix: '收到',
              people: senders,
              fallback: '「$dept」',
              suffix: '消息 · ${messages.length} 条',
            ),
          ),
        ),
      ),
    );
  }
}

String _deptName(AppState state, List<Msg> messages) {
  final rid = (messages.first.meta?['fromRoomId'] as String?) ?? '';
  return state.rooms.where((r) => r.id == rid).firstOrNull?.name ?? '部门';
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
    final state = AppScope.of(context);
    final senders = progressSenders(widget.messages);
    final dept = _deptName(state, widget.messages);

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
                    const Icon(
                      LucideIcons.inbox,
                      size: 15,
                      color: PB.textTertiary,
                    ),
                    const SizedBox(width: 8),
                    Expanded(
                      child: Text(
                        senders.isEmpty
                            ? '「$dept」的消息'
                            : '收到 ${senders.map((s) => s.name).join('、')} 的消息',
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: const TextStyle(
                          fontSize: PB.fsSm,
                          fontWeight: FontWeight.w600,
                          color: PB.textPrimary,
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
                  padding: const EdgeInsets.fromLTRB(16, 14, 16, 10),
                  children: [
                    for (final m in widget.messages) _receipt(state, m),
                  ],
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
                    child: const Padding(
                      padding: EdgeInsets.symmetric(
                        horizontal: 20,
                        vertical: 8,
                      ),
                      child: Text(
                        '关闭',
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

  Widget _receipt(AppState state, Msg m) {
    final fromId = (m.meta?['fromId'] as String?) ?? '';
    final fromName = ((m.meta?['fromName'] as String?) ?? '').trim();
    final dept = _deptName(state, [m]);
    final result = progressResult(m);
    final resultColor = switch (result) {
      ProgressResult.success => PB.accentBright,
      ProgressResult.failure => PB.danger,
      _ => PB.textQuaternary,
    };
    final who = fromName.isNotEmpty ? fromName : dept;
    final author = m.authorId ?? m.authorName;

    return Padding(
      padding: const EdgeInsets.only(bottom: 14),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              BlobAvatar(
                seed: fromId.isNotEmpty ? fromId : author,
                color: PB.colorFor(fromId.isNotEmpty ? fromId : author),
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
                    style: const TextStyle(
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
                  message: dept,
                  child: Text(
                    dept,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: const TextStyle(
                      fontSize: PB.fsXxs,
                      color: PB.textQuaternary,
                    ),
                  ),
                ),
              ),
              const SizedBox(width: 8),
              Text(
                _fmtTime(m.createdAt),
                style: const TextStyle(
                  fontSize: PB.fsXxs,
                  color: PB.textQuaternary,
                ),
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
              style: const TextStyle(
                fontSize: PB.fsXs,
                height: 1.5,
                color: PB.textPrimary,
              ),
            ),
          ),
        ],
      ),
    );
  }
}
