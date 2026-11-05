import 'dart:async';
import 'dart:collection';
import 'dart:convert';
import 'dart:io';

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter_inappwebview/flutter_inappwebview.dart';

import '../html_preview_document.dart';
import '../l10n/l10n.dart';
import '../html_preview_environment.dart';
import '../html_preview_platform_policy.dart';

/// 仅加载宿主生成的离线文档；报告不获得附件地址、授权信息或应用工具桥接。
class OfflineHtmlView extends StatefulWidget {
  const OfflineHtmlView({
    super.key,
    required this.html,
    required this.onReady,
    required this.onError,
    this.onExternalLink,
    this.onDiagnostic,
  });

  final String html;
  final VoidCallback onReady;
  final ValueChanged<String> onError;
  final ValueChanged<Uri>? onExternalLink;
  final ValueChanged<String>? onDiagnostic;

  @override
  State<OfflineHtmlView> createState() => _OfflineHtmlViewState();
}

class _OfflineHtmlViewState extends State<OfflineHtmlView> {
  _PreviewSession? _session;
  _PreviewSession? _pendingSession;
  int _generation = 0;
  bool _failed = false;
  bool _ready = false;
  Timer? _timeout;

  @override
  void initState() {
    super.initState();
    unawaited(_initialize());
  }

