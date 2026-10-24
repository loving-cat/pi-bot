import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../models.dart';
import '../ime_guard.dart';
import '../theme.dart';

/// 「要用户拿个主意」的卡片。
///
/// 为什么要有它：bot 卡住的时候，在聊天里写一段"您看是 A 还是 B？"——
/// 用户得打字回，而且经常答得不完整，bot 又要追问一轮。
/// 换成卡片：选项直接点，还能自己写一句（自定义 query）。
///
/// 用户点了之后，**把选项文字原样当成一条普通消息发回去** ——
/// 这样服务端不用多一套协议，bot 拿到的就是用户在说话。
class AskCard extends StatefulWidget {
  const AskCard({super.key, required this.msg, required this.onAnswer});

  final Msg msg;

  /// 用户选了/写了什么 → 发回这个会话
  final void Function(String text) onAnswer;

  @override
  State<AskCard> createState() => _AskCardState();
}

class _AskCardState extends State<AskCard> with SingleTickerProviderStateMixin {
  /// 本地“已发出”：用户点下去的瞬间就把卡片锁住。
  ///
  /// 等服务端把 `meta.answer` 写回来要一个往返，这期间按钮还是可点的 ——
  /// 点两下就会发两条同样的消息出去。所以本地先记一笔。
  bool _submitted = false;

  /// 用户选的/写的那个回答（本地记录，服务端回包后以服务端为准）
  String? _localAnswer;
  /// 入场：卡片本体先"弹"出来，选项再一行一行跟上。
  ///
  /// 用户："这个询问卡片 要有动态动画，现在没有动画 触发的感觉都没有"。
  /// 这张卡片是 bot **停下来等你回话**的地方 —— 它越有存在感，
  /// 用户越不容易在往下滚的消息里把它划过去。
  ///
  /// 全部走 FadeTransition + Transform（GPU 合成层），不触发重排。
  static const _cardMs = 260.0;
  static const _stepMs = 60.0;
  static const _itemMs = 220.0;

  late final int _slots;
  late final AnimationController _c;

  @override
  void initState() {
    super.initState();
    _slots =
        1 + widget.msg.askOptions.length + (widget.msg.askAllowCustom ? 1 : 0);
    _c = AnimationController(
      vsync: this,
      duration: Duration(
        milliseconds: (_cardMs + (_slots - 1) * _stepMs + _itemMs).round(),
      ),
    );
    // 系统开了"减弱动态效果"就直接到位（无障碍，也顺便省电）。
    // ★ 这里读 platformDispatcher 而不是 MediaQuery —— initState 里还不能读
    //   继承的 widget（组件测试会直接报错）。
    final reduce =
        WidgetsBinding
            .instance
            .platformDispatcher
            .accessibilityFeatures
            .disableAnimations;
    if (reduce) {
      _c.value = 1;
    } else {
      _c.forward();
    }
  }

  @override
  void dispose() {
    _c.dispose();
    super.dispose();
  }

