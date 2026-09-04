import { canonicalStateHash, summarizeState } from './state-probe.mjs';

const ACTIVE_STATUSES = new Set(['running', 'reserved']);
const ACTIVE_STORAGE_STATUSES = new Set(['storing', 'exception']);
const TERMINAL_STATUSES = new Set(['completed', 'cancelled', 'canceled', 'returned']);
const AUDIT_OUTCOMES = new Set(['success', 'warning', 'rejected', 'failure']);
const UI_PAGES = new Set([
  'dashboard', 'apply', 'requests', 'devices', 'testers', 'reserved', 'records', 'logs', 'timeliness',
  'runningSamples', 'storageSamples'
]);
const SUMMARY_KEYS = Object.freeze([
  'revision', 'devices', 'channels', 'requests', 'samples', 'records', 'audits',
  'storageRecords', 'journalEntries', 'runningRecords', 'reservedRecords', 'activeRecords'
]);
const VISIBLE_KEYS = Object.freeze(['records', 'samples', 'channels', 'todos', 'storageRecords']);

function array(value) {
  return Array.isArray(value) ? value : [];
}

function entityId(value) {
  return String(value ?? '').trim();
}

function uniqueIds(values) {
  return [...new Set(values.map(entityId).filter(Boolean))].sort();
}

function sameValue(left, right) {
  return canonicalStateHash({ value: left }) === canonicalStateHash({ value: right });
}

function addViolation(violations, code, severity, message, entityIds = []) {
  const ids = uniqueIds(entityIds);
  const existing = violations.find(item => item.code === code);
  if (existing) {
    existing.entityIds = uniqueIds([...existing.entityIds, ...ids]);
    return;
  }
  violations.push({ code, severity, message, entityIds: ids });
}

function byId(items, keys = ['id']) {
  const result = new Map();
  for (const item of array(items)) {
    const id = keys.map(key => entityId(item?.[key])).find(Boolean);
    if (id) result.set(id, item);
  }
  return result;
}

function groupedActive(records, field) {
  const groups = new Map();
  for (const record of array(records)) {
    if (!ACTIVE_STATUSES.has(record?.status)) continue;
    const ids = field === 'channelKey'
      ? uniqueIds([record?.channelKey, ...array(record?.keys)])
      : uniqueIds([record?.[field]]);
    for (const id of ids) {
      const values = groups.get(id) || [];
      values.push(record);
      groups.set(id, values);
    }
  }
  return groups;
}

function checkIntegrity(after, violations) {
  const integrity = array(after?.integrity).map(String);
  if (integrity.length !== 1 || integrity[0].toLowerCase() !== 'ok') {
    addViolation(violations, 'SQLITE_INTEGRITY', 'P0', `SQLite integrity_check: ${integrity.join('; ') || 'missing'}`);
  }
}

function actualOutcome(action, ui) {
  if (typeof action?.outcome === 'string') return action.outcome;
  if (typeof action?.actualOutcome === 'string') return action.actualOutcome;
  if (typeof action?.observedOutcome === 'string') return action.observedOutcome;
  if (typeof action?.result === 'string') return action.result;
  if (typeof action?.result?.outcome === 'string') return action.result.outcome;
  if (typeof ui?.outcome === 'string') return ui.outcome;
  return '';
}

function checkOutcomeAndRevision(before, after, action, ui, violations) {
  const observedOutcome = actualOutcome(action, ui);
  if (action?.expect && action.expect !== observedOutcome) {
    addViolation(
      violations,
      'ACTION_OUTCOME',
      'P0',
      `expected outcome ${action.expect}, got ${observedOutcome || '<missing>'}`,
      [action.id]
    );
  }
  if (action?.revisionDelta === undefined) return;
  const expectedDeltas = Array.isArray(action.revisionDelta) ? action.revisionDelta : [action.revisionDelta];
  const observedDelta = Number(after?.state?.revision || 0) - Number(before?.state?.revision || 0);
  if (!expectedDeltas.includes(observedDelta)) {
    addViolation(
      violations,
      'REVISION_DELTA',
      'P0',
      `expected ${expectedDeltas.join('/')}, got ${observedDelta}`,
      [action.id]
    );
  }
}

