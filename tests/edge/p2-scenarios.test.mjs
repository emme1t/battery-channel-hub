import assert from 'node:assert/strict';
import test from 'node:test';

const p2Module = await import('./scenarios/p2.mjs').catch(() => ({}));

const context = {
  runEvidence: async check => ({ ok: true, evidencePath: `artifacts/${check.key}.txt`, summary: { pass: 1 } }),
  relativeEvidence: value => value.replaceAll('\\', '/')
};

test('P2 runner map contains P2-01 through P2-04', () => {
  assert.ok(p2Module.P2_RUNNERS);
  assert.deepEqual(Object.keys(p2Module.P2_RUNNERS), ['P2-01', 'P2-02', 'P2-03', 'P2-04']);
});

test('P2-03 requires recovery language, package identity and candidate path evidence', async () => {
  const result = await p2Module.P2_RUNNERS['P2-03'](context);
  assert.equal(result.status, 'PASS');
  assert.deepEqual(result.assertions.map(item => item.key), [
    'main-recovery-language',
    'package-identity',
    'candidate-build-path'
  ]);
});

test('P2-04 records the icon as an explicit non-blocking acceptance item', async () => {
  const result = await p2Module.P2_RUNNERS['P2-04'](context);
  assert.equal(result.status, 'PASS');
  assert.deepEqual(result.assertions.map(item => item.key), ['application-icon-boundary', 'native-window-icon']);
});
