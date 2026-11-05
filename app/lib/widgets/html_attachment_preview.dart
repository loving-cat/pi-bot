import 'dart:async';

import 'package:flutter/material.dart';
import 'package:url_launcher/url_launcher.dart';

import '../html_preview_document.dart';
import '../l10n/l10n.dart';
import '../html_preview_loader.dart';
import '../theme.dart';
import 'offline_html_view.dart';

typedef HtmlPreviewRendererBuilder = Widget Function(
  BuildContext context, {
  required String html,
  required VoidCallback onReady,
  required ValueChanged<String> onError,
  required ValueChanged<Uri> onExternalLink,
});

/// HTML 附件的加载、预览和源码切换；渲染器只接收解码内容。
class HtmlAttachmentPreview extends StatefulWidget {
  const HtmlAttachmentPreview({
    super.key,
    required this.source,
    this.declaredSize = 0,
    this.loaderFactory,
    this.rendererBuilder,
    this.onExternalLink,
    this.renderTimeout = const Duration(seconds: 20),
  });

  final Uri source;
  final int declaredSize;
  final HtmlPreviewLoader Function()? loaderFactory;
  final HtmlPreviewRendererBuilder? rendererBuilder;
  final Future<void> Function(Uri)? onExternalLink;
  final Duration renderTimeout;

  @override
  State<HtmlAttachmentPreview> createState() => _HtmlAttachmentPreviewState();
}

class _HtmlAttachmentPreviewState extends State<HtmlAttachmentPreview> {
  HtmlPreviewLoader? _loader;
  Timer? _renderTimer;
  String? _html;
  String? _loadError;
  String? _renderError;
  bool _loading = true;
  bool _source = false;
  bool _ready = false;
  bool _linkDialog = false;
  List<Uri> _links = const [];
  int _generation = 0;
  int _renderGeneration = 0;

  @override
  void initState() {
    super.initState();
    _load();
  }

