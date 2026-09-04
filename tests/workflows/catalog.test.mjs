import assert from 'node:assert/strict';
import test from 'node:test';

import { WORKFLOW_CATALOG, selectWorkflows } from './catalog.mjs';

const ALL_IDS = [
  'S01', 'S02', 'S03', 'S04', 'S05', 'S06', 'S07', 'S08',
  'D01', 'D02', 'D03', 'D04', 'D05', 'D06', 'D07', 'D08',
  'M01', 'M02', 'M03', 'M04', 'M05', 'M06', 'M07', 'M08', 'M09', 'M10', 'M11', 'M12'
];
const QUICK_EXTRA = new Set(['D05', 'D07', 'D08', 'M04', 'M06', 'M08', 'M10']);

test('总目录精确为 S01-S08、D01-D08、M01-M12 且递归冻结', () => {
  assert.deepEqual(WORKFLOW_CATALOG.map(item => item.id), ALL_IDS);
  assert.equal(WORKFLOW_CATALOG.length, 28);
  assert.equal(new Set(WORKFLOW_CATALOG.map(item => item.id)).size, 28);
  assert.equal(Object.isFrozen(WORKFLOW_CATALOG), true);
  for (const workflow of WORKFLOW_CATALOG) {
    assert.equal(Object.isFrozen(workflow), true, workflow.id);
    assert.equal(Object.isFrozen(workflow.actions), true, `${workflow.id} actions`);
    for (const item of workflow.actions) {
      assert.equal(Object.isFrozen(item), true, `${workflow.id}/${item.id}`);
      assert.equal(Object.isFrozen(item.params), true, `${workflow.id}/${item.id} params`);
    }
  }
});

test('full 返回精确 28 条，quick 返回全部 P0 加固定七条 P1', () => {
  assert.deepEqual(selectWorkflows({ mode: 'full' }).map(item => item.id), ALL_IDS);
  const quick = selectWorkflows({ mode: 'quick' }).map(item => item.id);
  assert.equal(quick.length, 27);
  assert.deepEqual(quick, ALL_IDS.filter(id => id !== 'S06'));
  assert.deepEqual(quick.filter(id => QUICK_EXTRA.has(id)), ['D05', 'D07', 'D08', 'M04', 'M06', 'M08', 'M10']);
  assert.throws(() => selectWorkflows({ mode: 'fast' }), /unknown workflow mode: fast/);
});

test('显式 IDs 保持调用者顺序和重复并拒绝未知 ID', () => {
  assert.deepEqual(selectWorkflows({ mode: 'quick', ids: ['M12', 'S01', 'M12', 'D04'] }).map(item => item.id), ['M12', 'S01', 'M12', 'D04']);
  assert.throws(() => selectWorkflows({ mode: 'full', ids: ['S01', 'X99'] }), /unknown workflow id: X99/);
  assert.throws(() => selectWorkflows({ mode: 'full', ids: 'S01' }), /ids must be an array/);
});

test('合并目录每条动作 ID 唯一且 workflow timeout 覆盖 maxMs 总和', () => {
  for (const workflow of WORKFLOW_CATALOG) {
    assert.equal(new Set(workflow.actions.map(item => item.id)).size, workflow.actions.length, `${workflow.id} action IDs`);
    assert.ok(workflow.timeoutMs >= workflow.actions.reduce((sum, item) => sum + item.maxMs, 0), `${workflow.id} timeout`);
  }
});
