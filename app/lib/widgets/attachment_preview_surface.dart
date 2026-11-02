import 'package:flutter/material.dart';

import '../attachment_preview_request.dart';
import '../browser_pane_state.dart';
import '../theme.dart';
import 'browser_pane.dart';

/// 可用宽度不足时使用独立二级阅读页，不改变已打开的会话详情栏。
Future<void> showAttachmentSecondary(
  BuildContext context,
  AttachmentPreviewRequest request,
) => Navigator.of(context).push<void>(
  PageRouteBuilder<void>(
    opaque: false,
    barrierColor: Colors.black.withValues(alpha: 0.6),
    pageBuilder: (_, _, _) => _AttachmentPreviewSurface(request: request),
    transitionsBuilder: (_, animation, _, child) => FadeTransition(
      opacity: animation,
      child: Transform.scale(
        scale: 0.97 + 0.03 * animation.value,
        child: child,
      ),
    ),
  ),
);

class _AttachmentPreviewSurface extends StatefulWidget {
  const _AttachmentPreviewSurface({required this.request});
  final AttachmentPreviewRequest request;
  @override
  State<_AttachmentPreviewSurface> createState() =>
      _AttachmentPreviewSurfaceState();
}

class _AttachmentPreviewSurfaceState extends State<_AttachmentPreviewSurface> {
  final _pane = BrowserPaneState();
  bool _expanded = false;

  @override
  void initState() {
    super.initState();
    final request = widget.request;
    _pane.showFile(
      name: request.file.name,
      htmlUrl: request.viewUrl,
      nativeViewer: request.kind == AttachmentPreviewKind.pdf,
      request: request,
    );
  }

  @override
  void dispose() {
    _pane.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final screen = MediaQuery.sizeOf(context);
    final availableWidth = (screen.width - 24).clamp(0.0, double.infinity);
    final width = _expanded
        ? availableWidth
        : (screen.width * 0.78).clamp(
            availableWidth.clamp(0.0, 320.0),
            availableWidth.clamp(0.0, 900.0),
          );
    final height = _expanded
        ? (screen.height - 24).clamp(0.0, double.infinity)
        : (screen.height * 0.82).clamp(0.0, 820.0);
    return Center(
      child: Material(
        type: MaterialType.transparency,
        child: Container(
          key: const ValueKey('attachment-secondary-preview'),
          width: width,
          height: height,
          decoration: BoxDecoration(
            color: PB.bgPane,
            borderRadius: BorderRadius.circular(PB.r2xl),
            border: Border.all(color: PB.borderSecondary),
            boxShadow: PB.shadow(y: 12, blur: 40, alpha: 0.5),
          ),
          clipBehavior: Clip.antiAlias,
          child: BrowserPane(
            state: _pane,
            onClose: () => Navigator.of(context).pop(),
            showNavigationControls: false,
            toolbarActions: [
              if (width >= 400)
                TextButton(
                  onPressed: () => setState(() => _expanded = !_expanded),
                  child: Text(_expanded ? '恢复' : '放大'),
                ),
            ],
          ),
        ),
      ),
    );
  }
}
