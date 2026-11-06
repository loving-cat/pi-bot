import 'package:flutter_test/flutter_test.dart';
import 'package:pi_bot/widgets/toast.dart';

// 轻提示的形态与规矩。
//
// 真实问题：删除结果这类「知道了就行」的消息原先走 SnackBar ——
// 它铺在窗口底部、横跨整个内容区，挡住的正是消息列表下沿和输入框。
// 现代桌面应用里这种通知方式过时了。
//
// 测的是 toast.dart 的真实实现，不是在这里抄一份逻辑。

void main() {
  group('同时最多几条', () {
    test('没满时不挤掉任何人', () {
      expect(toastEvictionsFor(0), 0);
      expect(toastEvictionsFor(1), 0);
      expect(toastEvictionsFor(2), 0);
    });

    test('★ 满了再来一条，挤掉最老的那条', () {
      // 3 条已满，new 一条 → 收掉 1 条
      expect(toastEvictionsFor(kToastMaxLive), 1);
    });

    test('超出的越多，收掉的越多', () {
      expect(toastEvictionsFor(kToastMaxLive + 1), 2);
      expect(toastEvictionsFor(kToastMaxLive + 2), 3);
    });

    test('上限是 3 —— 刷屏时不该把整块屏幕盖住', () {
      expect(kToastMaxLive, 3);
    });
  });

  group('停留时长', () {
    test('失败比成功久 —— 用户要读完才知道下一步做什么', () {
      final success = defaultToastDuration(ToastKind.success);
      final error = defaultToastDuration(ToastKind.error);
      expect(error.inMilliseconds, greaterThan(success.inMilliseconds));
    });

    test('成功只是「知道了就行」，两秒多足够', () {
      expect(
        defaultToastDuration(ToastKind.success).inMilliseconds,
        lessThanOrEqualTo(3000),
      );
    });

    test('失败至少留 3 秒', () {
      expect(
        defaultToastDuration(ToastKind.error).inSeconds,
        greaterThanOrEqualTo(3),
      );
    });

    test('info 用成功那档时长（它也只是告知）', () {
      expect(
        defaultToastDuration(ToastKind.info),
        kToastSuccessDuration,
      );
    });
  });
}