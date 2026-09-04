import { randomBytes } from 'node:crypto';
import * as defaultFileSystem from 'node:fs/promises';
import path from 'node:path';

import { CHAOS_ACTIVITIES } from './chaos-planner.mjs';
import { validateWorkflowActionContract } from './actions.mjs';

const REQUIRED_FIELDS = Object.freeze([
  'schemaVersion',
  'plannerVersion',
  'runId',
  'mode',
  'startedAt',
  'finishedAt',
  'status',
  'fixtureSha256',
  'protectedVerification',
  'seed',
  'plannedActions',
  'workflows',
  'failure',
  'lastSuccessfulActionId'
]);
const OPTIONAL_FIELDS = Object.freeze(['edgeFull']);
const INPUT_FIELDS = new Set([...REQUIRED_FIELDS, ...OPTIONAL_FIELDS]);
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const SAFE_SEGMENT_PATTERN = /^[A-Za-z0-9._-]+$/;
const ACTION_OUTCOMES = new Set(['success', 'warning', 'cancelled', 'rejected', 'failure']);
const PATH_KEYS = new Set(['path', 'file', 'sourcePath', 'targetPath', 'destinationPath']);
const STATE_SUMMARY_KEYS = Object.freeze([
  'revision', 'devices', 'channels', 'requests', 'samples', 'records', 'storageRecords',
  'audits', 'journalEntries', 'runningRecords', 'reservedRecords', 'activeRecords'
]);
const AUDIT_ENTRY_KEYS = Object.freeze(['id', 'action', 'target', 'result', 'verified', 'time', 'field']);
const AUDIT_POLICY_SUMMARY_KEYS = Object.freeze(['committed', 'skipped', 'covered', 'validCount']);
const AUDIT_POLICY_ERROR_KEYS = Object.freeze(['file', 'requestNo', 'code', 'message']);
const MAX_EVIDENCE_TEXT_LENGTH = 256;
const MAX_EVIDENCE_ITEMS = 32;
const MAX_DIAGNOSTIC_MESSAGES = 3;

function schemaError(message, code = 'WORKFLOW_REPORT_SCHEMA_INVALID') {
  const error = new TypeError(message);
  error.code = code;
  error.exitCode = 2;
  return error;
}

function plainValue(value, seen = new WeakSet()) {
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      ...(value.code !== undefined ? { code: value.code } : {}),
      ...(value.stack ? { stack: value.stack } : {}),
      ...(value.cause !== undefined ? { cause: plainValue(value.cause, seen) } : {})
    };
  }
  if (Array.isArray(value)) return value.map(item => plainValue(item, seen));
  if (!value || typeof value !== 'object') return value;
  if (seen.has(value)) throw schemaError('workflow report must not contain circular values');
  seen.add(value);
  const output = {};
  for (const [key, item] of Object.entries(value)) {
    if (item !== undefined) output[key] = plainValue(item, seen);
  }
  seen.delete(value);
  return output;
}

function compactText(value) {
  if (typeof value !== 'string') return null;
  if (value.length <= MAX_EVIDENCE_TEXT_LENGTH) return value;
  return `${value.slice(0, MAX_EVIDENCE_TEXT_LENGTH)}… [truncated ${value.length - MAX_EVIDENCE_TEXT_LENGTH} chars]`;
}

function compactStringList(value, maximum = MAX_EVIDENCE_ITEMS) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, maximum).map(item => compactText(String(item)) ?? '');
}

function compactStateSummary(value) {
  const summary = {};
  for (const key of STATE_SUMMARY_KEYS) {
    if (Number.isFinite(value?.[key])) summary[key] = value[key];
  }
  return summary;
}

function compactUiEvidence(value) {
  if (!isPlainObject(value)) return null;
  const projection = isPlainObject(value.projection) ? value.projection : {};
  const summary = compactStateSummary(projection.summary);
  const consoleErrors = compactStringList(value.consoleErrors ?? value.console?.errors, MAX_DIAGNOSTIC_MESSAGES);
  const pageErrors = compactStringList(value.pageErrors, MAX_DIAGNOSTIC_MESSAGES);
  return {
    ...(compactText(projection.currentPage) ? { currentPage: compactText(projection.currentPage) } : {}),
    ...(Object.keys(summary).length ? { stateSummary: summary } : {}),
    consoleErrorCount: Array.isArray(value.consoleErrors ?? value.console?.errors) ? (value.consoleErrors ?? value.console.errors).length : 0,
    pageErrorCount: Array.isArray(value.pageErrors) ? value.pageErrors.length : 0,
    ...(consoleErrors.length ? { consoleErrors } : {}),
    ...(pageErrors.length ? { pageErrors } : {})
  };
}

function compactAuditPolicySummary(value) {
  if (!isPlainObject(value)) return value === null ? null : undefined;
  const summary = {};
  for (const key of AUDIT_POLICY_SUMMARY_KEYS) {
    const item = value[key];
    if (typeof item === 'number' || typeof item === 'boolean') summary[key] = item;
    else if (typeof item === 'string') summary[key] = compactText(item);
  }
  if (Array.isArray(value.errors)) {
    summary.errors = value.errors.slice(0, MAX_EVIDENCE_ITEMS).map(error => {
      if (!isPlainObject(error)) return { message: compactText(String(error)) ?? '' };
      const compact = {};
      for (const key of AUDIT_POLICY_ERROR_KEYS) {
        if (typeof error[key] === 'string') compact[key] = compactText(error[key]);
      }
      return compact;
    });
    if (value.errors.length > MAX_EVIDENCE_ITEMS) summary.errors.push({ omittedCount: value.errors.length - MAX_EVIDENCE_ITEMS });
  }
  return summary;
}

