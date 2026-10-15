import 'package:flutter/material.dart';
import 'package:url_launcher/url_launcher.dart';

import '../models.dart';
import '../theme.dart';

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
                      Icons.broken_image_outlined,
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
    if (lower.endsWith('.pdf')) return Icons.picture_as_pdf_outlined;
    if (lower.endsWith('.xlsx') ||
        lower.endsWith('.xls') ||
        lower.endsWith('.csv')) {
      return Icons.table_chart_outlined;
    }
    if (lower.endsWith('.docx') || lower.endsWith('.doc'))
      return Icons.description_outlined;
    if (lower.endsWith('.zip') || lower.endsWith('.rar'))
      return Icons.folder_zip_outlined;
    return Icons.insert_drive_file_outlined;
  }

  @override
  Widget build(BuildContext context) {
    return InkWell(
      onTap: url == null
          ? null
          : () => launchUrl(
              Uri.parse(url!),
              mode: LaunchMode.externalApplication,
            ),
      borderRadius: BorderRadius.circular(PB.rXl),
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 8),
        decoration: BoxDecoration(
          color: isUser ? Colors.black.withValues(alpha: 0.18) : PB.bgActive,
          borderRadius: BorderRadius.circular(PB.rXl),
          border: Border.all(color: PB.borderTertiary),
        ),
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
                    style: TextStyle(
                      fontSize: PB.fsXs,
                      color: isUser ? Colors.white : PB.textPrimary,
                    ),
                  ),
                  if (file.sizeText.isNotEmpty)
                    Text(
                      file.sizeText,
                      style: TextStyle(
                        fontSize: PB.fsXxs,
                        color: isUser ? Colors.white70 : PB.textQuaternary,
                      ),
                    ),
                ],
              ),
            ),
            const SizedBox(width: 6),
            Icon(
              Icons.open_in_new,
              size: 13,
              color: isUser ? Colors.white70 : PB.textQuaternary,
            ),
          ],
        ),
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
                  icon: const Icon(Icons.close, color: Colors.white70),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}
