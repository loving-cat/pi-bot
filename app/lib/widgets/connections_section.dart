import 'dart:async';

import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../app_state.dart';
import '../connections_controller.dart';
import '../connections_filters.dart';
import '../connections_models.dart';
import '../l10n/l10n.dart';
import '../scope.dart';
import '../theme.dart';
import 'connections_cards.dart';
import 'connections_detail.dart';
import 'connections_editor.dart';
import 'connections_import.dart';

/// 应用目录、已配置连接与管理入口。
class ConnectionsSection extends StatefulWidget {
  const ConnectionsSection({super.key, this.controller});
  final ConnectionsController? controller;

  @override
  State<ConnectionsSection> createState() => _ConnectionsSectionState();
}

class _ConnectionsSectionState extends State<ConnectionsSection> {
  final _search = TextEditingController();
  // 筛选栏已去掉（见 build 里的说明）：只剩「全部」这一种状态。
  // 保留这个字段是为了复用 connectionMatches / catalogMatches 的过滤逻辑，
  // 它们的 filter 参数还能表达"已配置"等语义，将来若要恢复筛选不必重写。
  final ConnectionFilter _filter = ConnectionFilter.all;
  ConnectionsController? _controller;
  AppState? _state;
  int _revision = -1;
  Object? _api;
  bool _refreshScheduled = false;
  ConnectionsSnapshot? _syncedSnapshot;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    final state = AppScope.of(context);
    if (identical(state, _state)) return;
    _state?.removeListener(_onState);
    _state = state;
    _state!.addListener(_onState);
    if (_controller == null) {
      _controller =
          widget.controller ??
          ConnectionsController(apiProvider: () => _state?.api);
      _controller!.addListener(_onConnections);
    }
    _onState();
  }

  void _onConnections() {
    final controller = _controller!;
    if (!controller.loaded ||
        controller.loading ||
        controller.error != null ||
        identical(_syncedSnapshot, controller.snapshot))
      return;
    _syncedSnapshot = controller.snapshot;
    _state?.applyMcpServers(
      controller.snapshot.connections.map((item) => item.server).toList(),
    );
  }

  void _onState() {
    final state = _state!;
    if (_revision == state.connectionsRevision && identical(_api, state.api))
      return;
    _revision = state.connectionsRevision;
    _api = state.api;
    if (_refreshScheduled) return;
    _refreshScheduled = true;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      _refreshScheduled = false;
      if (mounted) unawaited(_controller!.load());
    });
  }

  @override
  void dispose() {
    _state?.removeListener(_onState);
    _controller?.removeListener(_onConnections);
    if (widget.controller == null) _controller?.dispose();
    _search.dispose();
    super.dispose();
  }

  Future<void> _edit({AppConnection? item, String type = 'http'}) async {
    final api = _state?.api;
    final switched = L10n.s(context).t('conn.serverSwitched');
    await showConnectionEditor(
      context,
      server: item?.server,
      initialType: type,
      onSave: (patch) => identical(api, _state?.api)
          ? _controller!.save(patch)
          : Future.value(switched),
      onTest: (patch) => identical(api, _state?.api)
          ? _controller!.testDraft(patch)
          : Future.value({'ok': false, 'error': switched}),
    );
  }

  Future<void> _import() async {
    _controller!.importResult = null;
    unawaited(_controller!.scanLocal());
    await showDialog<void>(
      context: context,
      builder: (_) => ConnectionsImport(controller: _controller!),
    );
    if (mounted) await _controller!.load();
  }

  Future<void> _detail(String id) async {
    await showDialog<void>(
      context: context,
      builder: (dialogContext) => AnimatedBuilder(
        animation: _controller!,
        builder: (context, _) {
          final item = _controller!.connection(id);
          if (item == null)
            return AlertDialog(
              title: Text(L10n.s(context).t('conn.deletedTitle')),
              actions: [
                TextButton(
                  onPressed: () => Navigator.pop(context),
                  child: Text(L10n.s(context).t('common.close')),
                ),
              ],
            );
          final state = AppScope.of(context);
          return ConnectionsDetail(
            connection: item,
            bots: state.bots,
            busy: _controller!.isBusy(id),
            error: _controller!.error,
            policy: '${state.policy['dangerous'] ?? 'ask'}',
            onVerify: () => _controller!.verify(id),
            onEnabled: (value) => _controller!.setEnabled(id, value),
            onAssign: (botIds) => _controller!.assign(id, botIds),
            onEdit: () => _edit(item: item),
            onDelete: () async {
              final confirmed = await showDialog<bool>(
                context: context,
                builder: (ctx) => AlertDialog(
                  title: Text(L10n.s(ctx).t('conn.deleteTitle')),
                  content: Text(
                    L10n.s(ctx)
                        .tf('conn.deleteBody', {'name': item.server.name}),
                  ),
                  actions: [
                    TextButton(
                      onPressed: () => Navigator.pop(ctx, false),
                      child: Text(L10n.s(ctx).t('common.cancel')),
                    ),
                    FilledButton(
                      onPressed: () => Navigator.pop(ctx, true),
                      child: Text(L10n.s(ctx).t('common.delete')),
                    ),
                  ],
                ),
              );
              if (confirmed != true || !mounted) return;
              final error = await _controller!.remove(id);
              if (!dialogContext.mounted) return;
              if (error == null) Navigator.pop(dialogContext);
            },
          );
        },
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final controller = _controller;
    if (controller == null) return const SizedBox.shrink();
    final strings = L10n.s(context);
    return AnimatedBuilder(
      animation: controller,
      builder: (context, _) {
        final connections = controller.snapshot.connections
            .where((item) => connectionMatches(item, _search.text, _filter))
            .toList();
        final catalog = controller.snapshot.catalog
            .where((item) => catalogMatches(item, _search.text, _filter))
            .toList();
        return Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const SizedBox(height: 12),
            Row(
              children: [
                Expanded(
                  child: Text(
                    strings.t('conn.title'),
                    style: const TextStyle(
                      fontSize: PB.fsXxl,
                      fontWeight: FontWeight.w600,
                    ),
                  ),
                ),
                Text(
                  strings.tf('conn.configuredCount', {
                    'n': controller.snapshot.connections.length,
                  }),
                  style: TextStyle(
                    fontSize: PB.fsSm,
                    color: PB.textTertiary,
                  ),
                ),
                IconButton(
                  tooltip: strings.t('conn.refresh'),
                  onPressed: controller.loading ? null : controller.load,
                  icon: const Icon(LucideIcons.refreshCw, size: 17),
                ),
              ],
            ),
            const SizedBox(height: 6),
            Text(
              strings.t('conn.subtitle'),
              style: TextStyle(
                color: PB.textSecondary,
                fontSize: PB.fsBase,
              ),
            ),
            const SizedBox(height: 20),
            TextField(
              key: const ValueKey('connections-search'),
              controller: _search,
              onChanged: (_) => setState(() {}),
              decoration: InputDecoration(
                hintText: strings.t('conn.searchHint'),
                prefixIcon: const Icon(LucideIcons.search, size: 17),
                suffixIcon: _search.text.isEmpty
                    ? null
                    : IconButton(
                        tooltip: strings.t('conn.clearSearch'),
                        onPressed: () => setState(_search.clear),
                        icon: const Icon(LucideIcons.x, size: 17),
                      ),
                isDense: true,
              ),
            ),
            // ★ 筛选栏去掉了。
            //
            //   它本来是「远程服务 / 本地工具 / 已配置」——前两个是同一个
            //   「连接方式」下拉框的两个取值，第三个又是另一个维度
            //   （配置状态混进类型筛选里）。三个 chip 各说各的，
            //   而连接总数通常个位数，上面已经有搜索框。
            //   留着只是让人多做一次选择。
            const SizedBox(height: 12),
            if (controller.loading)
              const Padding(
                padding: EdgeInsets.only(top: 14),
                child: LinearProgressIndicator(minHeight: 2),
              ),
            if (controller.error != null)
              Padding(
                padding: const EdgeInsets.only(top: 14),
                child: Row(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Expanded(
                      child: Text(
                        controller.error!,
                        style: TextStyle(
                          color: PB.danger,
                          fontSize: PB.fsSm,
                        ),
                      ),
                    ),
                    TextButton(
                      onPressed: controller.loading ? null : controller.load,
                      child: Text(strings.t('common.retry')),
                    ),
                  ],
                ),
              ),
            if (catalog.isNotEmpty) ...[
              const SizedBox(height: 24),
              Text(
                strings.t('conn.addTitle'),
                style: const TextStyle(
                  fontSize: PB.fsLg,
                  fontWeight: FontWeight.w600,
                ),
              ),
              const SizedBox(height: 12),
              _cards(context, [
                // ★ 一个「添加 MCP」就够，不再分远程/本地两张卡。
                //
                //   两张卡点进去都是同一个编辑器，**唯一的区别**是
                //   表单里的「连接方式」下拉框默认选哪个 ——
                //   而那个下拉框本来就在编辑器第一屏。
                //   在外面先让用户选一次，等于让他为一个他还没看到的
                //   选项做决定：不知道区别的人只能瞎点。
                //
                //   现在进来就是表单，想改方式随时改。
                ConnectionsCatalogCard(
                  item: ConnectionCatalogItem(
                    id: 'add_mcp',
                    name: strings.t('conn.addMcp'),
                    description: strings.t('conn.addMcpHint'),
                    category: 'remote',
                    type: 'http',
                    action: 'create',
                  ),
                  onTap: () => _edit(),
                ),
                for (final item in catalog)
                  if (item.id == 'import_local')
                    ConnectionsCatalogCard(
                      item: item,
                      onTap: _import,
                    ),
              ]),
            ],
            if (connections.isNotEmpty) ...[
              const SizedBox(height: 26),
              Text(
                strings.t('conn.configuredTitle'),
                style: const TextStyle(
                  fontSize: PB.fsLg,
                  fontWeight: FontWeight.w600,
                ),
              ),
              const SizedBox(height: 12),
              _cards(context, [
                for (final item in connections)
                  ConnectionsCard(
                    item: item,
                    busy: controller.isBusy(item.id),
                    onTap: () => _detail(item.id),
                    onVerify: () => controller.verify(item.id),
                  ),
              ]),
            ] else if (controller.loaded && !controller.loading)
              Padding(
                padding: const EdgeInsets.symmetric(vertical: 30),
                child: Text(
                  _search.text.trim().isNotEmpty
                      ? strings.t('conn.noMatch')
                      : _filter == ConnectionFilter.configured
                      ? strings.t('conn.emptyConfigured')
                      : strings.t('conn.emptyFiltered'),
                  style: TextStyle(
                    color: PB.textTertiary,
                    fontSize: PB.fsBase,
                  ),
                ),
              ),
            const SizedBox(height: 16),
          ],
        );
      },
    );
  }

  Widget _cards(BuildContext context, List<Widget> children) => LayoutBuilder(
    builder: (context, constraints) {
      final columns = constraints.maxWidth >= 560 ? 2 : 1;
      final width = (constraints.maxWidth - (columns - 1) * 12) / columns;
      return Wrap(
        spacing: 12,
        runSpacing: 12,
        children: [
          for (final child in children) SizedBox(width: width, child: child),
        ],
      );
    },
  );
}
