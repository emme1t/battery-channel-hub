import { randomUUID } from 'node:crypto';
import * as defaultFs from 'node:fs/promises';
import { join } from 'node:path';

import {
  assertValidState,
  createEmptyState,
  summarizeState
} from '../domain/state-schema.mjs';

const VNEXT_FILE_NAME = 'battery-channel-vnext.json';
const LEGACY_FILE_NAMES = [
  'battery-channel-hub.json',
  'battery-channel-hub.sqlite',
  'battery-channel-hub.db'
];

async function exists(fsApi, filePath) {
  try {
    await fsApi.access(filePath);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

async function existingLegacyFiles(fsApi, dataRoot) {
  const found = [];
  for (const name of LEGACY_FILE_NAMES) {
    if (await exists(fsApi, join(dataRoot, name))) found.push(name);
  }
  return found;
}

async function writeSynced(fsApi, filePath, value) {
  const handle = await fsApi.open(filePath, 'wx');
  try {
    await handle.writeFile(value);
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

function publicInspection(result) {
  const { rawBytes: _rawBytes, ...publicResult } = result;
  return publicResult;
}

function failed(code, message, details = undefined) {
  return {
    ok: false,
    code,
    message,
    ...(details ? { details } : {})
  };
}

export function createStateStore({
  dataRoot,
  fsApi = defaultFs,
  clock = () => new Date(),
  idFactory = randomUUID
}) {
  if (typeof dataRoot !== 'string' || dataRoot.trim() === '') {
    throw new TypeError('dataRoot is required');
  }

  const filePath = join(dataRoot, VNEXT_FILE_NAME);

  async function inspectInternal() {
    let legacyFiles;
    try {
      legacyFiles = await existingLegacyFiles(fsApi, dataRoot);
    } catch (error) {
      return {
        kind: 'blocked',
        message: `数据目录无法安全检查：${error.message}`,
        legacyFiles: []
      };
    }

    if (!(await exists(fsApi, filePath))) {
      return legacyFiles.length > 0
        ? {
            kind: 'migration-required',
            message: '检测到旧版数据，正常启动不会迁移或覆盖；请先执行独立 dry-run。',
            legacyFiles
          }
        : {
            kind: 'empty',
            state: createEmptyState(),
            summary: summarizeState(createEmptyState()),
            legacyFiles
          };
    }

    try {
      const rawBytes = await fsApi.readFile(filePath);
      const state = assertValidState(JSON.parse(rawBytes.toString('utf8')));
      return {
        kind: 'ready',
        state,
        summary: summarizeState(state),
        legacyFiles,
        rawBytes
      };
    } catch (error) {
      return {
        kind: 'blocked',
        message: `vNext 状态无法安全读取：${error.message}`,
        legacyFiles
      };
    }
  }

  async function inspect() {
    return publicInspection(await inspectInternal());
  }

  async function save(nextState, expectedRevision) {
    let validated;
    try {
      validated = assertValidState(nextState);
    } catch (error) {
      return failed(error.code || 'INVALID_VNEXT_STATE', error.message, error.blockers);
    }

    const current = await inspectInternal();
    if (current.kind === 'migration-required') {
      return failed('MIGRATION_REQUIRED', current.message);
    }
    if (current.kind === 'blocked') {
      return failed('CURRENT_STATE_BLOCKED', current.message);
    }

    const currentRevision = current.kind === 'ready' ? current.state.dataRevision : 0;
    if (currentRevision !== expectedRevision) {
      return failed('REVISION_CONFLICT', '数据已被其它操作更新，请重新加载。');
    }

    let persisted;
    try {
      persisted = assertValidState({
        ...validated,
        dataRevision: currentRevision + 1,
        savedAt: clock().toISOString()
      });
    } catch (error) {
      return failed(error.code || 'INVALID_VNEXT_STATE', error.message, error.blockers);
    }

    const operationId = String(idFactory());
    const temporaryPath = join(dataRoot, `.battery-channel-vnext.${operationId}.tmp`);
    const rollbackPath = join(dataRoot, `.battery-channel-vnext.${operationId}.rollback`);
    let targetReplaced = false;
    let rollbackCreated = false;
    let phase = 'prepare';

    try {
      await fsApi.mkdir(dataRoot, { recursive: true });
      if (current.rawBytes) {
        phase = 'rollback-copy';
        await writeSynced(fsApi, rollbackPath, current.rawBytes);
        const verifiedRollback = await fsApi.readFile(rollbackPath);
        if (!verifiedRollback.equals(current.rawBytes)) {
          throw new Error('rollback copy verification failed');
        }
        rollbackCreated = true;
      }

      phase = 'temporary-write';
      const serialized = `${JSON.stringify(persisted, null, 2)}\n`;
      await writeSynced(fsApi, temporaryPath, serialized);

      phase = 'replace';
      await fsApi.rename(temporaryPath, filePath);
      targetReplaced = true;

      phase = 'post-write-validation';
      const verified = await inspectInternal();
      if (
        verified.kind !== 'ready' ||
        verified.state.dataRevision !== persisted.dataRevision ||
        JSON.stringify(verified.state) !== JSON.stringify(persisted)
      ) {
        throw new Error('post-write validation failed');
      }

      if (rollbackCreated) await removeIfPresent(fsApi, rollbackPath);
      return { ok: true, state: verified.state, summary: verified.summary };
    } catch (error) {
      let rollbackError = null;
      try {
        if (targetReplaced) {
          if (rollbackCreated || await exists(fsApi, rollbackPath)) {
            await fsApi.rename(rollbackPath, filePath);
            rollbackCreated = false;
          } else {
            await removeIfPresent(fsApi, filePath);
          }
        }
      } catch (restoreError) {
        rollbackError = restoreError;
      }

      try {
        await removeIfPresent(fsApi, temporaryPath);
        if (rollbackCreated) await removeIfPresent(fsApi, rollbackPath);
      } catch (cleanupError) {
        rollbackError ||= cleanupError;
      }

      if (rollbackError) {
        return failed(
          'ROLLBACK_FAILED',
          `状态保存失败且自动回滚失败：${rollbackError.message}`,
          { phase, cause: error.message }
        );
      }
      return phase === 'post-write-validation'
        ? failed('POST_WRITE_VALIDATION_FAILED', '写入后校验失败，已恢复原状态。')
        : failed('ATOMIC_WRITE_FAILED', `状态原子保存失败：${error.message}`, { phase });
    }
  }

  return {
    filePath,
    inspect,
    save
  };
}
