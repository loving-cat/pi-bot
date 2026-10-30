import 'dart:async';

import 'package:flutter/foundation.dart';

import 'api.dart';
import 'connections_models.dart';
import 'models.dart';

/// 连接列表与操作请求；异步结果只更新仍有效的控制器和服务端。
class ConnectionsController extends ChangeNotifier {
  ConnectionsController({required this.apiProvider});
  final Api? Function() apiProvider;
  ConnectionsSnapshot snapshot = const ConnectionsSnapshot();
  bool loading = false;
  bool loaded = false;
  String? error;
  final Map<String, Object> _busy = {};
  bool _disposed = false;
  int _loadGeneration = 0;
  Api? _sourceApi;
  int _apiEpoch = 0;
  List<LocalMcpEntry> localEntries = const [];
  bool scanning = false;
  String? importError;
  String? importResult;
  int _scanGeneration = 0;
  Api? _scanApi;
  Timer? _expiryTimer;

  bool isBusy(String id) => _busy.containsKey(id);
  AppConnection? connection(String id) {
    for (final item in snapshot.connections) {
      if (item.id == id) return item;
    }
    return null;
  }

  void _notify() {
    if (!_disposed) notifyListeners();
  }

  bool _isCurrent(Api? api, int epoch) =>
      !_disposed && epoch == _apiEpoch && identical(api, apiProvider());

  String get _interrupted => _disposed ? '页面已关闭' : '服务端已切换，请重试';

  Future<void> load() async {
    if (_disposed) return;
    final generation = ++_loadGeneration;
    final api = apiProvider();
    if (!identical(api, _sourceApi)) {
      _apiEpoch++;
      _busy.clear();
      _scanGeneration++;
      _scanApi = null;
      scanning = false;
      snapshot = const ConnectionsSnapshot();
      loaded = false;
      _sourceApi = api;
      localEntries = const [];
      importResult = null;
    }
    loading = true;
    error = null;
    _notify();
    try {
      if (api == null) throw ApiException('请先连接服务端');
      final raw = await api.get('/api/connections');
      if (_disposed ||
          generation != _loadGeneration ||
          !identical(api, apiProvider()))
        return;
      snapshot = ConnectionsSnapshot.fromJson(raw);
      _scheduleExpiry();
      loaded = true;
    } catch (e) {
      if (_disposed ||
          generation != _loadGeneration ||
          !identical(api, apiProvider()))
        return;
      error = '$e';
    } finally {
      if (!_disposed && generation == _loadGeneration) {
        loading = false;
        _notify();
      }
    }
  }

  void _scheduleExpiry() {
    _expiryTimer?.cancel();
    final now = DateTime.now().millisecondsSinceEpoch;
    final pending =
        snapshot.connections
            .map((item) => item.verification)
            .where(
              (result) => result.state == 'ready' && result.checkedAt != null,
            )
            .map(
              (result) =>
                  result.checkedAt! +
                  const Duration(minutes: 10).inMilliseconds -
                  now,
            )
            .where((remaining) => remaining >= 0)
            .toList()
          ..sort();
    if (pending.isEmpty) return;
    _expiryTimer = Timer(Duration(milliseconds: pending.first + 50), () {
      _notify();
      if (!_disposed) _scheduleExpiry();
    });
  }

  Future<String?> _change(
    String id,
    Future<void> Function(Api api) request,
  ) async {
    if (_disposed) return '页面已关闭';
    if (!identical(_sourceApi, apiProvider())) return '服务端已切换，请刷新连接列表';
    if (_busy.containsKey(id)) return '这项操作仍在进行';
    final operation = Object();
    _busy[id] = operation;
    error = null;
    _notify();
    final api = apiProvider();
    final epoch = _apiEpoch;
    try {
      if (api == null) throw ApiException('请先连接服务端');
      await request(api);
      if (!_isCurrent(api, epoch)) return _interrupted;
      await load();
      return _isCurrent(api, epoch) ? null : _interrupted;
    } catch (e) {
      if (!_isCurrent(api, epoch)) return _interrupted;
      error = '$e';
      return '$e';
    } finally {
      if (identical(_busy[id], operation)) _busy.remove(id);
      _notify();
    }
  }

