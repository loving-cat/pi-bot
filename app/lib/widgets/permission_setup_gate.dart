import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../l10n/l10n.dart';
import '../onboarding_model.dart';
import '../scope.dart';
import '../theme.dart';

/// 首次授权页（规格 §13.2）。
///
/// ## 为什么是一页而不是五步向导
///
/// 规格写的是五步，但其中三步是"告知"、一步是"选择"、一步是"跑完之后的收尾"。
/// 拆成向导用户要多点四次"下一步"，而信息量一点没少 ——
/// 需要一起看的东西（边界、逐次确认、旧授权还在）分屏反而看不清。
///
/// ## 这一层只做三件事
///
///   1. 把服务端算好的内容摆出来（`OnboardingPlan`）；
///   2. 记住用户的两个选择（项目、Git 档位）；
///   3. 点"开始"时把它们交回去（真正建授权的是服务端）。
///
/// ★ 它**不判断**"该给多少权限"。判据在 `server/src/onboarding.js`，
///   这里只负责显示 —— 界面自己发明一套判据，就会出现
///   "界面上说只给项目范围、服务端发的却是全局"这种最难查的错。
///
/// ## 为什么"不能"那一半必须显示
///
/// 只说"它能做什么"的界面等于广告。用户真正需要知道的是
/// "它做不到什么、什么保证我给不了"（例如 project 模式不是沙箱）。
/// 那几条是 §13.2-4 的原文要求，不是可选的帮助文案。
class PermissionSetupView extends StatefulWidget {
  const PermissionSetupView({
    super.key,
    required this.plan,
    this.onApply,
    this.onDismiss,
    this.busy = false,
    this.errorText,
    this.initialProjectId,
    this.initialGitScope,
  });

  final OnboardingPlan plan;

  /// 点"开始"时回调；`null` 表示只读展示（没有可提交的动作）。
  final Future<void> Function(String projectId, String gitScope)? onApply;

  final VoidCallback? onDismiss;
  final bool busy;
  final String? errorText;

  /// 回填上次的选择（服务端记着 `state.onboarding`）。
  final String? initialProjectId;
  final String? initialGitScope;

  @override
  State<PermissionSetupView> createState() => _PermissionSetupViewState();
}

class _PermissionSetupViewState extends State<PermissionSetupView> {
  String? _projectId;
  String? _gitScope;

  @override
  void initState() {
    super.initState();
    _seed();
  }

  @override
  void didUpdateWidget(covariant PermissionSetupView old) {
    super.didUpdateWidget(old);
    // 计划变了（重新拉了服务端）就重新算初始值，别让旧选择卡住新选项
    if (!identical(old.plan, widget.plan)) _seed();
  }

  void _seed() {
    final step = widget.plan.projectStep;
    if (step == null) {
      _projectId = null;
      _gitScope = null;
      return;
    }
    _projectId = initialChoice(
      step.projects,
      widget.initialProjectId ?? step.recommendedProjectId,
    );
    _gitScope = initialChoice(
      step.gitScopes,
      widget.initialGitScope ?? step.recommendedGitScope,
    );
  }

