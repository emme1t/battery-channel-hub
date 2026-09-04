import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { validateManualGuidedReport, verifyManualGuidedReplayBindings } from './report-writer.mjs';

const hash = 'a'.repeat(64);
const quickIds = ['A01', 'B01', 'C01', 'D01', 'E04', 'F01', 'G01'];

function report() {
  return {
    schemaVersion: 'manual-guided-v1', runId: '20260902T000000000Z-1234abcd', mode: 'quick', status: 'passed',
    startedAt: '2026-09-02T00:00:00.000Z', endedAt: '2026-09-02T00:01:00.000Z', commit: '009a34a',
    executable: { path: 'C:\\app.exe', version: '1.0.0', sha256: hash },
    manual: { path: 'C:\\manual.md', sha256: hash },
    styles: Array.from({ length: 10 }, (_, index) => ({ path: `C:\\style-${index}.xlsx`, sha256: hash })),
    dataManifest: [{ id: 'normal', path: 'C:\\run\\normal.xlsx', sha256: hash }],
    selectedScenarioIds: quickIds,
    scenarios: quickIds.map(scenarioId => ({
      scenarioId, status: 'passed', compressed: ['C01', 'D01', 'G01'].includes(scenarioId),
      actions: [{ actionId: `${scenarioId}-action`, outcome: 'success', visiblePage: '通道看板', visibleMessage: '可见终态', screenshotPath: `C:\\run\\${scenarioId}.png`, dialogEvidence: 'none' }],
      oracleEvidence: { integrity: ['ok'], violations: [], changedBusinessCollections: [] }, recovery: null, restartResult: null
    })),
    firstFailure: null, lastSuccessfulActionId: 'G01-action', protection: { ok: true, changed: [] },
    cleanup: { verified: true, profileExists: false, workExists: false, residue: [] },
    replayCommand: 'npm run test:manual-guided:replay -- --report "C:\\run\\result.json"'
  };
}

test('quick report fails closed under every critical evidence mutation', () => {
  const mutations = [
    ['omitted scenario', value => { value.scenarios.pop(); }],
    ['protected style change', value => { value.protection.ok = false; value.protection.changed = [value.styles[0].path]; }],
    ['PASS without visible terminal evidence', value => { value.scenarios[0].actions[0].visibleMessage = ''; }],
    ['cancelled import changed requests', value => {
      value.scenarios[1].actions[0].outcome = 'cancelled';
      value.scenarios[1].oracleEvidence.changedBusinessCollections = ['requests'];
    }],
    ['duplicate active record', value => { value.scenarios[2].oracleEvidence.violations = [{ code: 'DUPLICATE_ACTIVE_SAMPLE' }]; }],
    ['ordinary storage overlap', value => { value.scenarios[3].oracleEvidence.violations = [{ code: 'ORDINARY_STORAGE_OVERLAP' }]; }],
    ['missing compressed flag', value => { delete value.scenarios[2].compressed; }],
    ['dialog route misrepresented as native', value => {
      value.scenarios[4].actions[0].visibleMessage = 'AUTOMATED_DIALOG_ROUTE: 用户取消';
      value.scenarios[4].actions[0].dialogEvidence = 'native';
    }],
    ['unverified cleanup', value => { value.cleanup.verified = false; }]
  ];
  for (const [name, mutate] of mutations) {
    const value = report();
    mutate(value);
    assert.throws(() => validateManualGuidedReport(value), undefined, name);
  }
});

test('replay binding rejects an executable whose bytes do not match the recorded SHA-256', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'manual-gate-exe-hash-'));
  const executablePath = path.join(root, 'app.exe');
  const manualPath = path.join(root, 'manual.md');
  const stylesRoot = path.join(root, 'styles');
  await mkdir(stylesRoot);
  await writeFile(executablePath, 'changed executable bytes');
  await writeFile(manualPath, 'manual');
  const value = report();
  value.executable.path = executablePath;
  value.manual.path = manualPath;
  for (let index = 0; index < value.styles.length; index += 1) {
    const stylePath = path.join(stylesRoot, `style-${index}.xlsx`);
    await writeFile(stylePath, 'style');
    value.styles[index].path = stylePath;
  }
  await assert.rejects(verifyManualGuidedReplayBindings(value), /executable hash mismatch/i);
});