function checkPointers(state, violations) {
  const records = array(state?.records);
  const channels = byId(state?.channels, ['key']);
  const samples = byId(state?.samples);
  const recordsById = byId(records);
  const runningIds = [];
  const reservedIds = [];
  const terminalIds = [];

  for (const record of records) {
    const recordId = entityId(record?.id);
    const channelKey = entityId(record?.channelKey || array(record?.keys)[0]);
    const sampleId = entityId(record?.sampleId);
    const channel = channels.get(channelKey);
    const sample = samples.get(sampleId);
    if (record?.status === 'running' && (
      !channel || channel.state !== 'busy' || entityId(channel.currentRecordId) !== recordId ||
      !sample || sample.status !== 'running' || entityId(sample.channelKey) !== channelKey
    )) runningIds.push(recordId, channelKey, sampleId);
    if (record?.status === 'reserved' && (
      !channel || !['booked', 'busy'].includes(channel.state) || entityId(channel.nextRecordId) !== recordId ||
      !sample || sample.status !== 'reserved' || entityId(sample.channelKey) !== channelKey
    )) reservedIds.push(recordId, channelKey, sampleId);
  }

  for (const channel of array(state?.channels)) {
    const currentId = entityId(channel?.currentRecordId);
    const nextId = entityId(channel?.nextRecordId);
    const current = recordsById.get(currentId);
    const next = recordsById.get(nextId);
    if (channel.state === 'busy' && (!currentId || current?.status !== 'running')) {
      runningIds.push(channel.key, currentId);
    }
    if (channel.state === 'booked' && (!nextId || next?.status !== 'reserved')) {
      reservedIds.push(channel.key, nextId);
    }
    if (currentId && !current) runningIds.push(channel.key, currentId);
    if (current?.status === 'running' && (channel.state !== 'busy' || entityId(current.channelKey) !== entityId(channel.key))) {
      runningIds.push(channel.key, currentId);
    }
    if (currentId && current && current.status !== 'running' && !TERMINAL_STATUSES.has(current.status)) {
      runningIds.push(channel.key, currentId);
    }
    if (nextId && (!next || next.status !== 'reserved' || entityId(next.channelKey) !== entityId(channel.key))) {
      reservedIds.push(channel.key, nextId);
    }
    if ((currentId && TERMINAL_STATUSES.has(current?.status)) || (nextId && TERMINAL_STATUSES.has(next?.status))) {
      terminalIds.push(channel.key, currentId, nextId);
    }
  }

  if (runningIds.length) {
    addViolation(violations, 'RUNNING_POINTER_SPLIT', 'P0', 'running record, sample and current channel pointer disagree', runningIds);
  }
  if (reservedIds.length) {
    addViolation(violations, 'RESERVED_POINTER_SPLIT', 'P0', 'reserved record, sample and next channel pointer disagree', reservedIds);
  }
  if (terminalIds.length) {
    addViolation(violations, 'TERMINAL_CHANNEL_NOT_RELEASED', 'P0', 'completed or cancelled record still owns a channel pointer', terminalIds);
  }
}

function checkActiveUniqueness(state, violations) {
  for (const [sampleId, records] of groupedActive(state?.records, 'sampleId')) {
    if (records.length > 1) {
      addViolation(
        violations,
        'SAMPLE_ACTIVE_DUPLICATE',
        'P0',
        `sample ${sampleId} has ${records.length} active records`,
        [sampleId, ...records.map(record => record.id)]
      );
    }
  }
  for (const [channelKey, records] of groupedActive(state?.records, 'channelKey')) {
    const duplicateRecords = [...ACTIVE_STATUSES].flatMap(status => {
      const matching = records.filter(record => record.status === status);
      return matching.length > 1 ? matching : [];
    });
    if (duplicateRecords.length) {
      addViolation(
        violations,
        'CHANNEL_ACTIVE_DUPLICATE',
        'P0',
        `channel ${channelKey} has duplicate running or reserved records`,
        [channelKey, ...duplicateRecords.map(record => record.id)]
      );
    }
  }
}

