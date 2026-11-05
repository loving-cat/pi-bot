import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../app_state.dart';
import '../l10n/l10n.dart';
import '../models.dart';
import '../motion.dart';
import '../scope.dart';
import '../theme.dart';
import 'toast.dart';

/// 系统接入面板（设置里的「系统接入」标签页）。
///
/// 用户填网址 + 账号 + 口令，先探测能不能连、登录字段叫什么，
/// 确认后再存下来，并可以一键为它建一个团队。
///
/// 之所以必须先探测：不同系统的登录接口/字段名不一样，
/// 直接存进去会出现「保存成功但永远连不上」，用户完全不知道错在哪。
class SitesSection extends StatefulWidget {
  const SitesSection({super.key});

  @override
  State<SitesSection> createState() => _SitesSectionState();
}

class _SitesSectionState extends State<SitesSection> {
  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) {
      AppScope.of(context).loadSites();
    });
  }

  @override
  Widget build(BuildContext context) {
    final strings = L10n.s(context);
    final state = AppScope.of(context);
    final list = state.sites;

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Row(
          children: [
            Expanded(
              child: Text(
                list.isEmpty
                    ? strings.t('sites.hint')
                    : strings.tf('sites.connectedCount', {'n': list.length}),
                style: const TextStyle(
                  fontSize: PB.fsXs,
                  color: PB.textTertiary,
                ),
              ),
            ),
            FilledButton.icon(
              onPressed: () => _addSite(context, state),
              icon: const Icon(LucideIcons.plus, size: 14),
              label: Text(
                strings.t('sites.add'),
                style: const TextStyle(fontSize: PB.fsXs),
              ),
              style: FilledButton.styleFrom(
                minimumSize: const Size(0, 34),
                padding: const EdgeInsets.symmetric(horizontal: 12),
              ),
            ),
          ],
        ),
        const SizedBox(height: 12),
        if (!state.sitesLoaded)
          const Padding(
            padding: EdgeInsets.symmetric(vertical: 30),
            child: Center(
              child: SizedBox(
                width: 18,
                height: 18,
                child: CircularProgressIndicator(strokeWidth: 2),
              ),
            ),
          )
        else if (list.isEmpty)
          _EmptySites(onAdd: () => _addSite(context, state))
        else
          ...list.map(
            (site) => _SiteCard(
              key: ValueKey(site.id),
              site: site,
              onTest: () => _testSite(context, state, site),
              onDelete: () => _deleteSite(context, state, site),
              onTeam: () => _makeTeam(context, state, site),
            ),
          ),
      ],
    );
  }

  void _toast(BuildContext context, String text) {
    toast(context, text, kind: ToastKind.error);
  }

  Future<void> _deleteSite(
    BuildContext context,
    AppState state,
    SiteSystem site,
  ) async {
    final strings = L10n.s(context);
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        backgroundColor: PB.bgElevated,
        title: Text(
          strings.t('sites.removeTitle'),
          style: const TextStyle(fontSize: PB.fsLg),
        ),
        content: Text(
          strings.tf('sites.removeBody', {'name': site.name}),
          style: const TextStyle(
            fontSize: PB.fsSm,
            color: PB.textSecondary,
            height: 1.6,
          ),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(ctx, false),
            child: Text(strings.t('common.cancel')),
          ),
          FilledButton(
            onPressed: () => Navigator.pop(ctx, true),
            style: FilledButton.styleFrom(backgroundColor: PB.danger),
            child: Text(strings.t('common.remove')),
          ),
        ],
      ),
    );
    if (ok != true || !context.mounted) return;
    final err = await state.removeSite(site.id);
    if (!context.mounted) return;
    _toast(context, err ?? strings.t('sites.removed'));
  }

  Future<void> _testSite(
    BuildContext context,
    AppState state,
    SiteSystem site,
  ) async {
    final strings = L10n.s(context);
    _toast(context, strings.tf('sites.connecting', {'name': site.name}));
    final r = await state.testSite(site.id);
    if (!context.mounted) return;
    _toast(
      context,
      r['ok'] == true
          ? strings.tf('sites.connectOk', {'name': site.name})
          : strings.tf('sites.connectFailed', {
              'reason': r['reason'] ?? strings.t('sites.unknownReason'),
            }),
    );
    await state.loadSites();
  }

  /// 为一个系统建团队：创建部门并把该系统的查询能力交给它
  Future<void> _makeTeam(
    BuildContext context,
    AppState state,
    SiteSystem site,
  ) async {
    final strings = L10n.s(context);
    final name = TextEditingController(
      text: strings.tf('sites.teamName', {'name': site.name}),
    );
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        backgroundColor: PB.bgElevated,
        title: Text(
          strings.t('sites.createTeamTitle'),
          style: const TextStyle(fontSize: PB.fsLg),
        ),
        content: SizedBox(
          width: 420,
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                strings.tf('sites.createTeamBody', {'name': site.name}),
                style: const TextStyle(
                  fontSize: PB.fsXs,
                  color: PB.textTertiary,
                  height: 1.7,
                ),
              ),
              const SizedBox(height: 12),
              TextField(
                controller: name,
                autofocus: true,
                decoration: InputDecoration(
                  labelText: strings.t('sites.teamNameLabel'),
                ),
              ),
            ],
          ),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(ctx, false),
            child: Text(strings.t('common.cancel')),
          ),
          FilledButton(
            onPressed: () => Navigator.pop(ctx, true),
            child: Text(strings.t('sites.create')),
          ),
        ],
      ),
    );
    name.dispose();
    if (ok != true || !context.mounted) return;

    // 交给主控去建（它会按站点定制人设与技能），比自己硬编码一套更符合「主控统一调度」
    final err = await state.bindSiteTeam(site.id, site.name);
    if (!context.mounted) return;
    if (err != null) {
      _toast(context, err);
      return;
    }
    await state.loadSites();
    if (!context.mounted) return;
    _toast(context, strings.tf('sites.teamCreated', {'name': site.name}));
  }

  /// 添加系统：填 → 探测 → 保存
  Future<void> _addSite(BuildContext context, AppState state) async {
    final strings = L10n.s(context);
    final url = TextEditingController();
    final account = TextEditingController();
    final password = TextEditingController();
    final accField = TextEditingController();
    final pwdField = TextEditingController();
    var probing = false;
    String? status;
    bool? probeOk;
    Map<String, dynamic>? auth;
    var advanced = false;

    final saved = await showDialog<bool>(
      context: context,
      builder: (ctx) => StatefulBuilder(
        builder: (ctx, setLocal) {
          Future<void> doProbe() async {
            setLocal(() {
              probing = true;
              status = strings.t('sites.probing');
              probeOk = null;
            });
            final r = await state.probeSite(
              baseUrl: url.text.trim(),
              account: account.text.trim(),
              password: password.text,
              accountField: accField.text.trim(),
              passwordField: pwdField.text.trim(),
            );
            if (!ctx.mounted) return;
            setLocal(() {
              probing = false;
              probeOk = r['ok'] == true;
              status =
                  r['reason']?.toString() ??
                  (probeOk!
                      ? strings.t('sites.probeOk')
                      : strings.t('sites.probeFailed'));
              auth = (r['auth'] as Map?)?.cast<String, dynamic>();
            });
          }

          return AlertDialog(
            backgroundColor: PB.bgElevated,
            title: Text(
              strings.t('sites.addTitle'),
              style: const TextStyle(fontSize: PB.fsLg),
            ),
            content: SizedBox(
              width: 480,
              child: SingleChildScrollView(
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      strings.t('sites.addBody'),
                      style: const TextStyle(
                        fontSize: PB.fsXs,
                        color: PB.textTertiary,
                        height: 1.7,
                      ),
                    ),
                    const SizedBox(height: 14),
                    TextField(
                      controller: url,
                      autofocus: true,
                      decoration: InputDecoration(
                        labelText: strings.t('sites.url'),
                        hintText: 'https://your-system.com',
                      ),
                    ),
                    const SizedBox(height: 10),
                    TextField(
                      controller: account,
                      decoration: InputDecoration(
                        labelText: strings.t('sites.account'),
                      ),
                    ),
                    const SizedBox(height: 10),
                    TextField(
                      controller: password,
                      obscureText: true,
                      decoration: InputDecoration(
                        labelText: strings.t('sites.password'),
                      ),
                    ),
                    const SizedBox(height: 8),
                    // 高级：探测不出来时手填字段名
                    InkWell(
                      onTap: () => setLocal(() => advanced = !advanced),
                      child: Padding(
                        padding: const EdgeInsets.symmetric(vertical: 4),
                        child: Row(
                          children: [
                            Icon(
                              advanced
                                  ? LucideIcons.chevronDown
                                  : LucideIcons.chevronRight,
                              size: 14,
                              color: PB.textQuaternary,
                            ),
                            const SizedBox(width: 4),
                            Text(
                              strings.t('sites.manualFields'),
                              style: const TextStyle(
                                fontSize: PB.fsXxs,
                                color: PB.textTertiary,
                              ),
                            ),
                          ],
                        ),
                      ),
                    ),
                    AnimatedCrossFade(
                      firstChild: const SizedBox(width: double.infinity),
                      secondChild: Padding(
                        padding: const EdgeInsets.only(top: 8),
                        child: Column(
                          children: [
                            TextField(
                              controller: accField,
                              decoration: InputDecoration(
                                labelText: strings.t('sites.accountField'),
                                hintText: 'account / email / username',
                              ),
                            ),
                            const SizedBox(height: 8),
                            TextField(
                              controller: pwdField,
                              decoration: InputDecoration(
                                labelText: strings.t('sites.passwordField'),
                                hintText: 'password / passwd / pwd',
                              ),
                            ),
                          ],
                        ),
                      ),
                      crossFadeState: advanced
                          ? CrossFadeState.showSecond
                          : CrossFadeState.showFirst,
                      duration: Motion.base,
                    ),
                    if (status != null) ...[
                      const SizedBox(height: 12),
                      Row(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          if (probing)
                            const SizedBox(
                              width: 12,
                              height: 12,
                              child: CircularProgressIndicator(
                                strokeWidth: 1.6,
                              ),
                            )
                          else
                            Icon(
                              probeOk == true
                                  ? LucideIcons.checkCircle2
                                  : LucideIcons.xCircle,
                              size: 14,
                              color: probeOk == true
                                  ? PB.success
                                  : PB.danger,
                            ),
                          const SizedBox(width: 6),
                          Expanded(
                            child: Text(
                              status!,
                              style: TextStyle(
                                fontSize: PB.fsXs,
                                height: 1.6,
                                color: probeOk == true
                                    ? PB.textSecondary
                                    : (probeOk == false
                                          ? PB.danger
                                          : PB.textTertiary),
                              ),
                            ),
                          ),
                        ],
                      ),
                    ],
                  ],
                ),
              ),
            ),
            actions: [
              TextButton(
                onPressed: () => Navigator.pop(ctx, false),
                child: Text(strings.t('common.cancel')),
              ),
              OutlinedButton(
                onPressed: probing ? null : doProbe,
                child: Text(
                  probing
                      ? strings.t('sites.connectingShort')
                      : strings.t('sites.testConnection'),
                ),
              ),
              FilledButton(
                // 探测通过才能保存：没连上就存，等于存一条永远用不了的配置
                onPressed: probeOk == true && !probing
                    ? () async {
                        final err = await state.addSite(
                          baseUrl: url.text.trim(),
                          account: account.text.trim(),
                          password: password.text,
                          auth: auth,
                        );
                        if (!ctx.mounted) return;
                        if (err != null) {
                          setLocal(() {
                            status = err;
                            probeOk = false;
                          });
                          return;
                        }
                        Navigator.pop(ctx, true);
                      }
                    : null,
                child: Text(strings.t('common.save')),
              ),
            ],
          );
        },
      ),
    );

    url.dispose();
    account.dispose();
    password.dispose();
    accField.dispose();
    pwdField.dispose();
    if (saved == true && context.mounted) {
      _toast(context, strings.t('sites.added'));
    }
  }
}

