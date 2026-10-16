const fs = require('fs');
const p = 'lib/screens/chat_screen.dart';
let s = fs.readFileSync(p, 'utf8');

// ---- imports
s = s.replace(
  "import '../widgets/blob_avatar.dart';",
  "import '../widgets/attachment_view.dart';\nimport '../widgets/blob_avatar.dart';",
);
s = s.replace(
  "import 'package:flutter/services.dart';",
  "import 'package:flutter/services.dart';\nimport 'package:file_picker/file_picker.dart';\nimport 'package:image_picker/image_picker.dart';",
);

// ---- widget: 加 embedded 参数
s = s.replace(
  `class ChatScreen extends StatefulWidget {
  const ChatScreen({super.key, required this.room, this.initialText});

  final Room room;
  final String? initialText;`,
  `class ChatScreen extends StatefulWidget {
  const ChatScreen({super.key, required this.room, this.initialText, this.embedded = false});

  final Room room;
  final String? initialText;

  /// 宽屏分栏里嵌在右边时，不显示返回键
  final bool embedded;`,
);

// ---- AppBar 返回键
s = s.replace(
  `      appBar: AppBar(
        backgroundColor: PB.bgPane,
        toolbarHeight: 60,
        titleSpacing: 0,`,
  `      appBar: AppBar(
        backgroundColor: PB.bgPane,
        toolbarHeight: 60,
        automaticallyImplyLeading: !widget.embedded,
        titleSpacing: widget.embedded ? 14 : 0,`,
);

// ---- state: 待发送附件
s = s.replace(
  `  AppState? _state;
  bool _stick = true;
  String? _shownError;`,
  `  AppState? _state;
  bool _stick = true;
  String? _shownError;
  final List<Attachment> _pending = [];
  bool _uploading = false;`,
);

// ---- 选图 / 选文件 / 上传
s = s.replace(
  `  Future<void> _send() async {
    final text = _input.text;
    if (text.trim().isEmpty) return;
    _input.clear();
    _stick = true;
    final state = AppScope.read(context);
    try {
      await state.sendMessage(widget.room.id, text);
    } catch (err) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('\$err')));
        _input.text = text;
      }
    } finally {
      // 发完继续留着焦点，方便接着敲
      if (mounted) _focus.requestFocus();
    }
  }`,
  `  Future<void> _send() async {
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
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('\$err')));
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
      _toast('选图失败：\$err');
    }
  }

  Future<void> _pickFiles() async {
    try {
      final result = await FilePicker.platform.pickFiles(withData: true, allowMultiple: true);
      if (result == null || result.files.isEmpty) return;
      final items = <(String, Future<List<int>> Function())>[];
      for (final f in result.files) {
        if (f.bytes == null) continue;
        final bytes = f.bytes!;
        items.add((f.name, () async => bytes));
      }
      await _uploadAll(items);
    } catch (err) {
      _toast('选文件失败：\$err');
    }
  }

  Future<void> _uploadAll(List<(String, Future<List<int>> Function())> items) async {
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
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(message)));
  }`,
);

// ---- 附件按钮的入口函数传给 composer
s = s.replace(
  `          _Composer(
            controller: _input,
            focus: _focus,
            busy: busy,
            queuedCount: state.queued[room.id] ?? 0,
            onSend: _send,
            onStop: () => state.abort(room.id),
          ),`,
  `          _Composer(
            controller: _input,
            focus: _focus,
            busy: busy,
            queuedCount: state.queued[room.id] ?? 0,
            pending: _pending,
            uploading: _uploading,
            onPickImages: _pickImages,
            onPickFiles: _pickFiles,
            onRemovePending: (att) => setState(() => _pending.removeWhere((a) => a.id == att.id)),
            onSend: _send,
            onStop: () => state.abort(room.id),
          ),`,
);

// ---- composer 参数
s = s.replace(
  `  const _Composer({
    required this.controller,
    required this.focus,
    required this.busy,
    required this.queuedCount,
    required this.onSend,
    required this.onStop,
  });

  final TextEditingController controller;
  final FocusNode focus;
  final bool busy;
  final int queuedCount;
  final VoidCallback onSend;
  final VoidCallback onStop;`,
  `  const _Composer({
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
  final VoidCallback onStop;`,
);

// ---- composer build：待发附件 + 附件按钮
s = s.replace(
  `    final onStop = widget.onStop;
    final hasText = _hasText;`,
  `    final onStop = widget.onStop;
    final pending = widget.pending;
    final hasText = _hasText || pending.isNotEmpty;`,
);