function storageHasChannelReference(record) {
  return Boolean(entityId(record?.channelKey))
    || array(record?.keys).some(value => Boolean(entityId(value)))
    || array(record?.channelIds).some(value => Boolean(entityId(value)));
}

function expectedStorageSampleStatus(status) {
  if (ACTIVE_STORAGE_STATUSES.has(status)) return status;
  if (status === 'completed') return 'completed';
  if (status === 'returned') return 'pending';
  return null;
}

function checkStorage(beforeState, afterState, action, violations) {
  const storageRecords = array(afterState?.storageRecords);
  const samples = byId(afterState?.samples);
  const activeOrdinarySamples = new Set(array(afterState?.records)
    .filter(record => ACTIVE_STATUSES.has(record?.status))
    .map(record => entityId(record?.sampleId)).filter(Boolean));
  const activeStorageSamples = new Map();
  const duplicateIds = [];
  const ordinaryConflicts = [];
  const channelReferences = [];
  const statusSplits = [];

  for (const record of storageRecords) {
    const recordId = entityId(record?.id);
    if (storageHasChannelReference(record)) channelReferences.push(recordId);
    const expectedStatus = expectedStorageSampleStatus(entityId(record?.status));
    for (const sampleId of uniqueIds(record?.sampleIds || [])) {
      if (ACTIVE_STORAGE_STATUSES.has(record?.status)) {
        const owners = activeStorageSamples.get(sampleId) || [];
        owners.push(recordId);
        activeStorageSamples.set(sampleId, owners);
        if (activeOrdinarySamples.has(sampleId)) ordinaryConflicts.push(sampleId, recordId);
      }
      if (expectedStatus && samples.get(sampleId)?.status !== expectedStatus) {
        statusSplits.push(sampleId, recordId);
      }
    }
  }
  for (const [sampleId, owners] of activeStorageSamples) {
    if (owners.length > 1) duplicateIds.push(sampleId, ...owners);
  }
  if (ordinaryConflicts.length) {
    addViolation(violations, 'SAMPLE_ACTIVE_ASSIGNMENT_CONFLICT', 'P0', 'sample has both ordinary and storage active assignments', ordinaryConflicts);
  }
  if (channelReferences.length) {
    addViolation(violations, 'STORAGE_CHANNEL_REFERENCE', 'P0', 'storage records must not reference channels', channelReferences);
  }
  if (duplicateIds.length) {
    addViolation(violations, 'STORAGE_SAMPLE_ACTIVE_DUPLICATE', 'P0', 'sample belongs to multiple active storage records', duplicateIds);
  }
  if (statusSplits.length) {
    addViolation(violations, 'STORAGE_SAMPLE_STATUS_SPLIT', 'P0', 'storage record and sample statuses disagree', statusSplits);
  }
  if (['startStorage', 'updateStorage', 'finishStorage', 'returnStorage'].includes(action?.type)
    && !sameValue(array(beforeState?.channels), array(afterState?.channels))) {
    addViolation(violations, 'STORAGE_CHANNEL_MUTATION', 'P0', 'storage actions must leave channels byte-equivalent');
  }
}

function checkImmutableSources(beforeState, afterState, violations) {
  const beforeRequests = byId(beforeState?.requests, ['id', 'requestNo']);
  const afterRequests = byId(afterState?.requests, ['id', 'requestNo']);
  const rawChanged = [];
  const sourceChanged = [];
  for (const [id, before] of beforeRequests) {
    const after = afterRequests.get(id);
    if (!after) continue;
    if (!sameValue(before.rawFields ?? {}, after.rawFields ?? {})) rawChanged.push(id);
    if (!sameValue(
      { sourceFile: before.sourceFile ?? '', sourcePath: before.sourcePath ?? '', source: before.source ?? null },
      { sourceFile: after.sourceFile ?? '', sourcePath: after.sourcePath ?? '', source: after.source ?? null }
    )) sourceChanged.push(id);
  }
  const beforeRows = byId(beforeState?.requestSourceRows, ['requestNo', 'id']);
  const afterRows = byId(afterState?.requestSourceRows, ['requestNo', 'id']);
  for (const [id, before] of beforeRows) {
    const after = afterRows.get(id);
    if (after && !sameValue(before, after)) sourceChanged.push(id);
  }
  if (rawChanged.length) {
    addViolation(violations, 'RAW_FIELDS_CHANGED', 'P0', 'original request rawFields changed', rawChanged);
  }
  if (sourceChanged.length) {
    addViolation(violations, 'SOURCE_CHANGED', 'P0', 'request source identity or path changed', sourceChanged);
  }
}

