import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../connections_draft.dart';
import '../l10n/l10n.dart';
import '../models.dart';
import '../theme.dart';

typedef SaveConnection = Future<String?> Function(Map<String, dynamic> patch);
typedef TestConnection = Future<Map<String, dynamic>> Function(
  Map<String, dynamic> patch,
);

Future<bool?> showConnectionEditor(
  BuildContext context, {
  McpServer? server,
  String initialType = 'http',
  required SaveConnection onSave,
  required TestConnection onTest,
}) => showDialog<bool>(
  context: context,
  barrierDismissible: false,
  builder: (_) => ConnectionsEditor(
    server: server,
    initialType: initialType,
    onSave: onSave,
    onTest: onTest,
  ),
);

/// 连接配置表单；仅提交用户本次输入的凭据值。
class ConnectionsEditor extends StatefulWidget {
  const ConnectionsEditor({
    super.key,
    this.server,
    this.initialType = 'http',
    required this.onSave,
    required this.onTest,
  });
  final McpServer? server;
  final String initialType;
  final SaveConnection onSave;
  final TestConnection onTest;

  @override
  State<ConnectionsEditor> createState() => _ConnectionsEditorState();
}

class _CredentialRow {
  final name = TextEditingController();
  final value = TextEditingController();
  void dispose() {
    name.dispose();
    value.dispose();
  }
}

class _ConnectionsEditorState extends State<ConnectionsEditor> {
  late final _name = TextEditingController(text: widget.server?.name ?? '');
  late final _description = TextEditingController(
    text: widget.server?.description ?? '',
  );
  late final _url = TextEditingController(text: widget.server?.url ?? '');
  late final _command = TextEditingController(
    text: widget.server?.command ?? '',
  );
  late final _args = TextEditingController(
    text: (widget.server?.args ?? []).join('\n'),
  );
  late final _cwd = TextEditingController(text: widget.server?.cwd ?? '');
  late String _type = widget.server?.type ?? widget.initialType;
  late bool _enabled = widget.server?.enabled ?? false;
  final _credentials = <_CredentialRow>[];
  bool _clearCredentials = false;
  bool _saving = false;
  bool _testing = false;
  String? _error;
  Map<String, dynamic>? _result;
  int _draftRevision = 0;

  bool get _busy => _saving || _testing;

  @override
  void dispose() {
    for (final c in [_name, _description, _url, _command, _args, _cwd]) {
      c.dispose();
    }
    for (final row in _credentials) {
      row.dispose();
    }
    super.dispose();
  }

  void _changed() {
    _draftRevision++;
    if (_result != null) setState(() => _result = null);
  }

  Map<String, dynamic> _payload() => connectionDraftPatch(
    id: widget.server?.id,
    name: _name.text,
    type: _type,
    description: _description.text,
    enabled: _enabled,
    url: _url.text,
    command: _command.text,
    args: _args.text,
    cwd: _cwd.text,
    credentials: _credentials.map((row) => (row.name.text, row.value.text)),
    clearCredentials: _clearCredentials,
  );

  Future<void> _run({required bool save}) async {
    if (_busy) return;
    Map<String, dynamic> patch;
    try {
      patch = _payload();
    } on FormatException catch (e) {
      setState(() => _error = e.message);
      return;
    }
    final revision = _draftRevision;
    setState(() {
      _error = null;
      _saving = save;
      _testing = !save;
    });
    try {
      if (save) {
        final error = await widget.onSave(patch);
        if (!mounted) return;
        if (error == null) {
          Navigator.pop(context, true);
          return;
        }
        setState(() => _error = error);
      } else {
        final result = await widget.onTest(patch);
        if (!mounted) return;
        if (revision == _draftRevision) setState(() => _result = result);
      }
    } catch (e) {
      if (mounted) setState(() => _error = '$e');
    } finally {
      if (mounted)
        setState(() {
          _saving = false;
          _testing = false;
        });
    }
  }

