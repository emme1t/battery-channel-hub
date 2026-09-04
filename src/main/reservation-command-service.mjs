import {
  reconcileLegacySamples,
  reserveLegacySample,
  startLegacySample,
  transitionLegacyChannel
} from '../domain/legacy-reservation-transactions.mjs';
import {
  returnLegacyReservedToApplication,
  returnLegacyRunningToApplication
} from '../domain/legacy-return-to-application-transactions.mjs';

const handlers = Object.freeze({
  reconcileQuantity: reconcileLegacySamples,
  start: startLegacySample,
  reserve: reserveLegacySample,
  transition: transitionLegacyChannel,
  returnReservedToApplication: returnLegacyReservedToApplication,
  returnRunningToApplication: returnLegacyRunningToApplication
});

function failure(code, message, details = undefined) {
  const result = { ok: false, code, message };
  if (details !== undefined) result.details = details;
  return result;
}

function commandError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function applyHandler(type, handler, state, payload) {
  if (!['start', 'reserve'].includes(type) || !Array.isArray(payload?.items)) {
    return handler(state, payload || {});
  }
  if (payload.items.length < 1 || payload.items.length > 999) {
    throw commandError('ASSIGNMENT_BATCH_INVALID', '批量分配必须包含 1–999 个子样品');
  }
  return payload.items.reduce((draft, item) => handler(draft, {
    ...payload,
    ...item,
    items: undefined
  }), state);
}

export function createReservationCommandService({ store }) {
  if (!store || typeof store.load !== 'function' || typeof store.save !== 'function') {
    throw new TypeError('reservation command service requires a state store');
  }

  return {
    async execute(command) {
      if (!command || typeof command !== 'object' || Array.isArray(command)) {
        return failure('COMMAND_REQUIRED', '缺少预约命令');
      }
      const handler = handlers[command.type];
      if (!handler) {
        return failure('COMMAND_UNSUPPORTED', `不支持的预约命令：${String(command.type || '(空)')}`);
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
        nextState = applyHandler(command.type, handler, loaded.state, command.payload || {});
      } catch (error) {
        return failure(error.code || 'RESERVATION_COMMAND_REJECTED', error.message, error.details);
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

export { handlers as reservationCommandHandlers };
