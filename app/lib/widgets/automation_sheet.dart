import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../app_state.dart';
import '../models.dart';
import '../theme.dart';

/// 定时任务面板：列出这个会话的定时任务，能加、能停、能立刻跑一次、能删。
///
/// 只做展示与回调（数据在 AppState），和任务板一样便于单测。
class AutomationSheet extends StatefulWidget {
  const AutomationSheet({
    super.key,
    required this.roomName,
    required this.items,
    required this.onCreate,
    required this.onToggle,
    required this.onRunNow,
    required this.onDelete,
  });

  final String roomName;
  final List<Automation> items;
  final void Function(String title, String prompt, {int? everyMinutes, String? dailyAt})
  onCreate;
  final ValueChanged<Automation> onToggle;
  final ValueChanged<Automation> onRunNow;
  final ValueChanged<Automation> onDelete;

  @override
  State<AutomationSheet> createState() => _AutomationSheetState();
}

class _AutomationSheetState extends State<AutomationSheet> {
  final _title = TextEditingController();
  final _prompt = TextEditingController();
  final _interval = TextEditingController(text: '30');
  bool _daily = false;
  TimeOfDay _time = const TimeOfDay(hour: 9, minute: 30);

  @override
  void dispose() {
    _title.dispose();
    _prompt.dispose();
    _interval.dispose();
    super.dispose();
  }

  void _add() {
    final title = _title.text.trim();
    final prompt = _prompt.text.trim();
    if (title.isEmpty || prompt.isEmpty) return;
    if (_daily) {
      final hh = _time.hour.toString().padLeft(2, '0');
      final mm = _time.minute.toString().padLeft(2, '0');
      widget.onCreate(title, prompt, dailyAt: '$hh:$mm');
    } else {
      final every = int.tryParse(_interval.text.trim()) ?? 30;
      widget.onCreate(title, prompt, everyMinutes: every < 5 ? 5 : every);
    }
    _title.clear();
    _prompt.clear();
    setState(() {});
  }

