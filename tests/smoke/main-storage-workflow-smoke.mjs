import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createLegacySqliteStore } from '../../src/main/legacy-sqlite-store.mjs';

const require = createRequire(import.meta.url);
const electronPath = require('electron');
const preset = require('../../lib/device-preset.js');
const projectRoot = path.resolve(import.meta.dirname, '..', '..');
const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'battery-main-storage-smoke-'));

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function channelsHash(state) {
  return sha256(JSON.stringify(state.channels));
}

function request(id, project) {
  return {
    id, qty: 1, test: '长期存储 Smoke', project,
    sample: '35Ah', client: '委托人', dept: '研发部', tester: 'smoke-user', status: 'assigned'
  };
}

function sample(id, requestNo, status, channelKey = '') {
  return {
    id, requestNo, ordinal: 1, status, channelKey,
    start: status === 'running' ? '2026-08-28T08:00:00.000Z' : '',
    end: '', hasHistory: status !== 'pending'
  };
}

function initialState() {
  const deviceProfiles = preset.devices();
  const channels = preset.channels();
  const channel = channels[0];
  channel.state = 'busy';
  channel.project = '普通测试退回';
  channel.user = 'smoke-user';
  channel.start = '2026-08-28T08:00:00.000Z';
  channel.end = '2026-08-29T08:00:00.000Z';
  channel.requestNo = 'REQ-SMOKE-RUNNING';
  channel.test = '循环测试';
  channel.currentRecordId = 'REC-SMOKE-RUNNING';
  channel.nextRecordId = 'REC-SMOKE-NEXT';
  return {
    revision: 0,
    requests: [
      request('REQ-SMOKE-STORAGE', '存储生命周期'),
      request('REQ-SMOKE-STORAGE-RETURN', '存储退回'),
      request('REQ-SMOKE-RUNNING', '普通测试退回'),
      request('REQ-SMOKE-NEXT', '合法下一预约')
    ],
    samples: [
      sample('REQ-SMOKE-STORAGE.001', 'REQ-SMOKE-STORAGE', 'pending'),
      sample('REQ-SMOKE-STORAGE-RETURN.001', 'REQ-SMOKE-STORAGE-RETURN', 'pending'),
      sample('REQ-SMOKE-RUNNING.001', 'REQ-SMOKE-RUNNING', 'running', channel.key),
      sample('REQ-SMOKE-NEXT.001', 'REQ-SMOKE-NEXT', 'reserved', channel.key)
    ],
    records: [
      {
        id: 'REC-SMOKE-RUNNING', no: 'REQ-SMOKE-RUNNING', requestNo: 'REQ-SMOKE-RUNNING',
        sampleId: 'REQ-SMOKE-RUNNING.001', project: '普通测试退回', test: '循环测试',
        status: 'running', channelKey: channel.key, keys: [channel.key],
        start: '2026-08-28T08:00:00.000Z', end: '2026-08-29T08:00:00.000Z', user: 'smoke-user'
      },
      {
        id: 'REC-SMOKE-NEXT', no: 'REQ-SMOKE-NEXT', requestNo: 'REQ-SMOKE-NEXT',
        sampleId: 'REQ-SMOKE-NEXT.001', project: '合法下一预约', test: '循环测试',
        status: 'reserved', channelKey: channel.key, keys: [channel.key],
        start: '2026-08-29T09:00:00.000Z', end: '2026-08-29T12:00:00.000Z', user: 'next-user'
      }
    ],
    storageRecords: [], requestSourceRows: [], auditLogs: [], formChangeJournal: [], testers: [],
    deviceProfiles, channels, username: 'smoke-user', savedAt: ''
  };
}

async function seed(dataRoot) {
  const store = await createLegacySqliteStore({ dataRoot, clock: () => '2026-08-28T07:00:00.000Z' });
  try {
    const saved = await store.save({ expectedRevision: 0, state: initialState(), journalEntries: [] });
    assert.equal(saved.ok, true);
    return saved.state;
  } finally {
    store.close();
  }
}

async function load(dataRoot) {
  const store = await createLegacySqliteStore({ dataRoot });
  try {
    const result = await store.load();
    assert.equal(result.ok, true);
    return result.state;
  } finally {
    store.close();
  }
}

function terminateOwnedProcess(child) {
  if (!child?.pid || child.exitCode !== null) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
  } else {
    child.kill('SIGKILL');
  }
}

