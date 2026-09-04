import test from 'node:test';
import assert from 'node:assert/strict';
import { createSeededRandom } from './prng.mjs';

test('同一十进制 seed 生成完全一致序列', () => {
  const left = createSeededRandom(20260822);
  const right = createSeededRandom(20260822);
  assert.deepEqual(Array.from({ length: 20 }, () => left.int(0, 999)), Array.from({ length: 20 }, () => right.int(0, 999)));
});

test('非法 seed 和非正权重被拒绝', () => {
  assert.throws(() => createSeededRandom(-1), /seed/);
  assert.throws(() => createSeededRandom(1).weightedPick([{ weight: 0, value: 'x' }]), /weight/);
});
