import 'dart:async';

import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../app_state.dart';
import '../connections_controller.dart';
import '../connections_filters.dart';
import '../connections_models.dart';
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
  ConnectionFilter _filter = ConnectionFilter.all;
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
    await showConnectionEditor(
      context,
      server: item?.server,
      initialType: type,
      onSave: (patch) => identical(api, _state?.api)
          ? _controller!.save(patch)
          : Future.value('服务端已切换，请重新打开配置'),
      onTest: (patch) => identical(api, _state?.api)
          ? _controller!.testDraft(patch)
          : Future.value({'ok': false, 'error': '服务端已切换，请重新打开配置'}),
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
              title: const Text('连接已移除'),
              actions: [
                TextButton(
                  onPressed: () => Navigator.pop(context),
                  child: const Text('关闭'),
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
                  title: const Text('删除连接？'),
                  content: Text('删除「${item.server.name}」后，已分配的 Bot 将无法再使用它。'),
                  actions: [
                    TextButton(
                      onPressed: () => Navigator.pop(ctx, false),
                      child: const Text('取消'),
                    ),
                    FilledButton(
                      onPressed: () => Navigator.pop(ctx, true),
                      child: const Text('删除'),
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
                const Expanded(
                  child: Text(
                    '应用连接',
                    style: TextStyle(
                      fontSize: PB.fsXxl,
                      fontWeight: FontWeight.w600,
                    ),
                  ),
                ),
                Text(
                  '${controller.snapshot.connections.length} 个已配置',
                  style: const TextStyle(
                    fontSize: PB.fsSm,
                    color: PB.textTertiary,
                  ),
                ),
                IconButton(
                  tooltip: '刷新应用连接',
                  onPressed: controller.loading ? null : controller.load,
                  icon: const Icon(LucideIcons.refreshCw, size: 17),
                ),
              ],
            ),
            const SizedBox(height: 6),
            const Text(
              '把工作工具连接给 Bot，按需要分配使用。',
              style: TextStyle(color: PB.textSecondary, fontSize: PB.fsBase),
            ),
            const SizedBox(height: 20),
            TextField(
              key: const ValueKey('connections-search'),
              controller: _search,
              onChanged: (_) => setState(() {}),
              decoration: InputDecoration(
                hintText: '搜索应用连接',
                prefixIcon: const Icon(LucideIcons.search, size: 17),
                suffixIcon: _search.text.isEmpty
                    ? null
                    : IconButton(
                        tooltip: '清空搜索',
                        onPressed: () => setState(_search.clear),
                        icon: const Icon(Icons.close, size: 17),
                      ),
                isDense: true,
              ),
            ),
            const SizedBox(height: 12),
            Wrap(
              spacing: 8,
              runSpacing: 6,
              children: [
                for (final filter in ConnectionFilter.values)
                  ChoiceChip(
                    label: Text(filter.label),
                    selected: _filter == filter,
                    showCheckmark: false,
                    backgroundColor: PB.bgElevated,
                    selectedColor: PB.bgActive,
                    labelStyle: TextStyle(
                      color: _filter == filter
                          ? PB.textPrimary
                          : PB.textSecondary,
                    ),
                    side: const BorderSide(color: PB.borderTertiary),
                    onSelected: (_) => setState(() => _filter = filter),
                  ),
              ],
            ),
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
                        style: const TextStyle(
                          color: PB.danger,
                          fontSize: PB.fsSm,
                        ),
                      ),
                    ),
                    TextButton(
                      onPressed: controller.loading ? null : controller.load,
                      child: const Text('重试'),
                    ),
                  ],
                ),
              ),
            if (catalog.isNotEmpty) ...[
              const SizedBox(height: 24),
              const Text(
                '添加连接',
                style: TextStyle(
                  fontSize: PB.fsLg,
                  fontWeight: FontWeight.w600,
                ),
              ),
              const SizedBox(height: 12),
              _cards(context, [
                for (final item in catalog)
                  ConnectionsCatalogCard(
                    item: item,
                    onTap: () {
                      if (item.id == 'import_local') {
                        _import();
                      } else {
                        _edit(
                          type: item.type == 'stdio' || item.id == 'local_mcp'
                              ? 'stdio'
                              : 'http',
                        );
                      }
                    },
                  ),
              ]),
            ],
            if (connections.isNotEmpty) ...[
              const SizedBox(height: 26),
              const Text(
                '已配置应用',
                style: TextStyle(
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
                      ? '没有找到匹配的连接'
                      : _filter == ConnectionFilter.configured
                      ? '还没有配置连接。选择“全部”添加一个。'
                      : '还没有这类连接。从上方选择一种接入方式开始。',
                  style: const TextStyle(
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
