import 'dart:async';
import 'dart:io';
import 'dart:math' as math;

import 'package:desktop_drop/desktop_drop.dart';
import 'package:flutter/gestures.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:file_picker/file_picker.dart';
import 'package:image_picker/image_picker.dart';

import '../app_state.dart';
import '../chat_input_action.dart';
import '../l10n/l10n.dart';
import '../chat_scroll_follow.dart';
import '../clipboard_image.dart';
import '../models.dart';
import '../paste_paths.dart';
import '../progress_messages.dart';
import '../scope.dart';
import '../desktop_shortcuts.dart';
import '../theme.dart';
import '../window_chrome.dart';
import '../widgets/message_anchor_rail.dart';
import '../widgets/no_scrollbar.dart';
import '../widgets/toast.dart';
import '../widgets/anchored_menu.dart';
import '../widgets/activity_monitor.dart';
import '../widgets/attachment_view.dart';
import '../widgets/avatar_life.dart';
import '../widgets/ask_card.dart';
import '../widgets/approval_card.dart';
import '../widgets/blob_avatar.dart';
import '../widgets/context_chip.dart';
import '../widgets/floating_menu.dart';
import '../widgets/md_text.dart';
import '../widgets/progress_notice.dart';
import '../widgets/msg_quote_strip.dart';
import '../widgets/msg_ref_chip.dart';
import '../widgets/changed_files.dart';
import '../widgets/task_board.dart';
import '../widgets/automation_sheet.dart';
import '../widgets/tool_steps.dart';
import '../widgets/browser_pane.dart';
import '../widgets/room_panel.dart';
import '../widgets/message_actions.dart';
import '../widgets/teach_dialog.dart';

import 'package:lucide_icons_flutter/lucide_icons.dart';

/// 列表显示顺序：把「还在思考」的流式占位（还没有一个字）挪到最底部。
///
/// 并发群里，先开始、后完成的 bot 的占位本来排在前面；后完成的 bot 内容一长，
/// 就会把还空着的占位顶到上面 —— 用户看起来像"它还在想，但被压上去了/卡住了"。
/// 只影响显示顺序，不影响消息本身的时间顺序。
List<Msg> displayOrderMsgs(List<Msg> msgs) => [
  // 还在进行中（流式 / 重试）且暂时没内容的，排到最后 ——
  // 否则它会插在历史消息中间，看起来像一条空记录。
  ...msgs.where((m) => !(m.isLive && m.text.trim().isEmpty)),
  ...msgs.where((m) => m.isLive && m.text.trim().isEmpty),
];

class ChatScreen extends StatefulWidget {
  const ChatScreen({
    super.key,
    required this.room,
    this.initialText,
    this.embedded = false,
  });

  final Room room;
  final String? initialText;

  /// 宽屏分栏里嵌在右边时，不显示返回键
  final bool embedded;

  @override
  State<ChatScreen> createState() => _ChatScreenState();
}

class _ChatScreenState extends State<ChatScreen> with WidgetsBindingObserver {
  /// 任务按钮的锚点：任务浮层要贴着它弹出。
  final _taskAnchor = GlobalKey();

  /// 上一次已经提示过的错误"指纹"：同样的原因不再重复弹窗。
  String? _lastToastedErrorKey;

  /// 错误指纹：把变化的部分（次数、耗时、数字）抹掉，只留原因。
  ///
  /// 这样「接口不稳定（第 2 次）」和「接口不稳定（第 3 次）」算同一个原因，
  /// 只提示一次；而「接口不稳定」和「key 已失效」是不同的，会各提示一次。
  static String _errorDedupeKey(String message) {
    return message
        .replaceAll(RegExp(r'第\s*\d+\s*次'), '')
        .replaceAll(RegExp(r'\d+(?:\.\d+)?\s*(?:ms|s|秒|毫秒)'), '')
        .replaceAll(RegExp(r'HTTP\s*\d{3}'), 'HTTP')
        .replaceAll(RegExp(r'\s+'), ' ')
        .trim();
  }

  /// 三个点按钮的锚点：更多菜单要贴着它弹出。
  final _moreAnchor = GlobalKey();

  final _scroll = ScrollController();

  /// 右侧滚动滑块。滚动通知只能从包着 ListView 的那层转给它 ——
  /// 它在 Stack 里是 ListView 的兄弟节点，自己收不到 Scroll 通知。
  final GlobalKey<MessageAnchorRailState> _railKey =
      GlobalKey<MessageAnchorRailState>();

  /// 上一次触发追底时的"内容指纹"（条数 + 末条 id + 末条长度）。
  /// 内容没变就不重复追底，避免流式输出期间每帧都排一轮。
  String? _lastFollowKey;
  final _input = TextEditingController();
  final _focus = FocusNode();
  AppState? _state;
  late final ChatScrollFollow _scrollFollow;
  bool get _stick => _scrollFollow.following;

  /// 往上翻的时候又来了几条新消息 —— 显示在"回到底部"那个按钮上。
  /// 这样用户知道"下面有多少没看"，而不是只看到一个箭头。
  int _unreadWhileUp = 0;
  String? _lastMsgId;
  String? _shownError;
  final List<Attachment> _pending = [];
  bool _uploading = false;

  /// 正在把文件拖到窗口上（给一个明确的落点提示）
  bool _draggingOver = false;

