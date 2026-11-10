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

  // ★ 让 pane 的 Element/State 跟着**迁移**而不是销毁重建。
  //
  //   同一个 pane 在并排模式（Row → _animatedPane → _pane）和浮层模式
  //   （Stack → Positioned → _pane）下挂在完全不同的父链上。没有 GlobalKey 时，
  //   父链一换 Flutter 就 dispose 旧子树再 init 新的：
  //     · 浏览器是无痕 WebView —— 重建后白屏重载、丢滚动和表单，还容易掉登录
  //     · RoomPanel 的任务详情、记忆 tab 一起丢
  //   默认窗口约 1180px 就能踩中（两个 pane 都开时阈值约 1198px）。
  //
  //   加上 GlobalKey 后 Element（含 InAppWebView 的平台视图）会整体迁过去。
  //
  //   同一帧里同一个 kind 只能出现在一处：并排和浮层互斥（见 _buildShell 的 assert）。
  final _browserPaneKey = GlobalKey(debugLabel: 'shell-browser-pane');
  final _roomPanelKey = GlobalKey(debugLabel: 'shell-room-panel');

  // ★ 拖动分隔条时缓存子树 widget 实例。
  //
  //   拖一下每帧都 setState，_buildShell 每次都会 new 出 RoomsScreen、
  //   RoomPanel、BrowserPane —— Element.updateChild 看到 widget 实例变了
  //   就会 rebuild 整棵子树。输入（参数）没变时返回**同一个实例**，
  //   Flutter 会判定「widget 没变」直接跳过 rebuild。
  //
  //   能省的是：会话列表、右栏、以及它们下面的所有东西。
  //   聊天栏本身的宽度在变，可见气泡必须经 LayoutBuilder 重排，这块省不掉。
  //
  //   ★ 依赖一个前提：主题切换会整树重挂（main.dart 里那个
  //     ValueListenableBuilder + KeyedSubtree）。缓存只在**本地 setState**
  //     （拖动、选会话）的帧里生效；一旦主题/语言/MediaQuery 变化，
  //     didChangeDependencies 会先清空缓存，行为和改前一致。
  //     以后如果改掉 main.dart 那个「整树重挂」机制，这里的缓存会让
  //     颜色/文案停在旧值上 —— 到时候必须一并清缓存。
  RoomsScreen? _cachedRooms;
  String? _cachedRoomsSelectedId;
  Widget? _cachedRoomPanel;
  String? _cachedRoomPanelRoomId;
  double? _cachedRoomPanelWidth;
  bool? _cachedRoomPanelTrailing;
  Widget? _cachedBrowserPane;
  double? _cachedBrowserPaneWidth;
  bool? _cachedBrowserPaneTrailing;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    // 依赖变了（主题 / 语言 / MediaQuery / AppScope 通知）→ 缓存全部作废，
    // 走和改前完全一样的重建路径。
    _cachedRooms = null;
    _cachedRoomsSelectedId = null;
    _cachedRoomPanel = null;
    _cachedRoomPanelRoomId = null;
    _cachedRoomPanelWidth = null;
    _cachedRoomPanelTrailing = null;
    _cachedBrowserPane = null;
    _cachedBrowserPaneWidth = null;
    _cachedBrowserPaneTrailing = null;
  }

  /// 参数没变就返回上一次的实例，让 Element.updateChild 跳过 rebuild。
  Widget _roomsPane(AppState state, String? selectedId) {
    if (_cachedRooms != null && _cachedRoomsSelectedId == selectedId) {
      return _cachedRooms!;
    }
    _cachedRoomsSelectedId = selectedId;
    return _cachedRooms = RoomsScreen(
      embedded: true,
      selectedId: selectedId,
      onSelect: (room) => setState(() => _selectedId = room.id),
    );
  }

  Widget _browserPane(
    AppState state,
    double width, {
    required bool trailing,
  }) {
    if (_cachedBrowserPane != null &&
        _cachedBrowserPaneWidth == width &&
        _cachedBrowserPaneTrailing == trailing) {
      return _cachedBrowserPane!;
    }
    _cachedBrowserPaneWidth = width;
    _cachedBrowserPaneTrailing = trailing;
    return _cachedBrowserPane = _pane(
      state,
      null,
      PaneKind.browser,
      width,
      trailing: trailing,
    );
  }

  Widget _roomPanelPane(
    AppState state,
    Room room,
    double width, {
    required bool trailing,
  }) {
    if (_cachedRoomPanel != null &&
        _cachedRoomPanelRoomId == room.id &&
        _cachedRoomPanelWidth == width &&
        _cachedRoomPanelTrailing == trailing) {
      return _cachedRoomPanel!;
    }
    _cachedRoomPanelRoomId = room.id;
    _cachedRoomPanelWidth = width;
    _cachedRoomPanelTrailing = trailing;
    return _cachedRoomPanel = _pane(
      state,
      room,
      PaneKind.roomPanel,
      width,
      trailing: trailing,
    );
  }

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

    // ★ 同一个 pane 在同一帧里只能出现一处 —— 否则两个 GlobalKey 会撞。
    //   并排（panelWidth/browserWidth > 0）和浮层（overlay*Width > 0）互斥，
    //   这条 assert 就是用来守住这个前提的：以后改布局算法时它先炸，
    //   而不是等到 WebView 白屏才发现。
    assert(() {
      final panelBoth =
          layout.panelWidth > 0 && layout.overlayPanelWidth > 0;
      final browserBoth =
          layout.browserWidth > 0 && layout.overlayBrowserWidth > 0;
      return !panelBoth && !browserBoth;
    }(), '同一个 pane 不能同时出现在并排和浮层两处');

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
                      child: _roomsPane(state, selected?.id),
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
                  // 缓存版：宽度和会话没变就复用同一个实例（见 _roomPanelPane）
                  _animatedPaneWith(
                    kind: PaneKind.roomPanel,
                    width: layout.panelWidth,
                    child: _roomPanelPane(
                      state,
                      selected!,
                      layout.panelWidth,
                      trailing: !layout.hasOverlay && layout.browserWidth == 0,
                    ),
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
                  _animatedPaneWith(
                    child: _browserPane(
                      state,
                      layout.browserWidth,
                      // 并排且浏览器是最右 pane 时要给窗口按钮让位（非 macOS 用）
                      trailing: !layout.hasOverlay,
                    ),
                    kind: PaneKind.browser,
                    width: layout.browserWidth,
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
                        // 显式传颜色 + 不用 const：
                        // const 实例在编译期固化，切换明暗时不会重新求值，
                        // 中间这条分隔线会一直停在旧颜色上。
                        VerticalDivider(
                          width: paneDividerWidth,
                          thickness: 1,
                          color: PB.borderTertiary,
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

  /// 展开动画外壳；内容由调用方先构建好（可能是缓存实例）。
  Widget _animatedPaneWith({
    required Widget child,
    required PaneKind kind,
    required double width,
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
    child: child,
  );

  Widget _pane(
    AppState state,
    Room? room,
    PaneKind kind,
    double width, {
    bool leading = false,
    bool trailing = false,
  }) => KeyedSubtree(
    // 并排 ↔ 浮层切换时靠这个 GlobalKey 保住子树（见字段处说明）
    key: kind == PaneKind.browser ? _browserPaneKey : _roomPanelKey,
    child: WindowChromeRegion(
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
          Icon(
            LucideIcons.messageSquare,
            size: 36,
            color: PB.textQuaternary,
          ),
          const SizedBox(height: 14),
          Text(
            L10n.s(context).t('shell.noSelection'),
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
