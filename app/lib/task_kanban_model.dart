/// 任务看板的**归类纯逻辑**（W5a）。
///
/// ## 为什么单独成文件
///
/// 看板页要做四件事：把 11 个服务端状态折成 4 列、按「等你处理优先」排序、
/// 截断长标题、把旧对话片段收进折叠区。这些规则一旦写进 Widget 的 build 里，
/// 就只能靠肉眼验证 —— 而界面测试跑一次几秒，逻辑错一条要翻半天截图。
/// 所以这里只放纯函数：`TaskRun` → `KanbanCard`，不 import Flutter、不读时钟。
///
/// ## 归类口径（与服务端 `task-transport.js` 的 `PHASE_OF_STATE` 对齐）
///
/// | 列 | 状态 | 含义 |
/// |---|---|---|
/// | 待办 todo | `queued` `paused_user` | 还没在跑：等排期，或用户自己按了暂停 |
/// | 进行中 doing | `running` `verifying` `waiting_dependency` | 正在干，或等别的任务 |
/// | 等你处理 needsYou | `waiting_approval` `waiting_input` `blocked` `paused_budget` | 卡在人身上 |
/// | 已完成 done | `completed` `cancelled` | 终态 |
///
/// `paused_budget` 放进「等你处理」而不是「待办」：预算耗尽只有用户能加预算，
/// 摆在待办里就变成一条永远不动、也没人知道要做什么的卡片。
/// `waiting_dependency` 反而留在「进行中」：它在等别的任务跑完，不需要人动手。
///
/// 未知状态一律落到「进行中」而不是丢弃 —— 看板宁可显示一条错列的卡片，
/// 也不能让任务凭空消失（用户会以为活丢了）。
library;

import 'task_run_models.dart';

/// 看板四列，枚举顺序即界面从左到右的顺序。
enum KanbanColumn { todo, doing, done, needsYou }

/// 标题默认截断长度（按字符数，不是字节）。
const int kKanbanTitleMaxChars = 40;

/// 摘要默认截断长度。
const int kKanbanSummaryMaxChars = 80;

/// 状态 → 列。与 `task-transport.js` 的 phase 投影保持一致。
KanbanColumn kanbanColumnOf(String state) {
  switch (state) {
    case 'queued':
    case 'paused_user':
      return KanbanColumn.todo;
    case 'waiting_approval':
    case 'waiting_input':
    case 'blocked':
    case 'paused_budget':
      return KanbanColumn.needsYou;
    case 'completed':
    case 'cancelled':
      return KanbanColumn.done;
    case 'running':
    case 'verifying':
    case 'waiting_dependency':
      return KanbanColumn.doing;
    default:
      // 服务端加了新状态而 App 还没更新时：宁可先显示在「进行中」，
      // 也不要把卡片丢掉（丢卡 = 用户以为任务没了）。
      return KanbanColumn.doing;
  }
}

/// 「等你处理」内部再排个先后：要人点确认的比要人写字更急。
int _stateRankWithinColumn(String state) => switch (state) {
      'waiting_approval' => 0,
      'waiting_input' => 1,
      'blocked' => 2,
      'paused_budget' => 3,
      _ => 4,
    };

/// 列之间没排序需求（界面按列分栏），但「等你处理优先」要看得到，
/// 所以提供一个跨列权重：数字越小越靠前。
int kanbanRankOf(KanbanColumn column) => switch (column) {
      KanbanColumn.needsYou => 0,
      KanbanColumn.doing => 1,
      KanbanColumn.todo => 2,
      KanbanColumn.done => 3,
    };

/// 按**字符**（rune）截断，避免把 emoji 或中英混排切半个字节。
String truncateKanbanText(String text, int maxChars, {String ellipsis = '…'}) {
  final clean = text.trim().replaceAll(RegExp(r'\s+'), ' ');
  if (maxChars <= 0) return '';
  final runes = clean.runes.toList(growable: false);
  if (runes.length <= maxChars) return clean;
  return '${String.fromCharCodes(runes.take(maxChars))}$ellipsis';
}

/// 看板卡片：把 TaskRun 里界面要用的那几个字段提前算好。
class KanbanCard {
  const KanbanCard({
    required this.run,
    required this.column,
    required this.title,
    required this.summary,
    required this.leadName,
    required this.paused,
    required this.legacyLike,
  });

  final TaskRun run;
  final KanbanColumn column;

  /// 已截断的标题（标题为空时退到 scope，再退到「未命名任务」）。
  final String title;

  /// 已截断的一句摘要：受阻原因 > 等待说明 > 状态文案 > 目标。
  final String summary;

  /// 负责人名字；没有负责人时是空串（界面显示「未指派」而不是空白）。
  final String leadName;

  /// 是否处于暂停态（界面画个暂停点，不要画成「正在跑」）。
  final bool paused;

  /// 是否像一条旧对话片段（W5c 迁移前的兜底判定）。
  ///
  /// 服务端迁移落地后会写 `legacy-note` 标记，那时应改读标记；
  /// 这里先用「已完成 + 没有交付物 + 标题像一句话」的启发式，
  /// 让「已完成」列不至于被 36 条"收到。先看基线和色板…"刷满。
  final bool legacyLike;

  /// 是不是被取消的（也会落在「已完成」列）。
  ///   取消不等于干完：卡片上必须标出来，否则看板会把它当成交付。
  bool get cancelled => run.state == 'cancelled';

  String get id => run.id;
  String get roomId => run.roomId ?? '';
  bool get needsYou => column == KanbanColumn.needsYou;
}

