import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createLegacySqliteStore } from '../../src/main/legacy-sqlite-store.mjs';

const require = createRequire(import.meta.url);
const electronPath = require('electron');
const preset = require('../../lib/device-preset.js');
const projectRoot = path.resolve(import.meta.dirname, '..', '..');
const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'battery-main-full-shell-'));

function initialState() {
  return {
    revision: 0,
    requests: [],
    samples: [],
    records: [],
    requestSourceRows: [],
    auditLogs: [{
      id: 'AUDIT-SMOKE-INIT',
      time: '2026-08-20T21:00:00.000Z',
      user: '系统',
      action: '初始化测试数据',
      target: '26 台设备 / 529 通道',
      before: null,
      after: { devices: 26, channels: 529 },
      level: 'normal',
      note: 'full-shell smoke'
    }],
    formChangeJournal: [],
    testers: [],
    deviceProfiles: preset.devices(),
    channels: preset.channels(),
    username: 'smoke-user',
    savedAt: ''
  };
}

async function seedLegacyState(dataRoot) {
  const store = await createLegacySqliteStore({
    dataRoot,
    clock: () => '2026-08-20T21:00:00.000Z'
  });
  try {
    const result = await store.save({ expectedRevision: 0, state: initialState(), journalEntries: [] });
    assert.equal(result.ok, true);
  } finally {
    store.close();
  }
}

async function launchElectron(dataRoot) {
  const profileRoot = path.join(temporaryRoot, 'profile');
  await mkdir(profileRoot, { recursive: true });
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
        BATTERY_CHANNEL_SMOKE: '1',
        BATTERY_CHANNEL_SMOKE_MODE: 'full-shell'
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
    }, 20000);
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('exit', code => {
      clearTimeout(timeout);
      if (timedOut) {
        reject(new Error(`Electron full-shell Smoke 超时\nSTDOUT:\n${stdout}\nSTDERR:\n${stderr}`));
        return;
      }
      resolve({ code, stdout, stderr });
    });
  });
}

try {
  const dataRoot = path.join(temporaryRoot, 'data');
  await mkdir(dataRoot, { recursive: true });
  await seedLegacyState(dataRoot);
  const result = await launchElectron(dataRoot);
  const marker = result.stdout.split(/\r?\n/).find(line => line.startsWith('SMOKE_RESULT='));

  assert.equal(result.code, 0, `Electron exit code\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`);
  assert.ok(marker, `缺少 SMOKE_RESULT\n${result.stdout}\n${result.stderr}`);
  const report = JSON.parse(marker.slice('SMOKE_RESULT='.length));
  assert.deepEqual(report.pages, [
    'dashboard', 'timeliness', 'apply', 'runningSamples', 'storageSamples',
    'reserved', 'requests', 'records', 'testers', 'devices'
  ]);
  assert.deepEqual(report.navigationIds, [
    'dashboard', 'timeliness', 'apply', 'runningSamples', 'storageSamples',
    'reserved', 'requests', 'records', 'testers', 'devices'
  ]);
  assert.equal(report.disabledNavigation, 0);
  assert.deepEqual(report.missingPages, []);
  assert.equal(report.initialStateSummary.devices, 26);
  assert.equal(report.initialStateSummary.channels, 529);
  assert.equal(report.initialStateSummary.requests, 0);
  assert.equal(report.initialStateSummary.records, 0);
  assert.equal(report.stateSummary.devices, 26);
  assert.equal(report.stateSummary.channels, 529);
  assert.equal(report.stateSummary.requests, 0);
  assert.equal(report.stateSummary.records, 0);
  assert.deepEqual(report.consoleErrors, []);
  process.stdout.write(`Electron full-shell Smoke PASS ${JSON.stringify(report)}\n`);
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