  /// 第 [i] 档的时间片：i=0 是卡片本体，之后依次是各选项 / 自定义输入。
  Animation<double> _slot(int i) {
    final total = _cardMs + (_slots - 1) * _stepMs + _itemMs;
    final begin = i == 0 ? 0.0 : (_cardMs + (i - 1) * _stepMs) / total;
    final end = i == 0
        ? _cardMs / total
        : (_cardMs + (i - 1) * _stepMs + _itemMs) / total;
    return CurvedAnimation(
      parent: _c,
      curve: Interval(
        begin.clamp(0.0, 1.0),
        end.clamp(0.0, 1.0),
        curve: Curves.easeOutCubic,
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final msg = widget.msg;
    final options = msg.askOptions;

    // ★ 已经答过 → 卡片收起，只留一行小字。
    //
    //   这张卡片的职责是“停下来等你回话”。用户回了（或者自己打了一句），
    //   事情就已经往下走了 —— 卡片还摊在那里、按钮还能再点，
    //   只会让人怀疑“我刚才到底点上了没有”。
    final answered = _submitted || msg.askAnswered;
    final answeredText = msg.askAnswer?.isNotEmpty == true
        ? msg.askAnswer!
        : _localAnswer;
    if (answered) {
      return _CollapsedAsk(
        question: msg.text,
        authorName: msg.authorName,
        answer: answeredText ?? '',
      );
    }

    /// 点了/写了之后：先本地上锁，再发回去。
    /// 锁在本地是必须的 —— 服务端把 meta.answer 写回来要一个往返，
    /// 这段空窗里连点两下就会发出两条一样的消息。
    void submit(String text) {
      if (_submitted) return;
      setState(() {
        _submitted = true;
        _localAnswer = text;
      });
      widget.onAnswer(text);
    }

    var slot = 1;
    return _RiseIn(
      animation: _slot(0),
      child: Padding(
        padding: const EdgeInsets.symmetric(vertical: 4),
        child: Container(
          constraints: const BoxConstraints(maxWidth: 520),
          padding: const EdgeInsets.fromLTRB(14, 12, 14, 12),
          decoration: BoxDecoration(
            color: PB.bgElevated,
            borderRadius: BorderRadius.circular(PB.rXl),
            border: Border.all(color: PB.accent.withValues(alpha: 0.35)),
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            mainAxisSize: MainAxisSize.min,
            children: [
              Row(
                children: [
                  Icon(LucideIcons.circleHelp, size: 15, color: PB.accent),
                  const SizedBox(width: 7),
                  Text(
                    '${msg.authorName} 问你',
                    style: const TextStyle(
                      fontSize: PB.fsXxs,
                      color: PB.accent,
                      fontWeight: FontWeight.w600,
                    ),
                  ),
                ],
              ),
              const SizedBox(height: 8),
              if (msg.text.isNotEmpty)
                Text(
                  msg.text,
                  style: const TextStyle(
                    fontSize: PB.fsSm,
                    color: PB.textPrimary,
                    height: 1.5,
                  ),
                ),
              const SizedBox(height: 10),
              // 选项：一行一个，点一下就发回去。逐条出现 —— 像"给你摆出来"
              for (final o in options)
                Padding(
                  padding: const EdgeInsets.only(bottom: 6),
                  child: _RiseIn(
                    animation: _slot(slot++),
                    child: _OptionButton(
                      label: o.label,
                      detail: o.detail,
                      onTap: () => submit(o.label),
                    ),
                  ),
                ),
              if (msg.askAllowCustom) ...[
                const SizedBox(height: 2),
                _RiseIn(
                  animation: _slot(slot++),
                  child: _CustomAnswer(onSubmit: submit),
                ),
              ],
            ],
          ),
        ),
      ),
    );
  }
}

/// 卡片的“已收起”形态。
///
/// 不把整张卡直接删掉：聊天记录里总得留下“当时问过什么、我回了什么”的痕迹，
/// 否则往上一滚就是莫名其妙地从“问你做什么”跳到“好的我开工了”。
/// 但也不再给它任何可点的东西 —— 这件事已经翻篇了。
class _CollapsedAsk extends StatelessWidget {
  const _CollapsedAsk({
    required this.question,
    required this.authorName,
    required this.answer,
  });

  final String question;
  final String authorName;
  final String answer;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 3),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(
            LucideIcons.circleCheck,
            size: 13,
            color: PB.textQuaternary,
          ),
          const SizedBox(width: 6),
          Flexible(
            child: Text(
              answer.isEmpty
                  ? '已回答：$question'
                  : '已回答：$answer',
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: const TextStyle(
                fontSize: PB.fsXxs,
                color: PB.textQuaternary,
              ),
            ),
          ),
        ],
      ),
    );
  }
}

/// 淡入 + 上浮 + 轻轻放大。
///
/// 放大从 0.97 起（而不是 0.8）—— 卡片这种大面积的东西放大太多会显得在"弹跳"，
/// 只要那一点点"推到位"的感觉就够。
class _RiseIn extends StatelessWidget {
  const _RiseIn({required this.animation, required this.child});

  final Animation<double> animation;
  final Widget child;

