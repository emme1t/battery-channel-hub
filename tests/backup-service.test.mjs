import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { createEmptyState } from '../src/domain/state-schema.mjs';
import { createStateStore } from '../src/main/state-store.mjs';
import {
  makeBackupPackage,
  restoreBackup,
  verifyBackupPackage,
  writeBackupFile
} from '../src/main/backup-service.mjs';

const fixedNow = '2026-08-20T19:00:00.000Z';

async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

async function withStore(run) {
  const root = await fs.mkdtemp(join(tmpdir(), 'vnext-backup-'));
  const store = createStateStore({ dataRoot: join(root, 'data'), idFactory: () => 'state' });
  try {
    const seeded = await store.save(createEmptyState({ username: 'current' }), 0);
    assert.equal(seeded.ok, true);
    return await run({ root, store, current: seeded.state });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

test('backup package checksum detects state and revision tampering', () => {
  const state = createEmptyState({ dataRevision: 4, username: 'before' });
  const packageValue = makeBackupPackage(state, { reason: '测试备份', createdAt: fixedNow });

  assert.equal(verifyBackupPackage(packageValue).username, 'before');

  const stateTamper = structuredClone(packageValue);
  stateTamper.state.username = 'tampered';
  assert.throws(() => verifyBackupPackage(stateTamper), /checksum/i);

  const revisionTamper = structuredClone(packageValue);
  revisionTamper.sourceRevision = 3;
  assert.throws(() => verifyBackupPackage(revisionTamper), /source revision/i);
});

test('writeBackupFile writes a re-readable verified package', async () => {
  await withStore(async ({ root, current }) => {
    const filePath = join(root, 'backups', 'manual.batterydata');

    const result = await writeBackupFile(filePath, current, {
      reason: '手动备份',
      createdAt: fixedNow,
      idFactory: () => 'backup'
    });

    assert.equal(result.ok, true);
    assert.equal(result.filePath, filePath);
    const verified = verifyBackupPackage(JSON.parse(await fs.readFile(filePath, 'utf8')));
    assert.deepEqual(verified, current);
    assert.deepEqual((await fs.readdir(join(root, 'backups'))).sort(), ['manual.batterydata']);
  });
});

test('tampered backup is rejected before pre-backup creation or current-state change', async () => {
  await withStore(async ({ root, store, current }) => {
    const packageValue = makeBackupPackage(createEmptyState({ username: 'restored' }), { createdAt: fixedNow });
    packageValue.state.username = 'tampered';
    const preRestoreFile = join(root, 'auto', 'before-restore.batterydata');

    await assert.rejects(
      () => restoreBackup({ packageValue, store, expectedRevision: 1, preRestoreFile, actor: 'tester', auditId: 'AUD-R-1', now: fixedNow }),
      /checksum/i
    );

    assert.equal(await exists(preRestoreFile), false);
    assert.deepEqual((await store.inspect()).state, current);
  });
});

test('successful restore verifies pre-backup, advances revision and appends one success audit', async () => {
  await withStore(async ({ root, store, current }) => {
    const packageValue = makeBackupPackage(createEmptyState({ username: 'restored' }), { createdAt: fixedNow });
    const preRestoreFile = join(root, 'auto', 'before-restore.batterydata');

    const result = await restoreBackup({
      packageValue,
      store,
      expectedRevision: current.dataRevision,
      preRestoreFile,
      actor: 'tester',
      auditId: 'AUD-R-2',
      now: fixedNow
    });

    assert.equal(result.ok, true);
    assert.equal(result.state.dataRevision, 2);
    assert.equal(result.state.username, 'restored');
    assert.deepEqual(result.state.audits, [{
      id: 'AUD-R-2',
      at: fixedNow,
      actor: 'tester',
      action: 'restore-backup',
      result: 'success',
      level: 'WARNING',
      before: { revision: 1, requests: 0, samples: 0, devices: 0, channels: 0, records: 0, audits: 0, requestSourceRows: 0 },
      after: { revision: 0, requests: 0, samples: 0, devices: 0, channels: 0, records: 0, audits: 0, requestSourceRows: 0 },
      note: '恢复前备份已验证：before-restore.batterydata'
    }]);
    assert.deepEqual(verifyBackupPackage(JSON.parse(await fs.readFile(preRestoreFile, 'utf8'))), current);
  });
});

test('duplicate restore audit id blocks before creating the pre-backup', async () => {
  await withStore(async ({ root, store, current }) => {
    const restored = createEmptyState({
      audits: [{ id: 'AUD-DUP', action: 'legacy', result: 'success' }]
    });
    const packageValue = makeBackupPackage(restored, { createdAt: fixedNow });
    const preRestoreFile = join(root, 'auto', 'before-restore.batterydata');

    await assert.rejects(
      () => restoreBackup({ packageValue, store, expectedRevision: 1, preRestoreFile, actor: 'tester', auditId: 'AUD-DUP', now: fixedNow }),
      /already exists/i
    );

    assert.equal(await exists(preRestoreFile), false);
    assert.deepEqual((await store.inspect()).state, current);
  });
});

test('pre-restore backup failure and revision conflict leave current state unchanged', async () => {
  await withStore(async ({ root, store, current }) => {
    const packageValue = makeBackupPackage(createEmptyState({ username: 'restored' }), { createdAt: fixedNow });
    const blocker = join(root, 'not-a-directory');
    await fs.writeFile(blocker, 'file', 'utf8');

    await assert.rejects(
      () => restoreBackup({ packageValue, store, expectedRevision: 1, preRestoreFile: join(blocker, 'backup.batterydata'), actor: 'tester', auditId: 'AUD-R-3', now: fixedNow }),
      /ENOTDIR|EEXIST/
    );
    assert.deepEqual((await store.inspect()).state, current);

    const conflictBackup = join(root, 'auto', 'conflict.batterydata');
    const conflict = await restoreBackup({ packageValue, store, expectedRevision: 0, preRestoreFile: conflictBackup, actor: 'tester', auditId: 'AUD-R-4', now: fixedNow });
    assert.equal(conflict.ok, false);
    assert.equal(conflict.code, 'REVISION_CONFLICT');
    assert.deepEqual((await store.inspect()).state, current);
    assert.equal(await exists(conflictBackup), true);
  });
});
