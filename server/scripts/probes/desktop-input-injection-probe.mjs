/**
 * 实机注入回归探针：把一串 PS 元字符喂给 `type_text`，验证它们在**目标程序里
 * 变成字面文字**，而不是在 PowerShell 里被求值。
 *
 *   node scripts/probes/desktop-input-injection-probe.mjs
 *
 * 为什么需要这个：`type_text` 的实现是「把文字嵌进一段 PowerShell 双引号字符串
 * → Set-Clipboard」。文字来自模型，里面完全可能有 `" $ ` 这些能改变语义的字符。
 * 转义写漏一个，整段脚本就变成"执行模型写的东西"—— 那就等于把 shell 交出去了。
 *
 * 判据两条，缺一不可：
 *   1. 靶子 TextBox 收到的是**原文**（一字不差）
 *   2. 用来做标记的文件**没有**被创建（说明注入的 Set-Content 没有执行）
 *
 * 需要交互式会话（会弹一个靶子窗口），所以不在 CI 里跑。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const marker = path.join(os.tmpdir(), 'pib-inject-proof.txt');
try { fs.unlinkSync(marker); } catch {}
const p = spawn('powershell', ['-NoProfile','-STA','-ExecutionPolicy','Bypass','-File',
  new URL('./desktop-input-paste-target.ps1', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')], { stdio: 'ignore' });
setTimeout(async () => {
  const m = await import(new URL('../../src/desktop-input-win.js', import.meta.url));
  const parts = [
    'x"; Set-Content -Path ' + marker + ' -Value PWNED; "',
    '$(Set-Content -Path ' + marker + ' -Value PWNED2)',
    '`Set-Content -Path ' + marker + ' -Value PWNED3' + ' `',
    "'; Set-Content -Path " + marker + " -Value PWNED4; '",
  ];
  const evil = parts.join(' | ');
  const r = m.performAction({ action: 'type_text', text: evil });
  console.log('type ok:', r.ok, r.ok ? '' : r.text.slice(0, 120));
  await new Promise((z) => setTimeout(z, 1600));
  const got = fs.readFileSync(path.join(os.tmpdir(), 'pib-paste-target.txt'), 'utf8')
    .replace(/^\uFEFF/, '').trim();
  console.log('typed   :', JSON.stringify(got));
  console.log('expected:', JSON.stringify(evil));
  console.log('MATCH   :', got === evil);
  console.log('INJECTION HAPPENED:', fs.existsSync(marker));
  if (fs.existsSync(marker)) console.log('marker:', fs.readFileSync(marker, 'utf8').trim());
  p.kill();
}, 3000);
