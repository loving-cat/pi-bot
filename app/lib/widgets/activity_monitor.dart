import 'dart:async';

import 'package:flutter/material.dart';

import '../scope.dart';
import '../theme.dart';
import 'blob_avatar.dart';

/// 输入框左上角的「谁在干活」轮播。
///
/// 多 Agent 后台干活时，用户最想知道两件事：现在**有没有人在干**、**是谁**。
/// 这里把正在执行的 Bot 名字轮流显示出来，带一个转圈动画；没人干活就整块隐藏，
/// 不占位置。
class ActivityMonitor extends StatefulWidget {
  const ActivityMonitor({
    super.key,
    required this.roomId,
    this.needsUser = false,
    this.streaming = false,
  });

  final String roomId;

  /// 有任务在等用户确认（phase == 'needs_user'）。
  final bool needsUser;

  /// 助手的回复已经开始往外吐字（已经能看到流式正文）。
  final bool streaming;

  @override
  State<ActivityMonitor> createState() => _ActivityMonitorState();
}

/// 胶囊整体最大宽度（含转圈、名字、+N）。
///
/// 280 是经验值：够放一个七八字的中文名字 + 转圈 + 「+N」，
/// 又远小于聊天区宽度 —— 不会再出现「整条通栏」的观感。
const double _maxCapsuleWidth = 280;

/// 胶囊里 bot 形象的尺寸。
///
/// 13 比原来的转圈（11）略大：emoji 在小尺寸下笔画容易糊，
/// 13px 是「看得出是谁」和「不撑高胶囊」的平衡点。
const double _avatarSize = 13;

/// 名字那一段的最大宽度（扣掉图标、间距、+N 之后剩下的量）。
const double _maxLabelWidth = 200;

/// 胶囊里那句话的措辞。
///
/// 只用**确定可靠**的信号：
///   · needsUser → 这轮在等你确认（phase == 'needs_user'）
///   · streaming → 已经开始往外吐字了
///   · 其余      → 最保守的「正在处理」
///
/// 不引用任何任务内容：typing 事件只带 botId，服务端没下发
/// 「这一轮在答什么」，硬编只会"说错"。
String activityVerb({
  required bool needsUser,
  required bool streaming,
}) {
  if (needsUser) return '等你确认';
  if (streaming) return '正在回复';
  return '正在处理';
}

/// 有内容才包 Tooltip，没有就原样返回。
///
/// 空 Tooltip 不只是没意义：它会占一块可命中的区域，
/// 把本该落到下面消息上的指针事件吃掉。
Widget _maybeTooltip(String message, Widget child) {
  if (message.trim().isEmpty) return child;
  return Tooltip(
    message: message,
    waitDuration: const Duration(milliseconds: 400),
    child: child,
  );
}

class _ActivityMonitorState extends State<ActivityMonitor> {
  Timer? _timer;

  /// 当前是否在轮播（用来判断是否需要变更定时器状态）。
  bool _timerRunning = false;
  int _index = 0;

  @override
  void dispose() {
    _timer?.cancel();
    super.dispose();
  }

  void _ensureTimer(bool running) {
    _timerRunning = running;
    if (running && _timer == null) {
      _timer = Timer.periodic(const Duration(milliseconds: 2200), (_) {
        if (mounted) setState(() => _index += 1);
      });
    } else if (!running && _timer != null) {
      _timer!.cancel();
      _timer = null;
      _index = 0;
    }
  }

