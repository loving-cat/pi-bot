import 'dart:io';
import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:http/http.dart' as http;
import 'package:url_launcher/url_launcher.dart';

import '../models.dart';
import '../open_file.dart';
import '../save_file.dart';
import '../theme.dart';
import 'md_text.dart';

import 'package:lucide_icons_flutter/lucide_icons.dart';

/// 消息里的附件：图片直接画出来，其它显示成文件卡片。
class AttachmentList extends StatelessWidget {
  const AttachmentList({
    super.key,
    required this.items,
    required this.urlFor,
    this.isUser = false,
  });

  final List<Attachment> items;
  final String? Function(String id) urlFor;
  final bool isUser;

  @override
  Widget build(BuildContext context) {
    if (items.isEmpty) return const SizedBox.shrink();
    final images = items.where((a) => a.isImage).toList();
    final files = items.where((a) => !a.isImage).toList();

    return Column(
      crossAxisAlignment: isUser
          ? CrossAxisAlignment.end
          : CrossAxisAlignment.start,
      children: [
        if (images.isNotEmpty)
          Padding(
            padding: const EdgeInsets.only(bottom: 6),
            child: Wrap(
              spacing: 6,
              runSpacing: 6,
              children: [
                for (final img in images)
                  _Thumb(url: urlFor(img.id), name: img.name),
              ],
            ),
          ),
        for (final file in files)
          Padding(
            padding: const EdgeInsets.only(bottom: 4),
            child: _FileChip(file: file, url: urlFor(file.id), isUser: isUser),
          ),
      ],
    );
  }
}

class _Thumb extends StatelessWidget {
  const _Thumb({required this.url, required this.name});

  final String? url;
  final String name;