  Future<String?> verify(String id) => _change(id, (api) async {
    await api.post('/api/connections/${Uri.encodeComponent(id)}/verify');
  });

  Future<String?> setEnabled(String id, bool enabled) =>
      _change(id, (api) async {
        await api.patch('/api/mcp/${Uri.encodeComponent(id)}', {
          'enabled': enabled,
        });
      });

  Future<String?> assign(String id, Iterable<String> botIds) =>
      _change(id, (api) async {
        await api.put('/api/connections/${Uri.encodeComponent(id)}/bots', {
          'botIds': botIds.toSet().toList(),
        });
      });

  Future<String?> remove(String id) => _change(id, (api) async {
    await api.delete('/api/mcp/${Uri.encodeComponent(id)}');
  });

  Future<String?> save(Map<String, dynamic> patch) =>
      _change('${patch['id'] ?? 'new'}', (api) async {
        final id = patch['id'];
        if (id is String && id.isNotEmpty) {
          await api.patch('/api/mcp/${Uri.encodeComponent(id)}', patch);
        } else {
          await api.post('/api/mcp', patch);
        }
      });

  Future<Map<String, dynamic>> testDraft(Map<String, dynamic> patch) async {
    if (_disposed)
      return {'ok': false, 'error': '页面已关闭', 'errorCode': 'cancelled'};
    final api = apiProvider();
    final epoch = _apiEpoch;
    if (api == null) return {'ok': false, 'error': '请先连接服务端'};
    try {
      final result = await api.post('/api/mcp/test', patch);
      if (!_isCurrent(api, epoch)) {
        return {'ok': false, 'error': _interrupted, 'errorCode': 'cancelled'};
      }
      return result;
    } catch (e) {
      if (!_isCurrent(api, epoch)) {
        return {'ok': false, 'error': _interrupted, 'errorCode': 'cancelled'};
      }
      return {'ok': false, 'error': '$e'};
    }
  }

  Future<void> scanLocal() async {
    if (_disposed) return;
    final api = apiProvider();
    final epoch = _apiEpoch;
    final generation = ++_scanGeneration;
    _scanApi = api;
    scanning = true;
    localEntries = const [];
    importError = null;
    _notify();
    try {
      if (api == null) throw ApiException('请先连接服务端');
      final raw = await api.get('/api/local-capabilities');
      if (!_isCurrent(api, epoch) || generation != _scanGeneration) return;
      localEntries = LocalCapabilities.fromJson(raw).mcpServers;
    } catch (e) {
      if (_isCurrent(api, epoch) && generation == _scanGeneration)
        importError = '$e';
    } finally {
      if (!_disposed && generation == _scanGeneration) {
        scanning = false;
        _notify();
      }
    }
  }

  Future<String?> importLocal(List<String> names) async {
    if (!identical(_scanApi, apiProvider())) return '服务端已切换，请重新扫描本机配置';
    final api = apiProvider();
    final epoch = _apiEpoch;
    Map<String, dynamic>? result;
    final error = await _change('local-import', (api) async {
      result = await api.post('/api/local-capabilities/import', {
        'kind': 'mcp',
        'names': names,
      });
    });
    if (error != null) return error;
    if (!_isCurrent(api, epoch)) return _interrupted;
    final raw = result ?? const <String, dynamic>{};
    final count = (raw['imported'] as List?)?.length ?? 0;
    final skipped = ((raw['skipped'] as List?) ?? const [])
        .whereType<Map>()
        .map((item) => '${item['title'] ?? ''}：${item['reason'] ?? '未导入'}');
    importResult =
        '已导入 $count 个连接${skipped.isEmpty ? '' : '\n${skipped.join('\n')}'}';
    await scanLocal();
    return _isCurrent(api, epoch) ? null : _interrupted;
  }

  @override
  void dispose() {
    _disposed = true;
    _expiryTimer?.cancel();
    _loadGeneration++;
    super.dispose();
  }
}
