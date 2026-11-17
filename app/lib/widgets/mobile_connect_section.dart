import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../l10n/l10n.dart';
import '../scope.dart';
import '../theme.dart';
import '../screens/pair_screen.dart';

/// 手机端「连接」页：我连的是哪台电脑 / 是不是加密 / 怎么换一台。
///
/// ## 为什么单独一个 widget（而不是塞在 settings_screen 里）
///
/// 它原来就埋在 settings_screen 的 `_connectTab` 里，而且**嵌在宿主端的条件内**
/// （`if (isHostPlatform && pairing != null)`）—— 那个条件对手机恒为 false，
/// 于是这一整块从来没渲染过。表现是：手机连上电脑之后，设置里既看不到
/// "我连的是哪台"，也没有"换一台电脑"的入口，用户只能卸载重装清数据。
///
/// 抽成独立 widget 之后可以单独 pump 起来测（见 test/mobile_connect_section_test.dart），
/// 而不是依赖"在真机上点一遍"才发现它没显示。
class MobileConnectSection extends StatelessWidget {
  const MobileConnectSection({super.key});

  @override
  Widget build(BuildContext context) {
    final s = L10n.s(context);
    final state = AppScope.of(context);
    final accent = PB.colors(context).accentBright;
    final encrypted = state.serverFingerprint.isNotEmpty;

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Container(
          padding: const EdgeInsets.fromLTRB(14, 12, 14, 12),
          decoration: BoxDecoration(
            color: PB.bgPane,
            borderRadius: BorderRadius.circular(PB.rXl),
            border: Border.all(color: PB.borderTertiary),
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                s.t('settings.connect.connectedServer'),
                style: TextStyle(fontSize: PB.fsXs, color: PB.textTertiary),
              ),
              const SizedBox(height: 6),
              Row(
                children: [
                  Expanded(
                    child: Text(
                      state.serverUrl ?? s.t('settings.connect.unknownServer'),
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
              const SizedBox(height: 8),
              // 加密状态要显式写出来：用户有权知道"这条链路是不是明文"。
              Row(
                children: [
                  Icon(
                    encrypted ? LucideIcons.lock : LucideIcons.lockOpen,
                    size: 13,
                    color: encrypted ? accent : PB.danger,
                  ),
                  const SizedBox(width: 6),
                  Expanded(
                    child: Text(
                      encrypted
                          ? s.t('settings.connect.tlsOn')
                          : s.t('settings.connect.tlsOff'),
                      style: TextStyle(
                        fontSize: PB.fsXxs,
                        color: encrypted ? PB.textTertiary : PB.danger,
                      ),
                    ),
                  ),
                ],
              ),
              if (state.fingerprintCode6.isNotEmpty) ...[
                const SizedBox(height: 6),
                Text(
                  s.tf('settings.connect.tlsCode', {'code': state.fingerprintCode6}),
                  style: TextStyle(
                    fontSize: PB.fsXxs,
                    color: PB.textQuaternary,
                    height: 1.5,
                  ),
                ),
              ],
              const SizedBox(height: 8),
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
        // ★ 用 Material 而不是 Container 包 ListTile：带背景色的 DecoratedBox
        //   会挡住 ListTile 的水波纹（debug 模式直接断言报错）。
        Material(
          color: PB.bgPane,
          clipBehavior: Clip.antiAlias,
          shape: RoundedRectangleBorder(
            borderRadius: BorderRadius.circular(PB.rXl),
            side: BorderSide(color: PB.borderTertiary),
          ),
          child: ListTile(
            contentPadding: const EdgeInsets.symmetric(horizontal: 14, vertical: 4),
            // 这个按钮不是扫码 —— 它打开的是"附近的电脑"那一页。
            leading: Icon(LucideIcons.laptop, size: 20, color: accent),
            title: Text(
              s.t('settings.connect.rescan'),
              style: const TextStyle(fontSize: PB.fsSm),
            ),
            subtitle: Text(
              s.t('settings.connect.rescanSubtitle'),
              style: TextStyle(fontSize: PB.fsXxs, color: PB.textQuaternary),
            ),
            // ★ 直接打开配对页，**不先 signOut**：原来先断开再回登录页，
            //   中途想反悔时原来那台已经下线了，还得重新连一次。
            //   现在新电脑连上了才替换，没连上就原样返回。
            onTap: () async {
              final before = state.serverUrl;
              await Navigator.of(context).push(
                MaterialPageRoute(builder: (_) => const PairScreen()),
              );
              if (!context.mounted) return;
              if (state.serverUrl != null && state.serverUrl != before) {
                // 换成功：设置页压在主界面上，退回去看新电脑的会话
                Navigator.of(context).maybePop();
              }
            },
          ),
        ),
      ],
    );
  }
}
