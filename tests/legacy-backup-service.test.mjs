import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import {
  createLegacyBackupService,
  makeLegacyBackup,
  restoreLegacyBackup,
  verifyLegacyBackup,
  writeLegacyBackupFile
} from '../src/main/legacy-backup-service.mjs';
import { createLegacySqliteStore, SQLITE_FILE } from '../src/main/legacy-sqlite-store.mjs';

const fixedNow = '2026-08-20T16:00:00-07:00';

function stateFixture(overrides = {}) {
  return {
    revision: 0,
    requests: [], samples: [], records: [], requestSourceRows: [],
    deviceProfiles: [{ id: 'D-001', name: '设备 A', status: 'enabled' }],
    channels: [{ key: '设备 A|001', device: '设备 A', name: '001', state: 'free' }],
    auditLogs: [], formChangeJournal: [], testers: [], storageRecords: [],
    username: 'current-user', savedAt: '',
    ...overrides
  };
}

async function exists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

async function withStore(run, initial = stateFixture()) {
  const root = await mkdtemp(path.join(tmpdir(), 'battery-legacy-backup-'));
  const dataRoot = path.join(root, 'data');
  const store = await createLegacySqliteStore({ dataRoot, clock: () => fixedNow });
  try {
    const seeded = await store.save({ expectedRevision: 0, state: initial, journalEntries: initial.formChangeJournal });
    assert.equal(seeded.ok, true);
    await run({ root, dataRoot, store, current: seeded.state });
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
}

test('legacy backup checksum rejects state tampering and invalid state shape', () => {
  const packageValue = makeLegacyBackup(stateFixture({ revision: 4 }), { createdAt: fixedNow });
  assert.deepEqual(verifyLegacyBackup(packageValue), stateFixture({ revision: 4 }));

  const tampered = structuredClone(packageValue);
  tampered.state.username = 'tampered';
  assert.throws(() => verifyLegacyBackup(tampered), error => error.code === 'BACKUP_CHECKSUM_INVALID');

  const invalid = structuredClone(packageValue);
  invalid.state.channels[0].device = '不存在设备';
  assert.throws(() => verifyLegacyBackup(invalid), error => error.code === 'BACKUP_CHECKSUM_INVALID');
});

test('writeLegacyBackupFile atomically writes and re-reads a verified package', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'battery-legacy-backup-file-'));
  try {
    const filePath = path.join(root, 'nested', 'manual.batterydata');
    const result = await writeLegacyBackupFile(filePath, stateFixture({ revision: 3 }), {
      createdAt: fixedNow,
      idFactory: () => 'write-test'
    });
    assert.equal(result.ok, true);
    assert.equal(result.verified, true);
    assert.equal(result.file, path.resolve(filePath));
    assert.equal(verifyLegacyBackup(JSON.parse(await readFile(filePath, 'utf8'))).revision, 3);
    assert.deepEqual(await readdir(path.dirname(filePath)), ['manual.batterydata']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('tampered restore is rejected before pre-backup or current-state mutation', async () => {
  await withStore(async ({ root, store, current }) => {
    const packageValue = makeLegacyBackup(stateFixture({ username: 'restored' }), { createdAt: fixedNow });
    packageValue.state.username = 'tampered';
    const preRestoreFile = path.join(root, 'auto', 'before-restore.batterydata');
    const before = await store.load();

    await assert.rejects(
      () => restoreLegacyBackup({
        packageValue, store, expectedRevision: current.revision, preRestoreFile,
        actor: 'admin', auditId: 'AUDIT-RESTORE', now: fixedNow
      }),
      error => error.code === 'BACKUP_CHECKSUM_INVALID'
    );
    assert.equal(await exists(preRestoreFile), false);
    assert.deepEqual(await store.load(), before);
  });
});

test('successful restore preserves current and backup audit histories and verifies database reload', async () => {
  const currentAudit = { id: 'AUDIT-CURRENT', action: '当前日志', result: 'success' };
  const currentJournal = { id: 'JOURNAL-CURRENT', requestId: '', action: '当前表单日志', time: fixedNow };
  await withStore(async ({ root, store, current }) => {
    const restoredState = stateFixture({
      revision: 7,
      username: 'restored-user',
      requests: [{ id: 'REQ-STORAGE-BACKUP', status: 'assigned' }],
      samples: [{ id: 'REQ-STORAGE-BACKUP.001', requestNo: 'REQ-STORAGE-BACKUP', status: 'exception' }],
      storageRecords: [{
        id: 'STO-STORAGE-BACKUP', requestNo: 'REQ-STORAGE-BACKUP',
        sampleIds: ['REQ-STORAGE-BACKUP.001'], tester: 'backup-user', status: 'exception',
        startedAt: '2026-08-20T10:00:00.000Z', expectedEndAt: '2026-08-30T10:00:00.000Z',
        endedAt: '', note: '备份中的长期存储', returnReason: ''
      }],
      auditLogs: [{ id: 'AUDIT-BACKUP', action: '备份日志', result: 'success' }],
      formChangeJournal: [{ id: 'JOURNAL-BACKUP', requestId: '', action: '备份表单日志', time: fixedNow }]
    });
    const packageValue = makeLegacyBackup(restoredState, { createdAt: fixedNow });
    const preRestoreFile = path.join(root, 'auto', 'before-restore.batterydata');
    const result = await restoreLegacyBackup({
      packageValue, store, expectedRevision: current.revision, preRestoreFile,
      actor: 'admin', auditId: 'AUDIT-RESTORE', now: fixedNow
    });

    assert.equal(result.ok, true);
    assert.equal(result.verified, true);
    assert.equal(result.state.revision, current.revision + 1);
    assert.equal(result.state.username, 'restored-user');
    assert.deepEqual(result.state.storageRecords, restoredState.storageRecords);
    assert.deepEqual(
      new Set(result.state.auditLogs.map(item => item.id)),
      new Set(['AUDIT-CURRENT', 'AUDIT-BACKUP', 'AUDIT-RESTORE'])
    );
    assert.deepEqual(
      new Set(result.state.formChangeJournal.map(item => item.id)),
      new Set(['JOURNAL-CURRENT', 'JOURNAL-BACKUP'])
    );
    assert.equal(result.state.auditLogs.find(item => item.id === 'AUDIT-RESTORE').outcome, 'warning');
    assert.equal(result.state.auditLogs.find(item => item.id === 'AUDIT-RESTORE').verified, true);
    assert.deepEqual((await store.load()).state, result.state);
    assert.deepEqual(verifyLegacyBackup(JSON.parse(await readFile(preRestoreFile, 'utf8'))), current);
  }, stateFixture({ auditLogs: [currentAudit], formChangeJournal: [currentJournal] }));
});

test('revision conflict and pre-restore backup failure leave current state unchanged', async () => {
  await withStore(async ({ root, store, current }) => {
    const packageValue = makeLegacyBackup(stateFixture({ username: 'restored' }), { createdAt: fixedNow });
    const staleFile = path.join(root, 'auto', 'stale.batterydata');
    const before = await store.load();
    await assert.rejects(
      () => restoreLegacyBackup({
        packageValue, store, expectedRevision: current.revision - 1, preRestoreFile: staleFile,
        actor: 'admin', auditId: 'AUDIT-STALE', now: fixedNow
      }),
      error => error.code === 'REVISION_CONFLICT'
    );
    assert.equal(await exists(staleFile), false);

    const blocker = path.join(root, 'not-a-directory');
    await writeFile(blocker, 'file', 'utf8');
    await assert.rejects(
      () => restoreLegacyBackup({
        packageValue, store, expectedRevision: current.revision,
        preRestoreFile: path.join(blocker, 'before.batterydata'),
        actor: 'admin', auditId: 'AUDIT-PREBACKUP', now: fixedNow
      }),
      error => error.code === 'PRE_RESTORE_BACKUP_FAILED'
    );
    assert.deepEqual(await store.load(), before);
  });
});

test('restore persistence failure keeps current state even after a verified pre-backup', async () => {
  const current = stateFixture({ revision: 5 });
  let saveCalls = 0;
  const root = await mkdtemp(path.join(tmpdir(), 'battery-legacy-backup-save-failure-'));
  try {
    const preRestoreFile = path.join(root, 'before.batterydata');
    const store = {
      load: async () => ({ ok: true, state: structuredClone(current) }),
      save: async () => { saveCalls += 1; return { ok: false, code: 'PERSISTENCE_FAILED', message: 'write failed' }; }
    };
    await assert.rejects(
      () => restoreLegacyBackup({
        packageValue: makeLegacyBackup(stateFixture({ username: 'restored' })),
        store, expectedRevision: 5, preRestoreFile,
        actor: 'admin', auditId: 'AUDIT-FAIL', now: fixedNow
      }),
      error => error.code === 'PERSISTENCE_FAILED'
    );
    assert.equal(saveCalls, 1);
    assert.equal(await exists(preRestoreFile), true);
    assert.deepEqual((await store.load()).state, current);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('post-save restore mismatch atomically restores exact app_state revision, payload and journal rows', async () => {
  const currentJournal = {
    id: 'JOURNAL-CURRENT', requestId: 'REQ-CURRENT', action: 'current',
    time: '2026-08-20T15:00:00-07:00', user: 'current-user'
  };
  await withStore(async ({ root, dataRoot, store, current }) => {
    const restored = stateFixture({
      username: 'restored-user',
      formChangeJournal: [{
        id: 'JOURNAL-RESTORED', requestId: 'REQ-RESTORED', action: 'restored',
        time: fixedNow, user: 'restored-user'
      }]
    });
    let loadCalls = 0;
    const injectedStore = {
      load: async () => {
        loadCalls += 1;
        const loaded = await store.load();
        if (loadCalls === 2 && loaded.ok) {
          return { ok: true, state: { ...loaded.state, username: 'injected-reread-mismatch' } };
        }
        return loaded;
      },
      save: options => store.save(options),
      ...(typeof store.replaceExact === 'function'
        ? { replaceExact: options => store.replaceExact(options) }
        : {})
    };

    await assert.rejects(
      () => restoreLegacyBackup({
        packageValue: makeLegacyBackup(restored, { createdAt: fixedNow }),
        store: injectedStore,
        expectedRevision: current.revision,
        preRestoreFile: path.join(root, 'auto', 'before-mismatch.batterydata'),
        actor: 'admin', auditId: 'AUDIT-RESTORE-MISMATCH', now: fixedNow
      }),
      error => error.code === 'RESTORE_VERIFY_FAILED'
    );

    assert.ok(loadCalls >= 3, 'compensation must reload and compare the restored snapshot');
    assert.deepEqual((await store.load()).state, current);
    const database = new DatabaseSync(path.join(dataRoot, SQLITE_FILE), { readOnly: true });
    try {
      const row = database.prepare('SELECT revision, payload FROM app_state WHERE id = 1').get();
      assert.equal(Number(row.revision), current.revision);
      assert.deepEqual(JSON.parse(row.payload), current);
      assert.deepEqual(
        database.prepare('SELECT id FROM form_change_journal ORDER BY id').all().map(item => item.id),
        ['JOURNAL-CURRENT']
      );
    } finally {
      database.close();
    }
  }, stateFixture({ formChangeJournal: [currentJournal] }));
});

test('dialog cancellation performs no state load, backup write, or restore read', async () => {
  let loads = 0;
  let reads = 0;
  let writes = 0;
  const service = createLegacyBackupService({
    dialog: {
      showSaveDialog: async () => ({ canceled: true }),
      showOpenDialog: async () => ({ canceled: true, filePaths: [] })
    },
    store: {
      load: async () => { loads += 1; return { ok: true, state: stateFixture() }; },
      save: async () => { throw new Error('must not save'); }
    },
    dataRoot: 'C:\\isolated-data',
    documentsRoot: 'C:\\isolated-documents',
    readTextFile: async () => { reads += 1; },
    writeBackupFileImpl: async () => { writes += 1; },
    clock: () => new Date(fixedNow),
    idFactory: () => 'dialog-test'
  });
  assert.deepEqual(await service.backupState(), { canceled: true });
  assert.deepEqual(await service.restoreState({ expectedRevision: 0 }), { canceled: true });
  assert.equal(loads, 0);
  assert.equal(reads, 0);
  assert.equal(writes, 0);
});