function exactObject(value, keys) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === keys.length
    && keys.every(key => Object.hasOwn(value, key));
}

function hasLegacyLifecycleEnvelope(audit) {
  return audit?.before === null
    && audit?.source === '软件操作'
    && audit?.level === 'normal'
    && !Object.hasOwn(audit, 'outcome')
    && !Object.hasOwn(audit, 'result')
    && !Object.hasOwn(audit, 'verified')
    && !Object.hasOwn(audit, 'code');
}

function isExactLegacyLifecycleAudit(audit) {
  const actor = entityId(audit?.user ?? audit?.actor);
  if (!actor || !hasLegacyLifecycleEnvelope(audit)) return false;
  if (audit.action === '登录看板') {
    return audit.target === `用户 ${actor}`
      && exactObject(audit.after, ['结果'])
      && audit.after.结果 === '登录成功'
      && audit.note === '进入本机看板';
  }
  if (audit.action === '日志初始化') {
    if (audit.target !== '本机看板'
      || !exactObject(audit.after, ['历史使用日志', '申请单数量'])
      || !Number.isSafeInteger(audit.after.历史使用日志) || audit.after.历史使用日志 < 0
      || !Number.isSafeInteger(audit.after.申请单数量) || audit.after.申请单数量 < 0) return false;
    const expectedNote = audit.after.历史使用日志 > 0
      ? '旧版使用日志没有保存逐项审计，无法补录旧操作；从本次开始持续记录'
      : '首次启用软件操作审计；当前版本不接入真实设备';
    return audit.note === expectedNote;
  }
  return audit.action === '查看页面'
    && exactObject(audit.after, ['页面'])
    && Boolean(entityId(audit.after.页面))
    && audit.target === `页面 ${audit.after.页面}`
    && audit.note === '页面访问';
}

function checkAudits(state, violations) {
  const audits = array(state?.auditLogs);
  const counts = new Map();
  const invalid = [];
  for (const audit of audits) {
    const id = entityId(audit?.id);
    if (id) counts.set(id, (counts.get(id) || 0) + 1);
    const outcome = entityId(audit?.outcome);
    const result = entityId(audit?.result);
    const legacy = !outcome && result === 'legacy' && audit?.source === 'legacy';
    const legacyLifecycle = isExactLegacyLifecycleAudit(audit);
    const verifiedOutcome = AUDIT_OUTCOMES.has(outcome) && result === outcome;
    const successSemantics = ['success', 'warning'].includes(outcome) && audit?.verified === true;
    const failureSemantics = ['failure', 'rejected'].includes(outcome) &&
      audit?.verified === false && entityId(audit?.code);
    const semanticsValid = legacy || legacyLifecycle || (verifiedOutcome && (successSemantics || failureSemantics));
    if (!id || !entityId(audit?.action) || !semanticsValid) invalid.push(id || '<missing-audit-id>');
  }
  const duplicates = [...counts].filter(([, count]) => count > 1).map(([id]) => id);
  if (duplicates.length) {
    addViolation(violations, 'AUDIT_ID_DUPLICATE', 'P0', 'audit IDs must be unique', duplicates);
  }
  if (invalid.length) {
    addViolation(violations, 'AUDIT_SEMANTICS', 'P0', 'audit action/outcome/result/verification semantics are invalid', invalid);
  }
}

