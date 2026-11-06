import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../decision_mode.dart';
import '../l10n/l10n.dart';
import '../scope.dart';
import '../theme.dart';
import 'toast.dart';

/// 设置里的「快速决策」区块。
///
/// ## 两种接入方式
///
///   TypeSafe 官方 —— 地址和模型名都是固定的，用户只需要填 key。
///   自定义       —— 任何兼容 /v1/systemone 的服务，地址和模型名都得自己填。
///
/// 为什么分两种而不是让用户全填：
///   绝大多数人用官方，让他填地址和模型名纯属负担，
///   而且填错（比如把 /v1 也贴进去）只会得到一堆 404。
///
/// ## 自定义模式下测一下的作用
///
/// 用户不知道自己的服务支持哪些模型名。填完地址和 key 点一下，
/// 我们从 /v1/models 拉回来列给他选 —— 手打模型名太容易错了。
class DecisionSection extends StatefulWidget {
  const DecisionSection({super.key});

  @override
  State<DecisionSection> createState() => _DecisionSectionState();
}

class _DecisionSectionState extends State<DecisionSection> {
  final _url = TextEditingController();
  final _model = TextEditingController();
  final _key = TextEditingController();
  bool _dirty = false;
  bool _saving = false;
  bool _probing = false;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) => _fill());
  }

  @override
  void dispose() {
    _url.dispose();
    _model.dispose();
    _key.dispose();
    super.dispose();
  }

  void _fill() {
    if (!mounted || _dirty) return;
    final d = AppScope.read(context).decision;
    _url.text = (d['baseUrl'] as String?) ?? '';
    _model.text = (d['model'] as String?) ?? '';
  }

  Map<String, dynamic> get _cfg => AppScope.read(context).decision;
  bool get _enabled => _cfg['enabled'] == true;
  bool get _hasKey => _cfg['hasApiKey'] == true;
  bool get _custom => isCustomDecisionMode(_cfg);

  Future<void> _patch(Map<String, dynamic> patch) async {
    setState(() => _saving = true);
    final state = AppScope.read(context);
    final saved = await state.saveDecision(patch);
    if (!mounted) return;
    setState(() {
      _saving = false;
      _dirty = false;
    });
    if (saved != null) {
      toast(context, L10n.s(context).t('decision.saved'), kind: ToastKind.success);
    }
  }

  Future<void> _save() async {
    final patch = <String, dynamic>{};
    if (_custom) {
      patch['baseUrl'] = _url.text.trim();
      patch['model'] = _model.text.trim();
    }
    final key = _key.text.trim();
    if (key.isNotEmpty) patch['apiKey'] = key;
    if (patch.isEmpty) return;
    _key.clear();
    await _patch(patch);
  }

  Future<void> _probe() async {
    setState(() => _probing = true);
    final state = AppScope.read(context);
    final r = await state.probeDecision(
      baseUrl: _custom ? _url.text.trim() : null,
      apiKey: _key.text.trim(),
      mode: _custom ? 'custom' : 'typesafe',
    );
    if (!mounted) return;
    setState(() => _probing = false);
    final s = L10n.s(context);
    if (r == null) {
      toast(context, s.t('decision.probeFail'), kind: ToastKind.error);
      return;
    }
    final ok = r['ok'] == true;
    final models =
        (r['models'] as List?)?.whereType<String>().toList() ?? const [];
    if (!ok) {
      toast(
        context,
        (r['error'] as String?) ?? s.t('decision.probeFail'),
        kind: ToastKind.error,
      );
      return;
    }
    if (models.isEmpty) {
      toast(context, s.t('decision.probeOkNoModels'), kind: ToastKind.success);
      return;
    }
    if (!_custom) {
      toast(
        context,
        s.tf('decision.probeOk', {'models': models.join('、')}),
        kind: ToastKind.success,
      );
      return;
    }
    final picked = await _pickModel(models);
    if (picked == null || !mounted) return;
    setState(() {
      _model.text = picked;
      _dirty = true;
    });
  }

  Future<String?> _pickModel(List<String> models) {
    final s = L10n.s(context);
    return showDialog<String>(
      context: context,
      builder: (ctx) => AlertDialog(
        backgroundColor: PB.bgElevated,
        title: Text(
          s.t('decision.pickModel'),
          style: const TextStyle(fontSize: PB.fsLg),
        ),
        content: SizedBox(
          width: 420,
          height: 360,
          child: ListView.builder(
            itemCount: models.length,
            itemBuilder: (c, i) {
              final m = models[i];
              return ListTile(
                dense: true,
                title: Text(m, style: const TextStyle(fontSize: PB.fsSm)),
                onTap: () => Navigator.pop(c, m),
              );
            },
          ),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(ctx),
            child: Text(s.t('common.cancel')),
          ),
        ],
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final s = L10n.s(context);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Row(
          children: [
            Text(
              s.t('decision.title'),
              style: TextStyle(
                fontSize: PB.fsSm,
                fontWeight: FontWeight.w600,
                color: PB.textSecondary,
              ),
            ),
            const Spacer(),
            if (_dirty)
              FilledButton(
                onPressed: _saving ? null : _save,
                child: Text(
                  _saving ? s.t('common.saving') : s.t('common.save'),
                ),
              ),
          ],
        ),
        const SizedBox(height: 4),
        Container(
          padding: const EdgeInsets.fromLTRB(14, 12, 14, 14),
          decoration: BoxDecoration(
            color: PB.bgPane,
            borderRadius: BorderRadius.circular(PB.rXl),
            border: Border.all(color: PB.borderTertiary),
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                s.t('decision.intro'),
                style: TextStyle(
                  fontSize: PB.fsXxs,
                  color: PB.textQuaternary,
                  height: 1.6,
                ),
              ),
              const SizedBox(height: 12),
              Row(
                children: [
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          s.t('decision.enable'),
                          style: TextStyle(
                            fontSize: PB.fsSm,
                            color: PB.textPrimary,
                          ),
                        ),
                        const SizedBox(height: 2),
                        Text(
                          _enabled
                              ? s.t('decision.enabledHint')
                              : s.t('decision.disabledHint'),
                          style: TextStyle(
                            fontSize: PB.fsXxs,
                            color: PB.textQuaternary,
                          ),
                        ),
                      ],
                    ),
                  ),
                  Switch(
                    value: _enabled,
                    onChanged: _saving ? null : (v) => _patch({'enabled': v}),
                  ),
                ],
              ),
              const SizedBox(height: 12),
              Text(
                s.t('decision.mode'),
                style: TextStyle(fontSize: PB.fsXxs, color: PB.textTertiary),
              ),
              const SizedBox(height: 6),
              SegmentedButton<String>(
                segments: [
                  ButtonSegment(
                    value: 'typesafe',
                    label: Text(s.t('decision.modeTypesafe')),
                  ),
                  ButtonSegment(
                    value: 'custom',
                    label: Text(s.t('decision.modeCustom')),
                  ),
                ],
                selected: {_custom ? 'custom' : 'typesafe'},
                onSelectionChanged: _saving
                    ? null
                    : (v) => _patch({'mode': v.first}),
              ),
              const SizedBox(height: 6),
              Text(
                _custom
                    ? s.t('decision.modeCustomHint')
                    : s.t('decision.modeTypesafeHint'),
                style: TextStyle(
                  fontSize: PB.fsXxs,
                  color: PB.textQuaternary,
                  height: 1.5,
                ),
              ),
              const SizedBox(height: 10),
              if (_custom) ...[
                _field(
                  label: s.t('decision.url'),
                  hint: 'https://your-service/v1',
                  controller: _url,
                ),
                const SizedBox(height: 10),
              ] else ...[
                // 官方模式把固定值显示出来：用户知道它连的是哪，但改不了。
                // 改不了不是防他，是防他填错一个 /v1 就全是 404 还查不出原因。
                _readonly(
                  context,
                  label: s.t('decision.url'),
                  value: kDecisionOfficialBaseUrl,
                ),
                const SizedBox(height: 10),
                _readonly(
                  context,
                  label: s.t('decision.model'),
                  value: kDecisionOfficialModel,
                ),
                const SizedBox(height: 10),
              ],
              _field(
                label: s.t('decision.key'),
                hint: _hasKey ? s.t('decision.keySaved') : 'sk-...',
                controller: _key,
                obscure: true,
              ),
              if (_custom) ...[
                const SizedBox(height: 10),
                _field(
                  label: s.t('decision.model'),
                  hint: s.t('decision.modelHint'),
                  controller: _model,
                ),
              ],
              const SizedBox(height: 10),
              Row(
                children: [
                  OutlinedButton.icon(
                    onPressed: _probing ? null : _probe,
                    icon: _probing
                        ? const SizedBox(
                            width: 13,
                            height: 13,
                            child: CircularProgressIndicator(strokeWidth: 2),
                          )
                        : const Icon(LucideIcons.zap, size: 14),
                    label: Text(
                      _probing ? s.t('decision.probing') : s.t('decision.probe'),
                    ),
                  ),
                  const SizedBox(width: 10),
                  Expanded(
                    child: Text(
                      _custom
                          ? s.t('decision.probeNoteCustom')
                          : s.t('decision.probeNote'),
                      style: TextStyle(
                        fontSize: PB.fsXxs,
                        color: PB.textQuaternary,
                        height: 1.4,
                      ),
                    ),
                  ),
                ],
              ),
            ],
          ),
        ),
      ],
    );
  }

  /// 只读展示（官方模式下地址和模型名是固定的）。
  Widget _readonly(
    BuildContext context, {
    required String label,
    required String value,
  }) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(
          label,
          style: TextStyle(fontSize: PB.fsXxs, color: PB.textTertiary),
        ),
        const SizedBox(height: 4),
        Container(
          width: double.infinity,
          padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 10),
          decoration: BoxDecoration(
            color: PB.bgHover,
            borderRadius: BorderRadius.circular(PB.rLg),
            border: Border.all(color: PB.borderTertiary),
          ),
          child: Text(
            value,
            style: TextStyle(fontSize: PB.fsSm, color: PB.textSecondary),
          ),
        ),
      ],
    );
  }

  Widget _field({
    required String label,
    required String hint,
    required TextEditingController controller,
    bool obscure = false,
  }) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(
          label,
          style: TextStyle(fontSize: PB.fsXxs, color: PB.textTertiary),
        ),
        const SizedBox(height: 4),
        TextField(
          controller: controller,
          obscureText: obscure,
          onChanged: (_) {
            if (!_dirty) setState(() => _dirty = true);
          },
          style: const TextStyle(fontSize: PB.fsSm),
          decoration: InputDecoration(
            hintText: hint,
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
    );
  }
}