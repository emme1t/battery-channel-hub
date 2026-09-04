import assert from 'node:assert/strict';
import test from 'node:test';

const stabilityModule = await import('../scripts/edge-regression/stability-runner.mjs').catch(() => ({}));

function fakeClock(maximum = Infinity) {
  let now = 0;
  return {
    now: () => now,
    sleep: async milliseconds => {
      now = Math.min(maximum, now + milliseconds);
    }
  };
}

test('stability runner exports the required API', () => {
  assert.equal(typeof stabilityModule.runStability, 'function');
  assert.equal(stabilityModule.FULL_DURATION_MS, 5 * 60_000);
});

test('full stability cannot pass when monotonic time stalls before 5 minutes', async () => {
  const result = await stabilityModule.runStability({
    mode: 'full',
    clock: fakeClock(5 * 60_000 - 1),
    runListCycle: async () => ({ ok: true, latencyMs: 1 }),
    runStateCycle: async () => ({ ok: true, latencyMs: 1 }),
    restartCheck: async () => ({ ok: true }),
    sampleProcessMemory: async () => ({ aggregateRss: 100 })
  });
  assert.equal(result.scenarios['ST-01'].status, 'FAIL');
  assert.equal(result.scenarios['ST-01'].error.code, 'STABILITY_DURATION_SHORT');
  assert.equal(result.fullGateSatisfied, false);
});

test('full stability keeps 50/10 cycles and samples across the real 5-minute window', async () => {
  const result = await stabilityModule.runStability({
    mode: 'full',
    clock: fakeClock(),
    runListCycle: async () => ({ ok: true, latencyMs: 1 }),
    runStateCycle: async () => ({ ok: true, latencyMs: 1 }),
    restartCheck: async () => ({ ok: true }),
    sampleProcessMemory: async () => ({ aggregateRss: 100 })
  });
  assert.equal(result.coverage, 'FULL_5_MINUTES');
  assert.equal(result.fullGateSatisfied, true);
  assert.equal(result.metrics.elapsedMs, 5 * 60_000);
  assert.equal(result.metrics.listCycles, 50);
  assert.equal(result.metrics.stateCycles, 10);
  assert.deepEqual(
    result.scenarios['ST-04'].metrics.samples.map(sample => sample.elapsedMs),
    [0, 100_000, 200_000, 300_000]
  );
});

test('quick stability is shortened coverage with deterministic cycle counts', async () => {
  const result = await stabilityModule.runStability({
    mode: 'quick',
    clock: fakeClock(),
    runListCycle: async () => ({ ok: true, latencyMs: 2 }),
    runStateCycle: async () => ({ ok: true, latencyMs: 3 }),
    restartCheck: async () => ({ ok: true, same: true }),
    sampleProcessMemory: async () => ({ aggregateRss: 100 })
  });
  assert.equal(result.coverage, 'FAST_COVERAGE');
  assert.equal(result.fullGateSatisfied, false);
  assert.equal(result.metrics.listCycles, 3);
  assert.equal(result.metrics.stateCycles, 2);
  assert.deepEqual(Object.values(result.scenarios).map(item => item.status), ['PASS', 'PASS', 'PASS', 'PASS', 'PASS']);
});

test('unbounded memory growth and failed restart remain terminal failures', async () => {
  let memory = 100;
  const result = await stabilityModule.runStability({
    mode: 'quick',
    clock: fakeClock(),
    runListCycle: async () => ({ ok: true }),
    runStateCycle: async () => ({ ok: true }),
    restartCheck: async () => ({ ok: false, error: { code: 'REOPEN_MISMATCH', message: 'mismatch' } }),
    sampleProcessMemory: async () => ({ aggregateRss: (memory += 300 * 1024 * 1024) }),
    memoryGrowthLimitBytes: 128 * 1024 * 1024
  });
  assert.equal(result.scenarios['ST-04'].status, 'FAIL');
  assert.equal(result.scenarios['ST-05'].status, 'FAIL');
});
