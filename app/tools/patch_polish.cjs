const fs = require('fs');
const p = 'lib/screens/chat_screen.dart';
let s = fs.readFileSync(p, 'utf8');

// 1) 气泡：加深厚度（顶部高光 + 柔和投影）
s = s.replace(
  `                child: Container(
                  constraints: BoxConstraints(maxWidth: math.min(MediaQuery.sizeOf(context).width * 0.74, 560)),
                  padding: const EdgeInsets.fromLTRB(14, 10, 14, 10),
                  decoration: BoxDecoration(
                    color: PB.userBubble,
                    borderRadius: BorderRadius.circular(18),
                  ),`,
  `                child: Container(
                  constraints: BoxConstraints(maxWidth: math.min(MediaQuery.sizeOf(context).width * 0.74, 560)),
                  padding: const EdgeInsets.fromLTRB(14, 11, 14, 11),
                  decoration: BoxDecoration(
                    gradient: const LinearGradient(
                      begin: Alignment.topLeft,
                      end: Alignment.bottomRight,
                      colors: [PB.userBubbleTop, PB.userBubbleBottom],
                    ),
                    borderRadius: BorderRadius.circular(PB.rBubble),
                    border: Border.all(color: Colors.white.withValues(alpha: 0.10)),
                    boxShadow: PB.glow(PB.userBubbleBottom, blur: 16, alpha: 0.28),
                  ),`,
);

s = s.replace(
  `                  child: Container(
                    constraints: BoxConstraints(maxWidth: maxBubble),
                    padding: const EdgeInsets.fromLTRB(14, 10, 14, 10),
                    decoration: BoxDecoration(
                      color: PB.bgBubble,
                      borderRadius: BorderRadius.circular(18),
                      border: msg.status == 'error' ? Border.all(color: PB.danger.withValues(alpha: 0.5)) : null,
                    ),`,
  `                  child: Container(
                    constraints: BoxConstraints(maxWidth: maxBubble),
                    padding: const EdgeInsets.fromLTRB(14, 11, 14, 11),
                    decoration: BoxDecoration(
                      color: PB.bgBubble,
                      borderRadius: BorderRadius.circular(PB.rBubble),
                      border: Border.all(
                        color: msg.status == 'error'
                            ? PB.danger.withValues(alpha: 0.45)
                            : (streaming ? PB.accent.withValues(alpha: 0.22) : PB.borderHighlight),
                      ),
                      boxShadow: PB.shadow(y: 1, blur: 4, alpha: 0.22),
                    ),`,
);

// 2) 消息出现动画
s = s.replace(
  `class _MessageRow extends StatelessWidget {
  const _MessageRow({
    required this.msg,
    required this.showAuthor,
    required this.bot,
    required this.onLongPress,
  });`,
  `/// 新消息淡入 + 轻微上浮，不要"啪"地蹦出来
class _Appear extends StatefulWidget {
  const _Appear({required this.child});

  final Widget child;

  @override
  State<_Appear> createState() => _AppearState();
}

class _AppearState extends State<_Appear> with SingleTickerProviderStateMixin {
  late final AnimationController _c = AnimationController(
    vsync: this,
    duration: const Duration(milliseconds: 240),
  )..forward();

  @override
  void dispose() {
    _c.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final curve = CurvedAnimation(parent: _c, curve: Curves.easeOutCubic);
    return FadeTransition(
      opacity: curve,
      child: AnimatedBuilder(
        animation: curve,
        builder: (context, child) => Transform.translate(
          offset: Offset(0, (1 - curve.value) * 8),
          child: child,
        ),
        child: widget.child,
      ),
    );
  }
}

class _MessageRow extends StatelessWidget {
  const _MessageRow({
    required this.msg,
    required this.showAuthor,
    required this.bot,
    required this.onLongPress,
  });`,
);

