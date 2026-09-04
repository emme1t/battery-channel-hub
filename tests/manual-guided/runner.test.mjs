import assert from 'node:assert/strict';
import test from 'node:test';

import { runManualScenario } from './runner.mjs';

function scenario(overrides = {}) {
  return {
    id: 'B01',
    title: '纵向申请单导入',
    manualSection: '使用说明 §4',
    dataIds: ['normal-vertical-1'],
    visiblePrecondition: '已登录并位于测试申请表格',
    actions: [
      { id: 'B01-import', type: 'importFile', expect: 'success', params: { dataId: 'normal-vertical-1' } },
      { id: 'B01-cancel', type: 'cancelDialog', expect: 'cancelled', params: { buttonName: '导入单个 Excel' } }
    ],
    allowedVisibleOutcomes: ['success', 'cancelled'],
    oracleRule: '每步通过只读快照核验安全；取消动作零业务写入',
    recovery: '取消后保持同一会话继续操作',
    compressed: false,
    maximumDurationMs: 30_000,
    ...overrides
  };
}

test('runner resolves generated data and verifies each visible action with read-only snapshots', async () => {
  let sequence = 0;
  const snapshots = [];
  const zeroWritePairs = [];
  const safety = [];
  const oracle = {
    capture({ dataRoot }) {
      const snapshot = { hash: `snapshot-${sequence++}`, dataRoot };
      snapshots.push(snapshot);
      return snapshot;
    },
    assertSafety(snapshot) {
      safety.push(snapshot.hash);
      return true;
    },
    assertZeroBusinessWrite(before, after) {
      zeroWritePairs.push([before.hash, after.hash]);
      return true;
    }
  };
  const seen = [];
  const operator = {
    async perform(action) {
      seen.push(action);
      return {
        actionId: action.id,
        outcome: action.expect,
        visiblePage: '测试申请表格',
        visibleMessage: action.expect === 'cancelled' ? '用户取消' : '成功导入 1 条申请',
        screenshotPath: `C:\\evidence\\${action.id}.png`,
        startedAt: '2026-09-02T00:00:00.000Z',
        endedAt: '2026-09-02T00:00:01.000Z'
      };
    }
  };
  const dataEntry = { id: 'normal-vertical-1', path: 'C:\\run\\normal.xlsx' };

  const result = await runManualScenario({
    scenario: scenario(),
    operator,
    oracle,
    runContext: { dataRoot: 'C:\\run\\profile\\data' },
    dataManifest: [dataEntry]
  });

  assert.equal(result.status, 'passed');
  assert.equal(result.scenarioId, 'B01');
  assert.equal(result.actions.length, 2);
  assert.equal(seen[0].params.path, dataEntry.path);
  assert.equal(seen[0].params.dataId, 'normal-vertical-1');
  assert.equal(snapshots.length, 3, 'runner captures before and after every action without duplicate terminal reads');
  assert.deepEqual(zeroWritePairs, [['snapshot-1', 'snapshot-2']]);
  assert.deepEqual(safety, ['snapshot-1', 'snapshot-2']);
});

test('runner fails closed on missing data, unexpected outcome and unsafe persistence', async () => {
  const base = {
    operator: { perform: async action => ({
      actionId: action.id,
      outcome: 'failure',
      visiblePage: '测试申请表格',
      visibleMessage: '导入失败',
      screenshotPath: 'C:\\evidence\\failure.png',
      startedAt: '2026-09-02T00:00:00.000Z',
      endedAt: '2026-09-02T00:00:01.000Z'
    }) },
    oracle: {
      capture: () => ({ hash: 'same' }),
      assertSafety: () => true,
      assertZeroBusinessWrite: () => true
    },
    runContext: { dataRoot: 'C:\\run\\profile\\data' }
  };
  await assert.rejects(
    runManualScenario({ ...base, scenario: scenario(), dataManifest: [] }),
    /missing generated data.*normal-vertical-1/i
  );
  await assert.rejects(
    runManualScenario({ ...base, scenario: scenario(), dataManifest: [{ id: 'normal-vertical-1', path: 'C:\\run\\normal.xlsx' }] }),
    /unexpected visible outcome.*B01-import/i
  );
  await assert.rejects(
    runManualScenario({
      ...base,
      scenario: scenario({ actions: [{ id: 'B01-cancel', type: 'cancelDialog', expect: 'cancelled' }] }),
      dataManifest: [{ id: 'normal-vertical-1', path: 'C:\\run\\normal.xlsx' }],
      operator: { perform: async action => ({
        actionId: action.id,
        outcome: action.expect,
        visiblePage: '测试申请表格',
        visibleMessage: '用户取消',
        screenshotPath: 'C:\\evidence\\cancel.png',
        startedAt: '2026-09-02T00:00:00.000Z',
        endedAt: '2026-09-02T00:00:01.000Z'
      }) },
      oracle: { ...base.oracle, assertZeroBusinessWrite: () => { throw new Error('business state changed'); } }
    }),
    /business state changed/i
  );
});
