import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fsPromises from 'node:fs/promises';
import {
  copyFile, mkdtemp, mkdir, readFile, readdir, rename, rm, stat, symlink, unlink, writeFile
} from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import {
  inspectProductionRoot,
  rollbackProductionData,
  switchProductionData
} from '../src/main/production-switch-service.mjs';
import { createLegacySqliteStore, SQLITE_FILE } from '../src/main/legacy-sqlite-store.mjs';

const require = createRequire(import.meta.url);
const preset = require('../lib/device-preset.js');
const fixedNow = '2026-08-20T17:00:00-07:00';

function stateFixture({ approved = true, marker = 'candidate' } = {}) {
  const deviceProfiles = approved ? preset.devices() : [{ id: 'D-ONE', name: '单设备' }];
  const channels = approved ? preset.channels() : [{ key: '单设备|001', device: '单设备', name: '001', state: 'free' }];
  return {
    revision: 0,
    requests: [], samples: [], records: [], requestSourceRows: [],
    auditLogs: [{ id: `AUDIT-${marker}`, time: fixedNow, user: '系统', action: marker }],
    formChangeJournal: [], testers: [], storageRecords: [], deviceProfiles, channels,
    username: marker, savedAt: ''
  };
}

async function createSqlite(directory, state) {
  const store = await createLegacySqliteStore({ dataRoot: directory, clock: () => fixedNow });
  try {
    const result = await store.save({ expectedRevision: 0, state, journalEntries: [] });
    assert.equal(result.ok, true);
  } finally {
    store.close();
  }
  return path.join(directory, SQLITE_FILE);
}

async function sha256(filePath) {
  return createHash('sha256').update(await readFile(filePath)).digest('hex');
}

function readSqliteState(filePath) {
  const database = new DatabaseSync(filePath, { readOnly: true });
  try {
    const row = database.prepare('SELECT revision, payload FROM app_state WHERE id = 1').get();
    const journalIds = database.prepare('SELECT id FROM form_change_journal ORDER BY id').all().map(item => item.id);
    return { revision: Number(row.revision), state: JSON.parse(row.payload), journalIds };
  } finally {
    database.close();
  }
}

async function createDirectoryLink(target, linkPath) {
  await symlink(target, linkPath, process.platform === 'win32' ? 'junction' : 'dir');
}

