import { canonicalStateHash, readWorkflowSnapshot } from '../workflows/state-probe.mjs';

const COLLECTIONS = Object.freeze([
  'requests', 'samples', 'deviceProfiles', 'channels', 'records', 'storageRecords',
  'testers', 'requestSourceRows', 'formChangeJournal', 'auditLogs'
]);
const BUSINESS_COLLECTIONS = Object.freeze(COLLECTIONS.filter(name => name !== 'auditLogs'));
const ORDINARY_ACTIVE = new Set(['running', 'reserved']);
const STORAGE_ACTIVE = new Set(['storing', 'exception']);
const FAILURE_OUTCOMES = new Set(['cancelled', 'rejected', 'failure', 'failed']);

function array(value) {
  return Array.isArray(value) ? value : [];
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, stableValue(value[key])]))
}

function stableJson(value) {
  return JSON.stringify(stableValue(value));
}

function collectionHash(state, name) {
  return canonicalStateHash({ [name]: array(state?.[name]) });
}

function activeOwnership(state) {
  const ordinary = array(state?.records)
    .filter(record => ORDINARY_ACTIVE.has(String(record?.status || '')))
    .map(record => Object.freeze({
      recordId: String(record.id || ''),
      requestNo: String(record.requestNo || record.no || ''),
      sampleId: String(record.sampleId || ''),
      channelKeys: Object.freeze([...new Set([
        record.channelKey,
        ...array(record.keys)
      ].map(String).filter(Boolean))])
    }));
  const storage = array(state?.storageRecords)
    .filter(record => STORAGE_ACTIVE.has(String(record?.status || '')))
    .map(record => Object.freeze({
      storageId: String(record.id || ''),
      requestNo: String(record.requestNo || ''),
      sampleIds: Object.freeze(array(record.sampleIds).map(String).filter(Boolean))
    }));
  return Object.freeze({ ordinary: Object.freeze(ordinary), storage: Object.freeze(storage) });
}

function auditSummary(audits) {
  const actions = {};
  const outcomes = {};
  for (const audit of array(audits)) {
    const action = String(audit?.action || '(empty)');
    const outcome = String(audit?.outcome || audit?.result || '(empty)');
    actions[action] = (actions[action] || 0) + 1;
    outcomes[outcome] = (outcomes[outcome] || 0) + 1;
  }
  return Object.freeze({
    count: array(audits).length,
    actions: Object.freeze(actions),
    outcomes: Object.freeze(outcomes)
  });
}

function violationError(code, message, violations = []) {
  const error = new Error(message);
  error.code = code;
  error.violations = Object.freeze(violations.map(item => Object.freeze(item)));
  return error;
}

export function captureManualSnapshot(options = {}) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    throw new TypeError('read-only options must be an object');
  }
  const unexpected = Object.keys(options).filter(key => key !== 'dataRoot');
  if (unexpected.length > 0) throw new TypeError(`read-only options do not accept: ${unexpected.join(', ')}`);
  const shell = readWorkflowSnapshot({ dataRoot: options.dataRoot });
  const state = structuredClone(shell.state);
  const collectionHashes = Object.fromEntries(COLLECTIONS.map(name => [name, collectionHash(state, name)]));
  return Object.freeze({
    sqlitePath: shell.sqlitePath,
    integrity: Object.freeze([...shell.integrity]),
    state,
    summary: Object.freeze(structuredClone(shell.summary)),
    hash: shell.hash,
    collectionHashes: Object.freeze(collectionHashes),
    activeOwnership: activeOwnership(state),
    auditSummary: auditSummary(state.auditLogs)
  });
}

export function compareManualSnapshots(before, after) {
  if (!before?.collectionHashes || !after?.collectionHashes) {
    throw new TypeError('before and after manual snapshots are required');
  }
  const changedCollections = COLLECTIONS.filter(name =>
    before.collectionHashes[name] !== after.collectionHashes[name]
  );
  const summaryDelta = {};
  for (const key of new Set([...Object.keys(before.summary || {}), ...Object.keys(after.summary || {})])) {
    const left = Number(before.summary?.[key] || 0);
    const right = Number(after.summary?.[key] || 0);
    if (left !== right) summaryDelta[key] = right - left;
  }
  return Object.freeze({
    hashChanged: before.hash !== after.hash,
    changedCollections: Object.freeze(changedCollections),
    summaryDelta: Object.freeze(summaryDelta)
  });
}

