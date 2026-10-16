import 'dart:async';
import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:window_manager/window_manager.dart';
import 'package:file_picker/file_picker.dart';
import 'package:image_picker/image_picker.dart';

import '../app_state.dart';
import '../models.dart';
import '../scope.dart';
import '../text_utils.dart';
import '../theme.dart';
import '../widgets/attachment_view.dart';
import '../widgets/blob_avatar.dart';
import '../widgets/md_text.dart';
import '../widgets/window_title_bar.dart';
import '../widgets/message_actions.dart';
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

class _ChatScreenState extends State<ChatScreen> {
  final _scroll = ScrollController();
  final _input = TextEditingController();
  final _focus = FocusNode();
  AppState? _state;
  bool _stick = true;
  String? _shownError;
  final List<Attachment> _pending = [];
  bool _uploading = false;

  @override
  void initState() {
    super.initState();
    if (widget.initialText != null) {
      _input.text = widget.initialText!;
      _input.selection = TextSelection.collapsed(offset: _input.text.length);
    }
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    if (_state == null) {
      _state = AppScope.read(context);
      _state!.openRoom(widget.room.id);
      unawaited(_state!.loadMessages(widget.room.id));
      _scroll.addListener(() {
        if (!_scroll.hasClients) return;
        _stick = (_scroll.position.maxScrollExtent - _scroll.offset) < 140;
      });
    }
  }

  @override
  void dispose() {
    _state?.openRoom(null);
    _scroll.dispose();
    _input.dispose();
    _focus.dispose();
    super.dispose();
  }

  void _toBottom({bool animate = false}) {
    if (!_scroll.hasClients) return;
    if (animate) {
      _scroll.animateTo(
        _scroll.position.maxScrollExtent,
        duration: const Duration(milliseconds: 220),
        curve: Curves.easeOut,
      );
    } else {
      _scroll.jumpTo(_scroll.position.maxScrollExtent);
    }
  }

