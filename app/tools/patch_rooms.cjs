const fs = require('fs');
const p = 'lib/screens/rooms_screen.dart';
let s = fs.readFileSync(p, 'utf8');

s = s.replace(
  `class RoomsScreen extends StatefulWidget {
  const RoomsScreen({super.key});

  @override
  State<RoomsScreen> createState() => _RoomsScreenState();
}`,
  `class RoomsScreen extends StatefulWidget {
  const RoomsScreen({super.key, this.embedded = false, this.selectedId, this.onSelect});

  /// 宽屏分栏里当左栏用：点会话不跳页，交给 onSelect
  final bool embedded;
  final String? selectedId;
  final void Function(Room room)? onSelect;

  @override
  State<RoomsScreen> createState() => _RoomsScreenState();
}`,
);

s = s.replace(
  `                for (final room in rooms) _RoomRow(room: room, state: state),`,
  `                for (final room in rooms)
                  _RoomRow(
                    room: room,
                    state: state,
                    selected: widget.selectedId == room.id,
                    onOpen: (r) {
                      if (widget.onSelect != null) {
                        widget.onSelect!(r);
                      } else {
                        Navigator.push(
                          context,
                          MaterialPageRoute(builder: (_) => ChatScreen(room: r)),
                        );
                      }
                    },
                  ),`,
);

s = s.replace(
  `class _RoomRow extends StatefulWidget {
  const _RoomRow({required this.room, required this.state});

  final Room room;
  final AppState state;`,
  `class _RoomRow extends StatefulWidget {
  const _RoomRow({
    required this.room,
    required this.state,
    required this.onOpen,
    this.selected = false,
  });

  final Room room;
  final AppState state;
  final void Function(Room room) onOpen;
  final bool selected;`,
);

s = s.replace(
  `      child: Material(
        color: _pressed ? PB.bgHover : Colors.transparent,
        borderRadius: BorderRadius.circular(12),
        child: InkWell(
          borderRadius: BorderRadius.circular(12),
          onTap: () => Navigator.push(context, MaterialPageRoute(builder: (_) => ChatScreen(room: room))),`,
  `      child: Material(
        color: (_pressed || widget.selected) ? PB.bgHover : Colors.transparent,
        borderRadius: BorderRadius.circular(12),
        child: InkWell(
          borderRadius: BorderRadius.circular(12),
          onTap: () => widget.onOpen(room),`,
);

fs.writeFileSync(p, s);
console.log('rooms_screen 补丁完成');