async function snapshotTree(root) {
  const result = {};
  async function walk(current, relative = '') {
    for (const entry of (await readdir(current, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const fullPath = path.join(current, entry.name);
      const key = path.join(relative, entry.name).replaceAll('\\', '/');
      const info = await stat(fullPath);
      if (entry.isDirectory()) {
        result[`${key}/`] = { mtimeMs: info.mtimeMs };
        await walk(fullPath, key);
      } else {
        result[key] = { size: info.size, mtimeMs: info.mtimeMs, sha256: await sha256(fullPath) };
      }
    }
  }
  await walk(root);
  return result;
}

async function setup() {
  const root = await mkdtemp(path.join(tmpdir(), 'battery-production-switch-'));
  const dataRoot = path.join(root, 'production-data');
  const candidateRoot = path.join(root, 'candidate-data');
  const backupRoot = path.join(root, 'external-backups');
  await mkdir(dataRoot, { recursive: true });
  await mkdir(candidateRoot, { recursive: true });
  const activeDatabase = await createSqlite(dataRoot, stateFixture({ approved: true, marker: 'active-old' }));
  const candidate = await createSqlite(candidateRoot, stateFixture({ approved: true, marker: 'candidate-new' }));
  const activeProgram = path.join(root, 'Battery-Channel-Hub.exe');
  const candidateProgram = path.join(root, 'Battery-Channel-Hub-candidate.exe');
  await writeFile(activeProgram, 'old-program', 'utf8');
  await writeFile(candidateProgram, 'new-program', 'utf8');
  return { root, dataRoot, candidateRoot, backupRoot, activeDatabase, candidate, activeProgram, candidateProgram };
}

async function setupAppliedSwitch(runId = 'RUN-ROLLBACK') {
  const fixture = await setup();
  const oldDatabaseHash = await sha256(fixture.activeDatabase);
  const oldProgramHash = await sha256(fixture.activeProgram);
  const candidateSourceHash = await sha256(fixture.candidate);
  const candidateProgramHash = await sha256(fixture.candidateProgram);
  const switchReport = await switchProductionData({
    mode: 'apply', dataRoot: fixture.dataRoot, candidate: fixture.candidate,
    activeProgram: fixture.activeProgram, candidateProgram: fixture.candidateProgram,
    externalBackupRoot: fixture.backupRoot, runId, now: fixedNow
  });
  const candidateHash = await sha256(fixture.activeDatabase);
  return {
    ...fixture, runId, switchReport,
    oldDatabaseHash, oldProgramHash, candidateHash, candidateSourceHash, candidateProgramHash
  };
}

function reportFailureFs(finalName, phase) {
  const finalSuffix = path.sep + finalName;
  const temporarySuffix = `${finalSuffix}.tmp`;
  return {
    ...fsPromises,
    async open(filePath, flags) {
      const handle = await fsPromises.open(filePath, flags);
      if (!String(filePath).endsWith(temporarySuffix)) return handle;
      return {
        writeFile: phase === 'write'
          ? async () => { throw new Error('injected report write failure'); }
          : handle.writeFile.bind(handle),
        sync: phase === 'sync'
          ? async () => { throw new Error('injected report sync failure'); }
          : handle.sync.bind(handle),
        close: handle.close.bind(handle)
      };
    },
    async rename(source, destination) {
      if (phase === 'rename' && String(source).endsWith(temporarySuffix)) {
        throw new Error('injected report rename failure');
      }
      return fsPromises.rename(source, destination);
    },
    async readFile(filePath, ...args) {
      if (phase === 'reread' && String(filePath).endsWith(finalSuffix)) {
        throw new Error('injected report reread failure');
      }
      return fsPromises.readFile(filePath, ...args);
    }
  };
}

function mutatingReportWriter(mutate) {
  return async ({ value, validate }) => {
    const persisted = structuredClone(value);
    mutate(persisted);
    validate(persisted);
    return persisted;
  };
}

test('default dry-run reports exact paths and changes no byte or mtime', async () => {
  const fixture = await setup();
  try {
    const before = await snapshotTree(fixture.root);
    const report = await switchProductionData({
      mode: 'dry-run',
      dataRoot: fixture.dataRoot,
      candidate: fixture.candidate,
      activeProgram: fixture.activeProgram,
      candidateProgram: fixture.candidateProgram,
      externalBackupRoot: fixture.backupRoot,
      runId: 'RUN-DRY',
      now: fixedNow
    });
    assert.equal(report.mode, 'dry-run');
    assert.equal(report.applied, false);
    assert.deepEqual(report.candidate.summary, {
      revision: 1, devices: 26, channels: 529, requests: 0, records: 0, samples: 0,
      audits: 1, requestSourceRows: 0, formChangeJournal: 0, testers: 0, storageRecords: 0
    });
    assert.equal(report.candidate.integrity, 'ok');
    assert.deepEqual(await snapshotTree(fixture.root), before);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('empty candidate approval rejects terminal storage history before dry-run or apply writes', async () => {
  for (const mode of ['dry-run', 'apply']) {
    const fixture = await setup();
    try {
      const historyRoot = path.join(fixture.root, `terminal-storage-${mode}`);
      await mkdir(historyRoot);
      const state = stateFixture({ marker: `terminal-storage-${mode}` });
      state.storageRecords.push({
        id: 'STO-HISTORY',
        requestNo: 'REQ-REMOVED',
        sampleIds: ['REQ-REMOVED.001'],
        status: 'completed'
      });
      const candidate = await createSqlite(historyRoot, state);
      const before = await snapshotTree(fixture.root);

      await assert.rejects(
        () => switchProductionData({
          mode,
          dataRoot: fixture.dataRoot,
          candidate,
          externalBackupRoot: fixture.backupRoot,
          runId: `RUN-STORAGE-${mode.toUpperCase()}`,
          now: fixedNow
        }),
        error => error.code === 'CANDIDATE_SUMMARY_INVALID'
      );
      assert.deepEqual(await snapshotTree(fixture.root), before, mode);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  }
});

test('candidate count mismatch and active handle probe block before writes', async () => {
  const fixture = await setup();
  try {
    const invalidRoot = path.join(fixture.root, 'invalid');
    await mkdir(invalidRoot);
    const invalid = await createSqlite(invalidRoot, stateFixture({ approved: false, marker: 'invalid' }));
    const beforeInvalid = await snapshotTree(fixture.root);
    await assert.rejects(
      () => switchProductionData({
        mode: 'apply', dataRoot: fixture.dataRoot, candidate: invalid,
        externalBackupRoot: fixture.backupRoot, runId: 'RUN-INVALID', now: fixedNow
      }),
      error => error.code === 'CANDIDATE_SUMMARY_INVALID'
    );
    assert.deepEqual(await snapshotTree(fixture.root), beforeInvalid);

    const beforeHandle = await snapshotTree(fixture.root);
    await assert.rejects(
      () => switchProductionData({
        mode: 'apply', dataRoot: fixture.dataRoot, candidate: fixture.candidate,
        externalBackupRoot: fixture.backupRoot, runId: 'RUN-HANDLE', now: fixedNow,
        activePathProbe: async () => [fixture.activeDatabase]
      }),
      error => error.code === 'ACTIVE_PATH_BLOCKED'
    );
    assert.deepEqual(await snapshotTree(fixture.root), beforeHandle);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('default Windows probe detects an open active file handle in an isolated fixture', {
  skip: process.platform !== 'win32'
}, async () => {
  const fixture = await setup();
  let lockProcess;
  try {
    const before = await snapshotTree(fixture.root);
    const lockScript = [
      '$handle = [System.IO.File]::Open($env:BATTERY_SWITCH_LOCK_PATH, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::None)',
      "[Console]::Out.WriteLine('LOCKED')",
      '[Console]::Out.Flush()',
      '[Console]::In.ReadLine() | Out-Null',
      '$handle.Dispose()'
    ].join('; ');
    lockProcess = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', lockScript],
      {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        env: { ...process.env, BATTERY_SWITCH_LOCK_PATH: fixture.activeProgram }
      }
    );
    await new Promise((resolve, reject) => {
      const onExit = code => reject(new Error(`lock helper exited before ready: ${code}`));
      lockProcess.once('exit', onExit);
      lockProcess.stdout.once('data', () => {
        lockProcess.off('exit', onExit);
        resolve();
      });
    });
    await assert.rejects(
      () => switchProductionData({
        mode: 'dry-run', dataRoot: fixture.dataRoot, candidate: fixture.candidate,
        activeProgram: fixture.activeProgram, candidateProgram: fixture.candidateProgram,
        externalBackupRoot: fixture.backupRoot, runId: 'RUN-DEFAULT-HANDLE', now: fixedNow
      }),
      error => error.code === 'ACTIVE_PATH_BLOCKED' &&
        error.details?.blockers?.some(blocker => blocker.kind === 'file-handle')
    );
    lockProcess.stdin.write('\n');
    await new Promise(resolve => lockProcess.once('exit', resolve));
    lockProcess = null;
    assert.deepEqual(await snapshotTree(fixture.root), before);
  } finally {
    if (lockProcess && lockProcess.exitCode === null) {
      lockProcess.stdin.write('\n');
      await new Promise(resolve => lockProcess.once('exit', resolve));
    }
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('external backup failure blocks before staging or active replacement', async () => {
  const fixture = await setup();
  try {
    const activeHash = await sha256(fixture.activeDatabase);
    await assert.rejects(
      () => switchProductionData({
        mode: 'apply', dataRoot: fixture.dataRoot, candidate: fixture.candidate,
        activeProgram: fixture.activeProgram, candidateProgram: fixture.candidateProgram,
        externalBackupRoot: fixture.backupRoot, runId: 'RUN-BACKUP-FAIL', now: fixedNow,
        copyFileImpl: async () => { throw new Error('injected copy failure'); }
      }),
      error => error.code === 'EXTERNAL_BACKUP_FAILED'
    );
    assert.equal(await sha256(fixture.activeDatabase), activeHash);
    assert.equal(await readFile(fixture.activeProgram, 'utf8'), 'old-program');
    assert.equal((await inspectProductionRoot({ dataRoot: fixture.dataRoot })).archiveRuns.length, 0);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('swap failure restores exact active database and program bytes', async () => {
  const fixture = await setup();
  try {
    const databaseHash = await sha256(fixture.activeDatabase);
    const programHash = await sha256(fixture.activeProgram);
    let activeDatabaseMoves = 0;
    const { rename } = await import('node:fs/promises');
    await assert.rejects(
      () => switchProductionData({
        mode: 'apply', dataRoot: fixture.dataRoot, candidate: fixture.candidate,
        activeProgram: fixture.activeProgram, candidateProgram: fixture.candidateProgram,
        externalBackupRoot: fixture.backupRoot, runId: 'RUN-SWAP-FAIL', now: fixedNow,
        renameImpl: async (source, destination) => {
          if (destination === fixture.activeDatabase) {
            activeDatabaseMoves += 1;
            if (activeDatabaseMoves === 1) throw new Error('injected candidate swap failure');
          }
          return rename(source, destination);
        }
      }),
      error => error.code === 'SWAP_FAILED'
    );
    assert.equal(await sha256(fixture.activeDatabase), databaseHash);
    assert.equal(await sha256(fixture.activeProgram), programHash);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('successful apply and paired rollback retain both program/data generations', async () => {
  const fixture = await setup();
  try {
    const oldDatabaseHash = await sha256(fixture.activeDatabase);
    const candidateHash = await sha256(fixture.candidate);
    const report = await switchProductionData({
      mode: 'apply', dataRoot: fixture.dataRoot, candidate: fixture.candidate,
      activeProgram: fixture.activeProgram, candidateProgram: fixture.candidateProgram,
      externalBackupRoot: fixture.backupRoot, runId: 'RUN-SUCCESS', now: fixedNow
    });
    assert.equal(report.applied, true);
    assert.equal(report.completedPhases.at(-1), 'verify-active');
    assert.equal(report.candidate.sha256, candidateHash);
    assert.equal(await sha256(fixture.activeDatabase), report.active.database.sha256);
    assert.equal(await readFile(fixture.activeProgram, 'utf8'), 'new-program');
    assert.equal(await sha256(report.archive.database), oldDatabaseHash);
    assert.equal(await readFile(report.archive.program, 'utf8'), 'old-program');
    assert.equal(await sha256(report.externalBackup.database), oldDatabaseHash);
    const persistedSwitchReport = JSON.parse(await readFile(report.reportFile, 'utf8'));
    const returnedSwitchReport = { ...report };
    delete returnedSwitchReport.reportFile;
    assert.deepEqual(returnedSwitchReport, persistedSwitchReport);

    const rolledBack = await rollbackProductionData({
      mode: 'apply',
      dataRoot: fixture.dataRoot,
      runId: 'RUN-SUCCESS',
      activeProgram: fixture.activeProgram,
      externalBackupRoot: fixture.backupRoot,
      now: '2026-08-20T17:30:00-07:00'
    });
    assert.equal(rolledBack.rolledBack, true);
    assert.equal(await sha256(fixture.activeDatabase), oldDatabaseHash);
    assert.equal(await readFile(fixture.activeProgram, 'utf8'), 'old-program');
    assert.equal(await sha256(rolledBack.replaced.database.path), report.active.database.sha256);
    assert.equal(rolledBack.replaced.database.sha256, report.active.database.sha256);
    assert.equal(await readFile(rolledBack.replaced.program.path, 'utf8'), 'new-program');
    const persistedRollbackReport = JSON.parse(await readFile(rolledBack.rollbackReportFile, 'utf8'));
    const returnedRollbackReport = { ...rolledBack };
    delete returnedRollbackReport.rollbackReportFile;
    assert.deepEqual(returnedRollbackReport, persistedRollbackReport);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('rollback defaults to read-only dry-run and apply is explicit', async () => {
  const fixture = await setupAppliedSwitch('RUN-ROLLBACK-DRY');
  try {
    const before = await snapshotTree(fixture.root);
    const preview = await rollbackProductionData({
      dataRoot: fixture.dataRoot,
      runId: fixture.runId,
      activeProgram: fixture.activeProgram,
      externalBackupRoot: fixture.backupRoot,
      now: '2026-08-20T17:30:00-07:00'
    });
    assert.equal(preview.mode, 'dry-run');
    assert.equal(preview.applied, false);
    assert.equal(preview.rolledBack, false);
    assert.equal(preview.switchReportHash, await sha256(fixture.switchReport.reportFile));
    assert.deepEqual(await snapshotTree(fixture.root), before);

    const applied = await rollbackProductionData({
      mode: 'apply',
      dataRoot: fixture.dataRoot,
      runId: fixture.runId,
      activeProgram: fixture.activeProgram,
      externalBackupRoot: fixture.backupRoot,
      now: '2026-08-20T17:31:00-07:00'
    });
    assert.equal(applied.mode, 'apply');
    assert.equal(applied.applied, true);
    assert.equal(applied.rolledBack, true);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('rollback lineage accepts legitimate SQLite saves and preserves the written generation before replacement', async () => {
  const fixture = await setupAppliedSwitch('RUN-ROLLBACK-AFTER-WRITE');
  try {
    const store = await createLegacySqliteStore({
      dataRoot: fixture.dataRoot,
      clock: () => '2026-08-20T17:15:00-07:00'
    });
    let saved;
    try {
      const loaded = await store.load();
      assert.equal(loaded.ok, true);
      loaded.state.username = 'post-switch-operator';
      saved = await store.save({
        expectedRevision: loaded.state.revision,
        state: loaded.state,
        journalEntries: [{
          id: 'FORM-AFTER-SWITCH', requestId: '', action: 'login',
          time: '2026-08-20T17:15:00-07:00', user: 'post-switch-operator', level: 'normal'
        }]
      });
      assert.equal(saved.ok, true);
    } finally {
      store.close();
    }
    const writtenHash = await sha256(fixture.activeDatabase);
    assert.notEqual(writtenHash, fixture.switchReport.active.database.sha256);

    const beforeDryRun = await snapshotTree(fixture.root);
    const preview = await rollbackProductionData({
      dataRoot: fixture.dataRoot,
      runId: fixture.runId,
      activeProgram: fixture.activeProgram,
      externalBackupRoot: fixture.backupRoot,
      now: '2026-08-20T17:20:00-07:00'
    });
    assert.equal(preview.mode, 'dry-run');
    assert.equal(preview.production.database.sha256, writtenHash);
    assert.deepEqual(await snapshotTree(fixture.root), beforeDryRun);

    const rolledBack = await rollbackProductionData({
      mode: 'apply',
      dataRoot: fixture.dataRoot,
      runId: fixture.runId,
      activeProgram: fixture.activeProgram,
      externalBackupRoot: fixture.backupRoot,
      now: '2026-08-20T17:25:00-07:00'
    });
    assert.equal(rolledBack.replaced.database.sha256, writtenHash);
    assert.equal(path.basename(rolledBack.replaced.database.path), 'after-switch.sqlite');
    assert.deepEqual(readSqliteState(rolledBack.replaced.database.path), {
      revision: saved.state.revision,
      state: {
        ...JSON.parse(JSON.stringify(saved.state)),
        formChangeJournal: []
      },
      journalIds: ['FORM-AFTER-SWITCH']
    });
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('rollback rejects an active SQLite carrying another valid switch lineage without writing', async () => {
  const fixture = await setupAppliedSwitch('RUN-LINEAGE-TARGET');
  const foreign = await setupAppliedSwitch('RUN-LINEAGE-FOREIGN');
  try {
    await copyFile(foreign.activeDatabase, fixture.activeDatabase);
    const before = await snapshotTree(fixture.root);
    for (const mode of ['dry-run', 'apply']) {
      await assert.rejects(
        () => rollbackProductionData({
          mode,
          dataRoot: fixture.dataRoot,
          runId: fixture.runId,
          activeProgram: fixture.activeProgram,
          externalBackupRoot: fixture.backupRoot
        }),
        error => error.code === 'ACTIVE_GENERATION_MISMATCH'
      );
      assert.deepEqual(await snapshotTree(fixture.root), before, mode);
    }
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
    await rm(foreign.root, { recursive: true, force: true });
  }
});

test('rollback rejects a lineage sidecar whose bytes no longer match the switch report', async () => {
  const fixture = await setupAppliedSwitch('RUN-LINEAGE-SIDECAR-TAMPER');
  try {
    await writeFile(fixture.switchReport.generationLineage.path, '{}\n', 'utf8');
    const before = await snapshotTree(fixture.root);
    await assert.rejects(
      () => rollbackProductionData({
        dataRoot: fixture.dataRoot,
        runId: fixture.runId,
        activeProgram: fixture.activeProgram,
        externalBackupRoot: fixture.backupRoot
      }),
      error => error.code === 'GENERATION_LINEAGE_INVALID'
    );
    assert.deepEqual(await snapshotTree(fixture.root), before);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('legacy switch reports retain exact-hash rollback compatibility without accepting later SQLite writes', async () => {
  const fixture = await setupAppliedSwitch('RUN-LEGACY-REPORT');
  try {
    await copyFile(fixture.candidate, fixture.activeDatabase);
    const active = (await inspectProductionRoot({
      dataRoot: fixture.dataRoot,
      activeProgram: fixture.activeProgram
    })).database;
    const legacyReport = JSON.parse(await readFile(fixture.switchReport.reportFile, 'utf8'));
    delete legacyReport.reportSchema;
    delete legacyReport.generationLineage;
    legacyReport.active.database = active;
    await unlink(fixture.switchReport.generationLineage.path);
    await writeFile(fixture.switchReport.reportFile, `${JSON.stringify(legacyReport, null, 2)}\n`, 'utf8');

    const preview = await rollbackProductionData({
      dataRoot: fixture.dataRoot,
      runId: fixture.runId,
      activeProgram: fixture.activeProgram,
      externalBackupRoot: fixture.backupRoot
    });
    assert.equal(preview.mode, 'dry-run');

    const store = await createLegacySqliteStore({ dataRoot: fixture.dataRoot, clock: () => fixedNow });
    try {
      const loaded = await store.load();
      loaded.state.username = 'legacy-report-write';
      assert.equal((await store.save({
        expectedRevision: loaded.state.revision,
        state: loaded.state,
        journalEntries: []
      })).ok, true);
    } finally {
      store.close();
    }
    await assert.rejects(
      () => rollbackProductionData({
        dataRoot: fixture.dataRoot,
        runId: fixture.runId,
        activeProgram: fixture.activeProgram,
        externalBackupRoot: fixture.backupRoot
      }),
      error => error.code === 'ACTIVE_GENERATION_MISMATCH'
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('rollback validates archive hashes and active generation before staging', async () => {
  for (const target of ['archive-database', 'archive-program', 'active-database', 'active-program']) {
    const fixture = await setupAppliedSwitch(`RUN-BIND-${target.toUpperCase()}`);
    try {
      const targetPath = {
        'archive-database': fixture.switchReport.archive.database,
        'archive-program': fixture.switchReport.archive.program,
        'active-database': fixture.activeDatabase,
        'active-program': fixture.activeProgram
      }[target];
      if (target.endsWith('database')) {
        const otherRoot = path.join(fixture.root, `other-${target}`);
        await mkdir(otherRoot);
        const other = await createSqlite(otherRoot, stateFixture({ approved: true, marker: target }));
        await copyFile(other, targetPath);
      } else {
        await writeFile(targetPath, `tampered-${target}`, 'utf8');
      }
      const before = await snapshotTree(fixture.root);
      const expectedCode = target === 'archive-database'
        ? 'ARCHIVE_DATABASE_HASH_MISMATCH'
        : target === 'archive-program'
          ? 'ARCHIVE_PROGRAM_HASH_MISMATCH'
          : 'ACTIVE_GENERATION_MISMATCH';
      await assert.rejects(
        () => rollbackProductionData({
          mode: 'apply', dataRoot: fixture.dataRoot, runId: fixture.runId,
          activeProgram: fixture.activeProgram, externalBackupRoot: fixture.backupRoot
        }),
        error => error.code === expectedCode
      );
      assert.deepEqual(await snapshotTree(fixture.root), before);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  }
});

test('rollback fail-closes on switch report identity and path tampering', async () => {
  const mutations = [
    ['runId', report => { report.runId = 'RUN-OTHER'; }],
    ['dataRoot', report => { report.dataRoot = path.join(report.dataRoot, 'other'); }],
    ['applied', report => { report.applied = false; }],
    ['completedPhases', report => { report.completedPhases = ['inspect']; }],
    ['archive.database', (report, fixture) => { report.archive.database = fixture.candidate; }],
    ['archive.program', (report, fixture) => { report.archive.program = fixture.candidateProgram; }]
  ];
  for (const [label, mutate] of mutations) {
    const fixture = await setupAppliedSwitch(`RUN-REPORT-${label.replace('.', '-').toUpperCase()}`);
    try {
      const report = JSON.parse(await readFile(fixture.switchReport.reportFile, 'utf8'));
      mutate(report, fixture);
      await writeFile(fixture.switchReport.reportFile, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
      const before = await snapshotTree(fixture.root);
      await assert.rejects(
        () => rollbackProductionData({
          mode: 'apply', dataRoot: fixture.dataRoot, runId: fixture.runId,
          activeProgram: fixture.activeProgram, externalBackupRoot: fixture.backupRoot
        }),
        error => error.code === 'SWITCH_REPORT_INVALID'
      );
      assert.deepEqual(await snapshotTree(fixture.root), before);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  }
});

test('rollback requires the operator backup root and binds it to the switch report before staging', async () => {
  const fixture = await setupAppliedSwitch('RUN-EXTERNAL-ROOT-BIND');
  try {
    const before = await snapshotTree(fixture.root);
    for (const [externalBackupRoot, expectedCode] of [
      [undefined, 'EXTERNAL_BACKUP_ROOT_REQUIRED'],
      [path.join(fixture.root, 'wrong-external-root'), 'EXTERNAL_BACKUP_ROOT_MISMATCH']
    ]) {
      let copyCalls = 0;
      let renameCalls = 0;
      await assert.rejects(
        () => rollbackProductionData({
          mode: 'apply', dataRoot: fixture.dataRoot, runId: fixture.runId,
          activeProgram: fixture.activeProgram, externalBackupRoot,
          copyFileImpl: async () => { copyCalls += 1; },
          renameImpl: async () => { renameCalls += 1; }
        }),
        error => error.code === expectedCode
      );
      assert.equal(copyCalls, 0);
      assert.equal(renameCalls, 0);
      assert.deepEqual(await snapshotTree(fixture.root), before);
    }
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('switch rejects physical backup containment through backup or data-root directory links', async () => {
  for (const linkedSide of ['backup-root', 'data-root']) {
    for (const mode of ['dry-run', 'apply']) {
      const fixture = await setup();
      try {
        const alias = path.join(fixture.root, `${linkedSide}-${mode}-alias`);
        let dataRoot;
        let externalBackupRoot;
        if (linkedSide === 'backup-root') {
          await createDirectoryLink(fixture.dataRoot, alias);
          dataRoot = fixture.dataRoot;
          externalBackupRoot = path.join(alias, 'nested-backups');
        } else {
          await createDirectoryLink(fixture.dataRoot, alias);
          dataRoot = alias;
          externalBackupRoot = path.join(fixture.dataRoot, 'nested-backups');
        }
        const before = await snapshotTree(fixture.dataRoot);
        await assert.rejects(
          () => switchProductionData({
            mode, dataRoot, candidate: fixture.candidate,
            externalBackupRoot, runId: `RUN-PHYSICAL-${mode.toUpperCase()}-${linkedSide.toUpperCase()}`,
            now: fixedNow
          }),
          error => error.code === 'EXTERNAL_BACKUP_ROOT_INVALID',
          `${linkedSide}:${mode}`
        );
        assert.deepEqual(await snapshotTree(fixture.dataRoot), before, `${linkedSide}:${mode}`);
      } finally {
        await rm(fixture.root, { recursive: true, force: true });
      }
    }
  }
});

test('switch rechecks physical backup containment after directory creation and before copy', async () => {
  const fixture = await setup();
  const backupRoot = path.join(fixture.root, 'late-reparse-backup');
  const externalDirectory = path.join(backupRoot, 'RUN-LATE-REPARSE');
  let copyCalls = 0;
  let redirected = false;
  const fsApi = {
    ...fsPromises,
    async mkdir(target, options) {
      const result = await fsPromises.mkdir(target, options);
      if (path.resolve(target) === path.resolve(externalDirectory)) {
        await fsPromises.rm(backupRoot, { recursive: true, force: true });
        await createDirectoryLink(fixture.dataRoot, backupRoot);
        redirected = true;
      }
      return result;
    }
  };
  try {
    await assert.rejects(
      () => switchProductionData({
        mode: 'apply', dataRoot: fixture.dataRoot, candidate: fixture.candidate,
        externalBackupRoot: backupRoot, runId: 'RUN-LATE-REPARSE', now: fixedNow,
        fsApi,
        copyFileImpl: async () => {
          copyCalls += 1;
          throw new Error('copy must not start after physical boundary changes');
        }
      }),
      error => error.code === 'EXTERNAL_BACKUP_ROOT_INVALID'
    );
    assert.equal(redirected, true);
    assert.equal(copyCalls, 0);
  } finally {
    if (redirected) await unlink(backupRoot).catch(() => undefined);
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('rollback rejects a previously approved backup link redirected into the data root', async () => {
  const fixture = await setup();
  const backupTarget = path.join(fixture.root, 'rollback-backup-target');
  const backupAlias = path.join(fixture.root, 'rollback-backup-alias');
  await mkdir(backupTarget);
  await createDirectoryLink(backupTarget, backupAlias);
  let aliasExists = true;
  try {
    const switchReport = await switchProductionData({
      mode: 'apply', dataRoot: fixture.dataRoot, candidate: fixture.candidate,
      externalBackupRoot: backupAlias, runId: 'RUN-ROLLBACK-REPARSE', now: fixedNow
    });
    await unlink(backupAlias);
    aliasExists = false;
    await createDirectoryLink(fixture.dataRoot, backupAlias);
    aliasExists = true;
    const before = await snapshotTree(fixture.dataRoot);

    for (const mode of ['dry-run', 'apply']) {
      await assert.rejects(
        () => rollbackProductionData({
          mode, dataRoot: fixture.dataRoot, runId: switchReport.runId,
          externalBackupRoot: backupAlias
        }),
        error => error.code === 'EXTERNAL_BACKUP_ROOT_INVALID',
        mode
      );
      assert.deepEqual(await snapshotTree(fixture.dataRoot), before, mode);
    }
  } finally {
    if (aliasExists) await unlink(backupAlias).catch(() => undefined);
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('rollback rejects external backup path escapes in the switch report before staging', async () => {
  const mutations = [
    ['root', (report, fixture) => { report.externalBackupRoot = fixture.candidateRoot; }, 'EXTERNAL_BACKUP_ROOT_MISMATCH'],
    ['directory', (report, fixture) => { report.externalBackup.directory = fixture.candidateRoot; }],
    ['database', (report, fixture) => { report.externalBackup.database = fixture.candidate; }],
    ['database-inspection', (report, fixture) => { report.externalBackup.databaseInspection.path = fixture.candidate; }],
    ['program', (report, fixture) => { report.externalBackup.program = fixture.candidateProgram; }],
    ['program-inspection', (report, fixture) => { report.externalBackup.programInspection.path = fixture.candidateProgram; }]
  ];
  for (const [label, mutate, expectedCode = 'SWITCH_REPORT_INVALID'] of mutations) {
    const fixture = await setupAppliedSwitch(`RUN-EXTERNAL-PATH-${label.toUpperCase()}`);
    try {
      const report = JSON.parse(await readFile(fixture.switchReport.reportFile, 'utf8'));
      mutate(report, fixture);
      await writeFile(fixture.switchReport.reportFile, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
      const before = await snapshotTree(fixture.root);
      let copyCalls = 0;
      let renameCalls = 0;
      await assert.rejects(
        () => rollbackProductionData({
          mode: 'apply', dataRoot: fixture.dataRoot, runId: fixture.runId,
          activeProgram: fixture.activeProgram, externalBackupRoot: fixture.backupRoot,
          copyFileImpl: async () => { copyCalls += 1; },
          renameImpl: async () => { renameCalls += 1; }
        }),
        error => error.code === expectedCode
      );
      assert.equal(copyCalls, 0);
      assert.equal(renameCalls, 0);
      assert.deepEqual(await snapshotTree(fixture.root), before);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  }
});

test('rollback validates external backup existence, size, hash, and SQLite integrity in dry-run and apply', async () => {
  const cases = [
    ['database-missing', async fixture => rm(fixture.switchReport.externalBackup.database), 'EXTERNAL_BACKUP_DATABASE_MISSING'],
    ['program-missing', async fixture => rm(fixture.switchReport.externalBackup.program), 'EXTERNAL_BACKUP_PROGRAM_MISSING'],
    ['database-hash', async fixture => copyFile(fixture.candidate, fixture.switchReport.externalBackup.database), 'EXTERNAL_BACKUP_DATABASE_MISMATCH'],
    ['program-hash', async fixture => copyFile(fixture.candidateProgram, fixture.switchReport.externalBackup.program), 'EXTERNAL_BACKUP_PROGRAM_MISMATCH'],
    ['program-size', async fixture => writeFile(fixture.switchReport.externalBackup.program, 'old-program-expanded', 'utf8'), 'EXTERNAL_BACKUP_PROGRAM_MISMATCH'],
    ['database-integrity', async fixture => writeFile(fixture.switchReport.externalBackup.database, Buffer.alloc(4096, 0x5a)), 'EXTERNAL_BACKUP_DATABASE_INVALID']
  ];
  for (const [label, mutate, expectedCode] of cases) {
    const fixture = await setupAppliedSwitch(`RUN-EXTERNAL-${label.toUpperCase()}`);
    try {
      await mutate(fixture);
      const before = await snapshotTree(fixture.root);
      for (const mode of ['dry-run', 'apply']) {
        let copyCalls = 0;
        let renameCalls = 0;
        await assert.rejects(
          () => rollbackProductionData({
            mode, dataRoot: fixture.dataRoot, runId: fixture.runId,
            activeProgram: fixture.activeProgram, externalBackupRoot: fixture.backupRoot,
            copyFileImpl: async () => { copyCalls += 1; },
            renameImpl: async () => { renameCalls += 1; }
          }),
          error => error.code === expectedCode
        );
        assert.equal(copyCalls, 0);
        assert.equal(renameCalls, 0);
        assert.deepEqual(await snapshotTree(fixture.root), before);
      }
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  }
});

test('rollback apply performs two activity preflights and cleans staging on the second blocker', async () => {
  const fixture = await setupAppliedSwitch('RUN-ROLLBACK-PREFLIGHT');
  try {
    const before = await snapshotTree(fixture.root);
    let calls = 0;
    await assert.rejects(
      () => rollbackProductionData({
        mode: 'apply', dataRoot: fixture.dataRoot, runId: fixture.runId,
        activeProgram: fixture.activeProgram, externalBackupRoot: fixture.backupRoot,
        activePathProbe: async () => (++calls === 1 ? [] : [{ kind: 'process', pid: 4242 }])
      }),
      error => error.code === 'ACTIVE_PATH_BLOCKED'
    );
    assert.equal(calls, 2);
    const after = await snapshotTree(fixture.root);
    for (const [key, value] of Object.entries(before)) {
      if (!key.endsWith('/')) assert.deepEqual(after[key], value, key);
    }
    assert.deepEqual(Object.keys(after), Object.keys(before));
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('rollback rejects every SQLite sidecar in dry-run and apply without writes', async () => {
  for (const suffix of ['-journal', '-wal', '-shm']) {
    const fixture = await setupAppliedSwitch(`RUN-SIDECAR-${suffix.slice(1).toUpperCase()}`);
    try {
      await writeFile(`${fixture.activeDatabase}${suffix}`, suffix, 'utf8');
      for (const mode of ['dry-run', 'apply']) {
        const before = await snapshotTree(fixture.root);
        await assert.rejects(
          () => rollbackProductionData({
            mode, dataRoot: fixture.dataRoot, runId: fixture.runId,
            activeProgram: fixture.activeProgram, externalBackupRoot: fixture.backupRoot
          }),
          error => error.code === 'ACTIVE_PATH_BLOCKED'
        );
        assert.deepEqual(await snapshotTree(fixture.root), before);
      }
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  }
});

test('switch performs a second preflight immediately before swap', async () => {
  const fixture = await setup();
  try {
    const activeHash = await sha256(fixture.activeDatabase);
    let calls = 0;
    await assert.rejects(
      () => switchProductionData({
        mode: 'apply', dataRoot: fixture.dataRoot, candidate: fixture.candidate,
        activeProgram: fixture.activeProgram, candidateProgram: fixture.candidateProgram,
        externalBackupRoot: fixture.backupRoot, runId: 'RUN-SWITCH-PREFLIGHT', now: fixedNow,
        activePathProbe: async () => (++calls === 1 ? [] : [{ kind: 'handle', path: fixture.activeDatabase }])
      }),
      error => error.code === 'ACTIVE_PATH_BLOCKED'
    );
    assert.equal(calls, 2);
    assert.equal(await sha256(fixture.activeDatabase), activeHash);
    assert.equal(await readFile(fixture.activeProgram, 'utf8'), 'old-program');
    assert.equal((await inspectProductionRoot({ dataRoot: fixture.dataRoot })).archiveRuns.length, 0);
    assert.equal((await readdir(fixture.dataRoot)).some(name => name.startsWith('.switch-')), false);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('switch and rollback staging collisions preserve sentinel bytes', async () => {
  const switchFixture = await setup();
  try {
    const sentinel = path.join(switchFixture.dataRoot, '.switch-RUN-COLLIDE.sqlite');
    await writeFile(sentinel, 'do-not-overwrite', 'utf8');
    const before = await snapshotTree(switchFixture.root);
    await assert.rejects(
      () => switchProductionData({
        mode: 'apply', dataRoot: switchFixture.dataRoot, candidate: switchFixture.candidate,
        externalBackupRoot: switchFixture.backupRoot, runId: 'RUN-COLLIDE'
      }),
      error => error.code === 'SWITCH_STAGING_EXISTS'
    );
    assert.deepEqual(await snapshotTree(switchFixture.root), before);
  } finally {
    await rm(switchFixture.root, { recursive: true, force: true });
  }

  const rollbackFixture = await setupAppliedSwitch('RUN-ROLLBACK-COLLIDE');
  try {
    const sentinel = path.join(rollbackFixture.dataRoot, '.rollback-RUN-ROLLBACK-COLLIDE.sqlite');
    await writeFile(sentinel, 'do-not-overwrite', 'utf8');
    const before = await snapshotTree(rollbackFixture.root);
    await assert.rejects(
      () => rollbackProductionData({
        mode: 'apply', dataRoot: rollbackFixture.dataRoot, runId: rollbackFixture.runId,
        activeProgram: rollbackFixture.activeProgram, externalBackupRoot: rollbackFixture.backupRoot
      }),
      error => error.code === 'ROLLBACK_STAGING_EXISTS'
    );
    assert.deepEqual(await snapshotTree(rollbackFixture.root), before);
  } finally {
    await rm(rollbackFixture.root, { recursive: true, force: true });
  }

  const switchProgramFixture = await setup();
  try {
    const sentinel = path.join(
      path.dirname(switchProgramFixture.activeProgram),
      `.switch-RUN-COLLIDE-PROGRAM-${path.basename(switchProgramFixture.activeProgram)}`
    );
    await writeFile(sentinel, 'program-sentinel', 'utf8');
    const before = await snapshotTree(switchProgramFixture.root);
    await assert.rejects(
      () => switchProductionData({
        mode: 'apply', dataRoot: switchProgramFixture.dataRoot, candidate: switchProgramFixture.candidate,
        activeProgram: switchProgramFixture.activeProgram,
        candidateProgram: switchProgramFixture.candidateProgram,
        externalBackupRoot: switchProgramFixture.backupRoot,
        runId: 'RUN-COLLIDE-PROGRAM', activePathProbe: async () => []
      }),
      error => error.code === 'SWITCH_STAGING_EXISTS'
    );
    assert.deepEqual(await snapshotTree(switchProgramFixture.root), before);
  } finally {
    await rm(switchProgramFixture.root, { recursive: true, force: true });
  }

  const rollbackProgramFixture = await setupAppliedSwitch('RUN-ROLLBACK-COLLIDE-PROGRAM');
  try {
    const sentinel = path.join(
      path.dirname(rollbackProgramFixture.activeProgram),
      `.rollback-${rollbackProgramFixture.runId}-${path.basename(rollbackProgramFixture.activeProgram)}`
    );
    await writeFile(sentinel, 'program-sentinel', 'utf8');
    const before = await snapshotTree(rollbackProgramFixture.root);
    await assert.rejects(
      () => rollbackProductionData({
        mode: 'apply', dataRoot: rollbackProgramFixture.dataRoot, runId: rollbackProgramFixture.runId,
        activeProgram: rollbackProgramFixture.activeProgram, externalBackupRoot: rollbackProgramFixture.backupRoot,
        activePathProbe: async () => []
      }),
      error => error.code === 'ROLLBACK_STAGING_EXISTS'
    );
    assert.deepEqual(await snapshotTree(rollbackProgramFixture.root), before);
  } finally {
    await rm(rollbackProgramFixture.root, { recursive: true, force: true });
  }
});

test('switch report failure restores old generation and leaves no final report', async () => {
  const fixture = await setup();
  try {
    const oldDatabaseHash = await sha256(fixture.activeDatabase);
    const oldProgramHash = await sha256(fixture.activeProgram);
    await assert.rejects(
      () => switchProductionData({
        mode: 'apply', dataRoot: fixture.dataRoot, candidate: fixture.candidate,
        activeProgram: fixture.activeProgram, candidateProgram: fixture.candidateProgram,
        externalBackupRoot: fixture.backupRoot, runId: 'RUN-REPORT-FAIL', now: fixedNow,
        writeReportAtomic: async () => { throw new Error('injected atomic report failure'); }
      }),
      error => error.code === 'REPORT_WRITE_FAILED'
    );
    assert.equal(await sha256(fixture.activeDatabase), oldDatabaseHash);
    assert.equal(await sha256(fixture.activeProgram), oldProgramHash);
    assert.equal((await inspectProductionRoot({ dataRoot: fixture.dataRoot })).archiveRuns.length, 0);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('switch atomic reread binds every external backup path, size, and hash', async () => {
  const mutations = [
    ['root', (report, fixture) => { report.externalBackupRoot = fixture.candidateRoot; }],
    ['directory', (report, fixture) => { report.externalBackup.directory = fixture.candidateRoot; }],
    ['database-path', (report, fixture) => { report.externalBackup.database = fixture.candidate; }],
    ['database-inspection-path', (report, fixture) => { report.externalBackup.databaseInspection.path = fixture.candidate; }],
    ['database-size', report => { report.externalBackup.databaseInspection.size += 1; }],
    ['database-hash', report => { report.externalBackup.databaseInspection.sha256 = '0'.repeat(64); }],
    ['program-path', (report, fixture) => { report.externalBackup.program = fixture.candidateProgram; }],
    ['program-inspection-path', (report, fixture) => { report.externalBackup.programInspection.path = fixture.candidateProgram; }],
    ['program-size', report => { report.externalBackup.programInspection.size += 1; }],
    ['program-hash', report => { report.externalBackup.programInspection.sha256 = '0'.repeat(64); }]
  ];

  for (const [name, mutate] of mutations) {
    const fixture = await setup();
    try {
      const oldDatabaseHash = await sha256(fixture.activeDatabase);
      const oldProgramHash = await sha256(fixture.activeProgram);
      await assert.rejects(
        () => switchProductionData({
          mode: 'apply', dataRoot: fixture.dataRoot, candidate: fixture.candidate,
          activeProgram: fixture.activeProgram, candidateProgram: fixture.candidateProgram,
          externalBackupRoot: fixture.backupRoot, runId: `RUN-REPORT-${name.toUpperCase()}`,
          now: fixedNow, writeReportAtomic: mutatingReportWriter(report => mutate(report, fixture))
        }),
        error => error.code === 'REPORT_WRITE_FAILED',
        name
      );
      assert.equal(await sha256(fixture.activeDatabase), oldDatabaseHash, name);
      assert.equal(await sha256(fixture.activeProgram), oldProgramHash, name);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  }
});

test('rollback report failure restores switched generation without deleting either generation', async () => {
  const fixture = await setupAppliedSwitch('RUN-ROLLBACK-REPORT-FAIL');
  try {
    await assert.rejects(
      () => rollbackProductionData({
        mode: 'apply', dataRoot: fixture.dataRoot, runId: fixture.runId,
        activeProgram: fixture.activeProgram, externalBackupRoot: fixture.backupRoot,
        writeReportAtomic: async () => { throw new Error('injected atomic report failure'); }
      }),
      error => error.code === 'ROLLBACK_FAILED'
    );
    assert.equal(await sha256(fixture.activeDatabase), fixture.candidateHash);
    assert.equal(await sha256(fixture.activeProgram), fixture.candidateProgramHash);
    assert.equal(await sha256(fixture.switchReport.archive.database), fixture.oldDatabaseHash);
    assert.equal(await sha256(fixture.switchReport.archive.program), fixture.oldProgramHash);
    await assert.rejects(stat(fixture.switchReport.archive.directory + path.sep + 'rollback-report.json'), { code: 'ENOENT' });
    const preview = await rollbackProductionData({
      dataRoot: fixture.dataRoot, runId: fixture.runId, activeProgram: fixture.activeProgram,
      externalBackupRoot: fixture.backupRoot
    });
    assert.equal(preview.mode, 'dry-run');
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('rollback atomic reread binds switch hash, phases, and active/replaced generations', async () => {
  const mutations = [
    ['switch-report-hash', report => { report.switchReportHash = '0'.repeat(64); }],
    ['completed-phases', report => { report.completedPhases = ['inspect-report']; }],
    ['active-database-size', report => { report.active.database.size += 1; }],
    ['active-database-hash', report => { report.active.database.sha256 = '0'.repeat(64); }],
    ['active-program-size', report => { report.active.program.size += 1; }],
    ['active-program-hash', report => { report.active.program.sha256 = '0'.repeat(64); }],
    ['replaced-database-path', (report, fixture) => {
      if (typeof report.replaced.database === 'string') report.replaced.database = fixture.candidate;
      else report.replaced.database.path = fixture.candidate;
    }],
    ['replaced-database-hash', report => {
      report.replaced.database = typeof report.replaced.database === 'string'
        ? { path: report.replaced.database, size: 0, sha256: '0'.repeat(64) }
        : { ...report.replaced.database, sha256: '0'.repeat(64) };
    }],
    ['replaced-program-path', (report, fixture) => {
      if (typeof report.replaced.program === 'string') report.replaced.program = fixture.candidateProgram;
      else report.replaced.program.path = fixture.candidateProgram;
    }],
    ['replaced-program-hash', report => {
      report.replaced.program = typeof report.replaced.program === 'string'
        ? { path: report.replaced.program, size: 0, sha256: '0'.repeat(64) }
        : { ...report.replaced.program, sha256: '0'.repeat(64) };
    }]
  ];

  for (const [name, mutate] of mutations) {
    const fixture = await setupAppliedSwitch(`RUN-ROLLBACK-BIND-${name.toUpperCase()}`);
    try {
      await assert.rejects(
        () => rollbackProductionData({
          mode: 'apply', dataRoot: fixture.dataRoot, runId: fixture.runId,
          activeProgram: fixture.activeProgram, externalBackupRoot: fixture.backupRoot,
          writeReportAtomic: mutatingReportWriter(report => mutate(report, fixture))
        }),
        error => error.code === 'ROLLBACK_FAILED',
        name
      );
      assert.equal(await sha256(fixture.activeDatabase), fixture.candidateHash, name);
      assert.equal(await sha256(fixture.activeProgram), fixture.candidateProgramHash, name);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  }
});

test('every switch atomic report failure phase restores the old generation', async () => {
  for (const phase of ['write', 'sync', 'rename', 'reread']) {
    const fixture = await setup();
    try {
      const oldDatabaseHash = await sha256(fixture.activeDatabase);
      const oldProgramHash = await sha256(fixture.activeProgram);
      await assert.rejects(
        () => switchProductionData({
          mode: 'apply', dataRoot: fixture.dataRoot, candidate: fixture.candidate,
          activeProgram: fixture.activeProgram, candidateProgram: fixture.candidateProgram,
          externalBackupRoot: fixture.backupRoot, runId: `RUN-ATOMIC-${phase.toUpperCase()}`,
          now: fixedNow, fsApi: reportFailureFs('switch-report.json', phase)
        }),
        error => error.code === 'REPORT_WRITE_FAILED'
      );
      assert.equal(await sha256(fixture.activeDatabase), oldDatabaseHash, phase);
      assert.equal(await sha256(fixture.activeProgram), oldProgramHash, phase);
      assert.equal((await inspectProductionRoot({ dataRoot: fixture.dataRoot })).archiveRuns.length, 0, phase);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  }
});

test('every rollback atomic report failure phase restores the switched generation', async () => {
  for (const phase of ['write', 'sync', 'rename', 'reread']) {
    const fixture = await setupAppliedSwitch(`RUN-ROLLBACK-ATOMIC-${phase.toUpperCase()}`);
    try {
      await assert.rejects(
        () => rollbackProductionData({
          mode: 'apply', dataRoot: fixture.dataRoot, runId: fixture.runId,
          activeProgram: fixture.activeProgram, externalBackupRoot: fixture.backupRoot,
          fsApi: reportFailureFs('rollback-report.json', phase)
        }),
        error => error.code === 'ROLLBACK_FAILED'
      );
      assert.equal(await sha256(fixture.activeDatabase), fixture.candidateHash, phase);
      assert.equal(await sha256(fixture.activeProgram), fixture.candidateProgramHash, phase);
      await assert.rejects(
        stat(path.join(fixture.switchReport.archive.directory, 'rollback-report.json')),
        { code: 'ENOENT' }
      );
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  }
});

test('rollback recovery failure preserves every generation at explicit recovery paths', async () => {
  const fixture = await setupAppliedSwitch('RUN-ROLLBACK-RECOVERY-FAIL');
  try {
    let activeProgramDestinations = 0;
    await assert.rejects(
      () => rollbackProductionData({
        mode: 'apply', dataRoot: fixture.dataRoot, runId: fixture.runId,
        activeProgram: fixture.activeProgram, externalBackupRoot: fixture.backupRoot,
        writeReportAtomic: async () => { throw new Error('injected report failure'); },
        renameImpl: async (source, destination) => {
          if (destination === fixture.activeProgram && ++activeProgramDestinations === 2) {
            throw new Error('injected recovery rename failure');
          }
          return rename(source, destination);
        }
      }),
      error => error.code === 'ROLLBACK_RECOVERY_FAILED' && Boolean(error.details?.failedProgram)
    );
    const archiveDirectory = fixture.switchReport.archive.directory;
    const failedProgram = path.join(
      path.dirname(fixture.activeProgram),
      `.rollback-${fixture.runId}-${path.basename(fixture.activeProgram)}.failed`
    );
    const replacedProgram = path.join(archiveDirectory, `after-switch-${path.basename(fixture.activeProgram)}`);
    assert.equal(await sha256(failedProgram), fixture.oldProgramHash);
    assert.equal(await sha256(replacedProgram), fixture.candidateProgramHash);
    assert.equal(await sha256(fixture.activeDatabase), fixture.oldDatabaseHash);
    assert.equal(await sha256(path.join(archiveDirectory, 'after-switch.sqlite')), fixture.candidateHash);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('duplicate run id is blocked without changing the successful switch', async () => {
  const fixture = await setup();
  try {
    const options = {
      mode: 'apply', dataRoot: fixture.dataRoot, candidate: fixture.candidate,
      externalBackupRoot: fixture.backupRoot, runId: 'RUN-DUPLICATE', now: fixedNow
    };
    await switchProductionData(options);
    const before = await snapshotTree(fixture.dataRoot);
    await assert.rejects(
      () => switchProductionData(options),
      error => error.code === 'RUN_ID_EXISTS'
    );
    assert.deepEqual(await snapshotTree(fixture.dataRoot), before);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});