function checkUi(after, ui, violations) {
  if (!ui) return;
  const expected = summarizeState(after?.state);
  const projection = ui.projection;
  const projectionValid = projection && typeof projection === 'object' && !Array.isArray(projection) &&
    UI_PAGES.has(projection.currentPage) && projection.summary && typeof projection.summary === 'object' &&
    !Array.isArray(projection.summary) && SUMMARY_KEYS.every(key => Object.hasOwn(projection.summary, key)) &&
    projection.visible && typeof projection.visible === 'object' && !Array.isArray(projection.visible) &&
    VISIBLE_KEYS.every(key => Array.isArray(projection.visible[key]));
  if (!projectionValid) {
    addViolation(violations, 'UI_PROJECTION_INVALID', 'P1', 'UI projection must include currentPage, complete summary and visible entity arrays');
  } else {
    const mismatches = SUMMARY_KEYS.filter(key => !sameValue(projection.summary[key], expected[key]));
    const state = after?.state || {};
    const entities = [
      ['records', byId(state.records), 'id', 'status', 'status'],
      ['samples', byId(state.samples), 'id', 'status', 'status'],
      ['channels', byId(state.channels, ['key']), 'key', 'state', 'state'],
      ['todos', byId(array(state.records).filter(record => record.status === 'reserved')), 'id', 'status', 'status'],
      ['storageRecords', byId(state.storageRecords), 'id', 'status', 'status']
    ];
    for (const [name, source, idKey, uiStatusKey, stateStatusKey] of entities) {
      for (const item of projection.visible[name]) {
        const id = entityId(item?.[idKey]);
        const stateItem = source.get(id);
        if (!id || !stateItem || entityId(item?.[uiStatusKey]) !== entityId(stateItem?.[stateStatusKey])) {
          mismatches.push(id || `visible.${name}`);
        }
      }
    }
    if (mismatches.length) {
      addViolation(violations, 'UI_SQLITE_PROJECTION', 'P1', 'UI projection differs from SQLite snapshot', mismatches);
    }
  }
  const rendered = ui.renderedChannelCards ?? ui.dom?.channelCards ?? ui.channelCardCount;
  if (Number.isFinite(rendered) && rendered > 529) {
    addViolation(violations, 'CHANNEL_DOM_LIMIT', 'P2', `rendered ${rendered} channel cards; limit is 529`);
  }
  const consoleErrors = array(ui.consoleErrors ?? ui.console?.errors);
  const rejections = array(ui.unhandledRejections ?? ui.promiseRejections);
  const externalRequests = array(ui.externalRequests ?? ui.network?.externalRequests ?? ui.networkViolations);
  if (consoleErrors.length) {
    addViolation(violations, 'CONSOLE_ERROR', 'P1', `${consoleErrors.length} console errors`, consoleErrors);
  }
  if (rejections.length) {
    addViolation(violations, 'UNHANDLED_REJECTION', 'P1', `${rejections.length} unhandled promise rejections`, rejections);
  }
  if (externalRequests.length) {
    addViolation(violations, 'EXTERNAL_NETWORK_REQUEST', 'P1', `${externalRequests.length} external network requests`, externalRequests);
  }
}

function checkRestart(after, restart, violations) {
  if (!restart) return;
  const expectedHash = after?.hash || canonicalStateHash(after?.state);
  const restartHash = restart.hash || restart.snapshot?.hash || (restart.state ? canonicalStateHash(restart.state) : '');
  if (!restartHash || restartHash !== expectedHash) {
    addViolation(violations, 'RESTART_HASH_MISMATCH', 'P0', `restart hash ${restartHash || '<missing>'} differs from ${expectedHash}`);
  }
}

export function checkWorkflowInvariants({ before, after, action, ui, restart }) {
  const violations = [];
  checkIntegrity(after, violations);
  checkOutcomeAndRevision(before, after, action, ui, violations);
  checkPointers(after?.state, violations);
  checkActiveUniqueness(after?.state, violations);
  checkStorage(before?.state, after?.state, action, violations);
  checkImmutableSources(before?.state, after?.state, violations);
  checkAudits(after?.state, violations);
  checkUi(after, ui, violations);
  checkRestart(after, restart, violations);
  return violations;
}
