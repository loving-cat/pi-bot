import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../l10n/l10n.dart';
import '../scope.dart';
import '../theme.dart';
import 'toast.dart';

/// 设置里的「快速决策」区块。
///
/// ## 这是什么
///
/// 产品里有一批"小判断"：这个成员该配哪个模型、这条消息要不要接、
/// 压缩时哪些内容不能丢。走一次完整 LLM 推理太贵也慢，
/// 决策模型（Jev / TypeSafe）几百毫秒就能给出结构化答案。
///
/// ## 两条线
///
/// 关着的时候一切走原来的逻辑，行为和没这个功能完全一致。
/// 打开后只有**注册过**的决策点才切过去 —— 不是全局替换，
/// 因为有的判断必须确定性（危险命令放行），有的高频到不能每次发请求。
///
/// 所以这个开关默认关闭，也不拦着用户干活：
/// 没配它，产品照常能用，只是少一点"聪明"。
class DecisionSection extends StatefulWidget {
  const DecisionSection({super.key});

  @override
  State<DecisionSection> createState() => _DecisionSectionState();
}

class _DecisionSectionState extends State<DecisionSection> {
  final _url = TextEditingController();
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
    _key.dispose();
    super.dispose();
  }

  void _fill() {
    if (!mounted || _dirty) return;
    final d = AppScope.read(context).decision;
    _url.text = (d['baseUrl'] as String?) ?? '';
  }

  Map<String, dynamic> get _cfg => AppScope.read(context).decision;
  bool get _enabled => _cfg['enabled'] == true;
  bool get _hasKey => _cfg['hasApiKey'] == true;

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
    final url = _url.text.trim();
    if (url.isNotEmpty) patch['baseUrl'] = url;
    // 只在用户真的填了才传 key；留空表示"不改"
    final key = _key.text.trim();
    if (key.isNotEmpty) patch['apiKey'] = key;
    if (patch.isEmpty) return;
    _key.clear();
    await _patch(patch);
  }

  Future<void> _probe() async {
    setState(() => _probing = true);
    final state = AppScope.read(context);
    final res = await state.probeDecision(
      baseUrl: _url.text.trim(),
      apiKey: _key.text.trim(),
    );
    if (!mounted) return;
    setState(() => _probing = false);
    final s = L10n.s(context);
    if (res == null) {
      toast(context, s.t('decision.probeFail'), kind: ToastKind.error);
      return;
    }
    final ok = res['ok'] == true;
    final models =
        (res['models'] as List?)?.whereType<String>().toList() ?? const [];
    toast(
      context,
      ok
          ? s.tf('decision.probeOk', {'models': models.join('、')})
          : ((res['error'] as String?) ?? s.t('decision.probeFail')),
      kind: ok ? ToastKind.success : ToastKind.error,
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
              const SizedBox(height: 10),
              _field(
                label: s.t('decision.url'),
                hint: 'https://api.typesafe.ai',
                controller: _url,
              ),
              const SizedBox(height: 10),
              _field(
                label: s.t('decision.key'),
                hint: _hasKey ? s.t('decision.keySaved') : 'apikey_...',
                controller: _key,
                obscure: true,
              ),
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
                      s.t('decision.probeNote'),
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