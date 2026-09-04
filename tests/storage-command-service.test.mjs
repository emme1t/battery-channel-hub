import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import vm from 'node:vm';

import { createStorageCommandService } from '../src/main/storage-command-service.mjs';
import { createLegacySqliteStore } from '../src/main/legacy-sqlite-store.mjs';

const require = createRequire(import.meta.url);
const Module = require('node:module');

function emptyState(overrides = {}) {
  return {
    revision: 0,
    requests: [{ id: 'REQ-1' }],
    channels: [],
    deviceProfiles: [],
    records: [],
    samples: [{ id: 'REQ-1.001', requestNo: 'REQ-1', status: 'pending' }],
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

function startCommand(expectedRevision = 0) {
  return {
    type: 'startStorage',
    expectedRevision,
    payload: {
      storageId: 'STO-1', requestNo: 'REQ-1', sampleIds: ['REQ-1.001'], tester: 'tester',
      expectedEndAt: '2026-09-28T08:00:00.000Z', actor: 'tester', auditId: 'AUD-1',
      now: '2026-08-28T08:00:00.000Z', note: '保存'
    }
  };
}

async function withStore(run) {
  const dataRoot = await mkdtemp(path.join(tmpdir(), 'battery-storage-command-'));
  const rawStore = await createLegacySqliteStore({
    dataRoot,
    clock: () => '2026-08-28T08:00:00.000Z'
  });
  let saveCalls = 0;
  const store = {
    load: (...args) => rawStore.load(...args),
    save: async (...args) => {
      saveCalls += 1;
      return rawStore.save(...args);
    }
  };
  try {
    await run({ dataRoot, rawStore, store, saveCalls: () => saveCalls });
  } finally {
    rawStore.close();
    await rm(dataRoot, { recursive: true, force: true });
  }
}

test('storage command service rejects unknown commands without loading or saving', async () => {
  await withStore(async ({ store, saveCalls }) => {
    const service = createStorageCommandService({ store });

    const result = await service.execute({ type: 'unknown', expectedRevision: 0 });

    assert.equal(result.ok, false);
    assert.equal(result.code, 'COMMAND_UNSUPPORTED');
    assert.equal(saveCalls(), 0);
  });
});

test('storage command service rejects a stale revision with zero saves', async () => {
  await withStore(async ({ rawStore, store, saveCalls }) => {
    const seeded = await rawStore.save({ expectedRevision: 0, state: emptyState(), journalEntries: [] });
    assert.equal(seeded.ok, true);
    const service = createStorageCommandService({ store });

    const result = await service.execute(startCommand(0));

    assert.equal(result.ok, false);
    assert.equal(result.code, 'REVISION_CONFLICT');
    assert.equal(saveCalls(), 0);
  });
});

test('storage command service saves once and a reopened SQLite store preserves storage plus audit', async () => {
  await withStore(async ({ dataRoot, rawStore, store, saveCalls }) => {
    const service = createStorageCommandService({ store });
    const seeded = await rawStore.save({ expectedRevision: 0, state: emptyState(), journalEntries: [] });
    assert.equal(seeded.ok, true);
    const result = await service.execute(startCommand(seeded.state.revision));

    assert.equal(result.ok, true);
    assert.equal(saveCalls(), 1);
    rawStore.close();
    const reopened = await createLegacySqliteStore({ dataRoot });
    try {
      const loaded = await reopened.load();
      assert.equal(loaded.ok, true);
      assert.equal(loaded.state.storageRecords[0].id, 'STO-1');
      assert.equal(loaded.state.auditLogs[0].action, 'storage_started');
    } finally {
      reopened.close();
    }
  });
});

test('a SQLite save failure leaves storage state and audit unchanged', async () => {
  await withStore(async ({ dataRoot, rawStore, store }) => {
    const service = createStorageCommandService({ store });
    const seeded = await rawStore.save({ expectedRevision: 0, state: emptyState(), journalEntries: [] });
    assert.equal(seeded.ok, true);
    const started = await service.execute(startCommand(seeded.state.revision));
    assert.equal(started.ok, true);
    const before = await rawStore.load();
    const injector = new DatabaseSync(path.join(dataRoot, 'battery-channel-hub.sqlite'));
    injector.exec(`
      CREATE TRIGGER fail_storage_update
      BEFORE UPDATE ON app_state
      BEGIN
        SELECT RAISE(ABORT, 'injected storage failure');
      END;
    `);
    injector.close();

    const failed = await service.execute({
      type: 'updateStorage', expectedRevision: started.state.revision,
      payload: {
        storageId: 'STO-1', note: '不得保存', actor: 'tester', auditId: 'AUD-2',
        now: '2026-08-29T08:00:00.000Z'
      }
    });

    assert.equal(failed.ok, false);
    assert.equal(failed.code, 'PERSISTENCE_FAILED');
    assert.deepEqual(await rawStore.load(), before);
  });
});

test('storage return executes through the service, saves once, and rejects invalid or stale commands without saving', async () => {
  await withStore(async ({ rawStore, store, saveCalls }) => {
    const seeded = await rawStore.save({
      expectedRevision: 0,
      state: emptyState({
        samples: [{ id: 'REQ-1.001', requestNo: 'REQ-1', status: 'storing', hasHistory: true }],
        storageRecords: [{
          id: 'STO-RETURN', requestNo: 'REQ-1', sampleIds: ['REQ-1.001'], tester: 'tester',
          status: 'storing', startedAt: '2026-08-01T08:00:00.000Z',
          expectedEndAt: '2026-09-28T08:00:00.000Z', endedAt: '', note: '保存', returnReason: ''
        }]
      }),
      journalEntries: []
    });
    assert.equal(seeded.ok, true);
    const service = createStorageCommandService({ store });
    const payload = {
      storageId: 'STO-RETURN', actor: 'tester', auditId: 'AUD-RETURN',
      now: '2026-08-28T10:00:00.000Z', reason: '申请资料需要补充'
    };

    const invalid = await service.execute({
      type: 'returnStorageToApplication', expectedRevision: seeded.state.revision,
      payload: { ...payload, reason: '' }
    });
    assert.equal(invalid.ok, false);
    assert.equal(invalid.code, 'COMMAND_FIELD_REQUIRED');
    assert.equal(saveCalls(), 0);

    const stale = await service.execute({
      type: 'returnStorageToApplication', expectedRevision: seeded.state.revision - 1, payload
    });
    assert.equal(stale.ok, false);
    assert.equal(stale.code, 'REVISION_CONFLICT');
    assert.equal(saveCalls(), 0);

    const success = await service.execute({
      type: 'returnStorageToApplication', expectedRevision: seeded.state.revision, payload
    });
    assert.equal(success.ok, true);
    assert.equal(saveCalls(), 1);
    assert.equal(success.state.storageRecords[0].status, 'returned');
    assert.equal(success.state.samples[0].status, 'pending');
    assert.equal(success.state.auditLogs[0].action, 'storage_returned_to_application');
    assert.equal(success.state.auditLogs[0].note, '申请资料需要补充');
  });
});

test('preload serializes storage commands and carries the latest revision', async () => {
  const source = await readFile(path.resolve(import.meta.dirname, '..', 'preload.js'), 'utf8');
  let api;
  const calls = [];
  const context = {
    structuredClone,
    Promise,
    process: { defaultApp: true },
    require(name) {
      assert.equal(name, 'electron');
      return {
        contextBridge: { exposeInMainWorld: (_key, value) => { api = value; } },
        ipcRenderer: {
          async invoke(channel, command) {
            if (channel === 'state:load') return { revision: 7 };
            calls.push({ channel, command });
            return { ok: true, state: { revision: command.expectedRevision + 1 } };
          }
        }
      };
    }
  };
  vm.runInNewContext(source, context, { filename: 'preload.js' });
  await api.loadState();

  await Promise.all([
    api.executeStorage({ type: 'startStorage' }),
    api.executeStorage({ type: 'finishStorage' })
  ]);

  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [
    { channel: 'storage:execute', command: { type: 'startStorage', expectedRevision: 7 } },
    { channel: 'storage:execute', command: { type: 'finishStorage', expectedRevision: 8 } }
  ]);
});

test('main process registers storage IPC against the isolated SQLite service', async () => {
  const dataRoot = await mkdtemp(path.join(tmpdir(), 'battery-storage-main-ipc-'));
  const mainPath = path.resolve(import.meta.dirname, '..', 'main.js');
  const handlers = new Map();
  const lifecycle = new Map();
  const previousDataRoot = process.env.BATTERY_CHANNEL_DATA_DIR;
  const originalLoad = Module._load;
  const electron = {
    app: {
      isPackaged: false,
      requestSingleInstanceLock: () => true,
      whenReady: () => Promise.resolve(),
      getPath: () => dataRoot,
      on: (event, listener) => lifecycle.set(event, listener),
      quit() {},
      exit() {}
    },
    BrowserWindow: class {
      static getAllWindows() { return []; }
      constructor() {
        this.webContents = { on() {}, once() {} };
      }
      async loadFile() {}
    },
    dialog: { showOpenDialog() {}, showSaveDialog() {} },
    ipcMain: { handle: (channel, listener) => handlers.set(channel, listener) }
  };
  process.env.BATTERY_CHANNEL_DATA_DIR = dataRoot;
  Module._load = function mockElectron(request, parent, isMain) {
    if (request === 'electron') return electron;
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    delete require.cache[mainPath];
    require(mainPath);
    for (let attempt = 0; attempt < 20 && !handlers.has('storage:execute'); attempt += 1) {
      await new Promise(resolve => setImmediate(resolve));
    }

    assert.equal(typeof handlers.get('storage:execute'), 'function');
    const result = await handlers.get('storage:execute')({}, startCommand());
    assert.equal(result.ok, false);
    assert.equal(result.code, 'REQUEST_NOT_FOUND');
  } finally {
    lifecycle.get('will-quit')?.();
    delete require.cache[mainPath];
    Module._load = originalLoad;
    if (previousDataRoot === undefined) delete process.env.BATTERY_CHANNEL_DATA_DIR;
    else process.env.BATTERY_CHANNEL_DATA_DIR = previousDataRoot;
    await rm(dataRoot, { recursive: true, force: true });
  }
});
