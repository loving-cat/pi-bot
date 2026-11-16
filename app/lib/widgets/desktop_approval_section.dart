import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../l10n/l10n.dart';
import '../scope.dart';
import '../theme.dart';
import 'toast.dart';

/// 设置里「这台电脑上的批准与操作」面板（系统标签页，和授权面板同页）。
///
/// ## 为什么这两个开关放在一起
///
/// 它们解决的是同一类问题：**"它明明有权限，为什么就是不干活"**。
///
/// | 开关 | 不开的时候 | 开了之后 |
/// |---|---|---|
/// | 允许在本机批准 | 动鼠标/跑命令的申请必须用手机点；不用手机端就什么都批不了 | 桌面上也能批（代价：能跑命令的 bot 理论上能自己点） |
/// | 信任合成输入 | 远程控制软件一直在假装"有人动鼠标"→ 它永远让开 | 认出"光标没动"就继续干；你真动鼠标照样让开 |
///
/// 两个都是**放宽**，所以服务端都要求 nonce 并记审计；面板上也把代价直接写出来 ——
/// 藏起来不说，用户点开之后才发现"怎么感觉变松了"，那才是真的坑。
class DesktopApprovalSection extends StatefulWidget {
  const DesktopApprovalSection({super.key});

  @override
  State<DesktopApprovalSection> createState() => _DesktopApprovalSectionState();
}

class _DesktopApprovalSectionState extends State<DesktopApprovalSection> {
  bool _busy = false;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) {
      AppScope.of(context).loadDesktopSettings();
    });
  }

  Future<void> _patch(Map<String, dynamic> patch) async {
    if (_busy) return;
    setState(() => _busy = true);
    final s = L10n.s(context);
    final err = await AppScope.of(context).setDesktopSettings(patch);
    if (!mounted) return;
    setState(() => _busy = false);
    toast(
      context,
      err ?? s.t('desk.saved'),
      kind: err == null ? ToastKind.success : ToastKind.error,
    );
  }

  @override
  Widget build(BuildContext context) {
    final s = L10n.s(context);
    final state = AppScope.of(context);
    final settings = state.desktopSettings;
    final allowLocal = settings['allowLocalApproval'] == true;
    final trustPhantom = settings['trustPhantomInput'] == true;
    final awayMinutes = ((settings['awayAfterMs'] as num?)?.toInt() ?? 0) ~/ 60000;
    final synthetic = state.desktopEnvironment?['syntheticSource'] == true;

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Row(
          children: [
            Icon(LucideIcons.shieldAlert, size: 16, color: PB.warn),
            const SizedBox(width: 8),
            Text(s.t('desk.title'), style: const TextStyle(fontSize: PB.fsLg, fontWeight: FontWeight.w600)),
          ],
        ),
        const SizedBox(height: 4),
        Text(s.t('desk.subtitle'), style: TextStyle(fontSize: PB.fsXs, color: PB.textTertiary)),
        const SizedBox(height: 10),
        Container(
          decoration: BoxDecoration(
            color: PB.bgPane,
            borderRadius: BorderRadius.circular(PB.rLg),
            border: Border.all(color: PB.borderSecondary),
          ),
          child: Column(
            children: [
              SwitchListTile(
                value: allowLocal,
                onChanged: _busy ? null : (v) => _patch({'allowLocalApproval': v}),
                title: Text(s.t('desk.allowLocal'), style: const TextStyle(fontSize: PB.fsSm)),
                subtitle: Text(s.t('desk.allowLocalHint'),
                    style: TextStyle(fontSize: PB.fsXs, color: PB.textTertiary, height: 1.5)),
                dense: true,
              ),
              const Divider(height: 1),
              SwitchListTile(
                value: trustPhantom,
                onChanged: _busy ? null : (v) => _patch({'trustPhantomInput': v}),
                title: Text(s.t('desk.trustPhantom'), style: const TextStyle(fontSize: PB.fsSm)),
                subtitle: Text(s.t('desk.trustPhantomHint'),
                    style: TextStyle(fontSize: PB.fsXs, color: PB.textTertiary, height: 1.5)),
                dense: true,
              ),
              const Divider(height: 1),
              SwitchListTile(
                value: awayMinutes > 0,
                onChanged: _busy
                    ? null
                    : (v) => _patch({'awayAfterMs': v ? 90 * 60 * 1000 : 0}),
                title: Text(s.t('desk.awayAfter'), style: const TextStyle(fontSize: PB.fsSm)),
                subtitle: Text(
                  '${s.t('desk.awayAfterHint')}'
                  '${awayMinutes > 0 ? '\n${s.t('desk.minutes')}: $awayMinutes' : ''}',
                  style: TextStyle(fontSize: PB.fsXs, color: PB.textTertiary, height: 1.5),
                ),
                dense: true,
              ),
            ],
          ),
        ),
        const SizedBox(height: 8),
        Row(
          children: [
            Icon(
              synthetic ? LucideIcons.activity : LucideIcons.checkCircle2,
              size: 13,
              color: synthetic ? PB.warn : PB.success,
            ),
            const SizedBox(width: 6),
            Expanded(
              child: Text(
                '${s.t('desk.diagnose')}：${synthetic ? s.t('desk.synthetic') : s.t('desk.clean')}',
                style: TextStyle(fontSize: PB.fsXs, color: PB.textTertiary),
              ),
            ),
          ],
        ),
      ],
    );
  }
}
