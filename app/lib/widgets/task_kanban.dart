/// 全局任务看板（W5b）：四列 + 顶部统计 + 「只看等我的」+ 成员过滤。
///
/// ## 只做展示，归类判定不在这里
///
/// 状态→列、排序、截断、旧片段折叠判定全在 `task_kanban_model.dart`（W5a，有 21 项
/// 纯逻辑测试）。这里只负责把卡片画出来、把点击转给 `showTaskRunSheet`，
/// 这样界面改动不会悄悄改变归类口径。
///
/// ## 数据源只有一份
///
/// 房间内清单（`task_board.dart`）和右侧栏（`room_task_panel.dart`）也都读
/// `state.taskRuns`；看板不另建缓存，否则两处状态会打架。
library;

import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../app_state.dart';
import '../l10n/l10n.dart';
import '../task_kanban_model.dart';
import '../task_run_models.dart';
import '../theme.dart';
import '../window_chrome.dart';
import 'task_run_card.dart';
import 'task_run_sheet.dart';

/// 打开全局任务看板（整页路由：手机和桌面同一套，避免再养一个浮层）。
Future<void> showTaskKanban(BuildContext context, AppState state) {
  return Navigator.of(
    context,
  ).push(MaterialPageRoute<void>(builder: (_) => TaskKanbanPage(state: state)));
}

class TaskKanbanPage extends StatefulWidget {
  const TaskKanbanPage({super.key, required this.state});

  final AppState state;

  @override
  State<TaskKanbanPage> createState() => _TaskKanbanPageState();
}

class _TaskKanbanPageState extends State<TaskKanbanPage> {
  bool _onlyMine = false;
  bool _showLegacy = false;
  String? _lead;

  static const double _minColumnWidth = 260;
  static const double _wideBreakpoint = 900;

  @override
  Widget build(BuildContext context) {
    final s = L10n.s(context);
    return Scaffold(
      backgroundColor: PB.bgApp,
      // 全页也要能拖窗口：顶部条用 chromeAppBar + WindowDragArea，
      // 否则进了看板就拖不动整个应用（其它页面都这么做）。
      appBar: chromeAppBar(
        context,
        AppBar(
          flexibleSpace: const WindowDragArea(),
          title: Text(s.t('kanban.title')),
          backgroundColor: Colors.transparent,
          elevation: 0,
          scrolledUnderElevation: 0,
          actions: [
            IconButton(
              key: const ValueKey('kanban-only-mine'),
              tooltip: s.t('kanban.onlyMine'),
              icon: Icon(
                _onlyMine ? LucideIcons.filterX : LucideIcons.funnel,
                size: 18,
              ),
              color: _onlyMine
                  ? PB.colors(context).accentBright
                  : PB.textTertiary,
              onPressed: () => setState(() => _onlyMine = !_onlyMine),
            ),
            const SizedBox(width: 6),
          ],
        ),
      ),
      body: ListenableBuilder(
        listenable: widget.state.taskRuns,
        builder: (context, _) {
          final allCards = buildKanbanCards(widget.state.taskRuns.tasks);
          final cards = _onlyMine
              ? allCards.where((c) => c.needsYou).toList()
              : (_lead == null
                    ? allCards
                    : allCards.where((c) => c.leadName == _lead).toList());
          final columns = groupKanbanCards(cards);
          final stats = KanbanStats.of(groupKanbanCards(allCards));
          final leads = <String>{
            for (final c in allCards)
              if (c.leadName.isNotEmpty) c.leadName,
          }.toList()..sort();
          return Column(
            children: [
              _StatsRow(stats: stats),
              if (leads.isNotEmpty)
                _LeadFilter(
                  leads: leads,
                  selected: _lead,
                  onSelect: (lead) => setState(() => _lead = lead),
                ),
              Expanded(
                child: LayoutBuilder(
                  builder: (context, box) {
                    final wide = box.maxWidth >= _wideBreakpoint;
                    if (wide) {
                      return Row(
                        crossAxisAlignment: CrossAxisAlignment.stretch,
                        children: [
                          for (final column in KanbanColumn.values)
                            Expanded(
                              child: _Column(
                                column: column,
                                cards: columns[column] ?? const [],
                                showLegacy: _showLegacy,
                                onToggleLegacy: () =>
                                    setState(() => _showLegacy = !_showLegacy),
                                onOpen: (card) => showTaskRunSheet(
                                  context,
                                  widget.state,
                                  card.run,
                                ),
                              ),
                            ),
                        ],
                      );
                    }
                    return ListView(
                      key: const ValueKey('kanban-hscroll'),
                      scrollDirection: Axis.horizontal,
                      padding: const EdgeInsets.fromLTRB(8, 0, 8, 12),
                      children: [
                        for (final column in KanbanColumn.values)
                          SizedBox(
                            width: _minColumnWidth,
                            child: _Column(
                              column: column,
                              cards: columns[column] ?? const [],
                              showLegacy: _showLegacy,
                              onToggleLegacy: () =>
                                  setState(() => _showLegacy = !_showLegacy),
                              onOpen: (card) => showTaskRunSheet(
                                context,
                                widget.state,
                                card.run,
                              ),
                            ),
                          ),
                      ],
                    );
                  },
                ),
              ),
            ],
          );
        },
      ),
    );
  }
}

