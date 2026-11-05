import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../connections_models.dart';
import '../l10n/l10n.dart';
import '../theme.dart';

/// 验证状态的文案 key；未知状态按「尚未验证」处理。
String _statusKey(String state) => switch (state) {
  'checking' => 'conn.status.checking',
  'ready' => 'conn.status.ready',
  'auth_required' => 'conn.status.authRequired',
  'error' => 'conn.status.error',
  'stale' => 'conn.status.stale',
  _ => 'conn.status.unverified',
};

/// 验证时间标签：无记录时给出提示，有记录时按「月/日 时:分」显示。
String _checkedAtLabel(AppStrings strings, int? value) {
  if (value == null || value <= 0) return strings.t('conn.neverChecked');
  final dt = DateTime.fromMillisecondsSinceEpoch(value);
  String two(int n) => n.toString().padLeft(2, '0');
  return strings.tf('conn.checkedAt', {
    'time': '${dt.month}/${dt.day} ${two(dt.hour)}:${two(dt.minute)}',
  });
}

class ConnectionsCatalogCard extends StatelessWidget {
  const ConnectionsCatalogCard({
    super.key,
    required this.item,
    required this.onTap,
  });
  final ConnectionCatalogItem item;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final import = item.id == 'import_local';
    final remote = item.id == 'remote_mcp' || item.type == 'http';
    return _CardFrame(
      onTap: onTap,
      child: Row(
        children: [
          _ServiceIcon(remote: remote, importing: import),
          const SizedBox(width: 12),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  item.name,
                  style: const TextStyle(
                    fontWeight: FontWeight.w600,
                    fontSize: PB.fsBase,
                  ),
                ),
                const SizedBox(height: 5),
                Text(
                  item.description,
                  maxLines: 2,
                  overflow: TextOverflow.ellipsis,
                  style: const TextStyle(
                    fontSize: PB.fsSm,
                    color: PB.textTertiary,
                    height: 1.5,
                  ),
                ),
              ],
            ),
          ),
          const SizedBox(width: 8),
          const Icon(
            LucideIcons.chevronRight,
            size: 16,
            color: PB.textTertiary,
          ),
        ],
      ),
    );
  }
}

class ConnectionsCard extends StatelessWidget {
  const ConnectionsCard({
    super.key,
    required this.item,
    required this.busy,
    required this.onTap,
    required this.onVerify,
  });
  final AppConnection item;
  final bool busy;
  final VoidCallback onTap;
  final VoidCallback onVerify;

  @override
  Widget build(BuildContext context) {
    final strings = L10n.s(context);
    final state = item.verification.displayState;
    final status = state == 'ready' && item.verification.toolCount == 0
        ? strings.t('conn.status.readyNoTools')
        : strings.t(_statusKey(state));
    final enabledLabel = strings.t(
      item.server.enabled ? 'conn.enabled' : 'conn.disabled',
    );
    return _CardFrame(
      onTap: onTap,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              _ServiceIcon(remote: item.server.isHttp),
              const SizedBox(width: 12),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      item.server.name,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: const TextStyle(
                        fontWeight: FontWeight.w600,
                        fontSize: PB.fsBase,
                      ),
                    ),
                    const SizedBox(height: 4),
                    Text(
                      item.server.description.isEmpty
                          ? strings.t(
                              item.server.isHttp
                                  ? 'conn.remoteService'
                                  : 'conn.localService',
                            )
                          : item.server.description,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: const TextStyle(
                        fontSize: PB.fsSm,
                        color: PB.textTertiary,
                      ),
                    ),
                  ],
                ),
              ),
            ],
          ),
          const SizedBox(height: 14),
          Text(
            busy ? strings.t('conn.processing') : status,
            style: TextStyle(
              fontSize: PB.fsSm,
              color: state == 'ready' ? PB.success : PB.textSecondary,
            ),
          ),
          const SizedBox(height: 4),
          Text(
            _checkedAtLabel(strings, item.verification.checkedAt),
            style: const TextStyle(fontSize: PB.fsXs, color: PB.textTertiary),
          ),
          const SizedBox(height: 8),
          Row(
            children: [
              Expanded(
                child: Text(
                  strings.tf('conn.botCount', {
                    'state': enabledLabel,
                    'n': item.assignedBotIds.length,
                  }),
                  style: const TextStyle(
                    fontSize: PB.fsSm,
                    color: PB.textTertiary,
                  ),
                ),
              ),
              TextButton(
                onPressed: busy ? null : onVerify,
                child: Text(strings.t('conn.verify')),
              ),
            ],
          ),
        ],
      ),
    );
  }
}

class _CardFrame extends StatelessWidget {
  const _CardFrame({required this.child, required this.onTap});
  final Widget child;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) => Material(
    color: PB.bgElevated,
    shape: RoundedRectangleBorder(
      borderRadius: BorderRadius.circular(PB.rXl),
      side: const BorderSide(color: PB.borderSecondary),
    ),
    clipBehavior: Clip.antiAlias,
    child: InkWell(
      onTap: onTap,
      child: Padding(padding: const EdgeInsets.all(16), child: child),
    ),
  );
}

class _ServiceIcon extends StatelessWidget {
  const _ServiceIcon({required this.remote, this.importing = false});
  final bool remote;
  final bool importing;

  @override
  Widget build(BuildContext context) => Container(
    width: 38,
    height: 38,
    decoration: BoxDecoration(
      color:
          (importing
                  ? PB.palette[3]
                  : remote
                  ? PB.colors(context).accent
                  : PB.palette[5])
              .withValues(alpha: .14),
      borderRadius: BorderRadius.circular(11),
    ),
    child: Icon(
      importing
          ? LucideIcons.download
          : remote
          ? LucideIcons.globe
          : LucideIcons.terminal,
      size: 19,
      color: importing
          ? PB.palette[3]
          : remote
          ? PB.colors(context).accentBright
          : PB.palette[5],
    ),
  );
}
