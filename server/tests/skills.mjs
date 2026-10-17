/**
 * 技能库测试：规范化、SKILL.md 解析、按任务挑选。
 *
 * 重点：
 *   · 存进去和读出来的形状必须稳定（否则"能存不能匹配"很难查）；
 *   · 导入普通 markdown 也要能用（不能因为没 frontmatter 就拒绝）；
 *   · 挑选要"宁缺毋滥" —— 没相关的就不给，不能塞一堆撑上下文。
 */
import assert from 'node:assert/strict';
import {
  normalizeSkill,
  normalizeSkillList,
  parseSkillMarkdown,
  selectSkillsFor,
  splitWords,
  skillsPromptLines,
  SKILL_LIMITS,
} from '../src/skills.js';

let pass = 0;
let fail = 0;
function test(name, fn) {
  try {
    fn();
    console.log(`✓ ${name}`);
    pass++;
  } catch (err) {
    console.log(`✗ ${name}\n    ${err.message}`);
    fail++;
  }
}

test('规范化：标题必填，其余有默认值', () => {
  assert.equal(normalizeSkill({}), null, '没标题就不该收');
  assert.equal(normalizeSkill({ title: '   ' }), null, '空白标题也算没标题');

  const s = normalizeSkill({ title: '查日志' });
  assert.equal(s.title, '查日志');
  assert.equal(s.enabled, true, '默认启用');
  assert.deepEqual(s.tags, []);
  assert.ok(s.id.startsWith('sk_'));
});

test('规范化：超长字段被截断（它们会进提示词）', () => {
  const s = normalizeSkill({
    title: 'x'.repeat(200),
    summary: 'y'.repeat(500),
    howto: 'z'.repeat(9000),
    tags: Array.from({ length: 20 }, (_, i) => `tag${i}1234567890`),
  });
  assert.equal(s.title.length, SKILL_LIMITS.title);
  assert.equal(s.summary.length, SKILL_LIMITS.summary);
  assert.equal(s.howto.length, SKILL_LIMITS.howto);
  assert.equal(s.tags.length, SKILL_LIMITS.tags);
  assert.ok(s.tags.every((t) => t.length <= SKILL_LIMITS.tagLength));
});

test('规范化：标签去重、去空', () => {
  const s = normalizeSkill({ title: 't', tags: ['a', 'a', ' ', 'b'] });
  assert.deepEqual(s.tags, ['a', 'b']);
});

test('整库：同标题去重（重复导入同一份文件很常见）', () => {
  const list = normalizeSkillList([
    { title: '查日志', howto: 'A' },
    { title: '查日志', howto: 'B' },
    { title: '发版', howto: 'C' },
  ]);
  assert.equal(list.length, 2);
  assert.equal(list[0].howto, 'A', '保留第一条');
});

test('整库：条数上限', () => {
  const many = Array.from({ length: SKILL_LIMITS.total + 50 }, (_, i) => ({ title: `s${i}` }));
  assert.equal(normalizeSkillList(many).length, SKILL_LIMITS.total);
});

test('解析 SKILL.md：带 frontmatter', () => {
  const md = `---
name: 查日志三步
description: 线上排查先看这条
tags: [运维, 排查]
---

# 步骤

1. 先看 server.log
2. 再看 pid
`;
  const s = parseSkillMarkdown(md, 'x.md');
  assert.equal(s.title, '查日志三步');
  assert.equal(s.summary, '线上排查先看这条');
  assert.deepEqual(s.tags, ['运维', '排查']);
  assert.match(s.howto, /先看 server\.log/, 'howto 不该包含 frontmatter');
  assert.ok(!s.howto.includes('---'), 'frontmatter 要从正文里去掉');
});

test('解析 SKILL.md：没有 frontmatter 用一级标题', () => {
  const s = parseSkillMarkdown('# 发版流程\n\n先跑测试再打包', 'whatever.md');
  assert.equal(s.title, '发版流程');
  assert.match(s.howto, /先跑测试再打包/);
});