  @override
  void didUpdateWidget(HtmlAttachmentPreview oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.source != widget.source ||
        oldWidget.declaredSize != widget.declaredSize) {
      _load();
    }
  }

  Future<void> _load() async {
    final generation = ++_generation;
    _loader?.cancel();
    _renderTimer?.cancel();
    _renderGeneration++;
    _loader = widget.loaderFactory?.call() ?? HtmlPreviewLoader();
    setState(() {
      _loading = true;
      _html = null;
      _loadError = null;
      _renderError = null;
      _ready = false;
      _source = false;
      _links = const [];
      _linkDialog = false;
    });
    try {
      final html = await _loader!.load(
        widget.source,
        declaredSize: widget.declaredSize,
      );
      if (!mounted || generation != _generation) return;
      setState(() {
        _html = html;
        _links = externalHtmlLinks(html);
        _loading = false;
      });
      _startRendering();
    } on HtmlPreviewLoadException catch (error) {
      if (!mounted || generation != _generation) return;
      setState(() {
        _loadError = error.message;
        _loading = false;
      });
    } catch (_) {
      if (!mounted || generation != _generation) return;
      setState(() {
        _loadError = L10n.s(context).t('html.readFailed');
        _loading = false;
      });
    }
  }

  void _startRendering() {
    final generation = ++_renderGeneration;
    _renderTimer?.cancel();
    _ready = false;
    _renderError = null;
    _renderTimer = Timer(
      widget.renderTimeout,
      () => _rendererError(generation, L10n.s(context).t('html.renderTimeout')),
    );
  }

  void _rendererReady(int generation) {
    if (!mounted ||
        generation != _renderGeneration ||
        _ready ||
        _renderError != null)
      return;
    _renderTimer?.cancel();
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted && generation == _renderGeneration && _renderError == null)
        setState(() => _ready = true);
    });
    WidgetsBinding.instance.ensureVisualUpdate();
  }

  void _rendererError(int generation, String message) {
    if (!mounted || generation != _renderGeneration || _renderError != null)
      return;
    _renderTimer?.cancel();
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted && generation == _renderGeneration) {
        setState(() => _renderError = message);
      }
    });
    WidgetsBinding.instance.ensureVisualUpdate();
  }

  Future<void> _openLinks() async {
    if (_links.isEmpty || _linkDialog) return;
    final generation = _generation;
    _renderTimer?.cancel();
    _renderGeneration++;
    setState(() => _linkDialog = true);
    await WidgetsBinding.instance.endOfFrame;
    if (!mounted || generation != _generation) return;
    try {
      final target = await showDialog<Uri>(
        context: context,
        builder: (context) => AlertDialog(
          title: Text(L10n.s(context).t('html.externalLinksTitle')),
          content: SizedBox(
            width: 520,
            height: 320,
            child: ListView.builder(
              itemCount: _links.length,
              itemBuilder: (context, index) => ListTile(
                title: Text(_links[index].host),
                subtitle: Text(
                  _links[index].toString(),
                  maxLines: 2,
                  overflow: TextOverflow.ellipsis,
                ),
                onTap: () => Navigator.pop(context, _links[index]),
              ),
            ),
          ),
          actions: [
            TextButton(
              onPressed: () => Navigator.pop(context),
              child: Text(L10n.s(context).t('common.close')),
            ),
          ],
        ),
      );
      if (!mounted ||
          generation != _generation ||
          target == null ||
          !_links.contains(target))
        return;
      final confirmed = await showDialog<bool>(
        context: context,
        builder: (context) => AlertDialog(
          title: Text(L10n.s(context).t('html.openInBrowser')),
          content: SingleChildScrollView(
            child: SelectableText(target.toString()),
          ),
          actions: [
            TextButton(
              onPressed: () => Navigator.pop(context, false),
              child: Text(L10n.s(context).t('common.cancel')),
            ),
            FilledButton(
              onPressed: () => Navigator.pop(context, true),
              child: Text(L10n.s(context).t('html.openLink')),
            ),
          ],
        ),
      );
      if (!mounted || generation != _generation || confirmed != true) return;
      if (widget.onExternalLink != null) {
        await widget.onExternalLink!(target);
      } else {
        final opened = await launchUrl(
          target,
          mode: LaunchMode.externalApplication,
        );
        if (!opened) throw StateError('browser unavailable');
      }
    } catch (_) {
      if (mounted && generation == _generation) {
        ScaffoldMessenger.maybeOf(context)?.showSnackBar(
          SnackBar(content: Text(L10n.s(context).t('html.browserFailed'))),
        );
      }
    } finally {
      if (mounted && generation == _generation) {
        if (!_source) _startRendering();
        setState(() => _linkDialog = false);
      }
    }
  }

  @override
  void dispose() {
    _generation++;
    _renderGeneration++;
    _loader?.cancel();
    _renderTimer?.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    if (_loading) return const Center(child: CircularProgressIndicator());
    if (_loadError != null) return _errorPanel(_loadError!, retry: true);
    final html = _html!;
    final generation = _renderGeneration;
    return Column(
      children: [
        Padding(
          padding: const EdgeInsets.fromLTRB(12, 6, 12, 6),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                children: [
                  _tab(L10n.s(context).t('html.previewTab'), false),
                  const SizedBox(width: 4),
                  _tab(L10n.s(context).t('html.sourceTab'), true),
                  const Spacer(),
                  if (_links.isNotEmpty)
                    TextButton(
                      onPressed: _openLinks,
                      child: Text(L10n.s(context).t('html.externalLinks')),
                    ),
                ],
              ),
              Text(
                L10n.s(context).t('html.offlineNote'),
                style: const TextStyle(
                  fontSize: PB.fsXs,
                  color: PB.textTertiary,
                ),
              ),
            ],
          ),
        ),
        Expanded(
          child: _linkDialog
              ? const SizedBox.shrink()
              : _source
              ? _sourceView(html)
              : _renderError != null
              ? _errorPanel(_renderError!, source: true)
              : Stack(
                  children: [
                    Positioned.fill(
                      child:
                          widget.rendererBuilder?.call(
                            context,
                            html: html,
                            onReady: () => _rendererReady(generation),
                            onError: (message) =>
                                _rendererError(generation, message),
                            onExternalLink: (_) {},
                          ) ??
                          OfflineHtmlView(
                            html: html,
                            onReady: () => _rendererReady(generation),
                            onError: (message) =>
                                _rendererError(generation, message),
                            onExternalLink: (_) {},
                          ),
                    ),
                    if (!_ready)
                      const Positioned.fill(
                        child: IgnorePointer(
                          child: Center(child: CircularProgressIndicator()),
                        ),
                      ),
                  ],
                ),
        ),
      ],
    );
  }

  void _selectSource(bool source) {
    if (_source == source) return;
    if (source) {
      _renderTimer?.cancel();
      _renderGeneration++;
    } else {
      _startRendering();
    }
    setState(() => _source = source);
  }

  Widget _tab(String label, bool source) => TextButton(
    onPressed: () => _selectSource(source),
    style: TextButton.styleFrom(
      foregroundColor: _source == source ? PB.textPrimary : PB.textSecondary,
      backgroundColor: _source == source ? PB.bgActive : Colors.transparent,
    ),
    child: Text(label),
  );

  Widget _sourceView(String html) {
    const limit = 512 * 1024;
    final capped = html.length > limit;
    return SingleChildScrollView(
      padding: const EdgeInsets.all(16),
      child: SelectableText(
        capped
            ? '${html.substring(0, limit)}\n\n'
                  '${L10n.s(context).t('html.truncated')}'
            : html,
        style: const TextStyle(
          fontFamily: PB.monoFamily,
          fontFamilyFallback: PB.monoFallback,
          fontSize: PB.fsXs,
          height: 1.5,
          color: PB.textSecondary,
        ),
      ),
    );
  }

  Widget _errorPanel(
    String message, {
    bool retry = false,
    bool source = false,
  }) => Center(
    child: Padding(
      padding: const EdgeInsets.all(24),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          Text(
            message,
            textAlign: TextAlign.center,
            style: const TextStyle(color: PB.textSecondary, height: 1.5),
          ),
          const SizedBox(height: 12),
          if (retry)
            TextButton(
              onPressed: _load,
              child: Text(L10n.s(context).t('common.retry')),
            ),
          if (source)
            TextButton(
              onPressed: () => _selectSource(true),
              child: Text(L10n.s(context).t('html.viewSource')),
            ),
        ],
      ),
    ),
  );
}