  Future<void> _changeType(String? type) async {
    if (type == null || type == _type || _busy) return;
    if (widget.server?.hasCredentials == true ||
        _credentials.any((r) => r.value.text.isNotEmpty)) {
      final strings = L10n.s(context);
      final confirmed = await showDialog<bool>(
        context: context,
        builder: (context) => AlertDialog(
          title: Text(strings.t('conn.changeTypeTitle')),
          content: Text(strings.t('conn.changeTypeBody')),
          actions: [
            TextButton(
              onPressed: () => Navigator.pop(context, false),
              child: Text(strings.t('common.cancel')),
            ),
            FilledButton(
              onPressed: () => Navigator.pop(context, true),
              child: Text(strings.t('conn.change')),
            ),
          ],
        ),
      );
      if (confirmed != true || !mounted) return;
    }
    setState(() {
      _type = type;
      _clearCredentials = widget.server?.hasCredentials == true;
      for (final row in _credentials) {
        row.dispose();
      }
      _credentials.clear();
      _result = null;
      _draftRevision++;
    });
  }

  /// 验证结果摘要：成功时带上工具数，零工具单独说明协议正常。
  String _resultText(AppStrings strings, Map<String, dynamic> result) {
    if (result['ok'] != true) {
      return '${result['error'] ?? strings.t('conn.testFailed')}';
    }
    final count = result['toolCount'] ?? 0;
    return count == 0
        ? strings.t('conn.testOkNoTools')
        : strings.tf('conn.testOk', {'n': count});
  }

