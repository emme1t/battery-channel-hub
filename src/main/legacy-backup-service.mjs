import { createHash, randomUUID } from 'node:crypto';
import * as defaultFs from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';

import { normalizeLegacyState, summarizeLegacyState } from './legacy-state-schema.mjs';

const LEGACY_BACKUP_FORMAT = 'battery-channel-hub-legacy-backup';
const LEGACY_BACKUP_VERSION = 1;
const MAX_BACKUP_BYTES = 100 * 1024 * 1024;

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value).sort().map(key => [key, canonicalize(value[key])])
    );
  }
  return value;
}

function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

function sha256State(value) {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function backupError(code, message, details = undefined) {
  const error = new Error(message);
  error.code = code;
  if (details !== undefined) error.details = details;
  return error;
}

function requireText(value, field, label) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw backupError('RESTORE_FIELD_REQUIRED', `${label}不能为空`, { field });
  }
  return value.trim();
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

async function removeIfPresent(fsApi, filePath) {
  try {
    await fsApi.unlink(filePath);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

async function writeSynced(fsApi, filePath, bytes) {
  const handle = await fsApi.open(filePath, 'wx');
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export function makeLegacyBackup(state, {
  reason = '手动备份',
  createdAt = new Date().toISOString()
} = {}) {
  const normalized = normalizeLegacyState(state);
  return {
    format: LEGACY_BACKUP_FORMAT,
    version: LEGACY_BACKUP_VERSION,
    createdAt,
    reason,
    sourceRevision: normalized.revision,
    state: normalized,
    stateSha256: sha256State(normalized)
  };
}

export function verifyLegacyBackup(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw backupError('BACKUP_FORMAT_INVALID', '备份包必须是对象');
  }
  if (value.format !== LEGACY_BACKUP_FORMAT || value.version !== LEGACY_BACKUP_VERSION) {
    throw backupError('BACKUP_FORMAT_INVALID', '备份包格式或版本不受支持');
  }
  const actual = sha256State(value.state);
  if (value.stateSha256 !== actual) {
    throw backupError('BACKUP_CHECKSUM_INVALID', '备份状态 SHA-256 校验失败');
  }
  const state = normalizeLegacyState(value.state);
  if (value.sourceRevision !== state.revision) {
    throw backupError('BACKUP_REVISION_INVALID', '备份修订号与状态不一致');
  }
  return state;
}

export async function writeLegacyBackupFile(filePath, state, {
  reason = '手动备份',
  createdAt = new Date().toISOString(),
  fsApi = defaultFs,
  idFactory = randomUUID
} = {}) {
  if (typeof filePath !== 'string' || filePath.trim() === '') {
    throw backupError('BACKUP_PATH_REQUIRED', '备份文件路径不能为空');
  }
  const absolute = resolve(filePath);
  const packageValue = makeLegacyBackup(state, { reason, createdAt });
  const parent = dirname(absolute);
  const operationId = String(idFactory()).replace(/[^A-Za-z0-9._-]/g, '_');
  const temporary = join(parent, `.${basename(absolute)}.${operationId}.tmp`);
  const rollback = join(parent, `.${basename(absolute)}.${operationId}.rollback`);
  let rollbackCreated = false;
  let targetCreated = false;
  try {
    await fsApi.mkdir(parent, { recursive: true });
    await writeSynced(fsApi, temporary, `${JSON.stringify(packageValue, null, 2)}\n`);
    verifyLegacyBackup(JSON.parse(await fsApi.readFile(temporary, 'utf8')));
    if (await exists(fsApi, absolute)) {
      await fsApi.rename(absolute, rollback);
      rollbackCreated = true;
    }
    await fsApi.rename(temporary, absolute);
    targetCreated = true;
    const persisted = JSON.parse(await fsApi.readFile(absolute, 'utf8'));
    verifyLegacyBackup(persisted);
    if (rollbackCreated) {
      await removeIfPresent(fsApi, rollback);
      rollbackCreated = false;
    }
    return {
      ok: true,
      verified: true,
      file: absolute,
      sourceRevision: persisted.sourceRevision,
      stateSha256: persisted.stateSha256,
      format: LEGACY_BACKUP_FORMAT
    };
  } catch (error) {
    if (targetCreated) await removeIfPresent(fsApi, absolute);
    if (rollbackCreated) {
      await fsApi.rename(rollback, absolute);
      rollbackCreated = false;
    }
    await removeIfPresent(fsApi, temporary);
    if (rollbackCreated) await removeIfPresent(fsApi, rollback);
    throw error;
  }
}

function mergeById(...collections) {
  const merged = new Map();
  for (const collection of collections) {
    for (const item of Array.isArray(collection) ? collection : []) {
      if (item?.id) merged.set(String(item.id), structuredClone(item));
    }
  }
  return [...merged.values()];
}

function restoreAudit({ auditId, actor, now, current, restored, preRestoreFile }) {
  return {
    id: auditId,
    time: now,
    at: now,
    user: actor,
    actor,
    action: '恢复数据备份',
    target: '本机 SQLite 看板数据',
    outcome: 'warning',
    result: 'warning',
    verified: true,
    level: 'warning',
    before: summarizeLegacyState(current),
    after: summarizeLegacyState(restored),
    note: `恢复前备份已写后校验：${basename(preRestoreFile)}`
  };
}

async function requireLoadedState(store) {
  const loaded = await store.load();
  if (!loaded?.ok) {
    throw backupError(loaded?.code || 'STATE_READ_FAILED', loaded?.message || 'SQLite 状态读取失败');
  }
  return loaded.state;
}

async function compensateRestore(store, current, savedRevision) {
  if (typeof store.replaceExact !== 'function') {
    return { ok: false, code: 'EXACT_REPLACE_UNAVAILABLE', message: 'SQLite store 不支持精确快照替换' };
  }
  const rollback = await store.replaceExact({ expectedRevision: savedRevision, state: current });
  if (!rollback?.ok) return rollback;
  let reloaded;
  try {
    reloaded = await requireLoadedState(store);
  } catch (error) {
    return { ok: false, code: error.code || 'STATE_READ_FAILED', message: error.message };
  }
  if (canonicalJson(reloaded) !== canonicalJson(current)) {
    return {
      ok: false,
      code: 'EXACT_REPLACE_MISMATCH',
      message: '补偿后的 SQLite 状态与恢复前快照不一致'
    };
  }
  return { ok: true, state: reloaded };
}

export async function restoreLegacyBackup({
  packageValue,
  store,
  expectedRevision,
  preRestoreFile,
  actor,
  auditId,
  now = new Date().toISOString(),
  writeBackupFileImpl = writeLegacyBackupFile
}) {
  if (!store || typeof store.load !== 'function' || typeof store.save !== 'function') {
    throw new TypeError('restoreLegacyBackup requires a store');
  }
  const restored = verifyLegacyBackup(packageValue);
  const normalizedActor = requireText(actor, 'actor', '操作者');
  const normalizedAuditId = requireText(auditId, 'auditId', '恢复审计标识');
  const normalizedNow = requireText(now, 'now', '恢复时间');
  if (!Number.isFinite(Date.parse(normalizedNow))) throw backupError('RESTORE_TIME_INVALID', '恢复时间无效');

  const current = await requireLoadedState(store);
  if (!Number.isInteger(expectedRevision) || expectedRevision !== current.revision) {
    throw backupError(
      'REVISION_CONFLICT',
      `状态修订冲突：当前 ${current.revision}，提交 ${String(expectedRevision)}`,
      { currentRevision: current.revision, expectedRevision }
    );
  }
  if (
    current.auditLogs.some(item => String(item?.id || '') === normalizedAuditId) ||
    restored.auditLogs.some(item => String(item?.id || '') === normalizedAuditId)
  ) {
    throw backupError('IDENTIFIER_ALREADY_EXISTS', '恢复审计标识已存在');
  }

  try {
    await writeBackupFileImpl(preRestoreFile, current, {
      reason: '恢复前自动备份',
      createdAt: normalizedNow
    });
    const verifiedPreRestore = verifyLegacyBackup(JSON.parse(await defaultFs.readFile(preRestoreFile, 'utf8')));
    if (sha256State(verifiedPreRestore) !== sha256State(normalizeLegacyState(current))) {
      throw backupError('PRE_RESTORE_BACKUP_INVALID', '恢复前备份与当前状态不一致');
    }
  } catch (error) {
    throw backupError('PRE_RESTORE_BACKUP_FAILED', `恢复前备份失败：${error.message}`, {
      causeCode: error.code || ''
    });
  }

  const auditLogs = mergeById(restored.auditLogs, current.auditLogs);
  auditLogs.unshift(restoreAudit({
    auditId: normalizedAuditId,
    actor: normalizedActor,
    now: normalizedNow,
    current,
    restored,
    preRestoreFile
  }));
  const formChangeJournal = mergeById(restored.formChangeJournal, current.formChangeJournal)
    .sort((left, right) => String(left.time || '').localeCompare(String(right.time || '')));
  const nextState = normalizeLegacyState({
    ...restored,
    revision: current.revision,
    auditLogs,
    formChangeJournal
  });

  const saved = await store.save({
    expectedRevision: current.revision,
    state: nextState,
    journalEntries: formChangeJournal
  });
  if (!saved?.ok) {
    throw backupError(saved?.code || 'PERSISTENCE_FAILED', saved?.message || '恢复状态写入失败');
  }

  let reloaded;
  try {
    reloaded = await requireLoadedState(store);
  } catch (error) {
    const rollback = await compensateRestore(store, current, saved.state.revision);
    if (!rollback?.ok) throw backupError('RESTORE_ROLLBACK_FAILED', '恢复校验失败且当前状态回滚失败');
    throw backupError('RESTORE_VERIFY_FAILED', `恢复后数据库重读失败，已回滚：${error.message}`);
  }
  if (canonicalJson(reloaded) !== canonicalJson(saved.state)) {
    const rollback = await compensateRestore(store, current, saved.state.revision);
    if (!rollback?.ok) throw backupError('RESTORE_ROLLBACK_FAILED', '恢复校验不一致且当前状态回滚失败');
    throw backupError('RESTORE_VERIFY_FAILED', '恢复后数据库内容不一致，已回滚');
  }
  return {
    ok: true,
    verified: true,
    state: reloaded,
    preRestoreFile: resolve(preRestoreFile),
    stateSha256: sha256State(reloaded)
  };
}

function fileTimestamp(value) {
  return value.replace(/[:.]/g, '-');
}

async function defaultReadTextFile(filePath) {
  const stats = await defaultFs.stat(filePath);
  if (!stats.isFile()) throw backupError('BACKUP_NOT_FILE', '所选备份路径不是文件');
  if (stats.size > MAX_BACKUP_BYTES) {
    throw backupError('BACKUP_TOO_LARGE', `备份包超过 ${MAX_BACKUP_BYTES / 1024 / 1024} MB 安全上限`);
  }
  return defaultFs.readFile(filePath, 'utf8');
}

export function createLegacyBackupService({
  dialog,
  store,
  dataRoot,
  documentsRoot,
  readTextFile = defaultReadTextFile,
  writeBackupFileImpl = writeLegacyBackupFile,
  restoreBackupImpl = restoreLegacyBackup,
  clock = () => new Date(),
  idFactory = randomUUID
}) {
  if (!dialog || !store || !dataRoot || !documentsRoot) {
    throw new TypeError('legacy backup service requires dialog, store, dataRoot and documentsRoot');
  }
  const resolvedDataRoot = resolve(dataRoot);
  const resolvedDocumentsRoot = resolve(documentsRoot);
  const nowIso = () => {
    const value = clock();
    return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
  };
  return {
    async backupState() {
      const now = nowIso();
      const selection = await dialog.showSaveDialog({
        title: '备份看板 SQLite 状态包',
        defaultPath: join(resolvedDocumentsRoot, `battery-channel-main-${fileTimestamp(now)}.batterydata`),
        filters: [{ name: '看板数据备份', extensions: ['batterydata', 'json'] }]
      });
      if (selection.canceled || !selection.filePath) return { canceled: true };
      try {
        const current = await requireLoadedState(store);
        return await writeBackupFileImpl(selection.filePath, current, {
          reason: '手动备份',
          createdAt: now
        });
      } catch (error) {
        return {
          ok: false,
          code: error.code || 'BACKUP_FAILED',
          message: `备份失败：${error.message}`
        };
      }
    },

    async restoreState(command = {}) {
      const selection = await dialog.showOpenDialog({
        title: '恢复看板 SQLite 状态包',
        properties: ['openFile'],
        filters: [{ name: '看板数据备份', extensions: ['batterydata', 'json'] }]
      });
      if (selection.canceled || !selection.filePaths?.[0]) return { canceled: true };
      const sourceFile = resolve(selection.filePaths[0]);
      try {
        const packageValue = JSON.parse(await readTextFile(sourceFile));
        verifyLegacyBackup(packageValue);
        const now = nowIso();
        const operationId = String(idFactory()).replace(/[^A-Za-z0-9._-]/g, '_');
        const preRestoreFile = join(
          resolvedDataRoot,
          'auto-backups',
          `before-restore-${fileTimestamp(now)}-${operationId}.batterydata`
        );
        const result = await restoreBackupImpl({
          packageValue,
          store,
          expectedRevision: command.expectedRevision,
          preRestoreFile,
          actor: String(command.actor || '当前用户'),
          auditId: `AUDIT-RESTORE-${operationId}`,
          now
        });
        return { ...result, file: sourceFile };
      } catch (error) {
        return {
          ok: false,
          code: error.code || 'RESTORE_FAILED',
          message: `恢复失败：${error.message}`,
          file: sourceFile
        };
      }
    }
  };
}

export { LEGACY_BACKUP_FORMAT, LEGACY_BACKUP_VERSION };
