import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../scope.dart';
import '../theme.dart';

/// 给 bot 选模型 —— 文本框 + 一个「选」按钮。
///
/// 为什么要按钮：内置模型是几个固定别名，但用户自己配的模型组里模型名是随便起的，
/// 让人手打 `<组id>/<模型名>` 太劝退。所以下面给一个可选列表
/// （模型组的模型 + 内置别名），点一下就填进去；当然也允许直接手打。
class ModelPickerField extends StatelessWidget {
  const ModelPickerField({
    super.key,
    required this.controller,
    this.label = '模型（留空用默认）',
  });

  final TextEditingController controller;
  final String label;

  @override
  Widget build(BuildContext context) {
    return TextField(
      controller: controller,
      decoration: InputDecoration(
        labelText: label,
        hintText: 'cline/cline-pass/deepseek-v4.1-flash',
        suffixIcon: IconButton(
          tooltip: '从列表里选',
          icon: const Icon(LucideIcons.list, size: 18),
          onPressed: () => _pick(context),
        ),
      ),
    );
  }

  Future<void> _pick(BuildContext context) async {
    final state = AppScope.read(context);
    final groups = state.modelGroups;

    final picked = await showDialog<String>(
      context: context,
      builder: (ctx) => AlertDialog(
        backgroundColor: PB.bgElevated,
        title: const Text('选一个模型', style: TextStyle(fontSize: PB.fsLg)),
        content: SizedBox(
          width: 460,
          child: SingleChildScrollView(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              mainAxisSize: MainAxisSize.min,
              children: [
                if (groups.isEmpty)
                  const Text(
                    '你还没配模型组。\n去「设置 → 模型组」加一个 baseUrl + key，\n'
                    '之后这里的模型就能直接选了。',
                    style: TextStyle(
                      fontSize: PB.fsXs,
                      color: PB.textQuaternary,
                      height: 1.7,
                    ),
                  )
                else
                  for (final g in groups) ...[
                    Padding(
                      padding: const EdgeInsets.only(top: 6, bottom: 4),
                      child: Text(
                        g.name,
                        style: const TextStyle(
                          fontSize: PB.fsXs,
                          fontWeight: FontWeight.w600,
                          color: PB.textTertiary,
                        ),
                      ),
                    ),
                    for (final m in g.models)
                      ListTile(
                        dense: true,
                        contentPadding: EdgeInsets.zero,
                        title: Text(
                          m.id,
                          style: const TextStyle(
                            fontSize: PB.fsSm,
                            color: PB.textPrimary,
                          ),
                        ),
                        subtitle: Text(
                          [
                            if (m.contextWindow > 0)
                              '${(m.contextWindow / 1000).round()}k 上下文',
                            if (m.maxTokens > 0) '最多出 ${m.maxTokens}',
                          ].join(' · '),
                          style: const TextStyle(
                            fontSize: PB.fsXxs,
                            color: PB.textQuaternary,
                          ),
                        ),
                        onTap: () => Navigator.pop(ctx, g.slugFor(m.id)),
                      ),
                  ],
              ],
            ),
          ),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(ctx),
            child: const Text('取消'),
          ),
        ],
      ),
    );
    if (picked != null && picked.isNotEmpty) {
      controller.text = picked;
    }
  }
}
