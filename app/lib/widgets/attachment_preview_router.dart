import 'package:flutter/widgets.dart';

import '../attachment_preview_request.dart';
import '../browser_pane_state.dart';
import '../models.dart';
import '../scope.dart';
import 'attachment_preview_scope.dart';
import 'attachment_preview_surface.dart';

/// 附件正文与展示按钮共用入口，按真实栏宽选择侧栏或二级预览。
Future<void> openAttachmentPreview(
  BuildContext context,
  Attachment file,
  String sourceUrl,
) async {
  final request = AttachmentPreviewRequest(file: file, sourceUrl: sourceUrl);
  final state = context.getInheritedWidgetOfExactType<AppScope>()?.notifier;
  if (state != null &&
      AttachmentPreviewScope.maybeOf(context)?.inlineAvailable == true) {
    state.showAttachmentRequest(request);
    return;
  }
  if (state != null &&
      state.browser.open &&
      state.browser.kind == PaneContentKind.file) {
    state.closeBrowserPane();
  }
  await showAttachmentSecondary(context, request);
}