test('解析 SKILL.md：什么都没有就用文件名', () => {
  const s = parseSkillMarkdown('就是一段说明文字', '我的技能.md');
  assert.equal(s.title, '我的技能');
  assert.equal(s.howto, '就是一段说明文字');
});

test('解析 SKILL.md：空内容返回 null', () => {
  assert.equal(parseSkillMarkdown(''), null);
  assert.equal(parseSkillMarkdown('   \n  '), null);
  assert.equal(parseSkillMarkdown('---\nname: x\n---\n'), null, '只有 frontmatter 没有正文');
});

test('解析 SKILL.md：frontmatter 里的引号被去掉', () => {
  const s = parseSkillMarkdown('---\nname: "带引号的名字"\ndescription: \'单引号\'\n---\n正文');
  assert.equal(s.title, '带引号的名字');
  assert.equal(s.summary, '单引号');
});

test('解析 SKILL.md：CRLF 换行也能处理', () => {
  const s = parseSkillMarkdown('---\r\nname: win\r\n---\r\n正文在这', 'a.md');
  assert.equal(s.title, 'win');
  assert.equal(s.howto, '正文在这');
});

test('分词：中文取 2~4 字滑窗，单字不要', () => {
  const words = splitWords('查日志');
  assert.ok(words.includes('查日'));
  assert.ok(words.includes('日志'));
  assert.ok(words.includes('查日志'));
  assert.ok(!words.includes('查'), '单字会命中一切，不能要');
});

test('分词：英文按词切', () => {
  const words = splitWords('Run Tests');
  assert.ok(words.includes('run'));
  assert.ok(words.includes('tests'));
});

test('挑选：标题命中得分最高', () => {
  const skills = normalizeSkillList([
    { title: '查日志', howto: '看 server.log' },
    { title: '发版', howto: '打包上传' },
  ]);
  const picked = selectSkillsFor(skills, '帮我查一下线上日志');
  assert.equal(picked.length, 1);
  assert.equal(picked[0].title, '查日志');
});

test('挑选：标签命中也能选中', () => {
  const skills = normalizeSkillList([
    { title: '某个流程', howto: '步骤', tags: ['发版'] },
  ]);
  const picked = selectSkillsFor(skills, '今天要发版了');
  assert.equal(picked.length, 1);
});

test('挑选：不相关的一条都不给（宁缺毋滥）', () => {
  const skills = normalizeSkillList([{ title: '查日志', howto: '看 server.log' }]);
  assert.deepEqual(selectSkillsFor(skills, '今天天气怎么样'), []);
});

test('挑选：停用的不参与', () => {
  const skills = normalizeSkillList([{ title: '查日志', howto: '看日志', enabled: false }]);
  assert.deepEqual(selectSkillsFor(skills, '帮我查日志'), []);
});

test('挑选：最多给 max 条，分高的在前', () => {
  const skills = normalizeSkillList([
    { title: '发版', howto: 'a', tags: ['发版'] },
    { title: '发版检查清单', howto: 'b', tags: ['发版'] },
    { title: '发版回滚', howto: 'c', tags: ['发版'] },
    { title: '无关', howto: 'd' },
  ]);
  const picked = selectSkillsFor(skills, '发版前要做什么', { max: 2 });
  assert.equal(picked.length, 2);
});

test('挑选：空任务返回空（没话说就别乱给）', () => {
  const skills = normalizeSkillList([{ title: '查日志', howto: 'x' }]);
  assert.deepEqual(selectSkillsFor(skills, ''), []);
  assert.deepEqual(selectSkillsFor(skills, '   '), []);
});

test('提示词：没有命中就什么都不加', () => {
  assert.deepEqual(skillsPromptLines([]), []);
});

test('提示词：包含标题、摘要和做法', () => {
  const lines = skillsPromptLines([
    { title: '查日志', summary: '线上排查', howto: '1. 看 server.log' },
  ]);
  const text = lines.join('\n');
  assert.match(text, /查日志/);
  assert.match(text, /线上排查/);
  assert.match(text, /server\.log/);
});

console.log(`\n技能库测试：${pass}/${pass + fail} 通过`);
if (fail > 0) process.exit(1);