  @override
  Widget build(BuildContext context) {
    final s = L10n.s(context);
    final state = widget.plan.stateOf(projectId: _projectId, gitScope: _gitScope);
    return SizedBox.expand(
      child: Center(
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 560),
          child: SingleChildScrollView(
            padding: const EdgeInsets.all(28),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              mainAxisSize: MainAxisSize.min,
              children: [
                _header(s),
                const SizedBox(height: 20),
                ...widget.plan.steps.map(_stepCard),
                const SizedBox(height: 14),
                _confirmCard(s),
                const SizedBox(height: 14),
                _boundariesCard(s),
                if (widget.plan.warnings.isNotEmpty) ...[
                  const SizedBox(height: 14),
                  _linesCard(
                    icon: LucideIcons.alertTriangle,
                    color: PB.warn,
                    title: s.t('perm.warnings'),
                    lines: widget.plan.warnings,
                  ),
                ],
                if (widget.plan.blockers.isNotEmpty) ...[
                  const SizedBox(height: 14),
                  _linesCard(
                    icon: LucideIcons.ban,
                    color: PB.danger,
                    title: s.t('perm.blockers'),
                    lines: widget.plan.blockers,
                  ),
                ],
                if (widget.errorText != null) ...[
                  const SizedBox(height: 12),
                  Text(
                    widget.errorText!,
                    style: TextStyle(color: PB.danger, fontSize: PB.fsSm),
                  ),
                ],
                const SizedBox(height: 22),
                _actions(s, state),
              ],
            ),
          ),
        ),
      ),
    );
  }

  Widget _header(AppStrings s) {
    final accent = PB.colors(context).accentBright;
    return Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Container(
          width: 40,
          height: 40,
          decoration: BoxDecoration(
            color: accent.withValues(alpha: .14),
            borderRadius: BorderRadius.circular(PB.rLg),
          ),
          child: Icon(LucideIcons.shieldCheck, size: 20, color: accent),
        ),
        const SizedBox(width: 12),
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                s.t('perm.title'),
                style: const TextStyle(fontSize: PB.fsXl, fontWeight: FontWeight.w600),
              ),
              const SizedBox(height: 6),
              Text(
                widget.plan.headline(projectId: _projectId, gitScope: _gitScope),
                style: TextStyle(fontSize: PB.fsSm, color: PB.textSecondary),
              ),
            ],
          ),
        ),
      ],
    );
  }

  Widget _stepCard(OnboardingStep step) {
    final children = <Widget>[
      for (final line in step.lines)
        Padding(
          padding: const EdgeInsets.only(bottom: 6),
          child: _bullet(line),
        ),
    ];
    if (step.kind == OnboardingStepKind.choose) {
      children.addAll(_choiceControls(step));
    }
    return Padding(
      padding: const EdgeInsets.only(bottom: 12),
      child: _card(
        Row(
          children: [
            _stepBadge(step.id),
            const SizedBox(width: 10),
            Expanded(
              child: Text(
                step.title,
                style: const TextStyle(fontWeight: FontWeight.w600, fontSize: PB.fsLg),
              ),
            ),
          ],
        ),
        children,
      ),
    );
  }

  List<Widget> _choiceControls(OnboardingStep step) {
    final s = L10n.s(context);
    Widget? projectField;
    if (step.projects.isNotEmpty) {
      projectField = _labelled(
        s.t('perm.project'),
        DropdownButtonFormField<String>(
          initialValue: _projectId,
          items: [
            for (final p in step.projects)
              DropdownMenuItem(value: p.id, child: Text(p.label)),
          ],
          onChanged: (v) => setState(() => _projectId = v),
        ),
      );
    }
    Widget? scopeField;
    if (step.gitScopes.isNotEmpty) {
      scopeField = _labelled(
        s.t('perm.gitScope'),
        DropdownButtonFormField<String>(
          initialValue: _gitScope,
          items: [
            for (final g in step.gitScopes)
              DropdownMenuItem(value: g.id, child: Text(g.label)),
          ],
          onChanged: (v) => setState(() => _gitScope = v),
        ),
      );
    }
    if (projectField == null && scopeField == null) return const [];
    return [
      const SizedBox(height: 10),
      if (projectField != null) projectField,
      if (projectField != null && scopeField != null) const SizedBox(height: 10),
      if (scopeField != null) scopeField,
    ];
  }

  Widget _confirmCard(AppStrings s) => _linesCard(
        icon: LucideIcons.hand,
        color: PB.colors(context).accentBright,
        title: s.t('perm.confirmEach'),
        lines: widget.plan.perCallConfirm,
      );

  Widget _boundariesCard(AppStrings s) => _linesCard(
        icon: LucideIcons.scale,
        color: PB.warn,
        title: s.t('perm.boundaries'),
        lines: [
          for (final line in widget.plan.canDo) '✓ $line',
          for (final line in widget.plan.cannotDo) '✕ $line',
        ],
      );

  Widget _actions(AppStrings s, OnboardingPageState state) {
    final canStart = state == OnboardingPageState.ready;
    final blocked = state == OnboardingPageState.blocked;
    return Row(
      children: [
        if (widget.onDismiss != null)
          TextButton(
            onPressed: widget.busy ? null : widget.onDismiss,
            child: Text(s.t('perm.later')),
          ),
        const Spacer(),
        FilledButton(
          onPressed: (canStart && !widget.busy)
              ? () => widget.onApply!(_projectId!, _gitScope!)
              : null,
          child: widget.busy
              ? const SizedBox(
                  width: 16,
                  height: 16,
                  child: CircularProgressIndicator(strokeWidth: 2),
                )
              : Text(
                  blocked
                      ? s.t('perm.blocked')
                      : widget.plan.primaryActionText(
                          projectId: _projectId,
                          gitScope: _gitScope,
                        ),
                ),
        ),
      ],
    );
  }

  // ---------------------------------------------------------------- 小零件

  Widget _card(Widget head, List<Widget> children) {
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: PB.bgPane,
        borderRadius: BorderRadius.circular(PB.rLg),
        border: Border.all(color: PB.borderSecondary),
      ),
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        head,
        if (children.isNotEmpty) const SizedBox(height: 8),
        ...children,
      ]),
    );
  }

  Widget _linesCard({
    required IconData icon,
    required Color color,
    required String title,
    required List<String> lines,
  }) {
    if (lines.isEmpty) return const SizedBox.shrink();
    return _card(
      Row(children: [
        Icon(icon, size: 16, color: color),
        const SizedBox(width: 8),
        Expanded(
          child: Text(
            title,
            style: const TextStyle(fontWeight: FontWeight.w600, fontSize: PB.fsLg),
          ),
        ),
      ]),
      [for (final line in lines) Padding(padding: const EdgeInsets.only(bottom: 6), child: _bullet(line))],
    );
  }

  Widget _stepBadge(int id) => Container(
        width: 22,
        height: 22,
        alignment: Alignment.center,
        decoration: BoxDecoration(
          color: PB.colors(context).accentBright.withValues(alpha: .14),
          borderRadius: BorderRadius.circular(PB.rSm),
        ),
        child: Text(
          '$id',
          style: TextStyle(
            fontSize: PB.fsXs,
            fontWeight: FontWeight.w600,
            color: PB.colors(context).accentBright,
          ),
        ),
      );

  Widget _bullet(String text) => Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Padding(
            padding: const EdgeInsets.only(top: 5, right: 8),
            child: Container(
              width: 4,
              height: 4,
              decoration: BoxDecoration(color: PB.textSecondary, shape: BoxShape.circle),
            ),
          ),
          Expanded(
            child: Text(
              text,
              style: TextStyle(fontSize: PB.fsSm, color: PB.textSecondary, height: 1.45),
            ),
          ),
        ],
      );

  Widget _labelled(String label, Widget field) => Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(label, style: TextStyle(fontSize: PB.fsXs, color: PB.textSecondary)),
          const SizedBox(height: 4),
          field,
        ],
      );
}

