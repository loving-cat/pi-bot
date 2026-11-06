import 'models.dart';

/// 按服务连接保存删除事件与快照版本，阻止旧消息重新带回已删除附件。
class AttachmentDeletions {
  Object? _scope;
  String? _revision;
  final Set<String> _ids = {};
  int _epoch = 0;
  int _version = 0;

  int get epoch => _epoch;
  int get version => _version;

  void bind(Object? scope) {
    if (identical(scope, _scope)) return;
    _scope = scope;
    _revision = null;
    _ids.clear();
    _epoch++;
    _version++;
  }

  /// 快照版本改变说明可能漏收事件，需要重新拉取历史而非猜测删除 ID。
  bool synchronize(Object? revision) {
    if (revision is! String || revision.isEmpty || revision == _revision) {
      return false;
    }
    _revision = revision;
    _ids.clear();
    _epoch++;
    _version++;
    return true;
  }

  /// 实时事件包含具体 ID，直接处理缓存并记住版本，不清空正在流式的消息。
  void record(Iterable<String> ids, {Object? revision}) {
    _ids.addAll(ids.where((id) => id.isNotEmpty));
    if (revision is String && revision.isNotEmpty) {
      final currentCount = _count(_revision);
      final incomingCount = _count(revision);
      // 可比较的实时版本只能前进；旧格式的不同版本由后续快照确认。
      if (_revision == null ||
          revision == _revision ||
          (incomingCount != null &&
              (currentCount == null || incomingCount >= currentCount))) {
        _revision = revision;
      }
    }
    _version++;
  }

  static int? _count(String? revision) {
    if (revision == null) return null;
    final match = RegExp(r'^(\d+):[a-f0-9]{64}$').firstMatch(revision);
    return match == null ? null : int.tryParse(match.group(1)!);
  }

  Msg filter(Msg message) {
    if (message.attachments.any((a) => _ids.contains(a.id))) {
      message.attachments = message.attachments
          .where((a) => !_ids.contains(a.id))
          .toList();
    }
    return message;
  }

  void filterCache(Map<String, List<Msg>> messages) {
    for (final list in messages.values) {
      for (final message in list) {
        filter(message);
      }
    }
  }
}