  /// 防止“粘贴路径 → 转附件”自己重入（清空文本也会触发监听）
  bool _convertingPaste = false;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _scrollFollow = ChatScrollFollow(
      _scroll,
      onFollowingChanged: (following) {
        if (!mounted) return;
        setState(() {
          if (following) _unreadWhileUp = 0;
        });
      },
    );
    if (widget.initialText != null) {
      _input.text = widget.initialText!;
      _input.selection = TextSelection.collapsed(offset: _input.text.length);
    }
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    // ★ 粘贴的是**文件路径**就自动变成附件。
    //
    //   为什么不拦 Ctrl+V：剪贴板要异步读，按键处理里没法同步判断"这是不是文件名" ——
    //   强行拦会把正常粘贴文字也挡掉。所以让它先正常粘进输入框，
    //   然后看一眼：如果整段就是一个（或几个）存在的文件路径，就收成附件。
    //   在资源管理器里复制文件、粘到这儿，就是这个形态。
    _input.addListener(_absorbPastedPaths);
    if (_state == null) {
      _state = AppScope.read(context);
      _state!.openRoom(widget.room.id);
      unawaited(_state!.loadMessages(widget.room.id));
      // 切换会话会销毁当前 ChatScreen；这里先接草稿监听，再恢复上次输入。
      _input.addListener(_saveDraft);
      if (widget.initialText == null) {
        final draft = _state!.draftFor(widget.room.id);
        if (draft.isNotEmpty) {
          _input.text = draft;
          _input.selection = TextSelection.collapsed(offset: draft.length);
        }
      }
      // 新消息计数：只在"往上翻着"的时候累加。
      // 用 state 的 notify（每来一条消息一次），不用 streamTick（那是 80ms 一次的
      // 流式增量，会把计数冲成天文数字）。
      _state!.addListener(_countIfScrolledUp);
      FocusManager.instance.addListener(_onFocusChanged);
    }
  }

  void _saveDraft() {
    _state?.setDraft(widget.room.id, _input.text);
  }

  void _countIfScrolledUp() {
    final list = _state?.messages[widget.room.id] ?? const [];
    final lastId = list.isEmpty ? null : list.last.id;
    if (lastId == _lastMsgId) return;
    _lastMsgId = lastId;
    if (!_stick && mounted) setState(() => _unreadWhileUp++);
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    _state?.removeListener(_countIfScrolledUp);
    FocusManager.instance.removeListener(_onFocusChanged);
    _state?.openRoom(null);
    _scrollFollow.dispose();
    _scroll.dispose();
    _input.removeListener(_absorbPastedPaths);
    _input.removeListener(_saveDraft);
    _state?.setDraft(widget.room.id, _input.text);
    _input.dispose();
    _focus.dispose();
    super.dispose();
  }

  /// 焦点一变就排一次"兜底检查"。
  ///
  /// 为什么不能只在 build 里排：焦点丢了**不等于界面要重建** ——
  /// 比如回车提交之后，Flutter 不会因为焦点变化就把整个 ChatScreen 重build，
  /// 于是那时候注册的帧后回调根本不会跑。
  void _onFocusChanged() {
    // 延后一帧再判：对话框 / 悬浮菜单通常在同一帧里就把焦点拿走了，
    // 等一帧再看，能少抢很多次
    WidgetsBinding.instance.addPostFrameCallback((_) => _keepComposerFocused());
  }

  /// 点了但没拖动？（拖是选字，不能打断）
  Offset? _tapDown;
  DateTime _tapAt = DateTime.now();

  /// 把**文本输入连接**重开一次。
  ///
  /// 解决的问题：发送第一条消息后想输入第二条，输入框没有聚焦、
  /// 点击也无效，直接没法输入。
  ///
  /// 其实**点击是能聚焦的** —— 边框变亮、光标也出来了。所以不是"点不动"，
  /// 是**键盘输入这条路断了**：Dart 侧 `hasFocus` 还是 true，但引擎那边的
  /// 文本输入连接已经废了，键盘事件根本到不了 Dart。
  ///
  /// 为什么"再点一下"救不回来：输入框**已经**聚焦了，没有状态变化，
  /// 引擎不会重新 attach。必须先 unfocus、下一帧再 requestFocus，
  /// 才会有一次真正的 detach/attach。
  void _reattachInput() {
    if (!mounted || !_focus.hasFocus) return;
    _focus.unfocus();
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) _focus.requestFocus();
    });
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    super.didChangeAppLifecycleState(state);
    // 窗口重新激活时顺手重连一次 —— 从别的程序切回来最容易碰上这个状态
    if (state == AppLifecycleState.resumed) _reattachInput();
  }

  /// 点了输入框（但没拖）但键盘还是没反应 —— 顺手重连一次。
  ///
  /// 拖不算（拖是选中文字，不能打断）；没聚焦时也不插手，
  /// 让正常的“点一下聚焦”自己走。
  Widget _tapToReattach(Widget child) {
    return Listener(
      // translucent：自己看得到事件，子控件（输入框、发送键）一样收得到
      behavior: HitTestBehavior.translucent,
      onPointerDown: (e) {
        _tapDown = e.position;
        _tapAt = DateTime.now();
      },
      onPointerUp: (e) {
        final down = _tapDown;
        _tapDown = null;
        if (down == null) return;
        if ((e.position - down).distance > 6) return;
        if (DateTime.now().difference(_tapAt) >
            const Duration(milliseconds: 600)) {
          return;
        }
        _reattachInput();
      },
      child: child,
    );
  }

  /// 把焦点兜回输入框 —— 但**只在"无主"时**。
  ///
  /// 为什么需要：回车提交之后框架会先把焦点从输入框收走；如果这时没有别的控件
  /// 接管，焦点就落在"空"上，得再点一下输入框才能接着打。
  ///
  /// 三条不抢的规则（避免把别人的焦点抢歪）：
  ///   · 上面压着别的页面（设置页）→ 不抢
  ///   · 当前焦点在一个**具体控件**上（对话框输入框、悬浮菜单的 Focus）→ 不抢
  ///   · 焦点已经在自己身上 → 不用抢
  /// 只有"焦点落在空 scope 上"（也就是没人要）时才拿回来。
  void _keepComposerFocused() {
    if (!mounted || _focus.hasFocus) return;
    final route = ModalRoute.of(context);
    if (route != null && !route.isCurrent) return;
    final primary = FocusManager.instance.primaryFocus;
    // ★ 判"有没有人持有焦点"要看**类型**，不要看 context.widget：
    //   `unfocus()` 之后主焦点会落到祖先的 FocusScopeNode 上（那就是"无主"），
    //   而 FocusScope 这个 widget 在树里不一定就是 FocusScope 类型 ——
    //   按 context.widget 判会误判成"有人持有"，兜底就永远不生效。
    if (primary != null && primary is! FocusScopeNode) return;
    _focus.requestFocus();
  }

  Future<void> _send({bool flushMerge = true}) async {
    final text = _input.text;
    final files = List<Attachment>.from(_pending);
    if (text.trim().isEmpty && files.isEmpty) return;
    _input.clear();
    setState(() => _pending.clear());
    _scrollFollow.resume();
    final state = AppScope.read(context);
    try {
      await state.sendMessage(
        widget.room.id,
        text,
        attachments: files,
        // ★ 用户还在连续输入（打完一句立刻接着下一句）→ 让服务端攒一下，
        //   把这几条合成一段给模型，它才能看懂完整意图。
        //   明确按发送/回车 → 立刻投递，一秒都不多等。
        flushMerge: flushMerge,
      );
    } catch (err) {
      if (mounted) {
        toast(context, '$err');
        _input.text = text;
        setState(() => _pending.addAll(files));
      }
    } finally {
      // 发完继续留着焦点，方便接着敲。
      // 但如果正处在"还聚焦着、键盘却没反应"的状态，单纯 requestFocus
      // 不顶用（没有状态变化 → 引擎不重连），得把连接重开一次。
      if (mounted) {
        if (_focus.hasFocus) {
          _reattachInput();
        } else {
          _focus.requestFocus();
        }
      }
    }
  }

  Future<void> _pickImages() async {
    final s = L10n.s(context);
    try {
      final picked = await ImagePicker().pickMultiImage(imageQuality: 88);
      if (picked.isEmpty) return;
      await _uploadAll(picked.map((x) => (x.name, x.readAsBytes)).toList());
    } catch (err) {
      _toast(s.tf('chat.pickImageFailed', {'error': err}));
    }
  }

  Future<void> _pickFiles() async {
    final s = L10n.s(context);
    try {
      final result = await FilePicker.platform.pickFiles(
        withData: true,
        allowMultiple: true,
      );
      if (result == null || result.files.isEmpty) return;
      final items = <(String, Future<List<int>> Function())>[];
      for (final f in result.files) {
        if (f.bytes == null) continue;
        final bytes = f.bytes!;
        items.add((f.name, () async => bytes));
      }
      await _uploadAll(items);
    } catch (err) {
      _toast(s.tf('chat.pickFileFailed', {'error': err}));
    }
  }

  /// 粘贴进来的路径 → 收成附件（图片、PDF、Word 都行；一次粘多个也认）。
  ///
  /// 两种形态：整段就是路径（Finder 复制文件后粘贴），或路径混在文字里
  /// （"看下 /Users/x/a.pdf 这个"）。后者只摘出真实存在的文件，其余文字留在输入框。
  /// 解析逻辑在 paste_paths.dart，那边能单独测。
  void _absorbPastedPaths() {
    if (_convertingPaste) return;
    final result = extractPastedFiles(_input.text);
    if (!result.hasFiles) return;

    _convertingPaste = true;
    final kept = result.remainingText;
    if (kept.isEmpty) {
      _input.clear();
    } else {
      _input.text = kept;
      _input.selection = TextSelection.collapsed(offset: kept.length);
    }
    _convertingPaste = false;

    unawaited(
      _uploadAll([
        for (final f in result.files)
          (f.uri.pathSegments.last, () => f.readAsBytes()),
      ]),
    );
  }

  /// 把拖进来的东西展开成 (名字, 读字节) 列表。
  ///
  /// · 普通文件 → 原样
  /// · 文件夹 → **递归展开**，名字带上相对路径（`项目/README.md`），
  ///   这样 bot 能看出目录结构，而不是一堆平铺的文件名。
  ///   跳过 node_modules / .git / __pycache__ 这类噪音目录 ——
  ///   拖个代码仓库进来，要的是源码，不是几万个依赖文件。
  ///   单个文件夹最多收 200 个文件：再多说明拖错东西了（比如整个主目录），
  ///   全部上传只会把服务端和上下文都撑爆。
  static const _skipDirs = {
    'node_modules',
    '.git',
    '__pycache__',
    '.venv',
    'venv',
    'dist',
    'build',
    '.dart_tool',
    '.idea',
    '.vscode',
    'target',
  };
  static const _maxFolderFiles = 200;

  List<(String, Future<List<int>> Function())> _expandDroppedPaths(
    List<String> paths,
  ) {
    final out = <(String, Future<List<int>> Function())>[];
    for (final p in paths) {
      final dir = Directory(p);
      if (dir.existsSync()) {
        _collectDir(dir, p, '', out);
        continue;
      }
      final f = File(p);
      if (f.existsSync()) {
        out.add((f.uri.pathSegments.last, () => f.readAsBytes()));
      }
    }
    return out;
  }

  void _collectDir(
    Directory dir,
    String root,
    String rel,
    List<(String, Future<List<int>> Function())> out,
  ) {
    if (out.length >= _maxFolderFiles) return;
    final List<FileSystemEntity> children;
    try {
      children = dir.listSync(followLinks: false);
    } catch (_) {
      return; // 没权限读的目录直接跳过
    }
    // 先文件后子目录，顺序稳定
    final files = <File>[];
    final dirs = <Directory>[];
    for (final c in children) {
      if (c is File)
        files.add(c);
      else if (c is Directory)
        dirs.add(c);
    }
    for (final f in files) {
      if (out.length >= _maxFolderFiles) return;
      final name = rel.isEmpty
          ? f.uri.pathSegments.last
          : '$rel/${f.uri.pathSegments.last}';
      out.add((name, () => f.readAsBytes()));
    }
    for (final d in dirs) {
      if (out.length >= _maxFolderFiles) return;
      final base = d.uri.pathSegments.where((s) => s.isNotEmpty).last;
      if (_skipDirs.contains(base)) continue;
      _collectDir(d, root, rel.isEmpty ? base : '$rel/$base', out);
    }
  }

  Future<void> _uploadAll(
    List<(String, Future<List<int>> Function())> items,
  ) async {
    final state = AppScope.read(context);
    setState(() => _uploading = true);
    try {
      for (final (name, read) in items) {
        final bytes = await read();
        final att = await state.uploadFile(bytes, name);
        if (att != null && mounted) setState(() => _pending.add(att));
      }
    } finally {
      if (mounted) setState(() => _uploading = false);
    }
  }

  void _toast(String message) {
    if (!mounted) return;
    toast(context, message);
  }

  /// 「更多」菜单：停止 / 开新会话 / 定时任务 / 重新拉取。
  ///
  /// 用锚定浮层而不是 PopupMenuButton：后者的落点不受控制，
  /// 会盖住触发它的按钮，也和其它浮层不统一。
  Future<void> _showMoreMenu(
    BuildContext context,
    AppState state,
    Room room,
    bool busy,
    AppStrings s,
  ) async {
    await showAnchoredMenu(
      context: context,
      anchorKey: _moreAnchor,
      items: [
        if (busy)
          AnchoredMenuItem(
            icon: LucideIcons.square,
            title: s.t('chat.stopTurn'),
            onTap: () => state.abort(room.id),
          ),
        AnchoredMenuItem(
          icon: LucideIcons.refreshCw,
          title: s.t('chat.resetMenu'),
          onTap: () async {
            final ok = await showDialog<bool>(
              context: context,
              builder: (ctx) => AlertDialog(
                title: Text(L10n.s(ctx).t('chat.newSession')),
                content: Text(L10n.s(ctx).t('chat.newSessionBody')),
                actions: [
                  TextButton(
                    onPressed: () => Navigator.pop(ctx, false),
                    child: Text(L10n.s(ctx).t('common.cancel')),
                  ),
                  FilledButton(
                    onPressed: () => Navigator.pop(ctx, true),
                    child: Text(L10n.s(ctx).t('chat.newSession')),
                  ),
                ],
              ),
            );
            if (ok == true) await state.resetSession(room.id);
          },
        ),
        // ★ 唯一能主动打开浏览器栏的入口。
        //
        //   原来只能点聊天里的链接把栏带出来 —— 栏有地址栏、能前进后退，
        //   却没有任何入口打开它，想搜个网址都做不到。
        //
        //   宽屏走右栏；窄屏右栏根本不存在（HomeShell 直接返回会话列表），
        //   所以改成整页打开 —— 否则状态变了但屏幕上什么都看不到。
        //
        //   ★ 判断条件必须和上面「切右侧面板」那一处一致（embedded && 宽屏）。
        //     只看宽度不够：从助手列表 Navigator.push 出来的私聊页盖在 HomeShell
        //     上面，这时改 AppState 只会让下层的右栏打开 —— 用户眼前什么都看不到，
        //     还以为点了没反应。
        AnchoredMenuItem(
          icon: LucideIcons.globe,
          title: s.t('chat.openBrowser'),
          onTap: () {
            final twoPane =
                widget.embedded &&
                MediaQuery.sizeOf(context).width >= kTwoPaneMinWidth;
            if (twoPane) {
              state.openBrowserPane();
              return;
            }
            Navigator.of(context).push(
              MaterialPageRoute(
                builder: (ctx) => _FullPageBrowser(state: state),
              ),
            );
          },
        ),
        AnchoredMenuItem(
          icon: LucideIcons.clock,
          title: s.t('chat.automations'),
          onTap: () => showAutomationSheet(context, state, room),
        ),
        AnchoredMenuItem(
          icon: LucideIcons.download,
          title: s.t('chat.reloadMessages'),
          onTap: () async {
            await state.loadMessages(room.id, force: true);
            _scrollFollow.resume();
          },
        ),
      ],
    );
  }

  @override
  Widget build(BuildContext context) {
    final s = L10n.s(context);
    final state = AppScope.of(context);
    final room = state.rooms.firstWhere(
      (r) => r.id == widget.room.id,
      orElse: () => widget.room,
    );
    final msgs = state.messages[room.id] ?? const <Msg>[];
    // ★ 并发时"还在思考"的占位（streaming 且一个字都没有）统一挪到列表最底部，
    //   否则先开始、后完成的 bot 的占位会被后完成 bot 的长内容顶上去。
    final display = displayOrderMsgs(msgs);
    final progressGroups = groupProgressMessages(display);

    // ★ Key → index 表，喂给 ListView.builder 的 findChildIndexCallback。
    //
    //   列表项本来就有 ValueKey(msg.id) / ValueKey('progress-…')，但**只有 key
    //   没有回调**时，Flutter 仍按 index 对位：一旦消息重排（占位消息写出第一个字
    //   后跳回时间位置、insertBefore、msg.moved、用户发消息时末尾占位后移），
    //   同一 index 上是另一条消息，key 对不上 → 旧元素销毁、新元素 init →
    //   _Appear 的 240ms 入场动画重播。群聊多个 bot 并发时能看到最新几条闪跳。
    //
    //   有了回调，delegate 会先解开 _SaltedValueKey、拿着 item 原来的 key 来问
    //   「它现在在第几个」，元素就能跟着挪而不是重建。
    final keyIndex = <Key, int>{
      for (var i = 0; i < display.length; i++)
        if (!display[i].isProgress)
          ValueKey(display[i].id): i
        else if (progressGroups[i] != null)
          ValueKey('progress-${display[i].id}'): i,
    };
    final busy = state.typing[room.id] == true;
    final lead =
        state.botById(room.leadBotId) ??
        state.botById(room.botIds.isNotEmpty ? room.botIds.first : null);

    if (state.lastError != null && state.lastError != _shownError) {
      _shownError = state.lastError;
      final message = _shownError!;
      // ★ 同一原因只提示一次。
      //
      //   key 不稳时接口会连着失败好几次，每次都弹一遍 toast，
      //   用户看到的就是"弹窗刷屏"。第一次已经说清楚了，
      //   后面同样的内容再弹只是噪音 —— 重试进度在气泡里能看到。
      //   只有换了原因（比如从"接口抖动"变成"key 失效"）才再提示一次。
      final key = _errorDedupeKey(message);
      final shouldToast = key != _lastToastedErrorKey;
      _lastToastedErrorKey = key;
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (!mounted) return;
        if (shouldToast) toast(context, message);
        AppScope.read(context).clearError();
      });
    }

    // ★ 追底请求必须去重：build 里每次重建都会走到这儿，
    //   而流式输出时消息每几十毫秒更新一次 —— 等于每帧都排一轮追底。
    //   chat_scroll_follow 的每一轮是"最多 10 帧 jumpTo"，
    //   于是 pixels 每帧都在变，右侧滑块跟着反复重算 = 抽搐。
    //   这里按消息条数+末条长度做键，内容真的变了才请求。
    if (_stick && msgs.isNotEmpty) {
      final last = msgs.last;
      final key = '${msgs.length}:${last.id}:${last.text.length}';
      if (key != _lastFollowKey) {
        _lastFollowKey = key;
        _scrollFollow.request();
      }
    }

    // 焦点兜底（见 _keepComposerFocused）—— 放在帧后，别在 build 里抢焦点
    WidgetsBinding.instance.addPostFrameCallback((_) => _keepComposerFocused());

    // 消息列的左右留白：**在聊天栏内部**居中，而不是拿窗口宽度算。
    //
    // ★ 这里改成看"这一栏有多宽"：右侧开着面板/浏览器栏时窗口很宽，
    //   但聊天栏可能只有几百像素 —— 按窗口算会算出巨大的留白，
    //   把内容挤成一条窄缝（用户看到的就是"中间像手机一样，不拉伸"）。
    //   真实宽度由下面的 LayoutBuilder 拿到（见 _chatColumnWidth）。

    return Scaffold(
      backgroundColor: PB.bgPane,
      // ★ 顶部是**浮在上面的小胶囊**，不是一整条 AppBar：
      //   透明背景 + 居中的圆角胶囊（头像 + 会话名），左右各留出返回 / 更多。
      //   整条工具栏是透明的，所以看上去就是"顶上浮了一个小椭圆"。
      appBar: chromeAppBar(
        context,
        AppBar(
          flexibleSpace: const WindowDragArea(),
          backgroundColor: Colors.transparent,
          elevation: 0,
          scrolledUnderElevation: 0,
          toolbarHeight: 54,
          automaticallyImplyLeading: !widget.embedded,
          titleSpacing: 0,
          centerTitle: true,
          // 居中的小胶囊：头像 + 会话名（状态只在"干活/压缩"时露出来，
          // 平时保持安静）
          // 点胶囊 → 右侧面板（这个会话是谁 / 里面有谁 / 上下文用得怎么样）。
          // 宽屏它是布局里的一栏（和左边同级，没遮罩）；窄屏才走整页滑入。
          // 鼠标移上去会**浮起来**、右边冒出一个 `>` —— 告诉用户"这里能点开"。
          title: Listener(
            behavior: HitTestBehavior.opaque,
            child: AvatarHoverScope(
              child: _HoverLift(
                onTap: () {
                  // ★ 只有「嵌在 HomeShell 里」时才能切双栏面板。
                  //
                  //   togglePanel() 只是改 AppState.panelOpen，
                  //   真正的右侧栏由 HomeShell 根据那个标志渲染。
                  //   而 Navigator.push 出来的独立 ChatScreen（比如
                  //   「让助手建团队」跳过去的私聊）盖在 HomeShell 上面，
                  //   改标志位没有可见效果 —— 用户点了觉得「点不动」。
                  //
                  //   这种独立页改用弹出的面板。
                  final twoPane =
                      widget.embedded &&
                      MediaQuery.sizeOf(context).width >= kTwoPaneMinWidth;
                  if (twoPane) {
                    AppScope.read(context).togglePanel();
                  } else {
                    showRoomPanel(context, room);
                  }
                },
                child: Container(
                  padding: const EdgeInsets.fromLTRB(6, 5, 14, 5),
                  decoration: BoxDecoration(
                    color: PB.bgElevated,
                    borderRadius: BorderRadius.circular(PB.rFull),
                    border: Border.all(color: PB.borderSecondary),
                  ),
                  child: Row(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      if (room.isGroup)
                        GroupBlobAvatar(
                          seeds: room.botIds,
                          size: 22,
                          animate: busy,
                          mood: busy ? AvatarMood.busy : AvatarMood.idle,
                        )
                      else
                        BlobAvatar(
                          seed: room.botIds.isNotEmpty
                              ? room.botIds.first
                              : room.id,
                          color: PB.colorFor(
                            room.botIds.isNotEmpty
                                ? room.botIds.first
                                : room.id,
                          ),
                          emoji: lead?.emoji,
                          size: 22,
                          animate: true,
                          mood: busy ? AvatarMood.busy : AvatarMood.idle,
                        ),
                      const SizedBox(width: 8),
                      Text(
                        room.isGroup ? room.name : (lead?.name ?? room.name),
                        style: const TextStyle(
                          fontSize: PB.fsSm,
                          fontWeight: FontWeight.w500,
                        ),
                      ),
                      // 状态只在"正在干活"时露出来 —— 平时不占地方。
                      //
                      // ★ 压缩状态不在这里画：右边的 ContextChip 已经会显示
                      //   「↻ 压缩中」，两处一起出现就是「压缩中 压缩中」。
                      //   压缩本来就是上下文的事，归给上下文那个小圆环汇报。
                      if (busy) ...[
                        const SizedBox(width: 8),
                        SizedBox(
                          width: 11,
                          height: 11,
                          child: CircularProgressIndicator(
                            strokeWidth: 1.8,
                            color: PB.colors(context).accentBright,
                          ),
                        ),
                      ],
                      // 上下文占用：平时也就是一个小圆环
                      const SizedBox(width: 6),
                      ContextChip(roomId: room.id),
                    ],
                  ),
                ),
              ),
            ),
          ),
          actions: [
            // 任务板：显示这个房间未完成的数量，点开是清单
            Builder(
              builder: (ctx) {
                final list = state.tasksFor(room.id);
                final pending = list.where((t) => !t.isDone).length;
                return KeyedSubtree(
                  key: _taskAnchor,
                  child: IconButton(
                    padding: EdgeInsets.zero,
                    alignment: Alignment.center,
                    visualDensity: VisualDensity.compact,
                    constraints: const BoxConstraints(
                      minWidth: 40,
                      minHeight: 40,
                    ),
                    tooltip: pending > 0
                        ? s.tf('chat.tasksWithCount', {'n': pending})
                        : s.t('chat.tasks'),
                    onPressed: () =>
                        showTaskBoard(ctx, state, room, anchorKey: _taskAnchor),
                    icon: Badge(
                      isLabelVisible: pending > 0,
                      label: Text('$pending'),
                      backgroundColor: PB.colors(context).accent,
                      child: Icon(
                        LucideIcons.checkCircle2,
                        size: 18,
                        color: pending > 0
                            ? PB.colors(context).accentBright
                            : PB.textTertiary,
                      ),
                    ),
                  ),
                );
              },
            ),
            // ★ 用锚定浮层，不用 PopupMenuButton。
            //
            //   原生 PopupMenuButton 的定位不受我们控制：它会从图标下方
            //   直接铺开，实测会盖住触发它的那颗三个点按钮，也和「新建」
            //   浮层的视觉语言不一致。这里统一走 showAnchoredMenu，
            //   落点由 menuPlacement 算（会避开按钮本身）。
            KeyedSubtree(
              key: _moreAnchor,
              child: IconButton(
                padding: EdgeInsets.zero,
                visualDensity: VisualDensity.compact,
                constraints: const BoxConstraints(minWidth: 36, minHeight: 36),
                tooltip: s.t('chat.more'),
                onPressed: () => _showMoreMenu(context, state, room, busy, s),
                icon: const Icon(LucideIcons.ellipsis, size: 18),
              ),
            ),
            const SizedBox(width: 6),
          ],
        ),
      ),
      // ★ 把附件（图片 / PDF / Word…）直接拖进聊天框。
      //   只在桌面端有效（desktop_drop 在移动端不注册），移动端就是普通 Scaffold。
      //   反馈用提示条 —— 不做布满全屏的高亮层（容易把 body 的嵌套改坏）。
      body: DropTarget(
        onDragEntered: (_) => setState(() => _draggingOver = true),
        onDragExited: (_) => setState(() => _draggingOver = false),
        onDragDone: (detail) async {
          setState(() => _draggingOver = false);
          final paths = detail.files
              .map((f) => f.path.trim())
              .where((p) => p.isNotEmpty)
              .toList();
          if (paths.isEmpty) return;
          // ★ 文件夹也能拖：展开成（带相对路径的）文件列表再上传。
          //   名字里带 `文件夹/子目录/文件名`，bot 能看出目录结构。
          final items = _expandDroppedPaths(paths);
          if (items.isEmpty) {
            _toast(s.t('chat.dropEmptyFolder'));
            return;
          }
          if (items.length >= _maxFolderFiles) {
            _toast(s.tf('chat.dropTooMany', {'n': _maxFolderFiles}));
          }
          await _uploadAll(items);
        },
        child: Stack(
          children: [
            Column(
              children: [
                Expanded(
                  child: msgs.isEmpty
                      ? _EmptyHint(room: room, lead: lead)
                      : Stack(
                          children: [
                            // ★ 消息列表整块**不许抢焦点**。
                            //
                            //   列表里每条消息的 MdText 默认 selectable: true，底层是
                            //   SelectableText.rich —— 它会自己建 FocusNode。而流式输出时
                            //   消息每 80ms 重建一次，这些节点就在焦点竞争里把焦点从输入框
                            //   拽走：用户打字打一半断掉，得重新点一下输入框。
                            //
                            //   现在不再套 ExcludeFocus —— 那会把 SelectionArea 的
                            //   键盘快捷键一起挡掉（⌘C 复制整段就靠它）。
                            RepaintBoundary(
                              child: NotificationListener<Notification>(
                                onNotification: (n) {
                                  // 先给追底逻辑，再转给右侧滑块。
                                  // 滑块在 Stack 里是兄弟节点，自己收不到滚动通知，
                                  // 必须在这里转发，否则它的「滚动结束校准」永不执行。
                                  _scrollFollow.handleNotification(n);
                                  _railKey.currentState?.handleNotification(n);
                                  return false;
                                },
                                // ★ 用 **聊天栏自己的宽度** 算留白和气泡上限。
                                //   窗口 2000px 但这一栏只有 500px 时，
                                //   必须按 500 算 —— 否则气泡被撑出栏外、留白也大得离谱。
                                child: LayoutBuilder(
                                  builder: (ctx, box) {
                                    final colW = box.maxWidth;
                                    // 内容列最多 kChatContentMax；多出来的宽度两边均分
                                    final extra = math.max(
                                      0.0,
                                      colW - kChatContentMax,
                                    );
                                    // 右侧留白必须比滑轮宽 —— 否则窄窗口时
                                    // 滑轨（18px）会直接压在正文上。
                                    final pad = math.max(
                                      kChatSidePad,
                                      extra / 2,
                                    );
                                    final rightPad = math.max(pad, 24.0);
                                    final leftPadForGroup = room.isGroup
                                        ? math.max(12.0, pad - 42)
                                        : pad;
                                    // ★ 不再显示滚动条。
                                    //
                                    //   抽搐的根因：消息列表在流式输出时每条消息都在
                                    //   长高，内容总高度每几十毫秒变一次 ——
                                    //   滚动条滑块必须跟着重算尺寸和位置，
                                    //   看起来就是不停抖动。这不是配置问题，
                                    //   只要"内容高度高频变化 + 常显滚动条"就会发生。
                                    //
                                    //   关掉它最实在：滚轮/触控板照样能滚，
                                    //   而用户视觉上少一个一直抽搐的东西。
                                    // ★ 只在这里关掉滚动条。
                                    //
                                    //   原来挂在 MaterialApp 上，等于把设置页、
                                    //   日志、文件列表、回执二级页的滚动条一起关了 ——
                                    //   长列表再也判断不了「下面还有多少」。
                                    //   抽搐只发生在聊天列表（流式输出让高度高频变化），
                                    //   所以只治这一处。
                                    return ScrollConfiguration(
                                      behavior: const NoScrollbarBehavior(),
                                      child: ListView.builder(
                                        controller: _scroll,
                                        // 重排时按 key 找回位置，避免整行重建
                                        // （见上面 keyIndex 的说明）
                                        findChildIndexCallback: (key) =>
                                            keyIndex[key],
                                        padding: EdgeInsets.fromLTRB(
                                          leftPadForGroup,
                                          20,
                                          rightPad,
                                          20,
                                        ),
                                        itemCount: display.length,
                                        itemBuilder: (ctx, i) {
                                          final msg = display[i];

                                          if (msg.isProgress) {
                                            final run = progressGroups[i];
                                            if (run == null) {
                                              return const SizedBox.shrink();
                                            }
                                            return _Appear(
                                              key: ValueKey(
                                                'progress-${msg.id}',
                                              ),
                                              child: ProgressNotice(
                                                messages: run,
                                              ),
                                            );
                                          }

                                          final prev = i > 0
                                              ? display[i - 1]
                                              : null;
                                          final newAuthor =
                                              prev == null ||
                                              prev.authorId != msg.authorId ||
                                              prev.authorType !=
                                                  msg.authorType ||
                                              (msg.createdAt - prev.createdAt) >
                                                  5 * 60 * 1000;
                                          // 同一个人连着发好几条时，头像挂在**最后一条**上 ——
                                          // 这样整串气泡都在头像的右上方，头像在底部托着。
                                          // （挂在第一条的话，头像会卡在整串中间，很怪。）
                                          final next = i + 1 < display.length
                                              ? display[i + 1]
                                              : null;
                                          final endOfRun =
                                              next == null ||
                                              next.authorId != msg.authorId ||
                                              next.authorType !=
                                                  msg.authorType ||
                                              (next.createdAt - msg.createdAt) >
                                                  5 * 60 * 1000;
                                          // ★ 这条是**外面的人说的**（不在这个会话的名单里）——
                                          //   比如负责人把某个成员的报告转进群里。
                                          //   挂一条「消息来自 X」，点开是**只读**的窥视：
                                          //   看那个 bot 的私聊里到底说了什么，让链路可见。
                                          //   注意：主控不算「外面的人」—— 它在哪儿说话都是派活。
                                          final authorBot =
                                              msg.authorType == 'bot' &&
                                                  msg.authorId != null
                                              ? state.botById(msg.authorId)
                                              : null;
                                          final relayed = isRelayedAuthor(
                                            author: authorBot,
                                            room: room,
                                          );
                                          final relayedBot = relayed
                                              ? authorBot
                                              : null;
                                          final relayedRoom = relayedBot == null
                                              ? null
                                              : state.rooms
                                                    .where(
                                                      (r) =>
                                                          !r.isGroup &&
                                                          r.botIds.contains(
                                                            relayedBot.id,
                                                          ),
                                                    )
                                                    .firstOrNull;
                                          // 不居中：整行铺满，bot 贴左、我贴右
                                          return _Appear(
                                            key: ValueKey(msg.id),
                                            child: Column(
                                              crossAxisAlignment:
                                                  CrossAxisAlignment.stretch,
                                              children: [
                                                if (relayedBot != null)
                                                  _RelayedFrom(
                                                    bot: relayedBot,
                                                    // 点开那个 bot 的私聊（只读）——
                                                    // 找不到私聊房间就不给点（只显示是谁说的）
                                                    onTap: relayedRoom == null
                                                        ? null
                                                        : () => showChatPeek(
                                                            context,
                                                            refs: [
                                                              MsgRef(
                                                                botId:
                                                                    relayedBot
                                                                        .id,
                                                                roomId:
                                                                    relayedRoom
                                                                        .id,
                                                              ),
                                                            ],
                                                          ),
                                                  ),
                                                _MessageRow(
                                                  msg: msg,
                                                  // 气泡上限按**这一栏**的宽度算，不按窗口
                                                  columnWidth: colW,
                                                  showAuthor: newAuthor,
                                                  showAvatar: endOfRun,
                                                  bot: state.botById(
                                                    msg.authorId,
                                                  ),
                                                  isGroup: room.isGroup,
                                                  mentions: room.botNames,
                                                  // @ 的名字 → 那个 bot（chip 的颜色、悬停卡的内容都靠它）
                                                  mentionOf: (name) {
                                                    final b = state.botByName(
                                                      name,
                                                    );
                                                    return b == null
                                                        ? null
                                                        : MentionInfo(
                                                            seed: b.id,
                                                            subtitle: b.tagline,
                                                            emoji: b.emoji,
                                                          );
                                                  },
                                                  isLead:
                                                      room.isGroup &&
                                                      msg.authorId != null &&
                                                      msg.authorId ==
                                                          room.leadBotId,
                                                  onLongPress: () =>
                                                      showMessageActions(
                                                        context,
                                                        msg,
                                                      ),
                                                ),
                                              ],
                                            ),
                                          );
                                        },
                                      ),
                                    );
                                  },
                                ),
                              ),
                            ),
                            // ★ 谁在干活：悬浮在消息区底部的胶囊。
                            //
                            //   原来它作为 Column 的一行**独占一条高度**，
                            //   在消息和输入框之间形成一条横带（用户看到的
                            //   「胶囊后面总有一整个长条背景」就是那条高度）。
                            //   现在用 Positioned 叠在消息区内部，
                            //   不占任何布局高度，胶囊本身才是唯一可见元素。
                            Positioned(
                              left: 0,
                              right: 0,
                              bottom: 0,
                              child: IgnorePointer(
                                child: ActivityMonitor(
                                  roomId: room.id,
                                  tasks: state.taskRuns
                                      .forRoom(room.id)
                                      .map((t) => t.title)
                                      .where((t) => t.isNotEmpty)
                                      .toList(),
                                ),
                              ),
                            ),
                            // 右侧导航轨：滑块 + 用户消息锚点二合一。
                            //
                            // 系统滚动条在这里无法稳定工作：位置按
                            // pixels / maxScrollExtent 算，而流式输出与懒渲染
                            // 都会让总高度突变 → 滑块反复跳。
                            // 这里改用增量 + 静止后校准（见组件内注释）。
                            Positioned(
                              right: 0,
                              top: 0,
                              bottom: 0,
                              child: MessageAnchorRail(
                                key: _railKey,
                                controller: _scroll,
                              ),
                            ),
                            // 顶部渐变：消息滚上去时柔和淡出，而不是被标题栏硬切
                            Positioned(
                              left: 0,
                              right: 0,
                              top: 0,
                              height: 22,
                              child: IgnorePointer(
                                child: DecoratedBox(
                                  decoration: BoxDecoration(
                                    gradient: LinearGradient(
                                      begin: Alignment.topCenter,
                                      end: Alignment.bottomCenter,
                                      colors: [
                                        PB.bgPane,
                                        PB.bgPane.withValues(alpha: 0),
                                      ],
                                    ),
                                  ),
                                ),
                              ),
                            ),
                          ],
                        ),
                ),
                _tapToReattach(
                  _Composer(
                    controller: _input,
                    focus: _focus,
                    busy: busy,
                    queuedCount: state.queued[room.id] ?? 0,
                    pending: _pending,
                    uploading: _uploading,
                    onPickImages: _pickImages,
                    onPickFiles: _pickFiles,
                    onTeach: () => showTeachDialog(
                      context,
                      state.mainBot ?? state.bots.first,
                    ),
                    onRemovePending: (att) => setState(
                      () => _pending.removeWhere((a) => a.id == att.id),
                    ),
                    onPasteImage: (name, bytes) =>
                        _uploadAll([(name, () async => bytes)]),
                    onSend: _send,
                    onStop: () => state.abort(room.id),
                    showJump: !_stick,
                    unread: _unreadWhileUp,
                    onJump: () => _scrollFollow.resume(animate: true),
                  ),
                ),
              ],
            ),
            // 拖拽落点提示：整块遮罩 + 一句话，松手就上传（图片 / PDF / Word / Excel 都收）
            if (_draggingOver)
              Positioned.fill(
                child: IgnorePointer(
                  child: Container(
                    color: PB.bgApp.withValues(alpha: 0.75),
                    alignment: Alignment.center,
                    child: Container(
                      padding: const EdgeInsets.symmetric(
                        horizontal: 22,
                        vertical: 16,
                      ),
                      decoration: BoxDecoration(
                        color: PB.bgBubble,
                        borderRadius: BorderRadius.circular(PB.r2xl),
                        border: Border.all(
                          color: PB
                              .colors(context)
                              .accent
                              .withValues(alpha: 0.5),
                        ),
                      ),
                      child: Column(
                        mainAxisSize: MainAxisSize.min,
                        children: [
                          Icon(
                            LucideIcons.paperclip,
                            size: 22,
                            color: PB.colors(context).accentBright,
                          ),
                          SizedBox(height: 8),
                          Text(
                            s.t('chat.dropHint'),
                            style: TextStyle(
                              fontSize: PB.fsSm,
                              color: PB.textSecondary,
                            ),
                          ),
                        ],
                      ),
                    ),
                  ),
                ),
              ),
          ],
        ),
      ),
    );
  }
}

