/**
 * 白名单模型 × 思考等级 全矩阵测试。
 * 目的：找出「某些模型在某些 thinking 档位下返回空内容」这种会静默失败的组合。
 *   node tests/model-matrix.mjs
 */
import { ModelRuntime, SessionManager, createAgentSession } from '@earendil-works/pi-coding-agent';
import { loadExtraProviders } from '../src/providers.js';
import { MODEL_MENU } from '../src/model-menu.js';

const rt = await ModelRuntime.create();
for (const [id, cfg] of Object.entries(loadExtraProviders())) rt.registerProvider(id, cfg);

const levels = ['off', 'low', 'medium', 'high'];
// 稍微长一点的提示词，更接近真实场景
const PROMPT =
  '用三句话说明：做 A 股行情看板时，后端接口应该返回哪些字段？直接给结论，不要客套。';

function textOf(msg) {
  const c = msg?.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.filter((p) => p?.type === 'text').map((p) => p.text).join('');
  return '';
}

const results = [];
for (const entry of MODEL_MENU) {
  for (const slug of entry.slugs) {
    const idx = slug.indexOf('/');
    const model = rt.getModel(slug.slice(0, idx), slug.slice(idx + 1));
    if (!model) {
      results.push({ alias: entry.alias, slug, level: '-', ok: false, note: '模型不存在' });
      continue;
    }
    for (const level of levels) {
      const started = Date.now();
      let session;
      try {
        const created = await createAgentSession({
          model,
          thinkingLevel: level,
          sessionManager: SessionManager.inMemory(),
          tools: [],
        });
        session = created.session;
        let text = '';
        let thinking = 0;
        session.subscribe((ev) => {
          if (ev.type === 'message_update') {
            const inner = ev.assistantMessageEvent;
            if (inner?.type === 'text_delta') text += inner.delta;
            if (inner?.type === 'thinking_delta') thinking += inner.delta.length;
          }
        });
        const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error('超时 60s')), 60_000));
        await Promise.race([session.prompt(PROMPT), timeout]);
        const trimmed = text.trim();
        results.push({
          alias: entry.alias,
          slug,
          level,
          ok: trimmed.length > 0,
          ms: Date.now() - started,
          chars: trimmed.length,
          thinking,
          note: trimmed.length ? '' : thinking > 0 ? `只有思考(${thinking}字)没正文` : '完全空',
        });
      } catch (err) {
        results.push({
          alias: entry.alias,
          slug,
          level,
          ok: false,
          ms: Date.now() - started,
          note: String(err?.message || err).slice(0, 90),
        });
      } finally {
        session?.dispose();
      }
    }
  }
}

console.log('\n================ 模型 × 思考等级 矩阵 ================');
console.log('别名'.padEnd(16) + 'slug'.padEnd(46) + 'level'.padEnd(8) + '结果');
for (const r of results) {
  const mark = r.ok ? `✓ ${r.chars}字` : '✗';
  console.log(
    r.alias.padEnd(16) +
      r.slug.padEnd(46) +
      String(r.level).padEnd(8) +
      `${mark.padEnd(10)} ${r.ms ?? ''}ms  ${r.note ?? ''}`,
  );
}
const bad = results.filter((r) => !r.ok);
console.log(`\n总计 ${results.length} 组合，失败 ${bad.length}`);
if (bad.length) {
  console.log('失败清单：');
  for (const b of bad) console.log(`  ${b.slug} @ ${b.level} → ${b.note}`);
}
