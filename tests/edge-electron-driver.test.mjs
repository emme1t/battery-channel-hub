import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const electronModule = await import('../scripts/edge-regression/electron-driver.mjs').catch(() => ({}));

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'edge-electron-driver-'));
  const projectRoot = path.join(root, 'project');
  const runRoot = path.join(root, 'run');
  await Promise.all([mkdir(projectRoot), mkdir(runRoot)]);
  await writeFile(path.join(projectRoot, 'package.json'), JSON.stringify({
    scripts: {
      pass: 'node -e "console.log(\'SMOKE_OK\')"',
      fail: 'node -e "console.error(\'SMOKE_BAD\');process.exit(7)"'
    }
  }), 'utf8');
  return { projectRoot, runRoot };
}

test('electron evidence driver exports the required API', () => {
  assert.equal(typeof electronModule.createElectronEvidenceDriver, 'function');
});

test('successful smoke script produces durable evidence and is cached', async () => {
  const paths = await fixture();
  const driver = electronModule.createElectronEvidenceDriver(paths);
  const first = await driver.runSmoke({ key: 'native-pass', script: 'pass' });
  const second = await driver.runSmoke({ key: 'native-pass', script: 'pass' });
  assert.equal(first.ok, true);
  assert.deepEqual(second, first);
  assert.match(await readFile(first.evidencePath, 'utf8'), /SMOKE_OK/);
});

test('failed smoke script cannot be reported as passing', async () => {
  const paths = await fixture();
  const driver = electronModule.createElectronEvidenceDriver(paths);
  const result = await driver.runSmoke({ key: 'native-fail', script: 'fail' });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'ELECTRON_SMOKE_FAILED');
  assert.equal(result.exitCode, 7);
});