  Future<void> _send() async {
    final text = _input.text;
    final files = List<Attachment>.from(_pending);
    if (text.trim().isEmpty && files.isEmpty) return;
    _input.clear();
    setState(() => _pending.clear());
    _stick = true;
    final state = AppScope.read(context);
    try {
      await state.sendMessage(widget.room.id, text, attachments: files);
    } catch (err) {
      if (mounted) {
        ScaffoldMessenger.of(context)
            .showSnackBar(SnackBar(content: Text('$err')));
        _input.text = text;
        setState(() => _pending.addAll(files));
      }
    } finally {
      // 发完继续留着焦点，方便接着敲
      if (mounted) _focus.requestFocus();
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
    ScaffoldMessenger.of(context)
        .showSnackBar(SnackBar(content: Text(message)));
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
        ScaffoldMessenger.of(context)
            .showSnackBar(SnackBar(content: Text(message)));
        AppScope.read(context).clearError();
      });
    }

    if (_stick && msgs.isNotEmpty) {
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (mounted) _toBottom();
      });
    }

    return Scaffold(
      backgroundColor: PB.bgPane,
      appBar: AppBar(
        backgroundColor: PB.bgPane,
        toolbarHeight: 60,
        automaticallyImplyLeading: !widget.embedded,
        titleSpacing: widget.embedded ? 14 : 0,
        title: Row(
          children: [
            if (room.isGroup)
              GroupBlobAvatar(seeds: room.botIds, size: 32, animate: false)
            else
              BlobAvatar(
                seed: room.botIds.isNotEmpty ? room.botIds.first : room.id,
                color: PB.colorFor(
                  room.botIds.isNotEmpty ? room.botIds.first : room.id,
                ),
                emoji: lead?.emoji,
                size: 32,
                animate: false,
              ),
            const SizedBox(width: 11),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                mainAxisAlignment: MainAxisAlignment.center,
                children: [
                  Text(
                    room.name,
                    style: const TextStyle(
                      fontSize: PB.fsBase,
                      fontWeight: FontWeight.w500,
                    ),
                    overflow: TextOverflow.ellipsis,
                  ),
                  const SizedBox(height: 2),
                  Text(
                    busy
                        ? '正在干活…'
                        : (room.isGroup
                              ? '负责人 ${room.leadName ?? '-'} · ${room.botIds.length} 人'
                              : (firstLine(lead?.persona ?? '').isNotEmpty
                                    ? preview(lead!.persona, 34)
                                    : '在线')),
                    style: TextStyle(
                      fontSize: PB.fsXxs,
                      color: busy ? PB.accent : PB.textQuaternary,
                    ),
                    overflow: TextOverflow.ellipsis,
                  ),
                ],
              ),
            ),
          ],
        ),
        actions: [
          // 无边框窗口：自己提供最小化 / 最大化 / 关闭
          if (WindowTitleBar.isSupported) ...[
            IconButton(
              tooltip: '最小化',
              iconSize: 17,
              onPressed: () => windowManager.minimize(),
              icon: const Icon(LucideIcons.minus),
            ),
            IconButton(
              tooltip: '最大化 / 还原',
              iconSize: 16,
              onPressed: () async {
                if (await windowManager.isMaximized()) {
                  await windowManager.unmaximize();
                } else {
                  await windowManager.maximize();
                }
              },
              icon: const Icon(LucideIcons.square),
            ),
            IconButton(
              tooltip: '关闭',
              iconSize: 17,
              onPressed: () => windowManager.close(),
              icon: const Icon(LucideIcons.x),
            ),
            const SizedBox(width: 4),
          ],
          if (busy)
            Padding(
              padding: const EdgeInsets.only(right: 6),
              child: _StopButton(onTap: () => state.abort(room.id)),
            ),
          PopupMenuButton<String>(
            icon: const Icon(LucideIcons.ellipsis, size: 18),
            padding: EdgeInsets.zero,
            constraints: const BoxConstraints(minWidth: 36, minHeight: 36),
            onSelected: (value) async {
              switch (value) {
                case 'abort':
                  await state.abort(room.id);
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
                  _stick = true;
              }
            },
            itemBuilder: (ctx) => [
              if (busy)
                const PopupMenuItem(value: 'abort', child: Text('打断这一轮')),
              const PopupMenuItem(value: 'reset', child: Text('开新会话（清记忆）')),
              const PopupMenuItem(value: 'reload', child: Text('重新拉取消息')),
            ],
          ),
          const SizedBox(width: 6),
          // 无边框窗口：最小化 / 最大化 / 关闭放在右上角（这里就是窗口右上角）
          const WindowControls(),
          const SizedBox(width: 8),
        ],
      ),
      body: Column(
        children: [
          Expanded(
            child: msgs.isEmpty
                ? _EmptyHint(room: room, lead: lead)
                : Stack(
                    children: [
                      ListView.builder(
                        controller: _scroll,
                        padding: const EdgeInsets.fromLTRB(12, 16, 12, 16),
                        itemCount: msgs.length,
                        itemBuilder: (ctx, i) {
                          final msg = msgs[i];
                          final prev = i > 0 ? msgs[i - 1] : null;
                          final newAuthor =
                              prev == null ||
                              prev.authorId != msg.authorId ||
                              prev.authorType != msg.authorType ||
                              (msg.createdAt - prev.createdAt) > 5 * 60 * 1000;
                          // 不居中：整行铺满，bot 贴左、我贴右
                          return _Appear(
                            key: ValueKey(msg.id),
                            child: _MessageRow(
                              msg: msg,
                              showAuthor: newAuthor,
                              bot: state.botById(msg.authorId),
                              mentions: room.botNames,
                              isLead: room.isGroup &&
                                  msg.authorId != null &&
                                  msg.authorId == room.leadBotId,
                              onLongPress: () =>
                                  showMessageActions(context, msg),
                            ),
                          );
                        },
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
                                colors: [PB.bgPane, PB.bgPane.withValues(alpha: 0)],
                              ),
                            ),
                          ),
                        ),
                      ),
                      if (!_stick)
                        Positioned(
                          right: 16,
                          bottom: 12,
                          child: Material(
                            color: PB.bgActive,
                            shape: const CircleBorder(),
                            clipBehavior: Clip.antiAlias,
                            child: InkWell(
                              onTap: () {
                                setState(() => _stick = true);
                                _toBottom(animate: true);
                              },
                              child: const SizedBox(
                                width: 36,
                                height: 36,
                                child: Icon(
                                  LucideIcons.arrowDown,
                                  size: 18,
                                  color: PB.textSecondary,
                                ),
                              ),
                            ),
                          ),
                        ),
                    ],
                  ),
          ),
          _Composer(
            controller: _input,
            focus: _focus,
            busy: busy,
            queuedCount: state.queued[room.id] ?? 0,
            pending: _pending,
            uploading: _uploading,
            onPickImages: _pickImages,
            onPickFiles: _pickFiles,
            onRemovePending: (att) =>
                setState(() => _pending.removeWhere((a) => a.id == att.id)),
            onSend: _send,
            onStop: () => state.abort(room.id),
          ),
        ],
      ),
    );
  }
}

