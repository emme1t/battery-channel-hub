import assert from 'node:assert/strict';
import test from 'node:test';

const stModule = await import('./scenarios/st.mjs').catch(() => ({}));

function context(status = 'PASS') {
  const scenarios = Object.fromEntries(Array.from({ length: 5 }, (_, index) => {
    const id = `ST-${String(index + 1).padStart(2, '0')}`;
    return [id, {
      status,
      assertions: [{ key: id.toLowerCase(), ok: status === 'PASS', message: id }],
      metrics: { id },
      error: status === 'PASS' ? null : { code: 'STABILITY_FAILED', message: id }
    }];
  }));
  return {
    getStabilityEvidence: async () => ({ coverage: 'FAST_COVERAGE', scenarios, evidencePath: 'artifacts/stability.json' }),
    relativeEvidence: value => value
  };
}

test('ST runner map contains ST-01 through ST-05', () => {
  assert.ok(stModule.ST_RUNNERS);
  assert.deepEqual(Object.keys(stModule.ST_RUNNERS), ['ST-01', 'ST-02', 'ST-03', 'ST-04', 'ST-05']);
});

test('all ST scenarios share one cached stability execution', async () => {
  let calls = 0;
  const base = context();
  const shared = { ...base, getStabilityEvidence: async () => { calls += 1; return base.getStabilityEvidence(); } };
  for (const runner of Object.values(stModule.ST_RUNNERS)) {
    const result = await runner(shared);
    assert.equal(result.status, 'PASS');
    assert.equal(result.metrics.coverage, 'FAST_COVERAGE');
  }
  assert.equal(calls, 1);
});
