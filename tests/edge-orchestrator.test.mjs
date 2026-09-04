import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { SCENARIOS } from './edge/scenario-manifest.mjs';
import { createScenarioResult } from './edge/result-contract.mjs';

const runModule = await import('../scripts/edge-regression/run.mjs').catch(() => ({}));

function pass(definition) {
  return createScenarioResult(definition, {
    status: 'PASS',
    assertions: [{ key: 'fake', ok: true, message: 'fake pass' }],
    evidence: ['artifacts/fake.txt']
  });
}

test('orchestrator exports runRegression and exitCodeFor', () => {
  assert.equal(typeof runModule.runRegression, 'function');
  assert.equal(typeof runModule.exitCodeFor, 'function');
});

test('quick run emits exactly 52 ordered terminal results', async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), 'edge-orchestrator-'));
  const result = await runModule.runRegression({
    mode: 'quick',
    projectRoot,
    dependencies: {
      prepare: async () => ({ runId: 'fake-run', runRoot: projectRoot, verifyProtected: async () => ({ ok: true }), cleanup: async () => {} }),
      executeScenario: async definition => pass(definition),
      writeReport: async () => ({ jsonPath: 'result.json', markdownPath: 'report.md' }),
      environment: async () => ({ branch: 'test', gitSha: 'abc' }),
      now: (() => { let time = 0; return () => new Date(time += 1000); })()
    }
  });
  assert.equal(result.scenarios.length, 52);
  assert.deepEqual(result.scenarios.map(item => item.id), SCENARIOS.map(item => item.id));
  assert.equal(result.scenarios.every(item => item.status === 'PASS'), true);
  assert.equal(result.coverage, 'FAST_COVERAGE');
});

test('P0/P1 failure is nonzero while filtered scenarios do not fail a focused run', () => {
  const failed = { scenarios: [createScenarioResult(SCENARIOS[0], { status: 'FAIL', error: { code: 'X', message: 'x' } })] };
  const filtered = { scenarios: [createScenarioResult(SCENARIOS[0], { status: 'BLOCKED', error: { code: 'SCENARIO_FILTERED', message: 'filtered' } })] };
  assert.equal(runModule.exitCodeFor(failed), 1);
  assert.equal(runModule.exitCodeFor(filtered), 0);
});
