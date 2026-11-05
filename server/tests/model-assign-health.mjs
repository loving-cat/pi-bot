import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveMenu } from '../src/model-menu.js';

/// 模型分配不该被"线路暂时不通"挡住。
///
/// 用户反馈：主控分配模型时，有时候模型组里的某些模型分不出去。
/// 根因是 checkModel 里 alive === false 时直接拒绝 —— 而 alive 来自
/// 健康探测记录，线路抖一下（限流、上游临时故障、24h 内的旧记录）
/// 就会把用户刚配好的模型判成"不可分配"。
void main2();

function main2() {
  const entries = [
    { alias: 'gpt/a', label: 'a', slugs: ['g1/a'], tier: 'custom' },
    { alias: 'gpt/b', label: 'b', slugs: ['g1/b'], tier: 'custom' },
  ];

  test('健康记录说 dead 时，模型仍是"已知的"（不该从菜单里消失）', () => {
    const health = {
      peek: () => ({ ok: false, at: Date.now() }),
      wasGood: () => false,
      isKnownDead: () => true,
      hasFreshFor: () => true,
    };
    const picked = resolveMenu('gpt/b', health, entries);
    assert.ok(picked, '模型应该还能被解析到');
    assert.equal(picked.entry.alias, 'gpt/b');
    // alive=false 只是"当前探测不通"，不代表这个模型不存在
    assert.equal(picked.alive, false);
    assert.equal(picked.status, 'unavailable');
  });

  test('健康记录说 ok 时是 verified', () => {
    const health = {
      peek: () => ({ ok: true, at: Date.now() }),
      wasGood: () => true,
      isKnownDead: () => false,
      hasFreshFor: () => true,
    };
    const picked = resolveMenu('gpt/a', health, entries);
    assert.equal(picked.alive, true);
    assert.equal(picked.status, 'verified');
  });

  test('没有健康记录时算 unverified —— 不是 unavailable（没测过≠不可用）', () => {
    const health = {
      peek: () => null,
      wasGood: () => false,
      isKnownDead: () => false,
      hasFreshFor: () => false,
    };
    const picked = resolveMenu('gpt/a', health, entries);
    assert.equal(picked.alive, true, '没探测过不该判死');
    assert.equal(picked.status, 'unverified');
  });

  test('曾经好过、现在记录过期：仍算 alive', () => {
    const health = {
      peek: () => null,
      wasGood: () => true,
      isKnownDead: () => false,
      hasFreshFor: () => true,
    };
    const picked = resolveMenu('gpt/a', health, entries);
    assert.equal(picked.alive, true);
  });
}
