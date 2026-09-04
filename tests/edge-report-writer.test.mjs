import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createScenarioResult } from './edge/result-contract.mjs';
import { SCENARIOS } from './edge/scenario-manifest.mjs';

const reportModule = await import('../scripts/edge-regression/report-writer.mjs').catch(() => ({}));

function completeRun() {
  return {
    schemaVersion: 1,
    runId: '20260822T010203Z-a1b2c3d4',
    mode: 'quick',
    coverage: 'FAST_COVERAGE',
    startedAt: '2026-08-22T01:02:03.000Z',
    finishedAt: '2026-08-22T01:03:03.000Z',
    durationMs: 60_000,
    environment: {
      branch: 'codex/main-differential-recovery',
      gitSha: 'abcdef1',
      node: process.version,
      edge: '140.0.0.0'
    },
    protection: { ok: true, files: [] },
    scenarios: SCENARIOS.map(item => createScenarioResult(item, {
      status: 'PASS',
      durationMs: 5,
      assertions: [{ key: 'verified', ok: true, message: '独立证据通过' }],
      evidence: [`artifacts/${item.id}.json`]
    }))
  };
}

test('report writer exports the required API', () => {
  assert.equal(typeof reportModule.writeRunReport, 'function');
  assert.equal(typeof reportModule.renderMarkdown, 'function');
});

test('report writes validated JSON first and derives Markdown from persisted JSON', async () => {
  assert.equal(typeof reportModule.writeRunReport, 'function');
  const runRoot = await mkdtemp(path.join(os.tmpdir(), 'edge-report-'));
  const paths = await reportModule.writeRunReport({ runRoot, result: completeRun() });
  const persisted = JSON.parse(await readFile(paths.jsonPath, 'utf8'));
  assert.equal(persisted.scenarios.length, 52);
  const markdown = await readFile(paths.markdownPath, 'utf8');
  assert.match(markdown, /PASS 52\/52/);
  assert.match(markdown, /\| P0-01 \| 隔离目录启动 \| hybrid \| PASS \|/);
  assert.match(markdown, /\[artifacts\/P0-01\.json\]\(artifacts\/P0-01\.json\)/);
  assert.equal((await readdir(runRoot)).some(name => name.endsWith('.tmp')), false);
});

test('invalid 51-scenario input writes no report files', async () => {
  assert.equal(typeof reportModule.writeRunReport, 'function');
  const runRoot = await mkdtemp(path.join(os.tmpdir(), 'edge-report-invalid-'));
  const result = completeRun();
  result.scenarios.pop();
  await assert.rejects(reportModule.writeRunReport({ runRoot, result }), { code: 'REPORT_INVALID' });
  assert.deepEqual(await readdir(runRoot), []);
});