class _StatsRow extends StatelessWidget {
  const _StatsRow({required this.stats});

  final KanbanStats stats;

  @override
  Widget build(BuildContext context) {
    final s = L10n.s(context);
    final items = <(KanbanColumn, String, int)>[
      (KanbanColumn.todo, s.t('kanban.todo'), stats.todo),
      (KanbanColumn.doing, s.t('kanban.doing'), stats.doing),
      (KanbanColumn.done, s.t('kanban.done'), stats.done),
      (KanbanColumn.needsYou, s.t('kanban.needsYou'), stats.needsYou),
    ];
    return Padding(
      padding: const EdgeInsets.fromLTRB(10, 4, 10, 6),
      child: Row(
        children: [
          for (final (column, label, count) in items)
            Expanded(
              child: Container(
                key: ValueKey('kanban-stat-${column.name}'),
                margin: const EdgeInsets.symmetric(horizontal: 3),
                padding: const EdgeInsets.symmetric(
                  horizontal: 10,
                  vertical: 8,
                ),
                decoration: BoxDecoration(
                  color: PB.bgElevated,
                  borderRadius: BorderRadius.circular(PB.rXl),
                  border: Border.all(color: PB.borderSecondary),
                ),
                child: Row(
                  children: [
                    Container(
                      width: 6,
                      height: 6,
                      decoration: BoxDecoration(
                        color: _columnColor(context, column),
                        shape: BoxShape.circle,
                      ),
                    ),
                    const SizedBox(width: 6),
                    Expanded(
                      child: Text(
                        label,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: TextStyle(
                          fontSize: PB.fsXs,
                          color: PB.textTertiary,
                        ),
                      ),
                    ),
                    Text(
                      '$count',
                      style: TextStyle(
                        fontSize: PB.fsSm,
                        fontWeight: FontWeight.w600,
                        color: PB.textPrimary,
                      ),
                    ),
                  ],
                ),
              ),
            ),
        ],
      ),
    );
  }
}

class _LeadFilter extends StatelessWidget {
  const _LeadFilter({
    required this.leads,
    required this.selected,
    required this.onSelect,
  });

  final List<String> leads;
  final String? selected;
  final void Function(String? lead) onSelect;

  @override
  Widget build(BuildContext context) {
    final s = L10n.s(context);
    final colors = PB.colors(context);
    Widget pill(String? lead, String label) {
      final active = selected == lead;
      return Padding(
        key: ValueKey('kanban-lead-${lead ?? 'all'}'),
        padding: const EdgeInsets.only(right: 6),
        child: Material(
          color: active ? colors.accentSoft : Colors.transparent,
          borderRadius: BorderRadius.circular(PB.rFull),
          child: InkWell(
            borderRadius: BorderRadius.circular(PB.rFull),
            onTap: () => onSelect(active ? null : lead),
            child: Container(
              padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
              decoration: BoxDecoration(
                borderRadius: BorderRadius.circular(PB.rFull),
                border: Border.all(
                  color: active
                      ? colors.accent.withValues(alpha: 0.45)
                      : PB.borderTertiary,
                ),
              ),
              child: Text(
                label,
                style: TextStyle(
                  fontSize: PB.fsXs,
                  fontWeight: active ? FontWeight.w600 : FontWeight.w500,
                  color: active ? colors.link : PB.textTertiary,
                ),
              ),
            ),
          ),
        ),
      );
    }

    return SizedBox(
      height: 38,
      child: ListView(
        scrollDirection: Axis.horizontal,
        padding: const EdgeInsets.fromLTRB(10, 4, 10, 6),
        children: [
          pill(null, s.t('kanban.allMembers')),
          for (final lead in leads) pill(lead, lead),
        ],
      ),
    );
  }
}

class _Column extends StatelessWidget {
  const _Column({
    required this.column,
    required this.cards,
    required this.showLegacy,
    required this.onToggleLegacy,
    required this.onOpen,
  });

  final KanbanColumn column;
  final List<KanbanCard> cards;
  final bool showLegacy;
  final VoidCallback onToggleLegacy;
  final void Function(KanbanCard card) onOpen;

