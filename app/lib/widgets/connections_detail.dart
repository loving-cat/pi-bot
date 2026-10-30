import 'package:flutter/material.dart';

import '../connections_filters.dart';
import '../connections_models.dart';
import '../models.dart';
import '../theme.dart';

/// 连接验证证据、可用工具与 Bot 分配。
class ConnectionsDetail extends StatefulWidget {
  const ConnectionsDetail({
    super.key,
    required this.connection,
    required this.bots,
    required this.busy,
    required this.onVerify,
    required this.onEnabled,
    required this.onAssign,
    required this.onEdit,
    required this.onDelete,
    this.policy = 'ask',
    this.error,
  });
  final AppConnection connection;
  final List<Bot> bots;
  final bool busy;
  final Future<String?> Function() onVerify;
  final Future<String?> Function(bool) onEnabled;
  final Future<String?> Function(List<String>) onAssign;
  final VoidCallback onEdit;
  final VoidCallback onDelete;
  final String policy;
  final String? error;

  @override
  State<ConnectionsDetail> createState() => _ConnectionsDetailState();
}

class _ConnectionsDetailState extends State<ConnectionsDetail> {
  late Set<String> _selected = widget.connection.assignedBotIds.toSet();
  bool _dirty = false;
  String? _error;

  @override
  void didUpdateWidget(ConnectionsDetail oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (!_dirty) _selected = widget.connection.assignedBotIds.toSet();
  }

  Future<void> _run(
    Future<String?> Function() action, {
    bool assigning = false,
  }) async {
    setState(() => _error = null);
    final error = await action();
    if (!mounted) return;
    setState(() {
      _error = error;
      if (assigning && error == null) _dirty = false;
    });
  }

