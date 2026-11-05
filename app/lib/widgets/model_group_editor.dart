import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../l10n/l10n.dart';
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
    final strings = L10n.s(context);
    final groups = state.modelGroups;

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Row(
          children: [
            Icon(LucideIcons.boxes, size: 15, color: PB.textTertiary),
            const SizedBox(width: 8),
            Text(
              strings.t('model.groupTitle'),
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
              label: Text(
                strings.t('common.add'),
                style: const TextStyle(fontSize: PB.fsXs),
              ),
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
              ? Text(
                  strings.t('model.groupEmpty'),
                  style: TextStyle(
                    fontSize: PB.fsXs,
                    color: PB.textQuaternary,
                    height: 1.6,
                  ),
                )
              : Column(
                  children: [
                    for (var i = 0; i < groups.length; i++) ...[
                      if (i > 0) Divider(height: 18, color: PB.borderTertiary),
                      _row(context, groups[i]),
                    ],
                  ],
                ),
        ),
      ],
    );
  }

  Widget _row(BuildContext context, ModelGroup g) {
    final strings = L10n.s(context);
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
                      style: TextStyle(
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
                      child: Text(
                        strings.t('model.inUse'),
                        style: const TextStyle(
                          fontSize: PB.fsXxs,
                          color: PB.success,
                        ),
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
                style: TextStyle(
                  fontSize: PB.fsXxs,
                  color: PB.textQuaternary,
                ),
              ),
              const SizedBox(height: 3),
              Text(
                [
                  strings.tf('model.count', {'n': g.models.length}),
                  if (g.hasKey)
                    strings.tf('model.keyMasked', {'key': g.keyMasked})
                  else
                    strings.t('model.noKey'),
                  if (!g.enabled) strings.t('model.groupDisabled'),
                ].join(' · '),
                style: TextStyle(
                  fontSize: PB.fsXxs,
                  color: PB.textTertiary,
                ),
              ),
              ModelGroupModelSummary(
                group: g,
                onEdit: (model) =>
                    _openEditor(context, group: g, modelId: model.id),
              ),
            ],
          ),
        ),
        TextButton(
          onPressed: () => _openEditor(context, group: g),
          child: Text(
            strings.t('common.edit'),
            style: const TextStyle(fontSize: PB.fsXs),
          ),
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
                    strings.tf('model.deleteTitle', {'name': g.name}),
                    style: const TextStyle(fontSize: PB.fsLg),
                  ),
                  content: Text(
                    strings.t('model.deleteBody'),
                    style: TextStyle(
                      fontSize: PB.fsSm,
                      color: PB.textSecondary,
                    ),
                  ),
                  actions: [
                    TextButton(
                      onPressed: () => Navigator.pop(ctx, false),
                      child: Text(strings.t('common.cancel')),
                    ),
                    FilledButton(
                      style: FilledButton.styleFrom(backgroundColor: PB.danger),
                      onPressed: () => Navigator.pop(ctx, true),
                      child: Text(strings.t('common.delete')),
                    ),
                  ],
                ),
              );
              if (ok == true) await app.deleteModelGroup(g.id);
            },
            child: Text(
              strings.t('common.delete'),
              style: const TextStyle(fontSize: PB.fsXs, color: PB.danger),
            ),
          ),
      ],
    );
  }

  Future<void> _openEditor(
    BuildContext context, {
    ModelGroup? group,
    String? modelId,
  }) => openModelGroupEditor(context, group: group, modelId: modelId);
}

