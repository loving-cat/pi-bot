import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../app_state.dart';
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
/// 为什么必须先探测：不同系统的登录接口/字段名不一样，
/// 直接存进去会出现"保存成功但永远连不上"，用户完全不知道错在哪。
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
                    ? '把你在用的 Web 系统接进来，bot 就能直接查它的数据'
                    : '已接入 ${list.length} 个系统',
                style: const TextStyle(fontSize: PB.fsXs, color: PB.textTertiary),
              ),
            ),
            FilledButton.icon(
              onPressed: () => _addSite(context, state),
              icon: const Icon(LucideIcons.plus, size: 14),
              label: const Text('添加系统', style: TextStyle(fontSize: PB.fsXs)),
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

  Future<void> _deleteSite(BuildContext context, AppState state, SiteSystem site) async {
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        backgroundColor: PB.bgElevated,
        title: const Text('移除这个系统？', style: TextStyle(fontSize: PB.fsLg)),
        content: Text(
          '「${site.name}」会被移除，凭证也一起删掉。\n'
          '它对应的团队（如果建过）不会删 —— 里面的聊天记录还在。',
          style: const TextStyle(fontSize: PB.fsSm, color: PB.textSecondary, height: 1.6),
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('取消')),
          FilledButton(
            onPressed: () => Navigator.pop(ctx, true),
            style: FilledButton.styleFrom(backgroundColor: PB.danger),
            child: const Text('移除'),
          ),
        ],
      ),
    );
    if (ok != true || !context.mounted) return;
    final err = await state.removeSite(site.id);
    if (!context.mounted) return;
    _toast(context, err ?? '已移除');
  }

  Future<void> _testSite(BuildContext context, AppState state, SiteSystem site) async {
    _toast(context, '正在连接 ${site.name}…');
    final r = await state.testSite(site.id);
    if (!context.mounted) return;
    _toast(context, r['ok'] == true ? '${site.name} 连接正常' : '连不上：${r['reason'] ?? '未知原因'}');
    await state.loadSites();
  }

  /// 为一个系统建团队：创建部门并把该系统的查询能力交给它
  Future<void> _makeTeam(BuildContext context, AppState state, SiteSystem site) async {
    final name = TextEditingController(text: '${site.name} 团队');
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        backgroundColor: PB.bgElevated,
        title: const Text('为它建一个团队', style: TextStyle(fontSize: PB.fsLg)),
        content: SizedBox(
          width: 420,
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                '会给「${site.name}」建一个部门，部门里的人都能查这个系统的数据。\n'
                '以后你直接对它们说"帮我看看 xx"，它们就去查。',
                style: const TextStyle(fontSize: PB.fsXs, color: PB.textTertiary, height: 1.7),
              ),
              const SizedBox(height: 12),
              TextField(
                controller: name,
                autofocus: true,
                decoration: const InputDecoration(labelText: '团队名字'),
              ),
            ],
          ),
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('取消')),
          FilledButton(onPressed: () => Navigator.pop(ctx, true), child: const Text('创建')),
        ],
      ),
    );
    name.dispose();
    if (ok != true || !context.mounted) return;

    // 交给主控去建（它会按站点定制人设与技能），比自己硬编码一套更符合"主控统一调度"
    final err = await state.bindSiteTeam(site.id, site.name);
    if (!context.mounted) return;
    if (err != null) {
      _toast(context, err);
      return;
    }
    await state.loadSites();
    if (!context.mounted) return;
    _toast(context, '已交给主控，它会在「${site.name}」里安排人');
  }

  /// 添加系统：填 → 探测 → 保存
  Future<void> _addSite(BuildContext context, AppState state) async {
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
              status = '正在尝试连接…';
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
              status = r['reason']?.toString() ?? (probeOk! ? '连接成功' : '连接失败');
              auth = (r['auth'] as Map?)?.cast<String, dynamic>();
            });
          }

          return AlertDialog(
            backgroundColor: PB.bgElevated,
            title: const Text('接入一个系统', style: TextStyle(fontSize: PB.fsLg)),
            content: SizedBox(
              width: 480,
              child: SingleChildScrollView(
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    const Text(
                      '填上系统的网址和登录信息，我们会先试着连一次，'
                      '确认能连上再存下来。',
                      style: TextStyle(fontSize: PB.fsXs, color: PB.textTertiary, height: 1.7),
                    ),
                    const SizedBox(height: 14),
                    TextField(
                      controller: url,
                      autofocus: true,
                      decoration: const InputDecoration(
                        labelText: '网址',
                        hintText: 'https://your-system.com',
                      ),
                    ),
                    const SizedBox(height: 10),
                    TextField(
                      controller: account,
                      decoration: const InputDecoration(labelText: '账号'),
                    ),
                    const SizedBox(height: 10),
                    TextField(
                      controller: password,
                      obscureText: true,
                      decoration: const InputDecoration(labelText: '密码'),
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
                              advanced ? LucideIcons.chevronDown : LucideIcons.chevronRight,
                              size: 14,
                              color: PB.textQuaternary,
                            ),
                            const SizedBox(width: 4),
                            const Text(
                              '连不上？手动指定登录字段',
                              style: TextStyle(fontSize: PB.fsXxs, color: PB.textTertiary),
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
                              decoration: const InputDecoration(
                                labelText: '账号字段名（选填）',
                                hintText: 'account / email / username',
                              ),
                            ),
                            const SizedBox(height: 8),
                            TextField(
                              controller: pwdField,
                              decoration: const InputDecoration(
                                labelText: '密码字段名（选填）',
                                hintText: 'password / passwd / pwd',
                              ),
                            ),
                          ],
                        ),
                      ),
                      crossFadeState:
                          advanced ? CrossFadeState.showSecond : CrossFadeState.showFirst,
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
                              child: CircularProgressIndicator(strokeWidth: 1.6),
                            )
                          else
                            Icon(
                              probeOk == true ? LucideIcons.checkCircle2 : LucideIcons.xCircle,
                              size: 14,
                              color: probeOk == true ? PB.accent : PB.danger,
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
                                    : (probeOk == false ? PB.danger : PB.textTertiary),
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
              TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('取消')),
              OutlinedButton(
                onPressed: probing ? null : doProbe,
                child: Text(probing ? '连接中…' : '试连接'),
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
                child: const Text('保存'),
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
    if (saved == true && context.mounted) _toast(context, '已接入');
  }
}