function compactAuditEntries(value) {
  if (!Array.isArray(value)) return [];
  const entries = value.slice(0, MAX_EVIDENCE_ITEMS).map(item => {
    if (!isPlainObject(item)) return { value: compactText(String(item)) ?? '' };
    const compact = {};
    for (const key of AUDIT_ENTRY_KEYS) {
      const entryValue = item[key];
      if (typeof entryValue === 'string') compact[key] = compactText(entryValue);
      else if (typeof entryValue === 'number' || typeof entryValue === 'boolean') compact[key] = entryValue;
    }
    const before = compactAuditPolicySummary(item.before);
    const after = compactAuditPolicySummary(item.after);
    if (before !== undefined) compact.before = before;
    if (after !== undefined) compact.after = after;
    if (typeof item.note === 'string') compact.note = compactText(item.note);
    return compact;
  });
  if (value.length > MAX_EVIDENCE_ITEMS) entries.push({ omittedCount: value.length - MAX_EVIDENCE_ITEMS });
  return entries;
}

function compactAuditEvidence(value) {
  return {
    auditLogs: compactAuditEntries(value.auditLogs),
    formJournal: compactAuditEntries(value.formJournal)
  };
}

function compactViolation(value) {
  return {
    code: value.code,
    severity: value.severity,
    message: compactText(value.message) ?? '',
    entityIds: compactStringList(value.entityIds)
  };
}

function compactError(value) {
  if (!isPlainObject(value)) return value;
  return {
    ...(typeof value.name === 'string' ? { name: compactText(value.name) ?? '' } : {}),
    message: compactText(value.message) ?? '',
    ...(typeof value.code === 'string' || typeof value.code === 'number' ? { code: value.code } : {}),
    ...(isPlainObject(value.cause) ? { cause: compactError(value.cause) } : {})
  };
}

function compactFailure(value) {
  if (!isPlainObject(value)) return value;
  return {
    ...value,
    ...(value.error !== undefined ? { error: compactError(value.error) } : {}),
    ...(value.violation !== undefined ? { violation: compactViolation(value.violation) } : {}),
    ...(value.protection !== undefined ? { protection: compactProtectionEvidence(value.protection) } : {}),
    ...(value.cleanup !== undefined ? { cleanup: compactCleanup(value.cleanup) } : {}),
    ...(value.finishedAtError !== undefined ? { finishedAtError: compactError(value.finishedAtError) } : {})
  };
}

function compactCleanup(value) {
  if (!isPlainObject(value)) return value;
  return {
    ...value,
    ...(value.error !== undefined ? { error: compactError(value.error) } : {}),
    ...(Array.isArray(value.drivers) ? {
      drivers: value.drivers.map(driver => ({
        ...driver,
        ...(driver?.error !== undefined ? { error: compactError(driver.error) } : {})
      }))
    } : {})
  };
}

function compactProtectionEvidence(value) {
  if (!isPlainObject(value)) return value;
  return {
    ...value,
    ...(value.error !== undefined ? { error: compactError(value.error) } : {}),
    ...(value.violation !== undefined ? { violation: compactViolation(value.violation) } : {})
  };
}

function compactRestartEvidence(value) {
  if (!isPlainObject(value)) return value;
  return {
    ...value,
    ...(value.cleanup !== undefined ? { cleanup: compactCleanup(value.cleanup) } : {})
  };
}

function compactSettlement(value, actionType) {
  if (value === null) return null;
  if (typeof actionType !== 'string' || actionType.trim() === '') throw schemaError('settlement action type is required');
  return {
    actionType,
    ...(compactText(value.mode) ? { mode: compactText(value.mode) } : {}),
    ...(compactText(value.outcome) ? { outcome: compactText(value.outcome) } : {}),
    ...(compactText(value.message) ? { message: compactText(value.message) } : {}),
    ...(Number.isInteger(value.beforeRevision) ? { beforeRevision: value.beforeRevision } : {}),
    ...(Number.isInteger(value.persistedRevision) ? { persistedRevision: value.persistedRevision } : {}),
    auditIds: compactStringList(value.auditIds),
    auditCount: Array.isArray(value.auditIds) ? value.auditIds.length : 0,
    ...(compactText(value.finalPage) ? { finalPage: compactText(value.finalPage) } : {}),
    ...(isPlainObject(value.uiEvidence) ? { uiSummary: compactUiEvidence(value.uiEvidence) } : {})
  };
}

function compactStep(step, actionType) {
  return {
    ...step,
    settlement: compactSettlement(step.settlement, actionType),
    stateSummaryBefore: compactStateSummary(step.stateSummaryBefore),
    stateSummaryAfter: compactStateSummary(step.stateSummaryAfter),
    uiEvidence: compactUiEvidence(step.uiEvidence),
    auditEvidence: compactAuditEvidence(step.auditEvidence),
    violations: step.violations.map(compactViolation)
  };
}

function compactReportEvidence(report) {
  return {
    ...report,
    workflows: report.workflows.map(workflow => {
      const actions = new Map([
        ...(Array.isArray(report.plannedActions) ? report.plannedActions : []),
        ...(Array.isArray(workflow.plannedActions) ? workflow.plannedActions : [])
      ].map(action => [action.id, action]));
      return {
        ...workflow,
        steps: workflow.steps.map(step => compactStep(step, actions.get(step.actionId)?.type)),
        ...(workflow.failure !== undefined ? { failure: compactFailure(workflow.failure) } : {}),
        ...(workflow.cleanup !== undefined ? { cleanup: compactCleanup(workflow.cleanup) } : {}),
        ...(workflow.protection !== undefined ? { protection: compactProtectionEvidence(workflow.protection) } : {}),
        ...(workflow.restart !== undefined ? { restart: compactRestartEvidence(workflow.restart) } : {})
      };
    }),
    ...(report.failure !== null ? { failure: compactFailure(report.failure) } : {})
  };
}

