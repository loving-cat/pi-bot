import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  skillFingerprint,
  skillsPromptLines,
  skillsToInject,
} from '../src/skills.js';

// ---------------------------------------------------------------------------
// 技能只注入一次
//
// 实测背景：7 轮的群聊里，同一个 bot 的上下文有 89% 是重复的技能正文。
// 同一份 8,266 字符的内容在会话历史里存了 7 份。
// 它既是上下文膨胀的主因，也是缓存失效的主因 ——
// 每轮 prompt 前缀都不一样，服务端缓存全废。
// ---------------------------------------------------------------------------

const skill = (id, updatedAt = 100, howto = '怎么做') => ({
  id,
  title: '技能' + id,
  summary: '一句话',
  howto,
  updatedAt,
});

test('第一次全都给', () => {
  const picked = [skill('a'), skill('b')];
  const { skills } = skillsToInject(picked);
  assert.equal(skills.length, 2);
});

test('★ 给过的第二次不再给 —— 这就是省下 89% 的关键', () => {
  const a = skill('a');
  const b = skill('b');
  const given = new Set([skillFingerprint(a), skillFingerprint(b)]);
  const { skills } = skillsToInject([a, b], { alreadyGiven: given });
  assert.equal(skills.length, 0, '两个都给过了，这轮不该再注入');
});

test('只给新匹配到的，已给过的跳过', () => {
  const a = skill('a');
  const b = skill('b');
  const given = new Set([skillFingerprint(a)]);
  const { skills } = skillsToInject([a, b], { alreadyGiven: given });
  assert.equal(skills.length, 1);
  assert.equal(skills[0].id, 'b');
});

test('★ 技能被改过（updatedAt 变了）要重新给', () => {
  // 旧内容已经过时，不能因为"给过"就不更新
  const before = skill('a', 100);
  const given = new Set([skillFingerprint(before)]);
  const after = skill('a', 999);
  const { skills } = skillsToInject([after], { alreadyGiven: given });
  assert.equal(skills.length, 1, '内容变了要重给');
});

test('★ 压缩之后全部重给', () => {
  // 压缩把老消息收成摘要了，技能正文可能真没了 ——
  // 这是"只给一次"唯一必须撤回的场景
  const a = skill('a');
  const given = new Set([skillFingerprint(a)]);
  const { skills } = skillsToInject([a], {
    alreadyGiven: given,
    afterCompaction: true,
  });
  assert.equal(skills.length, 1, '压缩后必须重给');
});

test('没有记录时按第一次处理（宽松，宁可多给一次）', () => {
  const { skills } = skillsToInject([skill('a')], { alreadyGiven: null });
  assert.equal(skills.length, 1);
});

test('脏数据不炸', () => {
  assert.equal(skillsToInject(null).skills.length, 0);
  assert.equal(skillsToInject([null, undefined, {}]).skills.length, 0);
  assert.equal(skillsToInject([skill('a')], { alreadyGiven: new Set() }).skills.length, 1);
});

// ---------------------------------------------------------------------------
// 指纹
// ---------------------------------------------------------------------------

test('同一内容指纹稳定', () => {
  assert.equal(skillFingerprint(skill('a', 100)), skillFingerprint(skill('a', 100)));
});

test('内容变了指纹就变', () => {
  assert.notEqual(skillFingerprint(skill('a', 100)), skillFingerprint(skill('a', 200)));
});

test('不同技能指纹不同', () => {
  assert.notEqual(skillFingerprint(skill('a')), skillFingerprint(skill('b')));
});

// ---------------------------------------------------------------------------
// 渲染
// ---------------------------------------------------------------------------

test('空列表不产生任何段落（调用方直接展开）', () => {
  assert.equal(skillsPromptLines([]).length, 0);
  assert.equal(skillsPromptLines(null).length, 0);
});

test('段落里带标题和正文', () => {
  const lines = skillsPromptLines([skill('a', 100, '第一步：先读文档')]);
  const text = lines.join('\n');
  assert.match(text, /技能a/);
  assert.match(text, /第一步：先读文档/);
});