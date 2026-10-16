import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../models.dart';
import '../scope.dart';
import '../resizing.dart';
import '../theme.dart';
import '../widgets/room_panel.dart';
import 'chat_screen.dart';
import 'rooms_screen.dart';

/// 外层容器：宽屏左右分栏（左边会话列表 + 右边对话），窄屏走原来的单页导航。
/// 微信 PC 端就是这个形态：切换会话不用来回返回。
class HomeShell extends StatefulWidget {
  const HomeShell({super.key, this.initialRoomId});

  /// 调试用：启动就直接选中某个会话
  final String? initialRoomId;

  @override
  State<HomeShell> createState() => _HomeShellState();
}

class _HomeShellState extends State<HomeShell> {
  String? _selectedId;

  // 两栏宽度都是**可拖的**（用户："内部应该可以控制左右侧边栏的宽度，
  // 而不是固定宽度，整个内部需要是一个弹性布局"）。
  double _leftWidth = 320;
  double _rightWidth = 340;

  static const _leftMin = 240.0;
  static const _leftMax = 480.0;
  static const _rightMin = 280.0;
  static const _rightMax = 560.0;

  /// 聊天区最小宽度 —— 再小就没法看了
  static const _chatMin = 420.0;

  @override
  void initState() {
    super.initState();
    _selectedId = widget.initialRoomId;
  }

  @override
  Widget build(BuildContext context) {
    final state = AppScope.of(context);
    final width = MediaQuery.sizeOf(context).width;
    final wide = width >= kTwoPaneMinWidth;

    // 外部入口（点 @提及 / 引用气泡 / 通知）请求切会话：分栏的选中项在这里，
    // 所以必须在这一层消费掉。取走即清空，只生效一次。
    final panelOpen = state.panelOpen;
    final jump = state.takePendingRoom();
    if (jump != null) {
      if (wide) {
        _selectedId = jump;
      } else {
        Room? target;
        for (final r in state.rooms) {
          if (r.id == jump) {
            target = r;
            break;
          }
        }
        // build 里不能 push，等这一帧画完
        if (target != null) {
          final room = target;
          WidgetsBinding.instance.addPostFrameCallback((_) {
            if (mounted) {
              Navigator.of(
                context,
              ).push(MaterialPageRoute(builder: (_) => ChatScreen(room: room)));
            }
          });
        }
      }
    }

    if (!wide) return RoomsScreen(initialRoomId: widget.initialRoomId);

    // ★ 渲染前先把两栏宽度夹进"当前窗口放得下"的范围。
    //
    //   以前只在**拖动分隔条**时 clamp —— 于是"先把分隔条拖宽、再把窗口缩小"时，
    //   两栏的固定宽度会超过窗口总宽：Expanded 拿到负空间，整个布局崩坏，
    //   而且会**一直保持**（不把分隔条拖回来就恢复不了）。
    //   用户报的"偶发会整个布局混乱"就是这个。
    //   _leftWidth/_rightWidth 仍然是用户的偏好值，只是显示时按可用宽度夹一下。
    final total = width;
    final panelW = panelOpen ? _rightWidth : 0.0;
    final maxLeft = math.max(
      _leftMin,
      math.min(_leftMax, total - _chatMin - panelW - 12),
    );
    final leftW = _leftWidth.clamp(_leftMin, maxLeft);
    final maxRight = math.max(
      _rightMin,
      math.min(_rightMax, total - _chatMin - leftW - 12),
    );
    final rightW = panelOpen ? _rightWidth.clamp(_rightMin, maxRight) : 0.0;

    Room? selected;
    for (final room in state.rooms) {
      if (room.id == _selectedId) selected = room;
    }
    selected ??= state.rooms.isNotEmpty ? state.rooms.first : null;

    return Scaffold(
      backgroundColor: PB.bgApp,
      body: Stack(
        children: [
          Column(
            children: [
              // 顶部拖拽条不在这儿了 —— 它是**全局**的（main.dart 根布局里），
              // 这样 push 出来的页面也自动在它下面，不用各自避让窗口按钮。
              Expanded(
                child: ValueListenableBuilder<bool>(
                  valueListenable: appResizing,
                  builder: (context, resizing, child) {
                    // 拖动期间直接给色块：不做布局也不做光栅。
                    // 这是试验，也是（如果结论是"内容太重"的话）正式方案。
                    // 拖动期间只画**骨架**：三栏的底色 + 分隔线，
                    // 不画任何内容（消息、头像、面板）。
                    // 量过：掉帧从 16 帧/700ms 降到 0-1 帧 —— 用户感觉到的"卡"
                    // 就是那些偶发的 20-26ms 帧。
                    // 之所以保留骨架而不是整窗留白：窗口在拖的时候还能看出结构，
                    // 不会像"程序卡死了"。
                    if (resizing) {
                      return Row(
                        children: [
                          Container(width: leftW, color: PB.bgApp),
                          Container(width: 1, color: PB.borderTertiary),
                          const Expanded(child: SizedBox()),
                          if (panelOpen) ...[
                            Container(width: 1, color: PB.borderTertiary),
                            Container(width: rightW, color: PB.bgPane),
                          ],
                        ],
                      );
                    }
                    return child!;
                  },
                  child: Row(
                    children: [
                      // ★ 包一层 RepaintBoundary：这两栏的宽度是**固定**的，
                      //   窗口缩放时它们只是平移、形状不变 —— 于是光栅结果可以复用。
                      //   不包的话，每一帧整棵树（三个栏）都要重光栅一遍，
                      //   开着右侧面板时尤其明显（用户报的"打开新组件后拖动非常卡"）。
                      RepaintBoundary(
                        child: SizedBox(
                          width: leftW,
                          child: RoomsScreen(
                            embedded: true,
                            selectedId: selected?.id,
                            onSelect: (room) =>
                                setState(() => _selectedId = room.id),
                          ),
                        ),
                      ),
                      _DragHandle(
                        onDrag: (dx) => setState(() {
                          final total = MediaQuery.sizeOf(context).width;
                          final maxByChat =
                              total -
                              _chatMin -
                              (state.panelOpen ? _rightWidth : 0);
                          // ★ clamp 的上下界必须 min ≤ max，否则 Dart 直接抛
                          //   ArgumentError（"Invalid argument(s): Invalid clamp range"）——
                          //   窗口窄 + 面板开着时 maxByChat 会小于 _leftMin，那时候
                          //   一拖就崩。这里先夹出合法的上界。
                          final hi = maxByChat < _leftMin
                              ? _leftMin
                              : (maxByChat < _leftMax ? maxByChat : _leftMax);
                          _leftWidth = (_leftWidth + dx).clamp(_leftMin, hi);
                        }),
                      ),
                      Expanded(
                        child: selected == null
                            ? const _NoSelection()
                            : ChatScreen(
                                key: ValueKey(selected.id),
                                room: selected,
                                embedded: true,
                              ),
                      ),
                      // ★ 右侧详情面板是**布局里的一栏**（点聊天顶部胶囊开关），
                      //   和左边那栏同级：没有遮罩、不盖住聊天，聊天区自己让出宽度。
                      // ★ 面板要**滑出来**，不是咣当一下出现。
                      //   做法：动画容器宽度 0 → 340，里面的内容固定 340 宽、
                      //   用 ClipRect 裁掉超出部分 —— 这样内容不会在动画过程中被挤变形，
                      //   而是像抽屉一样平移进场。
                      //   关的时候反过来（宽度收回 0），同样平滑。
                      // 只在**开着**时才挂载：进场有滑入动画，关闭立即消失。
                      // 关闭不做退场动画是有意的 —— 关东西就该干脆；
                      // 而且挂载着（哪怕宽度是 0）会让面板里的内容一直在树里，
                      // 白占内存、也让"关掉了没"变得说不清。
                      if (panelOpen && selected != null)
                        _DragHandle(
                          // 往左拖 = 面板变宽
                          onDrag: (dx) => setState(() {
                            _rightWidth = (_rightWidth - dx).clamp(
                              _rightMin,
                              _rightMax,
                            );
                          }),
                        ),
                      if (panelOpen && selected != null)
                        TweenAnimationBuilder<double>(
                          duration: const Duration(milliseconds: 240),
                          curve: Curves.easeOutCubic,
                          tween: Tween(begin: 0.0, end: 1.0),
                          builder: (context, t, child) => SizedBox(
                            width: rightW * t,
                            child: ClipRect(
                              child: OverflowBox(
                                alignment: Alignment.centerLeft,
                                minWidth: _rightWidth,
                                maxWidth: _rightWidth,
                                child: child,
                              ),
                            ),
                          ),
                          child: RepaintBoundary(
                            child: RoomPanel(room: selected),
                          ),
                        ),
                    ],
                  ),
                ),
              ),
            ],
          ),
          // 右上角窗口控制按钮和四周缩放热区都在 main.dart 的根布局里 ——
          // 那两样要在配对页也生效，放这儿就只有配对完之后才管用。
        ],
      ),
    );
  }
}