function validIso(value, field) {
  if (typeof value !== 'string' || value === '' || Number.isNaN(Date.parse(value))) {
    throw schemaError(`${field} must be an ISO date-time string`);
  }
  if (new Date(value).toISOString() !== value) throw schemaError(`${field} must be canonical ISO date-time`);
}

function validSeed(value) {
  return value === null || (Number.isSafeInteger(value) && value >= 0 && value <= 0xffff_ffff);
}

function validHash(value) {
  return value === null || (typeof value === 'string' && SHA256_PATTERN.test(value));
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function safeRelativePath(value, field) {
  if (typeof value !== 'string' || value.trim() === '') throw schemaError(`${field} must be a non-empty relative path`);
  const normalized = value.replaceAll('\\', '/');
  if (path.isAbsolute(value) || path.win32.isAbsolute(value) || normalized.startsWith('/') || normalized.split('/').includes('..')) {
    throw schemaError(`${field} must be a safe relative path`);
  }
  return normalized;
}

function validatePathValues(value, parentKey = '') {
  if (Array.isArray(value)) {
    value.forEach(item => validatePathValues(item, parentKey));
    return;
  }
  if (!isPlainObject(value)) return;
  for (const [key, item] of Object.entries(value)) {
    if (PATH_KEYS.has(key) && typeof item === 'string') safeRelativePath(item, `plannedActions.params.${key}`);
    else validatePathValues(item, key);
  }
}

function validateDelta(value, field) {
  if (Number.isInteger(value)) return;
  if (Array.isArray(value) && value.length > 0 && value.every(Number.isInteger)) return;
  throw schemaError(`${field} must be an integer or non-empty integer array`);
}

function validateAction(action, index, { replay = true } = {}) {
  if (!isPlainObject(action)) throw schemaError(`plannedActions[${index}] must be an object`);
  const requiredFields = ['id', 'type', 'params', 'expect', 'revisionDelta', 'maxMs'];
  if (replay) requiredFields.splice(5, 0, 'evidenceRevisionDelta');
  for (const field of requiredFields) {
    if (action[field] === undefined) throw schemaError(`plannedActions[${index}] missing ${field}`);
  }
  if (typeof action.id !== 'string' || action.id.trim() === '') throw schemaError(`plannedActions[${index}].id must be non-empty`);
  if (typeof action.type !== 'string' || action.type.trim() === '') throw schemaError(`plannedActions[${index}].type must be non-empty`);
  if (!isPlainObject(action.params)) throw schemaError(`plannedActions[${index}].params must be an object`);
  if (!ACTION_OUTCOMES.has(action.expect)) throw schemaError(`plannedActions[${index}].expect is invalid`);
  validateDelta(action.revisionDelta, `plannedActions[${index}].revisionDelta`);
  if (action.evidenceRevisionDelta !== undefined) {
    validateDelta(action.evidenceRevisionDelta, `plannedActions[${index}].evidenceRevisionDelta`);
  }
  if (!Number.isFinite(action.maxMs) || action.maxMs <= 0) throw schemaError(`plannedActions[${index}].maxMs must be positive`);
  validatePathValues(action.params);
  try {
    validateWorkflowActionContract(action, { requireFullPayload: replay });
  } catch (error) {
    throw schemaError(`plannedActions[${index}] action contract invalid: ${error.message}`);
  }
}

function validateProtection(value) {
  if (!isPlainObject(value) || typeof value.ok !== 'boolean') {
    throw schemaError('protectedVerification must be an object with boolean ok');
  }
  if (value.changed !== undefined && !Array.isArray(value.changed)) throw schemaError('protectedVerification.changed must be an array');
  if (value.files !== undefined && !Array.isArray(value.files)) throw schemaError('protectedVerification.files must be an array');
}

function validateEdgeFull(edgeFull) {
  if (!isPlainObject(edgeFull)) throw schemaError('edgeFull must be an object');
  const fields = ['command', 'stdout', 'stderr', 'exitCode', 'signal', 'timedOut', 'reportPath'];
  if (Object.keys(edgeFull).length !== fields.length || fields.some(field => !(field in edgeFull))) {
    throw schemaError('edgeFull fields do not match the schema');
  }
  if (edgeFull.command !== 'npm run test:edge:full') throw schemaError('edgeFull.command must use the fixed whitelist command');
  if (typeof edgeFull.stdout !== 'string' || typeof edgeFull.stderr !== 'string') throw schemaError('edgeFull output must be strings');
  if (!(edgeFull.exitCode === null || Number.isInteger(edgeFull.exitCode))) throw schemaError('edgeFull.exitCode must be an integer or null');
  if (!(edgeFull.signal === null || (typeof edgeFull.signal === 'string' && edgeFull.signal !== ''))) throw schemaError('edgeFull.signal must be a string or null');
  if (typeof edgeFull.timedOut !== 'boolean') throw schemaError('edgeFull.timedOut must be boolean');
  if (edgeFull.reportPath !== null) {
    const normalized = safeRelativePath(edgeFull.reportPath, 'edgeFull.reportPath');
    if (!normalized.startsWith('edge-full/')) throw schemaError('edgeFull.reportPath must be below fixed edge-full root');
  }
}

function exactObject(value, { label, required = [], allowed = required }) {
  if (!isPlainObject(value)) throw schemaError(`${label} must be an object`);
  const keys = Object.keys(value);
  for (const field of required) {
    if (!keys.includes(field)) throw schemaError(`${label} missing field ${field}`);
  }
  for (const field of keys) {
    if (!allowed.includes(field)) throw schemaError(`${label} contains unexpected field ${field}`);
  }
  return value;
}

function nullableNonEmptyString(value, field) {
  if (!(value === null || (typeof value === 'string' && value.trim() !== ''))) {
    throw schemaError(`${field} must be a non-empty string or null`);
  }
}

function validateError(value, field) {
  exactObject(value, {
    label: field,
    required: ['message'],
    allowed: ['name', 'message', 'code', 'stack', 'cause']
  });
  if (typeof value.message !== 'string' || value.message === '') throw schemaError(`${field}.message must be non-empty`);
  if (value.name !== undefined && (typeof value.name !== 'string' || value.name === '')) throw schemaError(`${field}.name must be non-empty`);
  if (value.stack !== undefined && typeof value.stack !== 'string') throw schemaError(`${field}.stack must be a string`);
  if (value.code !== undefined && !['string', 'number'].includes(typeof value.code)) throw schemaError(`${field}.code must be a string or number`);
  if (value.cause !== undefined && isPlainObject(value.cause)) validateError(value.cause, `${field}.cause`);
}

function validateViolation(value, field) {
  exactObject(value, {
    label: field,
    required: ['code', 'severity', 'message', 'entityIds']
  });
  if (typeof value.code !== 'string' || value.code.trim() === '') throw schemaError(`${field}.code must be non-empty`);
  if (!['P0', 'P1', 'P2'].includes(value.severity)) throw schemaError(`${field}.severity is invalid`);
  if (typeof value.message !== 'string' || value.message.trim() === '') throw schemaError(`${field}.message must be non-empty`);
  if (!Array.isArray(value.entityIds) || value.entityIds.some(item => typeof item !== 'string')) {
    throw schemaError(`${field}.entityIds must be a string array`);
  }
}

function validateCleanup(value, field) {
  exactObject(value, {
    label: field,
    required: ['status'],
    allowed: ['status', 'drivers', 'timeoutMs', 'error']
  });
  if (!['not_started', 'closed', 'failed', 'timed_out'].includes(value.status)) throw schemaError(`${field}.status is invalid`);
  if (value.drivers !== undefined) {
    if (!Array.isArray(value.drivers)) throw schemaError(`${field}.drivers must be an array`);
    for (const [index, driver] of value.drivers.entries()) {
      exactObject(driver, {
        label: `${field}.drivers[${index}]`, required: ['name', 'status'], allowed: ['name', 'status', 'timeoutMs', 'error']
      });
      if (typeof driver.name !== 'string' || driver.name === '') throw schemaError(`${field}.drivers[${index}].name must be non-empty`);
      if (!['closed', 'failed', 'timed_out'].includes(driver.status)) throw schemaError(`${field}.drivers[${index}].status is invalid`);
      if (driver.error !== undefined) validateError(driver.error, `${field}.drivers[${index}].error`);
    }
  }
  if (value.timeoutMs !== undefined && (!Number.isFinite(value.timeoutMs) || value.timeoutMs <= 0)) throw schemaError(`${field}.timeoutMs must be positive`);
  if (value.error !== undefined) validateError(value.error, `${field}.error`);
}

function validateProtectionEvidence(value, field) {
  exactObject(value, {
    label: field,
    required: ['status'],
    allowed: ['status', 'verification', 'violation', 'stage', 'error']
  });
  if (!['passed', 'failed'].includes(value.status)) throw schemaError(`${field}.status is invalid`);
  if (value.verification !== undefined) validateProtection(value.verification);
  if (value.violation !== undefined) validateViolation(value.violation, `${field}.violation`);
  if (value.error !== undefined) validateError(value.error, `${field}.error`);
  if (value.stage !== undefined && (typeof value.stage !== 'string' || value.stage === '')) throw schemaError(`${field}.stage must be non-empty`);
  if (value.status === 'passed' && (value.violation !== undefined || value.error !== undefined || value.verification?.ok !== true)) {
    throw schemaError(`${field} passed status requires successful verification only`);
  }
  if (value.status === 'failed' && value.violation === undefined && value.error === undefined) throw schemaError(`${field} failed status needs violation or error`);
}

function validateFailure(value, field) {
  exactObject(value, {
    label: field,
    allowed: ['workflowId', 'stage', 'actionId', 'error', 'violation', 'protection', 'cleanup', 'finishedAtError']
  });
  if (value.workflowId !== undefined) nullableNonEmptyString(value.workflowId, `${field}.workflowId`);
  if (value.stage !== undefined && (typeof value.stage !== 'string' || value.stage.trim() === '')) throw schemaError(`${field}.stage must be non-empty`);
  if (value.actionId !== undefined) nullableNonEmptyString(value.actionId, `${field}.actionId`);
  if (value.error !== undefined) validateError(value.error, `${field}.error`);
  if (value.violation !== undefined) validateViolation(value.violation, `${field}.violation`);
  if (value.protection !== undefined) validateProtectionEvidence(value.protection, `${field}.protection`);
  if (value.cleanup !== undefined) validateCleanup(value.cleanup, `${field}.cleanup`);
  if (value.finishedAtError !== undefined) validateError(value.finishedAtError, `${field}.finishedAtError`);
  if (![value.error, value.violation, value.protection, value.cleanup, value.finishedAtError].some(item => item !== undefined)) {
    throw schemaError(`${field} must include failure evidence`);
  }
}

function validateWorkflowEvidence(value, field) {
  exactObject(value, { label: field, required: ['lastScreenshot', 'beforeClose', 'afterRestart'] });
  safeRelativePath(value.lastScreenshot, `${field}.lastScreenshot`);
  if (!isPlainObject(value.beforeClose) || !isPlainObject(value.afterRestart)) throw schemaError(`${field} close/restart snapshots must be objects`);
}

function validateStep(value, workflowIndex, stepIndex) {
  const field = `workflows[${workflowIndex}].steps[${stepIndex}]`;
  exactObject(value, {
    label: field,
    required: ['actionId', 'outcome', 'revisionBefore', 'revisionAfter', 'settlement', 'stateSummaryBefore', 'stateSummaryAfter', 'uiEvidence', 'auditEvidence', 'violations']
  });
  if (typeof value.actionId !== 'string' || value.actionId.trim() === '') throw schemaError(`${field}.actionId must be non-empty`);
  if (!ACTION_OUTCOMES.has(value.outcome)) throw schemaError(`${field}.outcome is invalid`);
  if (!Number.isInteger(value.revisionBefore) || !Number.isInteger(value.revisionAfter)) throw schemaError(`${field} revisions must be integers`);
  if (!(value.settlement === null || isPlainObject(value.settlement))) throw schemaError(`${field}.settlement must be an object or null`);
  if (!isPlainObject(value.stateSummaryBefore) || !isPlainObject(value.stateSummaryAfter)) throw schemaError(`${field} state summaries must be objects`);
  if (!(value.uiEvidence === null || isPlainObject(value.uiEvidence))) throw schemaError(`${field}.uiEvidence must be an object or null`);
  exactObject(value.auditEvidence, { label: `${field}.auditEvidence`, required: ['auditLogs', 'formJournal'] });
  if (!Array.isArray(value.auditEvidence.auditLogs) || !Array.isArray(value.auditEvidence.formJournal)) throw schemaError(`${field}.auditEvidence values must be arrays`);
  if (!Array.isArray(value.violations)) throw schemaError(`${field}.violations must be an array`);
  value.violations.forEach((violation, index) => validateViolation(violation, `${field}.violations[${index}]`));
}

function validateRestartEvidence(value, field) {
  exactObject(value, {
    label: field,
    required: ['profileRoot', 'violations', 'cleanup'],
    allowed: ['profileRoot', 'durableSnapshot', 'businessHashBefore', 'invariantRuns', 'violations', 'snapshot', 'ui', 'businessHashAfter', 'cleanup']
  });
  if (!(value.profileRoot === null || (typeof value.profileRoot === 'string' && value.profileRoot !== ''))) throw schemaError(`${field}.profileRoot must be a string or null`);
  if (!Array.isArray(value.violations)) throw schemaError(`${field}.violations must be an array`);
  value.violations.forEach((violation, index) => validateViolation(violation, `${field}.violations[${index}]`));
  if (value.invariantRuns !== undefined) {
    if (!Array.isArray(value.invariantRuns)) throw schemaError(`${field}.invariantRuns must be an array`);
    for (const [index, run] of value.invariantRuns.entries()) {
      exactObject(run, { label: `${field}.invariantRuns[${index}]`, required: ['stage', 'violations'] });
      if (typeof run.stage !== 'string' || run.stage === '' || !Array.isArray(run.violations)) throw schemaError(`${field}.invariantRuns[${index}] is invalid`);
      run.violations.forEach((violation, violationIndex) => validateViolation(violation, `${field}.invariantRuns[${index}].violations[${violationIndex}]`));
    }
  }
  validateCleanup(value.cleanup, `${field}.cleanup`);
}

function validateWorkflowEntry(workflow, index) {
  const field = `workflows[${index}]`;
  exactObject(workflow, {
    label: field,
    required: ['workflowId', 'status', 'steps', 'plannedActions', 'lastSuccessfulActionId'],
    allowed: ['workflowId', 'fixture', 'fixtureSha256', 'seed', 'status', 'startedAt', 'finishedAt', 'steps', 'plannedActions', 'lastSuccessfulActionId', 'failure', 'evidence', 'restart', 'protection', 'cleanup']
  });
  if (typeof workflow.workflowId !== 'string' || workflow.workflowId.trim() === '') throw schemaError(`${field}.workflowId must be non-empty`);
  if (!['passed', 'failed'].includes(workflow.status)) throw schemaError(`${field}.status must be passed or failed`);
  if (workflow.startedAt !== undefined && workflow.startedAt !== null) validIso(workflow.startedAt, `${field}.startedAt`);
  if (workflow.finishedAt !== undefined && workflow.finishedAt !== null) validIso(workflow.finishedAt, `${field}.finishedAt`);
  if (workflow.startedAt && workflow.finishedAt && Date.parse(workflow.finishedAt) < Date.parse(workflow.startedAt)) throw schemaError(`${field}.finishedAt must not precede startedAt`);
  if (workflow.fixture !== undefined && (typeof workflow.fixture !== 'string' || workflow.fixture.trim() === '')) throw schemaError(`${field}.fixture must be non-empty`);
  if (workflow.fixtureSha256 !== undefined && !validHash(workflow.fixtureSha256)) throw schemaError(`${field}.fixtureSha256 is invalid`);
  if (workflow.seed !== undefined && !validSeed(workflow.seed)) throw schemaError(`${field}.seed is invalid`);
  if (!Array.isArray(workflow.steps)) throw schemaError(`${field}.steps must be an array`);
  workflow.steps.forEach((step, stepIndex) => validateStep(step, index, stepIndex));
  if (!Array.isArray(workflow.plannedActions)) throw schemaError(`${field}.plannedActions must be an array`);
  workflow.plannedActions.forEach((action, actionIndex) => validateAction(action, actionIndex, { replay: false }));
  nullableNonEmptyString(workflow.lastSuccessfulActionId, `${field}.lastSuccessfulActionId`);
  const actionIds = new Set(workflow.plannedActions.map(action => action.id));
  if (actionIds.size !== workflow.plannedActions.length) throw schemaError(`${field}.plannedActions action ids must be unique`);
  if (workflow.lastSuccessfulActionId !== null && !actionIds.has(workflow.lastSuccessfulActionId)) throw schemaError(`${field}.lastSuccessfulActionId must identify a planned action`);
  if (workflow.status === 'failed') {
    if (!isPlainObject(workflow.failure)) throw schemaError(`${field} failed status requires failure`);
    validateFailure(workflow.failure, `${field}.failure`);
  } else if (workflow.failure !== undefined && workflow.failure !== null) {
    throw schemaError(`${field} passed status must not include failure`);
  }
  if (workflow.evidence !== undefined) validateWorkflowEvidence(workflow.evidence, `${field}.evidence`);
  if (workflow.restart !== undefined) validateRestartEvidence(workflow.restart, `${field}.restart`);
  if (workflow.protection !== undefined) validateProtectionEvidence(workflow.protection, `${field}.protection`);
  if (workflow.cleanup !== undefined) validateCleanup(workflow.cleanup, `${field}.cleanup`);
}

function failureWorkflowMatches(report) {
  const chaosFailure = Object.hasOwn(CHAOS_ACTIVITIES, report.failure.workflowId);
  if (chaosFailure && !Number.isSafeInteger(report.seed)) return [];
  const failureSeed = chaosFailure ? report.seed : (report.seed ?? null);
  return report.workflows.filter(workflow => (
    workflow.workflowId === report.failure.workflowId
      && (chaosFailure ? workflow.seed : (workflow.seed ?? null)) === failureSeed
  ));
}

export function validateWorkflowReport(value) {
  if (!isPlainObject(value)) throw schemaError('workflow report must be an object');
  const keys = Object.keys(value);
  for (const field of REQUIRED_FIELDS) {
    if (!keys.includes(field)) throw schemaError(`workflow report missing field ${field}`);
  }
  for (const key of keys) {
    if (!INPUT_FIELDS.has(key)) throw schemaError(`workflow report contains unexpected field ${key}`);
  }
  if (value.schemaVersion !== 1) throw schemaError('schemaVersion must be 1');
  if (value.plannerVersion !== 1) throw schemaError('plannerVersion must be 1');
  if (typeof value.runId !== 'string' || !SAFE_SEGMENT_PATTERN.test(value.runId) || ['.', '..'].includes(value.runId)) {
    throw schemaError('runId must be a safe non-empty segment');
  }
  if (!['quick', 'full', 'replay'].includes(value.mode)) throw schemaError('mode must be quick, full, or replay');
  validIso(value.startedAt, 'startedAt');
  validIso(value.finishedAt, 'finishedAt');
  if (Date.parse(value.finishedAt) < Date.parse(value.startedAt)) throw schemaError('finishedAt must not precede startedAt');
  if (!['passed', 'failed'].includes(value.status)) throw schemaError('status must be passed or failed');
  if (!validHash(value.fixtureSha256)) throw schemaError('fixtureSha256 must be a lowercase SHA-256 or null');
  validateProtection(value.protectedVerification);
  if (!validSeed(value.seed)) throw schemaError('seed must be a decimal uint32 integer or null');
  if (!Array.isArray(value.plannedActions)) throw schemaError('plannedActions must be an array');
  value.plannedActions.forEach(validateAction);
  if (value.plannedActions.length > 0 && (typeof value.fixtureSha256 !== 'string' || !Number.isSafeInteger(value.seed))) {
    throw schemaError('non-empty plannedActions require a valid fixtureSha256 and seed');
  }
  if (!Array.isArray(value.workflows) || value.workflows.length === 0 || !value.workflows.every(isPlainObject)) {
    throw schemaError('workflows must be a non-empty object array');
  }
  value.workflows.forEach(validateWorkflowEntry);
  if (value.status === 'passed' && value.failure !== null) throw schemaError('passed report failure must be null');
  if (value.status === 'failed' && !isPlainObject(value.failure)) throw schemaError('failed report failure must be an object');
  if (value.failure !== null) validateFailure(value.failure, 'failure');
  if (value.failure?.workflowId !== null && value.failure?.workflowId !== undefined) {
    const matches = failureWorkflowMatches(value);
    if (matches.length !== 1) throw schemaError('failure workflowId and seed must identify exactly one workflow');
  }
  if (value.protectedVerification.ok === false && value.status !== 'failed') {
    throw schemaError('protected verification failure requires failed status');
  }
  if (!(value.lastSuccessfulActionId === null || (typeof value.lastSuccessfulActionId === 'string' && value.lastSuccessfulActionId !== ''))) {
    throw schemaError('lastSuccessfulActionId must be a non-empty string or null');
  }
  if (value.edgeFull !== undefined) {
    validateEdgeFull(value.edgeFull);
    if ((value.edgeFull.timedOut || value.edgeFull.signal !== null || value.edgeFull.exitCode !== 0 || value.edgeFull.reportPath === null) && value.status !== 'failed') {
      throw schemaError('Edge full failure requires failed status');
    }
  }
  return value;
}

function reportFrom(runContext, result) {
  if (!runContext || typeof runContext !== 'object') throw new TypeError('runContext is required');
  if (typeof runContext.runId !== 'string' || typeof runContext.runRoot !== 'string' || typeof runContext.artifactsRoot !== 'string') {
    throw new TypeError('runContext runId, runRoot, and artifactsRoot are required');
  }
  if (typeof runContext.assertWritable !== 'function') throw new TypeError('runContext.assertWritable is required');
  if (!isPlainObject(result)) throw schemaError('result must be an object');
  const allowedInput = new Set(REQUIRED_FIELDS.filter(field => field !== 'runId'));
  allowedInput.add('runId');
  allowedInput.add('edgeFull');
  for (const key of Object.keys(result)) {
    if (!allowedInput.has(key)) throw schemaError(`workflow report contains unexpected field ${key}`);
  }
  const report = {
    schemaVersion: result.schemaVersion,
    plannerVersion: result.plannerVersion,
    runId: result.runId ?? runContext.runId,
    mode: result.mode ?? runContext.mode,
    startedAt: result.startedAt,
    finishedAt: result.finishedAt,
    status: result.status,
    fixtureSha256: result.fixtureSha256,
    protectedVerification: result.protectedVerification,
    seed: result.seed,
    plannedActions: result.plannedActions,
    workflows: result.workflows,
    failure: result.failure,
    lastSuccessfulActionId: result.lastSuccessfulActionId,
    ...(result.edgeFull !== undefined ? { edgeFull: result.edgeFull } : {})
  };
  const plain = plainValue(report);
  validateWorkflowReport(plain);
  const compact = compactReportEvidence(plain);
  validateWorkflowReport(compact);
  if (compact.runId !== runContext.runId) throw schemaError('report runId must match runContext.runId');
  return compact;
}

async function atomicWrite({ target, contents, validateContents, fileSystem, token }) {
  const temp = `${target}.${token}.tmp`;
  let handle;
  let created = false;
  let closed = false;
  try {
    handle = await fileSystem.open(temp, 'wx');
    created = true;
    await handle.writeFile(contents, 'utf8');
    await handle.sync();
    await handle.close();
    closed = true;
    validateContents(await fileSystem.readFile(temp, 'utf8'));
    await fileSystem.rename(temp, target);
    validateContents(await fileSystem.readFile(target, 'utf8'));
  } catch (error) {
    if (handle && !closed) {
      try { await handle.close(); } catch {}
    }
    if (created) {
      try { await fileSystem.unlink(temp); } catch (cleanupError) {
        if (cleanupError?.code !== 'ENOENT') error.cleanupError = cleanupError;
      }
    }
    throw error;
  }
}

function violationsIn(report) {
  const violations = new Map();
  const normalizedActionId = (actionId, stage) => {
    if (actionId === 'restart-verification'
      || (stage === 'restart-verification' && (actionId === null || actionId === undefined || actionId === ''))) {
      return 'restart-verification';
    }
    if (stage === 'protected-verification' || actionId === 'protected-verification') return 'protected-verification';
    return actionId ?? null;
  };
  const add = (workflowId, actionId, violation, stage = null) => {
    if (!isPlainObject(violation)) return;
    const identity = JSON.stringify([
      workflowId ?? null,
      normalizedActionId(actionId, stage),
      violation.code ?? null,
      violation.severity ?? null,
      violation.message ?? null,
      Array.isArray(violation.entityIds) ? violation.entityIds : []
    ]);
    if (!violations.has(identity)) violations.set(identity, violation);
  };
  for (const workflow of report.workflows) {
    for (const step of Array.isArray(workflow.steps) ? workflow.steps : []) {
      for (const violation of Array.isArray(step.violations) ? step.violations : []) {
        add(workflow.workflowId, step.actionId, violation);
      }
    }
    for (const violation of Array.isArray(workflow.restart?.violations) ? workflow.restart.violations : []) {
      add(workflow.workflowId, 'restart-verification', violation, 'restart-verification');
    }
    add(workflow.workflowId, workflow.failure?.actionId, workflow.failure?.violation, workflow.failure?.stage);
    add(workflow.workflowId, 'protected-verification', workflow.failure?.protection?.violation, 'protected-verification');
    add(workflow.workflowId, 'protected-verification', workflow.protection?.violation, 'protected-verification');
  }
  add(report.failure?.workflowId, report.failure?.actionId, report.failure?.violation, report.failure?.stage);
  add(report.failure?.workflowId, 'protected-verification', report.failure?.protection?.violation, 'protected-verification');
  return [...violations.values()];
}

function markdownFor(report, jsonRelativePath, replayReportPath) {
  const counts = { P0: 0, P1: 0, P2: 0 };
  for (const violation of violationsIn(report)) {
    if (counts[violation.severity] !== undefined) counts[violation.severity] += 1;
  }
  const firstFailure = report.failure?.violation?.code ?? report.failure?.error?.code ?? report.failure?.error?.message ?? '无';
  const lastSuccess = report.lastSuccessfulActionId ?? '无';
  return [
    '# 工作流自动测试报告',
    '',
    `- Run ID：${report.runId}`,
    `- 模式：${report.mode}`,
    `- 状态：${report.status}`,
    `- P0：${counts.P0}`,
    `- P1：${counts.P1}`,
    `- P2：${counts.P2}`,
    `- 首个失败：${firstFailure}`,
    `- 最后成功动作：${lastSuccess}`,
    `- 重放命令：\`npm run test:workflow:replay -- --report "${replayReportPath}"\``,
    `- JSON：${jsonRelativePath}`,
    ''
  ].join('\n');
}

export async function writeWorkflowReport({
  runContext,
  result,
  fileSystem = defaultFileSystem,
  tempToken = () => randomBytes(8).toString('hex')
}) {
  const report = reportFrom(runContext, result);
  await fileSystem.mkdir(runContext.artifactsRoot, { recursive: true });
  const jsonPath = await runContext.assertWritable(path.join(runContext.artifactsRoot, 'result.json'));
  const markdownPath = await runContext.assertWritable(path.join(runContext.artifactsRoot, '工作流自动测试报告.md'));
  const jsonContents = `${JSON.stringify(report, null, 2)}\n`;
  await atomicWrite({
    target: jsonPath,
    contents: jsonContents,
    validateContents(contents) {
      let parsed;
      try { parsed = JSON.parse(contents); } catch (error) { throw schemaError(`workflow report JSON parse failed: ${error.message}`); }
      validateWorkflowReport(parsed);
      if (JSON.stringify(parsed) !== JSON.stringify(report)) throw schemaError('workflow report JSON reread differs from finalized payload');
    },
    fileSystem,
    token: tempToken()
  });

  const finalized = JSON.parse(await fileSystem.readFile(jsonPath, 'utf8'));
  validateWorkflowReport(finalized);
  const jsonRelativePath = path.relative(runContext.runRoot, jsonPath).replaceAll('\\', '/');
  safeRelativePath(jsonRelativePath, 'JSON relative path');
  if (typeof runContext.projectRoot !== 'string' || runContext.projectRoot.trim() === '') throw new TypeError('runContext.projectRoot is required');
  const replayReportPath = path.relative(path.resolve(runContext.projectRoot), jsonPath).replaceAll('\\', '/');
  safeRelativePath(replayReportPath, 'replay report path');
  const markdownContents = markdownFor(finalized, jsonRelativePath, replayReportPath);
  await atomicWrite({
    target: markdownPath,
    contents: markdownContents,
    validateContents(contents) {
      if (contents !== markdownContents) throw schemaError('Markdown reread token validation failed', 'WORKFLOW_MARKDOWN_INVALID');
      for (const token of ['P0：', 'P1：', 'P2：', '首个失败：', '最后成功动作：', 'test:workflow:replay', replayReportPath, jsonRelativePath]) {
        if (!contents.includes(token)) throw schemaError(`Markdown missing required token ${token}`, 'WORKFLOW_MARKDOWN_INVALID');
      }
    },
    fileSystem,
    token: tempToken()
  });
  return Object.freeze({ jsonPath, markdownPath });
}

function deepFreeze(value, seen = new WeakSet()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return value;
  seen.add(value);
  for (const item of Object.values(value)) deepFreeze(item, seen);
  return Object.freeze(value);
}

export async function readReplayReport(reportPath, { fileSystem = defaultFileSystem } = {}) {
  if (typeof reportPath !== 'string' || reportPath.trim() === '') throw schemaError('replay report path is required');
  let parsed;
  try {
    parsed = JSON.parse(await fileSystem.readFile(path.resolve(reportPath), 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') throw Object.assign(schemaError(`replay report does not exist: ${reportPath}`), { code: 'REPLAY_REPORT_NOT_FOUND' });
    if (error?.code === 'WORKFLOW_REPORT_SCHEMA_INVALID') throw error;
    throw schemaError(`replay report JSON parse failed: ${error.message}`);
  }
  validateWorkflowReport(parsed);
  if (!Array.isArray(parsed.plannedActions) || parsed.plannedActions.length === 0) {
    throw schemaError('replay action list missing or empty', 'REPLAY_ACTIONS_MISSING');
  }
  if (typeof parsed.fixtureSha256 !== 'string' || !SHA256_PATTERN.test(parsed.fixtureSha256)) {
    throw schemaError('replay fixtureSha256 is invalid', 'REPLAY_FIXTURE_SHA256_INVALID');
  }
  if (!Number.isSafeInteger(parsed.seed)) throw schemaError('replay seed is invalid', 'REPLAY_SEED_INVALID');
  const failureWorkflowId = parsed.failure?.workflowId;
  if (typeof failureWorkflowId !== 'string' || !CHAOS_ACTIVITIES[failureWorkflowId]) {
    throw schemaError('replay failure must identify one exact C01-C06 activity', 'REPLAY_ACTIVITY_INVALID');
  }
  const candidates = failureWorkflowMatches(parsed);
  if (candidates.length !== 1) throw schemaError('replay report must contain one unique failed activity', 'REPLAY_ACTIVITY_INVALID');
  const [target] = candidates;
  if (target.fixture !== CHAOS_ACTIVITIES[target.workflowId].fixture) throw schemaError('replay fixture/activity contract mismatch', 'REPLAY_FIXTURE_CONTRACT_INVALID');
  if (target.fixtureSha256 !== parsed.fixtureSha256 || target.seed !== parsed.seed) {
    throw schemaError('replay fixture hash or seed differs from workflow contract', 'REPLAY_CONTRACT_MISMATCH');
  }
  if (Array.isArray(target.plannedActions) && JSON.stringify(target.plannedActions) !== JSON.stringify(parsed.plannedActions)) {
    throw schemaError('replay actions differ from workflow contract', 'REPLAY_ACTIONS_MISMATCH');
  }
  const allowedTypes = new Set([...CHAOS_ACTIVITIES[target.workflowId].actionTypes, 'restart']);
  for (const [index, action] of parsed.plannedActions.entries()) {
    validateAction(action, index);
    if (!allowedTypes.has(action.type)) throw schemaError(`replay action ${action.type} is not valid for activity ${target.workflowId}`, 'REPLAY_ACTION_ACTIVITY_INVALID');
  }
  return deepFreeze({
    reportPath: path.resolve(reportPath),
    activityId: target.workflowId,
    fixture: target.fixture,
    fixtureSha256: parsed.fixtureSha256,
    seed: parsed.seed,
    startedAt: parsed.startedAt,
    plannedActions: structuredClone(parsed.plannedActions)
  });
}
