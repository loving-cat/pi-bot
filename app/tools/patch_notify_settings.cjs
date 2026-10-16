const fs = require('fs');
const p = 'lib/screens/settings_screen.dart';
let s = fs.readFileSync(p, 'utf8');

s = s.replace(
  "import '../scope.dart';",
  "import '../native.dart';\nimport '../notify.dart';\nimport '../scope.dart';",
);

s = s.replace(
  `              const SizedBox(height: 22),
              const _SectionTitle(icon: Icons.tune_outlined, title: '操作'),`,
  `              const SizedBox(height: 22),
              const _SectionTitle(
                icon: LucideIcons.bellRing,
                title: '后台通知',
                subtitle: '锁屏也能收到机器人干完活的消息',
              ),
              _Card(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    const _Hint(
                      '不走 FCM。App 会起一个低优先级的常驻通知保住连接，\\n'
                      '机器人干完活时再单独推一条消息通知。',
                    ),
                    const SizedBox(height: 14),
                    Row(
                      children: [
                        Expanded(
                          child: OutlinedButton.icon(
                            onPressed: () async {
                              await Notifier.init();
                              await Notifier.show(
                                title: 'pi-bot 通知测试',
                                body: '看到这条说明通知是通的 ✅',
                                roomId: null,
                              );
                            },
                            icon: const Icon(LucideIcons.bellRing, size: 16),
                            label: const Text('发一条测试通知'),
                          ),
                        ),
                      ],
                    ),
                    const SizedBox(height: 8),
                    Row(
                      children: [
                        Expanded(
                          child: OutlinedButton.icon(
                            onPressed: () async {
                              await Native.requestIgnoreBatteryOptimizations();
                            },
                            icon: const Icon(LucideIcons.batteryCharging, size: 16),
                            label: const Text('加入电池白名单'),
                          ),
                        ),
                      ],
                    ),
                    const SizedBox(height: 8),
                    const Text(
                      '国产 ROM 不加白名单的话，常驻服务也会被系统清掉，通知就收不到了。',
                      style: TextStyle(fontSize: PB.fsXxs, color: PB.textQuaternary, height: 1.5),
                    ),
                  ],
                ),
              ),

              const SizedBox(height: 22),
              const _SectionTitle(icon: LucideIcons.slidersHorizontal, title: '操作'),`,
);

// 去掉旧的 tune_outlined section title（已经被上面替换）
fs.writeFileSync(p, s);
console.log('settings 已加后台通知区块');
