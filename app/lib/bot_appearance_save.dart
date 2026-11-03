import 'app_state.dart';
import 'appearance_save_controller.dart';
import 'avatar_appearance.dart';
import 'models.dart';

final _appearanceSaves = AppearanceSaveControllers();

/// 外观保存绑定到原连接；仅最新选择的有效响应回写当前 AppState。
AppearanceSaveController botAppearanceSave(AppState state, Bot bot) {
  final api = state.api;
  final id = bot.id;
  return _appearanceSaves.forBot(
    scope: api ?? state,
    botId: id,
    initialColor: bot.avatarColor,
    initialShape: bot.avatarShape,
    save: (request) async {
      if (api == null || !identical(state.api, api)) return false;
      final response = await api.patch(
        '/api/bots/${Uri.encodeComponent(id)}',
        request.patch,
      );
      final raw = response['bot'];
      if (raw is! Map ||
          raw['id'] != id ||
          !raw.containsKey('avatarColor') ||
          !raw.containsKey('avatarShape')) {
        return false;
      }
      final color = raw['avatarColor'];
      final shape = raw['avatarShape'];
      if ((color != null &&
              (color is! String || parseAvatarColor(color) == null)) ||
          (shape != null &&
              (shape is! int || normalizeAvatarShape(shape) == null))) {
        return false;
      }
      if (normalizeAvatarColor(color as String?) != request.color ||
          shape != request.shape) {
        return false;
      }
      if (!identical(state.api, api)) return false;
      if (request.isCurrent) {
        final current = state.botById(id);
        if (current != null) {
          current.avatarColor = request.color;
          current.avatarShape = request.shape;
          state.applyBotUpdate(current);
        }
      }
      return true;
    },
  );
}
