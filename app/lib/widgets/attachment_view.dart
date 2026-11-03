import 'dart:io';

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';

import '../models.dart';
import '../attachment_preview_request.dart';
import 'attachment_actions.dart';
import 'attachment_preview_router.dart';
import 'attachment_preview_surface.dart';

export 'attachment_actions.dart'
    show downloadAttachment, openAttachmentExternally;
import '../attachment_external_open.dart';
import '../theme.dart';

import 'package:lucide_icons_flutter/lucide_icons.dart';

/// 消息里的附件：**独立成块**（不再塞进聊天气泡里）。
///
/// 设计对齐「改动 N 个文件」那一块：浅底 + 细边 + 圆角，文件一行一行排，
/// 每行等宽对齐（不随文件名长短参差）。图片仍然直接铺缩略图，不套块。
class AttachmentList extends StatelessWidget {
  const AttachmentList({
    super.key,
    required this.items,
    required this.urlFor,
    this.alignEnd = false,
    this.maxWidth = 620,
    this.onLongPress,
  });

  final List<Attachment> items;
  final String? Function(String id) urlFor;

  /// 用户发的消息靠右（缩略图跟着右对齐）
  final bool alignEnd;

  /// 块的最大宽度（跟聊天气泡同宽）
  final double maxWidth;

  /// 附件所属消息的操作入口；普通点击仍由附件预览和按钮处理。
  final VoidCallback? onLongPress;

  @override
  Widget build(BuildContext context) {
    if (items.isEmpty) return const SizedBox.shrink();
    final images = items.where((a) => a.isImage).toList();
    final files = items.where((a) => !a.isImage).toList();

    final body = Column(
      crossAxisAlignment: alignEnd
          ? CrossAxisAlignment.end
          : CrossAxisAlignment.start,
      mainAxisSize: MainAxisSize.min,
      children: [
        if (images.isNotEmpty)
          Padding(
            padding: EdgeInsets.only(bottom: files.isEmpty ? 0 : 8),
            child: Wrap(
              spacing: 6,
              runSpacing: 6,
              alignment: alignEnd ? WrapAlignment.end : WrapAlignment.start,
              children: [
                for (final img in images)
                  _Thumb(url: urlFor(img.id), file: img),
              ],
            ),
          ),
        if (files.isNotEmpty) ...[
          Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              const Icon(
                LucideIcons.paperclip,
                size: 11,
                color: PB.textQuaternary,
              ),
              const SizedBox(width: 5),
              Text(
                '附件 ${files.length} 个文件',
                style: const TextStyle(
                  fontSize: PB.fsXxs,
                  fontWeight: FontWeight.w600,
                  letterSpacing: 0.3,
                  color: PB.textTertiary,
                ),
              ),
            ],
          ),
          const SizedBox(height: 6),
          for (var i = 0; i < files.length; i++)
            Padding(
              padding: EdgeInsets.only(bottom: i == files.length - 1 ? 0 : 4),
              child: FileChip(
                file: files[i],
                url: urlFor(files[i].id),
                fullWidth: true,
              ),
            ),
        ],
      ],
    );

    final content = files.isEmpty
        ? body
        : Container(
            padding: const EdgeInsets.fromLTRB(10, 9, 10, 10),
            decoration: BoxDecoration(
              color: PB.bgBubble.withValues(alpha: 0.55),
              borderRadius: BorderRadius.circular(PB.rXl),
              border: Border.all(color: PB.borderTertiary),
            ),
            child: body,
          );

    return ConstrainedBox(
      constraints: BoxConstraints(maxWidth: maxWidth),
      child: GestureDetector(onLongPress: onLongPress, child: content),
    );
  }
}

class _Thumb extends StatelessWidget {
  const _Thumb({required this.url, required this.file});

  final String? url;
  final Attachment file;
  String get name => file.name;