class _StopButton extends StatelessWidget {
  const _StopButton({required this.onTap});

  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return Material(
      color: PB.accent,
      shape: const CircleBorder(),
      clipBehavior: Clip.antiAlias,
      child: InkWell(
        onTap: onTap,
        child: const SizedBox(
          width: 34,
          height: 34,
          child: Icon(LucideIcons.square, size: 18, color: Colors.white),
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
    required this.focus,
    required this.busy,
    required this.queuedCount,
    required this.pending,
    required this.uploading,
    required this.onPickImages,
    required this.onPickFiles,
    required this.onRemovePending,
    required this.onSend,
    required this.onStop,
  });

  final TextEditingController controller;
  final FocusNode focus;
  final bool busy;
  final int queuedCount;
  final List<Attachment> pending;
  final bool uploading;
  final VoidCallback onPickImages;
  final VoidCallback onPickFiles;
  final void Function(Attachment) onRemovePending;
  final VoidCallback onSend;
  final VoidCallback onStop;

  @override
  State<_Composer> createState() => _ComposerState();
}

class _ComposerState extends State<_Composer> {
  bool _hasText = false;

  @override
  void initState() {
    super.initState();
    widget.controller.addListener(_onTextChanged);
    _hasText = widget.controller.text.trim().isNotEmpty;
  }

  void _onTextChanged() {
    final hasText = widget.controller.text.trim().isNotEmpty;
    if (hasText != _hasText) setState(() => _hasText = hasText);
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
          if (busy)
            Padding(
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
                      queuedCount > 0
                          ? '已插话 $queuedCount 条，它会在下一步看到'
                          : '正在干活 —— 现在发送 = 插话引导，不用等',
                      style: const TextStyle(
                        fontSize: PB.fsXxs,
                        color: PB.textTertiary,
                      ),
                    ),
                  ],
                ),
              ),
            ),
          if (pending.isNotEmpty || widget.uploading)
            Padding(
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
            padding: const EdgeInsets.fromLTRB(12, 0, 12, 8),
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.end,
              children: [
                _RoundButton(
                  icon: LucideIcons.plus,
                  color: PB.bgActive,
                  iconColor: PB.textSecondary,
                  tooltip: '加附件',
                  onTap: () => _showAttachSheet(
                    context,
                    widget.onPickImages,
                    widget.onPickFiles,
                  ),
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
                        onSend();
                        return KeyEventResult.handled;
                      },
                      child: TextField(
                        controller: controller,
                        focusNode: widget.focus,
                        minLines: 1,
                        maxLines: 6,
                        keyboardType: TextInputType.multiline,
                        // 手机软键盘上回车键直接变成「发送」
                        textInputAction: TextInputAction.send,
                        onSubmitted: (_) => onSend(),
                        style: const TextStyle(
                          fontSize: PB.fsBase,
                          height: 1.4,
                        ),
                        decoration: InputDecoration(
                          hintText: busy ? '插话引导…' : '说点什么',
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
                const SizedBox(width: 8),
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
                  tooltip: busy ? '插话引导 (Enter)' : '发送 (Enter)',
                  onTap: onSend,
                ),
              ],
            ),
          ),
          if (hasText)
            Padding(
              padding: const EdgeInsets.only(bottom: 4),
              child: Text(
                busy
                    ? 'Enter 插话 · Shift+Enter 换行'
                    : 'Enter 发送 · Shift+Enter 换行',
                style: const TextStyle(
                  fontSize: PB.fsXxs,
                  color: PB.textQuaternary,
                ),
              ),
            ),
        ],
      ),
    );
  }
}

