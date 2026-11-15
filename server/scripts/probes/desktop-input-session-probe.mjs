import { spawn, spawnSync } from 'node:child_process';
const m = await import(new URL('./src/desktop-input-win.js', import.meta.url));

const ps = (s) => spawnSync('powershell', ['-NoProfile','-NonInteractive','-Command', s], {encoding:'utf8'});

// 1. 开一个记事本当靶子，把原剪贴板存起来
const before = ps("Get-Clipboard -Raw -Format Text").stdout ?? '';
const note = spawn('notepad.exe', [], { detached: true, stdio: 'ignore' });
note.unref();
await new Promise(r => setTimeout(r, 2500));

// 2. 让记事本到前台（用 PowerShell 的 AppActivate 不好使，直接点它自己也行）
//    改用一个可控的：新建一个 WinForms 窗体太麻烦，直接给记事本激活
ps(`Add-Type -AssemblyName Microsoft.VisualBasic; [Microsoft.VisualBasic.Interaction]::AppActivate('记事本')`);
ps(`$w = New-Object -ComObject WScript.Shell; $w.AppActivate('无标题 - 记事本')`);
await new Promise(r => setTimeout(r, 800));

const env = m.probeEnvironment();
console.log('env:', JSON.stringify(env));
const fg = m.foregroundTitle();
console.log('foreground:', JSON.stringify(fg));

// 3. 输入一段带中文与特殊字符的文字（测剪贴板路径 + 转义）
const text = 'pi-bot 输入测试 ✅ $HOME `backtick` "quoted" 结束';
const typed = m.performAction({ action: 'type_text', text });
console.log('type_text:', JSON.stringify(typed).slice(0, 200));
await new Promise(r => setTimeout(r, 500));

// 4. 全选复制，把内容读回来核对
const sel = m.performAction({ action: 'keyCombo', keyCombo: ['ctrl', 'a'] });
const cop = m.performAction({ action: 'keyCombo', keyCombo: ['ctrl', 'c'] });
await new Promise(r => setTimeout(r, 500));
const got = ps("Get-Clipboard -Raw -Format Text").stdout ?? '';
console.log('selector:', sel.ok, 'copy:', cop.ok);
console.log('got:', JSON.stringify(got.trim()));
console.log('MATCH:', got.trim() === text);

// 5. 收尾：不保存关掉记事本，还原剪贴板
m.performAction({ action: 'keyCombo', keyCombo: ['alt', 'f4'] });
await new Promise(r => setTimeout(r, 700));
// 若有"是否保存"对话框，按 n（不保存）
m.performAction({ action: 'key', key: 'n' });
await new Promise(r => setTimeout(r, 400));
ps(`Set-Clipboard -Value $null`);
if (before) ps(`Set-Clipboard -Value @'
${before}
'@`);
