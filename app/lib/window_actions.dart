import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:window_manager/window_manager.dart';

/// 窗口状态与原生动作端口；界面不直接依赖平台通道。
abstract interface class WindowActionsBackend {
  void addListener(WindowListener listener);
  void removeListener(WindowListener listener);
  Future<bool> isMaximized();
  Future<bool> isFullScreen();
  Future<void> maximize();
  Future<void> unmaximize();
  Future<void> setFullScreen(bool value);
  Future<void> minimize();
  Future<void> close();
  Future<void> startDragging();
}

class _NativeWindowActions implements WindowActionsBackend {
  @override
  void addListener(WindowListener listener) =>
      windowManager.addListener(listener);
  @override
  void removeListener(WindowListener listener) =>
      windowManager.removeListener(listener);
  @override
  Future<bool> isMaximized() => windowManager.isMaximized();
  @override
  Future<bool> isFullScreen() => windowManager.isFullScreen();
  @override
  Future<void> maximize() => windowManager.maximize();
  @override
  Future<void> unmaximize() => windowManager.unmaximize();
  @override
  Future<void> setFullScreen(bool value) => windowManager.setFullScreen(value);
  @override
  Future<void> minimize() => windowManager.minimize();
  @override
  Future<void> close() => windowManager.close();
  @override
  Future<void> startDragging() => windowManager.startDragging();
}

/// 共用窗口动作和状态；普通放大保持原生语义，全屏时还原退出全屏。
class WindowActionsController extends ChangeNotifier with WindowListener {
  WindowActionsController({
    WindowActionsBackend? backend,
    this.fullScreenExitTimeout = const Duration(seconds: 3),
  }) : _backend = backend ?? _NativeWindowActions();

  final WindowActionsBackend _backend;
  final Duration fullScreenExitTimeout;
  Future<void>? _initialization;
  bool _listening = false;
  bool _disposed = false;
  bool _known = false;
  bool _maximized = false;
  bool _fullScreen = false;
  bool _busy = false;
  Object? _lastError;
  int _queryVersion = 0;
  Completer<void>? _fullScreenExit;
  Timer? _exitTimeout;

  bool get maximized => _maximized;
  bool get fullScreen => _fullScreen;
  bool get busy => _busy;
  Object? get lastError => _lastError;

  Future<void> initialize() {
    if (_disposed) return Future.value();
    return _initialization ??= _initialize();
  }

  Future<void> _initialize() async {
    try {
      _backend.addListener(this);
      _listening = true;
      await _refresh();
    } catch (error) {
      _recordError(error);
    }
  }

  /// 丢弃较早查询的结果，避免窗口事件与动作完成回调互相覆盖。
  Future<bool> _refresh() async {
    if (_disposed) return false;
    final version = ++_queryVersion;
    try {
      final values = await Future.wait([
        _backend.isMaximized(),
        _backend.isFullScreen(),
      ]);
      if (_disposed || version != _queryVersion) return false;
      final changed =
          !_known || _maximized != values[0] || _fullScreen != values[1];
      _known = true;
      _maximized = values[0];
      _fullScreen = values[1];
      if (changed) notifyListeners();
      return true;
    } catch (error) {
      if (!_disposed && version == _queryVersion) _recordError(error);
      return false;
    }
  }

  void _recordError(Object error) {
    if (_disposed) return;
    _lastError = error;
    notifyListeners();
  }

  Future<void> _perform(
    Future<void> Function() action, {
    bool refreshAfter = true,
  }) async {
    if (_disposed || _busy) return;
    _busy = true;
    _lastError = null;
    notifyListeners();
    try {
      await initialize();
      if (!_disposed) await action();
    } catch (error) {
      _recordError(error);
    } finally {
      if (!_disposed && refreshAfter) await _refresh();
      _busy = false;
      if (!_disposed) notifyListeners();
    }
  }

  Future<void> minimize() => _perform(_backend.minimize);

  Future<void> close() => _perform(_backend.close, refreshAfter: false);

  Future<void> toggleMaximize() => _perform(() async {
    if (!await _refresh() || _disposed) return;
    if (_fullScreen) {
      await _leaveFullScreen();
    } else if (_maximized) {
      await _backend.unmaximize();
    } else {
      await _backend.maximize();
    }
  });

  /// 使用已收到的状态，保持鼠标拖动事件到原生拖动循环的直接交接。
  Future<void> startDrag() {
    if (_disposed || !_known || _fullScreen) return Future.value();
    return _perform(_backend.startDragging, refreshAfter: false);
  }

  Future<void> _leaveFullScreen() async {
    final completion = Completer<void>();
    _fullScreenExit = completion;
    _exitTimeout = Timer(fullScreenExitTimeout, () => completion.complete());
    try {
      await _backend.setFullScreen(false);
      await completion.future;
      if (!_disposed && await _refresh() && _fullScreen) {
        _recordError(StateError('窗口尚未退出全屏，请重试'));
      }
    } finally {
      _exitTimeout?.cancel();
      _exitTimeout = null;
      if (identical(_fullScreenExit, completion)) _fullScreenExit = null;
    }
  }

  void _windowChanged() => unawaited(_refresh());

  @override
  void onWindowMaximize() => _windowChanged();
  @override
  void onWindowUnmaximize() => _windowChanged();
  @override
  void onWindowRestore() => _windowChanged();
  @override
  void onWindowResized() => _windowChanged();
  @override
  void onWindowFocus() => _windowChanged();

  @override
  void onWindowEnterFullScreen() {
    if (_disposed) return;
    ++_queryVersion;
    _fullScreen = true;
    notifyListeners();
    _windowChanged();
  }

  @override
  void onWindowLeaveFullScreen() {
    if (_disposed) return;
    ++_queryVersion;
    _fullScreen = false;
    _exitTimeout?.cancel();
    final completion = _fullScreenExit;
    if (completion != null && !completion.isCompleted) completion.complete();
    notifyListeners();
    _windowChanged();
  }

  @override
  void dispose() {
    if (_disposed) return;
    _disposed = true;
    ++_queryVersion;
    _exitTimeout?.cancel();
    final completion = _fullScreenExit;
    if (completion != null && !completion.isCompleted) completion.complete();
    if (_listening) {
      try {
        _backend.removeListener(this);
      } catch (_) {}
    }
    super.dispose();
  }
}
