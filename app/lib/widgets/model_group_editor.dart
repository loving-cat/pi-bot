import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../models.dart';
import '../model_group_capacity.dart';
import '../scope.dart';
import '../theme.dart';
import 'model_capacity_fields.dart';

/// 设置里的「模型组」区块。
///
/// OpenAI 兼容接口到处都是（中转站、自建、云厂商），用户不该为了加一个自己的模型
/// 去改 pi 的 models.json —— 那是全局的，格式还得现学。
/// 这里填 baseUrl + key + 一组 modelId 就行，**加完立刻能在模型选择器里选到**
/// （服务端用 registerProvider 热注册，不用重启）。
class ModelGroupsSection extends StatelessWidget {
  const ModelGroupsSection({super.key});

  @override
  Widget build(BuildContext context) {
    final state = AppScope.of(context);
    final groups = state.modelGroups;

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Row(
          children: [
            const Icon(LucideIcons.boxes, size: 15, color: PB.textTertiary),
            const SizedBox(width: 8),
            const Text(
              '模型组',
              style: TextStyle(
                fontSize: PB.fsSm,
                fontWeight: FontWeight.w600,
                color: PB.textSecondary,
              ),
            ),
            const Spacer(),
            TextButton.icon(
              onPressed: () => _openEditor(context),
              icon: const Icon(LucideIcons.plus, size: 15),
              label: const Text('添加', style: TextStyle(fontSize: PB.fsXs)),
            ),
          ],
        ),
        const SizedBox(height: 4),
        Container(
          width: double.infinity,
          padding: const EdgeInsets.all(14),
          decoration: BoxDecoration(
            color: PB.bgPane,
            borderRadius: BorderRadius.circular(PB.rXl),
            border: Border.all(color: PB.borderTertiary),
          ),
          child: groups.isEmpty
              ? const Text(
                  '还没配。\n填一个 baseUrl + key + 模型名，就能在给 bot 选模型时用上。',
                  style: TextStyle(
                    fontSize: PB.fsXs,
                    color: PB.textQuaternary,
                    height: 1.6,
                  ),
                )
              : Column(
                  children: [
                    for (var i = 0; i < groups.length; i++) ...[
                      if (i > 0) const Divider(height: 18),
                      _row(context, groups[i]),
                    ],
                  ],
                ),
        ),
      ],
    );
  }

  Widget _row(BuildContext context, ModelGroup g) {
    return Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Padding(
          padding: const EdgeInsets.only(top: 2),
          child: Icon(
            g.hasKey ? LucideIcons.keyRound : LucideIcons.circleAlert,
            size: 15,
            color: g.hasKey ? PB.textTertiary : PB.warn,
          ),
        ),
        const SizedBox(width: 10),
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                children: [
                  Flexible(
                    child: Text(
                      g.name,
                      style: const TextStyle(
                        fontSize: PB.fsSm,
                        color: PB.textPrimary,
                      ),
                    ),
                  ),
                  if (g.builtin) ...[
                    const SizedBox(width: 6),
                    Container(
                      padding: const EdgeInsets.symmetric(
                        horizontal: 6,
                        vertical: 1,
                      ),
                      decoration: BoxDecoration(
                        color: PB.success.withValues(alpha: 0.15),
                        borderRadius: BorderRadius.circular(PB.rFull),
                      ),
                      child: const Text(
                        '正在用',
                        style: TextStyle(fontSize: PB.fsXxs, color: PB.success),
                      ),
                    ),
                  ],
                ],
              ),
              const SizedBox(height: 2),
              Text(
                g.baseUrl,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: const TextStyle(
                  fontSize: PB.fsXxs,
                  color: PB.textQuaternary,
                ),
              ),
              const SizedBox(height: 3),
              Text(
                [
                  '${g.models.length} 个模型',
                  if (g.hasKey) 'key ${g.keyMasked}' else '没配 key',
                  if (!g.enabled) '已停用',
                ].join(' · '),
                style: const TextStyle(
                  fontSize: PB.fsXxs,
                  color: PB.textTertiary,
                ),
              ),
              ModelGroupModelSummary(
                group: g,
                onEdit: (model) => _openEditor(context, group: g, modelId: model.id),
              ),
            ],
          ),
        ),
        TextButton(
          onPressed: () => _openEditor(context, group: g),
          child: const Text('编辑', style: TextStyle(fontSize: PB.fsXs)),
        ),
        // 内置组（从本机配置带出来的）不给删 —— 删了等于把自己踢下线
        if (!g.builtin)
          TextButton(
            onPressed: () async {
              final app = AppScope.read(context);
              final ok = await showDialog<bool>(
                context: context,
                builder: (ctx) => AlertDialog(
                  backgroundColor: PB.bgElevated,
                  title: Text(
                    '删掉「${g.name}」？',
                    style: const TextStyle(fontSize: PB.fsLg),
                  ),
                  content: const Text(
                    '用它跑着的 bot 会退回默认模型。',
                    style: TextStyle(
                      fontSize: PB.fsSm,
                      color: PB.textSecondary,
                    ),
                  ),
                  actions: [
                    TextButton(
                      onPressed: () => Navigator.pop(ctx, false),
                      child: const Text('取消'),
                    ),
                    FilledButton(
                      style: FilledButton.styleFrom(backgroundColor: PB.danger),
                      onPressed: () => Navigator.pop(ctx, true),
                      child: const Text('删除'),
                    ),
                  ],
                ),
              );
              if (ok == true) await app.deleteModelGroup(g.id);
            },
            child: const Text(
              '删除',
              style: TextStyle(fontSize: PB.fsXs, color: PB.danger),
            ),
          ),
      ],
    );
  }

  Future<void> _openEditor(BuildContext context, {ModelGroup? group, String? modelId}) async {
    await showDialog<void>(
      context: context,
      builder: (ctx) => _Editor(group: group, modelId: modelId),
    );
  }
}