/// 整页打开的浏览器（窄屏 / 非 embedded 时用）。
///
/// ★ 为什么单独抽一个组件、而不是内联在菜单回调里：
///   关闭时必须把 browser.open 复位。原来只给 BrowserPane 传了 onClose，
///   那**只挂在工具栏的 ✕ 按钮上** —— 系统返回键、Esc、侧滑返回走的是
///   Navigator.pop，根本不会进 onClose。结果是：整页关掉了，但
///   browser.open 还是 true；用户随后把窗口拉宽，右栏自己冒出来
///   （显示一个他以为已经关掉的浏览器）。
///
///   PopScope 能覆盖所有退出路径，所以用它在真正出栈前统一复位。
class _FullPageBrowser extends StatefulWidget {
  const _FullPageBrowser({required this.state});

  final AppState state;

  @override
  State<_FullPageBrowser> createState() => _FullPageBrowserState();
}

class _FullPageBrowserState extends State<_FullPageBrowser> {
  void _close() {
    // 必须过 AppState：栏是 HomeShell 布局里的一列，
    // 只有 AppState.notifyListeners 能让它重新布局。
    // 直接 browser.close() 只会改状态，布局层收不到通知。
    widget.state.closeBrowserPane();
    if (mounted) Navigator.of(context).pop();
  }