  @override
  Widget build(BuildContext context) {
    final item = widget.connection;
    final evidence = item.verification;
    return AlertDialog(
      title: Text(item.server.name, style: const TextStyle(fontSize: PB.fsXl)),
      content: SizedBox(
        width: 560,
        child: SingleChildScrollView(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            mainAxisSize: MainAxisSize.min,
            children: [
              if (item.server.description.isNotEmpty) ...[
                Text(
                  item.server.description,
                  style: const TextStyle(
                    color: PB.textSecondary,
                    fontSize: PB.fsBase,
                  ),
                ),
                const SizedBox(height: 12),
              ],
              Text(
                evidence.label,
                style: TextStyle(
                  color: evidence.displayState == 'ready'
                      ? PB.success
                      : PB.textSecondary,
                  fontWeight: FontWeight.w600,
                ),
              ),
              const SizedBox(height: 4),
              Text(
                connectionCheckedAt(evidence.checkedAt),
                style: const TextStyle(
                  fontSize: PB.fsSm,
                  color: PB.textTertiary,
                ),
              ),
              if (evidence.error.isNotEmpty)
                Padding(
                  padding: const EdgeInsets.only(top: 8),
                  child: Text(
                    evidence.error,
                    style: const TextStyle(color: PB.danger, fontSize: PB.fsSm),
                  ),
                ),
              const SizedBox(height: 12),
              Wrap(
                spacing: 8,
                runSpacing: 6,
                children: [
                  OutlinedButton(
                    onPressed: widget.busy ? null : () => _run(widget.onVerify),
                    child: Text(widget.busy ? '处理中…' : '重新验证'),
                  ),
                  TextButton(
                    onPressed: widget.busy ? null : widget.onEdit,
                    child: const Text('编辑配置'),
                  ),
                ],
              ),
              SwitchListTile(
                contentPadding: EdgeInsets.zero,
                title: const Text(
                  '允许 Bot 使用',
                  style: TextStyle(fontSize: PB.fsBase),
                ),
                subtitle: Text(
                  item.server.enabled ? '已启用' : '已停用',
                  style: const TextStyle(fontSize: PB.fsSm),
                ),
                value: item.server.enabled,
                onChanged: widget.busy
                    ? null
                    : (value) => _run(() => widget.onEnabled(value)),
              ),
              const Divider(height: 24),
              Text(
                '可用工具${evidence.toolCount == null ? '' : ' · ${evidence.toolCount}'}',
                style: const TextStyle(
                  fontWeight: FontWeight.w600,
                  fontSize: PB.fsBase,
                ),
              ),
              const SizedBox(height: 8),
              if (evidence.tools.isEmpty)
                Text(
                  switch (evidence.displayState) {
                    'ready' when evidence.toolCount == 0 =>
                      '服务响应正常，但没有提供可调用工具。',
                    'auth_required' => '认证未通过，请检查凭据后重新验证。',
                    'error' => '验证未通过，暂时无法确认可用工具。',
                    'stale' => '验证记录已过期，请重新验证后查看可用工具。',
                    'checking' => '正在确认可用工具…',
                    _ => '验证后会在这里展示工具。',
                  },
                  style: const TextStyle(
                    color: PB.textTertiary,
                    fontSize: PB.fsSm,
                  ),
                )
              else
                for (final tool in evidence.tools)
                  Padding(
                    padding: const EdgeInsets.only(bottom: 10),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          tool.title.isEmpty ? tool.name : tool.title,
                          style: const TextStyle(fontSize: PB.fsBase),
                        ),
                        if (tool.description.isNotEmpty)
                          Text(
                            tool.description,
                            maxLines: 3,
                            overflow: TextOverflow.ellipsis,
                            style: const TextStyle(
                              color: PB.textTertiary,
                              fontSize: PB.fsSm,
                              height: 1.4,
                            ),
                          ),
                      ],
                    ),
                  ),
              const Divider(height: 24),
              const Text(
                '分配给 Bot',
                style: TextStyle(
                  fontWeight: FontWeight.w600,
                  fontSize: PB.fsBase,
                ),
              ),
              const SizedBox(height: 6),
              Text(
                switch (widget.policy) {
                  'deny' => '当前为只读模式，外部工具不会执行。分配将在规则允许时生效。',
                  'ask' => '按部门规矩执行；需批准模式下，每次外部工具调用需确认。部门负责人通过成员完成操作。',
                  _ => '按部门规矩执行；部门负责人仍通过成员完成操作。',
                },
                style: const TextStyle(
                  fontSize: PB.fsSm,
                  color: PB.textTertiary,
                  height: 1.5,
                ),
              ),
              if (widget.bots.isEmpty)
                const Padding(
                  padding: EdgeInsets.symmetric(vertical: 12),
                  child: Text(
                    '还没有可分配的 Bot',
                    style: TextStyle(color: PB.textTertiary),
                  ),
                ),
              for (final bot in widget.bots)
                CheckboxListTile(
                  key: ValueKey('connection-bot-${bot.id}'),
                  contentPadding: EdgeInsets.zero,
                  dense: true,
                  controlAffinity: ListTileControlAffinity.leading,
                  title: Text(
                    bot.name,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                  ),
                  value: _selected.contains(bot.id),
                  onChanged: widget.busy
                      ? null
                      : (checked) => setState(() {
                          if (checked == true) {
                            _selected.add(bot.id);
                          } else {
                            _selected.remove(bot.id);
                          }
                          _dirty = true;
                        }),
                ),
              Align(
                alignment: Alignment.centerRight,
                child: FilledButton(
                  onPressed: widget.busy || !_dirty
                      ? null
                      : () => _run(
                          () => widget.onAssign(_selected.toList()),
                          assigning: true,
                        ),
                  child: const Text('保存分配'),
                ),
              ),
              if (_error != null || widget.error != null)
                Padding(
                  padding: const EdgeInsets.only(top: 12),
                  child: Text(
                    _error ?? widget.error!,
                    style: const TextStyle(color: PB.danger, fontSize: PB.fsSm),
                  ),
                ),
            ],
          ),
        ),
      ),
      actions: [
        TextButton(
          onPressed: widget.busy ? null : widget.onDelete,
          child: const Text('删除连接', style: TextStyle(color: PB.danger)),
        ),
        TextButton(
          onPressed: () => Navigator.pop(context),
          child: const Text('关闭'),
        ),
      ],
    );
  }
}
