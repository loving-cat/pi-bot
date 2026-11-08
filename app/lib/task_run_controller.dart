/// TaskRun 控制器：绑定服务身份与连接代次，合并快照/增量，执行任务级命令。
library;

import 'dart:async';

import 'package:flutter/foundation.dart';

import 'api.dart';
import 'task_run_api.dart';
import 'task_run_merge.dart';
import 'task_run_models.dart';

class TaskRunBusinessException implements Exception {
  TaskRunBusinessException(this.message, {this.code});
  final String message;
  final String? code;
  @override
  String toString() => message;
}

class TaskRunController extends ChangeNotifier {
  TaskRunController({Api? api}) {
    bindApi(api);
  }

  TaskRunApi? _client;
  final TaskRunMerge _merge = TaskRunMerge();
  String? _identity;
  int _epoch = 0;
  bool _loading = false;
  String? _error;
  int _commandSeq = 0;
  bool _lastReplay = false;
  int _activeCount = 0;
  bool _activeComplete = true;
  Map<String, dynamic>? _pendingCommand;

  TaskRunMerge get merge => _merge;
  List<TaskRun> get tasks => _merge.all;
  String? get identity => _identity;
  int get epoch => _epoch;
  bool get loading => _loading;
  String? get error => _error;
  bool get lastReplay => _lastReplay;
  int get activeCount => _activeCount;
  bool get activeComplete => _activeComplete;

  List<TaskRun> forRoom(String roomId, {bool includeDone = false}) =>
      _merge.forRoom(roomId, includeDone: includeDone);

  void bindApi(Api? api, {String? identity}) {
    _client = api == null ? null : TaskRunApi(api);
    final next = identity ?? (api == null ? null : '${api.baseUrl}|${(api.token ?? '').hashCode}');
    if (next != _identity) {
      _identity = next;
      resetForServer(next);
    }
  }

  void resetForServer(String? identity) {
    _epoch += 1;
    _identity = identity;
    _merge.clear();
    _error = null;
    _pendingCommand = null;
    _activeCount = 0;
    _activeComplete = true;
    notifyListeners();
  }

  /// 服务端 hello：权威活跃快照 + 最近终态 + 完整性元信息。
  void applyHello(Map<String, dynamic> event) {
    final server = event['server'];
    final identity = (server is Map ? server['serverInstanceId'] as String? : null) ??
        (event['serverInstanceId'] as String?) ??
        (event['serverName'] as String?) ??
        (event['version'] as String?);
    if (identity != _identity) resetForServer(identity);
    final active = (event['taskRuns'] as List?) ?? const [];
    final recent = (event['recentTaskRuns'] as List?) ?? const [];
    _merge.applySnapshot(<String, dynamic>{
      'tasks': [...active, ...recent],
      'cursor': event['cursor'] ?? _merge.cursor,
    });
    final meta = event['taskRunMeta'];
    if (meta is Map) {
      _activeCount = meta['activeCount'] is num ? (meta['activeCount'] as num).toInt() : _activeCount;
      _activeComplete = meta['activeComplete'] == true;
    }
    _error = null;
    notifyListeners();
    if (!_activeComplete) {
      unawaited(refresh());
    } else {
      final incoming = active.whereType<Map>().map((m) => m['id']).whereType<String>().toSet();
      for (final cached in _merge.all.where((t) => t.isActive)) {
        if (!incoming.contains(cached.id)) unawaited(_refreshOne(cached.id));
      }
    }
  }

  void applyEvent(Map<String, dynamic> event, {int? epoch}) {
    if (epoch != null && epoch != _epoch) return;
    final result = _merge.applyEvent(event);
    if (result.gap) unawaited(refresh());
    if (result.changed) notifyListeners();
  }

  Future<void> _refreshOne(String id) async {
    final client = _client;
    if (client == null) return;
    final epoch = _epoch;
    try {
      final body = await client.snapshot(id);
      if (epoch != _epoch) return;
      final run = body['taskRun'];
      if (run is Map) {
        _merge.applyEvent({'taskRun': Map<String, dynamic>.from(run)});
        notifyListeners();
      }
    } catch (_) {}
  }