s = s.replace(
  `                          return _MessageRow(
                            msg: msg,
                            showAuthor: newAuthor,
                            bot: state.botById(msg.authorId),
                            onLongPress: () => showMessageActions(context, msg),
                          );`,
  `                          return _Appear(
                            key: ValueKey(msg.id),
                            child: _MessageRow(
                              msg: msg,
                              showAuthor: newAuthor,
                              bot: state.botById(msg.authorId),
                              onLongPress: () => showMessageActions(context, msg),
                            ),
                          );`,
);

// 3) 工具调用：从"裸列表"变成一张卡片
s = s.replace(
  `class _Steps extends StatelessWidget {
  const _Steps({required this.steps});

  final List<ToolStep> steps;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 6),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          for (final step in steps)`,
  `class _Steps extends StatelessWidget {
  const _Steps({required this.steps});

  final List<ToolStep> steps;

  @override
  Widget build(BuildContext context) {
    final running = steps.any((s) => s.status == 'running');
    final shown = steps.length > 5 ? steps.sublist(steps.length - 5) : steps;
    return Padding(
      padding: const EdgeInsets.only(bottom: 7),
      child: Container(
        padding: const EdgeInsets.fromLTRB(10, 8, 11, 8),
        decoration: BoxDecoration(
          color: PB.bgBubble.withValues(alpha: 0.55),
          borderRadius: BorderRadius.circular(PB.rXl),
          border: Border.all(color: PB.borderTertiary),
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Padding(
              padding: const EdgeInsets.only(bottom: 5),
              child: Row(
                mainAxisSize: MainAxisSize.min,
                children: [
                  Icon(
                    running ? Icons.autorenew_rounded : Icons.check_circle_outline,
                    size: 11,
                    color: running ? PB.accent : PB.textQuaternary,
                  ),
                  const SizedBox(width: 5),
                  Text(
                    running ? '正在调用工具…' : '工具调用 · \${steps.length} 步',
                    style: TextStyle(
                      fontSize: PB.fsXxs,
                      fontWeight: FontWeight.w600,
                      letterSpacing: 0.3,
                      color: running ? PB.accent : PB.textTertiary,
                    ),
                  ),
                  if (steps.length > shown.length) ...[
                    const SizedBox(width: 6),
                    Text(
                      '（只显示最近 \${shown.length} 步）',
                      style: const TextStyle(fontSize: PB.fsXxs, color: PB.textQuaternary),
                    ),
                  ],
                ],
              ),
            ),
            for (final step in shown)`,
);

// _Steps 的收尾括号要多一层（外层加了 Container/Column）
s = s.replace(
  `                  ),
                ],
              ),
            ),
        ],
      ),
    );
  }
}

class _TypingDots extends StatefulWidget {`,
  `                  ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _TypingDots extends StatefulWidget {`,
);

// 4) 输入框：聚焦时边框渐亮 + 发送键按下有回弹
s = s.replace(
  `                Expanded(
                  child: Container(
                    decoration: BoxDecoration(
                      color: PB.bgInput,
                      borderRadius: BorderRadius.circular(22),
                      border: Border.all(color: PB.borderSecondary),
                    ),
                    padding: const EdgeInsets.symmetric(horizontal: 16),
                    child: Focus(`,
  `                Expanded(
                  child: AnimatedContainer(
                    duration: const Duration(milliseconds: 180),
                    curve: Curves.easeOut,
                    decoration: BoxDecoration(
                      color: PB.bgInput,
                      borderRadius: BorderRadius.circular(22),
                      border: Border.all(
                        color: widget.focus.hasFocus
                            ? PB.accent.withValues(alpha: 0.45)
                            : PB.borderSecondary,
                      ),
                      boxShadow: widget.focus.hasFocus
                          ? PB.glow(PB.accent, blur: 14, alpha: 0.12)
                          : null,
                    ),
                    padding: const EdgeInsets.symmetric(horizontal: 16),
                    child: Focus(`,
);

fs.writeFileSync(p, s);
console.log('chat_screen 质感补丁完成');
