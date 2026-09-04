import assert from 'node:assert/strict';
import test from 'node:test';

import { buildManualShellPlan, classifyScenarioEvidence } from './full-shell.mjs';

const quickIds = ['A01', 'B01', 'C01', 'D01', 'E04', 'F01', 'G01'];
const fullIds = [
  'A01', 'A02',
  'B01', 'B02', 'B03', 'B04', 'B05',
  'C01', 'C02', 'C03', 'C04',
  'D01', 'D02', 'D03',
  'E01', 'E02', 'E03', 'E04',
  'F01', 'F02', 'F03', 'F04', 'F05', 'F06', 'F07',
  'G01', 'G02', 'G03'
];

test('shell plan maps quick to fixed seven and full to all 28 exactly once', () => {
  const quick = buildManualShellPlan({ mode: 'quick' });
  const full = buildManualShellPlan({ mode: 'full' });
  assert.deepEqual(quick.selectedScenarioIds, quickIds);
  assert.deepEqual(full.selectedScenarioIds, fullIds);
  assert.equal(new Set(full.suites.flatMap(item => item.scenarioIds)).size, 28);
  assert.deepEqual(full.suites.map(item => item.file), [
    'normal-journeys.integration.test.mjs',
    'extended-journeys.integration.test.mjs',
    'misuse.integration.test.mjs',
    'restart.integration.test.mjs'
  ]);
});

test('evidence classification separates product failures, automation boundaries and clean passes', () => {
  assert.deepEqual(classifyScenarioEvidence({ scenarioId: 'F03', documents: [{
    scenarioId: 'F03', productDefect: { code: 'END_BEFORE_START_ACCEPTED', actual: 'running record created' }
  }] }), { status: 'failed', code: 'END_BEFORE_START_ACCEPTED', message: 'running record created' });
  assert.deepEqual(classifyScenarioEvidence({ scenarioId: 'E01', documents: [{
    scenarioId: 'E01', code: 'PNG_NATIVE_SAVE_DIALOG_ROUTE_BYPASSED', limitation: 'native dialog'
  }] }), { status: 'blocked', code: 'PNG_NATIVE_SAVE_DIALOG_ROUTE_BYPASSED', message: 'native dialog' });
  assert.deepEqual(classifyScenarioEvidence({ scenarioId: 'C02', documents: [] }), {
    status: 'passed', code: null, message: '可见旅程与只读安全核验完成'
  });
});
