/**
 * 附件链路测试：上传 Excel/图片 → 发消息 → 看 bot 有没有真的读到内容。
 *   node tests/attach.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import WebSocket from 'ws';
import * as XLSX from 'xlsx';

const base = process.argv[2] || 'http://127.0.0.1:8787';
const token = process.argv[3] ?? '';
const roomName = process.argv[4] || 'Pi';
const auth = token ? { authorization: (token ? `Bearer ${token}` : '') } : {};

// 造一个 xlsx
const dir = 'D:/pi-bot/server/data';
fs.mkdirSync(dir, { recursive: true });
const wb = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(
  wb,
  XLSX.utils.aoa_to_sheet([
    ['股票代码', '名称', '市值(亿)', '涨跌幅'],
    ['002920', '德赛西威', 1204.5, '+3.2%'],
    ['600519', '贵州茅台', 18230.0, '-0.8%'],
    ['300750', '宁德时代', 9876.4, '+1.1%'],
  ]),
  '持仓',
);
const xlsxPath = `${dir}/持仓样例.xlsx`;
XLSX.writeFile(wb, xlsxPath);

// 造一个 png（纯色 64x64）
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAYAAACqaXHeAAAAWklEQVR42u3PMQEAAAgDoJnc6BpjDyQgd2XAqQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAADwYwG4AAG3dQ0iAAAAAElFTkSuQmCC',
  'base64',
);
const pngPath = `${dir}/样例图.png`;
fs.writeFileSync(pngPath, png);

async function upload(file, name) {
  const res = await fetch(`${base}/api/uploads?name=${encodeURIComponent(name)}`, {
    method: 'POST',
    headers: { ...auth, 'content-type': 'application/octet-stream' },
    body: fs.readFileSync(file),
  });
  const json = await res.json();
  if (!json.attachment) throw new Error(`上传失败：${JSON.stringify(json)}`);
  console.log(`  ↑ 上传 ${name} → ${json.attachment.id} (${json.attachment.kind}, ${json.attachment.size}B)`);
  return json.attachment;
}

const state = await (await fetch(`${base}/api/state`, { headers: auth })).json();
const room = state.rooms.find((r) => r.name === roomName) ?? state.rooms[0];
console.log(`会话：${room.name} (${room.id})`);

console.log('--- 上传附件 ---');
const xlsx = await upload(xlsxPath, '持仓样例.xlsx');
const image = await upload(pngPath, '样例图.png');

const ws = new WebSocket(`${base.replace(/^http/, 'ws')}/ws?token=${token}`);
let done = false;
let lastLen = 0;
const texts = [];

ws.on('message', (raw) => {
  const ev = JSON.parse(raw.toString());
  if (ev.t === 'hello') {
    console.log('--- 发消息（带 Excel + 图片）---');
    ws.send(
      JSON.stringify({
        t: 'send',
        roomId: room.id,
        text: '这两个附件里有什么？把 Excel 里的股票和市值念给我，图片你看到了什么？',
        attachments: [xlsx.id, image.id],
      }),
    );
  }
  if (ev.t === 'msg.new' && ev.msg.authorType === 'bot') {
    console.log(`\n[${ev.msg.authorName}] 开始回…`);
    lastLen = 0;
  }
  if (ev.t === 'msg.delta') {
    if (ev.text.length > lastLen) {
      process.stdout.write(ev.text.slice(lastLen));
      lastLen = ev.text.length;
    }
  }
  if (ev.t === 'msg.steps' && ev.steps.length) {
    const s = ev.steps[ev.steps.length - 1];
    console.log(`  🔧 ${s.tool} ${s.status}`);
  }
  if (ev.t === 'msg.done' && ev.msg.authorType === 'bot' && !done) {
    done = true;
    texts.push(ev.msg.text);
    const all = texts.join('\n');
    const hitStock = all.includes('德赛西威') || all.includes('002920');
    const hitImage = all.includes('图') || all.includes('64') || all.includes('PNG') || all.includes('png');
    console.log(`\n\n--- 完成 ---`);
    console.log(hitStock ? '✅ 读到了 Excel 内容' : '❌ 没读到 Excel 内容');
    console.log(hitImage ? '✅ 提到了图片' : '⚠️ 没提图片（模型可能不支持视觉）');
    ws.close();
    process.exit(hitStock ? 0 : 1);
  }
  if (ev.t === 'msg.error') {
    console.log('\n❌ 出错：', ev.error);
    process.exit(1);
  }
});
setTimeout(() => {
  console.error('超时');
  process.exit(1);
}, 240_000);