  @override
  Widget build(BuildContext context) {
    final state = AppScope.of(context);
    final ids = state.typingBotIds(widget.roomId);
    final running = ids.isNotEmpty;
    // 定时器的创建/销毁放到 build 之后做：build 必须是纯函数。
    if (running != _timerRunning) {
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (!mounted) return;
        _ensureTimer(running);
      });
      _timerRunning = running;
    }
    if (!running) return const SizedBox.shrink();

    // 轮播：每 2.2 秒换一个人，用户能看到「A、B、C 都在动」。
    final current = ids[_index % ids.length];
    final bot = state.botById(current);
    // 查不到人也要把表停掉，否则会一直空转
    if (bot == null) return const SizedBox.shrink();
    // ★ 不再把 TaskRun 的 title 当「它在做什么」。
    //
    //   TaskRun 是「受管执行」的概念：它的 title 是派给这个 bot 的任务目标，
    //   可能是几小时前那条长任务的描述 —— 和用户**当前这一轮**问的东西
    //   完全无关。把它塞进 Tooltip，用户悬浮上来看到一段莫名其妙的旧任务，
    //   会以为胶囊显示错了（实际是文案来源错了）。
    //
    //   typing 事件只带 botId，服务端没有下发「这一轮在答什么」，
    //   所以这里**不做猜测**：Tooltip 只说明状态，不复述内容。
    final needsUser = widget.needsUser;
    final streaming = widget.streaming;
    final verb = activityVerb(
      needsUser: needsUser,
      streaming: streaming,
    );

    // Tooltip 文案：只说状态 + 一句怎么办，不引用任何任务内容。
    final tooltip = switch (verb) {
      '等你确认' => '${bot.name} 在等你的确认，点开可以看它问了什么',
      '正在回复' => '${bot.name} 正在把结论写出来',
      _ => '${bot.name} 正在处理，结论出来后会自动出现在这里',
    };

    // 做成悬浮胶囊，而不是一行裸文字。
    //
    // 之前是「小圆点 + 一行字」直接跟在消息下面，视觉上和上一条消息连成一片，
    // 用户会以为那是正文的一部分（截图里「研究审校员 正在处理」贴着正文结尾）。
    // 胶囊有明确边界，一眼能看出这是独立的运行状态，而不是消息内容。
    // ★ 用 Align + 明确的紧凑约束，绝不让它被父级拉成通栏。
    //
    //   Column 的交叉轴默认是 stretch：直接放一个 Padding 会拿到整行宽度，
    //   里面即使写了 Center，外层那块区域仍然是"满宽"的 ——
    //   用户看到的就是输入框上方多出一条通栏背景。
    //   这里在根部就锁死宽度上限，从布局上保证它只是个胶囊。
    // 做成悬浮胶囊。外层的 IgnorePointer + 内层 ignoring:false 组合：
    //   · 外层让 Positioned 占满的整行区域不拦事件（点击落到下面的消息上）；
    //   · 内层把胶囊自己的命中重新打开（Tooltip 悬停、点击消费都靠它）。
    // 只靠 Align/Center 的自然留白不行 —— Center 会占满宽度并居中，
    // 面积照样覆盖整行，点空白处仍然打不到下面。
    // 布局：这一层只负责"占位"，本身不参与命中。
    //
    //   Positioned(left:0, right:0) 让这块区域撑满整行 —— 如果它可命中，
    //   用户点胶囊左右的空白就点不到下面的消息了。
    //
    //   ★ 不能用 IgnorePointer 包住胶囊（哪怕内层再 ignoring:false）：
    //     IgnorePointer 一旦生效就阻断整个子树，内层覆盖不回来 ——
    //     Tooltip 悬停会彻底失效（上一版就是这个 bug）。
    //
    //   正确做法：让**外层完全不参与命中**（IgnorePointer 包空盒子），
    //   胶囊作为**兄弟节点**叠在上面，自己负责命中。
    return Stack(
      children: [
        // 占位：撑出正确的高度与对齐，本身零命中
        Positioned.fill(
          child: IgnorePointer(
            child: Align(
              alignment: Alignment.centerLeft,
              heightFactor: 1,
              child: OverflowBox(
                alignment: Alignment.bottomLeft,
                maxHeight: double.infinity,
                child: SizedBox(
                  height: 0,
                  width: _maxCapsuleWidth,
                ),
              ),
            ),
          ),
        ),
        // 胶囊本体：真实可命中（悬停弹 Tooltip、点击被吃掉）
        Align(
          alignment: Alignment.centerLeft,
          child: Padding(
            padding: const EdgeInsets.only(left: 4, top: 2, bottom: 8),
            child: GestureDetector(
              onTap: () {}, // 吃掉落在胶囊上的点击
              child: MouseRegion(
                cursor: SystemMouseCursors.help,
                child: Container(
                  constraints: const BoxConstraints(maxWidth: _maxCapsuleWidth),
                  padding: const EdgeInsets.symmetric(
                    horizontal: 10,
                    vertical: 5,
                  ),
                  decoration: BoxDecoration(
                    // 必须不透明实底：透明胶囊会让下面正文透出来，文字叠文字。
                    color: PB.bgElevated,
                    borderRadius: BorderRadius.circular(999),
                    border: Border.all(color: PB.borderTertiary),
                    boxShadow: PB.shadow(y: 2, blur: 10, alpha: 0.35),
                  ),
                  child: Row(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      // ★ 用 BlobAvatar —— 和左侧会话列表、消息作者头像是同一个。
                      //
                      //   不能用 bot.emoji：emoji 是**名字前的标签**（比如 π、🧭），
                      //   用户给 bot 创造的那个 3D 形象是由 avatarColor + avatarShape
                      //   经 BlobAvatar 自绘出来的，两者是不同的东西。
                      //
                      //   animate: false —— 胶囊每 2.2 秒轮播一个人，
                      //   带抖动动画会反复创建动画控制器，这里只要静态形象。
                      BlobAvatar(
                        seed: bot.id,
                        color: PB.colorFor(bot.id),
                        size: _avatarSize,
                        animate: false,
                      ),
                      const SizedBox(width: 7),
                      // 胶囊里只写「名字 正在处理」；任务描述进 Tooltip。
                      AnimatedSwitcher(
                        duration: const Duration(milliseconds: 260),
                        child: _maybeTooltip(
                          tooltip,
                          ConstrainedBox(
                            constraints: const BoxConstraints(
                              maxWidth: _maxLabelWidth,
                            ),
                            child: Text(
                              '${bot.name} $verb',
                              key: ValueKey(current),
                              maxLines: 1,
                              overflow: TextOverflow.ellipsis,
                              style: TextStyle(
                                fontSize: PB.fsXs,
                                color: PB.textTertiary,
                              ),
                            ),
                          ),
                        ),
                      ),
                      if (ids.length > 1) ...[
                        const SizedBox(width: 6),
                        Text(
                          '+${ids.length - 1}',
                          style: TextStyle(
                            fontSize: PB.fsXs,
                            color: PB.textTertiary,
                          ),
                        ),
                      ],
                    ],
                  ),
                ),
              ),
            ),
          ),
        ),
      ],
    );
  }
}
