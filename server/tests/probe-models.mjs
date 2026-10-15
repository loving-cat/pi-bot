/**
 * 探测哪些模型真的能用（每个跑一句最短的话）。
 *   node tests/probe-models.mjs [provider/model ...]
 */
import { ModelRuntime, SessionManager, createAgentSession } from '@earendil-works/pi-coding-agent';

const candidates = process.argv.slice(2);
if (!candidates.length) {
  console.error('用法: node tests/probe-models.mjs provider/model [provider/model ...]');
  process.exit(2);
}

const rt = await ModelRuntime.create();

for (const slug of candidates) {
  const idx = slug.indexOf('/');
  const provider = slug.slice(0, idx);
  const id = slug.slice(idx + 1);
  const model = rt.getModel(provider, id);
  if (!model) {
    console.log(`✗ ${slug}  —  models.json 里没有这个模型`);
    continue;
  }
  const started = Date.now();
  let session;
  try {
    const created = await createAgentSession({
      model,
      sessionManager: SessionManager.inMemory(),
      tools: [],
    });
    session = created.session;
    let text = '';
    session.subscribe((ev) => {
      if (ev.type === 'message_update' && ev.assistantMessageEvent?.type === 'text_delta') {
        text += ev.assistantMessageEvent.delta;
      }
    });
    const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error('超时 60s')), 60_000));
    await Promise.race([session.prompt('只回答两个字：你好'), timeout]);
    const ms = Date.now() - started;
    const trimmed = text.trim();
    console.log(`${trimmed ? '✓' : '✗'} ${slug}  —  ${ms}ms  ${trimmed ? JSON.stringify(trimmed.slice(0, 60)) : '(空输出)'}`);
  } catch (err) {
    console.log(`✗ ${slug}  —  ${Date.now() - started}ms  ${String(err?.message || err).slice(0, 160)}`);
  } finally {
    session?.dispose();
  }
}
