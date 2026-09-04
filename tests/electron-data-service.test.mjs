import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createElectronDataService } from '../src/main/electron-data-service.mjs';
import { makeState } from './fixtures/state-fixtures.mjs';

const fixedNow = new Date('2026-08-20T22:00:00.000Z');

function readyStore(state = makeState({ dataRevision: 3 })) {
  return {
    inspect: async () => ({ kind: 'ready', state: structuredClone(state) })
  };
}

function service(overrides = {}) {
  return createElectronDataService({
    dialog: {
      showSaveDialog: async () => ({ canceled: true }),
      showOpenDialog: async () => ({ canceled: true })
    },
    store: readyStore(),
    dataRoot: 'C:\\isolated-data',
    documentsRoot: 'C:\\isolated-documents',
    writeBackup: async () => ({ ok: true }),
    restoreFromBackup: async () => ({ ok: true, state: makeState({ dataRevision: 4 }) }),
    clock: () => fixedNow,
    idFactory: () => 'adapter-test',
    ...overrides
  });
}

test('backup cancellation returns canceled and performs no backup write or state mutation', async () => {
  const state = makeState({ dataRevision: 3 });
  const before = structuredClone(state);
  let writes = 0;
  const adapter = service({
    store: readyStore(state),
    writeBackup: async () => { writes += 1; }
  });

  assert.deepEqual(await adapter.backupWithDialog(), { canceled: true });
  assert.equal(writes, 0);
  assert.deepEqual(state, before);
});

test('backup failure is reported as failure and never changes current state', async () => {
  const state = makeState({ dataRevision: 3 });
  const before = structuredClone(state);
  const adapter = service({
    store: readyStore(state),
    dialog: {
      showSaveDialog: async () => ({ canceled: false, filePath: 'C:\\isolated-backup\\state.json' }),
      showOpenDialog: async () => ({ canceled: true })
    },
    writeBackup: async () => { throw Object.assign(new Error('disk full'), { code: 'ENOSPC' }); }
  });

  const result = await adapter.backupWithDialog();
  assert.equal(result.ok, false);
  assert.equal(result.code, 'ENOSPC');
  assert.match(result.message, /disk full/);
  assert.deepEqual(state, before);
});

test('restore cancellation returns before state inspection or backup reading', async () => {
  let inspections = 0;
  let reads = 0;
  const adapter = service({
    store: { inspect: async () => { inspections += 1; } },
    readTextFile: async () => { reads += 1; }
  });

  assert.deepEqual(await adapter.restoreWithDialog(), { canceled: true });
  assert.equal(inspections, 0);
  assert.equal(reads, 0);
});

test('restore failure returns failure and preserves the current state', async () => {
  const root = await mkdtemp(join(tmpdir(), 'battery-dialog-adapter-'));
  const sourceFile = join(root, 'tampered.json');
  await writeFile(sourceFile, '{"tampered":true}\n', 'utf8');
  const state = makeState({ dataRevision: 3 });
  const before = structuredClone(state);
  let restoreCalls = 0;
  const adapter = service({
    store: readyStore(state),
    dataRoot: root,
    dialog: {
      showSaveDialog: async () => ({ canceled: true }),
      showOpenDialog: async () => ({ canceled: false, filePaths: [sourceFile] })
    },
    readTextFile: (filePath) => readFile(filePath, 'utf8'),
    restoreFromBackup: async () => {
      restoreCalls += 1;
      throw Object.assign(new Error('checksum mismatch'), { code: 'BACKUP_CHECKSUM_INVALID' });
    }
  });

  const result = await adapter.restoreWithDialog();
  assert.equal(restoreCalls, 1);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'BACKUP_CHECKSUM_INVALID');
  assert.match(result.message, /checksum mismatch/);
  assert.deepEqual(state, before);
});

test('restore success forwards the inspected revision and reports the pre-restore backup', async () => {
  const root = await mkdtemp(join(tmpdir(), 'battery-dialog-adapter-success-'));
  const sourceFile = join(root, 'backup.json');
  await writeFile(sourceFile, '{"format":"fixture"}\n', 'utf8');
  const state = makeState({ dataRevision: 8, username: 'operator' });
  let command;
  const adapter = service({
    store: readyStore(state),
    dataRoot: root,
    dialog: {
      showSaveDialog: async () => ({ canceled: true }),
      showOpenDialog: async () => ({ canceled: false, filePaths: [sourceFile] })
    },
    readTextFile: (filePath) => readFile(filePath, 'utf8'),
    restoreFromBackup: async (value) => {
      command = value;
      return { ok: true, state: makeState({ dataRevision: 9 }) };
    }
  });

  const result = await adapter.restoreWithDialog();
  assert.equal(result.ok, true);
  assert.equal(command.expectedRevision, 8);
  assert.equal(command.actor, 'operator');
  assert.match(command.preRestoreFile, /before-restore-.*adapter-test\.batterydata$/);
  assert.equal(result.preRestoreFile, command.preRestoreFile);
});