async function launchElectron(name, dataRoot, phase, extraEnv = {}) {
  const profileRoot = path.join(temporaryRoot, `profile-${name}`);
  await mkdir(profileRoot, { recursive: true });
  return new Promise((resolve, reject) => {
    const child = spawn(electronPath, ['.', '--smoke-test', `--user-data-dir=${profileRoot}`, '--disable-gpu'], {
      cwd: projectRoot,
      env: {
        ...process.env,
        BATTERY_CHANNEL_DATA_DIR: dataRoot,
        BATTERY_CHANNEL_SMOKE: '1',
        BATTERY_CHANNEL_SMOKE_MODE: 'storage',
        BATTERY_CHANNEL_SMOKE_PHASE: phase,
        ...extraEnv
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      terminateOwnedProcess(child);
    }, 30000);
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('exit', code => {
      clearTimeout(timeout);
      const marker = stdout.split(/\r?\n/).find(line => line.startsWith('SMOKE_RESULT='));
      if (timedOut || code !== 0 || !marker) {
        reject(new Error(`${name}/${phase} failed with ${code}\nSTDOUT:\n${stdout}\nSTDERR:\n${stderr}`));
        return;
      }
      resolve(JSON.parse(marker.slice('SMOKE_RESULT='.length)));
    });
  });
}

try {
  const lifecycleRoot = path.join(temporaryRoot, 'lifecycle-data');
  await mkdir(lifecycleRoot, { recursive: true });
  const lifecycleSeed = await seed(lifecycleRoot);
  const originalChannelsHash = channelsHash(lifecycleSeed);

  const started = await launchElectron('lifecycle-start', lifecycleRoot, 'start');
  assert.deepEqual(started.consoleErrors, []);
  assert.equal(started.activePage, 'storageSamples');
  assert.deepEqual(started.visibleSampleIds, ['REQ-SMOKE-STORAGE.001']);
  let persisted = await load(lifecycleRoot);
  assert.equal(persisted.storageRecords.find(item => item.id === 'STO-SMOKE-LIFECYCLE')?.status, 'storing');
  assert.equal(persisted.samples.find(item => item.id === 'REQ-SMOKE-STORAGE.001')?.status, 'storing');
  assert.equal(persisted.auditLogs.some(item => item.action === 'storage_started'), true);
  assert.equal(channelsHash(persisted), originalChannelsHash);

  const exception = await launchElectron('lifecycle-exception', lifecycleRoot, 'exception');
  assert.deepEqual(exception.consoleErrors, []);
  assert.equal(exception.storageStatus, 'exception');
  persisted = await load(lifecycleRoot);
  assert.equal(persisted.storageRecords.find(item => item.id === 'STO-SMOKE-LIFECYCLE')?.status, 'exception');
  assert.equal(persisted.samples.find(item => item.id === 'REQ-SMOKE-STORAGE.001')?.status, 'exception');
  assert.equal(persisted.auditLogs.some(item => item.action === 'storage_updated'), true);
  assert.equal(channelsHash(persisted), originalChannelsHash);

  const finished = await launchElectron('lifecycle-finish', lifecycleRoot, 'finish');
  assert.deepEqual(finished.consoleErrors, []);
  assert.equal(finished.storageStatus, 'completed');
  persisted = await load(lifecycleRoot);
  assert.equal(persisted.storageRecords.find(item => item.id === 'STO-SMOKE-LIFECYCLE')?.status, 'completed');
  assert.ok(persisted.storageRecords.find(item => item.id === 'STO-SMOKE-LIFECYCLE')?.endedAt);
  assert.equal(persisted.samples.find(item => item.id === 'REQ-SMOKE-STORAGE.001')?.status, 'completed');
  assert.equal(persisted.auditLogs.some(item => item.action === 'storage_finished'), true);
  assert.equal(channelsHash(persisted), originalChannelsHash);

  const returnsRoot = path.join(temporaryRoot, 'returns-data');
  await mkdir(returnsRoot, { recursive: true });
  await seed(returnsRoot);
  const returned = await launchElectron('returns', returnsRoot, 'returns');
  assert.deepEqual(returned.consoleErrors, []);
  assert.deepEqual(returned.runningVisibleSampleIds, ['REQ-SMOKE-RUNNING.001']);
  assert.deepEqual(returned.storageVisibleSampleIds, ['REQ-SMOKE-STORAGE-RETURN.001']);
  const returnedState = await load(returnsRoot);
  assert.equal(returnedState.records.find(item => item.id === 'REC-SMOKE-RUNNING')?.status, 'returned');
  assert.equal(returnedState.samples.find(item => item.id === 'REQ-SMOKE-RUNNING.001')?.status, 'pending');
  assert.equal(returnedState.storageRecords.find(item => item.id === 'STO-SMOKE-RETURN')?.status, 'returned');
  assert.equal(returnedState.samples.find(item => item.id === 'REQ-SMOKE-STORAGE-RETURN.001')?.status, 'pending');
  const returnedChannel = returnedState.channels.find(item => item.currentRecordId === '' && item.nextRecordId === 'REC-SMOKE-NEXT');
  assert.ok(returnedChannel, '普通退回应释放 current 并保留合法 next');
  assert.equal(returnedState.auditLogs.some(item => item.action === 'running_returned_to_application'), true);
  assert.equal(returnedState.auditLogs.some(item => item.action === 'storage_returned_to_application'), true);

  const failureRoot = path.join(temporaryRoot, 'failure-data');
  await mkdir(failureRoot, { recursive: true });
  const failureSeed = await seed(failureRoot);
  const failed = await launchElectron('failure', failureRoot, 'failure', {
    BATTERY_CHANNEL_SMOKE_PERSISTENCE_FAILURE: 'storage'
  });
  assert.deepEqual(failed.consoleErrors, []);
  assert.equal(failed.ok, false);
  assert.equal(failed.code, 'SMOKE_INJECTED_PERSISTENCE_FAILURE');
  assert.equal(failed.stateUnchanged, true);
  const failureAfter = await load(failureRoot);
  assert.equal(failureAfter.storageRecords.length, 0);
  assert.equal(failureAfter.samples.find(item => item.id === 'REQ-SMOKE-STORAGE.001')?.status, 'pending');
  assert.equal(failureAfter.auditLogs.some(item => item.action === 'storage_started'), false);
  assert.equal(channelsHash(failureAfter), channelsHash(failureSeed));

  process.stdout.write(`Electron main storage workflow Smoke PASS ${JSON.stringify({
    lifecycleRevision: persisted.revision,
    channelSha256: originalChannelsHash,
    runningReturnAudit: true,
    storageReturnAudit: true,
    persistenceFailurePreserved: true
  })}\n`);
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
