import 'dart:async';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../platform.dart';
import '../native.dart';
import '../notify.dart';
import '../scope.dart';
import '../theme.dart';
import '../l10n/l10n.dart';
import '../widgets/language_card.dart';
import '../window_chrome.dart';
import '../widgets/toast.dart';
import '../widgets/decision_section.dart';
import '../widgets/group_limits_section.dart';
import '../widgets/user_name_section.dart';
import '../widgets/model_group_editor.dart';
import '../widgets/server_config_section.dart';
import '../widgets/log_section.dart';
import '../widgets/mcp_section.dart';
import '../widgets/lessons_section.dart';
import '../widgets/skills_library.dart';
import '../widgets/sites_section.dart';
import '../motion.dart';

import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../app_state.dart';
import '../widgets/update_prompt.dart';

/// 设置页。
///
/// 桌面端在这里「展示」二维码给手机扫（PC 是宿主，不需要自己去配对）。
/// 手机端在这里能看到自己连的是哪台机器，也能断开重配。
class SettingsScreen extends StatefulWidget {
  const SettingsScreen({super.key});

  @override
  State<SettingsScreen> createState() => _SettingsScreenState();
}

class _SettingsScreenState extends State<SettingsScreen> {
  Timer? _ticker;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) {
      AppScope.read(context).loadPairingInfo();
    });
    _ticker = Timer.periodic(const Duration(seconds: 1), (_) {
      if (mounted) setState(() {});
    });
  }

  /// 当前选中的标签页
  int _tab = 0;

  @override
  void dispose() {
    _ticker?.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final state = AppScope.of(context);

    return Scaffold(
      backgroundColor: PB.bgApp,
      appBar: chromeAppBar(
        context,
        AppBar(
          flexibleSpace: const WindowDragArea(),
          toolbarHeight: 58,
          title: Text(L10n.s(context).t('settings.title')),
          actions: [
            IconButton(
              tooltip: L10n.s(context).t('common.refresh'),
              onPressed: () {
                state.loadPairingInfo();
                state.refresh();
              },
              icon: const Icon(LucideIcons.refreshCw, size: 20),
            ),
            const SizedBox(width: 8),
          ],
        ),
      ),
      body: Center(
        child: ConstrainedBox(
          constraints: BoxConstraints(maxWidth: _tab == 3 ? 980 : 680),
          child: Column(
            children: [
              _SettingsTabs(
                index: _tab,
                onChanged: (i) => setState(() => _tab = i),
              ),
              Expanded(
                child: AnimatedSwitcher(
                  duration: Motion.base,
                  switchInCurve: Motion.inC,
                  switchOutCurve: Curves.easeIn,
                  // 轻微横向推入：让翻页有方向感，而不是原地淡入淡出
                  transitionBuilder: (child, anim) {
                    final slide = Tween<Offset>(
                      begin: const Offset(0.035, 0),
                      end: Offset.zero,
                    ).animate(anim);
                    return FadeTransition(
                      opacity: anim,
                      child: SlideTransition(position: slide, child: child),
                    );
                  },
                  child: ListView(
                    key: ValueKey<int>(_tab),
                    padding: const EdgeInsets.fromLTRB(14, 6, 14, 40),
                    children: switch (_tab) {
                      0 => _connectTab,
                      1 => _serverTab,
                      2 => const [SkillsLibrarySection(), LessonsSection()],
                      3 => const [McpSection()],
                      4 => const [SitesSection()],
                      _ => _advancedTab,
                    },
                  ),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }

  /// 标签页一：手机连接与设备
  List<Widget> get _connectTab {
    final s = L10n.s(context);
    final state = AppScope.read(context);
    final pairing = AppScope.read(context).pairing;
    final base = AppScope.read(context).serverUrl ?? '';
    final expiresAt = pairing?['expiresAt'] is num
        ? (pairing!['expiresAt'] as num).toInt()
        : 0;
    final remaining = expiresAt > 0
        ? ((expiresAt - DateTime.now().millisecondsSinceEpoch) / 1000).round()
        : 0;
    return [
      _SectionTitle(
        icon: LucideIcons.smartphone,
        title: s.t('settings.connect.title'),
        subtitle: isHostPlatform
            ? s.t('settings.connect.subtitleHost')
            : s.t('settings.connect.subtitleRemote'),
      ),
      // ★ 二维码只有**宿主端**（跑服务端的那台电脑）才画。
      //
      //   只判 `pairing != null` 不够：手机连上自己的服务端之后 pairing 也非空，
      //   于是手机上也会画出一张"等人来扫"的码，用户看到的是"手机端跟电脑端
      //   一模一样，也在等待被扫码"。手机上该给的是"我连的是哪台 / 重新扫码"。
      if (isHostPlatform && pairing != null) ...[
        _Card(
          child: Column(
            children: [
              // ★ 这里不画二维码给手机扫：扫码入口已取消（相机起不来），
              //   再画一张没人扫得了的码只会让人对着它发呆 —— 直接给
              //   **地址**和**配对码**，手机上照着填就行。
              Row(
                children: [
                  Icon(
                    LucideIcons.link,
                    size: 14,
                    color: PB.textTertiary,
                  ),
                  const SizedBox(width: 6),
                  Expanded(
                    child: Text(
                      base,
                      style: TextStyle(
                        fontFamily: PB.monoFamily,
                        fontFamilyFallback: PB.monoFallback,
                        fontSize: PB.fsSm,
                        color: PB.textSecondary,
                      ),
                    ),
                  ),
                  IconButton(
                    tooltip: s.t('settings.connect.copyUrl'),
                    icon: const Icon(LucideIcons.copy, size: 15),
                    onPressed: () {
                      Clipboard.setData(ClipboardData(text: base));
                      toast(context, s.t('settings.connect.urlCopied'));
                    },
                  ),
                ],
              ),
              const SizedBox(height: 6),
              Row(
                mainAxisAlignment: MainAxisAlignment.center,
                children: [
                  Text(
                    '${pairing['code']}',
                    style: TextStyle(
                      fontFamily: PB.monoFamily,
                      fontFamilyFallback: PB.monoFallback,
                      fontSize: 30,
                      fontWeight: FontWeight.w700,
                      letterSpacing: 7,
                      color: PB.colors(context).accentBright,
                    ),
                  ),
                  const SizedBox(width: 6),
                  GestureDetector(
                    onTap: () {
                      Clipboard.setData(
                        ClipboardData(text: '${pairing['code']}'),
                      );
                      toast(context, s.t('settings.connect.codeCopied'));
                    },
                    child: Icon(
                      LucideIcons.copy,
                      size: 15,
                      color: PB.textQuaternary,
                    ),
                  ),
                ],
              ),
              const SizedBox(height: 4),
              Text(
                remaining > 0
                    ? s.tf('settings.connect.codeRefreshIn', {'n': remaining})
                    : s.t('settings.connect.codeRefreshing'),
                style: TextStyle(
                  fontSize: PB.fsXs,
                  color: PB.textQuaternary,
                ),
              ),
              // 手机端（远程客户端）：说清楚"我连的是哪台"，再给一个重新扫码
              if (!isHostPlatform) ...[
                _Card(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        s.t('settings.connect.connectedServer'),
                        style: TextStyle(
                          fontSize: PB.fsXs,
                          color: PB.textTertiary,
                        ),
                      ),
                      const SizedBox(height: 6),
                      Row(
                        children: [
                          Expanded(
                            child: Text(
                              state.serverUrl ??
                                  s.t('settings.connect.unknownServer'),
                              style: TextStyle(
                                fontFamily: PB.monoFamily,
                                fontFamilyFallback: PB.monoFallback,
                                fontSize: PB.fsSm,
                                color: PB.textPrimary,
                              ),
                            ),
                          ),
                          Icon(
                            LucideIcons.smartphone,
                            size: 16,
                            color: PB.textQuaternary,
                          ),
                        ],
                      ),
                      const SizedBox(height: 4),
                      Text(
                        s.t('settings.connect.remoteHint'),
                        style: TextStyle(
                          fontSize: PB.fsXxs,
                          color: PB.textQuaternary,
                          height: 1.6,
                        ),
                      ),
                    ],
                  ),
                ),
                const SizedBox(height: 10),
                _Card(
                  child: ListTile(
                    contentPadding: EdgeInsets.zero,
                    // 这个按钮实际是"退出登录并重连"，不是扫码 ——
                    // 用二维码图标会让人以为还要扫一次。
                    leading: Icon(
                      LucideIcons.refreshCw,
                      size: 20,
                      color: PB.colors(context).accentBright,
                    ),
                    title: Text(
                      s.t('settings.connect.rescan'),
                      style: const TextStyle(fontSize: PB.fsSm),
                    ),
                    subtitle: Text(
                      s.t('settings.connect.rescanSubtitle'),
                      style: TextStyle(
                        fontSize: PB.fsXxs,
                        color: PB.textQuaternary,
                      ),
                    ),
                    onTap: () async {
                      await state.signOut();
                      if (mounted) Navigator.pop(context);
                    },
                  ),
                ),
              ],
              const SizedBox(height: 14),
              _Hint(s.t('settings.connect.wifiHint')),
            ],
          ),
        ),
        const SizedBox(height: 10),
        _Card(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                s.t('settings.connect.manualAddress'),
                style: TextStyle(
                  fontSize: PB.fsXs,
                  fontWeight: FontWeight.w600,
                  color: PB.textTertiary,
                ),
              ),
              const SizedBox(height: 8),
              for (final addr in ((pairing['addresses'] as List?) ?? const []))
                Padding(
                  padding: const EdgeInsets.only(bottom: 6),
                  child: Row(
                    children: [
                      Icon(
                        LucideIcons.network,
                        size: 14,
                        color: PB.textQuaternary,
                      ),
                      const SizedBox(width: 8),
                      Expanded(
                        child: SelectableText(
                          '${(addr as Map)['url']}',
                          style: TextStyle(
                            fontFamily: PB.monoFamily,
                            fontFamilyFallback: PB.monoFallback,
                            fontSize: PB.fsXs,
                            color: PB.textSecondary,
                          ),
                        ),
                      ),
                      Text(
                        '${addr['name']}',
                        style: TextStyle(
                          fontSize: PB.fsXxs,
                          color: PB.textQuaternary,
                        ),
                      ),
                    ],
                  ),
                ),
            ],
          ),
        ),
      ] else
        _Card(child: _Hint(s.t('settings.connect.fixedTokenHint'))),
    ];
  }

  /// 标签页二：服务端与运行参数
  List<Widget> get _serverTab {
    final s = L10n.s(context);
    final state = AppScope.read(context);
    final info = state.serverInfo;
    return [
      const SizedBox(height: 22),
      // 本机服务端：默认全自动，环境不同的人可以自己指路径/数据目录
      const ServerConfigSection(),

      const SizedBox(height: 22),
      const LogSection(),

      const SizedBox(height: 22),
      // 我是谁（bot 会用它称呼你）
      const UserNameSection(),

      const SizedBox(height: 22),
      // 用户自己配的模型组（baseUrl + key + 一组模型名）
      const ModelGroupsSection(),

      const SizedBox(height: 22),
      // 群聊轮次：防 bot 解不了就互相聊个没完
      const GroupLimitsSection(),

      const SizedBox(height: 22),
      // 快速决策：把一批小判断交给专用决策模型（默认关闭）
      const DecisionSection(),

      const SizedBox(height: 22),
      _SectionTitle(
        icon: LucideIcons.monitorSmartphone,
        title: s.t('settings.server.devices'),
      ),
      _Card(
        child: state.devices.isEmpty
            ? _Hint(s.t('settings.server.noDevices'))
            : Column(
                children: [
                  for (final d in state.devices)
                    Padding(
                      padding: const EdgeInsets.symmetric(vertical: 4),
                      child: Row(
                        children: [
                          Icon(
                            LucideIcons.smartphone,
                            size: 16,
                            color: PB.textTertiary,
                          ),
                          const SizedBox(width: 10),
                          Expanded(
                            child: Column(
                              crossAxisAlignment: CrossAxisAlignment.start,
                              children: [
                                Text(
                                  '${d['name']}',
                                  style: TextStyle(
                                    fontSize: PB.fsSm,
                                    color: PB.textPrimary,
                                  ),
                                ),
                                Text(
                                  s.tf('settings.server.lastSeen', {
                                    'time': formatTime(
                                      (d['lastSeenAt'] as num?)?.toInt() ?? 0,
                                    ),
                                  }),
                                  style: TextStyle(
                                    fontSize: PB.fsXxs,
                                    color: PB.textQuaternary,
                                  ),
                                ),
                              ],
                            ),
                          ),
                          TextButton(
                            // 撤销走设备 id：接口不下发 token（那是设备的凭证）
                            onPressed: () => state.revokeDevice('${d['id']}'),
                            child: Text(
                              s.t('common.remove'),
                              style: TextStyle(
                                color: PB.danger,
                                fontSize: PB.fsXs,
                              ),
                            ),
                          ),
                        ],
                      ),
                    ),
                ],
              ),
      ),

      const SizedBox(height: 22),
      _SectionTitle(
        icon: LucideIcons.server,
        title: s.t('settings.server.title'),
      ),
      _Card(
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            _InfoRow(
              s.t('settings.server.mode'),
              state.localMode
                  ? s.t('settings.server.modeLocal')
                  : s.t('settings.server.modeRemote'),
            ),
            _InfoRow(s.t('settings.server.address'), state.serverUrl ?? '-'),
            _InfoRow(s.t('settings.server.hostname'), info?.hostname ?? '-'),
            _InfoRow(s.t('settings.server.model'), info?.model ?? '-'),
            _InfoRow(
              s.t('settings.server.tools'),
              info?.tools.join(', ') ?? '-',
            ),
            _InfoRow(s.t('settings.server.workspace'), info?.workspace ?? '-'),
            // ★ 数据目录要显式给用户看：房间/会话/上传/附件都在这儿。
            //   它不能跟着安装目录跑，否则换个安装位置就变成“数据没了”。
            _InfoRow(s.t('settings.server.dataDir'), info?.dataDir ?? '-'),
            _InfoRow(s.t('settings.server.version'), info?.version ?? '-'),
            _InfoRow(s.t('settings.server.deviceName'), state.deviceName),
            const SizedBox(height: 6),
            _UpdateRow(state: state),
          ],
        ),
      ),
    ];
  }

  /// 标签页四：高级（通知与操作）
  List<Widget> get _advancedTab {
    final s = L10n.s(context);
    final state = AppScope.read(context);
    return [
      // 「后台通知」是手机专属（前台服务 + 电池白名单），桌面端不显示
      if (isMobilePlatform) ...[
        const SizedBox(height: 22),
        _SectionTitle(
          icon: LucideIcons.bellRing,
          title: s.t('settings.notify.title'),
          subtitle: s.t('settings.notify.subtitle'),
        ),
        _Card(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              _Hint(s.t('settings.notify.hint')),
              const SizedBox(height: 14),
              SizedBox(
                width: double.infinity,
                child: OutlinedButton.icon(
                  onPressed: () async {
                    await Notifier.init();
                    await Notifier.show(
                      title: s.t('settings.notify.testTitle'),
                      body: s.t('settings.notify.testBody'),
                      roomId: null,
                    );
                  },
                  icon: const Icon(LucideIcons.bellRing, size: 16),
                  label: Text(s.t('settings.notify.testButton')),
                ),
              ),
              const SizedBox(height: 8),
              SizedBox(
                width: double.infinity,
                child: OutlinedButton.icon(
                  onPressed: () => Native.requestIgnoreBatteryOptimizations(),
                  icon: const Icon(LucideIcons.batteryCharging, size: 16),
                  label: Text(s.t('settings.notify.batteryButton')),
                ),
              ),
              const SizedBox(height: 10),
              Text(
                s.t('settings.notify.romHint'),
                style: TextStyle(
                  fontSize: PB.fsXxs,
                  color: PB.textQuaternary,
                  height: 1.5,
                ),
              ),
            ],
          ),
        ),
      ],

      const SizedBox(height: 22),
      _SectionTitle(
        icon: LucideIcons.languages,
        title: s.t('settings.language'),
      ),
      const LanguageCard(),

      const SizedBox(height: 22),
      _SectionTitle(
        icon: LucideIcons.slidersHorizontal,
        title: s.t('settings.actions.title'),
      ),
      _Card(
        child: Column(
          children: [
            if (isHostPlatform)
              ListTile(
                contentPadding: EdgeInsets.zero,
                leading: const Icon(LucideIcons.house, size: 20),
                title: Text(
                  s.t('settings.actions.reconnectLocal'),
                  style: const TextStyle(fontSize: PB.fsSm),
                ),
                subtitle: Text(
                  s.t('settings.actions.reconnectLocalSubtitle'),
                  style: TextStyle(
                    fontSize: PB.fsXxs,
                    color: PB.textQuaternary,
                  ),
                ),
                onTap: () => state.connectLocal(),
              ),
            ListTile(
              contentPadding: EdgeInsets.zero,
              leading: Icon(
                isHostPlatform
                    ? LucideIcons.unlink
                    : LucideIcons.arrowLeftRight,
                size: 20,
                color: PB.danger,
              ),
              title: Text(
                isHostPlatform
                    ? s.t('settings.actions.switchServer')
                    : s.t('settings.actions.repair'),
                style: TextStyle(fontSize: PB.fsSm, color: PB.danger),
              ),
              onTap: () async {
                await state.signOut();
                if (mounted) Navigator.pop(context);
              },
            ),
          ],
        ),
      ),
    ];
  }
}

