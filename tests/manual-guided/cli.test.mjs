import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { main, resolveCliDependencies } from './cli.mjs';
import { replayManualGuidedReport, runManualGuidedShell } from './full-shell.mjs';

async function paths() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'manual-cli-'));
  const executablePath = path.join(root, 'app.exe');
  const manualPath = path.join(root, 'manual.md');
  const stylesRoot = path.join(root, 'styles');
  await mkdir(stylesRoot);
  await writeFile(executablePath, 'exe');
  await writeFile(manualPath, 'manual');
  return { root, executablePath, manualPath, stylesRoot };
}

test('quick and full require explicit absolute executable, manual and styles paths', async () => {
  let calls = 0;
  const dependencies = { run: async () => { calls += 1; return { status: 'passed', protection: { ok: true }, cleanup: { verified: true } }; } };
  assert.equal(await main(['--mode', 'quick'], dependencies), 2);
  assert.equal(await main(['--mode', 'full', '--executable', 'relative.exe', '--manual', 'manual.md', '--styles-root', 'styles'], dependencies), 2);
  assert.equal(calls, 0);
});

test('CLI maps pass, product failure and fail-closed protection/cleanup to exit codes', async () => {
  const input = await paths();
  const argv = ['--mode', 'quick', '--executable', input.executablePath, '--manual', input.manualPath, '--styles-root', input.stylesRoot];
  assert.equal(await main(argv, { run: async options => {
    assert.equal(options.mode, 'quick');
    assert.equal(options.executablePath, input.executablePath);
    return { status: 'passed', protection: { ok: true }, cleanup: { verified: true } };
  } }), 0);
  assert.equal(await main(argv, { run: async () => ({ status: 'failed', protection: { ok: true }, cleanup: { verified: true } }) }), 1);
  assert.equal(await main(argv, { run: async () => ({ status: 'passed', protection: { ok: false }, cleanup: { verified: true } }) }), 3);
  assert.equal(await main(argv, { run: async () => ({ status: 'passed', protection: { ok: true }, cleanup: { verified: false } }) }), 3);
});

test('replay requires one absolute existing report and passes the recorded report unchanged', async () => {
  const input = await paths();
  const reportPath = path.join(input.root, 'result.json');
  await writeFile(reportPath, '{}');
  let received;
  assert.equal(await main(['--mode', 'replay', '--report', reportPath], {
    readReplay: async value => ({ reportPath: value, status: 'passed' }),
    replay: async report => { received = report; return { status: 'passed', protection: { ok: true }, cleanup: { verified: true } }; }
  }), 0);
  assert.deepEqual(received, { reportPath, status: 'passed' });
  assert.equal(await main(['--mode', 'replay', '--report', path.join(input.root, 'missing.json')], {
    replay: async () => assert.fail('missing report must not replay')
  }), 2);
});

test('CLI rejects unknown arguments, duplicate options and unsupported modes before execution', async () => {
  const never = { run: async () => assert.fail('invalid argv must not run') };
  assert.equal(await main(['--mode', 'other'], never), 2);
  assert.equal(await main(['--mode', 'quick', '--mode', 'full'], never), 2);
  assert.equal(await main(['--mode', 'quick', '--unknown', 'x'], never), 2);
});

test('CLI resolves real packaged Electron runner and replay by default', () => {
  const resolved = resolveCliDependencies({});
  assert.equal(resolved.run, runManualGuidedShell);
  assert.equal(resolved.replay, replayManualGuidedReport);
});