class _EmptySites extends StatelessWidget {
  const _EmptySites({required this.onAdd});

  final VoidCallback onAdd;

  @override
  Widget build(BuildContext context) {
    final strings = L10n.s(context);
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.symmetric(vertical: 34, horizontal: 20),
      decoration: BoxDecoration(
        color: PB.bgPane,
        borderRadius: BorderRadius.circular(10),
        border: Border.all(color: PB.borderSecondary),
      ),
      child: Column(
        children: [
          const Icon(LucideIcons.plug, size: 26, color: PB.textQuaternary),
          const SizedBox(height: 12),
          Text(
            strings.t('sites.empty'),
            style: const TextStyle(fontSize: PB.fsSm, color: PB.textSecondary),
          ),
          const SizedBox(height: 14),
          FilledButton.icon(
            onPressed: onAdd,
            icon: const Icon(LucideIcons.plus, size: 15),
            label: Text(
              strings.t('sites.connectFirst'),
              style: const TextStyle(fontSize: PB.fsXs),
            ),
            style: FilledButton.styleFrom(minimumSize: const Size(0, 34)),
          ),
        ],
      ),
    );
  }
}

class _SiteCard extends StatefulWidget {
  const _SiteCard({
    super.key,
    required this.site,
    required this.onTest,
    required this.onDelete,
    required this.onTeam,
  });