export function assertZeroBusinessWrite(before, after, options = {}) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    throw new TypeError('zero-write options must be an object');
  }
  const unexpected = Object.keys(options).filter(key => key !== 'allowedAuditActions');
  if (unexpected.length > 0) throw new TypeError(`zero-write options do not accept: ${unexpected.join(', ')}`);
  const allowedAuditActions = new Set(options.allowedAuditActions ?? []);
  const diff = compareManualSnapshots(before, after);
  const changedBusiness = diff.changedCollections.filter(name => BUSINESS_COLLECTIONS.includes(name));
  const violations = changedBusiness.map(name => ({ code: 'COLLECTION_CHANGED', collection: name }));

  if (diff.changedCollections.includes('auditLogs')) {
    const beforeAudits = new Map(array(before.state?.auditLogs).map(item => [String(item.id || ''), item]));
    const afterAudits = new Map(array(after.state?.auditLogs).map(item => [String(item.id || ''), item]));
    for (const [id, audit] of beforeAudits) {
      if (!afterAudits.has(id) || stableJson(afterAudits.get(id)) !== stableJson(audit)) {
        violations.push({ code: 'EXISTING_AUDIT_CHANGED', auditId: id });
      }
    }
    for (const [id, audit] of afterAudits) {
      if (beforeAudits.has(id)) continue;
      const action = String(audit?.action || '');
      const outcome = String(audit?.outcome || audit?.result || '');
      if (!allowedAuditActions.has(action) || !FAILURE_OUTCOMES.has(outcome)) {
        violations.push({ code: 'AUDIT_NOT_ALLOWED', auditId: id, action, outcome });
      }
    }
  }
  if (violations.length > 0) {
    throw violationError('BUSINESS_WRITE_DETECTED', 'cancelled or rejected action changed protected business state', violations);
  }
  return true;
}

export function assertManualSafety(snapshot) {
  if (!snapshot || typeof snapshot !== 'object' || !snapshot.state) {
    throw new TypeError('manual snapshot with state is required');
  }
  const violations = [];
  if (array(snapshot.integrity).length !== 1 || String(snapshot.integrity[0]).toLowerCase() !== 'ok') {
    violations.push({ code: 'SQLITE_INTEGRITY', detail: array(snapshot.integrity).join('; ') || 'missing' });
  }
  const state = snapshot.state;
  const activeRecords = array(state.records).filter(record => ORDINARY_ACTIVE.has(String(record?.status || '')));
  const sampleOwners = new Map();
  const channelOwners = new Map();
  for (const record of activeRecords) {
    const sampleId = String(record.sampleId || '');
    if (sampleId) {
      if (sampleOwners.has(sampleId)) violations.push({ code: 'DUPLICATE_ACTIVE_SAMPLE', sampleId });
      else sampleOwners.set(sampleId, String(record.id || ''));
    }
    const keys = [...new Set([record.channelKey, ...array(record.keys)].map(String).filter(Boolean))];
    for (const channelKey of keys) {
      if (channelOwners.has(channelKey) && channelOwners.get(channelKey) !== String(record.id || '')) {
        violations.push({ code: 'DUPLICATE_CHANNEL_OWNERSHIP', channelKey });
      } else channelOwners.set(channelKey, String(record.id || ''));
    }
  }
  const storageSamples = new Map();
  for (const record of array(state.storageRecords).filter(item => STORAGE_ACTIVE.has(String(item?.status || '')))) {
    for (const sampleId of array(record.sampleIds).map(String).filter(Boolean)) {
      if (storageSamples.has(sampleId)) violations.push({ code: 'DUPLICATE_STORAGE_SAMPLE', sampleId });
      else storageSamples.set(sampleId, String(record.id || ''));
      if (sampleOwners.has(sampleId)) violations.push({ code: 'ORDINARY_STORAGE_OVERLAP', sampleId });
    }
  }
  const sourceIds = new Set(array(state.requestSourceRows).flatMap(row => [
    row?.id, row?.requestNo, row?.申请单号, row?.委托单号
  ]).map(String).filter(value => value.trim() !== ''));
  for (const request of array(state.requests)) {
    const requestId = String(request?.id || '').trim();
    if (requestId && !sourceIds.has(requestId)) violations.push({ code: 'REQUEST_SOURCE_MISSING', requestId });
  }
  if (violations.length > 0) {
    throw violationError('MANUAL_SAFETY_VIOLATION', 'manual persistence safety invariants failed', violations);
  }
  return true;
}
