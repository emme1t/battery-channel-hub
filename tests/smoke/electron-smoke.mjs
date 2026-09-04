import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

import { createStateStore } from '../../src/main/state-store.mjs';

const require = createRequire(import.meta.url);
const electronPath = require('electron');
const projectRoot = path.resolve(import.meta.dirname, '..', '..');
const fixturePath = path.join(import.meta.dirname, 'fixture-state.json');
const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'battery-channel-smoke-'));

async function runElectron() {
  const dataRoot = path.join(temporaryRoot, 'data');
  const profileRoot = path.join(temporaryRoot, 'profile');
  await mkdir(dataRoot, { recursive: true });
  await mkdir(profileRoot, { recursive: true });
  const fixture = JSON.parse(await readFile(fixturePath, 'utf8'));
  const seeded = await createStateStore({
    dataRoot,
    clock: () => new Date('2026-08-20T21:00:00.000Z'),
    idFactory: () => 'layout-seed'
  }).save(fixture, 0);
  assert.equal(seeded.ok, true);

  return new Promise((resolve, reject) => {
    const child = spawn(electronPath, [
      '.',
      '--smoke-test',
      `--user-data-dir=${profileRoot}`,
      '--disable-gpu'
    ], {
      cwd: projectRoot,
      env: {
        ...process.env,
        BATTERY_CHANNEL_DATA_DIR: dataRoot,
        BATTERY_CHANNEL_SMOKE: '1'
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, 15000);

    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('exit', (code) => {
      clearTimeout(timeout);
      if (timedOut) {
        reject(new Error(`Electron Smoke 超时\nSTDOUT:\n${stdout}\nSTDERR:\n${stderr}`));
        return;
      }
      resolve({ code, stdout, stderr });
    });
  });
}

try {
  const result = await runElectron();
  const marker = result.stdout
    .split(/\r?\n/)
    .find((line) => line.startsWith('SMOKE_RESULT='));
  assert.equal(result.code, 0, `Electron exit code\n${result.stderr}`);
  assert.ok(marker, `缺少 SMOKE_RESULT\n${result.stdout}\n${result.stderr}`);
  const payload = JSON.parse(marker.slice('SMOKE_RESULT='.length));
  assert.equal(payload.workspace, true);
  assert.equal(payload.detailsBefore, false);
  assert.equal(payload.detailsAfterSelect, true);
  assert.equal(payload.detailsAfterClose, false);
  assert.equal(payload.requestRows, 1);
  assert.deepEqual(payload.consoleErrors, []);
  process.stdout.write(`Electron Smoke PASS ${JSON.stringify(payload)}\n`);
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
