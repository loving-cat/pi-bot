import 'dart:async';

import 'package:flutter/foundation.dart';

import 'avatar_appearance.dart';

/// 单次外观写入的固定快照；isCurrent 表示它仍是该目标的最新选择。
class AppearanceSaveRequest {
  AppearanceSaveRequest._(
    this._isCurrent, {
    required this.botId,
    required this.connectionKey,
    required this.color,
    required this.shape,
  });

  final String botId;
  final Object connectionKey;
  final String? color;
  final int? shape;
  final bool Function() _isCurrent;

  bool get isCurrent => _isCurrent();
  Map<String, dynamic> get patch =>
      Map.unmodifiable({'avatarColor': color, 'avatarShape': shape});
}

typedef AppearanceSaver = Future<bool> Function(AppearanceSaveRequest request);

/// 同一连接与 Bot 共用队列；界面关闭只移除监听，已选外观继续保存。
class AppearanceSaveControllers {
  final Expando<Map<String, AppearanceSaveController>> _scopes = Expando();

  AppearanceSaveController forBot({
    required Object scope,
    required String botId,
    String? initialColor,
    int? initialShape,
    required AppearanceSaver save,
  }) {
    final entries = _scopes[scope] ??= <String, AppearanceSaveController>{};
    return entries.putIfAbsent(
      botId,
      () => AppearanceSaveController(
        botId: botId,
        connectionKey: scope,
        color: initialColor,
        shape: initialShape,
        save: save,
      ),
    )..synchronize(color: initialColor, shape: initialShape);
  }
}

/// 串行写入外观，合并尚未发送的选择，并保留失败草稿供重试。
class AppearanceSaveController extends ChangeNotifier {
  AppearanceSaveController({
    required this.botId,
    required this.connectionKey,
    String? color,
    int? shape,
    required this.save,
  }) : _color = normalizeAvatarColor(color),
       _shape = normalizeAvatarShape(shape),
       _savedColor = normalizeAvatarColor(color),
       _savedShape = normalizeAvatarShape(shape);

  final String botId;
  final Object connectionKey;
  final AppearanceSaver save;
  String? _color;
  int? _shape;
  String? _savedColor;
  int? _savedShape;
  bool _saving = false;
  bool _failed = false;
  bool _hasSaved = false;
  bool _serverStateKnown = true;
  bool _disposed = false;
  int _revision = 0;
  Completer<void>? _completion;

  String? get color => _color;
  int? get shape => _shape;
  String? get persistedColor => _savedColor;
  int? get persistedShape => _savedShape;
  bool get isSaving => _saving;
  bool get isSaved => _hasSaved && !_saving && !_failed && !hasPendingChanges;
  String? get error => _failed ? '保存失败，请重试。' : null;
  bool get canRetry => _failed && !_saving && !_disposed;
  bool get hasPendingChanges =>
      !_serverStateKnown || _color != _savedColor || _shape != _savedShape;

  Future<void> setColor(String? value) {
    if (value != null && parseAvatarColor(value) == null) {
      return Future.value();
    }
    return setAppearance(color: value, shape: _shape);
  }

  Future<void> setShape(int? value) {
    if (value != null && normalizeAvatarShape(value) == null) {
      return Future.value();
    }
    return setAppearance(color: _color, shape: value);
  }

  /// 同时设置两字段；null 明确恢复该字段的默认外观。
  Future<void> setAppearance({String? color, int? shape}) {
    if (_disposed ||
        (color != null && parseAvatarColor(color) == null) ||
        (shape != null && normalizeAvatarShape(shape) == null)) {
      return Future.value();
    }
    _color = normalizeAvatarColor(color);
    _shape = shape;
    _failed = false;
    _revision++;
    if (_saving) {
      notifyListeners();
      return _completion!.future;
    }
    if (!hasPendingChanges) {
      notifyListeners();
      return Future.value();
    }
    _saving = true;
    final completion = _completion = Completer<void>();
    notifyListeners();
    unawaited(_drain());
    return completion.future;
  }

  Future<void> retry() => setAppearance(color: _color, shape: _shape);

  /// 外部刷新只同步空闲状态，正在保存或失败的草稿不被覆盖。
  void synchronize({String? color, int? shape}) {
    if (_disposed || _saving) return;
    _savedColor = normalizeAvatarColor(color);
    _savedShape = normalizeAvatarShape(shape);
    if (!_failed) {
      _color = _savedColor;
      _shape = _savedShape;
      _serverStateKnown = true;
    }
  }

  Future<void> _drain() async {
    try {
      while (!_disposed && hasPendingChanges) {
        final revision = _revision;
        final requestedColor = _color;
        final requestedShape = _shape;
        final request = AppearanceSaveRequest._(
          () =>
              !_disposed &&
              _color == requestedColor &&
              _shape == requestedShape,
          botId: botId,
          connectionKey: connectionKey,
          color: requestedColor,
          shape: requestedShape,
        );
        var success = false;
        try {
          success = await save(request);
        } catch (_) {
          success = false;
        }
        if (_disposed) break;
        if (success) {
          _savedColor = requestedColor;
          _savedShape = requestedShape;
          _serverStateKnown = true;
          _hasSaved = true;
          if (revision == _revision) break;
        } else {
          _serverStateKnown = false;
          if (revision == _revision) {
            _failed = true;
            break;
          }
        }
      }
    } finally {
      _saving = false;
      final completion = _completion;
      _completion = null;
      if (completion != null && !completion.isCompleted) completion.complete();
      if (!_disposed) notifyListeners();
    }
  }

  @override
  void dispose() {
    _disposed = true;
    super.dispose();
  }
}