class _EmptySites extends StatelessWidget {
  const _EmptySites({required this.onAdd});

  final VoidCallback onAdd;

  @override
  Widget build(BuildContext context) {
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
          const Text(
            '还没有接入系统',
            style: TextStyle(fontSize: PB.fsSm, color: PB.textSecondary),
          ),
          const SizedBox(height: 14),
          FilledButton.icon(
            onPressed: onAdd,
            icon: const Icon(LucideIcons.plus, size: 15),
            label: const Text('接入第一个系统', style: TextStyle(fontSize: PB.fsXs)),
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
                color: s.connected ? PB.accent : PB.textQuaternary,
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
                        style: const TextStyle(fontSize: PB.fsSm, color: PB.textPrimary),
                      ),
                      if (s.teamRoomId.isNotEmpty) ...[
                        const SizedBox(width: 6),
                        Container(
                          padding: const EdgeInsets.symmetric(horizontal: 5, vertical: 1),
                          decoration: BoxDecoration(
                            color: PB.bgActive,
                            borderRadius: BorderRadius.circular(4),
                          ),
                          child: const Text(
                            '已建团队',
                            style: TextStyle(fontSize: 10, color: PB.textTertiary),
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
                    style: const TextStyle(fontSize: PB.fsXxs, color: PB.textTertiary),
                  ),
                  if (s.lastError.isNotEmpty) ...[
                    const SizedBox(height: 2),
                    Text(
                      s.lastError,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: const TextStyle(fontSize: PB.fsXxs, color: PB.danger),
                    ),
                  ],
                ],
              ),
            ),
            if (_hover) ...[
              _SiteAction(icon: LucideIcons.plugZap, tooltip: '测试连接', onTap: widget.onTest),
              _SiteAction(icon: LucideIcons.users, tooltip: '建团队', onTap: widget.onTeam),
              _SiteAction(
                icon: LucideIcons.trash2,
                tooltip: '移除',
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
          child: Icon(icon, size: 14, color: danger ? PB.danger : PB.textTertiary),
        ),
      ),
    );
  }
}
