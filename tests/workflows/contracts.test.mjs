import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeWorkflow, normalizeActionResult } from './contracts.mjs';

test('工作流拒绝重复动作 ID 和未知 outcome', () => {
  assert.throws(() => normalizeWorkflow({
    id: 'S01', name: '完整生命周期', risk: 'P0', fixture: 'baseline', timeoutMs: 60_000,
    actions: [
      { id: 'a', type: 'navigate', expect: 'success', revisionDelta: [0, 1] },
      { id: 'a', type: 'navigate', expect: 'success', revisionDelta: [0, 1] }
    ]
  }), /duplicate action id/);
  assert.throws(() => normalizeActionResult({ actionId: 'a', outcome: 'maybe' }), /unknown outcome/);
});

test('导航以外的只读动作只能声明零 revisionDelta', () => {
  const workflow = {
    id: 'S01', name: '搜索', risk: 'P0', fixture: 'baseline', timeoutMs: 60_000,
    actions: [{ id: 'search', type: 'search', expect: 'success', revisionDelta: [0, 1] }]
  };
  assert.throws(() => normalizeWorkflow(workflow), /read-only action revisionDelta must be 0/);
});

test('非导航写动作不能声明导航 revisionDelta 范围', () => {
  const workflow = {
    id: 'S01', name: '预约', risk: 'P0', fixture: 'baseline', timeoutMs: 60_000,
    actions: [{ id: 'reserve', type: 'reserve', expect: 'success', revisionDelta: [0, 1] }]
  };
  assert.throws(() => normalizeWorkflow(workflow), /only navigation or file actions may declare \[0, 1\]/);
  assert.doesNotThrow(() => normalizeWorkflow({
    id: 'M11', name: '旧 DOM', risk: 'P0', fixture: 'history', timeoutMs: 60_000,
    actions: [{ id: 'old', type: 'startTodo', expect: 'rejected', revisionDelta: [0, 1], params: { sampleId: 'REQ-001.001', old: true } }]
  }));
});

test('restart 与 reloadCurrent 必须声明重新登录产生的 [2, 3] 持久化边界', () => {
  for (const type of ['restart', 'reloadCurrent']) {
    assert.doesNotThrow(() => normalizeWorkflow({
      id: 'S99', name: '生命周期恢复', risk: 'P0', fixture: 'baseline', timeoutMs: 30_000,
      actions: [{ id: type, type, expect: 'success', revisionDelta: [2, 3], params: {}, maxMs: 30_000 }]
    }));
    assert.throws(() => normalizeWorkflow({
      id: 'S99', name: '错误生命周期合同', risk: 'P0', fixture: 'baseline', timeoutMs: 30_000,
      actions: [{ id: type, type, expect: 'success', revisionDelta: [0, 1], params: {}, maxMs: 30_000 }]
    }), /restart and reloadCurrent must declare \[2, 3\]/);
  }
});
