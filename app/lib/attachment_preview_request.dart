import 'html_preview_loader.dart';
import 'models.dart';

enum AttachmentPreviewKind {
  pdf,
  document,
  html,
  markdown,
  text,
  image,
  unsupported,
}

/// 附件阅读请求；原始地址用于下载，展示地址按文件种类派生。
class AttachmentPreviewRequest {
  const AttachmentPreviewRequest({required this.file, required this.sourceUrl});

  final Attachment file;
  final String sourceUrl;

  AttachmentPreviewKind get kind {
    final name = file.name.toLowerCase();
    final mime = file.mime.split(';').first.trim().toLowerCase();
    if (isHtmlAttachment(file.name, file.mime))
      return AttachmentPreviewKind.html;
    if (name.endsWith('.pdf') || mime == 'application/pdf') {
      return AttachmentPreviewKind.pdf;
    }
    if (const [
      '.xlsx',
      '.xls',
      '.xlsm',
      '.ods',
      '.csv',
      '.tsv',
      '.docx',
    ].any(name.endsWith))
      return AttachmentPreviewKind.document;
    if (file.isImage ||
        mime.startsWith('image/') ||
        const [
          '.png',
          '.jpg',
          '.jpeg',
          '.gif',
          '.webp',
          '.bmp',
        ].any(name.endsWith)) {
      return AttachmentPreviewKind.image;
    }
    if (name.endsWith('.md') ||
        name.endsWith('.markdown') ||
        mime == 'text/markdown') {
      return AttachmentPreviewKind.markdown;
    }
    if (mime.startsWith('text/') ||
        const [
          '.txt',
          '.json',
          '.log',
          '.yml',
          '.yaml',
          '.xml',
          '.css',
          '.js',
          '.ts',
          '.dart',
          '.py',
          '.sh',
          '.toml',
          '.ini',
        ].any(name.endsWith))
      return AttachmentPreviewKind.text;
    return AttachmentPreviewKind.unsupported;
  }

  bool get usesWebView =>
      kind == AttachmentPreviewKind.pdf ||
      kind == AttachmentPreviewKind.document;

  String get viewUrl {
    if (kind != AttachmentPreviewKind.document) return sourceUrl;
    final uri = Uri.tryParse(sourceUrl);
    return uri == null
        ? sourceUrl
        : uri.replace(path: '${uri.path}/html').toString();
  }

  @override
  bool operator ==(Object other) =>
      other is AttachmentPreviewRequest &&
      sourceUrl == other.sourceUrl &&
      file.id == other.file.id &&
      file.name == other.file.name &&
      file.mime == other.file.mime &&
      file.kind == other.file.kind &&
      file.size == other.file.size;

  @override
  int get hashCode => Object.hash(
    sourceUrl,
    file.id,
    file.name,
    file.mime,
    file.kind,
    file.size,
  );
}