  @override
  Widget build(BuildContext context) {
    return PopScope(
      // canPop: false → 拦截**系统返回键/手势**，改由我们自己先复位再 pop。
      //
      // ★ 分工：Esc 由下面的 CallbackShortcuts 负责；PopScope 只管
      //   系统返回（macOS 的 ⌘[ / 触控板滑动、Windows 的 Alt+←）。
      //   两者最后都走同一个 _close()，行为和 ✕ 按钮一致。
      canPop: false,
      onPopInvokedWithResult: (didPop, _) {
        if (didPop) return;
        _close();
      },
      child: CallbackShortcuts(
        bindings: {
          // Esc 关闭整页浏览器（焦点在页面本体或普通控件时走这里）
          const SingleActivator(LogicalKeyboardKey.escape): _close,
        },
        child: Focus(
          // 页面一打开就拿到焦点，否则快捷键收不到按键
          autofocus: true,
          // ★ 真正兜住"光标在地址栏里按 Esc"的是这一层。
          //
          //   按键先到最内层焦点（TextField），再沿焦点链往上冒泡。
          //   这里返回 handled 就把事件吃掉，CallbackShortcuts 不会再响应 ——
          //   所以两条机制不会重复触发关闭（实测：三种焦点位置各只触发一次）。
          //
          //   之所以不依赖 CallbackShortcuts 单独完成：它在焦点链**外部**，
          //   TextField 这类控件若把 Esc 就地消费，事件就冒不到它那里。
          onKeyEvent: (node, event) {
            if (event is KeyDownEvent &&
                event.logicalKey == LogicalKeyboardKey.escape) {
              _close();
              return KeyEventResult.handled;
            }
            return KeyEventResult.ignored;
          },
          child: Scaffold(
            backgroundColor: PB.bgPane,
            body: SafeArea(
              child: BrowserPane(state: widget.state.browser, onClose: _close),
            ),
          ),
        ),
      ),
    );
  }
}