  @override
  Widget build(BuildContext context) {
    return SafeArea(
      child: Padding(
        padding: const EdgeInsets.fromLTRB(20, 14, 20, 18),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                const Icon(LucideIcons.clock, size: 16, color: PB.textSecondary),
                const SizedBox(width: 8),
                Text(
                  '定时任务 · ${widget.roomName}',
                  style: const TextStyle(
                    fontSize: PB.fsLg,
                    fontWeight: FontWeight.w600,
                    color: PB.textPrimary,
                  ),
                ),
                const Spacer(),
                Text(
                  '${widget.items.where((a) => a.enabled).length} 个在跑',
                  style: const TextStyle(fontSize: PB.fsXs, color: PB.textQuaternary),
                ),
              ],
            ),
            const SizedBox(height: 10),
            _field(_title, '任务名（例如 盘前简报）'),
            const SizedBox(height: 8),
            _field(_prompt, '到点要它做什么（发给它的话）', maxLines: 2),
            const SizedBox(height: 8),
            Row(
              children: [
                SegmentedButton<bool>(
                  segments: const [
                    ButtonSegment(value: false, label: Text('每隔')),
                    ButtonSegment(value: true, label: Text('每天')),
                  ],
                  selected: {_daily},
                  onSelectionChanged: (v) => setState(() => _daily = v.first),
                ),
                const SizedBox(width: 10),
                if (!_daily)
                  SizedBox(
                    width: 90,
                    child: _field(_interval, '分钟'),
                  )
                else
                  TextButton.icon(
                    onPressed: () async {
                      final picked = await showTimePicker(
                        context: context,
                        initialTime: _time,
                      );
                      if (picked != null) setState(() => _time = picked);
                    },
                    icon: const Icon(LucideIcons.clock, size: 15),
                    label: Text(
                      '${_time.hour.toString().padLeft(2, '0')}:'
                      '${_time.minute.toString().padLeft(2, '0')}',
                    ),
                  ),
                const Spacer(),
                FilledButton(onPressed: _add, child: const Text('添加')),
              ],
            ),
            const SizedBox(height: 12),
            Flexible(
              child: SingleChildScrollView(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    if (widget.items.isEmpty)
                      const Padding(
                        padding: EdgeInsets.symmetric(vertical: 14),
                        child: Text(
                          '还没有定时任务。适合：盘前简报、每天巡检、每小时看一次进度。',
                          style: TextStyle(fontSize: PB.fsXs, color: PB.textQuaternary),
                        ),
                      ),
                    for (final a in widget.items) _row(a),
                  ],
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _row(Automation a) {
    final next = a.nextRunAt > 0
        ? DateTime.fromMillisecondsSinceEpoch(a.nextRunAt)
        : null;
    final nextLabel = next == null
        ? ''
        : ' · 下次 ${next.month}/${next.day} '
              '${next.hour.toString().padLeft(2, '0')}:${next.minute.toString().padLeft(2, '0')}';
    return Padding(
      padding: const EdgeInsets.only(bottom: 4),
      child: Row(
        children: [
          Icon(
            a.enabled ? LucideIcons.clock : LucideIcons.clock3,
            size: 15,
            color: a.enabled ? PB.accent : PB.textQuaternary,
          ),
          const SizedBox(width: 8),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  a.title,
                  style: TextStyle(
                    fontSize: PB.fsSm,
                    color: a.enabled ? PB.textPrimary : PB.textTertiary,
                  ),
                ),
                Text(
                  '${a.scheduleLabel}$nextLabel',
                  style: const TextStyle(fontSize: PB.fsXxs, color: PB.textQuaternary),
                ),
              ],
            ),
          ),
          IconButton(
            visualDensity: VisualDensity.compact,
            tooltip: '立刻跑一次',
            onPressed: () => widget.onRunNow(a),
            icon: const Icon(LucideIcons.play, size: 14),
          ),
          IconButton(
            visualDensity: VisualDensity.compact,
            tooltip: a.enabled ? '暂停' : '启用',
            onPressed: () => widget.onToggle(a),
            icon: Icon(
              a.enabled ? LucideIcons.pause : LucideIcons.play,
              size: 14,
            ),
          ),
          IconButton(
            visualDensity: VisualDensity.compact,
            tooltip: '删除',
            onPressed: () => widget.onDelete(a),
            icon: const Icon(LucideIcons.trash2, size: 14),
          ),
        ],
      ),
    );
  }

  Widget _field(TextEditingController c, String hint, {int maxLines = 1}) => TextField(
    controller: c,
    maxLines: maxLines,
    style: const TextStyle(fontSize: PB.fsSm),
    decoration: InputDecoration(
      hintText: hint,
      hintStyle: const TextStyle(fontSize: PB.fsXs, color: PB.textQuaternary),
      isDense: true,
      filled: true,
      fillColor: PB.bgApp,
      contentPadding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
      border: OutlineInputBorder(
        borderRadius: BorderRadius.circular(PB.rLg),
        borderSide: BorderSide(color: PB.borderTertiary),
      ),
    ),
  );
}

/// 打开某个房间的定时任务面板
Future<void> showAutomationSheet(
  BuildContext context,
  AppState state,
  Room room,
) async {
  await state.refreshAutomations();
  if (!context.mounted) return;
  await showModalBottomSheet<void>(
    context: context,
    backgroundColor: PB.bgPane,
    isScrollControlled: true,
    constraints: const BoxConstraints(maxWidth: 560),
    builder: (_) => AutomationSheet(
      roomName: room.name,
      items: state.automationsFor(room.id),
      onCreate: (title, prompt, {everyMinutes, dailyAt}) => state.createAutomation(
        roomId: room.id,
        title: title,
        prompt: prompt,
        everyMinutes: everyMinutes,
        dailyAt: dailyAt,
      ),
      onToggle: (a) => state.updateAutomation(a.id, {'enabled': !a.enabled}),
      onRunNow: (a) => state.runAutomationNow(a.id),
      onDelete: (a) => state.deleteAutomation(a.id),
    ),
  );
}
