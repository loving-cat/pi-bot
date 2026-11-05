import 'package:flutter/material.dart';
import 'package:http/http.dart' as http;
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../attachment_external_open.dart';
import '../l10n/l10n.dart';
import '../attachment_preview_request.dart';
import '../models.dart';
import '../save_file.dart';
import '../theme.dart';
import 'toast.dart';

/// 完整下载原附件并交给系统程序，反馈不包含附件地址。
Future<void> openAttachmentExternally(
  BuildContext context, {
  required Attachment file,
  required String url,
}) async {
  toast(context, L10n.s(context).tf('attach.opening', {'name': file.name}));
  final error = await openAttachmentFile(name: file.name, url: url);
  if (!context.mounted) return;
  toast(
    context,
    error ?? L10n.s(context).t('attach.openedSystem'),
    kind: error == null ? ToastKind.success : ToastKind.error,
  );
}

/// 将原附件保存到用户选择的位置；取消选择不视为错误。
Future<void> downloadAttachment(
  BuildContext context, {
  required Attachment file,
  required String url,
}) async {
  toast(context, L10n.s(context).tf('attach.downloading', {'name': file.name}));
  try {
    final response = await http
        .get(Uri.parse(url))
        .timeout(const Duration(seconds: 120));
    if (response.statusCode < 200 || response.statusCode >= 300) {
      throw StateError('HTTP ${response.statusCode}');
    }
    final path = await saveAttachment(
      name: file.name,
      bytes: response.bodyBytes,
    );
    if (path == null || !context.mounted) return;
    toast(
      context,
      L10n.s(context).tf('attach.savedTo', {'path': path}),
      kind: ToastKind.success,
    );
  } catch (_) {
    if (context.mounted)
      toast(
        context,
        L10n.s(context).t('attach.downloadError'),
        kind: ToastKind.error,
      );
  }
}

/// 阅读工具栏的原文件操作与打开状态，不能把转换后的网页作为原文件下载。
class AttachmentActionButtons extends StatefulWidget {
  const AttachmentActionButtons({super.key, required this.request});
  final AttachmentPreviewRequest request;

  @override
  State<AttachmentActionButtons> createState() =>
      _AttachmentActionButtonsState();
}

class _AttachmentActionButtonsState extends State<AttachmentActionButtons> {
  late AttachmentOpenController _opener;

  void _create() {
    _opener = AttachmentOpenController(
      operation: () => openAttachmentFile(
        name: widget.request.file.name,
        url: widget.request.sourceUrl,
      ),
    )..addListener(_changed);
  }

  void _changed() {
    if (mounted) setState(() {});
  }

  @override
  void initState() {
    super.initState();
    _create();
  }

  @override
  void didUpdateWidget(AttachmentActionButtons oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (widget.request == oldWidget.request) return;
    _opener.removeListener(_changed);
    _opener.dispose();
    _create();
  }

  @override
  void dispose() {
    _opener.removeListener(_changed);
    _opener.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => SizedBox(
    width: _opener.message == null ? 64 : 104,
    child: Column(
      mainAxisSize: MainAxisSize.min,
      children: [
        Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            IconButton(
              tooltip: L10n.s(context).t('common.download'),
              visualDensity: VisualDensity.compact,
              constraints: const BoxConstraints.tightFor(width: 28, height: 28),
              style: const ButtonStyle(
                tapTargetSize: MaterialTapTargetSize.shrinkWrap,
              ),
              padding: const EdgeInsets.all(6),
              icon: const Icon(LucideIcons.download, size: 16),
              onPressed: () => downloadAttachment(
                context,
                file: widget.request.file,
                url: widget.request.sourceUrl,
              ),
            ),
            IconButton(
              tooltip: L10n.s(context).t('attach.openWithSystem'),
              visualDensity: VisualDensity.compact,
              constraints: const BoxConstraints.tightFor(width: 28, height: 28),
              style: const ButtonStyle(
                tapTargetSize: MaterialTapTargetSize.shrinkWrap,
              ),
              padding: const EdgeInsets.all(6),
              icon: _opener.opening
                  ? const SizedBox(
                      width: 16,
                      height: 16,
                      child: CircularProgressIndicator(strokeWidth: 2),
                    )
                  : const Icon(LucideIcons.externalLink, size: 16),
              onPressed: _opener.opening ? null : _opener.open,
            ),
          ],
        ),
        if (_opener.message case final message?)
          Tooltip(
            message: message,
            child: Semantics(
              liveRegion: true,
              child: Text(
                message,
                maxLines: 2,
                overflow: TextOverflow.ellipsis,
                textAlign: TextAlign.center,
                style: TextStyle(
                  fontSize: PB.fsXxs,
                  color: _opener.phase == AttachmentOpenPhase.failed
                      ? PB.danger
                      : PB.textSecondary,
                ),
              ),
            ),
          ),
      ],
    ),
  );
}
