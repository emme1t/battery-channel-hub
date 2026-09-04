import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const continuousModule = await import('../scripts/edge-regression/continuous-stability.mjs').catch(() => ({}));
const projectRoot = path.resolve(import.meta.dirname, '..');

test('continuous Edge stability exports the required API', () => {
  assert.equal(typeof continuousModule.runContinuousEdgeStability, 'function');
});

test('quick stability keeps one Edge page, persists state cycles and reopens SQLite', async () => {
  const runRoot = await mkdtemp(path.join(os.tmpdir(), 'edge-continuous-stability-'));
  const result = await continuousModule.runContinuousEdgeStability({ projectRoot, runRoot, mode: 'quick' });
  assert.equal(result.coverage, 'FAST_COVERAGE');
  assert.equal(result.metrics.listCycles, 3);
  assert.equal(result.metrics.stateCycles, 2);
  assert.equal(result.scenarios['ST-05'].status, 'PASS');
  const samples = result.scenarios['ST-04'].metrics.samples;
  assert.ok(samples.every(sample => sample.edgeProcessCount >= 1), JSON.stringify(samples));
  assert.ok(samples.every(sample => sample.rendererRss > 0), JSON.stringify(samples));
  assert.ok(result.restart.revisionDelta >= 2, JSON.stringify(result.restart));
});
