import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../connections_filters.dart';
import '../connections_models.dart';
import '../theme.dart';

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
  Widget build(BuildContext context) => _CardFrame(
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
                        ? (item.server.isHttp ? '远程工具服务' : '本地工具服务')
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
          busy ? '处理中…' : item.verification.label,
          style: TextStyle(
            fontSize: PB.fsSm,
            color: item.verification.displayState == 'ready'
                ? PB.success
                : PB.textSecondary,
          ),
        ),
        const SizedBox(height: 4),
        Text(
          connectionCheckedAt(item.verification.checkedAt),
          style: const TextStyle(fontSize: PB.fsXs, color: PB.textTertiary),
        ),
        const SizedBox(height: 8),
        Row(
          children: [
            Expanded(
              child: Text(
                '${item.server.enabled ? '已启用' : '已停用'} · ${item.assignedBotIds.length} 个 Bot',
                style: const TextStyle(
                  fontSize: PB.fsSm,
                  color: PB.textTertiary,
                ),
              ),
            ),
            TextButton(
              onPressed: busy ? null : onVerify,
              child: const Text('验证'),
            ),
          ],
        ),
      ],
    ),
  );
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
                  ? PB.accent
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
          ? PB.accentBright
          : PB.palette[5],
    ),
  );
}