  /// 活跃任务：按 before 游标翻页直到服务端给出 complete，不把截断列表当完整事实。
  Future<void> refresh() async {
    final client = _client;
    if (client == null) return;
    final epoch = _epoch;
    _loading = true;
    notifyListeners();
    try {
      String? cursor;
      var complete = false;
      var count = 0;
      final fetched = <String>{};
      for (var page = 0; page < 10 && !complete; page += 1) {
        final body = await client.page(scope: 'active', limit: 200, cursor: cursor);
        if (epoch != _epoch) return;
        // ★ 直接把服务端原始 Map 交给 applySnapshot，不要经 TaskRun 重建。
        //
        //   原来先 fromJson 成 TaskRun、再用 _toJson 转回去 —— 而 _toJson
        //   只写了部分字段，phase / blockedReason / leadBotId / childrenSummary
        //   等六个字段在这一次往返里被静默丢掉。
        //
        //   后果不是"显示不全"而是"操作死结"：
        //   paused_budget 的任务被刷成 phase=active 后，
        //   「继续」按钮只认 paused_user、「追加额度」按钮只认 needs_user，
        //   两个都不出现 —— 任务既跑不动也关不掉。
        final raws = ((body['tasks'] as List?) ?? const []).whereType<Map>().toList();
        for (final raw in raws) {
          final id = raw['id'];
          if (id is String && id.isNotEmpty) fetched.add(id);
        }
        _merge.applySnapshot({
          'tasks': raws.map((m) => m.cast<String, dynamic>()).toList(),
          'cursor': _merge.cursor,
        });
        count = body['activeCount'] is num ? (body['activeCount'] as num).toInt() : count;
        complete = body['complete'] == true;
        final next = body['nextCursor'];
        cursor = next is String ? next : null;
        if (!complete && cursor == null) break;
      }
      _activeCount = count;
      _activeComplete = complete;
      if (complete) {
        for (final cached in _merge.all.where((t) => t.isActive)) {
          if (!fetched.contains(cached.id)) unawaited(_refreshOne(cached.id));
        }
      }
      _error = null;
    } catch (err) {
      _error = '$err';
    } finally {
      _loading = false;
      notifyListeners();
    }
  }

  Future<void> refreshHistory() async {
    final client = _client;
    if (client == null) return;
    final epoch = _epoch;
    try {
      final body = await client.page(scope: 'history', limit: 100);
      if (epoch != _epoch) return;
      _merge.applySnapshot({'tasks': (body['tasks'] as List?) ?? const [], 'cursor': _merge.cursor});
      notifyListeners();
    } catch (_) {}
  }

  /// 任务级命令：发出前保存完整不可变命令信封；成功才清理，未知结果保留可重试。
  Future<TaskRun?> control(
    TaskRun task, {
    required String type,
    String? ref,
    String? text,
    String? decision,
    String? reason,
    String? commandId,
    int? expectedRevision,
    int? extraRuns,
  }) async {
    final client = _client;
    if (client == null) return null;
    final effectiveId = commandId ?? _nextCommandId(task, type);
    final envelope = <String, dynamic>{
      'commandId': effectiveId,
      'taskId': task.id,
      'type': type,
      'ref': ref,
      'text': text,
      'decision': decision,
      'reason': reason,
      'expectedRevision': expectedRevision ?? task.revision,
      if (extraRuns != null) 'extraRuns': extraRuns,
    };
    _pendingCommand = envelope;
    final epoch = _epoch;
    try {
      final body = await client.control(
        task: task, type: type, commandId: effectiveId,
        expectedRevision: envelope['expectedRevision'] as int,
        ref: ref, text: text, decision: decision, reason: reason, extraRuns: extraRuns,
      );
      if (epoch != _epoch) return null;
      if (body['ok'] == false || body['accepted'] == false) {
        throw TaskRunBusinessException(
          (body['text'] as String?) ?? (body['code'] as String?) ?? '操作未被服务端接受',
          code: body['code'] as String?,
        );
      }
      _lastReplay = body['replayed'] == true;
      // 保留最近一次命令信封：未知结果/重复回包都可按原操作重试
      final updated = body['taskRun'];
      if (updated is Map) {
        _merge.applyEvent({'taskRun': Map<String, dynamic>.from(updated)});
        notifyListeners();
      }
      return _merge.byId(task.id);
    } catch (err) {
      if (err is TaskRunBusinessException) rethrow;
      rethrow;
    }
  }

  /// 原操作未知结果重试：使用发出前保存的命令信封，不重新拼字段。
  Future<TaskRun?> retryLastControl() async {
    final envelope = _pendingCommand;
    if (envelope == null) return null;
    final task = _merge.byId(envelope['taskId'] as String);
    if (task == null) return null;
    return control(
      task,
      type: envelope['type'] as String,
      ref: envelope['ref'] as String?,
      text: envelope['text'] as String?,
      decision: envelope['decision'] as String?,
      reason: envelope['reason'] as String?,
      commandId: envelope['commandId'] as String,
      expectedRevision: envelope['expectedRevision'] as int,
    );
  }

  String _nextCommandId(TaskRun task, String type) {
    _commandSeq += 1;
    return 'cmd_${type}_${task.id}_${_commandSeq}_${DateTime.now().microsecondsSinceEpoch}'
        .replaceAll(RegExp(r'[^A-Za-z0-9_-]'), '_');
  }

  // 注：_toJson 已删除。快照往返必须用服务端原始 Map ——
  // 手工重建对象会静默丢字段（见 refresh() 里的说明）。

  void clearError() {
    _error = null;
    notifyListeners();
  }
}