class _NoSelection extends StatelessWidget {
  const _NoSelection();

  @override
  Widget build(BuildContext context) {
    return Container(
      color: PB.bgPane,
      alignment: Alignment.center,
      child: const Column(
        mainAxisAlignment: MainAxisAlignment.center,
        children: [
          Icon(LucideIcons.messageSquare, size: 36, color: PB.textQuaternary),
          SizedBox(height: 14),
          Text(
            '左边选一个会话',
            style: TextStyle(fontSize: PB.fsSm, color: PB.textTertiary),
          ),
        ],
      ),
    );
  }
}

/// 两栏之间的分隔条：**可以拖**，鼠标移上去会亮起来。
///
/// 为什么值得做成可拖：侧边栏多宽取决于你在干什么 —— 找会话时想宽、
/// 看聊天时想窄。写死一个值总有人不合适。
/// 视觉上默认 1px（不抢戏），hover 时加粗成主题色（提示"这儿能拖"）。
class _DragHandle extends StatefulWidget {
  const _DragHandle({required this.onDrag});

  /// 水平拖动量（正数 = 往右）
  final void Function(double dx) onDrag;

  @override
  State<_DragHandle> createState() => _DragHandleState();
}

class _DragHandleState extends State<_DragHandle> {
  bool _hover = false;

  @override
  Widget build(BuildContext context) {
    return MouseRegion(
      cursor: SystemMouseCursors.resizeLeftRight,
      onEnter: (_) => setState(() => _hover = true),
      onExit: (_) => setState(() => _hover = false),
      child: GestureDetector(
        behavior: HitTestBehavior.opaque,
        onHorizontalDragUpdate: (d) => widget.onDrag(d.delta.dx),
        child: SizedBox(
          // 命中区 6px（好点中），视觉上只有 1px 的线
          width: 6,
          child: Center(
            child: AnimatedContainer(
              duration: const Duration(milliseconds: 120),
              width: _hover ? 2 : 1,
              color: _hover
                  ? PB.accent.withValues(alpha: 0.6)
                  : PB.borderTertiary,
            ),
          ),
        ),
      ),
    );
  }
}