/// 旧对话片段的启发式：终态、没有任何交付物、标题像一句人话。
///
/// 判据刻意保守（三段都满足才算）：宁可少折叠，也不要把真正的交付记录藏起来。
bool looksLikeConversationFragment(TaskRun run) {
  if (run.state != 'completed') return false;
  if (run.deliverables.isNotEmpty) return false;
  final t = run.title.trim();
  if (t.isEmpty) return true;
  if (t.length > 30) return true;
  return t.endsWith('。') ||
      t.endsWith('…') ||
      t.endsWith('...') ||
      t.startsWith('收到') ||
      t.startsWith('好的');
}

/// 一句话摘要的取材顺序。
String _summaryOf(TaskRun run, int maxChars) {
  final parts = <String>[
    if (run.blockedReason.trim().isNotEmpty) run.blockedReason,
    if (run.waiting?.describe.trim().isNotEmpty ?? false) run.waiting!.describe,
    if (run.stateText.trim().isNotEmpty) run.stateText,
    if (run.scope.trim().isNotEmpty) run.scope,
  ];
  if (parts.isEmpty) return '';
  return truncateKanbanText(parts.first, maxChars);
}

/// 负责人名字：服务端带名字就用它；只有 id 时先问宿主（App 有 bots 表），
/// 再退回 id —— 看板上宁可显示 `b_49b6aa…`，也不要显示空白。
String _leadNameOf(TaskRun run, String Function(String botId)? nameOf) {
  final named = run.leadBotName.trim();
  if (named.isNotEmpty) return named;
  final id = run.leadBotId.trim();
  if (id.isEmpty) return '';
  final resolved = nameOf?.call(id).trim() ?? '';
  return resolved.isNotEmpty ? resolved : id;
}

/// 把一批 TaskRun 摊成卡片。
///
/// - `onlyNeedsYou`：界面上的「只看等我的」开关；
/// - 排序：先按列权重（等你处理 → 进行中 → 待办 → 已完成），
///   同列内「等你处理」按紧急度，其余按更新时间倒序，最后用 id 兜底保证稳定；
/// - **不丢任务**：进来多少条就出多少张卡（除非被 `onlyNeedsYou` 过滤）。
List<KanbanCard> buildKanbanCards(
  List<TaskRun> runs, {
  bool onlyNeedsYou = false,
  /// 默认只出**根任务**的卡：子任务已经在根卡里以 childrenSummary 展示，
  /// 再单独出一张 = 同一件事在看板上出现两次，还会把数量和角标一起虚增。
  bool onlyRoot = true,
  int titleMaxChars = kKanbanTitleMaxChars,
  int summaryMaxChars = kKanbanSummaryMaxChars,
  String Function(String botId)? nameOf,
}) {
  final cards = <KanbanCard>[];
  for (final run in runs) {
    if (onlyRoot && !run.isRoot) continue;
    final column = kanbanColumnOf(run.state);
    if (onlyNeedsYou && column != KanbanColumn.needsYou) continue;
    final rawTitle = run.title.trim().isNotEmpty
        ? run.title
        : (run.scope.trim().isNotEmpty ? run.scope : '未命名任务');
    cards.add(
      KanbanCard(
        run: run,
        column: column,
        title: truncateKanbanText(rawTitle, titleMaxChars),
        summary: _summaryOf(run, summaryMaxChars),
        leadName: _leadNameOf(run, nameOf),
        paused: run.state == 'paused_user' || run.state == 'paused_budget',
        legacyLike: looksLikeConversationFragment(run),
      ),
    );
  }
  cards.sort((a, b) {
    final byColumn = kanbanRankOf(a.column).compareTo(kanbanRankOf(b.column));
    if (byColumn != 0) return byColumn;
    if (a.column == KanbanColumn.needsYou) {
      final byUrgency = _stateRankWithinColumn(a.run.state)
          .compareTo(_stateRankWithinColumn(b.run.state));
      if (byUrgency != 0) return byUrgency;
    }
    final byUpdated = b.run.updatedAt.compareTo(a.run.updatedAt);
    if (byUpdated != 0) return byUpdated;
    final bySeq = b.run.sequence.compareTo(a.run.sequence);
    if (bySeq != 0) return bySeq;
    return a.run.id.compareTo(b.run.id);
  });
  return cards;
}

/// 四列分桶（列顺序固定，空列也给空列表 —— 界面才好画「这一列空着」）。
Map<KanbanColumn, List<KanbanCard>> groupKanbanCards(List<KanbanCard> cards) {
  final map = <KanbanColumn, List<KanbanCard>>{
    for (final c in KanbanColumn.values) c: <KanbanCard>[],
  };
  for (final card in cards) {
    map[card.column]!.add(card);
  }
  return map;
}

/// 顶部四格统计。
class KanbanStats {
  const KanbanStats({
    required this.todo,
    required this.doing,
    required this.done,
    required this.needsYou,
  });

  final int todo;
  final int doing;
  final int done;
  final int needsYou;

  int get total => todo + doing + done + needsYou;

  factory KanbanStats.of(Map<KanbanColumn, List<KanbanCard>> columns) => KanbanStats(
        todo: columns[KanbanColumn.todo]?.length ?? 0,
        doing: columns[KanbanColumn.doing]?.length ?? 0,
        done: columns[KanbanColumn.done]?.length ?? 0,
        needsYou: columns[KanbanColumn.needsYou]?.length ?? 0,
      );
}