  @override
  Widget build(BuildContext context) {
    return FadeTransition(
      opacity: animation,
      child: AnimatedBuilder(
        animation: animation,
        builder: (context, child) {
          final t = animation.value;
          return Transform.translate(
            offset: Offset(0, (1 - t) * 10),
            child: Transform.scale(
              scale: 0.97 + 0.03 * t,
              alignment: Alignment.topLeft,
              child: child,
            ),
          );
        },
        child: child,
      ),
    );
  }
}

class _OptionButton extends StatefulWidget {
  const _OptionButton({
    required this.label,
    required this.detail,
    required this.onTap,
  });

  final String label;
  final String detail;
  final VoidCallback onTap;

  @override
  State<_OptionButton> createState() => _OptionButtonState();
}

class _OptionButtonState extends State<_OptionButton> {
  bool _hover = false;

  @override
  Widget build(BuildContext context) {
    // 悬停反馈自己做：InkWell 的水波纹画在 Material 上，会被这层不透明容器
    // 盖住（看得见点击、看不见悬停）。这里用 MouseRegion + AnimatedContainer
    // 直接把底色和描边变亮，鼠标一上去就有反应。
    return MouseRegion(
      cursor: SystemMouseCursors.click,
      onEnter: (_) => setState(() => _hover = true),
      onExit: (_) => setState(() => _hover = false),
      child: GestureDetector(
        behavior: HitTestBehavior.opaque,
        onTap: widget.onTap,
        child: AnimatedContainer(
          duration: const Duration(milliseconds: 120),
          curve: Curves.easeOut,
          width: double.infinity,
          padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 9),
          decoration: BoxDecoration(
            color: _hover ? PB.bgHover : PB.bgActive,
            borderRadius: BorderRadius.circular(PB.rLg),
            border: Border.all(
              color: _hover ? PB.accent.withValues(alpha: 0.45) : PB.borderSecondary,
            ),
          ),
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      widget.label,
                      style: const TextStyle(
                        fontSize: PB.fsSm,
                        color: PB.textPrimary,
                        fontWeight: FontWeight.w500,
                      ),
                    ),
                    if (widget.detail.isNotEmpty) ...[
                      const SizedBox(height: 2),
                      Text(
                        widget.detail,
                        style: const TextStyle(
                          fontSize: PB.fsXxs,
                          color: PB.textQuaternary,
                          height: 1.4,
                        ),
                      ),
                    ],
                  ],
                ),
              ),
              Icon(
                LucideIcons.chevronRight,
                size: 15,
                color: _hover ? PB.accent : PB.textQuaternary,
              ),
            ],
          ),
        ),
      ),
    );
  }
}

/// 「我自己说」—— 即"自定义 query"
class _CustomAnswer extends StatefulWidget {
  const _CustomAnswer({required this.onSubmit});

  final void Function(String text) onSubmit;

  @override
  State<_CustomAnswer> createState() => _CustomAnswerState();
}

class _CustomAnswerState extends State<_CustomAnswer> {
  final _c = TextEditingController();

  @override
  void dispose() {
    _c.dispose();
    super.dispose();
  }

  void _send() {
    final t = _c.text.trim();
    if (t.isEmpty) return;
    widget.onSubmit(t);
    _c.clear();
  }

  @override
  Widget build(BuildContext context) {
    return Row(
      children: [
        Expanded(
          child: TextField(
            controller: _c,
            // 中文输入法打英文时按回车是「选候选词」，不是提交
            onSubmitted: submitUnlessComposing(_c, _send),
            style: const TextStyle(fontSize: PB.fsSm),
            decoration: InputDecoration(
              hintText: '或者我自己说一句…',
              hintStyle: const TextStyle(
                fontSize: PB.fsSm,
                color: PB.textQuaternary,
              ),
              isDense: true,
              contentPadding: const EdgeInsets.symmetric(
                horizontal: 12,
                vertical: 10,
              ),
              border: OutlineInputBorder(
                borderRadius: BorderRadius.circular(PB.rLg),
                borderSide: const BorderSide(color: PB.borderSecondary),
              ),
            ),
          ),
        ),
        const SizedBox(width: 8),
        IconButton(
          tooltip: '发出去',
          onPressed: _send,
          icon: const Icon(LucideIcons.send, size: 17),
        ),
      ],
    );
  }
}
