/**
 * 把 app 里所有 Material Icons 换成 Lucide（线性、统一 2px 描边、现代）。
 * 用法：node tools/icons.cjs
 */
const fs = require('fs');
const path = require('path');

const MAP = {
  'Icons.search': 'LucideIcons.search',
  'Icons.add': 'LucideIcons.plus',
  'Icons.close': 'LucideIcons.x',
  'Icons.settings_outlined': 'LucideIcons.settings',
  'Icons.settings': 'LucideIcons.settings',
  'Icons.refresh': 'LucideIcons.refreshCw',
  'Icons.sync': 'LucideIcons.refreshCw',
  'Icons.arrow_upward_rounded': 'LucideIcons.arrowUp',
  'Icons.arrow_downward': 'LucideIcons.arrowDown',
  'Icons.stop_rounded': 'LucideIcons.square',
  'Icons.more_horiz': 'LucideIcons.ellipsis',
  'Icons.qr_code_scanner_rounded': 'LucideIcons.scanLine',
  'Icons.bolt_rounded': 'LucideIcons.zap',
  'Icons.bolt_outlined': 'LucideIcons.zap',
  'Icons.bolt': 'LucideIcons.zap',
  'Icons.autorenew_rounded': 'LucideIcons.loader',
  'Icons.check': 'LucideIcons.check',
  'Icons.check_circle_outline': 'LucideIcons.circleCheck',
  'Icons.error_outline': 'LucideIcons.circleAlert',
  'Icons.info_outline': 'LucideIcons.info',
  'Icons.help_outline': 'LucideIcons.circleHelp',
  'Icons.chat_bubble_outline': 'LucideIcons.messageSquare',
  'Icons.forum_outlined': 'LucideIcons.messagesSquare',
  'Icons.groups_2_outlined': 'LucideIcons.users',
  'Icons.smart_toy_outlined': 'LucideIcons.bot',
  'Icons.phonelink_lock_outlined': 'LucideIcons.smartphone',
  'Icons.devices_outlined': 'LucideIcons.monitorSmartphone',
  'Icons.dns_outlined': 'LucideIcons.server',
  'Icons.tune_outlined': 'LucideIcons.slidersHorizontal',
  'Icons.home_outlined': 'LucideIcons.house',
  'Icons.link_off': 'LucideIcons.unlink',
  'Icons.swap_horiz': 'LucideIcons.arrowLeftRight',
  'Icons.smartphone': 'LucideIcons.smartphone',
  'Icons.lan_outlined': 'LucideIcons.network',
  'Icons.no_photography_outlined': 'LucideIcons.cameraOff',
  'Icons.flashlight_on': 'LucideIcons.flashlight',
  'Icons.flashlight_off': 'LucideIcons.flashlightOff',
  'Icons.delete_outline': 'LucideIcons.trash2',
  'Icons.chevron_right': 'LucideIcons.chevronRight',
  'Icons.verified_user': 'LucideIcons.shieldCheck',
  'Icons.tag': 'LucideIcons.hash',
  'Icons.copy_all_outlined': 'LucideIcons.clipboardCopy',
  'Icons.copy_rounded': 'LucideIcons.copy',
  'Icons.terminal': 'LucideIcons.terminal',
  'Icons.image_outlined': 'LucideIcons.image',
  'Icons.image': 'LucideIcons.image',
  'Icons.upload_file_outlined': 'LucideIcons.fileUp',
  'Icons.open_in_new': 'LucideIcons.externalLink',
  'Icons.broken_image_outlined': 'LucideIcons.imageOff',
  'Icons.picture_as_pdf_outlined': 'LucideIcons.fileText',
  'Icons.table_chart_outlined': 'LucideIcons.table',
  'Icons.description_outlined': 'LucideIcons.fileText',
  'Icons.folder_zip_outlined': 'LucideIcons.fileArchive',
  'Icons.insert_drive_file_outlined': 'LucideIcons.file',
  'Icons.cloud_off': 'LucideIcons.cloudOff',
  'Icons.bubble_chart_outlined': 'LucideIcons.sparkles',
  'Icons.refresh_outlined': 'LucideIcons.refreshCw',
};

const dir = 'lib';
const files = [];
(function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith('.dart')) files.push(p);
  }
})(dir);

let touched = 0;
let replacements = 0;
for (const file of files) {
  let src = fs.readFileSync(file, 'utf8');
  const before = src;
  for (const [from, to] of Object.entries(MAP)) {
    // 只替换完整 token，避免 Icons.add 命中 Icons.add_comment 之类
    const re = new RegExp(`(?<![A-Za-z0-9_])${from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![A-Za-z0-9_])`, 'g');
    const hits = (src.match(re) || []).length;
    if (hits) {
      src = src.replace(re, to);
      replacements += hits;
    }
  }
  if (src !== before) {
    // 确保有 import
    if (!src.includes("lucide_icons_flutter/lucide_icons.dart")) {
      const lines = src.split('\n');
      let lastImport = -1;
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].startsWith('import ')) lastImport = i;
      }
      if (lastImport >= 0) {
        lines.splice(lastImport + 1, 0, "import 'package:lucide_icons_flutter/lucide_icons.dart';");
        src = lines.join('\n');
      }
    }
    fs.writeFileSync(file, src);
    touched++;
  }
}

// 检查还有没有漏网的 Material Icons
const leftovers = [];
for (const file of files) {
  const src = fs.readFileSync(file, 'utf8');
  for (const m of src.matchAll(/\bIcons\.[A-Za-z0-9_]+/g)) {
    if (m[0] !== 'Icons.copyWith') leftovers.push(`${file}: ${m[0]}`);
  }
}
console.log(`替换 ${replacements} 处，涉及 ${touched} 个文件`);
if (leftovers.length) {
  console.log('还有未映射的 Material Icons：');
  for (const l of [...new Set(leftovers)]) console.log('  ' + l);
} else {
  console.log('✓ 没有残留的 Material Icons');
}
