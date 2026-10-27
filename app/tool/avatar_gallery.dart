import 'package:flutter/material.dart';
import 'package:pi_bot/theme.dart';
import 'package:pi_bot/widgets/avatar_life.dart';
import 'package:pi_bot/widgets/avatar_character.dart';
import 'package:pi_bot/widgets/blob_avatar.dart';

/// 独立角色预览入口，使用合成身份，不连接服务端或读取用户配置。
void main() => runApp(const AvatarGallery());

class AvatarGallery extends StatefulWidget {
  const AvatarGallery({super.key});

  @override
  State<AvatarGallery> createState() => _AvatarGalleryState();
}

class _AvatarGalleryState extends State<AvatarGallery> {
  bool _busy = false;
  bool _animate = true;
  static final _seeds = List.generate(12, (i) => 'bot-$i');

  Widget _avatar(String seed, double size, {bool ring = false}) => BlobAvatar(
    seed: seed,
    color: PB.colorFor(seed),
    size: size,
    ring: ring,
    animate: _animate,
    mood: _busy ? AvatarMood.busy : AvatarMood.idle,
  );

  @override
  Widget build(BuildContext context) => MaterialApp(
    title: 'pi-bot Avatar Studio',
    debugShowCheckedModeBanner: false,
    theme: ThemeData.dark().copyWith(
      scaffoldBackgroundColor: const Color(0xFF0F131B),
    ),
    builder: (context, child) => AvatarLife.watchPointer(child: child!),
    home: Scaffold(
      body: SafeArea(
        child: SingleChildScrollView(
          padding: const EdgeInsets.all(28),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              const Text(
                'PI-BOT / AVATAR STUDIO',
                style: TextStyle(
                  fontFamily: 'Inter',
                  fontSize: 26,
                  fontWeight: FontWeight.w600,
                ),
              ),
              const SizedBox(height: 10),
              const Text(
                '14 / 22 / 46 / 96 px · move the pointer across a card',
                style: TextStyle(color: Colors.white60),
              ),
              const SizedBox(height: 16),
              Wrap(
                spacing: 20,
                children: [
                  Row(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      const Text('Busy'),
                      Switch(
                        value: _busy,
                        onChanged: (value) => setState(() => _busy = value),
                      ),
                    ],
                  ),
                  Row(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      const Text('Animation'),
                      Switch(
                        value: _animate,
                        onChanged: (value) => setState(() => _animate = value),
                      ),
                    ],
                  ),
                ],
              ),
              const SizedBox(height: 20),
              Wrap(
                spacing: 12,
                runSpacing: 12,
                children: [
                  for (var i = 0; i < _seeds.length; i++)
                    AvatarHoverScope(
                      child: Container(
                        width: 190,
                        height: 252,
                        padding: const EdgeInsets.all(16),
                        decoration: BoxDecoration(
                          color: const Color(0xFF191F2B),
                          borderRadius: BorderRadius.circular(20),
                        ),
                        child: Column(
                          children: [
                            SizedBox(
                              height: 118,
                              child: Center(
                                child: _avatar(_seeds[i], 96, ring: i == 0),
                              ),
                            ),
                            Text(
                              'BOT ${i + 1} · ${AvatarCharacter.fromSeed(_seeds[i]).kind.name}',
                              style: const TextStyle(
                                fontFamily: 'Inter',
                                fontSize: 11,
                                color: Colors.white70,
                              ),
                            ),
                            const Spacer(),
                            Row(
                              mainAxisAlignment: MainAxisAlignment.spaceEvenly,
                              children: [
                                _avatar(_seeds[i], 46),
                                _avatar(_seeds[i], 22),
                                _avatar(_seeds[i], 14),
                              ],
                            ),
                          ],
                        ),
                      ),
                    ),
                ],
              ),
              const SizedBox(height: 24),
              Wrap(
                spacing: 24,
                runSpacing: 12,
                children: [
                  for (final count in [0, 1, 2, 4])
                    Column(
                      children: [
                        GroupBlobAvatar(
                          seeds: _seeds.take(count).toList(),
                          size: 64,
                          animate: _animate,
                          mood: _busy ? AvatarMood.busy : AvatarMood.idle,
                        ),
                        const SizedBox(height: 8),
                        Text(
                          '$count members',
                          style: const TextStyle(
                            color: Colors.white60,
                            fontSize: 11,
                          ),
                        ),
                      ],
                    ),
                ],
              ),
            ],
          ),
        ),
      ),
    ),
  );
}
