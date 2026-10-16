const fs = require('fs');
const p = 'lib/screens/rooms_screen.dart';
let s = fs.readFileSync(p, 'utf8');

s = s.replace(
  "import '../widgets/blob_avatar.dart';",
  "import '../widgets/blob_avatar.dart';\nimport '../widgets/skeleton.dart';",
);

// 加载骨架：还没连上又没有会话时给形状
s = s.replace(
  `                if (rooms.isEmpty)
                  Padding(
                    padding: const EdgeInsets.only(top: 110),
                    child: Column(
                      children: [
                        Icon(Icons.bubble_chart_outlined, size: 38, color: PB.textQuaternary),
                        const SizedBox(height: 16),
                        Text(
                          _query.isEmpty ? '还没有会话' : '没找到「$_query」',
                          style: const TextStyle(color: PB.textTertiary, fontSize: PB.fsSm),
                        ),
                      ],
                    ),
                  ),`,
  `                if (rooms.isEmpty && _query.isEmpty && state.link != LinkState.online)
                  const RoomListSkeleton()
                else if (rooms.isEmpty)
                  Padding(
                    padding: const EdgeInsets.only(top: 110),
                    child: Column(
                      children: [
                        Container(
                          width: 64,
                          height: 64,
                          decoration: BoxDecoration(
                            color: PB.bgBubble,
                            borderRadius: BorderRadius.circular(20),
                            border: Border.all(color: PB.borderTertiary),
                          ),
                          child: const Icon(Icons.bubble_chart_outlined, size: 26, color: PB.textQuaternary),
                        ),
                        const SizedBox(height: 18),
                        Text(
                          _query.isEmpty ? '还没有会话' : '没找到「$_query」',
                          style: const TextStyle(
                            color: PB.textSecondary,
                            fontSize: PB.fsSm,
                            fontWeight: FontWeight.w500,
                          ),
                        ),
                        const SizedBox(height: 6),
                        const Text(
                          '点右上角 + 建一个团队',
                          style: TextStyle(color: PB.textQuaternary, fontSize: PB.fsXs),
                        ),
                      ],
                    ),
                  ),`,
);

// 列表项：加动画 + 选中态左侧强调条 + 主控身份环
s = s.replace(
  `      child: Material(
        color: (_pressed || widget.selected) ? PB.bgHover : Colors.transparent,
        borderRadius: BorderRadius.circular(12),
        child: InkWell(
          borderRadius: BorderRadius.circular(12),
          onTap: () => widget.onOpen(room),
          onLongPress: () => _roomMenu(context, room),
          onHighlightChanged: (v) => setState(() => _pressed = v),
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 9),
            child: Row(
              children: [`,
  `      child: Stack(
        children: [
          AnimatedContainer(
            duration: const Duration(milliseconds: 140),
            curve: Curves.easeOut,
            decoration: BoxDecoration(
              color: (widget.selected || _pressed) ? PB.bgHover : Colors.transparent,
              borderRadius: BorderRadius.circular(12),
            ),
            child: Material(
              color: Colors.transparent,
              borderRadius: BorderRadius.circular(12),
              child: InkWell(
                borderRadius: BorderRadius.circular(12),
                onTap: () => widget.onOpen(room),
                onLongPress: () => _roomMenu(context, room),
                onHighlightChanged: (v) => setState(() => _pressed = v),
                child: Padding(
                  padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 9),
                  child: Row(
                    children: [`,
);

s = s.replace(
  `                if (room.isGroup)
                  GroupBlobAvatar(seeds: room.botIds, size: 46, animate: false)
                else
                  BlobAvatar(
                    seed: room.botIds.isNotEmpty ? room.botIds.first : room.id,
                    color: PB.colorFor(room.botIds.isNotEmpty ? room.botIds.first : room.id),
                    emoji: state.botById(room.botIds.isNotEmpty ? room.botIds.first : null)?.emoji,
                    size: 46,
                    animate: false,
                    badge: busy
                        ? const SizedBox(
                            width: 11,
                            height: 11,
                            child: CircularProgressIndicator(strokeWidth: 1.6, color: PB.accent),
                          )
                        : null,
                  ),`,
  `                if (room.isGroup)
                  GroupBlobAvatar(seeds: room.botIds, size: 46, animate: false)
                else
                  BlobAvatar(
                    seed: room.botIds.isNotEmpty ? room.botIds.first : room.id,
                    color: PB.colorFor(room.botIds.isNotEmpty ? room.botIds.first : room.id),
                    emoji: state.botById(room.botIds.isNotEmpty ? room.botIds.first : null)?.emoji,
                    size: 46,
                    animate: false,
                    ring: state.botById(room.botIds.isNotEmpty ? room.botIds.first : null)?.isMain ?? false,
                    badge: busy
                        ? const SizedBox(
                            width: 12,
                            height: 12,
                            child: CircularProgressIndicator(strokeWidth: 1.8, color: PB.accent),
                          )
                        : null,
                  ),`,
);

// 行内文字层级
s = s.replace(
  `                      Row(
                        children: [
                          Expanded(
                            child: Text(
                              room.name,
                              style: const TextStyle(
                                fontSize: PB.fsBase,
                                fontWeight: FontWeight.w500,
                                color: PB.textPrimary,
                              ),
                              overflow: TextOverflow.ellipsis,
                            ),
                          ),
                          const SizedBox(width: 8),
                          Text(
                            formatTime(room.lastMessageAt),
                            style: const TextStyle(fontSize: PB.fsXxs, color: PB.textQuaternary),
                          ),
                        ],
                      ),
                      const SizedBox(height: 3),
                      Text(
                        preview,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: TextStyle(fontSize: PB.fsSm, color: busy ? PB.accent : PB.textTertiary),
                      ),`,
  `                      Row(
                        children: [
                          Expanded(
                            child: Text(
                              room.name,
                              style: const TextStyle(
                                fontSize: PB.fsBase,
                                fontWeight: FontWeight.w600,
                                letterSpacing: -0.1,
                                color: PB.textPrimary,
                              ),
                              overflow: TextOverflow.ellipsis,
                            ),
                          ),
                          const SizedBox(width: 8),
                          Text(
                            formatTime(room.lastMessageAt),
                            style: const TextStyle(
                              fontSize: PB.fsXxs,
                              color: PB.textQuaternary,
                              fontFeatures: [FontFeature.tabularFigures()],
                            ),
                          ),
                        ],
                      ),
                      const SizedBox(height: 4),
                      Text(
                        preview,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: TextStyle(
                          fontSize: PB.fsSm,
                          height: 1.3,
                          color: busy ? PB.accent : PB.textTertiary,
                        ),
                      ),`,
);

// 收尾：多包了一层 Stack，补上选中强调条 + 关闭括号
s = s.replace(
  `                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }

  Future<void> _roomMenu(BuildContext context, Room room) async {`,
  `                    ],
                  ),
                ),
              ),
            ),
          ),
          if (widget.selected)
            Positioned(
              left: 0,
              top: 12,
              bottom: 12,
              child: Container(
                width: 3,
                decoration: BoxDecoration(
                  color: PB.accent,
                  borderRadius: BorderRadius.circular(2),
                ),
              ),
            ),
        ],
      ),
    );
  }

  Future<void> _roomMenu(BuildContext context, Room room) async {`,
);

s = s.replace(
  "import 'package:flutter/material.dart';",
  "import 'dart:ui' show FontFeature;\n\nimport 'package:flutter/material.dart';",
);

fs.writeFileSync(p, s);
console.log('rooms_screen 质感补丁完成');