Future<void> _showAttachSheet(
  BuildContext context,
  VoidCallback onPickImages,
  VoidCallback onPickFiles,
) async {
  await showModalBottomSheet<void>(
    context: context,
    backgroundColor: PB.bgElevated,
    shape: const RoundedRectangleBorder(
      borderRadius: BorderRadius.vertical(top: Radius.circular(PB.r3xl)),
    ),
    builder: (ctx) => SafeArea(
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          const SizedBox(height: 10),
          Container(
            width: 36,
            height: 4,
            decoration: BoxDecoration(
              color: PB.borderPrimary,
              borderRadius: BorderRadius.circular(2),
            ),
          ),
          ListTile(
            leading: const Icon(LucideIcons.image, size: 20),
            title: const Text('照片', style: TextStyle(fontSize: PB.fsSm)),
            subtitle: const Text(
              '支持多选',
              style: TextStyle(fontSize: PB.fsXxs, color: PB.textQuaternary),
            ),
            onTap: () {
              Navigator.pop(ctx);
              onPickImages();
            },
          ),
          ListTile(
            leading: const Icon(LucideIcons.fileUp, size: 20),
            title: const Text('文件', style: TextStyle(fontSize: PB.fsSm)),
            subtitle: const Text(
              'PDF / Excel / Word / CSV / MD / HTML …会解析出正文给 bot',
              style: TextStyle(fontSize: PB.fsXxs, color: PB.textQuaternary),
            ),
            onTap: () {
              Navigator.pop(ctx);
              onPickFiles();
            },
          ),
          const SizedBox(height: 8),
        ],
      ),
    ),
  );
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

class _MessageRow extends StatelessWidget {
  const _MessageRow({
    required this.msg,
    required this.showAuthor,
    required this.bot,
    required this.onLongPress,
    this.mentions = const [],
    this.isLead = false,
  });

  final Msg msg;
  final bool showAuthor;
  final Bot? bot;
  final VoidCallback onLongPress;

  /// 部门成员名字，用来高亮 @提及
  final List<String> mentions;

  /// 这条消息的作者是不是这个部门的负责人
  final bool isLead;

