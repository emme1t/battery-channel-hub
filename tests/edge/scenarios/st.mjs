import { SCENARIOS } from '../scenario-manifest.mjs';
import { createScenarioResult } from '../result-contract.mjs';

const cache = new WeakMap();

function sharedEvidence(context) {
  if (!cache.has(context)) cache.set(context, Promise.resolve().then(() => context.getStabilityEvidence()));
  return cache.get(context);
}

const definitions = SCENARIOS.filter(item => item.group === 'ST');

function evidencePaths(evidence, context) {
  const paths = Array.isArray(evidence.evidencePaths)
    ? evidence.evidencePaths
    : (evidence.evidencePath ? [evidence.evidencePath] : []);
  return paths.map(item => context.relativeEvidence(item));
}

export const ST_RUNNERS = Object.freeze(Object.fromEntries(definitions.map(definition => [
  definition.id,
  async context => {
    const started = performance.now();
    const evidence = await sharedEvidence(context);
    const item = evidence.scenarios?.[definition.id];
    if (!item) {
      return createScenarioResult(definition, {
        status: 'BLOCKED',
        durationMs: Math.round((performance.now() - started) * 100) / 100,
        assertions: [{ key: 'stability-evidence', ok: false, message: `${definition.id} 缺少稳定性证据` }],
        evidence: evidencePaths(evidence, context),
        metrics: { coverage: evidence.coverage || 'UNKNOWN' },
        error: { code: 'STABILITY_EVIDENCE_MISSING', message: `${definition.id} 缺少稳定性证据` }
      });
    }
    return createScenarioResult(definition, {
      status: item.status,
      durationMs: Math.round((performance.now() - started) * 100) / 100,
      assertions: item.assertions,
      evidence: evidencePaths(evidence, context),
      metrics: { coverage: evidence.coverage, ...(item.metrics || {}) },
      error: item.error || null
    });
  }
])));
