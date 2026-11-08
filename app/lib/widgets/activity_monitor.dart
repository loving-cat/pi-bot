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
    // ★ 定时器的创建/销毁放到 build 之后做。
    //
    //   build 必须是纯函数：在里面 start/stop Timer 会在每次重建时
    //   产生副作用（调试热重载、父级重建都会走到这里），
    //   而且「提前 return」的那条路径会把表留在跑 —— 明明没人干活，
    //   UI 却每 2.2 秒重建一次。
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

    return Padding(
      padding: const EdgeInsets.only(left: 4, bottom: 6),
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
              doing.isEmpty ? '${bot.name} 正在处理' : '${bot.name} 正在做：$doing',
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
    );
  }
}