  @override
  Widget build(BuildContext context) {
    final s = L10n.s(context);
    // 「已完成」列里的旧对话片段默认折叠：否则 36 条"收到。先看基线…"
    // 会把真正有交付物的记录挤到看不见的地方。
    final legacy = column == KanbanColumn.done
        ? cards.where((c) => c.legacyLike).toList()
        : const <KanbanCard>[];
    final visible = column == KanbanColumn.done
        ? cards.where((c) => !c.legacyLike).toList()
        : cards;

    return Container(
      key: ValueKey('kanban-column-${column.name}'),
      margin: const EdgeInsets.fromLTRB(4, 0, 4, 6),
      padding: const EdgeInsets.fromLTRB(8, 8, 8, 8),
      decoration: BoxDecoration(
        color: PB.bgBubble,
        borderRadius: BorderRadius.circular(PB.rXl),
        border: Border.all(color: PB.borderSecondary),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Row(
            children: [
              Container(
                width: 7,
                height: 7,
                decoration: BoxDecoration(
                  color: _columnColor(context, column),
                  shape: BoxShape.circle,
                ),
              ),
              const SizedBox(width: 7),
              Expanded(
                child: Text(
                  _columnLabel(s, column),
                  style: TextStyle(
                    fontSize: PB.fsSm,
                    fontWeight: FontWeight.w600,
                    color: PB.textPrimary,
                  ),
                ),
              ),
              Text(
                '${cards.length}',
                style: TextStyle(fontSize: PB.fsXs, color: PB.textQuaternary),
              ),
            ],
          ),
          const SizedBox(height: 8),
          Expanded(
            child: visible.isEmpty && legacy.isEmpty
                ? Center(
                    child: Text(
                      s.t('kanban.empty'),
                      style: TextStyle(
                        fontSize: PB.fsXs,
                        color: PB.textQuaternary,
                      ),
                    ),
                  )
                : ListView(
                    padding: EdgeInsets.zero,
                    children: [
                      for (final card in visible)
                        _CardTile(card: card, onOpen: () => onOpen(card)),
                      if (legacy.isNotEmpty) ...[
                        Padding(
                          padding: const EdgeInsets.only(top: 6, bottom: 4),
                          child: InkWell(
                            borderRadius: BorderRadius.circular(PB.rLg),
                            onTap: onToggleLegacy,
                            child: Padding(
                              padding: const EdgeInsets.symmetric(
                                horizontal: 6,
                                vertical: 4,
                              ),
                              child: Row(
                                children: [
                                  Icon(
                                    showLegacy
                                        ? LucideIcons.chevronDown
                                        : LucideIcons.chevronRight,
                                    size: 13,
                                    color: PB.textQuaternary,
                                  ),
                                  const SizedBox(width: 4),
                                  Text(
                                    s.tf('kanban.legacy', {'n': legacy.length}),
                                    style: TextStyle(
                                      fontSize: PB.fsXxs,
                                      color: PB.textQuaternary,
                                    ),
                                  ),
                                ],
                              ),
                            ),
                          ),
                        ),
                        if (showLegacy)
                          for (final card in legacy)
                            _CardTile(card: card, onOpen: () => onOpen(card)),
                      ],
                    ],
                  ),
          ),
        ],
      ),
    );
  }
}

/// 卡片：主体复用 `TaskRunCard`（状态色、图标、点击详情都在那边），
/// 这里只补「负责人」与「暂停」两个看板特有的信息。
class _CardTile extends StatelessWidget {
  const _CardTile({required this.card, required this.onOpen});

  final KanbanCard card;
  final VoidCallback onOpen;

  @override
  Widget build(BuildContext context) {
    final s = L10n.s(context);
    final lead = card.leadName.isEmpty
        ? s.t('kanban.unassigned')
        : card.leadName;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        TaskRunCard(task: card.run, compact: true, onOpen: onOpen),
        Padding(
          padding: const EdgeInsets.only(left: 6, right: 6, bottom: 8),
          child: Row(
            children: [
              Icon(
                card.paused ? LucideIcons.pause : LucideIcons.userRound,
                size: 11,
                color: PB.textQuaternary,
              ),
              const SizedBox(width: 4),
              Expanded(
                child: Text(
                  lead,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(
                    fontSize: PB.fsXxs,
                    color: PB.textQuaternary,
                  ),
                ),
              ),
              if (card.run.updatedAt > 0)
                Text(
                  _relativeTime(card.run.updatedAt),
                  style: TextStyle(
                    fontSize: PB.fsXxs,
                    color: PB.textQuaternary,
                  ),
                ),
            ],
          ),
        ),
      ],
    );
  }
}

String _relativeTime(int epochMs) {
  final diff = DateTime.now().millisecondsSinceEpoch - epochMs;
  if (diff < 60 * 1000) return '刚刚';
  if (diff < 60 * 60 * 1000) return '${diff ~/ (60 * 1000)} 分钟前';
  if (diff < 24 * 60 * 60 * 1000) return '${diff ~/ (60 * 60 * 1000)} 小时前';
  return '${diff ~/ (24 * 60 * 60 * 1000)} 天前';
}

String _columnLabel(AppStrings s, KanbanColumn column) => switch (column) {
  KanbanColumn.todo => s.t('kanban.todo'),
  KanbanColumn.doing => s.t('kanban.doing'),
  KanbanColumn.done => s.t('kanban.done'),
  KanbanColumn.needsYou => s.t('kanban.needsYou'),
};

Color _columnColor(BuildContext context, KanbanColumn column) =>
    switch (column) {
      KanbanColumn.todo => PB.textTertiary,
      KanbanColumn.doing => PB.colors(context).accent,
      KanbanColumn.done => PB.success,
      KanbanColumn.needsYou => PB.warn,
    };

/// 任务运行对象的最小只读集合（给测试和外部调用用的窄接口）。
List<TaskRun> kanbanRunsOf(AppState state) => state.taskRuns.tasks;
