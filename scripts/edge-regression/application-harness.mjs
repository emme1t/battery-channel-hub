import { createHash } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { createApplicationCommandService } from '../../src/main/application-command-service.mjs';
import { createDashboardPngService } from '../../src/main/dashboard-png-service.mjs';
import { createExcelDialogService } from '../../src/main/excel-service.mjs';
import { createLegacyBackupService } from '../../src/main/legacy-backup-service.mjs';
import { createLegacySqliteStore } from '../../src/main/legacy-sqlite-store.mjs';
import { createReservationCommandService } from '../../src/main/reservation-command-service.mjs';
import { createStorageCommandService } from '../../src/main/storage-command-service.mjs';

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function isoFrom(clock) {
  const value = clock();
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function structuredFailure(error, fallbackCode) {
  return {
    ok: false,
    code: error?.code || fallbackCode,
    message: error?.message || String(error),
    ...(error?.details === undefined ? {} : { details: clone(error.details) })
  };
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonicalize(value[key])]));
  }
  return value;
}

function collectionHash(value) {
  return createHash('sha256').update(JSON.stringify(canonicalize(value))).digest('hex');
}

function stateCounts(state) {
  return {
    requests: state.requests.length,
    samples: state.samples.length,
    devices: state.deviceProfiles.length,
    channels: state.channels.length,
    records: state.records.length,
    audits: state.auditLogs.length,
    journals: state.formChangeJournal.length,
    testers: state.testers.length
  };
}

function createQueuedDialog({ dialogQueue, pathGuard, allowedReadRoots }) {
  const queues = {
    open: [...(dialogQueue?.open || [])].map(clone),
    save: [...(dialogQueue?.save || [])].map(clone)
  };

  async function next(kind) {
    const selection = queues[kind].shift() || { canceled: true };
    if (selection.canceled) return clone(selection);
    if (kind === 'open') {
      for (const filePath of selection.filePaths || []) {
        await pathGuard.assertReadable(filePath, allowedReadRoots);
      }
    } else if (selection.filePath) {
      selection.filePath = await pathGuard.assertWritable(selection.filePath);
    }
    return clone(selection);
  }

  return {
    showOpenDialog: () => next('open'),
    showSaveDialog: () => next('save'),
    enqueue(kind, selection) {
      if (!Object.hasOwn(queues, kind)) throw new TypeError(`unknown dialog queue: ${kind}`);
      queues[kind].push(clone(selection));
    },
    pending() {
      return { open: queues.open.length, save: queues.save.length };
    }
  };
}

