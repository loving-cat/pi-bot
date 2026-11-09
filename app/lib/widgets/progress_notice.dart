import 'dart:math' as math;

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
              prefix: strings.t('dept.received'),
              people: senders,
              fallback: strings.tf('misc.quoted', {'name': dept}),
              suffix: strings.tf('dept.messageSuffix', {'n': messages.length}),
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
                        senders.isEmpty
                            ? strings.tf('dept.fromRoom', {'room': dept})
                            : strings.tf('dept.fromPeople', {
                                'names': senders
                                    .map((s) => s.name)
                                    .join(strings.t('misc.listSeparator')),
                              }),
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
    // 按 id 建索引，用于把 re 解析成被回应的那条
    final byId = <String, Msg>{for (final m in messages) m.id: m};
    // 找出「这条是在回应批次内的另一条」的消息 → 它是子节点
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

    final out = <Widget>[];
    void emit(Msg m, int depth) {
      // 深度最多两层：再深就缩进到没有横向空间了
      out.add(_receipt(state, m, depth: depth));
      for (final child in childrenOf[m.id] ?? const <Msg>[]) {
        emit(child, math.min(depth + 1, 2));
      }
    }

    for (final r in roots) {
      emit(r, 0);
    }
    return out;
  }

  Widget _receipt(AppState state, Msg m, {int depth = 0}) {
    final fromId = (m.meta?['fromId'] as String?) ?? '';
    final fromName = ((m.meta?['fromName'] as String?) ?? '').trim();
    final dept = _deptName(state, [m], L10n.s(context));
    final result = progressResult(m);
    final resultColor = switch (result) {
      ProgressResult.success => PB.success,
      ProgressResult.failure => PB.danger,
      _ => PB.textQuaternary,
    };
    final who = fromName.isNotEmpty ? fromName : dept;
    final author = m.authorId ?? m.authorName;

    final body = Padding(
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
                  message: dept,
                  child: Text(
                    dept,
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
    // IntrinsicHeight 让左侧竖线能长到和内容同高。
    // 这里每条回执最多出现两次（父/子），开销可接受。
    return Padding(
      padding: EdgeInsets.only(left: 18.0 * depth),
      child: IntrinsicHeight(
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Container(
              width: 2,
              margin: const EdgeInsets.only(top: 2, bottom: 16, right: 10),
              decoration: BoxDecoration(
                color: PB.borderSecondary,
                borderRadius: BorderRadius.circular(1),
              ),
            ),
            Expanded(child: body),
          ],
        ),
      ),
    );
  }
}
