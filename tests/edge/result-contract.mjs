import { SCENARIOS } from './scenario-manifest.mjs';

export const TERMINAL_STATUSES = Object.freeze(['PASS', 'FAIL', 'BLOCKED']);

export function createScenarioResult(definition, overrides = {}) {
  if (!definition || typeof definition !== 'object') {
    throw new TypeError('scenario definition is required');
  }
  return {
    id: String(definition.id),
    title: String(definition.title),
    group: String(definition.group),
    surface: String(definition.surface),
    status: 'BLOCKED',
    durationMs: 0,
    assertions: [],
    evidence: [],
    metrics: {},
    error: null,
    ...structuredClone(overrides)
  };
}
function requiredText(value, field, errors) {
  if (typeof value !== 'string' || value.trim() === '') errors.push(`${field} 缺失`);
}

function validateScenario(scenario, definition, errors) {
  const prefix = definition?.id || String(scenario?.id || '(未知场景)');
  if (!scenario || typeof scenario !== 'object' || Array.isArray(scenario)) {
    errors.push(`${prefix}: 结果不是对象`);
    return;
  }
  if (scenario.id !== definition.id) errors.push(`${prefix}: 场景编号或顺序不一致`);
  if (!TERMINAL_STATUSES.includes(scenario.status)) errors.push(`${prefix}: 非终态 status`);
  if (!Number.isFinite(scenario.durationMs) || scenario.durationMs < 0) {
    errors.push(`${prefix}: durationMs 无效`);
  }
  if (!Array.isArray(scenario.assertions)) errors.push(`${prefix}: assertions 不是数组`);
  if (!Array.isArray(scenario.evidence)) errors.push(`${prefix}: evidence 不是数组`);
  if (scenario.status === 'PASS') {
    if (!Array.isArray(scenario.assertions) || scenario.assertions.length === 0 ||
        !Array.isArray(scenario.evidence) || scenario.evidence.length === 0) {
      errors.push(`${prefix}: PASS 缺少 assertions 或 evidence`);
      return;
    }
    if (scenario.assertions.some(item => !item || item.ok !== true || typeof item.key !== 'string')) {
      errors.push(`${prefix}: PASS 包含未通过或无键断言`);
    }
    if (scenario.evidence.some(item => typeof item !== 'string' || item.trim() === '')) {
      errors.push(`${prefix}: PASS 包含无效 evidence`);
    }
  }
  if (scenario.status !== 'PASS' && (!scenario.error || typeof scenario.error !== 'object')) {
    errors.push(`${prefix}: ${scenario.status} 缺少结构化 error`);
  }
}

export function validateRunResult(value) {
  const errors = [];
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, errors: ['run 结果不是对象'] };
  }
  if (value.schemaVersion !== 1) errors.push('schemaVersion 必须为 1');
  requiredText(value.runId, 'runId', errors);
  if (!['quick', 'full'].includes(value.mode)) errors.push('mode 必须为 quick 或 full');
  if (value.mode === 'quick' && value.coverage !== 'FAST_COVERAGE') {
    errors.push('quick 模式 coverage 必须为 FAST_COVERAGE');
  }
  if (value.mode === 'full' && value.coverage !== 'FULL') errors.push('full 模式 coverage 必须为 FULL');
  requiredText(value.startedAt, 'startedAt', errors);
  requiredText(value.finishedAt, 'finishedAt', errors);
  if (!Number.isFinite(value.durationMs) || value.durationMs < 0) errors.push('durationMs 无效');
  if (!Array.isArray(value.scenarios)) {
    errors.push('scenarios 不是数组');
  } else if (value.scenarios.length !== SCENARIOS.length) {
    errors.push(`scenarios 必须恰好包含 ${SCENARIOS.length} 条`);
  } else {
    value.scenarios.forEach((scenario, index) => validateScenario(scenario, SCENARIOS[index], errors));
  }
  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}