  @override
  Widget build(BuildContext context) {
    if (url == null) return const SizedBox.shrink();
    return GestureDetector(
      onTap: () => openAttachmentByBestRoute(context, file, url),
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
              return SizedBox(
                width: 140,
                height: 100,
                child: Center(
                  child: CircularProgressIndicator(
                    strokeWidth: 2,
                    color: PB.colors(context).accentBright,
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
class FileChip extends StatefulWidget {
  const FileChip({
    super.key,
    required this.file,
    required this.url,
    this.fullWidth = false,
  });

  final Attachment file;
  final String? url;

  /// true = 在附件块里占满一行（等宽对齐，不随文件名长短参差）
  final bool fullWidth;

  /// 由原文件或服务端转换页面直接交给网络 WebView 的格式。
  /// 其他格式也可进入右侧阅读栏，由对应的内容组件呈现。
  static bool canShowInPane(String name) {
    final lower = name.toLowerCase();
    return const [
      '.xlsx',
      '.xls',
      '.xlsm',
      '.ods',
      '.csv',
      '.tsv',
      '.pdf',
      '.docx',
    ].any(lower.endsWith);
  }

  static IconData iconFor(String name) {
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
  State<FileChip> createState() => _FileChipState();
}

class _FileChipState extends State<FileChip> {
  late AttachmentOpenController _opener;

  @override
  void initState() {
    super.initState();
    _createOpener();
  }

  void _createOpener() {
    _opener = AttachmentOpenController(
      operation: () =>
          openAttachmentFile(name: widget.file.name, url: widget.url!),
    )..addListener(_updateOpenStatus);
  }

  void _updateOpenStatus() {
    if (mounted) setState(() {});
  }

  @override
  void didUpdateWidget(FileChip oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.file.id == widget.file.id &&
        oldWidget.file.name == widget.file.name &&
        oldWidget.url == widget.url)
      return;
    _opener.removeListener(_updateOpenStatus);
    _opener.dispose();
    _createOpener();
  }

  @override
  void dispose() {
    _opener.removeListener(_updateOpenStatus);
    _opener.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final file = widget.file;
    final url = widget.url;
    final fullWidth = widget.fullWidth;
    const fg = PB.textPrimary;
    const dim = PB.textQuaternary;

    final nameCol = Column(
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
        if (_opener.message case final message?)
          Padding(
            padding: const EdgeInsets.only(top: 3),
            child: Text(
              message,
              maxLines: 2,
              overflow: TextOverflow.ellipsis,
              style: TextStyle(
                fontSize: PB.fsXxs,
                color: _opener.phase == AttachmentOpenPhase.failed
                    ? PB.danger
                    : PB.textSecondary,
              ),
            ),
          ),
      ],
    );

    final openArea = InkWell(
      onTap: url == null
          ? null
          : () => openAttachmentByBestRoute(context, file, url),
      borderRadius: BorderRadius.circular(PB.rXl),
      child: Padding(
        padding: const EdgeInsets.fromLTRB(10, 8, 6, 8),
        child: Row(
          mainAxisSize: fullWidth ? MainAxisSize.max : MainAxisSize.min,
          children: [
            Icon(
              FileChip.iconFor(file.name),
              size: 18,
              color: PB.textSecondary,
            ),
            const SizedBox(width: 8),
            if (fullWidth)
              Expanded(child: nameCol)
            else
              ConstrainedBox(
                constraints: const BoxConstraints(maxWidth: 200),
                child: nameCol,
              ),
          ],
        ),
      ),
    );

    return Container(
      width: fullWidth ? double.infinity : null,
      decoration: BoxDecoration(
        color: PB.bgActive,
        borderRadius: BorderRadius.circular(PB.rXl),
        border: Border.all(color: PB.borderTertiary),
      ),
      child: Row(
        mainAxisSize: fullWidth ? MainAxisSize.max : MainAxisSize.min,
        children: [
          if (fullWidth)
            Expanded(child: openArea)
          else
            Flexible(child: openArea),
          // 文件名与预览按钮采用相同的空间判定和呈现方式。
          if (!kIsWeb && FileChip.canShowInPane(file.name) && url != null)
            _IconAction(
              icon: LucideIcons.panelRight,
              tip: '预览文件',
              color: dim,
              onTap: () => openAttachmentByBestRoute(context, file, url),
            ),
          // 「用系统程序打开」：只在桌面端出现 —— 手机上交给系统的分享/打开
          // 机制是另一件事，先不给（给了也点不了）。价值在于：**看原样**，
          // 而不是这里抽出来的文字（PDF 的版式、xlsx 的公式都在原文件里）。
          if (!kIsWeb &&
              (Platform.isWindows || Platform.isMacOS || Platform.isLinux))
            _IconAction(
              icon: LucideIcons.squareArrowOutUpRight,
              tip: '用系统程序打开',
              color: dim,
              busy: _opener.opening,
              onTap: url == null || _opener.opening
                  ? null
                  : () => _opener.open(),
            ),
          // 下载按钮就放在卡片上 —— 不用点进去再找
          _IconAction(
            icon: LucideIcons.download,
            tip: '下载',
            color: dim,
            onTap: url == null
                ? null
                : () => downloadAttachment(context, file: file, url: url),
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
    this.busy = false,
  });

  final IconData icon;
  final String tip;
  final Color color;
  final VoidCallback? onTap;
  static const double size = 16;
  final bool busy;

  @override
  Widget build(BuildContext context) {
    return Tooltip(
      message: busy ? '正在打开…' : tip,
      waitDuration: const Duration(milliseconds: 500),
      child: InkWell(
        onTap: onTap,
        borderRadius: BorderRadius.circular(PB.rFull),
        child: Padding(
          padding: const EdgeInsets.all(6),
          child: busy
              ? SizedBox(
                  width: size,
                  height: size,
                  child: const CircularProgressIndicator(strokeWidth: 2),
                )
              : Icon(icon, size: size, color: color),
        ),
      ),
    );
  }
}

/// 文件卡片与按钮共用预览路由，由实际布局决定侧栏或二级页面。
void openAttachmentByBestRoute(
  BuildContext context,
  Attachment file,
  String? url,
) {
  if (url == null) return;
  openAttachmentPreview(context, file, url);
}

/// 在独立二级页面中预览文件，关闭后回到原聊天布局。
Future<void> showFilePreview(
  BuildContext context, {
  required Attachment file,
  required String? url,
}) {
  if (url == null) return Future<void>.value();
  return showAttachmentSecondary(
    context,
    AttachmentPreviewRequest(file: file, sourceUrl: url),
  );
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
