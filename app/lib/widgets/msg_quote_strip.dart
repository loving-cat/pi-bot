import 'package:flutter/material.dart';

import '../markdown_inline.dart';
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
    if (quoted == null && fallbackName.isEmpty) return const SizedBox.shrink();

    final who = quoted == null
        ? fallbackName
        : (quoted!.authorName.isNotEmpty ? quoted!.authorName : fallbackName);

    // ★ 用 markdownPreviewText 而不是直接截原文。
    //
    //   早先的做法先把整段空白压成一个空格、再按 60 字截断。两个坑：
    //     · ## 是块级标记，必须位于行首才生效；压成一行后它跑到句子中间，
    //       渲染器不认，就原样显示成 ##；
    //     · ** 被截断切掉一半时配对不上，也原样显示。
    //   所以引用条这里显示的是**剥掉标记后的纯文本预览**，
    //   而不是把一小段 Markdown 丢给渲染器 —— 一行摘要也确实排不下标题块。
    final preview = markdownPreviewText(quoted?.text ?? '', maxChars: 60);

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
              // 这里是**剥净标记后的纯文本**（见上面 markdownPreviewText），
              // 所以用普通 Text。一行摘要排不下标题块，不该走 MdText。
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