  @override
  void didUpdateWidget(OfflineHtmlView oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.html != widget.html) unawaited(_initialize());
  }

  Future<void> _initialize() async {
    final strings = L10n.s(context);
    final generation = ++_generation;
    _timeout?.cancel();
    final previous = _session;
    final previousPending = _pendingSession;
    _session = null;
    _pendingSession = null;
    if (previousPending != null) unawaited(previousPending.release());
    _failed = false;
    _ready = false;
    _diagnose('initializing', generation);
    _timeout = Timer(const Duration(seconds: 20), () {
      _fail(strings.t('offline.timeout'), generation);
    });
    if (previous != null) {
      WidgetsBinding.instance.addPostFrameCallback((_) {
        unawaited(previous.release());
      });
      WidgetsBinding.instance.ensureVisualUpdate();
    }
    final platform = defaultTargetPlatform;
    if (kIsWeb || !supportsOfflineHtmlPreview(platform)) {
      _fail(strings.t('offline.unsupported'), generation);
      return;
    }
    _PreviewSession? session;
    try {
      final document = buildOfflineHtmlDocument(widget.html);
      if (utf8.encode(document).length > 2 * 1024 * 1024) {
        _fail(strings.t('offline.tooLarge'), generation);
        return;
      }
      session = _PreviewSession(generation, document, platform);
      _pendingSession = session;
      if (platform == TargetPlatform.windows) {
        final version = await WebViewEnvironment.getAvailableVersion().timeout(
          const Duration(seconds: 8),
        );
        if (version == null || version.isEmpty) {
          _fail(strings.t('offline.missingRuntime'), generation);
          return;
        }
        if (session.closed) return;
        await session.createDirectory();
        if (session.closed) return;
        final currentSession = session;
        final environment = await awaitHtmlPreviewResource(
          creation: WebViewEnvironment.create(
            settings: WebViewEnvironmentSettings(
              userDataFolder: session.directory!.path,
              additionalBrowserArguments: '--disable-background-networking --disable-sync --no-first-run',
            ),
          ),
          isCancelled: () => currentSession.closed,
          releaseLate: currentSession.releaseLateEnvironment,
        );
        if (session.closed) {
          await session.releaseLateEnvironment(environment);
          return;
        }
        session.environment = environment;
        session.lease = HtmlPreviewEnvironmentLease(
          releaseNative: environment.dispose,
        );
      }
      if (!mounted || generation != _generation || _failed) {
        await session.release();
        return;
      }
      _pendingSession = null;
      setState(() => _session = session);
      _diagnose('environment-ready', generation);
    } catch (_) {
      _fail(strings.t('offline.initFailed'), generation);
      await session?.release();
    }
  }

  bool _current(_PreviewSession session) =>
      mounted &&
      !_failed &&
      identical(_session, session) &&
      session.generation == _generation;

  void _diagnose(String stage, int generation) {
    scheduleMicrotask(() {
      if (mounted && generation == _generation)
        widget.onDiagnostic?.call(stage);
    });
  }

  void _fail(String message, int generation) {
    if (!mounted || generation != _generation || _failed) return;
    _failed = true;
    _diagnose('failed', generation);
    _timeout?.cancel();
    final session = _session;
    final pendingSession = _pendingSession;
    _session = null;
    _pendingSession = null;
    if (pendingSession != null) unawaited(pendingSession.release());
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted || generation != _generation) {
        if (session != null) unawaited(session.release());
        return;
      }
      setState(() {});
      widget.onError(message);
      if (session != null) {
        WidgetsBinding.instance.addPostFrameCallback((_) {
          unawaited(session.release());
        });
        WidgetsBinding.instance.ensureVisualUpdate();
      }
    });
    WidgetsBinding.instance.ensureVisualUpdate();
  }

  Future<void> _checkReady(_PreviewSession session) async {
    if (!_current(session) || _ready || session.polling) return;
    final strings = L10n.s(context);
    session.polling = true;
    try {
      while (_current(session) && !_ready) {
        dynamic ready;
        try {
          ready = await session.controller
              ?.evaluateJavascript(
                source: "document.body && (document.body.dataset.previewError ? 'blocked' : document.body.dataset.previewReady === 'true' ? 'ready' : 'pending')",
              )
              .timeout(const Duration(seconds: 1));
        } catch (_) {
          ready = 'retry';
        }
        if (!_current(session)) return;
        final phase = switch (ready) {
          'ready' => 'probe-ready',
          'blocked' => 'probe-blocked',
          'pending' => 'probe-pending',
          'retry' => 'probe-retry',
          _ => 'probe-empty',
        };
        if (session.lastProbe != phase) {
          session.lastProbe = phase;
          _diagnose(phase, session.generation);
        }
        if (ready == 'blocked') {
          if (widget.onDiagnostic != null) {
            try {
              final stage = await session.controller
                  ?.evaluateJavascript(
                    source: 'document.body && document.body.dataset.previewErrorStage',
                  )
                  .timeout(const Duration(seconds: 1));
              if (const [
                'globals',
                'captures',
                'dom',
                'events',
                'freeze',
                'content',
              ].contains(stage)) {
                _diagnose('guard-$stage', session.generation);
              }
              final lock = await session.controller
                  ?.evaluateJavascript(
                    source: 'document.body && document.body.dataset.previewErrorLock',
                  )
                  .timeout(const Duration(seconds: 1));
              if (offlineHtmlDiagnosticLocks.contains(lock)) {
                _diagnose('guard-lock-$lock', session.generation);
              }
            } catch (_) {}
          }
          _fail(strings.t('offline.isolationFailed'), session.generation);
          return;
        }
        if (ready == 'ready') {
          _ready = true;
          _timeout?.cancel();
          widget.onReady();
          return;
        }
        await Future<void>.delayed(const Duration(milliseconds: 100));
      }
    } finally {
      session.polling = false;
    }
  }

  @override
  void dispose() {
    _generation++;
    _timeout?.cancel();
    final session = _session;
    final pendingSession = _pendingSession;
    _session = null;
    _pendingSession = null;
    if (session != null) unawaited(session.release());
    if (pendingSession != null) unawaited(pendingSession.release());
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final strings = L10n.s(context);
    final session = _session;
    if (session == null || _failed) return const SizedBox.shrink();
    return InAppWebView(
      key: ValueKey(session.generation),
      webViewEnvironment: session.environment,
      initialSettings: offlineHtmlSettings(session.platform),
      initialData: InAppWebViewInitialData(
        data: session.document,
        mimeType: 'text/html',
        encoding: 'utf-8',
        baseUrl: WebUri('about:blank'),
      ),
      initialUserScripts: UnmodifiableListView([
        UserScript(
          source: offlineHtmlBootstrapScript,
          injectionTime: UserScriptInjectionTime.AT_DOCUMENT_START,
          forMainFrameOnly: false,
          contentWorld: ContentWorld.PAGE,
        ),
      ]),
      onWebViewCreated: (controller) {
        session.controller = controller;
        _diagnose('view-created', session.generation);
        if (!_current(session)) {
          unawaited(controller.stopLoading().catchError((_) {}));
        } else {
          unawaited(_checkReady(session));
        }
      },
      onLoadStart: (_, _) => _diagnose('load-started', session.generation),
      onLoadStop: (_, _) {
        _diagnose('load-stopped', session.generation);
        unawaited(_checkReady(session));
      },
      onReceivedError: (_, request, _) {
        if (request.isForMainFrame == true) {
          _fail(strings.t('offline.loadFailed'), session.generation);
        }
      },
      shouldOverrideUrlLoading: (_, action) async {
        final allowed =
            _current(session) &&
            allowOfflineHtmlNavigation(action.request.url?.uriValue);
        _diagnose(
          allowed ? 'navigation-allowed' : 'navigation-blocked',
          session.generation,
        );
        return allowed
            ? NavigationActionPolicy.ALLOW
            : NavigationActionPolicy.CANCEL;
      },
      shouldInterceptRequest: (_, _) async => WebResourceResponse(
        contentType: 'text/plain',
        contentEncoding: 'utf-8',
        data: Uint8List(0),
        headers: const {'Cache-Control': 'no-store'},
        statusCode: 403,
        reasonPhrase: 'Offline preview',
      ),
      onCreateWindow: (_, _) async => false,
      onPermissionRequest: (_, request) async => PermissionResponse(
        resources: request.resources,
        action: PermissionResponseAction.DENY,
      ),
      onGeolocationPermissionsShowPrompt: (_, origin) async =>
          GeolocationPermissionShowPromptResponse(
            origin: origin,
            allow: false,
            retain: false,
          ),
      onReceivedHttpAuthRequest: (_, _) async =>
          HttpAuthResponse(action: HttpAuthResponseAction.CANCEL),
      onReceivedClientCertRequest: (_, _) async => ClientCertResponse(
        certificatePath: '',
        action: ClientCertResponseAction.CANCEL,
      ),
      onReceivedServerTrustAuthRequest: (_, _) async =>
          ServerTrustAuthResponse(action: ServerTrustAuthResponseAction.CANCEL),
      onJsAlert: (_, _) async => JsAlertResponse(handledByClient: true),
      onJsConfirm: (_, _) async => JsConfirmResponse(
        handledByClient: true,
        action: JsConfirmResponseAction.CANCEL,
      ),
      onJsPrompt: (_, _) async => JsPromptResponse(
        handledByClient: true,
        action: JsPromptResponseAction.CANCEL,
      ),
      onDownloadStarting: (_, _) {
        final controller = session.controller;
        if (_current(session) && controller != null) {
          unawaited(controller.stopLoading().catchError((_) {}));
        }
        return DownloadStartResponse(
          handled: true,
          action: DownloadStartResponseAction.CANCEL,
        );
      },
      onPrintRequest: (_, _, job) async {
        job?.dispose();
        return true;
      },
      onWebContentProcessDidTerminate: (_) =>
          _fail(strings.t('offline.processStopped'), session.generation),
      onProcessFailed: (_, _) =>
          _fail(strings.t('offline.processCrashed'), session.generation),
      onRenderProcessGone: (_, _) async {
        _fail(strings.t('offline.processStopped'), session.generation);
      },
    );
  }
}

