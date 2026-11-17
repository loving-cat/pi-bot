import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../l10n/l10n.dart';
import '../models.dart';
import '../scope.dart';
import '../theme.dart';
import '../screens/pair_screen.dart';

/// 手机端「连接与设备」面板：连接状态、主机摘要、切换电脑与重新配对。
class MobileConnectSection extends StatelessWidget {
  const MobileConnectSection({super.key, this.showDisconnect = false});

  final bool showDisconnect;

  @override
  Widget build(BuildContext context) {
    final s = L10n.s(context);
    final state = AppScope.of(context);
    final accent = PB.colors(context).accentBright;
    final encrypted = state.serverFingerprint.isNotEmpty;
    final info = state.serverInfo;

    final (statusColor, statusLabel) = switch (state.link) {
      LinkState.online => (PB.success, s.t('settings.connect.statusOnline')),
      LinkState.connecting => (
        PB.warn,
        s.t('settings.connect.statusConnecting'),
      ),
      LinkState.offline => (
        PB.textQuaternary,
        s.t('settings.connect.statusOffline'),
      ),
    };

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Container(
          padding: const EdgeInsets.fromLTRB(14, 14, 14, 14),
          decoration: BoxDecoration(
            color: PB.bgPane,
            borderRadius: BorderRadius.circular(PB.rXl),
            border: Border.all(color: PB.borderTertiary),
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                children: [
                  Expanded(
                    child: Text(
                      s.t('settings.connect.connectedServer'),
                      style: TextStyle(fontSize: PB.fsXs, color: PB.textTertiary),
                    ),
                  ),
                  Container(
                    padding: const EdgeInsets.symmetric(
                      horizontal: 8,
                      vertical: 3,
                    ),
                    decoration: BoxDecoration(
                      color: statusColor.withValues(alpha: 0.14),
                      borderRadius: BorderRadius.circular(999),
                    ),
                    child: Row(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        Container(
                          width: 6,
                          height: 6,
                          decoration: BoxDecoration(
                            color: statusColor,
                            shape: BoxShape.circle,
                          ),
                        ),
                        const SizedBox(width: 5),
                        Text(
                          statusLabel,
                          style: TextStyle(
                            fontSize: PB.fsXxs,
                            fontWeight: FontWeight.w500,
                            color: statusColor,
                          ),
                        ),
                      ],
                    ),
                  ),
                ],
              ),
              const SizedBox(height: 8),
              Text(
                state.serverUrl ?? s.t('settings.connect.unknownServer'),
                style: TextStyle(
                  fontFamily: PB.monoFamily,
                  fontFamilyFallback: PB.monoFallback,
                  fontSize: PB.fsSm,
                  fontWeight: FontWeight.w600,
                  color: PB.textPrimary,
                ),
              ),
              const SizedBox(height: 10),
              Wrap(
                spacing: 8,
                runSpacing: 6,
                crossAxisAlignment: WrapCrossAlignment.center,
                children: [
                  Row(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      Icon(
                        encrypted ? LucideIcons.lock : LucideIcons.lockOpen,
                        size: 13,
                        color: encrypted ? accent : PB.danger,
                      ),
                      const SizedBox(width: 5),
                      Text(
                        encrypted
                            ? s.t('settings.connect.tlsOn')
                            : s.t('settings.connect.tlsOff'),
                        style: TextStyle(
                          fontSize: PB.fsXxs,
                          color: encrypted ? PB.textSecondary : PB.danger,
                        ),
                      ),
                    ],
                  ),
                  if (state.fingerprintCode6.isNotEmpty)
                    Container(
                      padding: const EdgeInsets.symmetric(
                        horizontal: 8,
                        vertical: 2,
                      ),
                      decoration: BoxDecoration(
                        color: PB.bgBubble,
                        borderRadius: BorderRadius.circular(PB.rSm),
                        border: Border.all(color: PB.borderSecondary),
                      ),
                      child: Text(
                        s.tf('settings.connect.tlsCode', {
                          'code': state.fingerprintCode6,
                        }),
                        style: TextStyle(
                          fontFamily: PB.monoFamily,
                          fontFamilyFallback: PB.monoFallback,
                          fontSize: PB.fsXxs,
                          color: PB.textSecondary,
                        ),
                      ),
                    ),
                ],
              ),
              if (info != null) ...[
                const SizedBox(height: 12),
                Divider(height: 1, color: PB.borderTertiary),
                const SizedBox(height: 10),
                if (info.hostname.isNotEmpty)
                  _CompactMetaRow(
                    label: s.t('settings.server.hostname'),
                    value: info.hostname,
                  ),
                if ((info.model ?? '').isNotEmpty)
                  _CompactMetaRow(
                    label: s.t('settings.server.model'),
                    value: info.model!,
                  ),
                if (info.version.isNotEmpty)
                  _CompactMetaRow(
                    label: s.t('settings.server.version'),
                    value: info.version,
                  ),
              ],
              const SizedBox(height: 10),
              Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Icon(
                    LucideIcons.messageSquare,
                    size: 13,
                    color: PB.textQuaternary,
                  ),
                  const SizedBox(width: 6),
                  Expanded(
                    child: Text(
                      s.t('settings.connect.chatManageHint'),
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
        const SizedBox(height: 12),
        // ★ 用 Material 而不是 Container 包 ListTile：防止水波纹断言报错。
        Material(
          color: PB.bgPane,
          clipBehavior: Clip.antiAlias,
          shape: RoundedRectangleBorder(
            borderRadius: BorderRadius.circular(PB.rXl),
            side: BorderSide(color: PB.borderTertiary),
          ),
          child: Column(
            children: [
              ListTile(
                contentPadding: const EdgeInsets.symmetric(
                  horizontal: 14,
                  vertical: 2,
                ),
                leading: Icon(LucideIcons.laptop, size: 19, color: accent),
                title: Text(
                  s.t('settings.connect.rescan'),
                  style: const TextStyle(fontSize: PB.fsSm),
                ),
                subtitle: Text(
                  s.t('settings.connect.rescanSubtitle'),
                  style: TextStyle(fontSize: PB.fsXxs, color: PB.textQuaternary),
                ),
                // 直接打开配对页，不先断开：新电脑连上后才替换。
                onTap: () async {
                  final before = state.serverUrl;
                  await Navigator.of(context).push(
                    MaterialPageRoute(builder: (_) => const PairScreen()),
                  );
                  if (!context.mounted) return;
                  if (state.serverUrl != null && state.serverUrl != before) {
                    Navigator.of(context).maybePop();
                  }
                },
              ),
              if (showDisconnect) ...[
                Divider(height: 1, color: PB.borderTertiary),
                ListTile(
                  contentPadding: const EdgeInsets.symmetric(
                    horizontal: 14,
                    vertical: 2,
                  ),
                  leading: Icon(
                    LucideIcons.unlink,
                    size: 18,
                    color: PB.danger,
                  ),
                  title: Text(
                    s.t('settings.actions.repair'),
                    style: TextStyle(fontSize: PB.fsSm, color: PB.danger),
                  ),
                  onTap: () async {
                    await state.signOut();
                    if (context.mounted) {
                      Navigator.of(context).maybePop();
                    }
                  },
                ),
              ],
            ],
          ),
        ),
      ],
    );
  }
}

class _CompactMetaRow extends StatelessWidget {
  const _CompactMetaRow({required this.label, required this.value});

  final String label;
  final String value;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 3),
      child: Row(
        children: [
          SizedBox(
            width: 56,
            child: Text(
              label,
              style: TextStyle(fontSize: PB.fsXxs, color: PB.textQuaternary),
            ),
          ),
          Expanded(
            child: Text(
              value,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: TextStyle(
                fontFamily: PB.monoFamily,
                fontFamilyFallback: PB.monoFallback,
                fontSize: PB.fsXxs,
                color: PB.textSecondary,
              ),
            ),
          ),
        ],
      ),
    );
  }
}
