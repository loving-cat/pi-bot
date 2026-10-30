import 'dart:async';

import 'package:flutter/foundation.dart';

/// 同一服务连接与 Bot 共用写入队列；面板关闭后已确认选择仍按顺序保存。
class ModelSelectionSaves {
  final Expando<Map<String, ModelSelectionSave>> _scopes = Expando();

  ModelSelectionSave forBot({
    required Object scope,
    required String botId,
    required String initialValue,
    required Future<String> Function(String value) save,
  }) {
    final entries = _scopes[scope] ??= <String, ModelSelectionSave>{};
    return entries.putIfAbsent(
      botId,
      () => ModelSelectionSave(initialValue: initialValue, save: save),
    )..synchronize(initialValue);
  }
}

/// 串行保存模型选择；请求进行中仅保留最新选择，失败保留待重试值。
class ModelSelectionSave extends ChangeNotifier {
  ModelSelectionSave({required String initialValue, required this.save})
    : savedValue = initialValue.trim(),
      lastSavedInput = initialValue.trim(),
      selectedValue = initialValue.trim();

  final Future<String> Function(String value) save;
  String savedValue;
  String lastSavedInput;
  String selectedValue;
  bool saving = false;
  bool failed = false;
  bool hasSaved = false;
  bool _disposed = false;
  bool _serverStateKnown = true;
  int _revision = 0;
  Completer<void>? _completion;

  Future<void> select(String value) {
    if (_disposed) return Future.value();
    selectedValue = value.trim();
    failed = false;
    _revision++;
    if (saving) {
      notifyListeners();
      return _completion!.future;
    }
    if (_serverStateKnown && selectedValue == savedValue) {
      notifyListeners();
      return Future.value();
    }
    saving = true;
    final completion = _completion = Completer<void>();
    notifyListeners();
    unawaited(_drain());
    return completion.future;
  }

  Future<void> retry() => select(selectedValue);

  /// 外部配置刷新只同步空闲状态，不覆盖正在保存或失败待重试的选择。
  void synchronize(String value) {
    if (_disposed || saving) return;
    savedValue = value.trim();
    if (!failed) selectedValue = savedValue;
  }

  Future<void> _drain() async {
    try {
      while (true) {
        final revision = _revision;
        final value = selectedValue;
        if (_serverStateKnown && value == savedValue) break;
        try {
          savedValue = (await save(value)).trim();
          lastSavedInput = value;
          _serverStateKnown = true;
          hasSaved = true;
          if (revision == _revision) {
            selectedValue = savedValue;
            break;
          }
        } catch (_) {
          _serverStateKnown = false;
          if (revision == _revision) {
            failed = true;
            break;
          }
        }
      }
    } finally {
      saving = false;
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