class _PreviewSession {
  _PreviewSession(this.generation, this.document, this.platform);
  final int generation;
  final String document;
  final TargetPlatform platform;
  Directory? directory;
  WebViewEnvironment? environment;
  HtmlPreviewEnvironmentLease? lease;
  InAppWebViewController? controller;
  bool polling = false;
  String? lastProbe;
  bool closed = false;
  Future<void>? _release;

  Future<void> createDirectory() async {
    final created = await Directory.systemTemp.createTemp('pi-bot-html-');
    directory = created;
    if (closed) await removeHtmlPreviewDirectory(created);
  }

  Future<void> releaseLateEnvironment(WebViewEnvironment created) async {
    try {
      await HtmlPreviewEnvironmentLease(releaseNative: created.dispose)
          .dispose()
          .timeout(const Duration(seconds: 3));
    } catch (_) {}
    if (directory != null) await removeHtmlPreviewDirectory(directory!);
  }

  Future<void> release() => _release ??= _dispose();

  Future<void> _dispose() async {
    closed = true;
    try {
      await controller?.stopLoading().timeout(const Duration(seconds: 2));
    } catch (_) {}
    try {
      await lease?.dispose().timeout(const Duration(seconds: 3));
    } catch (_) {}
    if (directory != null) await removeHtmlPreviewDirectory(directory!);
  }
}
