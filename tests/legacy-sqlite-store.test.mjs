import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { Worker } from 'node:worker_threads';

import { createLegacySqliteStore } from '../src/main/legacy-sqlite-store.mjs';

function emptyState(overrides = {}) {
  return {
    revision: 0,
    requests: [],
    channels: [],
    deviceProfiles: [],
    records: [],
    samples: [],
    requestSourceRows: [],
    auditLogs: [],
    formChangeJournal: [],
    testers: [],
    storageRecords: [],
    username: 'tester',
    savedAt: '',
    ...overrides
  };
}

function journal(id = 'FORM-1') {
  return {
    id,
    requestId: 'REQ-1',
    action: '修改申请执行字段',
    time: '2026-08-20T20:00:00.000Z',
    user: 'tester',
    before: { tester: '' },
    after: { tester: '李雷' },
    source: { file: '申请.xlsx' },
    level: 'warning',
    note: '测试'
  };
}

async function withStore(run) {
  const dataRoot = await mkdtemp(path.join(tmpdir(), 'battery-main-sqlite-'));
  const store = await createLegacySqliteStore({
    dataRoot,
    clock: () => '2026-08-20T20:00:00.000Z'
  });
  try {
    await run({ dataRoot, store });
  } finally {
    store.close();
    await rm(dataRoot, { recursive: true, force: true });
  }
}

function nextWorkerMessage(worker) {
  return new Promise((resolve, reject) => {
    worker.once('message', resolve);
    worker.once('error', reject);
  });
}

function concurrentWriter({ dataRoot, id }) {
  return new Worker(`
    const { parentPort, workerData } = require('node:worker_threads');

    void (async () => {
      const { createLegacySqliteStore } = await import(workerData.storeModuleUrl);
      const store = await createLegacySqliteStore({
        dataRoot: workerData.dataRoot,
        clock: () => '2026-08-20T20:00:00.000Z'
      });
      parentPort.postMessage({ type: 'ready' });
      let savePending = false;
      parentPort.on('message', async message => {
        if (message.type === 'save') {
          savePending = true;
          parentPort.postMessage({ type: 'save-ready' });
          return;
        }
        if (message.type === 'start-save' && savePending) {
          savePending = false;
          parentPort.postMessage({ type: 'save-started' });
          const result = await store.save({
            expectedRevision: 0,
            state: workerData.state,
            journalEntries: []
          });
          parentPort.postMessage({ type: 'result', result });
          return;
        }
        if (message.type === 'retry') {
          const result = await store.save({
            expectedRevision: message.expectedRevision,
            state: workerData.state,
            journalEntries: []
          });
          parentPort.postMessage({ type: 'retry-result', result });
          return;
        }
        if (message.type === 'close') {
          store.close();
          parentPort.close();
        }
      });
    })().catch(error => {
      parentPort.postMessage({
        type: 'error',
        error: { message: error.message, stack: error.stack }
      });
    });
  `, {
    eval: true,
    workerData: {
      dataRoot,
      storeModuleUrl: new URL('../src/main/legacy-sqlite-store.mjs', import.meta.url).href,
      state: emptyState({ requests: [{ id }] })
    }
  });
}

test('first load returns an empty legacy state without creating a JSON fallback', async () => {
  await withStore(async ({ dataRoot, store }) => {
    const result = await store.load();

    assert.equal(result.ok, true);
    assert.deepEqual(result.state, emptyState({ username: 'user001' }));
    await assert.rejects(readFile(path.join(dataRoot, 'battery-channel-hub.json')));
  });
});

test('state and form journal commit together and reload with the new revision', async () => {
  await withStore(async ({ store }) => {
    const state = emptyState({ requests: [{ id: 'REQ-1' }] });

    const saved = await store.save({ expectedRevision: 0, state, journalEntries: [journal()] });
    const loaded = await store.load();

    assert.equal(saved.ok, true);
    assert.equal(saved.state.revision, 1);
    assert.equal(loaded.state.revision, 1);
    assert.deepEqual(loaded.state.requests, [{ id: 'REQ-1', status: 'pending' }]);
    assert.equal(loaded.state.formChangeJournal.length, 1);
    assert.equal(loaded.state.formChangeJournal[0].id, 'FORM-1');
  });
});

