import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../models.dart';
import '../scope.dart';
import '../theme.dart';
import 'local_capabilities_section.dart';

/// MCP 服务库面板（设置在「MCP」标签页里）。
///
/// 和技能库的区别要写在界面上，否则用户会以为它俩是一回事：
///   · 技能 = 一段做法喂进提示词，改错了只是回答变差
///   · MCP  = **真的去起子进程 / 连远端服务**，配错了会占端口吃内存
///
/// 所以这里的默认值是"不启用"：加进来先填好配置，确认没问题再打开开关。
/// 而且配了也不等于生效 —— 还要在 bot 的设置里选中它（两个门都过才连），
/// 这是为了避免几十个 bot 各自挂一份进程把机器拖死。
class McpSection extends StatefulWidget {
  const McpSection({super.key});

  @override
  State<McpSection> createState() => _McpSectionState();
}

class _McpSectionState extends State<McpSection> {
  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) {
      AppScope.of(context).loadMcpServers();
    });
  }

  @override
  Widget build(BuildContext context) {
    final state = AppScope.of(context);
    final servers = state.mcpServers;
    final enabled = servers.where((s) => s.enabled).length;

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        // 用户在 ~/.pi/agent/mcp.json 里配过的服务，一键导进来
        const LocalCapabilitiesSection(kind: 'mcp', title: 'MCP'),
        Row(
          children: [
            const Icon(LucideIcons.plug, size: 15, color: PB.textTertiary),
            const SizedBox(width: 8),
            const Text(
              'MCP 服务',
              style: TextStyle(
                fontSize: PB.fsSm,
                fontWeight: FontWeight.w600,
                color: PB.textSecondary,
              ),
            ),
            const SizedBox(width: 8),
            Text(
              servers.isEmpty
                  ? '还没配'
                  : '${servers.length} 个 · $enabled 个已启用',
              style: const TextStyle(fontSize: PB.fsXxs, color: PB.textQuaternary),
            ),
            const Spacer(),
            TextButton.icon(
              onPressed: () => _openEditor(context, null),
              icon: const Icon(LucideIcons.plus, size: 15),
              label: const Text('添加', style: TextStyle(fontSize: PB.fsXs)),
            ),
          ],
        ),
        const SizedBox(height: 4),
        const Text(
          'MCP 能给模型加能力（读文件、查数据库、调接口……）。\n'
          '注意：开启后会真的起子进程，别一次挂太多；而且还要在 bot 里选中才会生效。',
          style: TextStyle(
            fontSize: PB.fsXxs,
            color: PB.textQuaternary,
            height: 1.6,
          ),
        ),
        const SizedBox(height: 10),
        Container(
          width: double.infinity,
          padding: const EdgeInsets.all(14),
          decoration: BoxDecoration(
            color: PB.bgPane,
            borderRadius: BorderRadius.circular(PB.rXl),
            border: Border.all(color: PB.borderTertiary),
          ),
          child: servers.isEmpty
              ? const Text(
                  '还没配。\n常用的有 filesystem（读写本地文件）、'
                  'fetch（抓网页）、sqlite（查数据库）。',
                  style: TextStyle(
                    fontSize: PB.fsXs,
                    color: PB.textQuaternary,
                    height: 1.7,
                  ),
                )
              : Column(
                  children: [
                    for (var i = 0; i < servers.length; i++) ...[
                      if (i > 0) const Divider(height: 18),
                      _row(context, servers[i]),
                    ],
                  ],
                ),
        ),
      ],
    );
  }

  Widget _row(BuildContext context, McpServer server) {
    final state = AppScope.of(context);
    return Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        // 开关直接放行首：这是最常点的东西
        Tooltip(
          message: server.enabled ? '点击停用' : '点击启用（会真的去连）',
          child: InkWell(
            borderRadius: BorderRadius.circular(20),
            onTap: () async {
              await state.saveMcpServer({
                'id': server.id,
                'enabled': !server.enabled,
              });
            },
            child: Padding(
              padding: const EdgeInsets.all(4),
              child: Icon(
                server.enabled
                    ? LucideIcons.toggleRight
                    : LucideIcons.toggleLeft,
                size: 22,
                color: server.enabled ? PB.success : PB.textQuaternary,
              ),
            ),
          ),
        ),
        const SizedBox(width: 6),
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                children: [
                  Text(
                    server.name,
                    style: TextStyle(
                      fontSize: PB.fsSm,
                      fontWeight: FontWeight.w600,
                      color: server.enabled ? PB.textPrimary : PB.textTertiary,
                    ),
                  ),
                  const SizedBox(width: 6),
                  Container(
                    padding: const EdgeInsets.symmetric(horizontal: 5, vertical: 1),
                    decoration: BoxDecoration(
                      color: PB.bgHover,
                      borderRadius: BorderRadius.circular(4),
                    ),
                    child: Text(
                      server.isHttp ? 'HTTP' : '本地',
                      style: const TextStyle(
                        fontSize: 9,
                        color: PB.textQuaternary,
                      ),
                    ),
                  ),
                  if (!server.enabled) ...[
                    const SizedBox(width: 6),
                    const Text(
                      '未启用',
                      style: TextStyle(fontSize: 9, color: PB.textQuaternary),
                    ),
                  ],
                ],
              ),
              const SizedBox(height: 2),
              Text(
                server.target,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: const TextStyle(
                  fontSize: PB.fsXxs,
                  color: PB.textQuaternary,
                  fontFamily: PB.monoFamily,
                ),
              ),
              if (server.description.isNotEmpty) ...[
                const SizedBox(height: 3),
                Text(
                  server.description,
                  style: const TextStyle(
                    fontSize: PB.fsXxs,
                    color: PB.textTertiary,
                    height: 1.5,
                  ),
                ),
              ],
            ],
          ),
        ),
        TextButton(
          onPressed: () => _openEditor(context, server),
          child: const Text('编辑', style: TextStyle(fontSize: PB.fsXs)),
        ),
        TextButton(
          onPressed: () async {
            final ok = await showDialog<bool>(
              context: context,
              builder: (ctx) => AlertDialog(
                backgroundColor: PB.bgElevated,
                title: const Text('删除 MCP 服务？', style: TextStyle(fontSize: PB.fsLg)),
                content: Text(
                  '「${server.name}」会被删掉，选中它的 bot 也会跟着失去这个能力。',
                  style: const TextStyle(fontSize: PB.fsSm),
                ),
                actions: [
                  TextButton(
                    onPressed: () => Navigator.pop(ctx, false),
                    child: const Text('取消'),
                  ),
                  TextButton(
                    onPressed: () => Navigator.pop(ctx, true),
                    child: const Text('删除', style: TextStyle(color: PB.danger)),
                  ),
                ],
              ),
            );
            if (ok == true) await state.removeMcpServer(server.id);
          },
          child: const Text(
            '删除',
            style: TextStyle(fontSize: PB.fsXs, color: PB.danger),
          ),
        ),
      ],
    );
  }

  Future<void> _openEditor(BuildContext context, McpServer? server) async {
    await showDialog<void>(
      context: context,
      builder: (_) => _McpEditor(server: server),
    );
  }
}

