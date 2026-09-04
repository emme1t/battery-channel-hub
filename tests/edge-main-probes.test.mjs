import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { P0_EVIDENCE_PLANS } from './edge/scenarios/p0.mjs';
import { P1_EVIDENCE_PLANS } from './edge/scenarios/p1.mjs';
import { P2_EVIDENCE_PLANS } from './edge/scenarios/p2.mjs';

const probeModule = await import('../scripts/edge-regression/main-edge-driver.mjs').catch(() => ({}));
const projectRoot = path.resolve(import.meta.dirname, '..');

test('MAIN Edge evidence driver exports the required API', () => {
  assert.equal(typeof probeModule.createMainEdgeEvidenceDriver, 'function');
  assert.ok(probeModule.MAIN_EDGE_PROBES);
});

test('every declared P0/P1/P2 Edge check resolves to an implemented probe', () => {
  const plans = { ...P0_EVIDENCE_PLANS, ...P1_EVIDENCE_PLANS, ...P2_EVIDENCE_PLANS };
  const names = Object.values(plans).flat().filter(check => check.kind === 'edge').map(check => check.probe);
  assert.ok(names.length > 0);
  assert.deepEqual(names.filter(name => typeof probeModule.MAIN_EDGE_PROBES?.[name] !== 'function'), []);
});

test('MAIN Edge probe keeps writable SQLite sidecars within the Windows path budget', { timeout: 120_000 }, async t => {
  if (process.platform !== 'win32') return t.skip('Windows SQLite sidecar path regression');
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'edge-main-probe-path-'));
  const verboseSuffix = path.join(
    'work', 'edge', 'editable-fields-A02-1366x768', 'data', 'battery-channel-hub.sqlite'
  );
  const paddingLength = 253 - temporaryRoot.length - verboseSuffix.length - 2;
  assert.ok(paddingLength > 0, `temporary root is too long: ${temporaryRoot}`);
  const runRoot = path.join(temporaryRoot, 'x'.repeat(paddingLength));
  await mkdir(runRoot, { recursive: true });
  try {
    const driver = probeModule.createMainEdgeEvidenceDriver({ projectRoot, runRoot, timeoutMs: 90_000 });
    const result = await driver.runProbe({
      key: 'editable-fields',
      probe: 'reservation-editable-fields',
      fixture: 'A02',
      viewport: { width: 1366, height: 768 }
    });
    assert.equal(result.ok, true, JSON.stringify(result.error));
    assert.ok(result.summary.sqlite.filePath.length <= 240, result.summary.sqlite.filePath);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
