import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

function nowIso(clock) {
  const value = clock();
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function fileTimestamp(value) {
  return value.replace(/[:.]/g, '-');
}

function safeId(value) {
  return String(value).replace(/[^A-Za-z0-9._-]/g, '_');
}

function notReady(inspection, operation) {
  return {
    ok: false,
    code: 'CURRENT_STATE_NOT_READY',
    message: inspection.message || `当前状态无法安全${operation}`
  };
}

export function createElectronDataService({
  dialog,
  store,
  dataRoot,
  documentsRoot,
  writeBackup,
  restoreFromBackup,
  readTextFile = (filePath) => readFile(filePath, 'utf8'),
  clock = () => new Date(),
  idFactory = randomUUID
}) {
  if (!dialog || !store || !dataRoot || !documentsRoot) {
    throw new TypeError('dialog, store, dataRoot and documentsRoot are required');
  }
  if (typeof writeBackup !== 'function' || typeof restoreFromBackup !== 'function') {
    throw new TypeError('writeBackup and restoreFromBackup are required');
  }

  async function backupWithDialog() {
    const inspection = await store.inspect();
    if (!['empty', 'ready'].includes(inspection.kind)) return notReady(inspection, '备份');

    const now = nowIso(clock);
    const selection = await dialog.showSaveDialog({
      title: '备份 vNext 看板数据',
      defaultPath: join(documentsRoot, `battery-channel-vnext-${fileTimestamp(now)}.batterydata`),
      filters: [{ name: 'vNext 数据备份', extensions: ['batterydata', 'json'] }]
    });
    if (selection.canceled || !selection.filePath) return { canceled: true };

    try {
      const result = await writeBackup(selection.filePath, inspection.state, {
        reason: '手动备份',
        createdAt: now
      });
      return { ...result, format: 'battery-channel-hub-vnext-backup' };
    } catch (error) {
      return {
        ok: false,
        code: error.code || 'BACKUP_FAILED',
        message: `备份失败：${error.message}`
      };
    }
  }

  async function restoreWithDialog() {
    const selection = await dialog.showOpenDialog({
      title: '恢复 vNext 看板数据',
      properties: ['openFile'],
      filters: [{ name: 'vNext 数据备份', extensions: ['batterydata', 'json'] }]
    });
    if (selection.canceled || !selection.filePaths[0]) return { canceled: true };

    const sourceFile = selection.filePaths[0];
    try {
      const inspection = await store.inspect();
      if (!['empty', 'ready'].includes(inspection.kind)) return notReady(inspection, '恢复');

      const packageValue = JSON.parse(await readTextFile(sourceFile));
      const now = nowIso(clock);
      const operationId = safeId(idFactory());
      const preRestoreFile = join(
        dataRoot,
        'auto-backups',
        `before-restore-${fileTimestamp(now)}-${operationId}.batterydata`
      );
      const result = await restoreFromBackup({
        packageValue,
        store,
        expectedRevision: inspection.state.dataRevision,
        preRestoreFile,
        actor: inspection.state.username || '当前用户',
        auditId: `AUD-RESTORE-${operationId}`,
        now
      });
      return { ...result, file: sourceFile, preRestoreFile };
    } catch (error) {
      return {
        ok: false,
        code: error.code || 'RESTORE_FAILED',
        message: `恢复失败：${error.message}`,
        file: sourceFile
      };
    }
  }

  return { backupWithDialog, restoreWithDialog };
}
