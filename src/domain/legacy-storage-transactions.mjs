import { recomputeLegacyRequestStatus } from './legacy-request-transactions.mjs';

const ACTIVE_STORAGE_STATUS = new Set(['storing', 'exception']);
const ACTIVE_RECORD_STATUS = new Set(['reserved', 'running']);

function domainError(code, message, details = undefined) {
  const error = new Error(message);
  error.code = code;
  if (details !== undefined) error.details = details;
  return error;
}

function requireState(state) {
  if (!state || typeof state !== 'object' || Array.isArray(state)) {
    throw domainError('STATE_REQUIRED', '缺少 legacy 状态');
  }
  for (const name of ['requests', 'samples', 'channels', 'records', 'storageRecords', 'auditLogs']) {
    if (!Array.isArray(state[name])) {
      throw domainError('STATE_COLLECTION_INVALID', `状态集合 ${name} 无效`, { collection: name });
    }
  }
}

function requireText(value, field, label) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw domainError('COMMAND_FIELD_REQUIRED', `${label}不能为空`, { field });
  }
  return value.trim();
}

function requireMetadata(state, command) {
  const actor = requireText(command?.actor, 'actor', '操作者');
  const auditId = requireText(command?.auditId, 'auditId', '审计标识');
  const now = requireText(command?.now, 'now', '操作时间');
  if (!Number.isFinite(Date.parse(now))) throw domainError('COMMAND_TIME_INVALID', '操作时间无效');
  if (state.auditLogs.some(item => String(item?.id || '') === auditId)) {
    throw domainError('IDENTIFIER_ALREADY_EXISTS', '审计标识已存在', { id: auditId });
  }
  return { actor, auditId, now };
}

function activeOrdinaryRecordFor(state, sampleId) {
  return state.records.some(record =>
    String(record?.sampleId || '') === sampleId && ACTIVE_RECORD_STATUS.has(String(record?.status || ''))
  );
}

function storageAudit(metadata, action, record, before, after) {
  return {
    id: metadata.auditId,
    time: metadata.now,
    at: metadata.now,
    user: metadata.actor,
    actor: metadata.actor,
    action,
    target: `storage:${record.id}`,
    outcome: 'success',
    result: 'success',
    verified: true,
    level: 'normal',
    requestNo: record.requestNo,
    sampleIds: structuredClone(record.sampleIds),
    before: structuredClone(before),
    after: structuredClone(after),
    note: record.note || ''
  };
}

function findStorageRecord(state, storageId) {
  const id = requireText(storageId, 'storageId', '长期存储标识');
  const record = state.storageRecords.find(item => String(item?.id || '') === id);
  if (!record) throw domainError('STORAGE_NOT_FOUND', `长期存储不存在：${id}`);
  return record;
}

function requireActive(record) {
  if (!ACTIVE_STORAGE_STATUS.has(String(record?.status || ''))) {
    throw domainError('STORAGE_NOT_ACTIVE', '只有活动长期存储可以修改或结束');
  }
}