  final SiteSystem site;
  final VoidCallback onTest;
  final VoidCallback onDelete;
  final VoidCallback onTeam;

  @override
  State<_SiteCard> createState() => _SiteCardState();
}

class _SiteCardState extends State<_SiteCard> {
  bool _hover = false;

  @override
  Widget build(BuildContext context) {
    final strings = L10n.s(context);
    final s = widget.site;
    return MouseRegion(
      onEnter: (_) => setState(() => _hover = true),
      onExit: (_) => setState(() => _hover = false),
      child: AnimatedContainer(
        duration: Motion.fast,
        margin: const EdgeInsets.only(bottom: 8),
        padding: const EdgeInsets.fromLTRB(12, 10, 10, 10),
        decoration: BoxDecoration(
          color: _hover ? PB.bgHover : PB.bgPane,
          borderRadius: BorderRadius.circular(10),
          border: Border.all(color: PB.borderSecondary),
        ),
        child: Row(
          children: [
            Container(
              width: 7,
              height: 7,
              decoration: BoxDecoration(
                shape: BoxShape.circle,
                color: s.connected ? PB.success : PB.textQuaternary,
              ),
            ),
            const SizedBox(width: 10),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Row(
                    children: [
                      Text(
                        s.name,
                        style: const TextStyle(
                          fontSize: PB.fsSm,
                          color: PB.textPrimary,
                        ),
                      ),
                      if (s.teamRoomId.isNotEmpty) ...[
                        const SizedBox(width: 6),
                        Container(
                          padding: const EdgeInsets.symmetric(
                            horizontal: 5,
                            vertical: 1,
                          ),
                          decoration: BoxDecoration(
                            color: PB.bgActive,
                            borderRadius: BorderRadius.circular(4),
                          ),
                          child: Text(
                            strings.t('sites.teamBadge'),
                            style: const TextStyle(
                              fontSize: 10,
                              color: PB.textTertiary,
                            ),
                          ),
                        ),
                      ],
                    ],
                  ),
                  const SizedBox(height: 2),
                  Text(
                    '${s.baseUrl}  ·  ${s.account}',
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: const TextStyle(
                      fontSize: PB.fsXxs,
                      color: PB.textTertiary,
                    ),
                  ),
                  if (s.lastError.isNotEmpty) ...[
                    const SizedBox(height: 2),
                    Text(
                      s.lastError,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: const TextStyle(
                        fontSize: PB.fsXxs,
                        color: PB.danger,
                      ),
                    ),
                  ],
                ],
              ),
            ),
            if (_hover) ...[
              _SiteAction(
                icon: LucideIcons.plugZap,
                tooltip: strings.t('sites.test'),
                onTap: widget.onTest,
              ),
              _SiteAction(
                icon: LucideIcons.users,
                tooltip: strings.t('sites.createTeam'),
                onTap: widget.onTeam,
              ),
              _SiteAction(
                icon: LucideIcons.trash2,
                tooltip: strings.t('common.remove'),
                onTap: widget.onDelete,
                danger: true,
              ),
            ],
          ],
        ),
      ),
    );
  }
}

class _SiteAction extends StatelessWidget {
  const _SiteAction({
    required this.icon,
    required this.tooltip,
    required this.onTap,
    this.danger = false,
  });

  final IconData icon;
  final String tooltip;
  final VoidCallback onTap;
  final bool danger;

  @override
  Widget build(BuildContext context) {
    return Tooltip(
      message: tooltip,
      child: InkWell(
        borderRadius: BorderRadius.circular(6),
        onTap: onTap,
        child: Padding(
          padding: const EdgeInsets.all(6),
          child: Icon(
            icon,
            size: 14,
            color: danger ? PB.danger : PB.textTertiary,
          ),
        ),
      ),
    );
  }
}
