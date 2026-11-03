import 'dart:async';

import 'package:flutter/material.dart';

import '../bot_appearance_save.dart';
import '../models.dart';
import '../scope.dart';
import 'bot_appearance_controls.dart';

/// 将外观选择绑定到当前服务和 Bot 的共享保存队列。
class BotAppearanceSection extends StatelessWidget {
  const BotAppearanceSection({super.key, required this.bot});

  final Bot bot;

  @override
  Widget build(BuildContext context) {
    final state = AppScope.of(context);
    final current = state.botById(bot.id) ?? bot;
    final save = botAppearanceSave(state, current);
    return AnimatedBuilder(
      animation: save,
      builder: (context, _) => BotAppearanceControls(
        key: ObjectKey(save),
        seed: current.id,
        color: save.color,
        shape: save.shape,
        isMain: current.isMain,
        isSaving: save.isSaving,
        isSaved: save.isSaved,
        error: save.error,
        canRetry: save.canRetry,
        onColorChanged: (color) => unawaited(save.setColor(color)),
        onShapeChanged: (shape) => unawaited(save.setShape(shape)),
        onRetry: () => unawaited(save.retry()),
      ),
    );
  }
}
