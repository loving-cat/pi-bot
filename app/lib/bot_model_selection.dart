import 'app_state.dart';
import 'model_selection_save.dart';
import 'models.dart';

final _selections = ModelSelectionSaves();

/// 将模型写入队列绑定到原服务端和 Bot，成功响应只回写仍相同的连接。
ModelSelectionSave botModelSelection(AppState state, Bot bot) {
  final api = state.api;
  final id = bot.id;
  return _selections.forBot(
    scope: api ?? state,
    botId: id,
    initialValue: bot.model ?? '',
    save: (value) async {
      if (api == null) throw StateError('未连接服务端');
      final response = await api.patch('/api/bots/${Uri.encodeComponent(id)}', {
        'model': value,
      });
      final raw = response['bot'];
      if (raw is! Map) throw StateError('模型保存响应无效');
      final updated = Bot.fromJson(raw.cast<String, dynamic>());
      final confirmed = (updated.model ?? '').trim();
      if (updated.id != id || confirmed.isEmpty != value.isEmpty) {
        throw StateError('模型保存响应不一致');
      }
      if (identical(state.api, api)) state.applyBotUpdate(updated);
      return confirmed;
    },
  );
}