class _Editor extends StatefulWidget {
  const _Editor({this.group, this.modelId});

  final ModelGroup? group;
  final String? modelId;

  @override
  State<_Editor> createState() => _EditorState();
}

class _EditorState extends State<_Editor> {
  late final _name = TextEditingController(text: widget.group?.name ?? '');
  late final _baseUrl = TextEditingController(
    text: widget.group?.baseUrl ?? '',
  );
  final _key = TextEditingController();
  late List<ModelCardDraft> _modelRows = modelCardDrafts(widget.group?.models ?? []);
  int _nextRowId = 0;
  int? _focusedRowId;
  String _api = 'openai-completions';
  String? _error;
  bool _saving = false;

  /// 连通性测试的结果（null = 还没测过）
  Map<String, dynamic>? _test;
  bool _testing = false;

  @override
  void initState() {
    super.initState();
    _api = widget.group?.api ?? 'openai-completions';
    if (_modelRows.isEmpty) _modelRows = [const ModelCardDraft(rowId: 0)];
    _nextRowId = _modelRows.length;
    for (final row in _modelRows) {
      if (row.id == widget.modelId) _focusedRowId = row.rowId;
    }
  }

  @override
  void dispose() {
    _name.dispose();
    _baseUrl.dispose();
    _key.dispose();
    super.dispose();
  }

  Future<void> _runTest() async {
    setState(() {
      _testing = true;
      _test = null;
    });
    // 有 id 的话把 id 也带上：key 留空时服务端会拿存着的那份补全
    final r = await AppScope.read(context).testModelGroup({
      if (widget.group != null) 'id': widget.group!.id,
      'baseUrl': _baseUrl.text.trim(),
      if (_key.text.trim().isNotEmpty) 'apiKey': _key.text.trim(),
      'api': _api,
      'model': _modelRows
          .map((row) => row.id.trim())
          .firstWhere((l) => l.isNotEmpty, orElse: () => ''),
    });
    if (!mounted) return;
    setState(() {
      _testing = false;
      _test = r;
    });
  }

