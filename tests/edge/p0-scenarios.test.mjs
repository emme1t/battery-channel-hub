import assert from 'node:assert/strict';
import test from 'node:test';

const p0Module = await import('./scenarios/p0.mjs').catch(() => ({}));

function successfulContext(overrides = {}) {
  return {
    runEvidence: async check => ({
      ok: true,
      key: check.key,
      evidencePath: `artifacts/${check.key}.tap`,
      summary: { pass: 1, fail: 0 }
    }),
    relativeEvidence: value => value.replaceAll('\\', '/'),
    ...overrides
  };
}

test('P0 runner map contains every P0-01 through P0-21 scenario', () => {
  assert.ok(p0Module.P0_RUNNERS);
  assert.deepEqual(Object.keys(p0Module.P0_RUNNERS),
    Array.from({ length: 21 }, (_, index) => `P0-${String(index + 1).padStart(2, '0')}`));
});

test('P0-05 requires editable fields, full channel reachability and atomic commits', async () => {
  assert.equal(typeof p0Module.P0_RUNNERS?.['P0-05'], 'function');
  const result = await p0Module.P0_RUNNERS['P0-05'](successfulContext());
  assert.equal(result.status, 'PASS');
  assert.deepEqual(result.assertions.map(item => item.key), [
    'editable-fields',
    'all-channels-reachable',
    'invalid-batch-zero-write',
    'valid-batch-single-commit'
  ]);
  assert.equal(result.evidence.length, 4);
});

test('one failed P0 authority produces FAIL with structured evidence error', async () => {
  assert.equal(typeof p0Module.P0_RUNNERS?.['P0-17'], 'function');
  const context = successfulContext({
    runEvidence: async check => ({
      ok: false,
      key: check.key,
      evidencePath: `artifacts/${check.key}.tap`,
      error: { code: 'NODE_TEST_FAILED', message: 'tamper guard failed' }
    })
  });
  const result = await p0Module.P0_RUNNERS['P0-17'](context);
  assert.equal(result.status, 'FAIL');
  assert.equal(result.error.code, 'NODE_TEST_FAILED');
  assert.equal(result.assertions[0].ok, false);
});
