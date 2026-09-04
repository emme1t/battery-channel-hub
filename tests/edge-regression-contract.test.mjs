import assert from 'node:assert/strict';
import test from 'node:test';

const contractModule = await import('./edge/result-contract.mjs').catch(() => ({}));
const manifestModule = await import('./edge/scenario-manifest.mjs').catch(() => ({}));
const scenariosManifest = manifestModule.SCENARIOS || [];
const createScenarioResult = contractModule.createScenarioResult || (() => ({}));
const validateRunResult = contractModule.validateRunResult || (() => ({ ok: false, errors: ['契约未实现'] }));

const EXPECTED_SCENARIO_IDS = `
P0-01 P0-02 P0-03 P0-04 P0-05 P0-06 P0-07 P0-08 P0-09 P0-10 P0-11 P0-12 P0-13 P0-14 P0-15 P0-16 P0-17 P0-18 P0-19 P0-20 P0-21
P1-01 P1-02 P1-03 P1-04 P1-05 P1-06 P1-07 P1-08 P1-09 P1-10 P1-11 P1-12 P1-13 P1-14 P1-15 P1-16 P1-17 P1-18 P1-19 P1-20 P1-21 P1-22
ST-01 ST-02 ST-03 ST-04 ST-05
P2-01 P2-02 P2-03 P2-04
`.trim().split(/\s+/);

function completeRun(scenarios) {
  return {
    schemaVersion: 1,
    runId: '20260822T010203Z-a1b2c3d4',
    mode: 'quick',
    coverage: 'FAST_COVERAGE',
    startedAt: '2026-08-22T01:02:03.000Z',
    finishedAt: '2026-08-22T01:03:03.000Z',
    durationMs: 60_000,
    environment: { branch: 'codex/main-differential-recovery', gitSha: 'abcdef1' },
    protection: { ok: true, files: [] },
    scenarios
  };
}

test('scenario contract exports the required public API', () => {
  assert.equal(typeof contractModule.createScenarioResult, 'function');
  assert.equal(typeof contractModule.validateRunResult, 'function');
  assert.ok(Array.isArray(manifestModule.SCENARIOS));
});

test('manifest exactly matches all 52 published scenario IDs in order', () => {
  assert.equal(EXPECTED_SCENARIO_IDS.length, 52);
  assert.deepEqual(scenariosManifest.map(item => item.id), EXPECTED_SCENARIO_IDS);
  assert.equal(new Set(scenariosManifest.map(item => item.id)).size, 52);
});

test('a PASS result without assertions or evidence is rejected', () => {
  const scenarios = scenariosManifest.map(item => createScenarioResult(item, {
    status: 'PASS',
    assertions: [{ key: 'contract-probe', ok: true, message: '已验证' }],
    evidence: ['artifacts/contract-probe.json']
  }));
  scenarios[0] = createScenarioResult(scenariosManifest[0], { status: 'PASS' });

  assert.deepEqual(validateRunResult(completeRun(scenarios)), {
    ok: false,
    errors: ['P0-01: PASS 缺少 assertions 或 evidence']
  });
});

test('a complete 52-scenario result satisfies the machine contract', () => {
  const scenarios = scenariosManifest.map(item => createScenarioResult(item, {
    status: 'PASS',
    durationMs: 1,
    assertions: [{ key: 'contract-probe', ok: true, message: '已验证' }],
    evidence: [`artifacts/${item.id}.json`]
  }));

  assert.deepEqual(validateRunResult(completeRun(scenarios)), { ok: true });
});