class _EmptyHint extends StatelessWidget {
  const _EmptyHint({required this.room, required this.lead});

  final Room room;
  final Bot? lead;

  @override
  Widget build(BuildContext context) {
    final s = L10n.s(context);
    final isGroup = room.isGroup;
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(36),
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            if (isGroup)
              GroupBlobAvatar(seeds: room.botIds, size: 64, animate: true)
            else
              BlobAvatar(
                seed: room.botIds.isNotEmpty ? room.botIds.first : room.id,
                color: PB.colorFor(
                  room.botIds.isNotEmpty ? room.botIds.first : room.id,
                ),
                emoji: lead?.emoji,
                size: 64,
                animate: true,
                // 空会话里这个大头像是"孤零零挂着"的，戳一下挤一下不会抢谁的点击
                interactive: true,
              ),
            const SizedBox(height: 20),
            Text(
              isGroup ? room.name : (lead?.name ?? room.name),
              style: const TextStyle(
                fontSize: PB.fsLg,
                fontWeight: FontWeight.w500,
              ),
            ),
            const SizedBox(height: 8),
            Text(
              room.topic.isNotEmpty
                  ? room.topic
                  : (isGroup
                        ? s.t('chat.emptyGroupHint')
                        : s.t('chat.emptyDmHint')),
              textAlign: TextAlign.center,
              style: TextStyle(
                fontSize: PB.fsSm,
                color: PB.textQuaternary,
                height: 1.6,
              ),
            ),
            if (isGroup && room.botNames.isNotEmpty) ...[
              const SizedBox(height: 16),
              Wrap(
                spacing: 6,
                runSpacing: 6,
                alignment: WrapAlignment.center,
                children: [
                  for (var i = 0; i < room.botIds.length; i++)
                    Container(
                      padding: const EdgeInsets.symmetric(
                        horizontal: 10,
                        vertical: 5,
                      ),
                      decoration: BoxDecoration(
                        color: PB.bgBubble,
                        borderRadius: BorderRadius.circular(PB.rFull),
                        border: Border.all(color: PB.borderTertiary),
                      ),
                      child: AvatarHoverScope(
                        child: Row(
                          mainAxisSize: MainAxisSize.min,
                          children: [
                            BlobAvatar(
                              seed: room.botIds[i],
                              color: PB.colorFor(room.botIds[i]),
                              size: 14,
                              animate: false,
                            ),
                            const SizedBox(width: 6),
                            Text(
                              i < room.botNames.length
                                  ? room.botNames[i]
                                  : room.botIds[i],
                              style: TextStyle(
                                fontSize: PB.fsXs,
                                color: PB.textTertiary,
                              ),
                            ),
                          ],
                        ),
                      ),
                    ),
                ],
              ),
            ],
          ],
        ),
      ),
    );
  }
}

class _Composer extends StatefulWidget {
  const _Composer({
    required this.controller,
    this.showJump = false,
    this.unread = 0,
    this.onJump,
    required this.focus,
    required this.busy,
    required this.queuedCount,
    required this.pending,
    required this.uploading,
    required this.onPickImages,
    required this.onPickFiles,
    required this.onTeach,
    this.onPasteImage,
    required this.onRemovePending,
    required this.onSend,
    required this.onStop,
  });

  final TextEditingController controller;

  /// 要不要显示「回到底部」（往上翻着聊天记录时才显示）
  final bool showJump;

  /// 往上翻的时候又来了几条新的 —— 标在按钮上
  final int unread;
  final VoidCallback? onJump;
  final FocusNode focus;
  final bool busy;
  final int queuedCount;
  final List<Attachment> pending;
  final bool uploading;
  final VoidCallback onPickImages;
  final VoidCallback onPickFiles;

  /// 「教它做一项任务」——把用户口述的做法存成 bot 的技能
  final VoidCallback onTeach;

  /// Ctrl+V 粘进来一张图（截图）：直接当附件发出去
  final Future<void> Function(String name, List<int> bytes)? onPasteImage;
  final void Function(Attachment) onRemovePending;
  final VoidCallback onSend;
  final VoidCallback onStop;

  @override
  State<_Composer> createState() => _ComposerState();
}

class _ComposerState extends State<_Composer> {
  bool _hasText = false;

  /// 悬浮菜单锚在 "+" 按钮上
  final GlobalKey _plusKey = GlobalKey();

  void _openMenu() {
    final s = L10n.s(context);
    showFloatingMenu(
      context: context,
      anchorKey: _plusKey,
      entries: [
        FloatingMenuEntry(
          icon: LucideIcons.image,
          label: s.t('chat.addAttachment'),
          hint: s.t('chat.multiSelect'),
          onTap: widget.onPickImages,
        ),
        FloatingMenuEntry(
          icon: LucideIcons.paperclip,
          label: s.t('chat.uploadFile'),
          hint: s.t('chat.uploadFileHint'),
          onTap: widget.onPickFiles,
        ),
        FloatingMenuEntry(
          icon: LucideIcons.target,
          label: s.t('chat.teachTask'),
          iconColor: PB.danger,
          onTap: widget.onTeach,
        ),
      ],
    );
  }

  @override
  void initState() {
    super.initState();
    widget.controller.addListener(_onTextChanged);
    _hasText = widget.controller.text.trim().isNotEmpty;
  }

  /// Ctrl+V：剪贴板有图就发图，没有就按文本插进输入框。
  Future<void> _paste() async {
    final img = await readClipboardImage();
    if (img != null) {
      try {
        await widget.onPasteImage?.call(img.name, img.bytes);
      } finally {
        img.dispose();
      }
      return;
    }
    // 没图：走默认的文本粘贴
    final data = await Clipboard.getData(Clipboard.kTextPlain);
    final text = data?.text;
    if (text == null || text.isEmpty) return;
    final value = widget.controller.value;
    final sel = value.selection;
    final start = sel.isValid ? sel.start : value.text.length;
    final end = sel.isValid ? sel.end : value.text.length;
    widget.controller.value = TextEditingValue(
      text: value.text.replaceRange(start, end, text),
      selection: TextSelection.collapsed(offset: start + text.length),
    );
  }

  void _onTextChanged() {
    final hasText = widget.controller.text.trim().isNotEmpty;
    if (hasText != _hasText) setState(() => _hasText = hasText);
  }

  /// 输入法是不是**正在组词**（候选框还挂着没确认）。
  ///
  /// 为什么必须看这个：中文用户打英文单词时，候选框里的字母还没落进输入框，
  /// 这时候按回车是「选这个候选词」而不是「发送」。若把回车当成发送，
  /// 消息会带着半截内容飞出去，输入框还会被清空 —— 用户看起来就是
  /// “输入法吃字了”。日文/韩文的候选框同理。
  ///
  /// `composing` 为空（`TextRange.empty`）才说明没在组词。
  bool _isComposing() {
    final composing = widget.controller.value.composing;
    return composing.isValid && !composing.isCollapsed;
  }