/// 新增/编辑一个 MCP 服务。
class _McpEditor extends StatefulWidget {
  const _McpEditor({this.server});

  final McpServer? server;

  @override
  State<_McpEditor> createState() => _McpEditorState();
}

class _McpEditorState extends State<_McpEditor> {
  late final _name = TextEditingController(text: widget.server?.name ?? '');
  late final _description =
      TextEditingController(text: widget.server?.description ?? '');
  late final _command = TextEditingController(text: widget.server?.command ?? '');
  late final _args = TextEditingController(
    text: (widget.server?.args ?? const []).join('\n'),
  );
  late final _url = TextEditingController(text: widget.server?.url ?? '');
  late final _env = TextEditingController(
    text: (widget.server?.env ?? const {})
        .entries
        .map((e) => '${e.key}=${e.value}')
        .join('\n'),
  );
  late String _type = widget.server?.type ?? 'stdio';
  late bool _enabled = widget.server?.enabled ?? false;

  String? _error;
  bool _saving = false;
  bool _testing = false;
  Map<String, dynamic>? _test;

  @override
  void dispose() {
    _name.dispose();
    _description.dispose();
    _command.dispose();
    _args.dispose();
    _url.dispose();
    _env.dispose();
    super.dispose();
  }

  /// 把「KEY=VALUE」多行文本解析成 map
  Map<String, String> _parsePairs(String text) {
    final out = <String, String>{};
    for (final line in text.split('\n')) {
      final trimmed = line.trim();
      if (trimmed.isEmpty) continue;
      final i = trimmed.indexOf('=');
      if (i <= 0) continue;
      final key = trimmed.substring(0, i).trim();
      if (key.isEmpty) continue;
      out[key] = trimmed.substring(i + 1);
    }
    return out;
  }

  Map<String, dynamic> _payload() => {
    if (widget.server != null) 'id': widget.server!.id,
    'name': _name.text.trim(),
    'type': _type,
    'description': _description.text.trim(),
    'enabled': _enabled,
    if (_type == 'stdio') 'command': _command.text.trim(),
    if (_type == 'stdio')
      'args': _args.text
          .split('\n')
          .map((e) => e.trim())
          .where((e) => e.isNotEmpty)
          .toList(),
    if (_type == 'stdio' && _env.text.trim().isNotEmpty)
      'env': _parsePairs(_env.text),
    if (_type == 'http') 'url': _url.text.trim(),
    if (_type == 'http' && _env.text.trim().isNotEmpty)
      'headers': _parsePairs(_env.text),
  };

  Future<void> _runTest() async {
    setState(() {
      _testing = true;
      _test = null;
    });
    final r = await AppScope.read(context).testMcpServer(_payload());
    if (!mounted) return;
    setState(() {
      _testing = false;
      _test = r;
    });
  }

