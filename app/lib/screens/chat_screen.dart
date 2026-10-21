import 'dart:async';
import 'dart:io';
import 'dart:math' as math;

import 'package:desktop_drop/desktop_drop.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:file_picker/file_picker.dart';
import 'package:image_picker/image_picker.dart';

import '../app_state.dart';
import '../chat_scroll_follow.dart';
import '../clipboard_image.dart';
import '../models.dart';
import '../scope.dart';
import '../desktop_shortcuts.dart';
import '../theme.dart';
import '../widgets/toast.dart';
import '../widgets/attachment_view.dart';
import '../widgets/avatar_life.dart';
import '../widgets/ask_card.dart';
import '../widgets/approval_card.dart';
import '../widgets/blob_avatar.dart';
import '../widgets/context_chip.dart';
import '../widgets/floating_menu.dart';
import '../widgets/md_text.dart';
import '../widgets/msg_ref_chip.dart';
import '../widgets/changed_files.dart';
import '../widgets/task_board.dart';
import '../widgets/automation_sheet.dart';
import '../widgets/tool_steps.dart';
import '../widgets/room_panel.dart';
import '../widgets/message_actions.dart';
import '../widgets/teach_dialog.dart';

import 'package:lucide_icons_flutter/lucide_icons.dart';

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
  final _scroll = ScrollController();
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
      // 新消息计数：只在"往上翻着"的时候累加。
      // 用 state 的 notify（每来一条消息一次），不用 streamTick（那是 80ms 一次的
      // 流式增量，会把计数冲成天文数字）。
      _state!.addListener(_countIfScrolledUp);
      FocusManager.instance.addListener(_onFocusChanged);
    }
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
    _input.dispose();
    _focus.dispose();
    super.dispose();
  }

  /// 焦点一变就排一次"兜底检查"。
  ///
  /// 为什么不能只在 build 里排：焦点丢了**不等于界面要重建** ——
  /// 比如回车提交之后，Flutter 不会因为焦点变化就把整个 ChatScreen 重build，
  /// 于是那时候注册的帧后回调根本不会跑（我第一版就是这么写的，没用）。
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
  /// 用户报："我发送第一条消息、想输入第二条，结果没有聚焦到输入框，
  /// 就算我去点击也不行，直接没法输入。"
  ///
  /// 真机上量过（注入真实鼠标点击 + 截图）：**点击其实能聚焦** ——
  /// 边框变亮、光标也出来了。所以不是"点不动"，是**键盘输入这条路断了**：
  /// Dart 侧 `hasFocus` 还是 true，但引擎那边的文本输入连接已经废了，
  /// 键盘事件根本到不了 Dart。
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
  /// 这是用户那句“就算我去点击也不行”的正面回答：点一下现在真的会重连。
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
  /// 接管，焦点就落在"空"上，用户得再点一下才能接着打（用户报的"发一句、
  /// 再点一下输入框"）。
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
    try {
      final picked = await ImagePicker().pickMultiImage(imageQuality: 88);
      if (picked.isEmpty) return;
      await _uploadAll(picked.map((x) => (x.name, x.readAsBytes)).toList());
    } catch (err) {
      _toast('选图失败：$err');
    }
  }

  Future<void> _pickFiles() async {
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
      _toast('选文件失败：$err');
    }
  }

  /// 粘贴进来的路径 → 收成附件（图片、PDF、Word 都行；一次粘多个也认）
  void _absorbPastedPaths() {
    if (_convertingPaste) return;
    final text = _input.text.trim();
    if (text.isEmpty || text.length > 2000) return;
    // 多行（从资源管理器一次复制多个文件）也支持，每条一个路径
    final lines = text
        .split(RegExp(r'[\r\n]+'))
        .map((l) => l.trim().replaceAll('"', ''))
        .where((l) => l.isNotEmpty)
        .toList();
    if (lines.isEmpty || lines.length > 20) return;
    final files = <File>[];
    for (final line in lines) {
      // 只认“整段就是一个存在的文件”的形态，不碰正常打字内容
      if (line.contains(' ') && !File(line).existsSync()) return;
      final f = File(line);
      if (!f.existsSync()) return;
      files.add(f);
    }
    if (files.isEmpty) return;
    _convertingPaste = true;
    _input.clear();
    _convertingPaste = false;
    unawaited(
      _uploadAll([
        for (final f in files) (f.uri.pathSegments.last, () => f.readAsBytes()),
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
    'node_modules', '.git', '__pycache__', '.venv', 'venv',
    'dist', 'build', '.dart_tool', '.idea', '.vscode', 'target',
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
      if (c is File) files.add(c);
      else if (c is Directory) dirs.add(c);
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

  @override
  Widget build(BuildContext context) {
    final state = AppScope.of(context);
    final room = state.rooms.firstWhere(
      (r) => r.id == widget.room.id,
      orElse: () => widget.room,
    );
    final msgs = state.messages[room.id] ?? const <Msg>[];
    final busy = state.typing[room.id] == true;
    final lead =
        state.botById(room.leadBotId) ??
        state.botById(room.botIds.isNotEmpty ? room.botIds.first : null);

    if (state.lastError != null && state.lastError != _shownError) {
      _shownError = state.lastError;
      final message = _shownError!;
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (!mounted) return;
        toast(context, message);
        AppScope.read(context).clearError();
      });
    }

    if (_stick && msgs.isNotEmpty) {
      _scrollFollow.request();
    }

    // 焦点兜底（见 _keepComposerFocused）—— 放在帧后，别在 build 里抢焦点
    WidgetsBinding.instance.addPostFrameCallback((_) => _keepComposerFocused());

    // 消息列的左右留白：窗口越宽留白越大（内容列最多 1180），
    // 这样一个 2000px 的窗口里气泡也不会贴着两边。
    final sidePad = math.max(
      12.0,
      (MediaQuery.sizeOf(context).width - 1180) / 2,
    );
    // ★ 群里左边要**减掉头像列**（34+8=42）。
    //   头像列是内容的一部分；如果两边留白一样大，群里的气泡会整体右移 42px ——
    //   肉眼看就是"群聊的列比私聊窄了一截"（用户报的）。
    //   减掉之后，气泡的左右边缘在私聊和群聊里落在同一个位置。
    final leftPad = room.isGroup ? math.max(12.0, sidePad - 42) : sidePad;

    return Scaffold(
      backgroundColor: PB.bgPane,
      // ★ 顶部是**浮在上面的小胶囊**，不是一整条 AppBar：
      //   透明背景 + 居中的圆角胶囊（头像 + 会话名），左右各留出返回 / 更多。
      //   整条工具栏是透明的，所以看上去就是"顶上浮了一个小椭圆"。
      appBar: AppBar(
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
        title: AvatarHoverScope(
          child: _HoverLift(
            onTap: () {
              if (MediaQuery.sizeOf(context).width >= kTwoPaneMinWidth) {
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
                    GroupBlobAvatar(seeds: room.botIds, size: 22, animate: busy)
                  else
                    BlobAvatar(
                      seed: room.botIds.isNotEmpty
                          ? room.botIds.first
                          : room.id,
                      color: PB.colorFor(
                        room.botIds.isNotEmpty ? room.botIds.first : room.id,
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
                  // 状态只在"正在干活 / 正在压缩"时露出来 —— 平时不占地方
                  if (busy || state.compactingIn(room.id)) ...[
                    const SizedBox(width: 8),
                    if (state.compactingIn(room.id))
                      const Text(
                        '压缩中',
                        style: TextStyle(fontSize: PB.fsXxs, color: PB.warn),
                      )
                    else
                      const SizedBox(
                        width: 11,
                        height: 11,
                        child: CircularProgressIndicator(
                          strokeWidth: 1.8,
                          color: PB.accent,
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
        actions: [
          // 任务板：显示这个房间未完成的数量，点开是清单
          Builder(
            builder: (ctx) {
              final list = state.tasksFor(room.id);
              final pending = list.where((t) => !t.isDone).length;
              return IconButton(
                padding: EdgeInsets.zero,
                alignment: Alignment.center,
                visualDensity: VisualDensity.compact,
                constraints: const BoxConstraints(minWidth: 40, minHeight: 40),
                tooltip: pending > 0 ? '任务（$pending 个未完成）' : '任务',
                onPressed: () => showTaskBoard(ctx, state, room),
                icon: Badge(
                  isLabelVisible: pending > 0,
                  label: Text('$pending'),
                  backgroundColor: PB.accent,
                  child: Icon(
                    LucideIcons.checkCircle2,
                    size: 18,
                    color: pending > 0 ? PB.accent : PB.textTertiary,
                  ),
                ),
              );
            },
          ),
          PopupMenuButton<String>(
            icon: const Icon(LucideIcons.ellipsis, size: 18),
            padding: EdgeInsets.zero,
            // 紧贴右边的让位块，别在中间再挤出一段空白
            iconSize: 18,
            constraints: const BoxConstraints(minWidth: 36, minHeight: 36),
            onSelected: (value) async {
              switch (value) {
                case 'abort':
                  await state.abort(room.id);
                case 'automations':
                  await showAutomationSheet(context, state, room);
                case 'reset':
                  final ok = await showDialog<bool>(
                    context: context,
                    builder: (ctx) => AlertDialog(
                      title: const Text('开新会话'),
                      content: const Text(
                        '这个会话里的 bot 会忘掉之前的对话。历史消息还留着，只是不再进模型上下文。',
                      ),
                      actions: [
                        TextButton(
                          onPressed: () => Navigator.pop(ctx, false),
                          child: const Text('取消'),
                        ),
                        FilledButton(
                          onPressed: () => Navigator.pop(ctx, true),
                          child: const Text('开新会话'),
                        ),
                      ],
                    ),
                  );
                  if (ok == true) await state.resetSession(room.id);
                case 'reload':
                  await state.loadMessages(room.id, force: true);
                  _scrollFollow.resume();
              }
            },
            itemBuilder: (ctx) => [
              if (busy)
                const PopupMenuItem(value: 'abort', child: Text('打断这一轮')),
              const PopupMenuItem(value: 'reset', child: Text('开新会话（清记忆）')),
              const PopupMenuItem(value: 'automations', child: Text('定时任务…')),
              const PopupMenuItem(value: 'reload', child: Text('重新拉取消息')),
            ],
          ),
          const SizedBox(width: 6),
        ],
      ),
      // ★ 把附件（图片 / PDF / Word…）直接拖进聊天框。
      //   只在桌面端有效（desktop_drop 在移动端不注册），移动端就是普通 Scaffold。
      //   反馈用提示条 —— 不去做布满全屏的高亮层（以前加过，一不小心就把 body
      //   的嵌套改坏、整个文件都不编译了）。
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
            _toast('拖进来的文件夹是空的（或全是跳过的目录）');
            return;
          }
          if (items.length >= _maxFolderFiles) {
            _toast('文件太多（$_maxFolderFiles 个封顶），只收了前 $_maxFolderFiles 个');
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
                            //   ExcludeFocus 从根上关掉这条路。代价是消息里不能再用键盘
                            //   Ctrl+C —— 但每条消息长按有「复制」菜单，功能没丢。
                            RepaintBoundary(
                              child: NotificationListener<Notification>(
                                onNotification:
                                    _scrollFollow.handleNotification,
                                child: ListView.builder(
                                  controller: _scroll,
                                  // ★ 居中限宽：窗口拉宽时左右留白跟着长（内容列最多 1180），
                                  //   气泡就不会被吸附到窗口两边。
                                  //   左边用 leftPad：群里减掉头像列那 42px，
                                  //   这样气泡的左右边缘在私聊/群聊里落在同一位置。
                                  padding: EdgeInsets.fromLTRB(
                                    leftPad,
                                    20,
                                    sidePad,
                                    20,
                                  ),
                                  itemCount: msgs.length,
                                  itemBuilder: (ctx, i) {
                                    final msg = msgs[i];
                                    final prev = i > 0 ? msgs[i - 1] : null;
                                    final newAuthor =
                                        prev == null ||
                                        prev.authorId != msg.authorId ||
                                        prev.authorType != msg.authorType ||
                                        (msg.createdAt - prev.createdAt) >
                                            5 * 60 * 1000;
                                    // 同一个人连着发好几条时，头像挂在**最后一条**上 ——
                                    // 这样整串气泡都在头像的右上方，头像在底部托着。
                                    // （挂在第一条的话，头像会卡在整串中间，很怪。）
                                    final next = i + 1 < msgs.length
                                        ? msgs[i + 1]
                                        : null;
                                    final endOfRun =
                                        next == null ||
                                        next.authorId != msg.authorId ||
                                        next.authorType != msg.authorType ||
                                        (next.createdAt - msg.createdAt) >
                                            5 * 60 * 1000;
                                    // ★ 这条是**外面的人说的**（不在这个会话的名单里）——
                                    //   比如负责人把某个成员的报告转进群里。
                                    //   挂一条「消息来自 X」，点开是**只读**的窥视：
                                    //   看那个 bot 的私聊里到底说了什么（用户要的"链路可见"）。
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
                                                          botId: relayedBot.id,
                                                          roomId:
                                                              relayedRoom.id,
                                                        ),
                                                      ],
                                                    ),
                                            ),
                                          _MessageRow(
                                            msg: msg,
                                            showAuthor: newAuthor,
                                            showAvatar: endOfRun,
                                            bot: state.botById(msg.authorId),
                                            isGroup: room.isGroup,
                                            mentions: room.botNames,
                                            // @ 的名字 → 那个 bot（chip 的颜色、悬停卡的内容都靠它）
                                            mentionOf: (name) {
                                              final b = state.botByName(name);
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
                                                msg.authorId == room.leadBotId,
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
                          color: PB.accent.withValues(alpha: 0.5),
                        ),
                      ),
                      child: const Column(
                        mainAxisSize: MainAxisSize.min,
                        children: [
                          Icon(
                            LucideIcons.paperclip,
                            size: 22,
                            color: PB.accent,
                          ),
                          SizedBox(height: 8),
                          Text(
                            '松手就加进来（图片 / PDF / Word / Excel）',
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

class _EmptyHint extends StatelessWidget {
  const _EmptyHint({required this.room, required this.lead});

  final Room room;
  final Bot? lead;

  @override
  Widget build(BuildContext context) {
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
                  : (isGroup ? '把任务发进来，主控会分给对应的人' : '直接说你要干什么'),
              textAlign: TextAlign.center,
              style: const TextStyle(
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
                              style: const TextStyle(
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
    showFloatingMenu(
      context: context,
      anchorKey: _plusKey,
      entries: [
        FloatingMenuEntry(
          icon: LucideIcons.image,
          label: '添加附件',
          hint: '可多选',
          onTap: widget.onPickImages,
        ),
        FloatingMenuEntry(
          icon: LucideIcons.paperclip,
          label: '上传文件',
          hint: 'PDF/表格',
          onTap: widget.onPickFiles,
        ),
        FloatingMenuEntry(
          icon: LucideIcons.target,
          label: '教它做一项任务',
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
          //   于是它**永远不会打开文本输入连接**。表现就是用户报的：
          //   发完第一条，光标在闪、打字没反应、点一下也没用（点它没有状态变化，
          //   引擎不会重连）。有 key 之后 Flutter 按 key 配对，输入框原地不动。
          if (busy)
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
                    const Icon(LucideIcons.zap, size: 12, color: PB.accent),
                    const SizedBox(width: 5),
                    Text(
                      // ★ 语义变了：用户一说话，正在跑的会**立刻停下**，
                      //   不是"排队等它忙完"。
                      //   所以这里不能说"下一步会看到"——那会让用户以为要等。
                      queuedCount > 0
                          ? '已发了 $queuedCount 句 —— 发出去它会立刻停下来看'
                          : '正在干活 —— 你随时可以打断它，说新的要求',
                      style: const TextStyle(
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
                      const Padding(
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
                              color: PB.accent,
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
                                      errorBuilder: (c, e, s) => const Icon(
                                        LucideIcons.image,
                                        size: 18,
                                        color: PB.textQuaternary,
                                      ),
                                    )
                                  : const Icon(
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
                                  decoration: const BoxDecoration(
                                    color: PB.bgActive,
                                    shape: BoxShape.circle,
                                  ),
                                  child: const Icon(
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
                  tooltip: '附件 / 教它做任务',
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
                            ? PB.accent.withValues(alpha: 0.45)
                            : PB.borderSecondary,
                      ),
                      boxShadow: widget.focus.hasFocus
                          ? PB.glow(PB.accent, blur: 14, alpha: 0.12)
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
                      //   显式声明而不是全靠 Flutter 默认，是因为我们在
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
                          // 手机软键盘上回车键直接变成「发送」
                          textInputAction: TextInputAction.send,
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
                            hintText: '说点什么',
                            hintStyle: const TextStyle(
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
                        ? '回到最新（下面还有 ${widget.unread} 条）'
                        : '回到最新',
                    onTap: widget.onJump ?? () {},
                  ),
                  const SizedBox(width: 6),
                ],
                if (busy) ...[
                  _RoundButton(
                    icon: LucideIcons.square,
                    color: PB.bgActive,
                    iconColor: PB.textSecondary,
                    tooltip: '打断这一轮',
                    onTap: onStop,
                  ),
                  const SizedBox(width: 6),
                ],
                _RoundButton(
                  icon: busy ? LucideIcons.zap : LucideIcons.arrowUp,
                  color: hasText ? PB.accent : PB.bgActive,
                  iconColor: hasText ? Colors.white : PB.textQuaternary,
                  tooltip: busy ? '发出去，它会看到 (Enter)' : '发送 (Enter)',
                  onTap: onSend,
                ),
              ],
            ),
          ),
          // ★ 这里以前有一行「Enter 发送 · Shift+Enter 换行」的操作说明。
          //   删除的两个理由：
          //   1. **没人需要被告知回车能发送** —— 正常聊天软件都不说。
          //   2. 它是"有字才出现"的，一出现就把整个输入区顶高一行 ——
          //      用户报的"直接从下面突然出现导致整个界面波动一下"就是它。
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

/// 这条消息是不是「从别处转过来的」（需要在气泡上方挂「消息来自 X」）。
///
/// 判断依据是「作者不在这个会话的名单里」，但**主控永远不算**：
/// 主控是全局派活的人，它出现在部门群/某个 bot 的私聊里，本身就是正常的下发任务
/// 或者对任务的回复。把它标成「消息来自 主控」，用户会以为这些消息是从别处
/// 搬进来的二手信息，反而看不清真正的链路。
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
/// 以前只有"已发送给 X"那种（bot 主动私信时才有），转发进来的没有标记。
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
                  '消息来自',
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
  });

  final Msg msg;
  final bool showAuthor;

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

  @override
  Widget build(BuildContext context) {
    // 引用行（bot 私信了别的 bot）不画气泡，只渲染一个可点的小浮动条。
    if (msg.isRef) return MsgRefChip(refs: msg.refs);
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
        onDecide: (approve) => AppScope.read(context).decideApproval(
          msg.approvalId ?? '',
          approve: approve,
        ),
      );
    }

    // ★ 用户按 Esc 终止的那一条：整条不渲染。
    //
    //   跟 pi agent 里的体验对齐：终止就是终止，聊天记录里不留痕。
    //   以前这里会把消息画成"已按你的要求终止"的灰气泡，
    //   看起来像程序出错了 —— 而那是用户自己的操作，不需要被告知。
    if (msg.isAborted) return const SizedBox.shrink();

    final isUser = msg.isUser;
    final streaming = msg.isStreaming;

    // ★ 名字和 emoji 一律**从 authorId 现查**，不信消息里存的那一份。
    //   消息里的 authorName 是写入时的快照 —— 用户给 bot 改完名字，
    //   它以前发过的消息就会一直挂着旧名字（改名的经典坑）。
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
    //     每条气泡上再挂一遍名字，纯属重复（用户："只要有胶囊让我知道他是谁就行了"）
    //   · 群里主控（总经理）也不标：它是"你这边的人"，标出来只是噪音。
    //     头像还留着 —— 一眼能看出"这条是它说的"。
    final showName = isGroup && showAuthor && bot?.isMain != true;
    // 气泡最宽：屏幕 78%，桌面端最多 620，避免一行铺到大半个屏
    // 气泡最宽：屏幕的 82%，桌面端最多 760（以前 620，用户嫌窄）
    final maxBubble = math.min(MediaQuery.sizeOf(context).width * 0.82, 760.0);

    if (isUser) {
      return Padding(
        // 我发的消息也一样要喘气（以前 10，比 bot 那侧还挤）
        padding: const EdgeInsets.only(top: 22),
        child: Align(
          alignment: Alignment.centerRight,
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.end,
            children: [
              GestureDetector(
                onLongPress: onLongPress,
                child: Container(
                  constraints: BoxConstraints(
                    maxWidth: math.min(
                      MediaQuery.sizeOf(context).width * 0.74,
                      560,
                    ),
                  ),
                  padding: const EdgeInsets.fromLTRB(15, 13, 15, 13),
                  decoration: BoxDecoration(
                    gradient: const LinearGradient(
                      begin: Alignment.topLeft,
                      end: Alignment.bottomRight,
                      colors: [PB.userBubbleTop, PB.userBubbleBottom],
                    ),
                    borderRadius: BorderRadius.circular(PB.rBubble),
                    border: Border.all(
                      color: Colors.white.withValues(alpha: 0.10),
                    ),
                    boxShadow: PB.glow(
                      PB.userBubbleBottom,
                      blur: 16,
                      alpha: 0.28,
                    ),
                  ),
                  child: Column(
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
                            isUser: true,
                          ),
                        ),
                      if (msg.text.trim().isNotEmpty)
                        ExcludeFocus(
                          child: MdText(
                            msg.text,
                            selectable: true,
                            onMentionTap: (name) => openBotDm(context, name),
                            mentionOf: mentionOf,
                            style: const TextStyle(
                              fontSize: PB.fsBase,
                              height: 1.45,
                              color: Colors.white,
                            ),
                          ),
                        ),
                    ],
                  ),
                ),
              ),
              if (msg.wasSteer && _isLastSteer(context, msg))
                Padding(
                  padding: const EdgeInsets.only(top: 4, right: 4),
                  child: Row(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      const Icon(LucideIcons.zap, size: 11, color: PB.accent),
                      const SizedBox(width: 3),
                      Text(
                        // ★ 用户的新要求会让它**立刻停下**，不是排队等。
                        //   followUp 那种"排在后面"只发生在成员互相 @ 的场景。
                        msg.meta?['queued'] == 'followUp'
                            ? '排在它后面，做完会看'
                            : '已打断它，按这条重新开始',
                        style: const TextStyle(
                          fontSize: PB.fsXxs,
                          color: PB.accent,
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
        //   同一个人连着说 6px。以前是 16 / 3 —— 谁跟谁说的都黏成一坨。
        padding: EdgeInsets.only(top: showAuthor ? 26 : 6),
        child: Row(
          // ★ 头像**贴底**，不是贴顶 —— 这样气泡就落在头像的右上方，
          //   同时名字/职位在气泡的左上方。三者的相对位置一眼看清是谁在说。
          //   （以前是 CrossAxisAlignment.start，头像顶在最上面，名字反而跑到它右边。）
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
                            const Padding(
                              padding: EdgeInsets.only(left: 6),
                              child: Text(
                                '负责人',
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
                  if (msg.steps.isNotEmpty)
                    ToolSteps(
                      steps: msg.steps,
                      // 消息跑完且无错时不渲染（组件自己返回 SizedBox.shrink）
                      quietWhenDone: true,
                    ),
                  if (msg.changes != null)
                    ChangedFilesView(summary: msg.changes!),
                  GestureDetector(
                    onLongPress: onLongPress,
                    child: Container(
                      constraints: BoxConstraints(maxWidth: maxBubble),
                      padding: const EdgeInsets.fromLTRB(15, 13, 15, 13),
                      decoration: BoxDecoration(
                        color: PB.bgBubble,
                        borderRadius: BorderRadius.circular(PB.rBubble),
                        border: Border.all(
                          color: msg.status == 'error'
                              ? PB.danger.withValues(alpha: 0.45)
                              : (streaming
                                    ? PB.accent.withValues(alpha: 0.22)
                                    : PB.borderHighlight),
                        ),
                        boxShadow: PB.shadow(y: 1, blur: 4, alpha: 0.22),
                      ),
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          if (msg.attachments.isNotEmpty)
                            AttachmentList(
                              items: msg.attachments,
                              urlFor: (id) =>
                                  AppScope.read(context).fileUrl(id),
                            ),
                          if (streaming &&
                              msg.text.isEmpty &&
                              msg.attachments.isEmpty)
                            const _TypingDots()
                          else if (msg.text.trim().isNotEmpty)
                            ExcludeFocus(
                              child: MdText(
                                streaming ? '${msg.text}▍' : msg.text,
                                selectable: !streaming,
                                onMentionTap: (name) =>
                                    openBotDm(context, name),
                                mentionOf: mentionOf,
                                mentions: mentions,
                                style: const TextStyle(
                                  fontSize: PB.fsBase,
                                  height: 1.5,
                                  color: PB.textPrimary,
                                ),
                              ),
                            ),
                        ],
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
                  // 用量行（↑0 ↓0 ⚡0）不再显示，属于噪音
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
                  decoration: const BoxDecoration(
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
  // ★ 以前这里是 state.openRoom(room.id) —— 它只记一个"正在看哪个房间"，
  //   不发通知；而宽屏分栏的选中项是 HomeShell 自己的状态，压根不看这个字段，
  //   所以点了 @ 什么都不会发生。走统一入口，由 HomeShell 按布局决定怎么切。
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
                    ? const Icon(
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