  @override
  Widget build(BuildContext context) {
    final isUser = msg.isUser;
    final streaming = msg.isStreaming;
    final accent = PB.colorFor(msg.authorId ?? msg.authorName);
    // 气泡最宽：屏幕 78%，桌面端最多 620，避免一行铺到大半个屏
    final maxBubble = math.min(MediaQuery.sizeOf(context).width * 0.78, 620.0);

    if (isUser) {
      return Padding(
        padding: const EdgeInsets.only(top: 10),
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
                  padding: const EdgeInsets.fromLTRB(14, 11, 14, 11),
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
                        MdText(
                          msg.text,
                          selectable: true,
                          style: const TextStyle(
                            fontSize: PB.fsBase,
                            height: 1.45,
                            color: Colors.white,
                          ),
                        ),
                    ],
                  ),
                ),
              ),
              if (msg.wasSteer)
                Padding(
                  padding: const EdgeInsets.only(top: 4, right: 4),
                  child: Row(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      const Icon(
                        LucideIcons.zap,
                        size: 11,
                        color: PB.accent,
                      ),
                      const SizedBox(width: 3),
                      Text(
                        msg.meta?['queued'] == 'followUp' ? '已排队' : '已插话引导',
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

    return Padding(
      padding: EdgeInsets.only(top: showAuthor ? 16 : 3),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          SizedBox(
            width: 34,
            child: showAuthor
                ? Padding(
                    padding: const EdgeInsets.only(top: 2),
                    child: BlobAvatar(
                      seed: msg.authorId ?? msg.authorName,
                      color: accent,
                      emoji: msg.authorEmoji ?? bot?.emoji,
                      size: 28,
                      animate: false,
                    ),
                  )
                : null,
          ),
          const SizedBox(width: 8),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                if (showAuthor)
                  Padding(
                    padding: const EdgeInsets.only(bottom: 5),
                    child: Row(
                      children: [
                        Text(
                          msg.authorName,
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
                if (msg.steps.isNotEmpty) _Steps(steps: msg.steps),
                GestureDetector(
                  onLongPress: onLongPress,
                  child: Container(
                    constraints: BoxConstraints(maxWidth: maxBubble),
                    padding: const EdgeInsets.fromLTRB(14, 11, 14, 11),
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
                            urlFor: (id) => AppScope.read(context).fileUrl(id),
                          ),
                        if (streaming &&
                            msg.text.isEmpty &&
                            msg.attachments.isEmpty)
                          const _TypingDots()
                        else if (msg.text.trim().isNotEmpty)
                          MdText(
                            streaming ? '${msg.text}▍' : msg.text,
                            selectable: !streaming,
                            style: const TextStyle(
                              fontSize: PB.fsBase,
                              height: 1.5,
                              color: PB.textPrimary,
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
    );
  }


}

class _Steps extends StatelessWidget {
  const _Steps({required this.steps});

  final List<ToolStep> steps;

  @override
  Widget build(BuildContext context) {
    final running = steps.any((s) => s.status == 'running');
    final shown = steps.length > 5 ? steps.sublist(steps.length - 5) : steps;
    return Padding(
      padding: const EdgeInsets.only(bottom: 7),
      child: Container(
        padding: const EdgeInsets.fromLTRB(10, 8, 11, 8),
        decoration: BoxDecoration(
          color: PB.bgBubble.withValues(alpha: 0.55),
          borderRadius: BorderRadius.circular(PB.rXl),
          border: Border.all(color: PB.borderTertiary),
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Padding(
              padding: const EdgeInsets.only(bottom: 5),
              child: Row(
                mainAxisSize: MainAxisSize.min,
                children: [
                  Icon(
                    running
                        ? LucideIcons.loader
                        : LucideIcons.circleCheck,
                    size: 11,
                    color: running ? PB.accent : PB.textQuaternary,
                  ),
                  const SizedBox(width: 5),
                  Text(
                    running ? '正在调用工具…' : '工具调用 · ${steps.length} 步',
                    style: TextStyle(
                      fontSize: PB.fsXxs,
                      fontWeight: FontWeight.w600,
                      letterSpacing: 0.3,
                      color: running ? PB.accent : PB.textTertiary,
                    ),
                  ),
                  if (steps.length > shown.length) ...[
                    const SizedBox(width: 6),
                    Text(
                      '（只显示最近 ${shown.length} 步）',
                      style: const TextStyle(
                        fontSize: PB.fsXxs,
                        color: PB.textQuaternary,
                      ),
                    ),
                  ],
                ],
              ),
            ),
            for (final step in shown)
              Padding(
                padding: const EdgeInsets.only(bottom: 3),
                child: Row(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    SizedBox(
                      width: 12,
                      height: 12,
                      child: step.status == 'running'
                          ? const CircularProgressIndicator(
                              strokeWidth: 1.6,
                              color: PB.accent,
                            )
                          : Icon(
                              step.status == 'error'
                                  ? LucideIcons.x
                                  : LucideIcons.check,
                              size: 12,
                              color: step.status == 'error'
                                  ? PB.danger
                                  : PB.textQuaternary,
                            ),
                    ),
                    const SizedBox(width: 7),
                    ConstrainedBox(
                      constraints: const BoxConstraints(maxWidth: 280),
                      child: Text(
                        '${step.tool}${step.detail.isNotEmpty ? '  ${shortText(step.detail, 62)}' : ''}'
                        '${step.durationMs != null ? '  ${step.durationMs}ms' : ''}',
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: TextStyle(
                          fontFamily: 'monospace',
                          fontSize: PB.fsXxs,
                          color: step.status == 'running'
                              ? PB.accent
                              : PB.textQuaternary,
                        ),
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