s = s.replace(
  `          Padding(
            padding: const EdgeInsets.fromLTRB(12, 0, 12, 8),
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.end,
              children: [
                Expanded(`,
  `          if (pending.isNotEmpty || widget.uploading)
            Padding(
              padding: const EdgeInsets.fromLTRB(12, 0, 12, 6),
              child: SizedBox(
                height: 56,
                child: ListView(
                  scrollDirection: Axis.horizontal,
                  children: [
                    if (widget.uploading)
                      const Padding(
                        padding: EdgeInsets.symmetric(horizontal: 8, vertical: 10),
                        child: SizedBox(
                          width: 36,
                          height: 36,
                          child: Center(child: CircularProgressIndicator(strokeWidth: 2, color: PB.accent)),
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
                                      AppScope.read(context).fileUrl(att.id) ?? '',
                                      fit: BoxFit.cover,
                                      errorBuilder: (c, e, s) => const Icon(
                                        Icons.image_outlined,
                                        size: 18,
                                        color: PB.textQuaternary,
                                      ),
                                    )
                                  : const Icon(Icons.description_outlined, size: 18, color: PB.textSecondary),
                            ),
                            Positioned(
                              right: -6,
                              top: -6,
                              child: GestureDetector(
                                onTap: () => widget.onRemovePending(att),
                                child: Container(
                                  padding: const EdgeInsets.all(2),
                                  decoration: const BoxDecoration(color: PB.bgActive, shape: BoxShape.circle),
                                  child: const Icon(Icons.close, size: 12, color: PB.textSecondary),
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
                  icon: Icons.add,
                  color: PB.bgActive,
                  iconColor: PB.textSecondary,
                  tooltip: '加附件',
                  onTap: () => _showAttachSheet(context),
                ),
                const SizedBox(width: 8),
                Expanded(`,
);

// ---- 附件类型选择面板 + _RoundButton 保持不变
s = s.replace(
  `class _RoundButton extends StatelessWidget {`,
  `Future<void> _showAttachSheet(BuildContext context) async {
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
              decoration: BoxDecoration(color: PB.borderPrimary, borderRadius: BorderRadius.circular(2)),
            ),
            ListTile(
              leading: const Icon(Icons.image_outlined, size: 20),
              title: const Text('照片', style: TextStyle(fontSize: PB.fsSm)),
              subtitle: const Text('支持多选', style: TextStyle(fontSize: PB.fsXxs, color: PB.textQuaternary)),
              onTap: () {
                Navigator.pop(ctx);
                widget.onPickImages();
              },
            ),
            ListTile(
              leading: const Icon(Icons.upload_file_outlined, size: 20),
              title: const Text('文件', style: TextStyle(fontSize: PB.fsSm)),
              subtitle: const Text(
                'PDF / Excel / Word / CSV / MD / HTML …会解析出正文给 bot',
                style: TextStyle(fontSize: PB.fsXxs, color: PB.textQuaternary),
              ),
              onTap: () {
                Navigator.pop(ctx);
                widget.onPickFiles();
              },
            ),
            const SizedBox(height: 8),
          ],
        ),
      ),
    );
  }

class _RoundButton extends StatelessWidget {`,
);

// ---- 消息气泡里渲染附件
s = s.replace(
  `              child: MdText(
                msg.text,
                selectable: true,
                style: const TextStyle(fontSize: PB.fsBase, height: 1.45, color: Colors.white),
              ),`,
  `              child: Column(
                crossAxisAlignment: CrossAxisAlignment.end,
                children: [
                  AttachmentList(
                    items: msg.attachments,
                    urlFor: (id) => AppScope.read(context).fileUrl(id),
                    isUser: true,
                  ),
                  if (msg.text.trim().isNotEmpty)
                    MdText(
                      msg.text,
                      selectable: true,
                      style: const TextStyle(fontSize: PB.fsBase, height: 1.45, color: Colors.white),
                    ),
                ],
              ),`,
);

s = s.replace(
  `                    child: streaming && msg.text.isEmpty
                        ? const _TypingDots()
                        : MdText(
                            streaming ? '\${msg.text}▍' : msg.text,
                            selectable: !streaming,
                            style: const TextStyle(fontSize: PB.fsBase, height: 1.5, color: PB.textPrimary),
                          ),`,
  `                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        if (msg.attachments.isNotEmpty)
                          AttachmentList(
                            items: msg.attachments,
                            urlFor: (id) => AppScope.read(context).fileUrl(id),
                          ),
                        if (streaming && msg.text.isEmpty && msg.attachments.isEmpty)
                          const _TypingDots()
                        else if (msg.text.trim().isNotEmpty)
                          MdText(
                            streaming ? '\${msg.text}▍' : msg.text,
                            selectable: !streaming,
                            style: const TextStyle(fontSize: PB.fsBase, height: 1.5, color: PB.textPrimary),
                          ),
                      ],
                    ),`,
);

fs.writeFileSync(p, s);
console.log('chat_screen 补丁完成');
