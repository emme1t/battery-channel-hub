import { normalizeManualActionResult } from './contracts.mjs';

export const VISIBLE_ACTIONS = Object.freeze([
  'login', 'navigate', 'importFile', 'importFolder', 'selectRequest', 'selectSamples',
  'assignChannels', 'reserve', 'startImmediately', 'startReserved', 'finishRunning',
  'returnRunning', 'startStorage', 'finishStorage', 'returnStorage', 'editTester',
  'editDevice', 'exportTimeliness', 'exportRequests', 'exportSelectedRequests',
  'exportLogs', 'backup', 'restore', 'restart', 'doubleClick', 'cancelDialog',
  'search', 'paginate'
]);

const VISIBLE_ACTION_SET = new Set(VISIBLE_ACTIONS);

export async function executeVisibleAction({ operator, action, context = {} } = {}) {
  if (!operator || typeof operator.perform !== 'function') {
    throw new TypeError('operator must provide perform');
  }
  if (!action || typeof action !== 'object' || Array.isArray(action)) {
    throw new TypeError('visible action must be an object');
  }
  if (typeof action.id !== 'string' || action.id.trim() === '') {
    throw new TypeError('visible action id is required');
  }
  if (!VISIBLE_ACTION_SET.has(action.type)) {
    throw new TypeError(`unsupported visible action: ${String(action.type)}`);
  }
  if (!context || typeof context !== 'object' || Array.isArray(context)) {
    throw new TypeError('visible action context must be an object');
  }
  return normalizeManualActionResult(await operator.perform(action, context));
}
