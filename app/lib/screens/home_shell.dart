import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../models.dart';
import '../scope.dart';
import '../theme.dart';
import '../widgets/window_title_bar.dart';
import 'chat_screen.dart';
import 'rooms_screen.dart';

/// 外层容器：宽屏左右分栏（左边会话列表 + 右边对话），窄屏走原来的单页导航。
/// 微信 PC 端 / 同类客户端 就是这个形态，切换会话不用来回返回。
class HomeShell extends StatefulWidget {
  const HomeShell({super.key, this.initialRoomId});

  /// 调试用：启动就直接选中某个会话
  final String? initialRoomId;

  @override
  State<HomeShell> createState() => _HomeShellState();
}

class _HomeShellState extends State<HomeShell> {
  String? _selectedId;

  @override
  void initState() {
    super.initState();
    _selectedId = widget.initialRoomId;
  }

  @override
  Widget build(BuildContext context) {
    final state = AppScope.of(context);
    final width = MediaQuery.sizeOf(context).width;
    final wide = width >= 760;

    if (!wide) return RoomsScreen(initialRoomId: widget.initialRoomId);

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
              // 顶部拖拽条（双击 = 最大化 / 还原），本身不画东西
              const WindowTitleBar(),
              Expanded(
                child: Row(
                  children: [
                    SizedBox(
                      width: 320,
                      child: RoomsScreen(
                        embedded: true,
                        selectedId: selected?.id,
                        onSelect: (room) => setState(() => _selectedId = room.id),
                      ),
                    ),
                    Container(width: 1, color: PB.borderTertiary),
                    Expanded(
                      child: selected == null
                          ? const _NoSelection()
                          : ChatScreen(
                              key: ValueKey(selected.id),
                              room: selected,
                              embedded: true,
                            ),
                    ),
                  ],
                ),
              ),
            ],
          ),
          // 右上角窗口控制按钮，盖在最上层
          if (WindowControlsOverlay.isSupported)
            const Positioned(top: 0, right: 0, child: WindowControlsOverlay()),
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
          Text('左边选一个会话', style: TextStyle(fontSize: PB.fsSm, color: PB.textTertiary)),
        ],
      ),
    );
  }
}