test('duplicate form journal identifiers are ignored across later state saves', async () => {
  await withStore(async ({ store }) => {
    const first = await store.save({ expectedRevision: 0, state: emptyState(), journalEntries: [journal()] });
    const second = await store.save({
      expectedRevision: first.state.revision,
      state: { ...first.state, requests: [{ id: 'REQ-2' }] },
      journalEntries: [journal()]
    });
    const loaded = await store.load();

    assert.equal(second.ok, true);
    assert.equal(second.state.revision, 2);
    assert.equal(loaded.state.formChangeJournal.length, 1);
  });
});

test('revision conflicts return a structured failure and change no logical state', async () => {
  await withStore(async ({ store }) => {
    const first = await store.save({ expectedRevision: 0, state: emptyState(), journalEntries: [] });
    const before = await store.load();

    const conflict = await store.save({
      expectedRevision: 0,
      state: { ...first.state, requests: [{ id: 'STALE' }] },
      journalEntries: [journal('FORM-STALE')]
    });

    assert.equal(conflict.ok, false);
    assert.equal(conflict.code, 'REVISION_CONFLICT');
    assert.deepEqual(await store.load(), before);
  });
});

test('concurrent writers compare and advance revision under the same immediate transaction', async () => {
  const dataRoot = await mkdtemp(path.join(tmpdir(), 'battery-main-sqlite-concurrent-'));
  const bootstrap = await createLegacySqliteStore({ dataRoot });
  const filePath = bootstrap.filePath;
  bootstrap.close();

  const workers = [
    concurrentWriter({ dataRoot, id: 'WRITER-A' }),
    concurrentWriter({ dataRoot, id: 'WRITER-B' })
  ];
  let blocker;
  try {
    assert.deepEqual(await Promise.all(workers.map(nextWorkerMessage)), [
      { type: 'ready' },
      { type: 'ready' }
    ]);

    blocker = new DatabaseSync(filePath);
    blocker.exec('PRAGMA busy_timeout = 5000; BEGIN IMMEDIATE');

    const readyMessages = workers.map(nextWorkerMessage);
    workers.forEach(worker => worker.postMessage({ type: 'save' }));
    assert.deepEqual(await Promise.all(readyMessages), [
      { type: 'save-ready' },
      { type: 'save-ready' }
    ]);

    const startedMessages = workers.map(nextWorkerMessage);
    workers.forEach(worker => worker.postMessage({ type: 'start-save' }));
    assert.deepEqual(await Promise.all(startedMessages), [
      { type: 'save-started' },
      { type: 'save-started' }
    ]);
    const resultMessages = workers.map(nextWorkerMessage);
    blocker.exec('COMMIT');
    blocker.close();
    blocker = undefined;

    const results = (await Promise.all(resultMessages)).map(message => message.result);
    assert.equal(results.filter(result => result.ok).length, 1);
    assert.equal(results.filter(result => result.code === 'REVISION_CONFLICT').length, 1);

    const conflictIndex = results.findIndex(result => result.code === 'REVISION_CONFLICT');
    const retryMessage = nextWorkerMessage(workers[conflictIndex]);
    workers[conflictIndex].postMessage({ type: 'retry', expectedRevision: 1 });
    const retry = (await retryMessage).result;
    assert.equal(retry.ok, true);
    assert.equal(retry.state.revision, 2);
  } finally {
    try {
      blocker?.exec('ROLLBACK');
    } catch {
      // Cleanup must preserve the original assertion failure.
    }
    blocker?.close();
    workers.forEach(worker => worker.postMessage({ type: 'close' }));
    await Promise.allSettled(workers.map(worker => worker.terminate()));
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test('SQLite failure rolls back app state and form journal as one transaction', async () => {
  await withStore(async ({ dataRoot, store }) => {
    const first = await store.save({ expectedRevision: 0, state: emptyState(), journalEntries: [] });
    const before = await store.load();
    const injector = new DatabaseSync(path.join(dataRoot, 'battery-channel-hub.sqlite'));
    injector.exec(`
      CREATE TRIGGER fail_state_update
      BEFORE UPDATE ON app_state
      BEGIN
        SELECT RAISE(ABORT, 'injected failure');
      END;
    `);
    injector.close();

    const failed = await store.save({
      expectedRevision: first.state.revision,
      state: { ...first.state, requests: [{ id: 'REQ-FAIL' }] },
      journalEntries: [journal('FORM-FAIL')]
    });

    assert.equal(failed.ok, false);
    assert.equal(failed.code, 'PERSISTENCE_FAILED');
    assert.deepEqual(await store.load(), before);
  });
});
