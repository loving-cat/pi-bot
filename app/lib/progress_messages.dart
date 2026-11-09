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
/// 这批回执是**谁发来的**。
///
/// ★ 必须用消息的作者，不能用 meta.fromName。
///
///   两者的语义正好相反：
///     · authorId/authorName = 实际干完活、把结果交出来的那个 bot
///     · meta.fromId/fromName = 当初把活派给它的那个人
///   标题要回答的是「我收到了谁的消息」，所以该用作者。
///   用 fromName 会显示成「收到负责人的消息」——但正文明明是成员交的活，
///   读起来就是方向反了。
List<({String id, String name})> progressSenders(List<Msg> messages) {
  final seen = <String>{};
  final result = <({String id, String name})>[];
  for (final message in messages) {
    final rawName = message.authorName.trim();
    final name = rawName.isNotEmpty
        ? rawName
        : ((message.meta?['fromName'] as String?) ?? '').trim();
    if (name.isEmpty) continue;
    final rawId = message.authorId;
    final id = (rawId != null && rawId.isNotEmpty) ? rawId : name;
    if (seen.add(id)) result.add((id: id, name: name));
  }
  return result;
}

/// 相邻回执按时间间隔分组，键为首条消息索引；普通消息、跨房间或倒序时间会断组。
/// 分组窗口：同一个部门的工作往往断断续续跨几小时，
/// 10 分钟会把每一段都拆成独立气泡，私聊里就变成一长串「收到 X 消息」，
/// 每行还只有 1~8 条。放宽到 6 小时，一次部门工作大体能收成一条。
const int kProgressGroupGapMs = 6 * 60 * 60 * 1000;

Map<int, List<Msg>> groupProgressMessages(
  List<Msg> messages, {
  int maxGapMs = kProgressGroupGapMs,
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