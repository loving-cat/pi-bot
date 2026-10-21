import 'models.dart';

enum ProgressResult { started, success, failure, ended }

/// 只有明确的完成结果才表示成功或失败；缺失或未知结果表示已结束。
ProgressResult progressResult(Msg message) {
  final meta = message.meta;
  if (meta?['phase'] == 'start') return ProgressResult.started;
  if (meta?['phase'] != 'done') return ProgressResult.ended;
  return switch (meta?['outcome']) {
    'success' => ProgressResult.success,
    'failure' => ProgressResult.failure,
    _ => ProgressResult.ended,
  };
}

String progressResultLabel(ProgressResult result) => switch (result) {
  ProgressResult.started => '接到活',
  ProgressResult.success => '已交付',
  ProgressResult.failure => '未完成',
  ProgressResult.ended => '已结束',
};

/// 按身份去重并保持出现顺序；无身份的旧记录使用名字作为标识。
List<({String id, String name})> progressSenders(List<Msg> messages) {
  final seen = <String>{};
  final result = <({String id, String name})>[];
  for (final message in messages) {
    final rawName = message.meta?['fromName'];
    final name = rawName is String ? rawName.trim() : '';
    if (name.isEmpty) continue;
    final rawId = message.meta?['fromId'];
    final id = rawId is String && rawId.isNotEmpty ? rawId : name;
    if (seen.add(id)) result.add((id: id, name: name));
  }
  return result;
}

/// 相邻回执按时间间隔分组，键为首条消息索引；普通消息、跨房间或倒序时间会断组。
Map<int, List<Msg>> groupProgressMessages(
  List<Msg> messages, {
  int maxGapMs = 10 * 60 * 1000,
}) {
  final groups = <int, List<Msg>>{};
  List<Msg>? current;
  for (var i = 0; i < messages.length; i++) {
    final message = messages[i];
    if (!message.isProgress) {
      current = null;
      continue;
    }
    final previous = current?.last;
    final gap = previous == null
        ? null
        : message.createdAt - previous.createdAt;
    if (previous == null ||
        previous.roomId != message.roomId ||
        gap! < 0 ||
        gap > maxGapMs) {
      current = <Msg>[];
      groups[i] = current;
    }
    current!.add(message);
  }
  return groups;
}
