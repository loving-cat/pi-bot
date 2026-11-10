import 'package:flutter/material.dart';

import '../models.dart';
import '../theme.dart';

/// 气泡上方的引用条：这条消息在回应谁、回应的是哪句话。
///
/// 为什么需要：bot 之间的往来如果每条都画成独立卡片，
/// 读的人找不出「谁在接谁的话」—— 看起来像一排互不相干的播报。
/// 加上这条引用，视觉上就成立为「引用 + 回应」，也就是对话。
class MsgQuoteStrip extends StatelessWidget {
  const MsgQuoteStrip({
    super.key,
    required this.quoted,
    this.onTap,
    this.fallbackName = '',
  });

  /// 被引用的那条消息（可能已经不在本地列表里，此时为 null）。
  final Msg? quoted;

  /// 点引用条跳到原消息。
  final VoidCallback? onTap;

  /// 找不到原消息时显示的名字（用 meta.reFrom 查出来的）。
  final String fallbackName;

  @override
  Widget build(BuildContext context) {
    final text = quoted?.text.replaceAll(RegExp(r'\s+'), ' ').trim() ?? '';
    if (quoted == null && fallbackName.isEmpty) return const SizedBox.shrink();

    final who = quoted == null
        ? fallbackName
        : (quoted!.authorName.isNotEmpty ? quoted!.authorName : fallbackName);
    final preview = text.isEmpty
        ? '（原消息）'
        // ★ 按「字符」截断，不是按 UTF-16 code unit。
        //   substring 数的是 code unit，第 60 个正好落在代理对中间时，
        //   预览尾部会渲染成「�」。characters 会按字素簇切。
        : (text.characters.length > 60
              ? '${text.characters.take(60)}…'
              : text);

    // ★ onTap 为空时不要套 GestureDetector。
    //
    //   behavior: opaque 会把点击全部吃掉，但回调是 null ——
    //   用户点引用条什么都不会发生，也冒泡不到列表和长按菜单。
    //   目前没有调用方传 onTap（跳转还没实现），所以默认不拦。
    final body = Container(
          constraints: const BoxConstraints(maxWidth: 460),
          padding: const EdgeInsets.fromLTRB(8, 5, 10, 5),
          decoration: BoxDecoration(
            // 比气泡再低一档：它是辅助信息，不能抢正文
            color: PB.bgApp.withValues(alpha: 0.35),
            borderRadius: BorderRadius.circular(6),
            border: Border(
              left: BorderSide(
                color: PB.textQuaternary.withValues(alpha: 0.45),
                width: 2,
              ),
            ),
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            mainAxisSize: MainAxisSize.min,
            children: [
              Text(
                who,
                style: TextStyle(
                  fontSize: PB.fsXxs,
                  color: PB.textTertiary,
                  fontWeight: FontWeight.w500,
                ),
              ),
              const SizedBox(height: 1),
              Text(
                preview,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: TextStyle(fontSize: PB.fsXxs, color: PB.textTertiary),
              ),
            ],
          ),
        );

    return Padding(
      padding: const EdgeInsets.only(bottom: 6),
      // 有回调才让它可点；没有就原样交给下层处理命中
      child: onTap == null
          ? body
          : GestureDetector(
              behavior: HitTestBehavior.opaque,
              onTap: onTap,
              child: body,
            ),
    );
  }
}
