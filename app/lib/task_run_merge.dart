/// TaskRun 纯合并：拒绝旧回包、检测缺口、按权威快照恢复。
///
/// 不依赖 Flutter/网络，便于单测。
library;

import 'task_run_models.dart';

class TaskRunMergeResult {
  const TaskRunMergeResult({
    this.changed = false,
    this.stale = false,
    this.gap = false,
  });
  final bool changed;
  final bool stale;
  final bool gap;
}

/// 每任务按 storeVersion 合并；快照为权威。
class TaskRunMerge {
  final Map<String, TaskRun> _byId = <String, TaskRun>{};
  int _cursor = 0;

  int get cursor => _cursor;
  List<TaskRun> get all => List<TaskRun>.unmodifiable(_byId.values.toList()..sort(
        (a, b) => b.updatedAt.compareTo(a.updatedAt),
      ));

  TaskRun? byId(String id) => _byId[id];

  void clear() {
    _byId.clear();
    _cursor = 0;
  }

  /// 权威快照：与增量共用 per-record storeVersion 规则；不因缺席推定删除。
  TaskRunMergeResult applySnapshot(Map<String, dynamic> json) {
    final list = (json['tasks'] as List?) ?? const [];
    var changed = false;
    for (final raw in list.whereType<Map>()) {
      final next = TaskRun.fromJson(raw.cast<String, dynamic>());
      if (next.id.isEmpty) continue;
      final current = _byId[next.id];
      if (current != null && next.storeVersion <= current.storeVersion) continue;
      _byId[next.id] = next;
      if (next.storeVersion > _cursor) _cursor = next.storeVersion;
      changed = true;
    }
    final cursor = json['cursor'];
    if (cursor is num && cursor.toInt() > _cursor) _cursor = cursor.toInt();
    return TaskRunMergeResult(changed: changed);
  }

  /// 增量事件：拒绝同版本重复与旧版本；跨度大于 1 报告缺口。
  TaskRunMergeResult applyEvent(Map<String, dynamic> json) {
    final raw = json['taskRun'];
    if (raw is! Map) return const TaskRunMergeResult();
    final next = TaskRun.fromJson(raw.cast<String, dynamic>());
    if (next.id.isEmpty) return const TaskRunMergeResult();
    final current = _byId[next.id];
    if (current != null) {
      if (next.storeVersion < current.storeVersion) {
        return const TaskRunMergeResult(stale: true);
      }
      if (next.storeVersion == current.storeVersion) {
        // 同版本：仅允许同内容幂等，拒绝倒退
        if (next.revision < current.revision) {
          return const TaskRunMergeResult(stale: true);
        }
        return const TaskRunMergeResult();
      }
    }
    final gap = current != null && next.storeVersion > current.storeVersion + 1;
    _byId[next.id] = next;
    if (next.storeVersion > _cursor) _cursor = next.storeVersion;
    return TaskRunMergeResult(changed: true, gap: gap);
  }

  /// 某房间活跃任务（子任务默认折叠在根任务上）。
  /// 某个会话的任务列表。
  ///
  /// ★ 只返回**根任务**：子任务是父任务内部的执行分工，
  ///   一起平铺出来会让用户以为「5 个任务在抢同一个负责人」，
  ///   实际上它们是同一件事的 4 份分工。子任务通过父任务的
  ///   childrenSummary 展示「谁在跟、做到哪」。
  List<TaskRun> forRoom(String roomId, {bool includeDone = false}) {
    return all
        .where((t) => t.roomId == roomId && t.isRoot && (includeDone || t.isActive))
        .toList(growable: false);
  }

  /// 某个根任务下的子任务（用于详情页展开）。
  List<TaskRun> childrenOf(String rootId) {
    return all.where((t) => t.rootTaskId == rootId && !t.isRoot).toList(growable: false);
  }
}
