import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../discovery.dart';
import '../l10n/l10n.dart';
import '../theme.dart';

/// 附近的电脑：列表 + 搜索/重新搜索。
/// 附近的电脑：列表 + 搜索/重新搜索。
///
/// 抽成独立 widget 是为了能测（手机端才用得上）：给一组现成的 host 就能断言
/// "列表长什么样 / 空列表该说什么话"，不用真去发 UDP 广播。
class NearbyHostsCard extends StatelessWidget {
  const NearbyHostsCard({
    super.key,
    required this.hosts,
    required this.scanning,
    required this.picked,
    required this.onPick,
    required this.onRescan,
  });

  final List<DiscoveredHost> hosts;
  final bool scanning;
  final DiscoveredHost? picked;
  final ValueChanged<DiscoveredHost> onPick;
  final VoidCallback onRescan;

  @override
  Widget build(BuildContext context) {
    final s = L10n.s(context);
    return Container(
      padding: const EdgeInsets.fromLTRB(14, 12, 14, 12),
      decoration: BoxDecoration(
        color: PB.bgPane,
        borderRadius: BorderRadius.circular(PB.rXl),
        border: Border.all(color: PB.borderTertiary),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Row(
            children: [
              Icon(LucideIcons.radar, size: 15, color: PB.textTertiary),
              const SizedBox(width: 7),
              Text(
                s.t('pair.nearbyTitle'),
                style: TextStyle(
                  fontSize: PB.fsSm,
                  fontWeight: FontWeight.w500,
                  color: PB.textSecondary,
                ),
              ),
              const Spacer(),
              if (scanning)
                const SizedBox(
                  width: 14,
                  height: 14,
                  child: CircularProgressIndicator(strokeWidth: 1.6),
                )
              else
                InkWell(
                  onTap: onRescan,
                  borderRadius: BorderRadius.circular(PB.rSm),
                  child: Padding(
                    padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 3),
                    child: Row(
                      children: [
                        Icon(LucideIcons.refreshCw, size: 13, color: PB.textQuaternary),
                        const SizedBox(width: 4),
                        Text(
                          s.t('pair.rescan'),
                          style: TextStyle(fontSize: PB.fsXxs, color: PB.textQuaternary),
                        ),
                      ],
                    ),
                  ),
                ),
            ],
          ),
          const SizedBox(height: 6),
          if (scanning && hosts.isEmpty)
            Padding(
              padding: const EdgeInsets.symmetric(vertical: 10),
              child: Text(
                s.t('pair.searching'),
                style: TextStyle(fontSize: PB.fsXs, color: PB.textQuaternary),
              ),
            )
          else if (hosts.isEmpty)
            Padding(
              padding: const EdgeInsets.symmetric(vertical: 6),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    s.t('pair.notFound'),
                    style: TextStyle(fontSize: PB.fsXs, color: PB.textSecondary),
                  ),
                  const SizedBox(height: 6),
                  Text(
                    s.t('pair.notFoundHint'),
                    style: TextStyle(
                      fontSize: PB.fsXxs,
                      color: PB.textQuaternary,
                      height: 1.5,
                    ),
                  ),
                ],
              ),
            )
          else
            for (final host in hosts)
              _HostRow(
                host: host,
                selected: picked?.key == host.key,
                onTap: () => onPick(host),
              ),
        ],
      ),
    );
  }
}

/// 一台电脑
class _HostRow extends StatelessWidget {
  const _HostRow({
    required this.host,
    required this.selected,
    required this.onTap,
  });

  final DiscoveredHost host;
  final bool selected;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final accent = PB.colors(context).accentBright;
    return Padding(
      padding: const EdgeInsets.only(top: 6),
      child: Material(
        color: selected ? PB.bgActive : Colors.transparent,
        borderRadius: BorderRadius.circular(PB.rLg),
        child: InkWell(
          onTap: onTap,
          borderRadius: BorderRadius.circular(PB.rLg),
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 9),
            child: Row(
              children: [
                Icon(
                  LucideIcons.laptop,
                  size: 17,
                  color: selected ? accent : PB.textTertiary,
                ),
                const SizedBox(width: 10),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        host.label,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: TextStyle(
                          fontSize: PB.fsSm,
                          fontWeight: FontWeight.w500,
                          color: PB.textPrimary,
                        ),
                      ),
                      const SizedBox(height: 2),
                      Text(
                        host.url,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: TextStyle(
                          fontFamily: PB.monoFamily,
                          fontFamilyFallback: PB.monoFallback,
                          fontSize: PB.fsXxs,
                          color: PB.textQuaternary,
                        ),
                      ),
                    ],
                  ),
                ),
                if (selected)
                  Icon(LucideIcons.circleCheck, size: 16, color: accent),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

/// 等电脑点"允许"的那张卡：说明在等什么、等多久失效、随时能取消。
/// 等电脑点"允许"的那张卡：说明在等什么、等多久失效、随时能取消。
class PairWaitingCard extends StatelessWidget {
  const PairWaitingCard({
    super.key,
    required this.host,
    required this.title,
    required this.hint,
    required this.onCancel,
  });

  final String host;
  final String title;
  final String hint;
  final VoidCallback onCancel;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.all(14),
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
              const SizedBox(
                width: 15,
                height: 15,
                child: CircularProgressIndicator(strokeWidth: 1.8),
              ),
              const SizedBox(width: 10),
              Expanded(
                child: Text(
                  title,
                  style: TextStyle(
                    fontSize: PB.fsSm,
                    fontWeight: FontWeight.w500,
                    color: PB.textPrimary,
                  ),
                ),
              ),
            ],
          ),
          const SizedBox(height: 8),
          Text(
            hint,
            style: TextStyle(fontSize: PB.fsXs, color: PB.textQuaternary, height: 1.5),
          ),
          const SizedBox(height: 10),
          Row(
            children: [
              Expanded(
                child: Text(
                  host,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(
                    fontFamily: PB.monoFamily,
                    fontFamilyFallback: PB.monoFallback,
                    fontSize: PB.fsXxs,
                    color: PB.textTertiary,
                  ),
                ),
              ),
              TextButton(
                onPressed: onCancel,
                child: Text(
                  L10n.s(context).t('common.cancel'),
                  style: TextStyle(fontSize: PB.fsXs, color: PB.textTertiary),
                ),
              ),
            ],
          ),
        ],
      ),
    );
  }
}