export function startLegacyStorage(state, command) {
  requireState(state);
  const storageId = requireText(command?.storageId, 'storageId', '长期存储标识');
  const requestNo = requireText(command?.requestNo, 'requestNo', '申请单号');
  const tester = requireText(command?.tester, 'tester', '测试人员');
  const expectedEndAt = requireText(command?.expectedEndAt, 'expectedEndAt', '预计结束时间');
  if (!Number.isFinite(Date.parse(expectedEndAt))) {
    throw domainError('COMMAND_TIME_INVALID', '预计结束时间无效');
  }
  if (!Array.isArray(command?.sampleIds) || command.sampleIds.length === 0) {
    throw domainError('STORAGE_SAMPLE_IDS_INVALID', '长期存储必须包含至少一个子样品');
  }
  const sampleIds = command.sampleIds.map(sampleId => String(sampleId ?? '').trim());
  if (sampleIds.some(sampleId => !sampleId) || new Set(sampleIds).size !== sampleIds.length) {
    throw domainError('STORAGE_SAMPLE_IDS_INVALID', '长期存储子样品标识无效或重复');
  }
  const metadata = requireMetadata(state, command);
  if (state.storageRecords.some(item => String(item?.id || '') === storageId)) {
    throw domainError('STORAGE_ID_DUPLICATE', `长期存储标识已存在：${storageId}`);
  }
  if (!state.requests.some(item => String(item?.id ?? item?.requestNo ?? '') === requestNo)) {
    throw domainError('REQUEST_NOT_FOUND', `申请不存在：${requestNo}`);
  }
  for (const sampleId of sampleIds) {
    const sample = state.samples.find(item => String(item?.id || '') === sampleId);
    if (!sample || String(sample?.requestNo || '') !== requestNo) {
      throw domainError('SAMPLE_NOT_FOUND', '子样品不存在或不属于当前申请', { sampleId });
    }
    if (sample.status !== 'pending') {
      throw domainError('SAMPLE_NOT_PENDING', '只有待安排子样品可以开始长期存储', { sampleId });
    }
    if (activeOrdinaryRecordFor(state, sampleId)) {
      throw domainError('SAMPLE_ACTIVE_ASSIGNMENT_CONFLICT', '子样品已有活动普通测试或预约', { sampleId });
    }
    if (state.storageRecords.some(record =>
      ACTIVE_STORAGE_STATUS.has(String(record?.status || '')) && record.sampleIds?.map(String).includes(sampleId)
    )) {
      throw domainError('SAMPLE_ACTIVE_ASSIGNMENT_CONFLICT', '子样品已有活动长期存储', { sampleId });
    }
  }

  const next = structuredClone(state);
  const record = {
    id: storageId,
    requestNo,
    sampleIds,
    tester,
    status: 'storing',
    startedAt: metadata.now,
    expectedEndAt,
    endedAt: '',
    note: String(command.note || ''),
    returnReason: ''
  };
  next.storageRecords.unshift(record);
  for (const sampleId of sampleIds) {
    const sample = next.samples.find(item => String(item?.id || '') === sampleId);
    sample.status = 'storing';
    sample.hasHistory = true;
  }
  recomputeLegacyRequestStatus(next, requestNo);
  next.auditLogs.unshift(storageAudit(metadata, 'storage_started', record, null, record));
  return next;
}

export function updateLegacyStorage(state, command) {
  requireState(state);
  const current = findStorageRecord(state, command?.storageId);
  requireActive(current);
  const metadata = requireMetadata(state, command);
  const hasExpectedEndAt = Object.hasOwn(command || {}, 'expectedEndAt');
  const hasNote = Object.hasOwn(command || {}, 'note');
  const hasStatus = Object.hasOwn(command || {}, 'status');
  if (!hasExpectedEndAt && !hasNote && !hasStatus) {
    throw domainError('STORAGE_UPDATE_EMPTY', '长期存储至少需要更新一个字段');
  }
  if (hasExpectedEndAt && (!Number.isFinite(Date.parse(command.expectedEndAt)))) {
    throw domainError('COMMAND_TIME_INVALID', '预计结束时间无效');
  }
  if (hasStatus && !ACTIVE_STORAGE_STATUS.has(String(command.status || '').trim())) {
    throw domainError('STORAGE_STATUS_INVALID', '长期存储只能切换为 storing 或 exception');
  }

  const next = structuredClone(state);
  const record = findStorageRecord(next, command.storageId);
  const before = structuredClone(record);
  if (hasExpectedEndAt) record.expectedEndAt = command.expectedEndAt;
  if (hasNote) record.note = String(command.note ?? '');
  if (hasStatus) record.status = String(command.status).trim();
  for (const sampleId of record.sampleIds) {
    const sample = next.samples.find(item => String(item?.id || '') === String(sampleId));
    if (sample) sample.status = record.status;
  }
  next.auditLogs.unshift(storageAudit(metadata, 'storage_updated', record, before, record));
  return next;
}

export function finishLegacyStorage(state, command) {
  requireState(state);
  const current = findStorageRecord(state, command?.storageId);
  requireActive(current);
  const metadata = requireMetadata(state, command);

  const next = structuredClone(state);
  const record = findStorageRecord(next, command.storageId);
  const before = structuredClone(record);
  record.status = 'completed';
  record.endedAt = metadata.now;
  for (const sampleId of record.sampleIds) {
    const sample = next.samples.find(item => String(item?.id || '') === String(sampleId));
    if (sample) {
      sample.status = 'completed';
      sample.end = metadata.now;
      sample.hasHistory = true;
    }
  }
  next.auditLogs.unshift(storageAudit(metadata, 'storage_finished', record, before, record));
  return next;
}