export async function createApplicationHarness({
  projectRoot,
  runRoot,
  dataRoot,
  outputRoot,
  pathGuard,
  dialogQueue = { open: [], save: [] },
  allowedReadRoots,
  clock = () => new Date()
}) {
  if (!projectRoot || !runRoot || !dataRoot || !outputRoot || !pathGuard) {
    throw new TypeError('projectRoot, runRoot, dataRoot, outputRoot and pathGuard are required');
  }
  await pathGuard.assertWritable(path.join(dataRoot, '.data-root-probe'));
  await pathGuard.assertWritable(path.join(outputRoot, '.output-root-probe'));
  await Promise.all([mkdir(dataRoot, { recursive: true }), mkdir(outputRoot, { recursive: true })]);
  const store = await createLegacySqliteStore({ dataRoot, clock: () => isoFrom(clock) });
  const reservationService = createReservationCommandService({ store });
  const storageService = createStorageCommandService({ store });
  const applicationService = createApplicationCommandService({ store });
  const dialog = createQueuedDialog({
    dialogQueue,
    pathGuard,
    allowedReadRoots: allowedReadRoots || [path.resolve(projectRoot), path.resolve(runRoot)]
  });
  const excelService = createExcelDialogService({ dialog, documentsPath: outputRoot });
  const pngService = createDashboardPngService({ dialog });
  const backupService = createLegacyBackupService({
    dialog,
    store,
    dataRoot,
    documentsRoot: outputRoot,
    clock
  });
  let closed = false;
  let saveTail = Promise.resolve();
  const initial = await store.load();
  if (!initial.ok) {
    store.close();
    throw Object.assign(new Error(initial.message), { code: initial.code });
  }
  let revision = initial.state.revision;

  function assertOpen() {
    if (closed) throw Object.assign(new Error('application harness is closed'), { code: 'HARNESS_CLOSED' });
  }

  function serialize(operation) {
    assertOpen();
    const running = saveTail.then(operation);
    saveTail = running.catch(() => undefined);
    return running;
  }

  async function loadState() {
    assertOpen();
    await saveTail;
    const loaded = await store.load();
    if (!loaded.ok) throw Object.assign(new Error(loaded.message), { code: loaded.code, details: loaded.details });
    revision = loaded.state.revision;
    return clone(loaded.state);
  }

  async function invokeRead(operation, fallbackCode) {
    assertOpen();
    await saveTail;
    try {
      return clone(await operation());
    } catch (error) {
      return structuredFailure(error, fallbackCode);
    }
  }

  return Object.freeze({
    isTestEnvironment: true,
    filePath: store.filePath,

    loadState,

    saveState(state) {
      const snapshot = clone(state);
      return serialize(async () => {
        const result = await store.save({
          expectedRevision: revision,
          state: snapshot,
          journalEntries: snapshot?.formChangeJournal || []
        });
        if (!result.ok) throw Object.assign(new Error(result.message), { code: result.code, details: result.details });
        revision = result.state.revision;
        return clone(result.state);
      });
    },

    executeReservation(command) {
      const snapshot = clone(command || {});
      return serialize(async () => {
        const result = await reservationService.execute({ ...snapshot, expectedRevision: revision });
        if (result.ok) revision = result.state.revision;
        return clone(result);
      });
    },

    executeStorage(command) {
      const snapshot = clone(command || {});
      return serialize(async () => {
        const result = await storageService.execute({ ...snapshot, expectedRevision: revision });
        if (result.ok) revision = result.state.revision;
        return clone(result);
      });
    },

    executeApplication(command) {
      const snapshot = clone(command || {});
      return serialize(async () => {
        const result = await applicationService.execute({ ...snapshot, expectedRevision: revision });
        if (result.ok) revision = result.state.revision;
        return clone(result);
      });
    },

    importExcel: () => invokeRead(() => excelService.importFile(), 'EXCEL_IMPORT_FAILED'),
    importFolder: () => invokeRead(() => excelService.importFolder(), 'FOLDER_IMPORT_FAILED'),
    exportExcel: payload => invokeRead(() => excelService.exportWorkbook(clone(payload || {})), 'EXCEL_EXPORT_FAILED'),
    exportDashboardPng: payload => invokeRead(() => pngService.exportPng(clone(payload || {})), 'DASHBOARD_PNG_EXPORT_FAILED'),
    backupState: () => invokeRead(() => backupService.backupState(), 'BACKUP_FAILED'),

    restoreState(command = {}) {
      const snapshot = clone(command);
      return serialize(async () => {
        try {
          const result = await backupService.restoreState({ ...snapshot, expectedRevision: revision });
          if (result.ok) revision = result.state.revision;
          return clone(result);
        } catch (error) {
          return structuredFailure(error, 'RESTORE_FAILED');
        }
      });
    },

    enqueueDialog: (kind, selection) => dialog.enqueue(kind, selection),
    pendingDialogs: () => dialog.pending(),

    async inspectSqlite() {
      assertOpen();
      await saveTail;
      const independentStore = await createLegacySqliteStore({ dataRoot, clock: () => isoFrom(clock) });
      let state;
      try {
        const loaded = await independentStore.load();
        if (!loaded.ok) throw Object.assign(new Error(loaded.message), { code: loaded.code });
        state = loaded.state;
      } finally {
        independentStore.close();
      }
      const db = new DatabaseSync(store.filePath, { readOnly: true });
      let integrity;
      try {
        const row = db.prepare('PRAGMA integrity_check').get();
        integrity = String(row?.integrity_check || Object.values(row || {})[0] || '');
      } finally {
        db.close();
      }
      return {
        filePath: store.filePath,
        integrity,
        revision: state.revision,
        counts: stateCounts(state),
        collectionSha256: Object.fromEntries([
          ['requests', state.requests], ['samples', state.samples], ['devices', state.deviceProfiles],
          ['channels', state.channels], ['records', state.records], ['audits', state.auditLogs],
          ['journals', state.formChangeJournal], ['testers', state.testers]
        ].map(([key, value]) => [key, collectionHash(value)]))
      };
    },

    async close() {
      if (closed) return;
      await saveTail;
      closed = true;
      store.close();
    }
  });
}
