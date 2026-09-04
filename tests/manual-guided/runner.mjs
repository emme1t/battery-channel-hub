import { executeVisibleAction } from './actions.mjs';

const NON_SUCCESS_OUTCOMES = new Set(['cancelled', 'rejected', 'failure', 'failed']);

function validateInputs({ scenario, operator, oracle, runContext, dataManifest }) {
  if (!scenario || typeof scenario !== 'object') throw new TypeError('scenario is required');
  if (!operator || typeof operator.perform !== 'function') throw new TypeError('operator is required');
  if (!oracle || typeof oracle.capture !== 'function' || typeof oracle.assertSafety !== 'function'
    || typeof oracle.assertZeroBusinessWrite !== 'function') {
    throw new TypeError('oracle must provide capture, assertSafety and assertZeroBusinessWrite');
  }
  if (!runContext || typeof runContext.dataRoot !== 'string') throw new TypeError('runContext.dataRoot is required');
  if (!Array.isArray(dataManifest)) throw new TypeError('dataManifest must be an array');
}

function resolveAction(action, manifest) {
  const dataId = action.params?.dataId;
  if (!dataId) return action;
  const entry = manifest.get(dataId);
  if (!entry) throw new Error(`missing generated data for ${dataId}`);
  return Object.freeze({
    ...action,
    params: Object.freeze({ ...action.params, path: entry.path })
  });
}

export async function runManualScenario({ scenario, operator, oracle, runContext, dataManifest } = {}) {
  validateInputs({ scenario, operator, oracle, runContext, dataManifest });
  const manifest = new Map(dataManifest.map(item => [item.id, item]));
  for (const dataId of scenario.dataIds || []) {
    if (!manifest.has(dataId)) throw new Error(`missing generated data for ${dataId}`);
  }
  const startedAt = new Date().toISOString();
  const deadline = Date.now() + scenario.maximumDurationMs;
  const results = [];
  let current = oracle.capture({ dataRoot: runContext.dataRoot });

  for (const sourceAction of scenario.actions) {
    if (Date.now() > deadline) throw new Error(`manual scenario ${scenario.id} exceeded maximum duration`);
    const action = resolveAction(sourceAction, manifest);
    const result = await executeVisibleAction({ operator, action, context: { scenarioId: scenario.id, runContext, dataManifest } });
    if (!scenario.allowedVisibleOutcomes.includes(result.outcome) || result.outcome !== action.expect) {
      throw new Error(`unexpected visible outcome for ${action.id}: expected ${action.expect}, received ${result.outcome}`);
    }
    const next = oracle.capture({ dataRoot: runContext.dataRoot });
    oracle.assertSafety(next);
    if (NON_SUCCESS_OUTCOMES.has(result.outcome)) {
      oracle.assertZeroBusinessWrite(current, next, {
        allowedAuditActions: action.allowedAuditActions || []
      });
    }
    results.push(Object.freeze(result));
    current = next;
  }

  return Object.freeze({
    scenarioId: scenario.id,
    status: 'passed',
    compressed: scenario.compressed,
    startedAt,
    endedAt: new Date().toISOString(),
    actions: Object.freeze(results),
    finalSnapshot: current
  });
}
