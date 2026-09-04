import assert from 'node:assert/strict';
import test from 'node:test';

import { VISIBLE_ACTIONS, executeVisibleAction } from './actions.mjs';

const expectedActions = [
  'login', 'navigate', 'importFile', 'importFolder', 'selectRequest', 'selectSamples',
  'assignChannels', 'reserve', 'startImmediately', 'startReserved', 'finishRunning',
  'returnRunning', 'startStorage', 'finishStorage', 'returnStorage', 'editTester',
  'editDevice', 'exportTimeliness', 'exportRequests', 'exportSelectedRequests',
  'exportLogs', 'backup', 'restore', 'restart', 'doubleClick', 'cancelDialog',
  'search', 'paginate'
];

test('visible action catalog contains the exact manual-guided operation types', () => {
  assert.deepEqual([...VISIBLE_ACTIONS], expectedActions);
  assert.equal(Object.isFrozen(VISIBLE_ACTIONS), true);
});

test('visible action execution delegates one validated action to the operator', async () => {
  const calls = [];
  const operator = {
    async perform(action, context) {
      calls.push({ action, context });
      return {
        actionId: action.id,
        outcome: 'success',
        visiblePage: '通道看板',
        visibleMessage: '已进入通道看板',
        screenshotPath: 'C:\\evidence\\A01.png',
        startedAt: '2026-09-02T00:00:00.000Z',
        endedAt: '2026-09-02T00:00:01.000Z'
      };
    }
  };
  const action = Object.freeze({ id: 'A01-login', type: 'login', params: { username: '虚构测试工程师' } });
  const context = Object.freeze({ scenarioId: 'A01' });

  const result = await executeVisibleAction({ operator, action, context });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].action, action);
  assert.equal(calls[0].context, context);
  assert.equal(result.actionId, 'A01-login');
  assert.equal(result.outcome, 'success');
});

test('visible action execution rejects internal and unknown action requests', async () => {
  const operator = { perform: async () => assert.fail('invalid action must not reach operator') };
  await assert.rejects(
    executeVisibleAction({ operator, action: { id: 'bad-db', type: 'writeDatabase' }, context: {} }),
    /unsupported visible action/i
  );
  await assert.rejects(
    executeVisibleAction({ operator, action: { id: 'bad-state', type: 'injectState' }, context: {} }),
    /unsupported visible action/i
  );
});
