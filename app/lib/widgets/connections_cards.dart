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
                  style: TextStyle(
                    fontSize: PB.fsSm,
                    color: PB.textTertiary,
                    height: 1.5,
                  ),
                ),
              ],
            ),
          ),
          const SizedBox(width: 8),
          Icon(
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
    this.preset,
  });
  final AppConnection item;
  final bool busy;
  final VoidCallback onTap;
  final VoidCallback onVerify;

  /// 内置预设的本机依赖状态（不是预设时为 null）
  final PresetAvailability? preset;

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
                    Row(
                      children: [
                        Flexible(
                          child: Text(
                            item.server.name,
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            style: const TextStyle(
                              fontWeight: FontWeight.w600,
                              fontSize: PB.fsBase,
                            ),
                          ),
                        ),
                        // 「内置预设」标记：出厂就有这一项，默认不启用
                        if (item.server.isPreset) ...[
                          const SizedBox(width: 6),
                          _PresetBadge(),
                        ],
                      ],
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
                      style: TextStyle(
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
          // 内置预设：本机依赖检测结果（只提示，不自动安装）
          if (preset != null) ...[
            const SizedBox(height: 6),
            _PresetInstallState(preset: preset!, enabled: item.server.enabled),
          ],
          const SizedBox(height: 4),
          Text(
            _checkedAtLabel(strings, item.verification.checkedAt),
            style: TextStyle(fontSize: PB.fsXs, color: PB.textTertiary),
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
                  style: TextStyle(
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
      side: BorderSide(color: PB.borderSecondary),
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


/// 「内置预设」小标记：跟随主题色，深浅模式下都清晰。
class _PresetBadge extends StatelessWidget {
  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
      decoration: BoxDecoration(
        color: PB.colors(context).accent.withValues(alpha: 0.14),
        borderRadius: BorderRadius.circular(4),
      ),
      child: Text(
        L10n.s(context).t('conn.presetBadge'),
        style: TextStyle(
          fontSize: PB.fsXxs,
          color: PB.colors(context).accentBright,
          fontWeight: FontWeight.w600,
        ),
      ),
    );
  }
}

/// 预设的安装状态：已检测到 → 一行绿字；未安装 → 一行黄字 + 可展开的安装说明。
///
/// 说明只**展示**，不执行 —— 自动装 Ghidra 那种几百 MB 还要配 JVM 的东西，
/// 不该由界面替用户决定。
class _PresetInstallState extends StatelessWidget {
  const _PresetInstallState({required this.preset, required this.enabled});
  final PresetAvailability preset;

  /// 这个预设是否已启用（未启用时多给一条"首次会下载"的提示）
  final bool enabled;

  @override
  Widget build(BuildContext context) {
    final strings = L10n.s(context);
    if (preset.found) {
      return Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Icon(LucideIcons.check, size: 12, color: PB.success),
              const SizedBox(width: 4),
              Expanded(
                child: Text(
                  strings.tf('conn.presetInstalled', {'detail': preset.detail}),
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(fontSize: PB.fsXs, color: PB.success),
                ),
              ),
            ],
          ),
          // ★ 未启用时提示首次启动的下载代价。
          //   pyghidra 通过 uvx 拉起，第一次会把整个 Python 依赖树拉下来
          //   （实测约 80MB）。用户打开开关前该知道这件事。
          if (!enabled && preset.firstRunDownload != null) ...[
            const SizedBox(height: 2),
            Row(
              children: [
                Icon(LucideIcons.download, size: 12, color: PB.textTertiary),
                const SizedBox(width: 4),
                Expanded(
                  child: Text(
                    strings.tf('conn.presetFirstRunDownload', {
                      'size': preset.firstRunDownload!,
                    }),
                    maxLines: 2,
                    style: TextStyle(
                      fontSize: PB.fsXs,
                      color: PB.textTertiary,
                      height: 1.4,
                    ),
                  ),
                ),
              ],
            ),
          ],
        ],
      );
    }
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Row(
          children: [
            Icon(LucideIcons.alertCircle, size: 12, color: PB.warn),
            const SizedBox(width: 4),
            Expanded(
              child: Text(
                strings.t('conn.presetNotInstalled'),
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: TextStyle(fontSize: PB.fsXs, color: PB.warn),
              ),
            ),
          ],
        ),
        const SizedBox(height: 2),
        // 安装说明折叠起来，避免列表被大段文字撑高
        Theme(
          data: Theme.of(context).copyWith(dividerColor: Colors.transparent),
          child: ExpansionTile(
            tilePadding: EdgeInsets.zero,
            childrenPadding: const EdgeInsets.only(bottom: 6),
            dense: true,
            leading: const SizedBox.shrink(),
            title: Text(
              strings.t('conn.presetInstallHelp'),
              style: TextStyle(fontSize: PB.fsXs, color: PB.textTertiary),
            ),
            children: [
              Align(
                alignment: Alignment.centerLeft,
                child: SelectableText(
                  '`${preset.versionNote}\n\n${preset.install}`',
                  style: TextStyle(
                    fontSize: PB.fsXs,
                    color: PB.textSecondary,
                    height: 1.5,
                  ),
                ),
              ),
            ],
          ),
        ),
      ],
    );
  }
}

