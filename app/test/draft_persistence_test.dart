// R41 草稿持久化：切换会话与重启应用都要保住草稿。
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:pi_bot/app_state.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  setUp(() async {
    SharedPreferences.setMockInitialValues({});
  });

  test('R41a 设置草稿后能读回', () async {
    final state = AppState();
    await state.loadDrafts();
    state.setDraft('room_a', '这是一段没发出去的话');
    expect(state.draftFor('room_a'), '这是一段没发出去的话');
  });

  test('R41b 空内容即清除', () async {
    final state = AppState();
    await state.loadDrafts();
    state.setDraft('room_a', 'x');
    state.setDraft('room_a', '');
    expect(state.draftFor('room_a'), '');
  });

  test('R41c 草稿会落盘，新实例能读回来（模拟重启应用）', () async {
    final first = AppState();
    await first.loadDrafts();
    first.setDraft('room_a', '关掉应用也不能丢');
    // 等防抖写盘
    await Future<void>.delayed(const Duration(milliseconds: 900));

    // 全新实例 = 重启后的应用
    final second = AppState();
    await second.loadDrafts();
    expect(second.draftFor('room_a'), '关掉应用也不能丢',
        reason: '草稿只放内存的话，重启应用就全丢了');
  });

  test('R41d 多个会话的草稿互不干扰且都能恢复', () async {
    final first = AppState();
    await first.loadDrafts();
    first.setDraft('room_a', 'A 的草稿');
    first.setDraft('room_b', 'B 的草稿');
    await Future<void>.delayed(const Duration(milliseconds: 900));

    final second = AppState();
    await second.loadDrafts();
    expect(second.draftFor('room_a'), 'A 的草稿');
    expect(second.draftFor('room_b'), 'B 的草稿');
    expect(second.draftFor('room_c'), '');
  });
}
