import {
  finishLegacyStorage,
  startLegacyStorage,
  updateLegacyStorage
} from '../domain/legacy-storage-transactions.mjs';
import { returnLegacyStorageToApplication } from '../domain/legacy-return-to-application-transactions.mjs';

const handlers = Object.freeze({
  startStorage: startLegacyStorage,
  updateStorage: updateLegacyStorage,
  finishStorage: finishLegacyStorage,
  returnStorageToApplication: returnLegacyStorageToApplication
});

function failure(code, message, details = undefined) {
  const result = { ok: false, code, message };
  if (details !== undefined) result.details = details;
  return result;
}

export function createStorageCommandService({ store }) {
  if (!store || typeof store.load !== 'function' || typeof store.save !== 'function') {
    throw new TypeError('storage command service requires a state store');
  }

  return {
    async execute(command) {
      if (!command || typeof command !== 'object' || Array.isArray(command)) {
        return failure('COMMAND_REQUIRED', '缺少长期存储命令');
      }
      const handler = handlers[command.type];
      if (!handler) {
        return failure('COMMAND_UNSUPPORTED', `不支持的长期存储命令：${String(command.type || '(空)')}`);
      }

      let loaded;
      try {
        loaded = await store.load();
      } catch (error) {
        return failure(error.code || 'STATE_READ_FAILED', error.message, error.details);
      }
      if (!loaded?.ok) return loaded;

      const currentRevision = loaded.state.revision;
      if (!Number.isInteger(command.expectedRevision) || command.expectedRevision !== currentRevision) {
        return failure(
          'REVISION_CONFLICT',
          `状态修订冲突：当前 ${currentRevision}，提交 ${String(command.expectedRevision)}`,
          { currentRevision, expectedRevision: command.expectedRevision }
        );
      }

      let nextState;
      try {
        nextState = handler(loaded.state, command.payload || {});
      } catch (error) {
        return failure(error.code || 'STORAGE_COMMAND_REJECTED', error.message, error.details);
      }

      try {
        return await store.save({
          expectedRevision: currentRevision,
          state: nextState,
          journalEntries: nextState.formChangeJournal || []
        });
      } catch (error) {
        return failure(error.code || 'PERSISTENCE_FAILED', error.message, error.details);
      }
    }
  };
}

export { handlers as storageCommandHandlers };
