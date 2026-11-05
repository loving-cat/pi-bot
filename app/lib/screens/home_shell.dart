import 'dart:async';
import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../browser_pane_state.dart';
import '../app_state.dart';
import '../desktop_pane_layout.dart';
import '../models.dart';
import '../scope.dart';
import '../theme.dart';
import '../l10n/l10n.dart';
import '../window_chrome.dart';
import '../widgets/browser_pane.dart';
import '../widgets/attachment_preview_scope.dart';
import '../widgets/attachment_preview_surface.dart';
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
  double _leftWidth = 320;
  double _rightWidth = 340;
  double _browserWidth = 520;
  bool _widthsSynced = false;
  bool _fileInlineAvailable = false;
  int? _pendingFileHandoff;

  @override
  void initState() {
    super.initState();
    _selectedId = widget.initialRoomId;
  }

  @override
  Widget build(BuildContext context) {
    final state = AppScope.of(context);
    return LayoutBuilder(
      builder: (context, constraints) =>
          _buildShell(context, state, constraints.maxWidth),
    );
  }

  Widget _buildShell(BuildContext context, AppState state, double width) {
    final wide = width >= kTwoPaneMinWidth;
    if (!_widthsSynced) {
      _widthsSynced = true;
      _leftWidth = state.layoutLeftWidth;
      _rightWidth = state.layoutRightWidth;
      _browserWidth = state.layoutBrowserWidth;
    }
    final jump = state.takePendingRoom();
    if (jump != null) {
      if (wide) {
        _selectedId = jump;
      } else {
        Room? target;
        for (final room in state.rooms) {
          if (room.id == jump) target = room;
        }
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
    if (!wide) {
      _fileInlineAvailable = false;
      _scheduleFileHandoff(context, state);
      return AttachmentPreviewScope(
        inlineAvailable: false,
        child: RoomsScreen(initialRoomId: widget.initialRoomId),
      );
    }

    Room? selected;
    for (final room in state.rooms) {
      if (room.id == _selectedId) selected = room;
    }
    selected ??= state.rooms.isNotEmpty ? state.rooms.first : null;
    _fileInlineAvailable = canDisplayFileInline(
      width: width,
      panelOpen: state.panelOpen && selected != null,
      leftPreference: _leftWidth,
      panelPreference: _rightWidth,
      browserPreference: _browserWidth,
    );
    _scheduleFileHandoff(context, state);
    final fileInSecondary =
        state.browser.fileRequest != null && !_fileInlineAvailable;
    final layout = resolveDesktopPaneLayout(
      width: width,
      panelOpen: state.panelOpen && selected != null,
      browserOpen: state.browser.open && !fileInSecondary,
      leftPreference: _leftWidth,
      panelPreference: _rightWidth,
      browserPreference: _browserWidth,
    );

    void closeOverlay() {
      if (layout.overlayBrowserWidth > 0) {
        state.closeBrowserPane();
      } else {
        state.closePanel();
      }
    }

    return AttachmentPreviewScope(
      inlineAvailable: _fileInlineAvailable,
      child: Scaffold(
        backgroundColor: PB.bgApp,
        body: Stack(
          children: [
            Row(
              children: [
                RepaintBoundary(
                  child: SizedBox(
                    width: layout.leftWidth,
                    child: WindowChromeRegion(
                      leading: true,
                      trailing: false,
                      child: RoomsScreen(
                        embedded: true,
                        selectedId: selected?.id,
                        onSelect: (room) =>
                            setState(() => _selectedId = room.id),
                      ),
                    ),
                  ),
                ),
                _DragHandle(
                  width: paneDividerWidth,
                  onDrag: (dx) => setState(() {
                    final maxByChat =
                        width -
                        layout.chatMinimum -
                        layout.panelWidth -
                        layout.browserWidth -
                        layout.separators;
                    final hi = math.max(
                      paneLeftMin,
                      math.min(paneLeftMax, maxByChat),
                    );
                    _leftWidth = (layout.leftWidth + dx).clamp(paneLeftMin, hi);
                  }),
                  onDragEnd: () => state.saveLayoutWidths(left: _leftWidth),
                ),
                Expanded(
                  child: WindowChromeRegion(
                    leading: false,
                    trailing:
                        !layout.hasOverlay &&
                        layout.panelWidth == 0 &&
                        layout.browserWidth == 0,
                    child: selected == null
                        ? const _NoSelection()
                        : ChatScreen(
                            key: ValueKey(selected.id),
                            room: selected,
                            embedded: true,
                          ),
                  ),
                ),
                if (layout.panelWidth > 0) ...[
                  _DragHandle(
                    width: paneDividerWidth,
                    onDrag: (dx) => setState(() {
                      _rightWidth = (layout.panelWidth - dx).clamp(
                        panePanelMin,
                        panePanelMax,
                      );
                      state.browser.activity.touched(PaneKind.roomPanel);
                    }),
                    onDragEnd: () => state.saveLayoutWidths(right: _rightWidth),
                  ),
                  _animatedPane(
                    state,
                    selected,
                    PaneKind.roomPanel,
                    layout.panelWidth,
                    trailing: !layout.hasOverlay && layout.browserWidth == 0,
                  ),
                ],
                if (layout.browserWidth > 0) ...[
                  _DragHandle(
                    width: paneDividerWidth,
                    onDrag: (dx) => setState(() {
                      _browserWidth = (layout.browserWidth - dx).clamp(
                        paneBrowserMin,
                        paneBrowserMax,
                      );
                      state.browser.activity.touched(PaneKind.browser);
                    }),
                    onDragEnd: () =>
                        state.saveLayoutWidths(browser: _browserWidth),
                  ),
                  _animatedPane(
                    state,
                    selected,
                    PaneKind.browser,
                    layout.browserWidth,
                    trailing: !layout.hasOverlay,
                  ),
                ],
              ],
            ),
            if (layout.hasOverlay) ...[
              ModalBarrier(
                color: Colors.black38,
                dismissible: !layout.pairedOverlay,
                onDismiss: layout.pairedOverlay ? null : closeOverlay,
                semanticsLabel: layout.pairedOverlay
                    ? null
                    : L10n.s(context).t('shell.closePane'),
              ),
              Positioned(
                top: 0,
                right: 0,
                bottom: 0,
                width: layout.overlayWidth,
                child: Material(
                  elevation: 12,
                  color: PB.bgPane,
                  child: Row(
                    children: [
                      if (layout.overlayBrowserWidth > 0)
                        SizedBox(
                          width: layout.overlayBrowserWidth,
                          child: _pane(
                            state,
                            selected,
                            PaneKind.browser,
                            layout.overlayBrowserWidth,
                            leading:
                                width - layout.overlayWidth <
                                windowChromeControlsReserve,
                            trailing: layout.overlayPanelWidth == 0,
                          ),
                        ),
                      if (layout.pairedOverlay)
                        const VerticalDivider(
                          width: paneDividerWidth,
                          thickness: 1,
                        ),
                      if (layout.overlayPanelWidth > 0)
                        SizedBox(
                          width: layout.overlayPanelWidth,
                          child: _pane(
                            state,
                            selected,
                            PaneKind.roomPanel,
                            layout.overlayPanelWidth,
                            leading:
                                width - layout.overlayPanelWidth <
                                windowChromeControlsReserve,
                            trailing: true,
                          ),
                        ),
                    ],
                  ),
                ),
              ),
            ],
          ],
        ),
      ),
    );
  }

  /// 文件栏缩窄后只安排一次二级预览；新选择或已关闭文件使旧回调失效。
  void _scheduleFileHandoff(BuildContext context, AppState state) {
    final browser = state.browser;
    final request = browser.fileRequest;
    final routeCurrent = ModalRoute.of(context)?.isCurrent ?? true;
    if (_fileInlineAvailable ||
        !routeCurrent ||
        !browser.open ||
        request == null)
      return;
    final revision = browser.navigationRevision;
    if (_pendingFileHandoff == revision) return;
    _pendingFileHandoff = revision;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (_pendingFileHandoff != revision) return;
      _pendingFileHandoff = null;
      if (!mounted ||
          !context.mounted ||
          _fileInlineAvailable ||
          !browser.open ||
          browser.navigationRevision != revision ||
          !identical(browser.fileRequest, request) ||
          ModalRoute.of(context)?.isCurrent == false)
        return;
      state.closeBrowserPane();
      unawaited(showAttachmentSecondary(context, request));
    });
  }

  Widget _animatedPane(
    AppState state,
    Room? room,
    PaneKind kind,
    double width, {
    bool trailing = false,
  }) => TweenAnimationBuilder<double>(
    key: ValueKey(kind),
    duration: const Duration(milliseconds: 240),
    curve: Curves.easeOutCubic,
    tween: Tween(begin: 0.0, end: 1.0),
    builder: (context, t, child) => SizedBox(
      width: width * t,
      child: ClipRect(
        child: OverflowBox(
          alignment: Alignment.centerLeft,
          minWidth: width,
          maxWidth: width,
          child: child,
        ),
      ),
    ),
    child: _pane(state, room, kind, width, trailing: trailing),
  );

  Widget _pane(
    AppState state,
    Room? room,
    PaneKind kind,
    double width, {
    bool leading = false,
    bool trailing = false,
  }) => WindowChromeRegion(
    leading: leading,
    trailing: trailing,
    child: Listener(
      onPointerDown: (_) => state.browser.activity.touched(kind),
      onPointerSignal: (_) => state.browser.activity.touched(kind),
      child: RepaintBoundary(
        child: kind == PaneKind.browser
            ? BrowserPane(state: state.browser, width: width)
            : RoomPanel(room: room!, width: width),
      ),
    ),
  );
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
          const Icon(
            LucideIcons.messageSquare,
            size: 36,
            color: PB.textQuaternary,
          ),
          const SizedBox(height: 14),
          Text(
            L10n.s(context).t('shell.noSelection'),
            style: const TextStyle(fontSize: PB.fsSm, color: PB.textTertiary),
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
  const _DragHandle({required this.onDrag, this.onDragEnd, this.width = 6});

  /// 水平拖动量（正数 = 往右）
  final void Function(double dx) onDrag;

  /// 松手时调一次 —— 用来把最终宽度落盘（拖动过程中不写盘，太频繁）
  final VoidCallback? onDragEnd;

  /// 占位宽度。**必须和 HomeShell 的布局预算用同一个数**，
  /// 否则预算算出来的"刚好放得下"在实际排版时就是放不下。
  final double width;

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
        onHorizontalDragEnd: (_) => widget.onDragEnd?.call(),
        child: SizedBox(
          // 命中区要宽一点才好点中；视觉上仍然只有 1px 的线。
          // 这个宽度会**真的占掉布局空间**，所以布局预算必须按它算。
          width: widget.width,
          child: Center(
            child: AnimatedContainer(
              duration: const Duration(milliseconds: 120),
              width: _hover ? 2 : 1,
              color: _hover
                  ? PB.colors(context).accent.withValues(alpha: 0.6)
                  : PB.borderTertiary,
            ),
          ),
        ),
      ),
    );
  }
}