  Future<void> _save() async {
    final payload = buildModelCardModels(_modelRows);
    if (payload.error != null) {
      setState(() => _error = payload.error);
      return;
    }
    setState(() {
      _saving = true;
      _error = null;
    });
    final err = await AppScope.read(context).saveModelGroup({
      if (widget.group != null) 'id': widget.group!.id,
      'name': _name.text.trim(),
      'baseUrl': _baseUrl.text.trim(),
      'api': _api,
      // 留空 = 不改原来的 key（App 拿到的是打码后的，不能拿它覆盖真 key）
      if (_key.text.trim().isNotEmpty) 'apiKey': _key.text.trim(),
      'models': payload.models,
    });
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
    final isNew = widget.group == null;
    return AlertDialog(
      backgroundColor: PB.bgElevated,
      title: Text(
        isNew ? '添加模型组' : '编辑模型组',
        style: const TextStyle(fontSize: PB.fsLg),
      ),
      content: SizedBox(
        width: 460,
        child: SingleChildScrollView(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            mainAxisSize: MainAxisSize.min,
            children: [
              _field('名字', _name, '比如：我的中转站'),
              _field('baseUrl', _baseUrl, 'https://api.example.com/v1'),
              _field(
                isNew ? 'API key' : 'API key（留空 = 不改）',
                _key,
                isNew
                    ? 'sk-…'
                    : (widget.group!.hasKey ? widget.group!.keyMasked : 'sk-…'),
                obscure: true,
              ),
              const SizedBox(height: 6),
              const Text(
                '接口类型',
                style: TextStyle(fontSize: PB.fsXs, color: PB.textTertiary),
              ),
              const SizedBox(height: 4),
              DropdownButtonFormField<String>(
                initialValue: _api,
                dropdownColor: PB.bgElevated,
                style: const TextStyle(
                  fontSize: PB.fsSm,
                  color: PB.textPrimary,
                ),
                items: const [
                  DropdownMenuItem(
                    value: 'openai-completions',
                    child: Text('OpenAI 兼容（绝大多数都用这个）'),
                  ),
                  DropdownMenuItem(
                    value: 'openai-responses',
                    child: Text('OpenAI Responses'),
                  ),
                  DropdownMenuItem(
                    value: 'anthropic-messages',
                    child: Text('Anthropic Messages'),
                  ),
                ],
                onChanged: (v) => setState(() => _api = v ?? _api),
              ),
              const SizedBox(height: 10),
              ModelCardsEditor(
                rows: _modelRows,
                focusedRowId: _focusedRowId,
                enabled: !_saving,
                onChanged: (id, update) => setState(() {
                  _modelRows = [for (final old in _modelRows) old.rowId == id ? update(old) : old];
                }),
                onAdd: () => setState(() {
                  final row = ModelCardDraft(rowId: _nextRowId++);
                  _modelRows = [..._modelRows, row];
                  _focusedRowId = row.rowId;
                }),
                onRemove: (id) => setState(() {
                  _modelRows = _modelRows.where((row) => row.rowId != id).toList();
                }),
              ),
              const SizedBox(height: 6),
              Row(
                children: [
                  OutlinedButton.icon(
                    onPressed: _testing ? null : _runTest,
                    icon: _testing
                        ? const SizedBox(
                            width: 13,
                            height: 13,
                            child: CircularProgressIndicator(strokeWidth: 2),
                          )
                        : const Icon(LucideIcons.plugZap, size: 15),
                    label: Text(_testing ? '正在测…' : '测试连通性'),
                  ),
                  const SizedBox(width: 8),
                  const Expanded(
                    child: Text(
                      '先测一下再保存，省得配错了还得回来查',
                      style: TextStyle(
                        fontSize: PB.fsXxs,
                        color: PB.textQuaternary,
                      ),
                    ),
                  ),
                ],
              ),
              if (_test != null) ...[
                const SizedBox(height: 8),
                _testResult(_test!),
              ],
              if (_error != null) ...[
                const SizedBox(height: 10),
                Text(
                  _error!,
                  style: const TextStyle(fontSize: PB.fsXs, color: PB.danger),
                ),
              ],
            ],
          ),
        ),
      ),
      actions: [
        TextButton(
          onPressed: _saving ? null : () => Navigator.pop(context),
          child: const Text('取消'),
        ),
        FilledButton(
          onPressed: _saving ? null : _save,
          child: Text(_saving ? '保存中…' : '保存'),
        ),
      ],
    );
  }

  /// 测试结果 —— 成功/失败要给**不同的话**，不能让用户去猜该改哪儿
  Widget _testResult(Map<String, dynamic> r) {
    final ok = r['ok'] == true;
    final ms = r['ms'];
    final lines = <String>[
      if (ok)
        [
          '通了',
          if (ms != null) '${ms}ms',
          if (r['via'] != null) '经 ${r['via']}',
          if ((r['count'] as num?) != null && (r['count'] as num).toInt() > 0)
            '发现 ${r['count']} 个模型',
        ].join(' · ')
      else
        '${r['error'] ?? '没通'}',
      if (r['note'] != null) '${r['note']}',
    ];
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.all(10),
      decoration: BoxDecoration(
        color: (ok ? PB.success : PB.danger).withValues(alpha: 0.08),
        borderRadius: BorderRadius.circular(PB.rLg),
        border: Border.all(
          color: (ok ? PB.success : PB.danger).withValues(alpha: 0.35),
        ),
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Icon(
            ok ? LucideIcons.circleCheck : LucideIcons.circleAlert,
            size: 15,
            color: ok ? PB.success : PB.danger,
          ),
          const SizedBox(width: 8),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                for (final l in lines)
                  Text(
                    l,
                    style: TextStyle(
                      fontSize: PB.fsXs,
                      height: 1.5,
                      color: ok ? PB.textSecondary : PB.textPrimary,
                    ),
                  ),
              ],
            ),
          ),
        ],
      ),
    );
  }

  Widget _field(
    String label,
    TextEditingController c,
    String hint, {
    int lines = 1,
    bool obscure = false,
  }) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 10),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            label,
            style: const TextStyle(fontSize: PB.fsXs, color: PB.textTertiary),
          ),
          const SizedBox(height: 4),
          TextField(
            controller: c,
            maxLines: lines,
            obscureText: obscure,
            style: const TextStyle(fontSize: PB.fsSm),
            decoration: InputDecoration(
              hintText: hint,
              hintStyle: const TextStyle(
                fontSize: PB.fsSm,
                color: PB.textQuaternary,
              ),
              isDense: true,
              contentPadding: const EdgeInsets.symmetric(
                horizontal: 10,
                vertical: 10,
              ),
              border: OutlineInputBorder(
                borderRadius: BorderRadius.circular(PB.rLg),
                borderSide: const BorderSide(color: PB.borderSecondary),
              ),
            ),
          ),
        ],
      ),
    );
  }
}
