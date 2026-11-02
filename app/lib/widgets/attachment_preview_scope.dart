import 'package:flutter/widgets.dart';

/// 附件入口使用的实际布局能力；没有宿主布局时使用二级预览。
class AttachmentPreviewScope extends InheritedWidget {
  const AttachmentPreviewScope({
    super.key,
    required this.inlineAvailable,
    required super.child,
  });

  final bool inlineAvailable;

  static AttachmentPreviewScope? maybeOf(BuildContext context) =>
      context.dependOnInheritedWidgetOfExactType<AttachmentPreviewScope>();

  @override
  bool updateShouldNotify(AttachmentPreviewScope oldWidget) =>
      inlineAvailable != oldWidget.inlineAvailable;
}