/// 打开模型组编辑弹窗。设置页与首次配置引导共用同一个入口。
Future<void> openModelGroupEditor(
  BuildContext context, {
  ModelGroup? group,
  String? modelId,
}) async {
  await showDialog<void>(
    context: context,
    builder: (ctx) => _Editor(group: group, modelId: modelId),
  );
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
  late List<ModelCardDraft> _modelRows = modelCardDrafts(
    widget.group?.models ?? [],
  );
  int _nextRowId = 0;
  int? _focusedRowId;
  String _api = 'openai-completions';
  String? _error;
  bool _saving = false;

  /// 思考强度可选项（服务端下发，Windows 与 Mac 共用同一份）
  List<String> _thinkingFormats = const [];
  List<String> _thinkingLevels = const [];
  List<String> _thinkingUpstreamValues = const [];

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
    _loadThinkingOptions();
  }

  /// 思考强度的可选项从服务端取（Windows 与 Mac 共用同一套枚举）。
  /// 拿不到时界面会自动回退内置的七档，不会白屏。
  Future<void> _loadThinkingOptions() async {
    final options = await AppScope.read(context).loadThinkingOptions();
    if (!mounted) return;
    setState(() {
      _thinkingFormats = ((options['formats'] as List?) ?? const [])
          .map((e) => '$e')
          .toList();
      _thinkingLevels = ((options['levels'] as List?) ?? const [])
          .map((e) => '$e')
          .toList();
      _thinkingUpstreamValues =
          ((options['upstreamValues'] as List?) ?? const [])
              .map((e) => '$e')
              .toList();
    });
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

  /// 把服务端 /models 返回的模型一次性填进卡片。
  ///
  /// 合并规则（不改用户已经填过的内容）：
  ///   · 已在卡片里的模型：保留它原来的容量、显示名和思考设置，只补进列表；
  ///   · 新出现的模型：追加一张空容量卡片（容量交给服务端默认值）；
  ///   · 已存在但这次没返回的模型：**保留**，不删 —— 探测接口偶尔少返回几个，
  ///     不能因为一次探测就把用户配好的条目抹掉。
  void _autoFillModels(List<String> ids) {
    final existing = {for (final row in _modelRows) row.id.trim(): row};
    final next = <ModelCardDraft>[];
    for (final id in ids) {
      final row = existing.remove(id);
      next.add(row ?? ModelCardDraft(rowId: _nextRowId++, id: id));
    }
    // 剩下的：卡片里已有、但这次没探测到的，原样保留
    for (final row in _modelRows) {
      if (existing.containsKey(row.id.trim())) next.add(row);
    }
    setState(() {
      _modelRows = next;
      _error = null;
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
    final strings = L10n.s(context);
    final isNew = widget.group == null;
    return AlertDialog(
      backgroundColor: PB.bgElevated,
      title: Text(
        isNew ? strings.t('model.addGroup') : strings.t('model.editGroup'),
        style: const TextStyle(fontSize: PB.fsLg),
      ),
      content: SizedBox(
        width: 460,
        child: SingleChildScrollView(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            mainAxisSize: MainAxisSize.min,
            children: [
              _field(
                strings.t('model.fieldName'),
                _name,
                strings.t('model.fieldNameHint'),
              ),
              _field('baseUrl', _baseUrl, 'https://api.example.com/v1'),
              _field(
                isNew
                    ? strings.t('model.apiKey')
                    : strings.t('model.apiKeyUnchanged'),
                _key,
                isNew
                    ? 'sk-…'
                    : (widget.group!.hasKey ? widget.group!.keyMasked : 'sk-…'),
                obscure: true,
              ),
              const SizedBox(height: 6),
              Text(
                strings.t('model.apiType'),
                style: TextStyle(
                  fontSize: PB.fsXs,
                  color: PB.textTertiary,
                ),
              ),
              const SizedBox(height: 4),
              DropdownButtonFormField<String>(
                initialValue: _api,
                dropdownColor: PB.bgElevated,
                style: TextStyle(
                  fontSize: PB.fsSm,
                  color: PB.textPrimary,
                ),
                items: [
                  DropdownMenuItem(
                    value: 'openai-completions',
                    child: Text(strings.t('model.openaiCompatible')),
                  ),
                  const DropdownMenuItem(
                    value: 'openai-responses',
                    child: Text('OpenAI Responses'),
                  ),
                  const DropdownMenuItem(
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
                thinkingFormats: _thinkingFormats,
                thinkingLevels: _thinkingLevels,
                thinkingUpstreamValues: _thinkingUpstreamValues,
                onChanged: (id, update) => setState(() {
                  _modelRows = [
                    for (final old in _modelRows)
                      old.rowId == id ? update(old) : old,
                  ];
                }),
                onAdd: () => setState(() {
                  final row = ModelCardDraft(rowId: _nextRowId++);
                  _modelRows = [..._modelRows, row];
                  _focusedRowId = row.rowId;
                }),
                onRemove: (id) => setState(() {
                  _modelRows = _modelRows
                      .where((row) => row.rowId != id)
                      .toList();
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
                    label: Text(
                      _testing
                          ? strings.t('model.testing')
                          : strings.t('model.testConnection'),
                    ),
                  ),
                  const SizedBox(width: 8),
                  Expanded(
                    child: Text(
                      strings.t('model.testHint'),
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
              // 探测到模型列表后给一键填入：省掉用户一个个手打模型 ID
              if (_discoveredModels.isNotEmpty) ...[
                const SizedBox(height: 8),
                _autoFillRow(),
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
          child: Text(strings.t('common.cancel')),
        ),
        FilledButton(
          onPressed: _saving ? null : _save,
          child: Text(
            _saving ? strings.t('common.saving') : strings.t('common.save'),
          ),
        ),
      ],
    );
  }

  /// 服务端 /models 探测回来的模型列表（没有则为空）。
  List<String> get _discoveredModels {
    final raw = _test?['models'];
    if (raw is! List) return const [];
    return [
      for (final item in raw)
        if (item is String && item.trim().isNotEmpty) item.trim(),
    ];
  }

  /// 一键把探测到的模型填进卡片；全部已在卡片里时按钮变成「已填入」。
  Widget _autoFillRow() {
    final strings = L10n.s(context);
    final discovered = _discoveredModels;
    final existing = {for (final row in _modelRows) row.id.trim()};
    final missing = discovered.where((id) => !existing.contains(id)).toList();
    final done = missing.isEmpty;
    return SizedBox(
      width: double.infinity,
      child: OutlinedButton.icon(
        key: const ValueKey('model-autofill'),
        onPressed: done ? null : () => _autoFillModels(discovered),
        icon: Icon(done ? LucideIcons.check : LucideIcons.listPlus, size: 15),
        label: Text(
          '${strings.t(done ? 'model.autoFillDone' : 'model.autoFill')}'
          ' · ${strings.tf('model.count', {'n': discovered.length})}',
          style: const TextStyle(fontSize: PB.fsXs),
        ),
      ),
    );
  }

  /// 测试结果 —— 成功/失败要给**不同的话**，不能让用户去猜该改哪儿
  Widget _testResult(Map<String, dynamic> r) {
    final strings = L10n.s(context);
    final ok = r['ok'] == true;
    final ms = r['ms'];
    final lines = <String>[
      if (ok)
        [
          strings.t('model.connectionOk'),
          if (ms != null) '${ms}ms',
          if (r['via'] != null)
            strings.tf('model.connectionVia', {'via': '${r['via']}'}),
          if ((r['count'] as num?) != null && (r['count'] as num).toInt() > 0)
            strings.tf('model.foundCount', {'n': r['count']}),
        ].join(' · ')
      else
        '${r['error'] ?? strings.t('model.connectionFailed')}',
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
            style: TextStyle(fontSize: PB.fsXs, color: PB.textTertiary),
          ),
          const SizedBox(height: 4),
          TextField(
            controller: c,
            maxLines: lines,
            obscureText: obscure,
            style: const TextStyle(fontSize: PB.fsSm),
            decoration: InputDecoration(
              hintText: hint,
              hintStyle: TextStyle(
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
                borderSide: BorderSide(color: PB.borderSecondary),
              ),
            ),
          ),
        ],
      ),
    );
  }
}
