/// 请求 outbox：保存完整不可变请求信封与所属服务，支持原操作重传。
library;

import 'dart:convert';

import 'package:shared_preferences/shared_preferences.dart';

class OutboxPersistException implements Exception {
  OutboxPersistException(this.message);
  final String message;
  @override
  String toString() => message;
}

class RequestOutboxEntry {
  RequestOutboxEntry({
    required this.requestId,
    required this.roomId,
    required this.text,
    required this.mode,
    required this.attachmentIds,
    required this.serverIdentity,
    required this.createdAt,
  });

  final String requestId;
  final String roomId;
  final String text;
  final String mode;
  final List<String> attachmentIds;
  final String serverIdentity;
  final int createdAt;

  Map<String, dynamic> toJson() => {
        'requestId': requestId,
        'roomId': roomId,
        'text': text,
        'mode': mode,
        'attachments': attachmentIds,
        'serverIdentity': serverIdentity,
        'createdAt': createdAt,
      };

  static RequestOutboxEntry? fromJson(Object? raw) {
    if (raw is! Map) return null;
    final requestId = raw['requestId'];
    final roomId = raw['roomId'];
    final text = raw['text'];
    if (requestId is! String || requestId.isEmpty || roomId is! String || text is! String) return null;
    return RequestOutboxEntry(
      requestId: requestId,
      roomId: roomId,
      text: text,
      mode: raw['mode'] is String ? raw['mode'] as String : 'steer',
      attachmentIds: ((raw['attachments'] as List?) ?? const []).whereType<String>().toList(),
      serverIdentity: raw['serverIdentity'] is String ? raw['serverIdentity'] as String : '',
      createdAt: raw['createdAt'] is int ? raw['createdAt'] as int : 0,
    );
  }
}

class RequestOutbox {
  static const _storageKey = 'request_outbox';

  final Map<String, RequestOutboxEntry> _entries = <String, RequestOutboxEntry>{};
  Future<void> _tail = Future<void>.value();
  int _seq = 0;
  bool _loaded = false;

  /// 同一时刻只有一个事务：读最新快照 → 候选 → 写盘 → 提交内存。
  Future<T> _exclusive<T>(Future<T> Function() op) {
    final result = _tail.then((_) => op());
    _tail = result.then((_) {}, onError: (_) {});
    return result;
  }

  bool get loaded => _loaded;
  Map<String, dynamic> get snapshot =>
      {for (final e in _entries.entries) e.key: e.value.toJson()};
  List<RequestOutboxEntry> get entries => List.unmodifiable(_entries.values);

  RequestOutboxEntry? entry(String requestId) => _entries[requestId];

  Future<void> load() {
    return _exclusive(() async {
    if (_loaded) return;
    _loaded = true;
    try {
      final prefs = await SharedPreferences.getInstance();
      final raw = prefs.getString(_storageKey);
      if (raw == null || raw.isEmpty) return;
      final parsed = jsonDecode(raw);
      if (parsed is! Map) return;
      for (final value in parsed.values) {
        final entry = RequestOutboxEntry.fromJson(value);
        if (entry != null) _entries[entry.requestId] = entry;
      }
    } catch (_) {}
    });
  }

  String newRequestId() {
    _seq += 1;
    return 'req_${DateTime.now().microsecondsSinceEpoch}_$_seq';
  }

  Future<void> remember({
    required String requestId,
    required String roomId,
    required String text,
    required String mode,
    required List<String> attachmentIds,
    required String serverIdentity,
  }) {
    return _exclusive(() async {
    final previous = _entries[requestId];
    final candidate = RequestOutboxEntry(
      requestId: requestId,
      roomId: roomId,
      text: text,
      mode: mode,
      attachmentIds: attachmentIds,
      serverIdentity: serverIdentity,
      createdAt: DateTime.now().millisecondsSinceEpoch,
    );
    // 先以候选快照写盘；成功后才提交内存。失败恢复原记录，不能把待确认请求删掉。
    final nextSnapshot = <String, dynamic>{
      ...snapshot,
      requestId: candidate.toJson(),
    };
    final ok = await _persistSnapshot(nextSnapshot);
    if (!ok) {
      if (previous != null) _entries[requestId] = previous; else _entries.remove(requestId);
      throw OutboxPersistException('发送前未能保存请求，未发送');
    }
    _entries[requestId] = candidate;
    });
  }

  Future<void> clear(String? requestId) {
    if (requestId == null || requestId.isEmpty) return Future<void>.value();
    return _exclusive(() async {
      if (_entries.remove(requestId) == null) return;
      await _persistSnapshot(snapshot);
    });
  }

  Future<bool> persist() => _exclusive(() => _persistSnapshot(snapshot));

  Future<bool> _persistSnapshot(Map<String, dynamic> value) async {
    try {
      final prefs = await SharedPreferences.getInstance();
      return await prefs.setString(_storageKey, jsonEncode(value));
    } catch (_) {
      return false;
    }
  }
}
