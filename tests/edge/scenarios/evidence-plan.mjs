import { createScenarioResult } from '../result-contract.mjs';

const BLOCKING_CODES = new Set([
  'EDGE_NOT_INSTALLED',
  'ELECTRON_NOT_INSTALLED',
  'ENVIRONMENT_UNAVAILABLE',
  'FIXTURE_MISSING'
]);

export async function executeEvidencePlan(definition, checks, context) {
  const started = performance.now();
  const assertions = [];
  const evidence = [];
  const metrics = { authorities: [] };
  let firstError = null;
  try {
    for (const check of checks) {
      const result = await context.runEvidence(structuredClone(check), definition);
      const normalizedError = result?.error || null;
      assertions.push({
        key: check.key,
        ok: result?.ok === true,
        message: result?.ok === true
          ? String(check.success || '权威证据通过')
          : String(normalizedError?.message || '权威证据失败')
      });
      const evidencePaths = Array.isArray(result?.evidencePaths)
        ? result.evidencePaths
        : (result?.evidencePath ? [result.evidencePath] : []);
      evidence.push(...evidencePaths.map(item => context.relativeEvidence(item)));
      metrics.authorities.push({
        key: check.key,
        kind: check.kind,
        ok: result?.ok === true,
        summary: result?.summary || null
      });
      if (!result?.ok && !firstError) {
        firstError = normalizedError || { code: 'SCENARIO_EVIDENCE_FAILED', message: `${check.key} 未通过` };
      }
    }
  } catch (error) {
    firstError = { code: error.code || 'SCENARIO_EXECUTION_FAILED', message: error.message, details: error.details };
    assertions.push({ key: 'scenario-execution', ok: false, message: error.message });
  }
  const status = firstError
    ? (BLOCKING_CODES.has(firstError.code) ? 'BLOCKED' : 'FAIL')
    : 'PASS';
  return createScenarioResult(definition, {
    status,
    durationMs: Math.round((performance.now() - started) * 100) / 100,
    assertions,
    evidence,
    metrics,
    error: firstError
  });
}

export function createEvidenceRunners(definitions, plans) {
  return Object.freeze(Object.fromEntries(definitions.map(definition => [
    definition.id,
    context => executeEvidencePlan(definition, plans[definition.id], context)
  ])));
}