/// 主界面用的门：把首启页挡在 `HomeShell` 前面。
class PermissionSetupGate extends StatefulWidget {
  const PermissionSetupGate({super.key});

  @override
  State<PermissionSetupGate> createState() => _PermissionSetupGateState();
}

class _PermissionSetupGateState extends State<PermissionSetupGate> {
  bool _busy = false;
  String? _error;

  @override
  Widget build(BuildContext context) {
    final state = AppScope.of(context);
    final plan = state.onboardingPlan ?? OnboardingPlan.empty;
    return Scaffold(
      backgroundColor: PB.bgApp,
      body: PermissionSetupView(
        plan: plan,
        busy: _busy,
        errorText: _error,
        initialProjectId: state.onboardingSavedProjectId,
        initialGitScope: state.onboardingSavedGitScope,
        onDismiss: state.dismissOnboarding,
        onApply: (projectId, gitScope) async {
          setState(() {
            _busy = true;
            _error = null;
          });
          final err = await state.applyOnboarding(
            projectId: projectId,
            gitScope: gitScope,
          );
          if (!mounted) return;
          setState(() {
            _busy = false;
            _error = err;
          });
          // 成功才走：失败时留在这一页并把错误显示出来，
          // 直接关掉会让用户以为"点了没反应"。
          if (err == null) state.dismissOnboarding();
        },
      ),
    );
  }
}
