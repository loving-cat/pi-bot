import 'dart:async';

import 'package:flutter/material.dart';

import '../scope.dart';
import '../theme.dart';

/// 输入框左上角的「谁在干活」轮播。
///
/// 多 Agent 后台干活时，用户最想知道两件事：现在**有没有人在干**、**是谁**。
/// 这里把正在执行的 Bot 名字轮流显示出来，带一个转圈动画；没人干活就整块隐藏，
/// 不占位置。
class ActivityMonitor extends StatefulWidget {
  const ActivityMonitor({super.key, required this.roomId, this.tasks = const []});

  final String roomId;

  /// 这个会话的活跃任务（用来显示「在做哪件事」）。
  final List<String> tasks;

  @override
  State<ActivityMonitor> createState() => _ActivityMonitorState();
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
    final doing = widget.tasks.isNotEmpty
        ? widget.tasks[_index % widget.tasks.length]
        : '';

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
    return Align(
      alignment: Alignment.centerLeft,
      heightFactor: 1,
      child: Padding(
        padding: const EdgeInsets.only(left: 4, top: 2, bottom: 8),
        child: Center(
        child: Container(
          padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 5),
          decoration: BoxDecoration(
            // ★ 必须是不透明实底。
            //
            //   透明胶囊悬浮在消息上层时，下面的正文会从胶囊里透出来，
            //   文字叠文字 —— 用户明确反馈了这个重叠问题。
            //   用比面板略亮一档的 bgElevated + 阴影，既遮住下面又能浮起来。
            color: PB.bgElevated,
            borderRadius: BorderRadius.circular(999),
            border: Border.all(color: PB.borderTertiary),
            boxShadow: PB.shadow(y: 2, blur: 10, alpha: 0.35),
          ),
          child: Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              SizedBox(
                width: 11,
                height: 11,
                child: CircularProgressIndicator(
                  strokeWidth: 1.6,
                  color: PB.textTertiary,
                ),
              ),
              const SizedBox(width: 7),
              AnimatedSwitcher(
                  duration: const Duration(milliseconds: 260),
                  child: Text(
                    doing.isEmpty
                        ? '${bot.name} 正在处理'
                        : '${bot.name} 正在做：$doing',
                    key: ValueKey('$current|$doing'),
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: TextStyle(fontSize: PB.fsXs, color: PB.textTertiary),
                  ),
                ),
              if (ids.length > 1) ...[
                const SizedBox(width: 6),
                Text(
                  '+${ids.length - 1}',
                  style: TextStyle(fontSize: PB.fsXs, color: PB.textTertiary),
                ),
              ],
            ],
          ),
        ),
        ),
      ),
    );
  }
}
