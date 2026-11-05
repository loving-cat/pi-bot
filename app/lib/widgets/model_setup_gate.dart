import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../l10n/l10n.dart';
import '../scope.dart';
import '../theme.dart';
import 'default_model_picker.dart';
import 'model_group_editor.dart';

/// 没有任何模型组时的强制引导。
///
/// 为什么要有这一页：没有模型时 bot 收到消息只会静默失败，
/// 用户看到的是"它不理我"，而不是"我还没配模型"。
/// 与其让用户去猜，不如在进入主界面前把这件事讲清楚并给出入口。
class ModelSetupGate extends StatelessWidget {
  const ModelSetupGate({super.key});

  @override
  Widget build(BuildContext context) {
    final strings = L10n.s(context);
    final state = AppScope.of(context);
    return Scaffold(
      backgroundColor: PB.bgApp,
      // ★ 用 SizedBox.expand 撑满窗口，不要让它按内容收缩。
      //
      //   桌面端窗口的尺寸由 Flutter 视图的约束决定：如果根页面是
      //   Center + 滚动视图这种"按内容定大小"的结构，窗口会缩到内容那么大
      //   （实测会收缩成 131x130，几乎看不见）。HostConnectScreen 也是
      //   Scaffold 直接撑满，这里保持一致。
      body: SizedBox.expand(
        child: Center(
          child: ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 520),
            child: SingleChildScrollView(
              padding: const EdgeInsets.all(28),
              child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              mainAxisSize: MainAxisSize.min,
              children: [
                Row(
                  children: [
                    Container(
                      width: 40,
                      height: 40,
                      decoration: BoxDecoration(
                        color: PB.colors(context).accentBright.withValues(alpha: .14),
                        borderRadius: BorderRadius.circular(PB.rLg),
                      ),
                      child: Icon(
                        LucideIcons.cpu,
                        size: 20,
                        color: PB.colors(context).accentBright,
                      ),
                    ),
                    const SizedBox(width: 12),
                    Expanded(
                      child: Text(
                        strings.t('onboard.title'),
                        style: const TextStyle(
                          fontSize: PB.fsXl,
                          fontWeight: FontWeight.w600,
                        ),
                      ),
                    ),
                  ],
                ),
                const SizedBox(height: 14),
                Text(
                  strings.t('onboard.subtitle'),
                  style: const TextStyle(
                    fontSize: PB.fsSm,
                    color: PB.textSecondary,
                    height: 1.6,
                  ),
                ),
                const SizedBox(height: 18),
                _step(context, 1, strings.t('onboard.step1')),
                _step(context, 2, strings.t('onboard.step2')),
                _step(context, 3, strings.t('onboard.step3')),
                const SizedBox(height: 24),
                SizedBox(
                  width: double.infinity,
                  child: FilledButton.icon(
                    key: const ValueKey('model-setup-start'),
                    onPressed: () => _start(context),
                    icon: const Icon(LucideIcons.plus, size: 16),
                    label: Text(strings.t('onboard.start')),
                  ),
                ),
                const SizedBox(height: 8),
                Center(
                  child: TextButton(
                    key: const ValueKey('model-setup-later'),
                    onPressed: () => state.dismissModelSetup(),
                    child: Text(strings.t('onboard.later')),
                  ),
                ),
              ],
            ),
          ),
          ),
        ),
      ),
    );
  }

  /// 配好之后立刻让用户挑默认模型 —— 不挑的话主控仍然不知道该用哪个。
  Future<void> _start(BuildContext context) async {
    await openModelGroupEditor(context);
    if (!context.mounted) return;
    final state = AppScope.of(context);
    // 配置成功（现在有可用模型）才继续问默认模型
    if (state.modelGroups.any((g) => g.models.isNotEmpty)) {
      await showDefaultModelPicker(context);
    }
  }

  Widget _step(BuildContext context, int n, String text) => Padding(
    padding: const EdgeInsets.only(bottom: 10),
    child: Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Container(
          width: 20,
          height: 20,
          alignment: Alignment.center,
          decoration: BoxDecoration(
            color: PB.bgBubble,
            borderRadius: BorderRadius.circular(10),
            border: Border.all(color: PB.borderSecondary),
          ),
          child: Text(
            '$n',
            style: const TextStyle(fontSize: PB.fsXxs, color: PB.textSecondary),
          ),
        ),
        const SizedBox(width: 10),
        Expanded(
          child: Text(
            text,
            style: const TextStyle(
              fontSize: PB.fsSm,
              color: PB.textSecondary,
              height: 1.55,
            ),
          ),
        ),
      ],
    ),
  );
}