/// 设置页顶部标签条。
///
/// 设置页拆成标签页，每页只放同一类东西；切换用带方向感的推入动画，
/// 而不是原地淡入淡出 —— 让"翻页"这件事有空间感。
///
/// 标签数量会随功能增长（连接 / 服务端 / 技能 / 系统 / 高级），
/// 所以整条做成可横向滚动，窄窗口下不会溢出。
class _SettingsTabs extends StatelessWidget {
  const _SettingsTabs({required this.index, required this.onChanged});

  final int index;
  final ValueChanged<int> onChanged;

  /// 标签图标与文案 key，顺序与 _SettingsScreenState._tab 一致。
  static const _items = <({IconData icon, String labelKey})>[
    (icon: LucideIcons.smartphone, labelKey: 'settings.tab.connect'),
    (icon: LucideIcons.server, labelKey: 'settings.tab.server'),
    (icon: LucideIcons.sparkles, labelKey: 'settings.tab.skills'),
    (icon: LucideIcons.plug, labelKey: 'settings.tab.sites'),
    (icon: LucideIcons.network, labelKey: 'settings.tab.system'),
    (icon: LucideIcons.slidersHorizontal, labelKey: 'settings.tab.advanced'),
  ];

  @override
  Widget build(BuildContext context) {
    final s = L10n.s(context);
    return Padding(
      padding: const EdgeInsets.fromLTRB(14, 4, 14, 10),
      // 可横向滚动：手机或窄窗口下五个标签排不下时不会溢出（Row 会报 RenderFlex overflow）
      child: SingleChildScrollView(
        scrollDirection: Axis.horizontal,
        child: Row(
          children: [
            for (var i = 0; i < _items.length; i++) ...[
              if (i > 0) const SizedBox(width: 6),
              _TabPill(
                icon: _items[i].icon,
                label: s.t(_items[i].labelKey),
                selected: i == index,
                onTap: () => onChanged(i),
              ),
            ],
          ],
        ),
      ),
    );
  }
}

