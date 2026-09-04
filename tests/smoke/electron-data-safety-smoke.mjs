import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { createLegacySqliteStore } from '../../src/main/legacy-sqlite-store.mjs';

const require = createRequire(import.meta.url);
const electronPath = require('electron');
const preset = require('../../lib/device-preset.js');
const projectRoot = path.resolve(import.meta.dirname, '..', '..');
const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'battery-main-electron-safety-'));

async function snapshotFile(filePath) {
  const [bytes, metadata] = await Promise.all([readFile(filePath), stat(filePath)]);
  return {
    size: metadata.size,
    mtimeMs: metadata.mtimeMs,
    sha256: createHash('sha256').update(bytes).digest('hex')
  };
}

async function launchElectron(name, dataRoot, mode, phase = '', extraEnv = {}) {
  const profileRoot = path.join(temporaryRoot, `profile-${name}`);
  await mkdir(profileRoot, { recursive: true });
  return new Promise((resolve, reject) => {
    const child = spawn(electronPath, ['.', '--smoke-test', `--user-data-dir=${profileRoot}`, '--disable-gpu'], {
      cwd: projectRoot,
      env: {
        ...process.env,
        BATTERY_CHANNEL_DATA_DIR: dataRoot,
        BATTERY_CHANNEL_SMOKE: '1',
        BATTERY_CHANNEL_SMOKE_MODE: mode,
        ...(phase ? { BATTERY_CHANNEL_SMOKE_PHASE: phase } : {}),
        ...extraEnv
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timeout = setTimeout(() => { timedOut = true; child.kill(); }, 25000);
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('exit', code => {
      clearTimeout(timeout);
      const marker = stdout.split(/\r?\n/).find(line => line.startsWith('SMOKE_RESULT='));
      if (timedOut || code !== 0 || !marker) {
        reject(new Error(`${name} failed with ${code}\nSTDOUT:\n${stdout}\nSTDERR:\n${stderr}`));
        return;
      }
      resolve(JSON.parse(marker.slice('SMOKE_RESULT='.length)));
    });
  });
}

function reservationState() {
  return {
    revision: 0,
    requests: [{
      id: 'REQ-SAFETY-001', qty: 1, test: '循环测试', project: '无人机数据安全',
      sample: '35Ah', client: '委托人 A', dept: '研发部', tester: 'smoke-user', status: '待安排'
    }],
    samples: [{
      id: 'REQ-SAFETY-001.001', requestNo: 'REQ-SAFETY-001', ordinal: 1,
      status: 'pending', channelKey: '', start: '', end: '', hasHistory: false
    }],
    records: [], requestSourceRows: [], auditLogs: [], formChangeJournal: [], testers: [],
    deviceProfiles: preset.devices(), channels: preset.channels(), username: 'smoke-user', savedAt: ''
  };
}

async function seed(dataRoot) {
  const store = await createLegacySqliteStore({ dataRoot, clock: () => '2026-08-21T17:00:00.000Z' });
  try {
    const saved = await store.save({ expectedRevision: 0, state: reservationState(), journalEntries: [] });
    assert.equal(saved.ok, true);
    return { filePath: store.filePath, revision: saved.state.revision };
  } finally {
    store.close();
  }
}

function removeStorageCollectionFromPersistedPayload(filePath) {
  const db = new DatabaseSync(filePath);
  try {
    const row = db.prepare('SELECT payload FROM app_state WHERE id = 1').get();
    const payload = JSON.parse(row.payload);
    delete payload.storageRecords;
    db.prepare('UPDATE app_state SET payload = ? WHERE id = 1').run(JSON.stringify(payload));
  } finally {
    db.close();
  }
}

function persistedPayload(filePath) {
  const db = new DatabaseSync(filePath, { readOnly: true });
  try {
    return JSON.parse(db.prepare('SELECT payload FROM app_state WHERE id = 1').get().payload);
  } finally {
    db.close();
  }
}

try {
  const emptyRoot = path.join(temporaryRoot, 'empty-data');
  await mkdir(emptyRoot, { recursive: true });
  const emptyRun = await launchElectron('empty', emptyRoot, 'full-shell');
  const emptyFiles = await readdir(emptyRoot);
  assert.deepEqual(emptyRun.consoleErrors, []);
  assert.equal(emptyRun.stateSummary.devices, 0);
  assert.equal(emptyRun.stateSummary.channels, 0);
  assert.equal(emptyRun.stateSummary.storageRecords, 0);
  assert.deepEqual(emptyFiles, ['battery-channel-hub.sqlite']);

  const oldPayloadRoot = path.join(temporaryRoot, 'old-payload-data');
  await mkdir(oldPayloadRoot, { recursive: true });
  const oldPayloadSeed = await seed(oldPayloadRoot);
  removeStorageCollectionFromPersistedPayload(oldPayloadSeed.filePath);
  assert.equal(Object.hasOwn(persistedPayload(oldPayloadSeed.filePath), 'storageRecords'), false);
  const oldPayloadRun = await launchElectron('old-payload', oldPayloadRoot, 'full-shell');
  assert.equal(oldPayloadRun.stateSummary.storageRecords, 0);
  assert.deepEqual(persistedPayload(oldPayloadSeed.filePath).storageRecords, []);

  const restartRoot = path.join(temporaryRoot, 'restart-data');
  await mkdir(restartRoot, { recursive: true });
  await seed(restartRoot);
  const firstRun = await launchElectron('submit', restartRoot, 'reservation', 'submit');
  assert.equal(firstRun.saved.records, 1);
  const secondRun = await launchElectron('restart', restartRoot, 'reservation', 'verify');
  assert.ok(secondRun.persisted.revision > firstRun.saved.revision);
  assert.equal(secondRun.persisted.records, 1);
  assert.equal(secondRun.persisted.reservedSamples, 1);

  const legacyRoot = path.join(temporaryRoot, 'legacy-json-data');
  await mkdir(legacyRoot, { recursive: true });
  const legacyFile = path.join(legacyRoot, 'battery-channel-hub.json');
  await writeFile(legacyFile, `${JSON.stringify({ sentinel: '不得迁移或覆盖' }, null, 2)}\n`, 'utf8');
  const sourceBefore = await snapshotFile(legacyFile);
  await launchElectron('legacy-json', legacyRoot, 'full-shell');
  assert.deepEqual(await snapshotFile(legacyFile), sourceBefore);
  assert.deepEqual((await readdir(legacyRoot)).sort(), ['battery-channel-hub.json', 'battery-channel-hub.sqlite']);

  const failureRoot = path.join(temporaryRoot, 'failure-data');
  await mkdir(failureRoot, { recursive: true });
  const failureSeed = await seed(failureRoot);
  const failureRun = await launchElectron('failure', failureRoot, 'reservation', 'failure', {
    BATTERY_CHANNEL_SMOKE_PERSISTENCE_FAILURE: 'reservation'
  });
  assert.equal(failureRun.detailsOpen, true);
  assert.equal(failureRun.saved.records, 0);
  assert.deepEqual(failureRun.saved, failureRun.beforeFailure);
  assert.match(failureRun.message, /失败|持久化|保存/);
  const failureAfter = await snapshotFile(failureSeed.filePath);
  const failureStore = await createLegacySqliteStore({ dataRoot: failureRoot });
  try {
    const loaded = await failureStore.load();
    assert.equal(loaded.state.revision, failureRun.saved.revision);
    assert.equal(loaded.state.records.length, 0);
  } finally {
    failureStore.close();
  }

  process.stdout.write(`Electron data-safety Smoke PASS ${JSON.stringify({
    emptySqliteOnly: true,
    oldPayloadCompatible: oldPayloadRun.stateSummary.storageRecords === 0,
    restartRevision: secondRun.persisted.revision,
    restartRecords: secondRun.persisted.records,
    legacyJsonPreserved: sourceBefore.sha256,
    failurePreserved: failureRun.saved.records === 0,
    failureStateSha256: failureAfter.sha256
  })}\n`);
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
