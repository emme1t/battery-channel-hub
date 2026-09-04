import assert from 'node:assert/strict';
import test from 'node:test';

const p1Module = await import('./scenarios/p1.mjs').catch(() => ({}));
const manifestModule = await import('./scenario-manifest.mjs').catch(() => ({}));

function successfulContext(overrides = {}) {
  return {
    runEvidence: async check => ({ ok: true, evidencePath: `artifacts/${check.key}.json`, summary: { pass: 1 } }),
    relativeEvidence: value => value.replaceAll('\\', '/'),
    ...overrides
  };
}

test('P1 runner map contains every P1-01 through P1-22 scenario', () => {
  assert.ok(p1Module.P1_RUNNERS);
  assert.deepEqual(Object.keys(p1Module.P1_RUNNERS),
    Array.from({ length: 22 }, (_, index) => `P1-${String(index + 1).padStart(2, '0')}`));
});

test('P1-01 标题与两条成功证据均声明十个精确导航入口', async () => {
  const definition = manifestModule.SCENARIOS?.find(item => item.id === 'P1-01');
  assert.equal(definition?.title, '十个入口导航');
  const result = await p1Module.P1_RUNNERS?.['P1-01'](successfulContext());
  assert.deepEqual(result?.assertions.map(item => item.message), [
    '十个左侧入口均可进入且页面无控制台错误',
    '真实 Electron 外壳中的十个入口均可访问'
  ]);
});

test('P1-03 requires ratio, independent scrolling and overflow evidence', async () => {
  assert.equal(typeof p1Module.P1_RUNNERS?.['P1-03'], 'function');
  const result = await p1Module.P1_RUNNERS['P1-03'](successfulContext());
  assert.equal(result.status, 'PASS');
  assert.deepEqual(result.assertions.map(item => item.key), [
    'laptop-split-ratio',
    'details-independent-scroll',
    'no-horizontal-overflow'
  ]);
});

test('a missing Edge environment blocks rather than passes a P1 scenario', async () => {
  assert.equal(typeof p1Module.P1_RUNNERS?.['P1-21'], 'function');
  const result = await p1Module.P1_RUNNERS['P1-21'](successfulContext({
    runEvidence: async check => ({
      ok: false,
      evidencePath: `artifacts/${check.key}.json`,
      error: { code: 'EDGE_NOT_INSTALLED', message: 'Edge missing' }
    })
  }));
  assert.equal(result.status, 'BLOCKED');
  assert.equal(result.error.code, 'EDGE_NOT_INSTALLED');
});

test('Edge screenshot and trace are both retained as scenario evidence', async () => {
  const result = await p1Module.P1_RUNNERS['P1-15'](successfulContext({
    runEvidence: async () => ({
      ok: true,
      evidencePaths: ['screenshots/P1-15.png', 'traces/P1-15.zip'],
      summary: { pass: 1 }
    })
  }));
  assert.deepEqual(result.evidence, ['screenshots/P1-15.png', 'traces/P1-15.zip']);
});