  @override
  void dispose() {
    widget.controller.removeListener(_onTextChanged);
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final s = L10n.s(context);
    final controller = widget.controller;
    final busy = widget.busy;
    final queuedCount = widget.queuedCount;
    final onSend = widget.onSend;
    final onStop = widget.onStop;
    final pending = widget.pending;
    final hasText = _hasText || pending.isNotEmpty;

    return SafeArea(
      top: false,
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          // ★ 这个 key 是**必须的**，不是为了好看。
          //
          //   不加的话：busy 一变，这个孩子就凭空插到 Column 最前面，
          //   Flutter 按位置配对 → 后面的输入框整棵被**重建** →
          //   新的 EditableText 拿着一个"已经聚焦"的 FocusNode 初始化，
          //   于是它**永远不会打开文本输入连接**。表现就是：
          //   发完第一条，光标在闪、打字没反应、点一下也没用（点它没有状态变化，
          //   引擎不会重连）。有 key 之后 Flutter 按 key 配对，输入框原地不动。
          // ★ 只有**真的有排队消息**时才显示这一行。
          //   原来条件是 if (busy)，删掉"正在干活"文案后就变成
          //   "已发了 0 句" 常驻 —— 那是在说一件没发生的事。
          if (busy && queuedCount > 0)
            Padding(
              key: const ValueKey('composer-busy-hint'),
              padding: const EdgeInsets.only(bottom: 6),
              child: Container(
                padding: const EdgeInsets.symmetric(
                  horizontal: 11,
                  vertical: 5,
                ),
                decoration: BoxDecoration(
                  color: PB.bgBubble,
                  borderRadius: BorderRadius.circular(PB.rFull),
                  border: Border.all(color: PB.borderTertiary),
                ),
                child: Row(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Icon(
                      LucideIcons.zap,
                      size: 12,
                      color: PB.colors(context).accentBright,
                    ),
                    const SizedBox(width: 5),
                    Text(
                      // ★ 只在有排队消息时显示。
                      //   "正在干活"这类泛提示已经由输入框上方的活动轮播表达，
                      //   而那行能说出**谁在干、在干什么**，信息量更大；
                      //   两行都说同一件事只会挤占视线。
                      s.tf('chat.busyQueued', {'n': queuedCount}),
                      style: TextStyle(
                        fontSize: PB.fsXxs,
                        color: PB.textTertiary,
                      ),
                    ),
                  ],
                ),
              ),
            ),
          //   同上：这一行出现/消失也会挤掉输入框，必须给 key
          if (pending.isNotEmpty || widget.uploading)
            Padding(
              key: const ValueKey('composer-pending'),
              padding: const EdgeInsets.fromLTRB(12, 0, 12, 6),
              child: SizedBox(
                height: 56,
                child: ListView(
                  scrollDirection: Axis.horizontal,
                  children: [
                    if (widget.uploading)
                      Padding(
                        padding: EdgeInsets.symmetric(
                          horizontal: 8,
                          vertical: 10,
                        ),
                        child: SizedBox(
                          width: 36,
                          height: 36,
                          child: Center(
                            child: CircularProgressIndicator(
                              strokeWidth: 2,
                              color: PB.colors(context).accentBright,
                            ),
                          ),
                        ),
                      ),
                    for (final att in pending)
                      Padding(
                        padding: const EdgeInsets.only(right: 8, top: 4),
                        child: Stack(
                          clipBehavior: Clip.none,
                          children: [
                            Container(
                              width: 48,
                              height: 48,
                              decoration: BoxDecoration(
                                color: PB.bgActive,
                                borderRadius: BorderRadius.circular(PB.rXl),
                                border: Border.all(color: PB.borderSecondary),
                              ),
                              clipBehavior: Clip.antiAlias,
                              child: att.isImage
                                  ? Image.network(
                                      AppScope.read(context).fileUrl(att.id) ??
                                          '',
                                      fit: BoxFit.cover,
                                      errorBuilder: (c, e, s) => Icon(
                                        LucideIcons.image,
                                        size: 18,
                                        color: PB.textQuaternary,
                                      ),
                                    )
                                  : Icon(
                                      LucideIcons.fileText,
                                      size: 18,
                                      color: PB.textSecondary,
                                    ),
                            ),
                            Positioned(
                              right: -6,
                              top: -6,
                              child: GestureDetector(
                                onTap: () => widget.onRemovePending(att),
                                child: Container(
                                  padding: const EdgeInsets.all(2),
                                  decoration: BoxDecoration(
                                    color: PB.bgActive,
                                    shape: BoxShape.circle,
                                  ),
                                  child: Icon(
                                    LucideIcons.x,
                                    size: 12,
                                    color: PB.textSecondary,
                                  ),
                                ),
                              ),
                            ),
                          ],
                        ),
                      ),
                  ],
                ),
              ),
            ),
          Padding(
            // 输入行：整个 composer 里**唯一有状态**的东西（TextField 的
            // EditableText）。给它一个稳定的 key，任何兄弟的增删都不会碰到它。
            key: const ValueKey('composer-input-row'),
            padding: const EdgeInsets.fromLTRB(12, 0, 12, 8),
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.end,
              children: [
                PlusTriggerButton(
                  anchorKey: _plusKey,
                  size: 40,
                  tooltip: s.t('chat.attachOrTeach'),
                  onTap: _openMenu,
                ),
                const SizedBox(width: 8),
                Expanded(
                  child: AnimatedContainer(
                    duration: const Duration(milliseconds: 180),
                    curve: Curves.easeOut,
                    decoration: BoxDecoration(
                      color: PB.bgInput,
                      borderRadius: BorderRadius.circular(22),
                      border: Border.all(
                        color: widget.focus.hasFocus
                            ? PB.colors(context).accent.withValues(alpha: 0.45)
                            : PB.borderSecondary,
                      ),
                      boxShadow: widget.focus.hasFocus
                          ? PB.glow(
                              PB.colors(context).accent,
                              blur: 14,
                              alpha: 0.12,
                            )
                          : null,
                    ),
                    padding: const EdgeInsets.symmetric(horizontal: 16),
                    child: Focus(
                      // Enter 发送 / Shift+Enter 换行 / Ctrl(⌘)+Enter 也发送
                      onKeyEvent: (node, event) {
                        if (event is! KeyDownEvent &&
                            event is! KeyRepeatEvent) {
                          return KeyEventResult.ignored;
                        }
                        final key = event.logicalKey;
                        final isEnter =
                            key == LogicalKeyboardKey.enter ||
                            key == LogicalKeyboardKey.numpadEnter;
                        if (!isEnter) return KeyEventResult.ignored;
                        // Shift+Enter 交给 TextField 自己插换行
                        if (HardwareKeyboard.instance.isShiftPressed) {
                          return KeyEventResult.ignored;
                        }
                        // ★ IME 正在组词 → 这个回车属于输入法，不是发送。
                        //
                        //   中文用户输入英文时，候选框还没确认，按回车是「选这个候选」；
                        //   若在这里当成发送，就变成「消息发出去 + 输入框被清空」，
                        //   用户以为输入法吃字了。日文/韩文同理。
                        //
                        //   composing 非空就说明还在组词；交给 TextField 处理后，
                        //   它会自己把候选词提交进输入框。
                        if (_isComposing()) return KeyEventResult.ignored;
                        onSend();
                        return KeyEventResult.handled;
                      },
                      // ★ 桌面快捷键：按系统习惯绑定（Mac ⌘ / Windows Ctrl）。
                      //   显式声明而不是全靠 Flutter 默认，是因为这里在
                      //   PasteTextIntent 上加了"剪贴板有图就发图"的逻辑 ——
                      //   接管了默认行为，就得把配套的编辑快捷键补全，
                      //   否则那些键在某一端会变成死的。
                      child: Shortcuts(
                        shortcuts: desktopEditingShortcuts(),
                        child: Actions(
                          actions: <Type, Action<Intent>>{
                            ...desktopEditingActions(controller),
                            // ★ ⌘V / Ctrl+V：先看剪贴板里有没有**图**（截图），有就当附件；
                            //   没有就走原来的文本粘贴。Flutter 自带的粘贴只认文本，
                            //   截图粘进来会静默什么都不发生。
                            PasteTextIntent: CallbackAction<PasteTextIntent>(
                              onInvoke: (_) {
                                unawaited(_paste());
                                return null;
                              },
                            ),
                          },
                          child: TextField(
                            controller: controller,
                            focusNode: widget.focus,
                            // ★ 进会话就聚焦输入框 —— 用户不用先点一下才能打字。
                            //   ChatScreen 按房间 id 加了 key，切到任意 bot 都会重建一次，
                            //   autofocus 跟着再触发一次，行为一致。
                            autofocus: true,
                            minLines: 1,
                            maxLines: 6,
                            keyboardType: TextInputType.multiline,
                            // 桌面保留原生换行和输入法处理，移动端软键盘显示发送。
                            textInputAction: chatInputAction,
                            // ★ onSubmitted 也必须挡同一件事。
                            //   桌面端 Enter 走的是上面的 onKeyEvent，但手机/某些 IME
                            //   会直接触发 onSubmitted —— 两条路都要看组词状态。
                            onSubmitted: (_) {
                              if (_isComposing()) return;
                              onSend();
                            },
                            style: const TextStyle(
                              fontSize: PB.fsBase,
                              height: 1.4,
                            ),
                            decoration: InputDecoration(
                              hintText: s.t('chat.composerHint'),
                              hintStyle: TextStyle(
                                color: PB.textQuaternary,
                                fontSize: PB.fsBase,
                              ),
                              border: InputBorder.none,
                              enabledBorder: InputBorder.none,
                              focusedBorder: InputBorder.none,
                              filled: false,
                              isDense: true,
                              contentPadding: const EdgeInsets.symmetric(
                                vertical: 13,
                              ),
                            ),
                          ),
                        ),
                      ),
                    ),
                  ),
                ),
                const SizedBox(width: 8),
                // 「回到底部」：和发送键同一行（左侧）——
                // 这里有自己的位置，**永远不会压住消息气泡**。
                // 只有往上翻着看历史时才出现，所以平时不占视线。
                if (widget.showJump) ...[
                  _RoundButton(
                    icon: LucideIcons.arrowDown,
                    color: PB.bgActive,
                    iconColor: PB.textSecondary,
                    tooltip: widget.unread > 0
                        ? s.tf('chat.jumpUnread', {'n': widget.unread})
                        : s.t('chat.jumpLatest'),
                    onTap: widget.onJump ?? () {},
                  ),
                  const SizedBox(width: 6),
                ],
                if (busy) ...[
                  _RoundButton(
                    icon: LucideIcons.square,
                    color: PB.bgActive,
                    iconColor: PB.textSecondary,
                    tooltip: s.t('chat.stopTurn'),
                    onTap: onStop,
                  ),
                  const SizedBox(width: 6),
                ],
                _RoundButton(
                  icon: busy ? LucideIcons.zap : LucideIcons.arrowUp,
                  color: hasText ? PB.colors(context).accent : PB.bgActive,
                  iconColor: hasText ? Colors.white : PB.textQuaternary,
                  tooltip: busy ? s.t('chat.sendBusy') : s.t('chat.send'),
                  onTap: onSend,
                ),
              ],
            ),
          ),
          // ★ 不放「Enter 发送 · Shift+Enter 换行」的操作说明：
          //   1. 回车能发送不需要被告知 —— 正常聊天软件都不说。
          //   2. 若做成"有字才出现"，一出现就把整个输入区顶高一行，
          //      整个界面会突然波动一下。
          //   快捷键本身照旧（Enter 发送、Shift+Enter 换行）。
        ],
      ),
    );
  }
}

class _RoundButton extends StatelessWidget {
  const _RoundButton({
    required this.icon,
    required this.color,
    required this.iconColor,
    required this.onTap,
    this.tooltip,
  });

  final IconData icon;
  final Color color;
  final Color iconColor;
  final VoidCallback onTap;
  final String? tooltip;

  @override
  Widget build(BuildContext context) {
    final button = Padding(
      padding: const EdgeInsets.only(bottom: 1),
      child: Material(
        color: color,
        shape: const CircleBorder(),
        clipBehavior: Clip.antiAlias,
        child: InkWell(
          onTap: onTap,
          child: SizedBox(
            width: 40,
            height: 40,
            child: Icon(icon, size: 19, color: iconColor),
          ),
        ),
      ),
    );
    return tooltip == null ? button : Tooltip(message: tooltip!, child: button);
  }
}

/// 新消息淡入 + 轻微上浮，不要"啪"地蹦出来
class _Appear extends StatefulWidget {
  const _Appear({super.key, required this.child});

  final Widget child;

  @override
  State<_Appear> createState() => _AppearState();
}

class _AppearState extends State<_Appear> with SingleTickerProviderStateMixin {
  late final AnimationController _c = AnimationController(
    vsync: this,
    duration: const Duration(milliseconds: 240),
  );

  // ★ CurvedAnimation 只建一次。
  //
  //   原来在 build 里 new 一个：每次重建都注册一个新的 listener 到 _c 上，
  //   而且从不 dispose —— CurvedAnimation 自己会往 parent 加监听，
  //   不 dispose 就一直挂着，行被反复重建时会累积。
  //   现在在 initState 建、dispose 里释放。
  late final CurvedAnimation _curve = CurvedAnimation(
    parent: _c,
    curve: Curves.easeOutCubic,
  );

  @override
  void initState() {
    super.initState();
    _c.forward();
  }

  @override
  void dispose() {
    _curve.dispose();
    _c.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return FadeTransition(
      opacity: _curve,
      child: AnimatedBuilder(
        animation: _curve,
        builder: (context, child) => Transform.translate(
          offset: Offset(0, (1 - _curve.value) * 8),
          child: child,
        ),
        child: widget.child,
      ),
    );
  }
}

/// 这条消息是不是「从别处转过来的」（需要在气泡上方挂「消息来自 X」）。
///
/// 判断依据是「作者不在这个会话的名单里」，但**主控永远不算**：
/// 主控是全局派活的人，它出现在部门群/某个 bot 的私聊里，本身就是正常的下发任务
/// 或者对任务的回复。把它标成「消息来自 主控」，用户会以为这些消息是从别处
/// 转进来的二手信息，反而看不清真正的链路。
///
/// 真正需要标记的是：某个成员 bot 被负责人转进群里的话（它确实不在这个会话）。
bool isRelayedAuthor({Bot? author, required Room room}) {
  if (author == null) return false;
  if (author.isMain) return false;
  return !room.botIds.contains(author.id);
}

/// 「消息来自 X」—— 这条不是这个会话的人说的，是从别处转过来的。
///
/// 形态：一行居中的小字 + 头像，**可点** ——
/// 点开是**只读**的窥视，看那个 bot 的私聊里到底说了什么，整条链路就看清了。
/// bot 主动私信时另有"已发送给 X"标记；这条覆盖转发进来的消息。
class _RelayedFrom extends StatefulWidget {
  const _RelayedFrom({required this.bot, this.onTap});

  final Bot bot;

  /// null = 找不到对应的私聊房间，只显示"是谁说的"，不给点
  final VoidCallback? onTap;

  @override
  State<_RelayedFrom> createState() => _RelayedFromState();
}

class _RelayedFromState extends State<_RelayedFrom> {
  bool _hover = false;

