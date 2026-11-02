import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:http/http.dart' as http;

import '../attachment_preview_request.dart';
import '../theme.dart';
import 'html_attachment_preview.dart';
import 'md_text.dart';

/// 附件的阅读内容；HTML 始终使用离线沙箱，文本与图片使用原生 Flutter 阅读组件。
class AttachmentPreviewContent extends StatefulWidget {
  const AttachmentPreviewContent({super.key, required this.request});
  final AttachmentPreviewRequest request;

  @override
  State<AttachmentPreviewContent> createState() =>
      _AttachmentPreviewContentState();
}

class _AttachmentPreviewContentState extends State<AttachmentPreviewContent> {
  static const _textLimit = 512 * 1024;
  http.Client? _client;
  int _generation = 0;
  bool _loading = false;
  String? _text;
  String? _error;

  @override
  void initState() {
    super.initState();
    _load();
  }

  @override
  void didUpdateWidget(AttachmentPreviewContent oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.request != widget.request) _load();
  }

  @override
  void dispose() {
    _generation++;
    _client?.close();
    super.dispose();
  }

  Future<void> _load() async {
    final generation = ++_generation;
    _client?.close();
    _client = null;
    _text = null;
    _error = null;
    _loading = false;
    final request = widget.request;
    if (request.kind != AttachmentPreviewKind.markdown &&
        request.kind != AttachmentPreviewKind.text)
      return;
    final client = http.Client();
    _client = client;
    _loading = true;
    try {
      final text = await _readText(
        client,
        request.sourceUrl,
      ).timeout(const Duration(seconds: 30));
      if (!mounted || generation != _generation) return;
      setState(() {
        _text = text;
        _loading = false;
      });
    } catch (_) {
      if (!mounted || generation != _generation) return;
      setState(() {
        _error = '暂时无法读取附件，请重新打开或下载后查看。';
        _loading = false;
      });
    } finally {
      client.close();
      if (identical(_client, client)) _client = null;
    }
  }

  Future<String> _readText(http.Client client, String sourceUrl) async {
    final response = await client.send(
      http.Request('GET', Uri.parse(sourceUrl))..followRedirects = false,
    );
    if (response.statusCode < 200 || response.statusCode >= 300)
      throw StateError('Attachment read failed');
    final bytes = <int>[];
    var truncated = false;
    await for (final chunk in response.stream) {
      final available = _textLimit - bytes.length;
      if (chunk.length > available) {
        bytes.addAll(chunk.take(available));
        truncated = true;
        break;
      }
      bytes.addAll(chunk);
    }
    final text = utf8.decode(bytes, allowMalformed: true);
    return truncated ? '$text\n\n…（内容太长，只显示了前 512KB，要看全部请下载）' : text;
  }

  @override
  Widget build(BuildContext context) {
    final request = widget.request;
    if (request.kind == AttachmentPreviewKind.html) {
      return HtmlAttachmentPreview(
        key: ValueKey(request),
        source: Uri.parse(request.sourceUrl),
        declaredSize: request.file.size,
      );
    }
    if (request.kind == AttachmentPreviewKind.image) {
      return Padding(
        padding: const EdgeInsets.all(14),
        child: InteractiveViewer(
          key: ValueKey(request),
          minScale: 0.6,
          maxScale: 5,
          child: Center(
            child: Image.network(
              request.sourceUrl,
              fit: BoxFit.contain,
              errorBuilder: (_, _, _) =>
                  const _PreviewMessage('图片暂时无法显示，请下载后查看。'),
            ),
          ),
        ),
      );
    }
    if (_loading)
      return const Center(
        child: SizedBox(
          width: 22,
          height: 22,
          child: CircularProgressIndicator(strokeWidth: 2),
        ),
      );
    if (_error != null) return _PreviewMessage(_error!);
    if (_text != null) {
      return SingleChildScrollView(
        key: ValueKey(request),
        padding: const EdgeInsets.fromLTRB(20, 16, 20, 24),
        child: request.kind == AttachmentPreviewKind.markdown
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
    return const _PreviewMessage('当前格式暂不能直接预览，请使用上方的下载或系统打开按钮。');
  }
}

class _PreviewMessage extends StatelessWidget {
  const _PreviewMessage(this.message);
  final String message;
  @override
  Widget build(BuildContext context) => Center(
    child: Padding(
      padding: const EdgeInsets.all(20),
      child: Text(
        message,
        textAlign: TextAlign.center,
        style: const TextStyle(fontSize: PB.fsXs, color: PB.textSecondary),
      ),
    ),
  );
}
