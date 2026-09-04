export const WORKFLOW_OUTCOMES = Object.freeze(['success', 'warning', 'cancelled', 'rejected', 'failure']);

export function normalizeWorkflow(input) {
  if (!/^[SDM]\d{2}$/.test(input?.id || '')) throw new TypeError('invalid workflow id');
  if (!['P0', 'P1', 'P2'].includes(input.risk)) throw new TypeError('invalid workflow risk');
  if (!Array.isArray(input.actions) || input.actions.length === 0) throw new TypeError('workflow actions required');
  const ids = input.actions.map(action => action.id);
  if (new Set(ids).size !== ids.length) throw new TypeError('duplicate action id');
  if (input.actions.some(action => !Number.isInteger(action.revisionDelta) &&
    !(Array.isArray(action.revisionDelta) && action.revisionDelta.length > 0 && action.revisionDelta.every(Number.isInteger)))) {
    throw new TypeError('action revisionDelta required');
  }
  if (input.actions.some(action => ['search', 'filter', 'expand', 'collapse', 'paginate'].includes(action.type) && action.revisionDelta !== 0)) {
    throw new TypeError('read-only action revisionDelta must be 0');
  }
  if (input.actions.some(action => ['restart', 'reloadCurrent'].includes(action.type)
    && (!Array.isArray(action.revisionDelta) || action.revisionDelta.length !== 2
      || action.revisionDelta[0] !== 2 || action.revisionDelta[1] !== 3))) {
    throw new TypeError('restart and reloadCurrent must declare [2, 3]');
  }
  if (input.actions.some(action => {
    const retainedOldNavigation = action.params?.old === true && ['manageRunning', 'startTodo', 'cancelTodo'].includes(action.type);
    return !retainedOldNavigation && !['navigate', 'exportLog', 'exportRequest', 'backup', 'restore', 'closeSecondSession'].includes(action.type) && Array.isArray(action.revisionDelta) &&
      action.revisionDelta.length === 2 && action.revisionDelta[0] === 0 && action.revisionDelta[1] === 1;
  })) {
    throw new TypeError('only navigation or file actions may declare [0, 1]');
  }
  return Object.freeze({ ...structuredClone(input), actions: Object.freeze(structuredClone(input.actions)) });
}

export function normalizeActionResult(input) {
  if (!WORKFLOW_OUTCOMES.includes(input?.outcome)) throw new TypeError('unknown outcome');
  return Object.freeze(structuredClone(input));
}
