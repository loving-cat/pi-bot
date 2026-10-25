# 头像表情细节（待办）

> 2026-10-25 记录。用户："眼睛目前是纯深色胶囊，参考里有些头像是
> 两只眼睛 + 一点嘴或腮红的。要不要加点表情细节？" → 答："先记录下来，明天做"

## 现状

`app/lib/widgets/blob_avatar.dart` 的 `_BlobPainter.paint()` 末尾，眼睛是两个
圆角竖条（`eyeW = 0.128 * side`、`eyeH = 0.225 * side`、`Color.lerp(color,
Colors.black, 0.86)`）。眨眼靠 `blink` 压扁高度，视线靠 `gaze` 平移。

形状已经做出辨识度（bean / pebble / egg / pill / hexagon / tri / tear /
squircle / blob 九种，见 `BlobAvatar.shapeKindOf`），**下一步是表情**。

## 要做的

1. **嘴**：一条很短的弧线或小圆点。idle 时是小小的微笑弧，busy 时收成一个
   专注的小点（"在使劲"）。
2. **腮红**：两侧各一个很淡的圆斑（用 `color` 提亮、低 alpha），只在较大尺寸画。
3. 可选：按 `AvatarMood` 区分整体表情（现在 mood 只影响视线抬起和是否睡觉）。

## 两条硬约束

### 1. 小尺寸门控

聊天顶部的胶囊里头像只有 **22px**。任何细节在那个尺寸都会糊成一个脏点。

参考现有做法：`_emojiBadge()` 里 `widget.size < 40` 直接不画角标。
表情细节照同样的思路分档：

- `< 26px`：只有眼睛（现状）
- `>= 26px`：+ 嘴
- `>= 40px`：+ 腮红

### 2. 性能红线：raster 保持 ~1.9ms

曾经尝试"真 2.5D"（球面漫反射 + 镜面高光 + rim light + 眼窝阴影），
代价是 4 个 shader + 2 次 `clipPath`，实测 **raster 1.9ms → 7.8ms**，
还出现 43 帧超过 16ms，已整体回滚。

所以新增细节**只能用纯色 `fill`**，不要再引入新的 `createShader` 或
`clipPath`。

测法：

```powershell
$env:PI_BOT_FRAME_LOG="$env:TEMP\bench.log"
# 启动 pi_bot.exe，等十几秒，读日志最后几行
# 格式：帧数 平均ms P90 最慢 超16ms buildms rasterms
```

## 验收

- `flutter test` 全绿（现有 361 条 + 新增的表情门控测试）
- raster 与改造前持平（≈1.9ms），无超 16ms 帧
- 22px / 46px / 96px 三档截图肉眼确认：小尺寸不变脏，大尺寸有表情