  @override
  Widget build(BuildContext context) {
    final strings = L10n.s(context);
    final server = widget.server;
    final savedKeys = server == null
        ? ''
        : server.credentialKeys.join(strings.t('conn.listSeparator'));
    return AlertDialog(
      title: Text(
        server == null
            ? strings.t('conn.editorAddTitle')
            : strings.tf('conn.editorEditTitle', {'name': server.name}),
        style: const TextStyle(fontSize: PB.fsXl),
      ),
      content: SizedBox(
        width: 500,
        child: SingleChildScrollView(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            mainAxisSize: MainAxisSize.min,
            children: [
              _field(
                strings.t('conn.name'),
                _name,
                hint: 'my_tools',
                enabled: server == null,
              ),
              if (server != null)
                Padding(
                  padding: const EdgeInsets.only(top: 5),
                  child: Text(
                    strings.t('conn.nameHint'),
                    style: TextStyle(
                      fontSize: PB.fsXs,
                      color: PB.textTertiary,
                    ),
                  ),
                ),
              const SizedBox(height: 14),
              _field(
                strings.t('conn.description'),
                _description,
                hint: strings.t('conn.descriptionHint'),
              ),
              const SizedBox(height: 14),
              DropdownButtonFormField<String>(
                key: ValueKey(_type),
                initialValue: _type,
                decoration: InputDecoration(
                  labelText: strings.t('conn.type'),
                  isDense: true,
                ),
                items: [
                  DropdownMenuItem(
                    value: 'http',
                    child: Text(strings.t('conn.remoteService')),
                  ),
                  DropdownMenuItem(
                    value: 'stdio',
                    child: Text(strings.t('conn.localService')),
                  ),
                ],
                onChanged: _busy ? null : _changeType,
              ),
              const SizedBox(height: 14),
              if (_type == 'http')
                _field(
                  strings.t('conn.url'),
                  _url,
                  hint: 'https://example.com/mcp',
                )
              else ...[
                _field(strings.t('conn.command'), _command, hint: 'node'),
                const SizedBox(height: 14),
                _field(
                  strings.t('conn.args'),
                  _args,
                  hint: 'tool-server.mjs',
                  maxLines: 3,
                ),
                const SizedBox(height: 14),
                _field(strings.t('conn.cwd'), _cwd),
              ],
              const SizedBox(height: 18),
              Text(
                strings.t(_type == 'http' ? 'conn.headers' : 'conn.env'),
                style: const TextStyle(
                  fontWeight: FontWeight.w600,
                  fontSize: PB.fsBase,
                ),
              ),
              const SizedBox(height: 6),
              Text(
                server?.hasCredentials == true
                    ? strings.tf('conn.credentialsSaved', {'keys': savedKeys})
                    : strings.t('conn.credentialsHint'),
                style: TextStyle(
                  fontSize: PB.fsSm,
                  color: PB.textTertiary,
                  height: 1.5,
                ),
              ),
              if (server?.hasCredentials == true)
                CheckboxListTile(
                  contentPadding: EdgeInsets.zero,
                  dense: true,
                  controlAffinity: ListTileControlAffinity.leading,
                  value: _clearCredentials,
                  onChanged: _busy
                      ? null
                      : (value) => setState(() {
                          _clearCredentials = value == true;
                          _changed();
                        }),
                  title: Text(
                    strings.t('conn.clearCredentials'),
                    style: const TextStyle(fontSize: PB.fsSm),
                  ),
                ),
              for (final row in _credentials)
                Padding(
                  key: ObjectKey(row),
                  padding: const EdgeInsets.only(top: 10),
                  child: Row(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Expanded(
                        flex: 2,
                        child: _field(
                          strings.t('conn.credentialName'),
                          row.name,
                        ),
                      ),
                      const SizedBox(width: 8),
                      Expanded(
                        flex: 3,
                        child: _field(
                          strings.t('conn.credentialValue'),
                          row.value,
                          obscure: true,
                        ),
                      ),
                      IconButton(
                        tooltip: strings.t('conn.removeCredential'),
                        onPressed: _busy
                            ? null
                            : () => setState(() {
                                _credentials.remove(row);
                                row.dispose();
                                _changed();
                              }),
                        icon: const Icon(LucideIcons.x, size: 18),
                      ),
                    ],
                  ),
                ),
              TextButton(
                onPressed: _busy || _credentials.length >= 30
                    ? null
                    : () => setState(() => _credentials.add(_CredentialRow())),
                child: Text(strings.t('conn.addCredential')),
              ),
              const SizedBox(height: 6),
              SwitchListTile(
                contentPadding: EdgeInsets.zero,
                title: Text(
                  strings.t('conn.allowBots'),
                  style: const TextStyle(fontSize: PB.fsBase),
                ),
                subtitle: Text(
                  strings.t('conn.allowBotsHint'),
                  style: TextStyle(
                    fontSize: PB.fsSm,
                    color: PB.textTertiary,
                  ),
                ),
                value: _enabled,
                onChanged: _busy
                    ? null
                    : (value) => setState(() {
                        _enabled = value;
                        _changed();
                      }),
              ),
              if (_result != null)
                Padding(
                  padding: const EdgeInsets.only(top: 12),
                  child: Text(
                    _resultText(strings, _result!),
                    style: TextStyle(
                      fontSize: PB.fsSm,
                      color: _result!['ok'] == true ? PB.success : PB.danger,
                    ),
                  ),
                ),
              if (_error != null)
                Padding(
                  padding: const EdgeInsets.only(top: 12),
                  child: Text(
                    _error!,
                    style: const TextStyle(color: PB.danger, fontSize: PB.fsSm),
                  ),
                ),
            ],
          ),
        ),
      ),
      actions: [
        TextButton(
          onPressed: _busy ? null : () => _run(save: false),
          child: Text(
            _testing
                ? strings.t('conn.verifying')
                : strings.t('conn.testConnection'),
          ),
        ),
        TextButton(
          onPressed: _saving ? null : () => Navigator.pop(context, false),
          child: Text(strings.t('common.cancel')),
        ),
        FilledButton(
          onPressed: _busy ? null : () => _run(save: true),
          child: Text(
            _saving ? strings.t('common.saving') : strings.t('common.save'),
          ),
        ),
      ],
    );
  }

  Widget _field(
    String label,
    TextEditingController controller, {
    String? hint,
    int maxLines = 1,
    bool enabled = true,
    bool obscure = false,
  }) => TextField(
    controller: controller,
    enabled: enabled && !_busy,
    maxLines: maxLines,
    obscureText: obscure,
    autocorrect: !obscure,
    enableSuggestions: !obscure,
    onChanged: (_) => _changed(),
    decoration: InputDecoration(
      labelText: label,
      hintText: hint,
      isDense: true,
      alignLabelWithHint: maxLines > 1,
    ),
  );
}
