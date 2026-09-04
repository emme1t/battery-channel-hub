export const MANUAL_GUIDED_MODES = Object.freeze(['quick', 'full', 'replay']);

const VISIBLE_OUTCOMES = Object.freeze(['success', 'rejected', 'cancelled', 'failure']);

function requiredText(value, field) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`${field} is required`);
  }
  return value.trim();
}

export function normalizeManualScenario(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('manual scenario must be an object');
  }
  const id = requiredText(input.id, 'manual scenario id');
  if (!/^[A-G](?:0[1-9]|[1-9]\d)$/.test(id)) {
    throw new TypeError('manual scenario id must use A01-G99');
  }
  if (!Array.isArray(input.actions) || input.actions.length === 0) {
    throw new TypeError('manual scenario actions are required');
  }
  const actions = input.actions.map(action => {
    if (!action || typeof action !== 'object' || Array.isArray(action)) {
      throw new TypeError('manual scenario action must be an object');
    }
    return Object.freeze({
      ...action,
      id: requiredText(action.id, 'manual action id'),
      type: requiredText(action.type, 'manual action type'),
      expect: requiredText(action.expect, 'manual action expectation')
    });
  });
  return Object.freeze({
    ...input,
    id,
    title: requiredText(input.title, 'manual scenario title'),
    risk: requiredText(input.risk, 'manual scenario risk'),
    manualSection: requiredText(input.manualSection, 'manual scenario section'),
    actions: Object.freeze(actions)
  });
}

export function normalizeManualActionResult(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('manual action result must be an object');
  }
  const outcome = requiredText(input.outcome, 'visible outcome');
  if (!VISIBLE_OUTCOMES.includes(outcome)) {
    throw new TypeError(`visible outcome must be one of ${VISIBLE_OUTCOMES.join(', ')}`);
  }
  return Object.freeze({
    ...input,
    actionId: requiredText(input.actionId, 'manual action result actionId'),
    outcome,
    visiblePage: requiredText(input.visiblePage, 'manual action visiblePage'),
    visibleMessage: requiredText(input.visibleMessage, 'manual action visibleMessage')
  });
}
