import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { planHumanMisuse, replayHumanMisuse } from './misuse-planner.mjs';

const visibleState = Object.freeze({
  page: '开始/预约测试',
  availableActions: Object.freeze([
    'reserve', 'startImmediately', 'startStorage', 'doubleClick', 'editDevice',
    'search', 'paginate', 'navigate', 'finishRunning'
  ]),
  visibleTexts: Object.freeze(['立即开始', '提交预约', '下一页', '设备与通道'])
});

test('F01-F07 misuse plans are deterministic, state-aware and replayable', () => {
  for (const scenarioId of ['F01', 'F02', 'F03', 'F04', 'F05', 'F06', 'F07']) {
    const first = planHumanMisuse({ scenarioId, seed: 22001, visibleState });
    const second = planHumanMisuse({ scenarioId, seed: 22001, visibleState });
    assert.deepEqual(first, second);
    assert.equal(first.scenarioId, scenarioId);
    assert.equal(first.seed, 22001);
    assert.ok(first.candidateSets.length > 0);
    assert.ok(first.actions.length > 0);
    assert.equal(Object.isFrozen(first), true);
    for (const action of first.actions) {
      assert.match(action.id, new RegExp(`^${scenarioId}-`));
      assert.ok(visibleState.availableActions.includes(action.type));
    }
    const replay = replayHumanMisuse({ plan: first });
    assert.deepEqual(replay, first.actions);
    assert.equal(replay[0], first.actions[0], 'replay consumes recorded actions without drawing again');
  }
});

test('misuse planning covers missing choices, double submit, wrong time, active edits and hostile text', () => {
  const plans = Object.fromEntries(['F01', 'F02', 'F03', 'F04', 'F05', 'F06', 'F07']
    .map(id => [id, planHumanMisuse({ scenarioId: id, seed: 7, visibleState })]));
  assert.match(JSON.stringify(plans.F01), /missing|缺少|without/i);
  assert.ok(plans.F02.actions.some(item => item.type === 'doubleClick'));
  assert.match(JSON.stringify(plans.F03), /endBeforeStart|wrong-time/);
  assert.ok(plans.F04.actions.some(item => item.type === 'editDevice'));
  assert.match(JSON.stringify(plans.F05), /引号|\*|\?|\n|spaces-only/);
  assert.ok(plans.F06.actions.some(item => item.type === 'navigate'));
  assert.ok(plans.F06.actions.some(item => item.type === 'search'));
  assert.ok(plans.F06.actions.some(item => item.type === 'paginate'));
  assert.ok(plans.F07.actions.some(item => item.type === 'finishRunning'));
});

test('misuse planner rejects hidden, internal and destructive candidates', () => {
  assert.throws(
    () => planHumanMisuse({ scenarioId: 'F01', seed: 1, visibleState: { availableActions: ['writeDatabase'] } }),
    /no allowed visible misuse candidate/i
  );
  for (const forbidden of ['writeDatabase', 'directIpc', 'injectState', 'switchProduction', 'editSource', 'deleteFile']) {
    assert.throws(
      () => planHumanMisuse({
        scenarioId: 'F06',
        seed: 1,
        visibleState: { ...visibleState, availableActions: [forbidden] }
      }),
      /no allowed visible misuse candidate/i
    );
  }
  assert.throws(() => planHumanMisuse({ scenarioId: 'F08', seed: 1, visibleState }), /unknown misuse scenario/i);
});

test('misuse planner has no old workflow, product or persistence imports', async () => {
  const source = await readFile(path.join(import.meta.dirname, 'misuse-planner.mjs'), 'utf8');
  assert.doesNotMatch(source, /from\s+['"][^'"]*workflows[\\/]/);
  assert.doesNotMatch(source, /from\s+['"][^'"]*src[\\/](?:main|domain)/);
  assert.doesNotMatch(source, /\b(?:INSERT|UPDATE|DELETE|REPLACE)\b/i);
});
