import { createHash, randomUUID } from 'node:crypto';
import * as defaultFs from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

import {
  assertValidState,
  summarizeState
} from '../domain/state-schema.mjs';

const BACKUP_FORMAT = 'battery-channel-hub-vnext-backup';
const BACKUP_VERSION = 2;

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalize(value[key])])
    );
  }
  return value;
}

function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function backupError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

async function exists(fsApi, filePath) {
  try {
    await fsApi.access(filePath);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

async function writeSynced(fsApi, filePath, content) {
  const handle = await fsApi.open(filePath, 'wx');
  try {
    await handle.writeFile(content, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function removeIfPresent(fsApi, filePath) {
  try {
    await fsApi.unlink(filePath);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

export function makeBackupPackage(state, {
  reason = '手动备份',
  createdAt = new Date().toISOString()
} = {}) {
  const validState = assertValidState(state);
  return {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    createdAt,
    reason,
    sourceRevision: validState.dataRevision,
    checksum: sha256(canonicalJson(validState)),
    state: validState
  };
}

export function verifyBackupPackage(value) {
  if (!value || typeof value !== 'object') {
    throw backupError('BACKUP_FORMAT_INVALID', 'backup package must be an object');
  }
  if (value.format !== BACKUP_FORMAT || value.version !== BACKUP_VERSION) {
    throw backupError('BACKUP_FORMAT_INVALID', 'backup format or version is invalid');
  }
  const state = assertValidState(value.state);
  if (value.sourceRevision !== state.dataRevision) {
    throw backupError('BACKUP_SOURCE_REVISION_INVALID', 'backup source revision does not match state revision');
  }
  const actualChecksum = sha256(canonicalJson(state));
  if (value.checksum !== actualChecksum) {
    throw backupError('BACKUP_CHECKSUM_INVALID', 'backup checksum does not match state content');
  }
  return state;
}

export async function writeBackupFile(filePath, state, {
  reason = '手动备份',
  createdAt = new Date().toISOString(),
  fsApi = defaultFs,
  idFactory = randomUUID
} = {}) {
  if (typeof filePath !== 'string' || filePath.trim() === '') {
    throw backupError('BACKUP_PATH_REQUIRED', 'backup file path is required');
  }
  const packageValue = makeBackupPackage(state, { reason, createdAt });
  const parent = dirname(filePath);
  const operationId = String(idFactory());
  const temporaryPath = join(parent, `.${basename(filePath)}.${operationId}.tmp`);
  const rollbackPath = join(parent, `.${basename(filePath)}.${operationId}.rollback`);
  let rollbackCreated = false;
  let targetReplaced = false;

  try {
    await fsApi.mkdir(parent, { recursive: true });
    if (await exists(fsApi, filePath)) {
      const previousBytes = await fsApi.readFile(filePath);
      await writeSynced(fsApi, rollbackPath, previousBytes);
      rollbackCreated = true;
    }
    await writeSynced(fsApi, temporaryPath, `${JSON.stringify(packageValue, null, 2)}\n`);
    await fsApi.rename(temporaryPath, filePath);
    targetReplaced = true;
    const persistedPackage = JSON.parse(await fsApi.readFile(filePath, 'utf8'));
    verifyBackupPackage(persistedPackage);
    if (rollbackCreated) await removeIfPresent(fsApi, rollbackPath);
    return {
      ok: true,
      filePath,
      checksum: persistedPackage.checksum,
      sourceRevision: persistedPackage.sourceRevision
    };
  } catch (error) {
    if (targetReplaced) {
      if (rollbackCreated) {
        await fsApi.rename(rollbackPath, filePath);
        rollbackCreated = false;
      } else {
        await removeIfPresent(fsApi, filePath);
      }
    }
    await removeIfPresent(fsApi, temporaryPath);
    if (rollbackCreated) await removeIfPresent(fsApi, rollbackPath);
    throw error;
  }
}

function restoreAudit({ actor, auditId, now, before, after, preRestoreFile }) {
  return {
    id: auditId,
    at: now,
    actor,
    action: 'restore-backup',
    result: 'success',
    level: 'WARNING',
    before,
    after,
    note: `恢复前备份已验证：${basename(preRestoreFile)}`
  };
}

export async function restoreBackup({
  packageValue,
  store,
  expectedRevision,
  preRestoreFile,
  actor,
  auditId,
  now = new Date().toISOString()
}) {
  const restored = verifyBackupPackage(packageValue);
  if (restored.audits.some((item) => item.id === auditId)) {
    throw backupError('RESTORE_AUDIT_ID_EXISTS', `restore audit id ${auditId} already exists`);
  }

  const current = await store.inspect();
  if (!['ready', 'empty'].includes(current.kind)) {
    throw backupError('CURRENT_STATE_NOT_READY', current.message || 'current state is not ready');
  }

  await writeBackupFile(preRestoreFile, current.state, {
    reason: '恢复前自动备份',
    createdAt: now
  });
  const verifiedPreRestore = verifyBackupPackage(
    JSON.parse(await defaultFs.readFile(preRestoreFile, 'utf8'))
  );
  if (verifiedPreRestore.dataRevision !== current.state.dataRevision) {
    throw backupError('PRE_RESTORE_BACKUP_INVALID', 'pre-restore backup revision verification failed');
  }

  const nextState = assertValidState({
    ...restored,
    dataRevision: expectedRevision,
    audits: [
      ...restored.audits,
      restoreAudit({
        actor,
        auditId,
        now,
        before: summarizeState(current.state),
        after: summarizeState(restored),
        preRestoreFile
      })
    ]
  });
  return store.save(nextState, expectedRevision);
}