  @override
  Widget build(BuildContext context) {
    if (url == null) return const SizedBox.shrink();
    return GestureDetector(
      onTap: () => showImageViewer(context, url!, name),
      child: ClipRRect(
        borderRadius: BorderRadius.circular(12),
        child: Container(
          constraints: const BoxConstraints(maxWidth: 240, maxHeight: 240),
          color: PB.bgActive,
          child: Image.network(
            url!,
            fit: BoxFit.cover,
            loadingBuilder: (ctx, child, progress) {
              if (progress == null) return child;
              return const SizedBox(
                width: 140,
                height: 100,
                child: Center(
                  child: CircularProgressIndicator(
                    strokeWidth: 2,
                    color: PB.accent,
                  ),
                ),
              );
            },
            errorBuilder: (ctx, err, stack) => SizedBox(
              width: 180,
              height: 80,
              child: Center(
                child: Column(
                  mainAxisAlignment: MainAxisAlignment.center,
                  children: [
                    const Icon(
                      LucideIcons.imageOff,
                      size: 18,
                      color: PB.textQuaternary,
                    ),
                    const SizedBox(height: 4),
                    Text(
                      name,
                      style: const TextStyle(
                        fontSize: PB.fsXxs,
                        color: PB.textQuaternary,
                      ),
                    ),
                  ],
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}

/// 文件卡片。
///
/// 两件事要分开：
///   · **点卡片本体** = 站内预览（不再一上来就丢给系统外部应用 —— 那等于把你踢出 App）
///   · **右边的下载按钮** = 直接存下来（不用点进去再找）
class _FileChip extends StatelessWidget {
  const _FileChip({
    required this.file,
    required this.url,
    required this.isUser,
  });

  final Attachment file;
  final String? url;
  final bool isUser;

  static IconData _iconFor(String name) {
    final lower = name.toLowerCase();
    if (lower.endsWith('.pdf')) return LucideIcons.fileText;
    if (lower.endsWith('.xlsx') ||
        lower.endsWith('.xls') ||
        lower.endsWith('.csv')) {
      return LucideIcons.table;
    }
    if (lower.endsWith('.docx') || lower.endsWith('.doc'))
      return LucideIcons.fileText;
    if (lower.endsWith('.zip') || lower.endsWith('.rar'))
      return LucideIcons.fileArchive;
    return LucideIcons.file;
  }

  @override
  Widget build(BuildContext context) {
    final fg = isUser ? Colors.white : PB.textPrimary;
    final dim = isUser ? Colors.white70 : PB.textQuaternary;

    return Container(
      decoration: BoxDecoration(
        color: isUser ? Colors.black.withValues(alpha: 0.18) : PB.bgActive,
        borderRadius: BorderRadius.circular(PB.rXl),
        border: Border.all(color: PB.borderTertiary),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          InkWell(
            onTap: url == null
                ? null
                : () => showFilePreview(context, file: file, url: url),
            borderRadius: BorderRadius.circular(PB.rXl),
            child: Padding(
              padding: const EdgeInsets.fromLTRB(10, 8, 6, 8),
              child: Row(
                mainAxisSize: MainAxisSize.min,
                children: [
                  Icon(
                    _iconFor(file.name),
                    size: 18,
                    color: isUser ? Colors.white : PB.textSecondary,
                  ),
                  const SizedBox(width: 8),
                  ConstrainedBox(
                    constraints: const BoxConstraints(maxWidth: 200),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        Text(
                          file.name,
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: TextStyle(fontSize: PB.fsXs, color: fg),
                        ),
                        if (file.sizeText.isNotEmpty)
                          Text(
                            file.sizeText,
                            style: TextStyle(fontSize: PB.fsXxs, color: dim),
                          ),
                      ],
                    ),
                  ),
                ],
              ),
            ),
          ),
          // 「用系统程序打开」：只在桌面端出现 —— 手机上交给系统的分享/打开
          // 机制是另一件事，先不给（给了也点不了）。价值在于：**看原样**，
          // 而不是我们抽出来的文字（PDF 的版式、xlsx 的公式都在原文件里）。
          if (!kIsWeb && (Platform.isWindows || Platform.isMacOS || Platform.isLinux))
            _IconAction(
              icon: LucideIcons.squareArrowOutUpRight,
              tip: '用系统程序打开',
              color: dim,
              onTap: url == null
                  ? null
                  : () => openAttachmentExternally(context, file: file, url: url!),
            ),
          // 下载按钮就放在卡片上 —— 不用点进去再找
          _IconAction(
            icon: LucideIcons.download,
            tip: '下载',
            color: dim,
            onTap: url == null
                ? null
                : () => downloadAttachment(context, file: file, url: url!),
          ),
          const SizedBox(width: 4),
        ],
      ),
    );
  }
}

/// 卡片/弹窗里通用的小图标按钮（带 hover 反馈和 tip）
class _IconAction extends StatelessWidget {
  const _IconAction({
    required this.icon,
    required this.tip,
    required this.color,
    required this.onTap,
    this.size = 16,
  });

  final IconData icon;
  final String tip;
  final Color color;
  final VoidCallback? onTap;
  final double size;

  @override
  Widget build(BuildContext context) {
    return Tooltip(
      message: tip,
      waitDuration: const Duration(milliseconds: 500),
      child: InkWell(
        onTap: onTap,
        borderRadius: BorderRadius.circular(PB.rFull),
        child: Padding(
          padding: const EdgeInsets.all(6),
          child: Icon(icon, size: size, color: color),
        ),
      ),
    );
  }
}

/// 下载一个附件到用户选的位置。
///
/// 和"用系统应用打开"是两件事：那个是拿别的程序看，这个是存下来。
/// 用系统默认程序打开附件（桌面端）。
///
/// 和"下载"分开：下载是**存到用户选的位置**（留着），打开是**落到临时文件**
/// 交给系统（看完就算）——两件事，别混。
Future<void> openAttachmentExternally(
  BuildContext context, {
  required Attachment file,
  required String url,
}) async {
  final messenger = ScaffoldMessenger.maybeOf(context);
  void say(String text) =>
      messenger?.showSnackBar(SnackBar(duration: const Duration(seconds: 2), content: Text(text)));

  say('正在打开 ${file.name}…');
  try {
    final res = await http.get(Uri.parse(url)).timeout(const Duration(seconds: 120));
    if (res.statusCode >= 400) throw Exception('HTTP ${res.statusCode}');
    final err = await openWithSystemApp(
      name: file.name,
      bytes: res.bodyBytes,
      tempDir: attachmentTempDir(),
    );
    if (err != null) say(err);
  } catch (err) {
    say('打开失败：$err');
  }
}

Future<void> downloadAttachment(
  BuildContext context, {
  required Attachment file,
  required String url,
}) async {
  // 先把 messenger 抓在手里：await 之后 context 可能已经失效
  final messenger = ScaffoldMessenger.maybeOf(context);
  void say(String text) =>
      messenger?.showSnackBar(SnackBar(content: Text(text)));

  say('正在下载 ${file.name}…');
  try {
    final res = await http
        .get(Uri.parse(url))
        .timeout(const Duration(seconds: 120));
    if (res.statusCode >= 400) throw Exception('HTTP ${res.statusCode}');
    final path = await saveAttachment(name: file.name, bytes: res.bodyBytes);
    if (path == null) return; // 用户取消，不用吭声
    say('已保存到 $path');
  } catch (err) {
    say('下载失败：$err');
  }
}

/// 站内预览：点文件卡弹出来的那个悬浮窗。
///
/// 能就地画出来的（文本、图片）直接画；画不出来的（pdf/xlsx/zip）**老实说画不了**，
/// 但下载和"用系统应用打开"两个出口一定在 —— 标题栏 X 左边一个，
/// 空状态里再给一个，不让用户找不到下一步。
Future<void> showFilePreview(
  BuildContext context, {
  required Attachment file,
  required String? url,
}) async {
  if (url == null) return;
  await Navigator.of(context).push(
    PageRouteBuilder(
      opaque: false,
      barrierColor: Colors.black.withValues(alpha: 0.6),
      pageBuilder: (ctx, _, __) => _FilePreview(file: file, url: url),
      transitionsBuilder: (ctx, anim, _, child) => FadeTransition(
        opacity: anim,
        child: Transform.scale(scale: 0.97 + 0.03 * anim.value, child: child),
      ),
    ),
  );
}

class _FilePreview extends StatefulWidget {
  const _FilePreview({required this.file, required this.url});

  final Attachment file;
  final String url;

  @override
  State<_FilePreview> createState() => _FilePreviewState();
}

class _FilePreviewState extends State<_FilePreview> {
  /// null = 还在读
  Object? _error;
  String? _text;
  bool _loading = true;

  bool get _isImage => widget.file.isImage;

  bool get _looksTextual {
    final n = widget.file.name.toLowerCase();
    const exts = [
      '.md',
      '.markdown',
      '.txt',
      '.json',
      '.csv',
      '.tsv',
      '.log',
      '.yml',
      '.yaml',
      '.xml',
      '.html',
      '.css',
      '.js',
      '.ts',
      '.dart',
      '.py',
      '.sh',
      '.toml',
      '.ini',
    ];
    return exts.any(n.endsWith);
  }

  bool get _isMarkdown {
    final n = widget.file.name.toLowerCase();
    return n.endsWith('.md') || n.endsWith('.markdown');
  }

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    // 图片走 Image.network，不用在这儿读字节
    if (_isImage || !_looksTextual) {
      setState(() => _loading = false);
      return;
    }
    try {
      final bytes = await http
          .get(Uri.parse(widget.url))
          .timeout(const Duration(seconds: 30))
          .then((r) {
            if (r.statusCode >= 400) throw Exception('HTTP ${r.statusCode}');
            return r.bodyBytes;
          });
      if (!mounted) return;
      setState(() {
        // 预览上限 512KB：再大就不是"看一眼"了，该下载
        final capped = bytes.length > 512 * 1024;
        _text = utf8.decode(
          capped ? bytes.sublist(0, 512 * 1024) : bytes,
          allowMalformed: true,
        );
        if (capped) _text = '$_text\n\n…（内容太长，只显示了前 512KB，要看全部请下载）';
        _loading = false;
      });
    } catch (err) {
      if (!mounted) return;
      setState(() {
        _error = err;
        _loading = false;
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    final screen = MediaQuery.sizeOf(context);
    final w = (screen.width * 0.78).clamp(320.0, 900.0);
    final h = (screen.height * 0.82).clamp(300.0, 820.0);

    return Center(
      child: Material(
        // ★ Overlay/路由里没有 Material 祖先时，Flutter 会给文字画黄色双下划线
        type: MaterialType.transparency,
        child: Container(
          width: w,
          height: h,
          decoration: BoxDecoration(
            color: PB.bgPane,
            borderRadius: BorderRadius.circular(PB.r2xl),
            border: Border.all(color: PB.borderSecondary),
            boxShadow: PB.shadow(y: 12, blur: 40, alpha: 0.5),
          ),
          clipBehavior: Clip.antiAlias,
          child: Column(
            children: [
              _titleBar(context),
              Container(height: 1, color: PB.borderTertiary),
              Expanded(child: _body()),
            ],
          ),
        ),
      ),
    );
  }

  Widget _titleBar(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(14, 8, 8, 8),
      child: Row(
        children: [
          Icon(
            _FileChip._iconFor(widget.file.name),
            size: 15,
            color: PB.textSecondary,
          ),
          const SizedBox(width: 8),
          Expanded(
            child: Text(
              widget.file.name,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: const TextStyle(
                fontSize: PB.fsSm,
                fontWeight: FontWeight.w600,
                color: PB.textPrimary,
              ),
            ),
          ),
          // 下载在 X 左边 —— 用户要的就是这个位置
          _IconAction(
            icon: LucideIcons.download,
            tip: '下载',
            color: PB.textSecondary,
            size: 17,
            onTap: () =>
                downloadAttachment(context, file: widget.file, url: widget.url),
          ),
          _IconAction(
            icon: LucideIcons.externalLink,
            tip: '用系统应用打开',
            color: PB.textSecondary,
            size: 17,
            onTap: () => launchUrl(
              Uri.parse(widget.url),
              mode: LaunchMode.externalApplication,
            ),
          ),
          _IconAction(
            icon: LucideIcons.x,
            tip: '关闭',
            color: PB.textSecondary,
            size: 17,
            onTap: () => Navigator.of(context).pop(),
          ),
        ],
      ),
    );
  }

  Widget _body() {
    if (_loading) {
      return const Center(
        child: SizedBox(
          width: 22,
          height: 22,
          child: CircularProgressIndicator(strokeWidth: 2),
        ),
      );
    }

    if (_isImage) {
      return Padding(
        padding: const EdgeInsets.all(14),
        child: InteractiveViewer(
          child: Image.network(widget.url, fit: BoxFit.contain),
        ),
      );
    }

    if (_error != null) {
      return _cantPreview('读不出来：$_error');
    }

    if (_text != null) {
      return SingleChildScrollView(
        padding: const EdgeInsets.fromLTRB(20, 16, 20, 24),
        child: _isMarkdown
            ? MdText(
                _text!,
                selectable: true,
                style: const TextStyle(
                  fontSize: PB.fsSm,
                  height: 1.6,
                  color: PB.textPrimary,
                ),
              )
            : SelectableText(
                _text!,
                style: const TextStyle(
                  fontSize: PB.fsXs,
                  height: 1.5,
                  fontFamily: PB.monoFamily,
                  fontFamilyFallback: PB.monoFallback,
                  color: PB.textSecondary,
                ),
              ),
      );
    }

    // 画不出来的（pdf / xlsx / zip / 图片以外的二进制）：
    // 明说画不了，然后把两个出口摆出来
    return _cantPreview('这类文件没法在窗口里画出来（${widget.file.sizeText}）');
  }

  Widget _cantPreview(String reason) {
    return Center(
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(
            _FileChip._iconFor(widget.file.name),
            size: 40,
            color: PB.textQuaternary,
          ),
          const SizedBox(height: 14),
          Text(
            widget.file.name,
            style: const TextStyle(fontSize: PB.fsBase, color: PB.textPrimary),
          ),
          const SizedBox(height: 6),
          Text(
            reason,
            textAlign: TextAlign.center,
            style: const TextStyle(fontSize: PB.fsXs, color: PB.textQuaternary),
          ),
          const SizedBox(height: 18),
          Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              FilledButton.icon(
                onPressed: () => downloadAttachment(
                  context,
                  file: widget.file,
                  url: widget.url,
                ),
                icon: const Icon(LucideIcons.download, size: 16),
                label: const Text('下载'),
              ),
              const SizedBox(width: 10),
              TextButton.icon(
                onPressed: () => launchUrl(
                  Uri.parse(widget.url),
                  mode: LaunchMode.externalApplication,
                ),
                icon: const Icon(LucideIcons.externalLink, size: 16),
                label: const Text('用系统应用打开'),
              ),
            ],
          ),
        ],
      ),
    );
  }
}

/// 全屏看图（可双指缩放）
Future<void> showImageViewer(
  BuildContext context,
  String url,
  String name,
) async {
  await Navigator.of(context).push(
    PageRouteBuilder(
      opaque: false,
      barrierColor: Colors.black.withValues(alpha: 0.92),
      pageBuilder: (ctx, _, __) => _ImageViewer(url: url, name: name),
      transitionsBuilder: (ctx, anim, _, child) =>
          FadeTransition(opacity: anim, child: child),
    ),
  );
}

class _ImageViewer extends StatelessWidget {
  const _ImageViewer({required this.url, required this.name});

  final String url;
  final String name;

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: Colors.transparent,
      body: Stack(
        children: [
          Positioned.fill(
            child: GestureDetector(
              onTap: () => Navigator.pop(context),
              child: InteractiveViewer(
                minScale: 0.6,
                maxScale: 5,
                child: Center(
                  child: Image.network(
                    url,
                    fit: BoxFit.contain,
                    errorBuilder: (ctx, err, stack) => const Text(
                      '图片加载失败',
                      style: TextStyle(color: Colors.white70),
                    ),
                  ),
                ),
              ),
            ),
          ),
          Positioned(
            top: 40,
            left: 16,
            right: 16,
            child: Row(
              children: [
                Expanded(
                  child: Text(
                    name,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: const TextStyle(
                      color: Colors.white70,
                      fontSize: PB.fsSm,
                    ),
                  ),
                ),
                IconButton(
                  onPressed: () => Navigator.pop(context),
                  icon: const Icon(LucideIcons.x, color: Colors.white70),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}