  Future<void> _save() async {
    setState(() {
      _saving = true;
      _error = null;
    });
    final err = await AppScope.read(context).saveMcpServer(_payload());
    if (!mounted) return;
    if (err != null) {
      setState(() {
        _saving = false;
        _error = err;
      });
      return;
    }
    Navigator.pop(context);
  }

  @override
  Widget build(BuildContext context) {
    final isNew = widget.server == null;
    return AlertDialog(
      backgroundColor: PB.bgElevated,
      title: Text(
        isNew ? '添加 MCP 服务' : '编辑 MCP 服务',
        style: const TextStyle(fontSize: PB.fsLg),
      ),
      content: SizedBox(
        width: 500,
        child: SingleChildScrollView(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            mainAxisSize: MainAxisSize.min,
            children: [
              _field(
                '名字',
                _name,
                'filesystem（只能用字母数字下划线短横线）',
              ),
              const SizedBox(height: 10),
              _field('说明（可选）', _description, '读写本地文件'),
              const SizedBox(height: 10),
              const Text(
                '类型',
                style: TextStyle(fontSize: PB.fsXs, color: PB.textTertiary),
              ),
              const SizedBox(height: 4),
              DropdownButtonFormField<String>(
                initialValue: _type,
                isDense: true,
                decoration: const InputDecoration(isDense: true),
                items: const [
                  DropdownMenuItem(value: 'stdio', child: Text('本地命令（stdio）')),
                  DropdownMenuItem(value: 'http', child: Text('远端服务（HTTP）')),
                ],
                onChanged: (v) => setState(() => _type = v ?? 'stdio'),
              ),
              const SizedBox(height: 10),
              if (_type == 'stdio') ...[
                _field('启动命令', _command, 'npx'),
                const SizedBox(height: 10),
                _field(
                  '参数（一行一个）',
                  _args,
                  '-y\n@modelcontextprotocol/server-filesystem\n/tmp',
                  maxLines: 4,
                ),
              ] else ...[
                _field('URL', _url, 'https://mcp.example.com/v1'),
              ],
              const SizedBox(height: 10),
              _field(
                _type == 'http' ? '请求头（KEY=VALUE，一行一个）' : '环境变量（KEY=VALUE，一行一个）',
                _env,
                _type == 'http'
                    ? 'Authorization=Bearer xxx'
                    : 'API_KEY=xxx',
                maxLines: 3,
              ),
              const SizedBox(height: 12),
              Row(
                children: [
                  Switch(
                    value: _enabled,
                    onChanged: (v) => setState(() => _enabled = v),
                  ),
                  const SizedBox(width: 6),
                  Expanded(
                    child: Text(
                      _enabled
                          ? '已启用：配好后会真的去连（还要在 bot 里选中）'
                          : '未启用：只保存配置，不会去连',
                      style: const TextStyle(
                        fontSize: PB.fsXxs,
                        color: PB.textQuaternary,
                        height: 1.5,
                      ),
                    ),
                  ),
                ],
              ),
              if (_test != null) ...[
                const SizedBox(height: 10),
                Container(
                  width: double.infinity,
                  padding: const EdgeInsets.all(10),
                  decoration: BoxDecoration(
                    color: PB.bgPane,
                    borderRadius: BorderRadius.circular(PB.rLg),
                    border: Border.all(
                      color: _test!['ok'] == true
                          ? PB.success.withValues(alpha: 0.35)
                          : PB.danger.withValues(alpha: 0.35),
                    ),
                  ),
                  child: Text(
                    _test!['ok'] == true
                        ? '通了（${_test!['ms']}ms）${_test!['detail'] is String && (_test!['detail'] as String).isNotEmpty ? ' · ${_test!['detail']}' : ''}'
                        : '${_test!['error'] ?? '连不上'}',
                    style: TextStyle(
                      fontSize: PB.fsXxs,
                      height: 1.5,
                      color: _test!['ok'] == true ? PB.success : PB.danger,
                    ),
                  ),
                ),
              ],
              if (_error != null) ...[
                const SizedBox(height: 10),
                Text(
                  _error!,
                  style: const TextStyle(fontSize: PB.fsXxs, color: PB.danger),
                ),
              ],
            ],
          ),
        ),
      ),
      actions: [
        TextButton(
          onPressed: _testing ? null : _runTest,
          child: Text(_testing ? '测试中…' : '测试连接'),
        ),
        TextButton(
          onPressed: () => Navigator.pop(context),
          child: const Text('取消'),
        ),
        FilledButton(
          onPressed: _saving ? null : _save,
          child: Text(_saving ? '保存中…' : '保存'),
        ),
      ],
    );
  }

  Widget _field(
    String label,
    TextEditingController controller,
    String hint, {
    int maxLines = 1,
  }) =>
      TextField(
        controller: controller,
        maxLines: maxLines,
        decoration: InputDecoration(
          labelText: label,
          hintText: hint,
          isDense: true,
          alignLabelWithHint: maxLines > 1,
        ),
      );
}