  @override
  Widget build(BuildContext context) {
    final canTap = widget.onTap != null;
    final accent = PB.colorFor(widget.bot.id);
    return Align(
      alignment: Alignment.center,
      child: MouseRegion(
        cursor: canTap ? SystemMouseCursors.click : SystemMouseCursors.basic,
        onEnter: (_) => setState(() => _hover = true),
        onExit: (_) => setState(() => _hover = false),
        child: GestureDetector(
          onTap: widget.onTap,
          child: Container(
            margin: const EdgeInsets.only(bottom: 6),
            padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
            decoration: BoxDecoration(
              color: _hover && canTap ? PB.bgHover : Colors.transparent,
              borderRadius: BorderRadius.circular(PB.rFull),
            ),
            child: Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                Text(
                  L10n.s(context).t('chat.relayedFrom'),
                  style: TextStyle(
                    fontSize: PB.fsXxs,
                    color: PB.textQuaternary,
                  ),
                ),
                const SizedBox(width: 6),
                BlobAvatar(
                  seed: widget.bot.id,
                  color: accent,
                  emoji: widget.bot.emoji,
                  size: 14,
                  animate: false,
                ),
                const SizedBox(width: 5),
                Text(
                  widget.bot.name,
                  style: TextStyle(
                    fontSize: PB.fsXxs,
                    fontWeight: FontWeight.w500,
                    color: canTap ? accent : PB.textTertiary,
                  ),
                ),
                if (canTap) ...[
                  const SizedBox(width: 4),
                  Icon(
                    LucideIcons.chevronRight,
                    size: 12,
                    color: _hover ? accent : PB.textQuaternary,
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

/// 消息时间戳：小到不抢戏，但每条都有 —— 插话重排之后，
/// 位置顺序不再等于时间顺序，时间戳是用户核对"谁在什么时候说的"的唯一依据。
class _TimeLabel extends StatelessWidget {
  const _TimeLabel({required this.createdAt, this.alignEnd = false});

  final int createdAt;
  final bool alignEnd;

  @override
  Widget build(BuildContext context) {
    final text = formatTime(createdAt);
    if (text.isEmpty) return const SizedBox.shrink();
    return Align(
      alignment: alignEnd ? Alignment.centerRight : Alignment.centerLeft,
      child: Text(
        text,
        style: TextStyle(
          fontSize: 9,
          color: PB.textQuaternary,
          letterSpacing: 0.2,
        ),
      ),
    );
  }
}

/// 长按菜单包装：只在**触屏**上参与手势竞争。
///
/// 为什么不直接用 GestureDetector(onLongPress:)：
///   Flutter 的 SelectableRegion 在桌面端是用 TapAndPanGestureRecognizer
///   处理鼠标拖动选区的。外层再挂一个 LongPressGestureRecognizer，
///   两者会同时进手势竞技场：长按计时器 500ms 一到就把竞技场赢走，
///   正在进行的拖动随之中断 —— 表现就是"文字拖不动、选不上"。
///
///   长按本来是移动端交互（桌面有右键菜单和 ⌘C）。所以这里把长按
///   限定在 touch/stylus 设备上：鼠标拖动归选区，手指长按归菜单，
///   两者不再抢同一个指针。
Widget _longPressWrapper(VoidCallback? onLongPress, Widget child) {
  if (onLongPress == null) return child;
  return RawGestureDetector(
    gestures: <Type, GestureRecognizerFactory>{
      LongPressGestureRecognizer:
          GestureRecognizerFactoryWithHandlers<LongPressGestureRecognizer>(
            () => LongPressGestureRecognizer(),
            (instance) => instance
              ..onLongPress = onLongPress
              // 桌面鼠标不参与：把拖动让给文字选区
              ..supportedDevices = const <PointerDeviceKind>{
                PointerDeviceKind.touch,
                PointerDeviceKind.stylus,
                PointerDeviceKind.invertedStylus,
              },
          ),
    },
    child: child,
  );
}

class _MessageRow extends StatelessWidget {
  const _MessageRow({
    required this.msg,
    required this.showAuthor,
    required this.showAvatar,
    required this.bot,
    required this.isGroup,
    required this.onLongPress,
    this.mentions = const [],
    this.isLead = false,
    this.mentionOf,
    this.columnWidth,
  });

  final Msg msg;
  final bool showAuthor;

  /// 消息列的实际可用宽度（聊天栏被展开成多宽，不是整个窗口多宽）。
  ///
  /// 为什么不用 MediaQuery：右侧开着面板 + 浏览器栏时，窗口 2000px
  /// 而聊天栏可能只有 500px —— 按窗口算气泡会被撑到比聊天栏还宽。
  /// 传 null 时退回 MediaQuery（单页、窄屏那些地方没人传）。
  final double? columnWidth;

  /// 这条是不是**最后一条**排队中的消息？
  ///
  /// 用户："这个下面闪电 说下一步会看到不需要每一句话都有" ——
  /// 连着插三句就挂三个提示，太吵。挂在最后一条上，读起来就是
  /// "从这儿往后它还没看到"。
  bool _isLastSteer(BuildContext context, Msg m) {
    final list = AppScope.of(context).messages[m.roomId] ?? const <Msg>[];
    for (var i = list.length - 1; i >= 0; i--) {
      if (list[i].wasSteer) return list[i].id == m.id;
    }
    return true;
  }

  /// 是不是"这个作者连续发言的最后一条" —— 头像挂在这一条上
  final bool showAvatar;
  final Bot? bot;

  /// 群聊还是私聊 —— 决定要不要画头像
  final bool isGroup;
  final VoidCallback onLongPress;

  /// 部门成员名字，用来高亮 @提及
  final List<String> mentions;

  /// 这条消息的作者是不是这个部门的负责人
  final bool isLead;

  /// @提及 → chip/悬停卡要用的信息（名字换成 bot）
  final MentionInfo? Function(String name)? mentionOf;

  /// 用户在卡片上选了/自己写了 → **原样当成一条普通消息发回去**。
  /// 这样服务端不用多一套协议，bot 拿到的就是"用户说话了"。
  Future<void> _answerAsk(BuildContext context, String text) async {
    await AppScope.read(context).sendMessage(msg.roomId, text);
  }

  /// 这条消息在回应谁 —— 找出被引用的那条，渲染成引用条。
  Widget _quoteStripFor(BuildContext context, Msg m) {
    final state = AppScope.of(context);
    final target = m.replyToId;
    Msg? quoted;
    if (target != null) {
      for (final x in state.messages[m.roomId] ?? const <Msg>[]) {
        if (x.id == target) {
          quoted = x;
          break;
        }
      }
    }
    final fromId = m.replyToAuthorId;
    final fallback = fromId == null ? '' : (state.botById(fromId)?.name ?? '');
    return MsgQuoteStrip(quoted: quoted, fallbackName: fallback);
  }

  @override
  Widget build(BuildContext context) {
    // 引用行（bot 私信了别的 bot）不画气泡，只渲染一个可点的小浮动条。
    if (msg.isRef) return MsgRefChip(refs: msg.refs, senderBotId: msg.authorId);
    // 上下文压缩：在对话中间留一条小横条 ——
    // 不然用户看到的是"bot 刚才那几轮说的话不见了"，不知道发生了什么。
    if (msg.isCompact) return CompactNotice(msg: msg);
    // 「问你」卡片：卡住时让用户点一下/写一句，不用打字回一长串
    if (msg.isAsk) {
      return AskCard(msg: msg, onAnswer: (text) => _answerAsk(context, text));
    }
    // 「要动手了，批不批」卡片（部门规矩 = 需要批准时）
    if (msg.isApproval) {
      return ApprovalCard(
        msg: msg,
        onDecide: (approve) =>
            AppScope.read(context)
                .decideApproval(msg.approvalId ?? '', approve: approve),
      );
    }

    // ★ 用户按 Esc 终止的那一条：整条不渲染。
    //
    //   跟 pi agent 里的体验对齐：终止就是终止，聊天记录里不留痕。
    //   不画"已按你的要求终止"的灰气泡 —— 看起来像程序出错了，
    //   而那是用户自己的操作，不需要被告知。
    if (msg.isAborted) return const SizedBox.shrink();

    final isUser = msg.isUser;
    // ★ 重试中也是「还在进行」：要转圈、要显示占位文案。
    //   原来只认 isStreaming，retrying 那条被当成「已完成但没内容」，
    //   画出来是一个没有内容的透明气泡。
    final streaming = msg.isLive;

    // ★ 名字和 emoji 一律**从 authorId 现查**，不信消息里存的那一份。
    //   消息里的 authorName 是写入时的快照 —— 用户给 bot 改完名字，
    //   已发出的消息就会一直挂着旧名字（改名的经典坑）。
    //   存着那份只当兜底：bot 被删掉之后，历史消息还得有个署名。
    final displayName = bot?.name ?? msg.authorName;
    final displayEmoji = bot?.emoji ?? msg.authorEmoji;

    final accent = PB.colorFor(msg.authorId ?? displayName);

    // 私聊里每条都是同一个人，头像和头部重复 —— 整列都不要（气泡能贴左一点）。
    // 群聊里**这一列永远占位**，只有头像本身按需画：
    // 同一串消息里如果有的行有缩进、有的没有，气泡就不在同一列上（错位）。
    final reserveAvatarColumn = isGroup;
    final avatar = showAvatar && reserveAvatarColumn;
    // 名字/职位**只在群里标**：
    //   · 私聊里一条条都是同一个人，顶上那个胶囊已经写着是谁了 ——
    //     每条气泡上再挂一遍名字，纯属重复。
    //   · 群里主控（总经理）也不标：它是"你这边的人"，标出来只是噪音。
    //     头像还留着 —— 一眼能看出"这条是它说的"。
    final showName = isGroup && showAuthor && bot?.isMain != true;
    // 气泡最宽：**消息列**的 82%，桌面端最多 760。
    //
    // ★ 必须用列宽而不是窗口宽：窗口拉得很宽、但聊天栏被左右两侧挤窄时，
    //   按窗口算会把气泡撑出聊天栏（用户看到的就是「中间像手机一样不拉伸」的反面：
    //   栏变窄了气泡却还那么大，直接把行撑爆）。
    final available = columnWidth ?? MediaQuery.sizeOf(context).width;
    final maxBubble = math.min(available * 0.82, 760.0);

    if (isUser) {
      return Padding(
        // 我发的消息也一样要喘气，不能比 bot 那侧还挤
        padding: const EdgeInsets.only(top: 22),
        child: Align(
          alignment: Alignment.centerRight,
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.end,
            children: [
              Column(
                crossAxisAlignment: CrossAxisAlignment.end,
                children: [
                  if (msg.attachments.isNotEmpty)
                    Padding(
                      padding: EdgeInsets.only(
                        bottom: msg.text.trim().isEmpty ? 0 : 6,
                      ),
                      child: AttachmentList(
                        items: msg.attachments,
                        urlFor: (id) => AppScope.read(context).fileUrl(id),
                        onLongPress: onLongPress,
                        alignEnd: true,
                        maxWidth: math.min(available * 0.74, 560),
                      ),
                    ),
                  if (msg.text.trim().isNotEmpty)
                    _longPressWrapper(
                      onLongPress,
                      Container(
                        constraints: BoxConstraints(
                          maxWidth: math.min(available * 0.74, 560),
                        ),
                        padding: const EdgeInsets.fromLTRB(15, 13, 15, 13),
                        decoration: BoxDecoration(
                          gradient: LinearGradient(
                            begin: Alignment.topLeft,
                            end: Alignment.bottomRight,
                            colors: [
                              PB.colors(context).userBubbleTop,
                              PB.colors(context).userBubbleBottom,
                            ],
                          ),
                          borderRadius: BorderRadius.circular(PB.rBubble),
                          border: Border.all(
                            color: Colors.white.withValues(alpha: 0.10),
                          ),
                          boxShadow: PB.glow(
                            PB.colors(context).userBubbleBottom,
                            blur: 16,
                            alpha: 0.28,
                          ),
                        ),
                        child: MdText(
                          msg.text,
                          linkColor: PB.colors(context).onAccent,
                          selectable: true,
                          onMentionTap: (name) => openBotDm(context, name),
                          onLinkTap: (url) =>
                              AppScope.read(context).openInBrowser(url),
                          mentionOf: mentionOf,
                          style: TextStyle(
                            fontSize: PB.fsBase,
                            height: 1.45,
                            color: PB.colors(context).onAccent,
                          ),
                        ),
                      ),
                    ),
                ],
              ),
              // ★ 每条消息都带时间戳：插话/重排之后，顺序光靠位置看不出来，
              //   时间是唯一可信的"这条是什么时候说的"。
              Padding(
                padding: const EdgeInsets.only(top: 3, right: 4),
                child: _TimeLabel(createdAt: msg.createdAt, alignEnd: true),
              ),
              if (msg.wasSteer && _isLastSteer(context, msg))
                Padding(
                  padding: const EdgeInsets.only(top: 4, right: 4),
                  child: Row(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      Icon(
                        LucideIcons.zap,
                        size: 11,
                        color: PB.colors(context).accentBright,
                      ),
                      const SizedBox(width: 3),
                      Text(
                        // ★ 用户的新要求会让它**立刻停下**，不是排队等。
                        //   followUp 那种"排在后面"只发生在成员互相 @ 的场景。
                        msg.meta?['queued'] == 'followUp'
                            ? L10n.s(context).t('chat.steerQueued')
                            : L10n.s(context).t('chat.steerInterrupted'),
                        style: TextStyle(
                          fontSize: PB.fsXxs,
                          color: PB.colors(context).link,
                        ),
                      ),
                    ],
                  ),
                ),
            ],
          ),
        ),
      );
    }

    return AvatarHoverScope(
      child: Padding(
        // ★ 气泡之间的呼吸：换个人发言 26px，
        //   同一个人连着说 6px —— 间距再小，谁跟谁说的就黏成一坨。
        padding: EdgeInsets.only(top: showAuthor ? 26 : 6),
        child: Row(
          // ★ 头像**贴底**，不是贴顶 —— 这样气泡就落在头像的右上方，
          //   同时名字/职位在气泡的左上方。三者的相对位置一眼看清是谁在说。
          //   （不能用 CrossAxisAlignment.start：头像顶在最上面，名字反而跑到它右边。）
          crossAxisAlignment: CrossAxisAlignment.end,
          children: [
            if (reserveAvatarColumn) ...[
              SizedBox(
                width: 34,
                child: avatar
                    ? Padding(
                        // 往下留一点，别和气泡的最后一行贴死
                        padding: const EdgeInsets.only(bottom: 2),
                        child: BlobAvatar(
                          seed: msg.authorId ?? displayName,
                          color: accent,
                          emoji: displayEmoji,
                          size: 28,
                          animate: false,
                        ),
                      )
                    : null,
              ),
              const SizedBox(width: 8),
            ],
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  if (showName)
                    Padding(
                      padding: const EdgeInsets.only(bottom: 7),
                      child: Row(
                        children: [
                          Text(
                            displayName,
                            style: TextStyle(
                              fontSize: PB.fsSm,
                              fontWeight: FontWeight.w600,
                              color: accent,
                            ),
                          ),
                          if (isLead)
                            Padding(
                              padding: const EdgeInsets.only(left: 6),
                              child: Text(
                                L10n.s(context).t('chat.leadBadge'),
                                style: TextStyle(
                                  fontSize: PB.fsXxs,
                                  fontWeight: FontWeight.w600,
                                  color: PB.textQuaternary,
                                ),
                              ),
                            ),
                        ],
                      ),
                    ),
                  // ★ 这条在回应谁：气泡上方一条引用。
                  //
                  //   没有它，bot 之间的往来就只是一排独立卡片，
                  //   读不出谁在接谁的话；加上之后才是「引用 + 回应」。
                  if (msg.replyToId != null) _quoteStripFor(context, msg),
                  // ★ 工具调用卡片：**平时根本不显示**。
                  //
                  //   用户看的是结论，不是“它跑了什么命令”—— 截屏里一长串
                  //   `read_shell / run_background / kill_shell` 对用户既没用也看不懂，
                  //   还把真正的回答顶到屏幕外面去了。
                  //
                  //   只保留两个必要的瞬间：
                  //     · 正在跑：一行“正在干活…”给人一个反馈（不然以为什么都没发生）
                  //     · 出错了：把失败露出来（失败不能藏）
                  //   跑完且没出错 → 整块消失。
                  // ★ 工具步骤也要跟着 streamTick 刷新。
                  //
                  //   msg.steps 的处理和 msg.delta 一样：改完自增
                  //   streamTick 就 return，不调 notifyListeners
                  //   （见 app_state.dart 的 msg.steps 分支）。
                  //   不订阅的话，「正在干活…」这行和失败卡片同样不会更新。
                  if (msg.steps.isNotEmpty)
                    streaming
                        ? ValueListenableBuilder<int>(
                            valueListenable:
                                AppScope.read(context).streamTick,
                            builder: (_, __, ___) => ToolSteps(
                              steps: msg.steps,
                              quietWhenDone: true,
                            ),
                          )
                        : ToolSteps(
                            steps: msg.steps,
                            // 消息跑完且无错时不渲染（组件自己返回 SizedBox.shrink）
                            quietWhenDone: true,
                          ),
                  if (msg.changes != null)
                    ChangedFilesView(summary: msg.changes!),
                  if (msg.attachments.isNotEmpty)
                    Padding(
                      padding: const EdgeInsets.only(bottom: 6),
                      child: AttachmentList(
                        items: msg.attachments,
                        urlFor: (id) => AppScope.read(context).fileUrl(id),
                        onLongPress: onLongPress,
                        maxWidth: maxBubble,
                      ),
                    ),
                  if (msg.text.trim().isNotEmpty ||
                      (streaming && msg.text.isEmpty))
                    // ★ 桌面端不挂 onLongPress。
                    //
                    //   长按是移动端交互；桌面上它注册的指针手势会和
                    //   SelectionArea 抢事件 —— 表现就是"文字拖不动、选不上"。
                    //   桌面端有右键菜单与 ⌘C，不需要长按。
                    _longPressWrapper(
                      onLongPress,
                      Container(
                        constraints: BoxConstraints(maxWidth: maxBubble),
                        padding: const EdgeInsets.fromLTRB(15, 13, 15, 13),
                        decoration: BoxDecoration(
                          color: PB.bgBubble,
                          borderRadius: BorderRadius.circular(PB.rBubble),
                          border: Border.all(
                            color: msg.status == 'error'
                                ? PB.danger.withValues(alpha: 0.45)
                                : (streaming
                                      ? PB
                                            .colors(context)
                                            .accent
                                            .withValues(alpha: 0.22)
                                      : PB.borderHighlight),
                          ),
                          boxShadow: PB.shadow(y: 1, blur: 4, alpha: 0.22),
                        ),
                        // ★ 流式气泡单独订阅 streamTick。
                        //
                        //   为什么必须这么做：msg.delta 只改 msg.text 然后
                        //   自增 streamTick，**不调 notifyListeners**
                        //   （见 app_state.dart 的 msg.delta 分支，末尾是 return）。
                        //   而 chat_screen 是靠 AppScope.of（InheritedNotifier）
                        //   在 notifyListeners 时才重建的 —— 所以纯文字流式时
                        //   气泡内容根本不刷新，要等某个无关事件触发整屏重建
                        //   才突然显示出全文。这是个显示 bug，不只是性能问题。
                        //
                        //   ★ 只让**正在流式的这一条**订阅，绝不能让整个
                        //   ChatScreen 订阅：否则每 80ms 整屏重建一次，
                        //   所有可见气泡都会重新解析 Markdown，比现在更卡。
                        //   用 AppScope.read（不建立依赖），不是 of。
                        child: !streaming
                            ? MdText(
                                msg.text,
                                selectable: true,
                                onMentionTap: (name) =>
                                    openBotDm(context, name),
                                onLinkTap: (url) =>
                                    AppScope.read(context).openInBrowser(url),
                                mentionOf: mentionOf,
                                mentions: mentions,
                                style: TextStyle(
                                  fontSize: PB.fsBase,
                                  height: 1.5,
                                  color: PB.textPrimary,
                                ),
                              )
                            : ValueListenableBuilder<int>(
                                valueListenable:
                                    AppScope.read(context).streamTick,
                                builder: (_, __, ___) => msg.text.isEmpty
                                    ? const _TypingDots()
                                    : MdText(
                                        '${msg.text}▍',
                                        selectable: false,
                                        onMentionTap: (name) =>
                                            openBotDm(context, name),
                                        onLinkTap: (url) => AppScope.read(
                                          context,
                                        ).openInBrowser(url),
                                        mentionOf: mentionOf,
                                        mentions: mentions,
                                        style: TextStyle(
                                          fontSize: PB.fsBase,
                                          height: 1.5,
                                          color: PB.textPrimary,
                                        ),
                                      ),
                              ),
                      ),
                    ),
                  if (msg.error != null && msg.error!.isNotEmpty)
                    Padding(
                      padding: const EdgeInsets.only(top: 5, left: 2),
                      child: Text(
                        msg.error!,
                        style: const TextStyle(
                          fontSize: PB.fsXs,
                          color: PB.danger,
                        ),
                      ),
                    ),
                  // ★ 每条消息都带时间戳（同用户侧：重排后时间是唯一可信的顺序）
                  Padding(
                    padding: const EdgeInsets.only(top: 3, left: 2),
                    child: _TimeLabel(createdAt: msg.createdAt),
                  ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _TypingDots extends StatefulWidget {
  const _TypingDots();

  @override
  State<_TypingDots> createState() => _TypingDotsState();
}

class _TypingDotsState extends State<_TypingDots>
    with SingleTickerProviderStateMixin {
  late final AnimationController _controller = AnimationController(
    vsync: this,
    duration: const Duration(milliseconds: 1100),
  )..repeat();

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return AnimatedBuilder(
      animation: _controller,
      builder: (context, _) => Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          for (var i = 0; i < 3; i++)
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: 2.5, vertical: 5),
              child: Opacity(
                opacity:
                    0.25 +
                    0.75 *
                        (1 -
                            (((_controller.value * 3 - i) % 3).clamp(0.0, 1.0) *
                                        2 -
                                    1)
                                .abs()),
                child: Container(
                  width: 6,
                  height: 6,
                  decoration: BoxDecoration(
                    color: PB.textSecondary,
                    shape: BoxShape.circle,
                  ),
                ),
              ),
            ),
        ],
      ),
    );
  }
}

/// 点 @提及 → 跳到那个 bot 的私聊。
///
/// agent 之间在群里互相 @ 派活时，用户能一键跟过去看它们私下说了什么。
/// 名字对不上就静默忽略（模型偶尔会 @ 一个不存在的名字，不该弹错）。
Future<void> openBotDm(BuildContext context, String name) async {
  if (name.isEmpty) return;
  final state = AppScope.of(context);
  Bot? target;
  for (final b in state.bots) {
    if (b.name == name) {
      target = b;
      break;
    }
  }
  if (target == null) return;
  final room = await state.ensureDm(target.id);
  if (room == null || !context.mounted) return;
  // ★ 不能用 state.openRoom(room.id)：它只记一个"正在看哪个房间"，不发通知；
  //   而宽屏分栏的选中项是 HomeShell 自己的状态，压根不看这个字段，
  //   点了 @ 什么都不会发生。走统一入口，由 HomeShell 按布局决定怎么切。
  requestRoom(context, room.id);
}

/// 悬停会"浮起来"的包裹器：上移一点、加点阴影、右边冒出一个 `>`。
///
/// 为什么要它：胶囊是**唯一**能打开右侧面板的入口，但上面什么提示都没有 ——
/// 用户不知道它可点（"现代化交互"里，可点的东西得自己说出来）。
/// 不做成常驻箭头是因为那会一直占着宽度、看着吵；悬停才出现刚好。
class _HoverLift extends StatefulWidget {
  const _HoverLift({required this.child, this.onTap});

  final Widget child;
  final VoidCallback? onTap;

  @override
  State<_HoverLift> createState() => _HoverLiftState();
}

class _HoverLiftState extends State<_HoverLift> {
  bool _hover = false;

  @override
  Widget build(BuildContext context) {
    return MouseRegion(
      cursor: SystemMouseCursors.basic,
      onEnter: (_) => setState(() => _hover = true),
      onExit: (_) => setState(() => _hover = false),
      child: GestureDetector(
        behavior: HitTestBehavior.opaque,
        onTap: widget.onTap,
        child: AnimatedContainer(
          duration: const Duration(milliseconds: 140),
          curve: Curves.easeOut,
          // 浮起来：往上挪 1px + 一层柔和的影
          transform: Matrix4.translationValues(0, _hover ? -1 : 0, 0),
          decoration: BoxDecoration(
            borderRadius: BorderRadius.circular(PB.rFull),
            boxShadow: _hover
                ? PB.shadow(y: 3, blur: 12, alpha: 0.36)
                : const [],
          ),
          child: Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              widget.child,
              // `>` 悬停才出现，并用宽度动画让胶囊自然变宽（不跳）
              AnimatedContainer(
                duration: const Duration(milliseconds: 140),
                width: _hover ? 16 : 0,
                child: _hover
                    ? Icon(
                        LucideIcons.chevronRight,
                        size: 14,
                        color: PB.textTertiary,
                      )
                    : null,
              ),
              SizedBox(width: _hover ? 4 : 0),
            ],
          ),
        ),
      ),
    );
  }
}
