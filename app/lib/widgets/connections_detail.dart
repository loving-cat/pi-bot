import 'package:flutter/material.dart';

import '../connections_models.dart';
import '../l10n/l10n.dart';
import '../models.dart';
import '../theme.dart';

/// 验证状态的文案 key；未知状态按「尚未验证」处理。
String _statusKey(String state) => switch (state) {
  'checking' => 'conn.status.checking',
  'ready' => 'conn.status.ready',
  'auth_required' => 'conn.status.authRequired',
  'error' => 'conn.status.error',
  'stale' => 'conn.status.stale',
  _ => 'conn.status.unverified',
};

/// 验证时间标签：无记录时给出提示，有记录时按「月/日 时:分」显示。
String _checkedAtLabel(AppStrings strings, int? value) {
  if (value == null || value <= 0) return strings.t('conn.neverChecked');
  final dt = DateTime.fromMillisecondsSinceEpoch(value);
  String two(int n) => n.toString().padLeft(2, '0');
  return strings.tf('conn.checkedAt', {
    'time': '${dt.month}/${dt.day} ${two(dt.hour)}:${two(dt.minute)}',
  });
}

/// 验证通过但没有工具时的说明；其余状态沿用通用状态文案。
String _statusLabel(AppStrings strings, ConnectionVerification evidence) {
  final state = evidence.displayState;
  if (state == 'ready' && evidence.toolCount == 0) {
    return strings.t('conn.status.readyNoTools');
  }
  return strings.t(_statusKey(state));
}

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

  /// 工具区在明细为空时的提示：先按验证状态给原因，再退回通用说明。
  String _toolsEmptyHint(AppStrings strings, ConnectionVerification evidence) =>
      switch (evidence.displayState) {
        'ready' when evidence.toolCount == 0 => strings.t(
          'conn.toolsReadyEmpty',
        ),
        'auth_required' => strings.t('conn.toolsAuthRequired'),
        'error' => strings.t('conn.toolsError'),
        'stale' => strings.t('conn.toolsStale'),
        'checking' => strings.t('conn.toolsChecking'),
        _ => strings.t('conn.toolsUnverified'),
      };

  /// 分配区上方的执行规则说明，按当前危险操作策略选文案。
  String _policyHint(AppStrings strings) => switch (widget.policy) {
    'deny' => strings.t('conn.policyDeny'),
    'ask' => strings.t('conn.policyAsk'),
    _ => strings.t('conn.policyDefault'),
  };

  @override
  Widget build(BuildContext context) {
    final strings = L10n.s(context);
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
                  style: TextStyle(
                    color: PB.textSecondary,
                    fontSize: PB.fsBase,
                  ),
                ),
                const SizedBox(height: 12),
              ],
              Text(
                _statusLabel(strings, evidence),
                style: TextStyle(
                  color: evidence.displayState == 'ready'
                      ? PB.success
                      : PB.textSecondary,
                  fontWeight: FontWeight.w600,
                ),
              ),
              const SizedBox(height: 4),
              Text(
                _checkedAtLabel(strings, evidence.checkedAt),
                style: TextStyle(
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
                    child: Text(
                      widget.busy
                          ? strings.t('conn.processing')
                          : strings.t('conn.reverify'),
                    ),
                  ),
                  TextButton(
                    onPressed: widget.busy ? null : widget.onEdit,
                    child: Text(strings.t('conn.editConfig')),
                  ),
                ],
              ),
              SwitchListTile(
                contentPadding: EdgeInsets.zero,
                title: Text(
                  strings.t('conn.allowBots'),
                  style: const TextStyle(fontSize: PB.fsBase),
                ),
                subtitle: Text(
                  strings.t(
                    item.server.enabled ? 'conn.enabled' : 'conn.disabled',
                  ),
                  style: const TextStyle(fontSize: PB.fsSm),
                ),
                value: item.server.enabled,
                onChanged: widget.busy
                    ? null
                    : (value) => _run(() => widget.onEnabled(value)),
              ),
              const Divider(height: 24),
              Text(
                evidence.toolCount == null
                    ? strings.t('conn.tools')
                    : strings.tf('conn.toolsCount', {'n': evidence.toolCount}),
                style: const TextStyle(
                  fontWeight: FontWeight.w600,
                  fontSize: PB.fsBase,
                ),
              ),
              const SizedBox(height: 8),
              if (evidence.tools.isEmpty)
                Text(
                  _toolsEmptyHint(strings, evidence),
                  style: TextStyle(
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
                            style: TextStyle(
                              color: PB.textTertiary,
                              fontSize: PB.fsSm,
                              height: 1.4,
                            ),
                          ),
                      ],
                    ),
                  ),
              const Divider(height: 24),
              Text(
                strings.t('conn.assignTitle'),
                style: const TextStyle(
                  fontWeight: FontWeight.w600,
                  fontSize: PB.fsBase,
                ),
              ),
              const SizedBox(height: 6),
              Text(
                _policyHint(strings),
                style: TextStyle(
                  fontSize: PB.fsSm,
                  color: PB.textTertiary,
                  height: 1.5,
                ),
              ),
              if (widget.bots.isEmpty)
                Padding(
                  padding: const EdgeInsets.symmetric(vertical: 12),
                  child: Text(
                    strings.t('conn.noBots'),
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
                  child: Text(strings.t('conn.saveAssignment')),
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
          child: Text(
            strings.t('conn.delete'),
            style: const TextStyle(color: PB.danger),
          ),
        ),
        TextButton(
          onPressed: () => Navigator.pop(context),
          child: Text(strings.t('common.close')),
        ),
      ],
    );
  }
}