class _TabPill extends StatefulWidget {
  const _TabPill({
    required this.icon,
    required this.label,
    required this.selected,
    required this.onTap,
  });

  final IconData icon;
  final String label;
  final bool selected;
  final VoidCallback onTap;

  @override
  State<_TabPill> createState() => _TabPillState();
}

class _TabPillState extends State<_TabPill> {
  bool _hover = false;

  @override
  Widget build(BuildContext context) {
    final bg = widget.selected
        ? PB.colors(context).accent.withValues(alpha: 0.16)
        : (_hover ? PB.bgHover : Colors.transparent);
    final fg = widget.selected
        ? PB.colors(context).accent
        : (_hover ? PB.textSecondary : PB.textTertiary);

    return MouseRegion(
      cursor: SystemMouseCursors.click,
      onEnter: (_) => setState(() => _hover = true),
      onExit: (_) => setState(() => _hover = false),
      child: GestureDetector(
        onTap: widget.onTap,
        child: AnimatedContainer(
          duration: Motion.fast,
          curve: Motion.hover,
          padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 7),
          decoration: BoxDecoration(
            color: bg,
            borderRadius: BorderRadius.circular(8),
            border: Border.all(
              color: widget.selected
                  ? PB.colors(context).accent.withValues(alpha: 0.35)
                  : PB.borderSecondary,
            ),
          ),
          child: Row(
            children: [
              Icon(widget.icon, size: 14, color: fg),
              const SizedBox(width: 6),
              Text(
                widget.label,
                style: TextStyle(
                  fontSize: PB.fsXs,
                  color: fg,
                  fontWeight: widget.selected
                      ? FontWeight.w600
                      : FontWeight.w400,
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _SectionTitle extends StatelessWidget {
  const _SectionTitle({required this.icon, required this.title, this.subtitle});

  final IconData icon;
  final String title;
  final String? subtitle;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(4, 14, 4, 10),
      child: Row(
        children: [
          Icon(icon, size: 15, color: PB.textTertiary),
          const SizedBox(width: 8),
          Text(
            title,
            style: TextStyle(
              fontSize: PB.fsSm,
              fontWeight: FontWeight.w600,
              color: PB.textSecondary,
            ),
          ),
          if (subtitle != null) ...[
            const SizedBox(width: 10),
            Expanded(
              child: Text(
                subtitle!,
                style: TextStyle(
                  fontSize: PB.fsXxs,
                  color: PB.textQuaternary,
                ),
                overflow: TextOverflow.ellipsis,
              ),
            ),
          ],
        ],
      ),
    );
  }
}

class _Card extends StatelessWidget {
  const _Card({required this.child});

  final Widget child;

  @override
  Widget build(BuildContext context) {
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.fromLTRB(16, 14, 16, 14),
      decoration: BoxDecoration(
        color: PB.bgBubble,
        borderRadius: BorderRadius.circular(PB.r2xl),
        border: Border.all(color: PB.borderTertiary),
      ),
      child: child,
    );
  }
}

class _Hint extends StatelessWidget {
  const _Hint(this.text);

  final String text;

  @override
  Widget build(BuildContext context) {
    return Text(
      text,
      textAlign: TextAlign.center,
      style: TextStyle(
        fontSize: PB.fsXs,
        color: PB.textQuaternary,
        height: 1.7,
      ),
    );
  }
}

/// 设置页里的"检查更新"一行。
///
/// 为什么手动入口有必要：启动时那次检查是静默的（失败不报错、点了"以后再说"就不再问），
/// 用户想主动确认一下有没有新版本时，得有个地方点。
class _UpdateRow extends StatefulWidget {
  const _UpdateRow({required this.state});

  final AppState state;

  @override
  State<_UpdateRow> createState() => _UpdateRowState();
}

class _UpdateRowState extends State<_UpdateRow> {
  bool _checking = false;

  Future<void> _check() async {
    if (_checking) return;
    final s = L10n.s(context);
    setState(() => _checking = true);
    final info = await widget.state.checkUpdate(force: true);
    if (!mounted) return;
    setState(() => _checking = false);

    if (info == null) {
      toast(context, s.t('settings.update.failed'));
      return;
    }
    if (!info.ok) {
      // 原样显示服务端给的原因（例如 HTTP 403、超时 8 秒）。
      // 以前统一说「服务端没连上或网络不通」，可实际失败经常是
      // GitHub API 限流 —— 用户看到「网络不通」会去查网络，白折腾。
      toast(
        context,
        info.reason.isEmpty ? s.t('settings.update.failed') : info.reason,
      );
      return;
    }
    if (!info.update) {
      toast(context, s.tf('settings.update.latest', {'version': info.current}));
      return;
    }
    // 有新版本：走同一个提示流程，用户确认后下载
    if (!mounted) return;
    final choice = await showUpdateDialog(context, info);
    if (!mounted) return;
    if (choice == UpdateChoice.later) {
      await widget.state.skipUpdateVersion(info.latest);
      return;
    }
    if (choice == UpdateChoice.openPage && info.pageUrl.isNotEmpty) {
      try {
        await Process.run(Platform.isWindows ? 'explorer' : 'open', [
          info.pageUrl,
        ]);
      } catch (_) {}
      return;
    }
    if (choice == UpdateChoice.download) {
      final result = await downloadUpdate(context, info);
      if (!mounted) return;
      if (result.ok) {
        await showDownloadDoneDialog(context, path: result.path!, info: info);
      } else if (result.error != null && result.error != '已取消') {
        toast(
          context,
          s.tf('settings.update.downloadFailed', {'error': result.error}),
        );
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    final s = L10n.s(context);
    return Row(
      children: [
        TextButton.icon(
          onPressed: _checking ? null : _check,
          icon: _checking
              ? const SizedBox(
                  width: 12,
                  height: 12,
                  child: CircularProgressIndicator(strokeWidth: 1.6),
                )
              : const Icon(Icons.refresh, size: 15),
          label: Text(
            _checking
                ? s.t('settings.update.checking')
                : s.t('settings.update.check'),
          ),
          style: TextButton.styleFrom(
            padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 4),
            minimumSize: Size.zero,
            tapTargetSize: MaterialTapTargetSize.shrinkWrap,
            foregroundColor: PB.colors(context).accent,
            textStyle: const TextStyle(fontSize: PB.fsXs),
          ),
        ),
      ],
    );
  }
}

class _InfoRow extends StatelessWidget {
  const _InfoRow(this.label, this.value);

  final String label;
  final String value;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 5),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          SizedBox(
            width: 72,
            child: Text(
              label,
              style: TextStyle(
                fontSize: PB.fsXs,
                color: PB.textQuaternary,
              ),
            ),
          ),
          Expanded(
            child: SelectableText(
              value,
              style: TextStyle(
                fontSize: PB.fsXs,
                color: PB.textSecondary,
                fontFamily: PB.monoFamily,
                fontFamilyFallback: PB.monoFallback,
              ),
            ),
          ),
        ],
      ),
    );
  }
}
