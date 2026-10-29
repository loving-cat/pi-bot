import 'package:flutter/material.dart';

import '../connections_draft.dart';
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
      final confirmed = await showDialog<bool>(
        context: context,
        builder: (context) => AlertDialog(
          title: const Text('更换连接方式？'),
          content: const Text('已填写和已保存的凭据会在保存时清除。请为新的连接方式重新填写。'),
          actions: [
            TextButton(
              onPressed: () => Navigator.pop(context, false),
              child: const Text('取消'),
            ),
            FilledButton(
              onPressed: () => Navigator.pop(context, true),
              child: const Text('更换'),
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

  @override
  Widget build(BuildContext context) {
    final server = widget.server;
    return AlertDialog(
      title: Text(
        server == null ? '添加应用连接' : '编辑 ${server.name}',
        style: const TextStyle(fontSize: PB.fsXl),
      ),
      content: SizedBox(
        width: 500,
        child: SingleChildScrollView(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            mainAxisSize: MainAxisSize.min,
            children: [
              _field('连接名称', _name, hint: 'my_tools', enabled: server == null),
              if (server != null)
                const Padding(
                  padding: EdgeInsets.only(top: 5),
                  child: Text(
                    '名称用于 Bot 分配，保存后保持不变。',
                    style: TextStyle(fontSize: PB.fsXs, color: PB.textTertiary),
                  ),
                ),
              const SizedBox(height: 14),
              _field('用途说明', _description, hint: '说明这个连接能做什么'),
              const SizedBox(height: 14),
              DropdownButtonFormField<String>(
                key: ValueKey(_type),
                initialValue: _type,
                decoration: const InputDecoration(
                  labelText: '连接方式',
                  isDense: true,
                ),
                items: const [
                  DropdownMenuItem(value: 'http', child: Text('远程工具服务')),
                  DropdownMenuItem(value: 'stdio', child: Text('本地工具服务')),
                ],
                onChanged: _busy ? null : _changeType,
              ),
              const SizedBox(height: 14),
              if (_type == 'http')
                _field('服务地址', _url, hint: 'https://example.com/mcp')
              else ...[
                _field('启动命令', _command, hint: 'node'),
                const SizedBox(height: 14),
                _field('参数（每行一项）', _args, hint: 'tool-server.mjs', maxLines: 3),
                const SizedBox(height: 14),
                _field('工作目录（可选）', _cwd),
              ],
              const SizedBox(height: 18),
              Text(
                _type == 'http' ? '请求头与密钥' : '环境变量与密钥',
                style: const TextStyle(
                  fontWeight: FontWeight.w600,
                  fontSize: PB.fsBase,
                ),
              ),
              const SizedBox(height: 6),
              Text(
                server?.hasCredentials == true
                    ? '已保存：${server!.credentialKeys.join('、')}。留空保留原值；填写同名项目会替换。'
                    : '按服务要求添加；无需认证时可留空。',
                style: const TextStyle(
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
                  title: const Text(
                    '保存时清除全部已存凭据',
                    style: TextStyle(fontSize: PB.fsSm),
                  ),
                ),
              for (final row in _credentials)
                Padding(
                  key: ObjectKey(row),
                  padding: const EdgeInsets.only(top: 10),
                  child: Row(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Expanded(flex: 2, child: _field('名称', row.name)),
                      const SizedBox(width: 8),
                      Expanded(
                        flex: 3,
                        child: _field('值', row.value, obscure: true),
                      ),
                      IconButton(
                        tooltip: '移除本次输入',
                        onPressed: _busy
                            ? null
                            : () => setState(() {
                                _credentials.remove(row);
                                row.dispose();
                                _changed();
                              }),
                        icon: const Icon(Icons.close, size: 18),
                      ),
                    ],
                  ),
                ),
              TextButton(
                onPressed: _busy || _credentials.length >= 30
                    ? null
                    : () => setState(() => _credentials.add(_CredentialRow())),
                child: const Text('添加凭据项'),
              ),
              const SizedBox(height: 6),
              SwitchListTile(
                contentPadding: EdgeInsets.zero,
                title: const Text(
                  '允许 Bot 使用',
                  style: TextStyle(fontSize: PB.fsBase),
                ),
                subtitle: const Text(
                  '启用后，还需分配给指定 Bot。',
                  style: TextStyle(fontSize: PB.fsSm, color: PB.textTertiary),
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
                    _result!['ok'] == true
                        ? '验证通过 · ${_result!['toolCount'] ?? 0} 个工具${_result!['toolCount'] == 0 ? '（协议正常，未发现工具）' : ''}'
                        : '${_result!['error'] ?? '验证失败'}',
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
          child: Text(_testing ? '验证中…' : '验证连接'),
        ),
        TextButton(
          onPressed: _saving ? null : () => Navigator.pop(context, false),
          child: const Text('取消'),
        ),
        FilledButton(
          onPressed: _busy ? null : () => _run(save: true),
          child: Text(_saving ? '保存中…' : '保存'),
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
