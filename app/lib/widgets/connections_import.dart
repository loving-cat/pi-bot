import 'package:flutter/material.dart';

import '../connections_controller.dart';
import '../theme.dart';

/// 本机连接选择与导入结果，凭据值不进入界面。
class ConnectionsImport extends StatefulWidget {
  const ConnectionsImport({super.key, required this.controller});
  final ConnectionsController controller;

  @override
  State<ConnectionsImport> createState() => _ConnectionsImportState();
}

class _ConnectionsImportState extends State<ConnectionsImport> {
  final _selected = <String>{};
  String? _error;

  Future<void> _import() async {
    setState(() => _error = null);
    final error = await widget.controller.importLocal(_selected.toList());
    if (!mounted) return;
    setState(() {
      _error = error;
      if (error == null) _selected.clear();
    });
  }

  @override
  Widget build(BuildContext context) => AnimatedBuilder(
    animation: widget.controller,
    builder: (context, _) {
      final state = widget.controller;
      final busy = state.scanning || state.isBusy('local-import');
      return AlertDialog(
        title: const Text('从本机导入'),
        content: SizedBox(
          width: 540,
          child: SingleChildScrollView(
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                const Text(
                  '选择本机已有的工具配置。导入会复制一份配置，原配置保持不变；导入后默认停用，验证并分配给 Bot 后即可使用。',
                  style: TextStyle(fontSize: PB.fsBase, height: 1.5),
                ),
                const SizedBox(height: 16),
                if (state.scanning) const LinearProgressIndicator(minHeight: 2),
                if (state.importError != null) ...[
                  Text(
                    state.importError!,
                    style: const TextStyle(color: PB.danger, fontSize: PB.fsSm),
                  ),
                  TextButton(
                    onPressed: busy ? null : state.scanLocal,
                    child: const Text('重新扫描'),
                  ),
                ] else if (!state.scanning && state.localEntries.isEmpty)
                  const Text(
                    '没有发现本机工具配置。也可以返回添加远程或本地工具服务。',
                    style: TextStyle(color: PB.textTertiary, fontSize: PB.fsSm),
                  ),
                for (final entry in state.localEntries)
                  CheckboxListTile(
                    contentPadding: EdgeInsets.zero,
                    controlAffinity: ListTileControlAffinity.leading,
                    title: Text(
                      entry.name,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                    ),
                    subtitle: Text(
                      entry.imported ? '已导入' : entry.description,
                      maxLines: 2,
                      overflow: TextOverflow.ellipsis,
                    ),
                    value: entry.imported || _selected.contains(entry.name),
                    onChanged: busy || entry.imported
                        ? null
                        : (value) => setState(() {
                            if (value == true) {
                              _selected.add(entry.name);
                            } else {
                              _selected.remove(entry.name);
                            }
                          }),
                  ),
                if (state.importResult != null)
                  Text(
                    state.importResult!,
                    style: const TextStyle(
                      fontSize: PB.fsSm,
                      color: PB.textSecondary,
                    ),
                  ),
                if (_error != null)
                  Text(
                    _error!,
                    style: const TextStyle(color: PB.danger, fontSize: PB.fsSm),
                  ),
              ],
            ),
          ),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context),
            child: const Text('关闭'),
          ),
          FilledButton(
            onPressed: busy || _selected.isEmpty ? null : _import,
            child: Text(state.isBusy('local-import') ? '导入中…' : '导入所选'),
          ),
        ],
      );
    },
  );
}
