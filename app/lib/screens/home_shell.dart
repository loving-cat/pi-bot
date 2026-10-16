import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import 'package:window_manager/window_manager.dart';

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
              // 无边框窗口的拖拽条（双击 = 最大化/还原）
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
          // 窗口控制按钮用固定定位盖在最上层。
          // 注：试过封装成单独的组件（带 MouseRegion/GestureDetector 的），
          // 在无边框窗口下整个子树不渲染；内联 IconButton 反而稳定，所以就这样。
          if (WindowTitleBar.isSupported)
            Positioned(
              top: 4,
              right: 8,
              child: Row(
                mainAxisSize: MainAxisSize.min,
                children: [
                  IconButton(
                    tooltip: '最小化',
                    iconSize: 15,
                    padding: EdgeInsets.zero,
                    visualDensity: VisualDensity.compact,
                    constraints: const BoxConstraints(minWidth: 32, minHeight: 32),
                    onPressed: () => windowManager.minimize(),
                    icon: Icon(LucideIcons.minus, color: PB.textSecondary),
                  ),
                  IconButton(
                    tooltip: '最大化 / 还原',
                    iconSize: 14,
                    padding: EdgeInsets.zero,
                    visualDensity: VisualDensity.compact,
                    constraints: const BoxConstraints(minWidth: 32, minHeight: 32),
                    onPressed: () async {
                      if (await windowManager.isMaximized()) {
                        await windowManager.unmaximize();
                      } else {
                        await windowManager.maximize();
                      }
                    },
                    icon: Icon(LucideIcons.square, color: PB.textSecondary),
                  ),
                  IconButton(
                    tooltip: '关闭',
                    iconSize: 15,
                    padding: EdgeInsets.zero,
                    visualDensity: VisualDensity.compact,
                    constraints: const BoxConstraints(minWidth: 32, minHeight: 32),
                    onPressed: () => windowManager.close(),
                    icon: Icon(LucideIcons.x, color: PB.textSecondary),
                  ),
                  const SizedBox(width: 4),
                ],
              ),
            ),
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
      child: Column(
        mainAxisAlignment: MainAxisAlignment.center,
        children: [
          Icon(LucideIcons.messagesSquare, size: 40, color: PB.textQuaternary),
          const SizedBox(height: 14),
          const Text(
            '左边选一个会话',
            style: TextStyle(fontSize: PB.fsSm, color: PB.textTertiary),
          ),
        ],
      ),
    );
  }
}
