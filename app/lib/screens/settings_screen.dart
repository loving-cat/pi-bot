import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../platform.dart';
import '../native.dart';
import '../notify.dart';
import '../scope.dart';
import '../theme.dart';
import '../widgets/window_title_bar.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

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
  int _qrStamp = DateTime.now().millisecondsSinceEpoch;

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

  @override
  void dispose() {
    _ticker?.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final state = AppScope.of(context);
    final info = state.serverInfo;
    final pairing = state.pairing;
    final base = state.serverUrl ?? '';

    final expiresAt = pairing?['expiresAt'] is num ? (pairing!['expiresAt'] as num).toInt() : 0;
    final remaining = expiresAt > 0 ? ((expiresAt - DateTime.now().millisecondsSinceEpoch) / 1000).round() : 0;

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
              setState(() => _qrStamp = DateTime.now().millisecondsSinceEpoch);
            },
            icon: const Icon(LucideIcons.refreshCw, size: 20),
          ),
          // 别让"刷新"顶到窗口控制按钮下面去
          const WindowControlsSpacer(),
          const SizedBox(width: 8),
        ],
      ),
      body: Center(
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 620),
          child: ListView(
            padding: const EdgeInsets.fromLTRB(14, 6, 14, 40),
            children: [
              _SectionTitle(
                icon: LucideIcons.smartphone,
                title: '手机连接',
                subtitle: isHostPlatform
                    ? '手机扫下面的码就能连上这台电脑'
                    : '这台设备是通过配对连上服务端的',
              ),
              if (pairing != null) ...[
                _Card(
                  child: Column(
                    children: [
                      Container(
                        padding: const EdgeInsets.all(10),
                        decoration: BoxDecoration(
                          color: Colors.white,
                          borderRadius: BorderRadius.circular(PB.r2xl),
                        ),
                        child: Image.network(
                          '$base/api/qr.png?t=$_qrStamp',
                          width: 196,
                          height: 196,
                          errorBuilder: (c, e, s) => const SizedBox(
                            width: 196,
                            height: 196,
                            child: Center(child: Text('二维码加载失败', style: TextStyle(color: Colors.black54))),
                          ),
                        ),
                      ),
                      const SizedBox(height: 16),
                      Row(
                        mainAxisAlignment: MainAxisAlignment.center,
                        children: [
                          Text(
                            '${pairing['code']}',
                            style: const TextStyle(
                              fontFamily: 'monospace',
                              fontSize: 30,
                              fontWeight: FontWeight.w700,
                              letterSpacing: 7,
                              color: PB.accentBright,
                            ),
                          ),
                          const SizedBox(width: 6),
                          GestureDetector(
                            onTap: () {
                              Clipboard.setData(ClipboardData(text: '${pairing['code']}'));
                              ScaffoldMessenger.of(context).showSnackBar(
                                const SnackBar(
                                  content: Text('配对码已复制'),
                                  duration: Duration(milliseconds: 1200),
                                ),
                              );
                            },
                            child: const Icon(LucideIcons.copy, size: 15, color: PB.textQuaternary),
                          ),
                        ],
                      ),
                      const SizedBox(height: 4),
                      Text(
                        remaining > 0 ? '$remaining 秒后换新码' : '正在换码…',
                        style: const TextStyle(fontSize: PB.fsXs, color: PB.textQuaternary),
                      ),
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
                        style: TextStyle(fontSize: PB.fsXs, fontWeight: FontWeight.w600, color: PB.textTertiary),
                      ),
                      const SizedBox(height: 8),
                      for (final addr in ((pairing['addresses'] as List?) ?? const []))
                        Padding(
                          padding: const EdgeInsets.only(bottom: 6),
                          child: Row(
                            children: [
                              const Icon(LucideIcons.network, size: 14, color: PB.textQuaternary),
                              const SizedBox(width: 8),
                              Expanded(
                                child: SelectableText(
                                  '${(addr as Map)['url']}',
                                  style: const TextStyle(
                                    fontFamily: 'monospace',
                                    fontSize: PB.fsXs,
                                    color: PB.textSecondary,
                                  ),
                                ),
                              ),
                              Text(
                                '${addr['name']}',
                                style: const TextStyle(fontSize: PB.fsXxs, color: PB.textQuaternary),
                              ),
                            ],
                          ),
                        ),
                    ],
                  ),
                ),
              ] else
                const _Card(
                  child: _Hint('服务端配的是固定 token（PI_BOT_TOKEN），没有二维码。手机端在「固定 token」页填那个 token 就行。'),
                ),

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
                                  const Icon(LucideIcons.smartphone, size: 16, color: PB.textTertiary),
                                  const SizedBox(width: 10),
                                  Expanded(
                                    child: Column(
                                      crossAxisAlignment: CrossAxisAlignment.start,
                                      children: [
                                        Text(
                                          '${d['name']}',
                                          style: const TextStyle(fontSize: PB.fsSm, color: PB.textPrimary),
                                        ),
                                        Text(
                                          '最后活跃 ${formatTime((d['lastSeenAt'] as num?)?.toInt() ?? 0)}',
                                          style: const TextStyle(fontSize: PB.fsXxs, color: PB.textQuaternary),
                                        ),
                                      ],
                                    ),
                                  ),
                                  TextButton(
                                    onPressed: () => state.revokeDevice('${d['token']}'),
                                    child: const Text('移除', style: TextStyle(color: PB.danger, fontSize: PB.fsXs)),
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
                    _InfoRow('版本', info?.version ?? '-'),
                    _InfoRow('设备名', state.deviceName),
                  ],
                ),
              ),

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
                      style: TextStyle(fontSize: PB.fsXxs, color: PB.textQuaternary, height: 1.5),
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
                        title: const Text('回到本机直连', style: TextStyle(fontSize: PB.fsSm)),
                        subtitle: const Text(
                          '重新连 127.0.0.1:8787（桌面端就是宿主）',
                          style: TextStyle(fontSize: PB.fsXxs, color: PB.textQuaternary),
                        ),
                        onTap: () => state.connectLocal(),
                      ),
                    ListTile(
                      contentPadding: EdgeInsets.zero,
                      leading: Icon(
                        isHostPlatform ? LucideIcons.unlink : LucideIcons.arrowLeftRight,
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
            style: const TextStyle(fontSize: PB.fsSm, fontWeight: FontWeight.w600, color: PB.textSecondary),
          ),
          if (subtitle != null) ...[
            const SizedBox(width: 10),
            Expanded(
              child: Text(
                subtitle!,
                style: const TextStyle(fontSize: PB.fsXxs, color: PB.textQuaternary),
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
      style: const TextStyle(fontSize: PB.fsXs, color: PB.textQuaternary, height: 1.7),
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
            child: Text(label, style: const TextStyle(fontSize: PB.fsXs, color: PB.textQuaternary)),
          ),
          Expanded(
            child: SelectableText(
              value,
              style: const TextStyle(fontSize: PB.fsXs, color: PB.textSecondary, fontFamily: 'monospace'),
            ),
          ),
        ],
      ),
    );
  }
}
