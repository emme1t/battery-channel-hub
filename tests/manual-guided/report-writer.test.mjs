import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  readManualGuidedReplay,
  validateManualGuidedReport,
  verifyManualGuidedReplayBindings,
  writeManualGuidedReport
} from './report-writer.mjs';

const hash = 'a'.repeat(64);

function validReport(overrides = {}) {
  return {
    schemaVersion: 'manual-guided-v1',
    runId: '20260902T000000000Z-1234abcd',
    mode: 'quick',
    status: 'passed',
    startedAt: '2026-09-02T00:00:00.000Z',
    endedAt: '2026-09-02T00:01:00.000Z',
    commit: '2a5895c',
    executable: { path: 'C:\\app.exe', version: '1.0.0', sha256: hash },
    manual: { path: 'C:\\manual.md', sha256: hash },
    styles: Array.from({ length: 10 }, (_, index) => ({ path: `C:\\style-${index}.xlsx`, sha256: hash })),
    dataManifest: [{ id: 'normal-csv-4', path: 'C:\\run\\input.csv', sha256: hash }],
    selectedScenarioIds: ['A01'],
    scenarios: [{
      scenarioId: 'A01', status: 'passed', compressed: false,
      actions: [{ actionId: 'A01-login', outcome: 'success', visiblePage: '通道看板', visibleMessage: '已登录', screenshotPath: 'C:\\run\\A01.png' }],
      oracleEvidence: { integrity: ['ok'], hash }, recovery: null, restartResult: null
    }],
    firstFailure: null,
    lastSuccessfulActionId: 'A01-login',
    protection: { ok: true, changed: [] },
    cleanup: { verified: true, profileExists: false, workExists: false, residue: [] },
    replayCommand: 'npm run test:manual-guided:replay -- --report "C:\\run\\result.json"',
    ...overrides
  };
}

test('report schema requires bound hashes, terminal scenarios, visible evidence and cleanup', () => {
  assert.equal(validateManualGuidedReport(validReport()), true);
  for (const [field, mutate] of [
    ['executable hash', value => { value.executable.sha256 = 'bad'; }],
    ['ten styles', value => { value.styles.pop(); }],
    ['omitted scenario', value => { value.scenarios = []; }],
    ['visible evidence', value => { value.scenarios[0].actions[0].visibleMessage = ''; }],
    ['compressed flag', value => { delete value.scenarios[0].compressed; }],
    ['cleanup', value => { value.cleanup.verified = false; }],
    ['replay command', value => { value.replayCommand = ''; }]
  ]) {
    const value = structuredClone(validReport());
    mutate(value);
    assert.throws(() => validateManualGuidedReport(value), new RegExp(field, 'i'));
  }
});

test('report writer atomically writes validated JSON and Chinese Markdown then rereads replay', async () => {
  const artifactsRoot = await mkdtemp(path.join(os.tmpdir(), 'manual-report-'));
  const report = validReport();
  const written = await writeManualGuidedReport({ runContext: { artifactsRoot }, result: report });
  assert.equal(path.basename(written.jsonPath), 'result.json');
  assert.equal(path.basename(written.markdownPath), 'Electron黑盒测试报告.md');
  assert.deepEqual(JSON.parse(await readFile(written.jsonPath, 'utf8')), report);
  assert.match(await readFile(written.markdownPath, 'utf8'), /A01|可见证据|重放/);
  assert.deepEqual(await readManualGuidedReplay(written.jsonPath), report);
  assert.deepEqual((await readdir(artifactsRoot)).sort(), ['Electron黑盒测试报告.md', 'result.json']);
});

test('failed report requires a precise first failure and cannot masquerade as pass', () => {
  const failed = validReport({
    status: 'failed',
    firstFailure: { scenarioId: 'F03', actionId: 'F03-submit', code: 'END_BEFORE_START_ACCEPTED', message: 'invalid time accepted' }
  });
  failed.scenarios[0].status = 'failed';
  assert.equal(validateManualGuidedReport(failed), true);
  failed.firstFailure = null;
  assert.throws(() => validateManualGuidedReport(failed), /first failure/i);
});

test('replay bindings fail before launch when EXE, manual or any style hash drifts', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'manual-bindings-'));
  const executablePath = path.join(root, 'app.exe');
  const manualPath = path.join(root, 'manual.md');
  const stylePaths = Array.from({ length: 10 }, (_, index) => path.join(root, `style-${index}.xlsx`));
  await writeFile(executablePath, 'exe');
  await writeFile(manualPath, 'manual');
  await Promise.all(stylePaths.map((file, index) => writeFile(file, `style-${index}`)));
  const digest = async file => createHash('sha256').update(await readFile(file)).digest('hex');
  const report = validReport({
    executable: { path: executablePath, version: '1.0.0', sha256: await digest(executablePath) },
    manual: { path: manualPath, sha256: await digest(manualPath) },
    styles: await Promise.all(stylePaths.map(async file => ({ path: file, sha256: await digest(file) })))
  });
  assert.equal(await verifyManualGuidedReplayBindings(report), true);
  await writeFile(stylePaths[4], 'changed');
  await assert.rejects(verifyManualGuidedReplayBindings(report), /style hash mismatch/i);
});
