import 'dart:async';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../platform.dart';
import '../native.dart';
import '../notify.dart';
import '../scope.dart';
import '../theme.dart';
import '../widgets/group_limits_section.dart';
import '../widgets/user_name_section.dart';
import '../widgets/model_group_editor.dart';
import '../widgets/server_config_section.dart';
import '../widgets/log_section.dart';
import '../widgets/skills_library.dart';
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
      appBar: AppBar(
        toolbarHeight: 58,
        title: const Text('设置'),
        actions: [
          IconButton(
            tooltip: '刷新',
            onPressed: () {
              state.loadPairingInfo();
              state.refresh();
            },
            icon: const Icon(LucideIcons.refreshCw, size: 20),
          ),
          const SizedBox(width: 8),
        ],
      ),
      body: Center(
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 680),
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
                      2 => const [SkillsLibrarySection()],
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
        title: '手机连接',
        subtitle: isHostPlatform ? '手机扫下面的码就能连上这台电脑' : '这台设备是通过配对连上服务端的',
      ),
      // ★ 二维码只有**宿主端**（跑服务端的那台电脑）才画。
      //
      //   以前这里只判 `pairing != null` —— 可手机连上自己的服务端之后
      //   pairing 也非空，于是手机上也会画出一张"等人来扫"的码：
      //   用户看到的是"手机端跟电脑端一模一样，也在等待被扫码"。
      //   手机上该给的是"我连的是哪台 / 重新扫码"。
      if (isHostPlatform && pairing != null) ...[
        _Card(
          child: Column(
            children: [
              // ★ 这里以前画一张二维码给手机扫。
              //   扫码入口已经取消了（真机相机起不来），再画一张没人扫得了的码
              //   只会让人对着它发呆 —— 直接给**地址**和**配对码**，
              //   手机上照着填就行。
              Row(
                children: [
                  const Icon(
                    LucideIcons.link,
                    size: 14,
                    color: PB.textTertiary,
                  ),
                  const SizedBox(width: 6),
                  Expanded(
                    child: Text(
                      base,
                      style: const TextStyle(
                        fontFamily: PB.monoFamily,
                        fontFamilyFallback: PB.monoFallback,
                        fontSize: PB.fsSm,
                        color: PB.textSecondary,
                      ),
                    ),
                  ),
                  IconButton(
                    tooltip: '复制地址',
                    icon: const Icon(LucideIcons.copy, size: 15),
                    onPressed: () {
                      Clipboard.setData(ClipboardData(text: base));
                      ScaffoldMessenger.of(context).showSnackBar(
                        const SnackBar(
                          content: Text('地址已复制'),
                          duration: Duration(milliseconds: 1200),
                        ),
                      );
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
                    style: const TextStyle(
                      fontFamily: PB.monoFamily,
                      fontFamilyFallback: PB.monoFallback,
                      fontSize: 30,
                      fontWeight: FontWeight.w700,
                      letterSpacing: 7,
                      color: PB.accentBright,
                    ),
                  ),
                  const SizedBox(width: 6),
                  GestureDetector(
                    onTap: () {
                      Clipboard.setData(
                        ClipboardData(text: '${pairing['code']}'),
                      );
                      ScaffoldMessenger.of(context).showSnackBar(
                        const SnackBar(
                          content: Text('配对码已复制'),
                          duration: Duration(milliseconds: 1200),
                        ),
                      );
                    },
                    child: const Icon(
                      LucideIcons.copy,
                      size: 15,
                      color: PB.textQuaternary,
                    ),
                  ),
                ],
              ),
              const SizedBox(height: 4),
              Text(
                remaining > 0 ? '$remaining 秒后换新码' : '正在换码…',
                style: const TextStyle(
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
                      const Text(
                        '已连接的服务端',
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
                              state.serverUrl ?? '（未知）',
                              style: const TextStyle(
                                fontFamily: PB.monoFamily,
                                fontFamilyFallback: PB.monoFallback,
                                fontSize: PB.fsSm,
                                color: PB.textPrimary,
                              ),
                            ),
                          ),
                          const Icon(
                            LucideIcons.smartphone,
                            size: 16,
                            color: PB.textQuaternary,
                          ),
                        ],
                      ),
                      const SizedBox(height: 4),
                      const Text(
                        '这台手机上还是这台电脑的码 —— 换一台电脑就连它的二维码、'
                        '或者手填它的地址。',
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
                    leading: const Icon(
                      LucideIcons.qrCode,
                      size: 20,
                      color: PB.accent,
                    ),
                    title: const Text(
                      '重新扫码配对',
                      style: TextStyle(fontSize: PB.fsSm),
                    ),
                    subtitle: const Text(
                      '换电脑、或者配对码失效了就点这里',
                      style: TextStyle(
                        fontSize: PB.fsXxs,
                        color: PB.textQuaternary,
                      ),
                    ),
                    onTap: () async {
                      await state.signOut();
                      if (context.mounted) Navigator.pop(context);
                    },
                  ),
                ),
              ],
              const SizedBox(height: 14),
              const _Hint(
                '手机和电脑要在同一个 WiFi 下。\n'
                '手机装 pi-bot App → 点「扫码配对」→ 扫上面这个码。',
              ),
            ],
          ),
        ),
        const SizedBox(height: 10),
        _Card(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              const Text(
                '手动填地址',
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
                      const Icon(
                        LucideIcons.network,
                        size: 14,
                        color: PB.textQuaternary,
                      ),
                      const SizedBox(width: 8),
                      Expanded(
                        child: SelectableText(
                          '${(addr as Map)['url']}',
                          style: const TextStyle(
                            fontFamily: PB.monoFamily,
                            fontFamilyFallback: PB.monoFallback,
                            fontSize: PB.fsXs,
                            color: PB.textSecondary,
                          ),
                        ),
                      ),
                      Text(
                        '${addr['name']}',
                        style: const TextStyle(
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
        const _Card(
          child: _Hint(
            '服务端配的是固定 token（PI_BOT_TOKEN），没有二维码。手机端在「固定 token」页填那个 token 就行。',
          ),
        ),
    ];
  }

  /// 标签页二：服务端与运行参数
  List<Widget> get _serverTab {
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
      const _SectionTitle(icon: LucideIcons.monitorSmartphone, title: '已连接的设备'),
      _Card(
        child: state.devices.isEmpty
            ? const _Hint('还没有手机配对过')
            : Column(
                children: [
                  for (final d in state.devices)
                    Padding(
                      padding: const EdgeInsets.symmetric(vertical: 4),
                      child: Row(
                        children: [
                          const Icon(
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
                                  style: const TextStyle(
                                    fontSize: PB.fsSm,
                                    color: PB.textPrimary,
                                  ),
                                ),
                                Text(
                                  '最后活跃 ${formatTime((d['lastSeenAt'] as num?)?.toInt() ?? 0)}',
                                  style: const TextStyle(
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
                            child: const Text(
                              '移除',
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
      const _SectionTitle(icon: LucideIcons.server, title: '服务端'),
      _Card(
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            _InfoRow('连接方式', state.localMode ? '本机直连（无需配对）' : '远程配对'),
            _InfoRow('地址', state.serverUrl ?? '-'),
            _InfoRow('主机', info?.hostname ?? '-'),
            _InfoRow('模型', info?.model ?? '-'),
            _InfoRow('工具', info?.tools.join(', ') ?? '-'),
            _InfoRow('工作目录', info?.workspace ?? '-'),
            // ★ 数据目录要显式给用户看：房间/会话/上传/附件都在这儿。
            //   以前它跟着安装目录跑，换个安装位置就变成“数据没了”。
            _InfoRow('数据目录', info?.dataDir ?? '-'),
            _InfoRow('版本', info?.version ?? '-'),
            _InfoRow('设备名', state.deviceName),
            const SizedBox(height: 6),
            _UpdateRow(state: state),
          ],
        ),
      ),
    ];
  }

  /// 标签页四：高级（通知与操作）
  List<Widget> get _advancedTab {
    final state = AppScope.read(context);
    return [
      // 「后台通知」是手机专属（前台服务 + 电池白名单），桌面端不显示
      if (isMobilePlatform) ...[
        const SizedBox(height: 22),
        const _SectionTitle(
          icon: LucideIcons.bellRing,
          title: '后台通知',
          subtitle: '锁屏也能收到机器人干完活的消息',
        ),
        _Card(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              const _Hint(
                '不走 FCM。App 会起一个低优先级的常驻通知保住连接，\n'
                '机器人干完活时再单独推一条消息通知。',
              ),
              const SizedBox(height: 14),
              SizedBox(
                width: double.infinity,
                child: OutlinedButton.icon(
                  onPressed: () async {
                    await Notifier.init();
                    await Notifier.show(
                      title: 'pi-bot 通知测试',
                      body: '看到这条说明通知是通的 ✅',
                      roomId: null,
                    );
                  },
                  icon: const Icon(LucideIcons.bellRing, size: 16),
                  label: const Text('发一条测试通知'),
                ),
              ),
              const SizedBox(height: 8),
              SizedBox(
                width: double.infinity,
                child: OutlinedButton.icon(
                  onPressed: () => Native.requestIgnoreBatteryOptimizations(),
                  icon: const Icon(LucideIcons.batteryCharging, size: 16),
                  label: const Text('加入电池白名单'),
                ),
              ),
              const SizedBox(height: 10),
              const Text(
                '国产 ROM 不加白名单的话，常驻服务也会被系统清掉，通知就收不到了。',
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
      const _SectionTitle(icon: LucideIcons.slidersHorizontal, title: '操作'),
      _Card(
        child: Column(
          children: [
            if (isHostPlatform)
              ListTile(
                contentPadding: EdgeInsets.zero,
                leading: const Icon(LucideIcons.house, size: 20),
                title: const Text(
                  '回到本机直连',
                  style: TextStyle(fontSize: PB.fsSm),
                ),
                subtitle: const Text(
                  '重新连 127.0.0.1:8787（桌面端就是宿主）',
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
                isHostPlatform ? '切到别的服务端' : '断开重新配对',
                style: const TextStyle(fontSize: PB.fsSm, color: PB.danger),
              ),
              onTap: () async {
                await state.signOut();
                if (context.mounted) Navigator.pop(context);
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
/// 以前设置页是一条 760 行的长列表（七块内容），找东西全靠滚。
/// 拆成标签页后每页只放同一类东西；切换用带方向感的推入动画，
/// 而不是原地淡入淡出 —— 让"翻页"这件事有空间感。
class _SettingsTabs extends StatelessWidget {
  const _SettingsTabs({required this.index, required this.onChanged});

  final int index;
  final ValueChanged<int> onChanged;

  static const _items = <({IconData icon, String label})>[
    (icon: LucideIcons.smartphone, label: '连接'),
    (icon: LucideIcons.server, label: '服务端'),
    (icon: LucideIcons.sparkles, label: '技能'),
    (icon: LucideIcons.slidersHorizontal, label: '高级'),
  ];

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(14, 4, 14, 10),
      child: Row(
        children: [
          for (var i = 0; i < _items.length; i++) ...[
            if (i > 0) const SizedBox(width: 6),
            _TabPill(
              icon: _items[i].icon,
              label: _items[i].label,
              selected: i == index,
              onTap: () => onChanged(i),
            ),
          ],
        ],
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
        ? PB.accent.withValues(alpha: 0.16)
        : (_hover ? PB.bgHover : Colors.transparent);
    final fg = widget.selected
        ? PB.accent
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
                  ? PB.accent.withValues(alpha: 0.35)
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
            style: const TextStyle(
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
                style: const TextStyle(
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
      style: const TextStyle(
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
    setState(() => _checking = true);
    final info = await widget.state.checkUpdate(force: true);
    if (!mounted) return;
    setState(() => _checking = false);

    if (info == null) {
      ScaffoldMessenger.maybeOf(context)
          ?.showSnackBar(const SnackBar(content: Text('检查更新失败（服务端没连上或网络不通）')));
      return;
    }
    if (!info.ok) {
      ScaffoldMessenger.maybeOf(context)
          ?.showSnackBar(SnackBar(content: Text(info.reason)));
      return;
    }
    if (!info.update) {
      ScaffoldMessenger.maybeOf(context)
          ?.showSnackBar(SnackBar(content: Text('已经是最新版本（${info.current}）')));
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
        ScaffoldMessenger.maybeOf(context)
            ?.showSnackBar(SnackBar(content: Text('下载失败：${result.error}')));
      }
    }
  }

  @override
  Widget build(BuildContext context) {
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
          label: Text(_checking ? '检查中…' : '检查更新'),
          style: TextButton.styleFrom(
            padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 4),
            minimumSize: Size.zero,
            tapTargetSize: MaterialTapTargetSize.shrinkWrap,
            foregroundColor: PB.accent,
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
              style: const TextStyle(
                fontSize: PB.fsXs,
                color: PB.textQuaternary,
              ),
            ),
          ),
          Expanded(
            child: SelectableText(
              value,
              style: const TextStyle(
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
