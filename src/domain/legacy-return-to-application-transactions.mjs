import { recomputeLegacyRequestStatus } from './legacy-request-transactions.mjs';

const ACTIVE_STORAGE_STATUSES = new Set(['storing', 'exception']);
const ACTIVE_RECORD_STATUSES = new Set(['reserved', 'running']);

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

function metadata(state, command) {
  const actor = requireText(command?.actor, 'actor', '操作者');
  const auditId = requireText(command?.auditId, 'auditId', '审计标识');
  const now = requireText(command?.now, 'now', '操作时间');
  const reason = requireText(command?.reason, 'reason', '退回原因');
  if (!Number.isFinite(Date.parse(now))) throw domainError('COMMAND_TIME_INVALID', '操作时间无效');
  if (state.auditLogs.some(item => String(item?.id || '') === auditId)) {
    throw domainError('IDENTIFIER_ALREADY_EXISTS', '审计标识已存在', { id: auditId });
  }
  return { actor, auditId, now, reason };
}

function auditEntry(meta, { action, target, requestNo, sampleIds, before, after }) {
  return {
    id: meta.auditId,
    time: meta.now,
    at: meta.now,
    user: meta.actor,
    actor: meta.actor,
    action,
    target,
    outcome: 'success',
    result: 'success',
    verified: true,
    level: 'normal',
    requestNo,
    sampleIds: structuredClone(sampleIds),
    before: structuredClone(before),
    after: structuredClone(after),
    note: meta.reason
  };
}

function requestNumber(request) {
  return String(request?.id ?? request?.requestNo ?? request?.no ?? '');
}

function clearSampleAssignment(sample, now) {
  sample.status = 'pending';
  sample.channelKey = '';
  sample.start = '';
  sample.end = '';
  sample.hasHistory = true;
  sample.returnedAt = now;
}

function clearChannel(channel) {
  channel.state = 'free';
  channel.project = '';
  channel.user = '';
  channel.start = '';
  channel.end = null;
  channel.requestNo = '';
  channel.test = '';
  channel.currentRecordId = '';
  channel.nextRecordId = '';
}

function applyQueuedDisplay(state, channel, queued) {
  const requestNo = String(queued?.requestNo ?? queued?.no ?? '');
  const request = state.requests.find(item => requestNumber(item) === requestNo);
  channel.state = 'booked';
  channel.project = queued.project || request?.project || '';
  channel.user = queued.user || queued.actor || '';
  channel.start = queued.start || queued.time || '';
  channel.end = queued.end || '';
  channel.requestNo = requestNo;
  channel.test = queued.test || request?.test || request?.testName || '';
  channel.currentRecordId = '';
  channel.nextRecordId = queued.id;
}

function recordChannelKeys(record) {
  return [...new Set([
    record?.channelKey,
    ...(Array.isArray(record?.keys) ? record.keys : [])
  ].map(value => String(value ?? '').trim()).filter(Boolean))];
}

function recordRequestNumber(record) {
  return String(record?.requestNo ?? record?.no ?? '').trim();
}

function validateOrdinaryRecordOwnership(state, record, channel, expectedStatus, errorCode) {
  const channelKey = String(channel?.key || '');
  const requestNo = recordRequestNumber(record);
  const sampleId = String(record?.sampleId || '').trim();
  const channelKeys = recordChannelKeys(record);
  const samples = state.samples.filter(sample => String(sample?.id || '') === sampleId);
  const sample = samples[0];
  const requests = state.requests.filter(request => requestNumber(request) === requestNo);
  const activeSampleOwners = state.records.filter(item =>
    String(item?.sampleId || '') === sampleId && ACTIVE_RECORD_STATUSES.has(String(item?.status || ''))
  );
  if (
    String(record?.status || '') !== expectedStatus ||
    channelKeys.length !== 1 || channelKeys[0] !== channelKey ||
    !sampleId || samples.length !== 1 || String(sample?.status || '') !== expectedStatus ||
    String(sample?.channelKey || '') !== channelKey ||
    !requestNo || String(sample?.requestNo || '') !== requestNo || requests.length !== 1 ||
    activeSampleOwners.length !== 1 || activeSampleOwners[0] !== record
  ) {
    throw domainError(errorCode, '普通记录、子样品、申请与通道归属不一致', {
      recordId: record?.id, sampleId, requestNo, channelKey
    });
  }
  return sample;
}

function validateRunningReturnOwnership(state, record, channel) {
  const recordId = String(record?.id || '');
  const channelKey = String(channel?.key || '');
  const runningOnChannel = state.records.filter(item =>
    String(item?.status || '') === 'running' && recordChannelKeys(item).includes(channelKey)
  );
  if (
    String(channel?.state || '') !== 'busy' ||
    String(channel?.currentRecordId || '') !== recordId ||
    runningOnChannel.length !== 1 || runningOnChannel[0] !== record
  ) {
    throw domainError('RUNNING_RECORD_POINTER_INVALID', '普通测试记录不是通道唯一当前记录');
  }
  validateOrdinaryRecordOwnership(state, record, channel, 'running', 'RUNNING_OWNERSHIP_INVALID');

  const reservedOnChannel = state.records.filter(item =>
    String(item?.status || '') === 'reserved' && recordChannelKeys(item).includes(channelKey)
  );
  const nextRecordId = String(channel?.nextRecordId || '');
  if (!nextRecordId) {
    if (reservedOnChannel.length !== 0) {
      throw domainError('RUNNING_CHANNEL_OWNERSHIP_INVALID', '忙碌通道存在未由 nextRecordId 指向的预约记录');
    }
    return null;
  }
  const queued = state.records.find(item => String(item?.id || '') === nextRecordId);
  if (!queued || reservedOnChannel.length !== 1 || reservedOnChannel[0] !== queued) {
    throw domainError('RUNNING_CHANNEL_OWNERSHIP_INVALID', '忙碌通道的 nextRecordId 与预约记录不一致');
  }
  validateOrdinaryRecordOwnership(state, queued, channel, 'reserved', 'RUNNING_CHANNEL_OWNERSHIP_INVALID');
  return queued;
}

function validateStorageReturnOwnership(state, record) {
  const requestNo = String(record?.requestNo || '').trim();
  const sampleIds = Array.isArray(record?.sampleIds)
    ? record.sampleIds.map(value => String(value ?? '').trim())
    : [];
  if (
    !requestNo || state.requests.filter(request => requestNumber(request) === requestNo).length !== 1 ||
    sampleIds.length === 0 || sampleIds.some(id => !id) || new Set(sampleIds).size !== sampleIds.length
  ) {
    throw domainError('STORAGE_OWNERSHIP_INVALID', '长期存储的申请或子样品集合无效');
  }
  for (const sampleId of sampleIds) {
    const samples = state.samples.filter(sample => String(sample?.id || '') === sampleId);
    const sample = samples[0];
    const ordinaryOwners = state.records.filter(item =>
      String(item?.sampleId || '') === sampleId && ACTIVE_RECORD_STATUSES.has(String(item?.status || ''))
    );
    const storageOwners = state.storageRecords.filter(item =>
      ACTIVE_STORAGE_STATUSES.has(String(item?.status || '')) &&
      Array.isArray(item?.sampleIds) && item.sampleIds.map(String).includes(sampleId)
    );
    if (
      samples.length !== 1 || String(sample?.requestNo || '') !== requestNo ||
      String(sample?.status || '') !== String(record.status || '') || String(sample?.channelKey || '') !== '' ||
      ordinaryOwners.length !== 0 || storageOwners.length !== 1 || storageOwners[0] !== record
    ) {
      throw domainError('STORAGE_OWNERSHIP_INVALID', '长期存储子样品不再由目标活动记录独占', {
        storageId: record?.id, sampleId
      });
    }
  }
}

export function returnLegacyRunningToApplication(state, command) {
  requireState(state);
  const recordId = requireText(command?.recordId, 'recordId', '普通测试记录标识');
  const meta = metadata(state, command);
  const current = state.records.find(item => String(item?.id || '') === recordId);
  if (!current) throw domainError('RECORD_NOT_FOUND', `普通测试记录不存在：${recordId}`);
  if (String(current.status || '') !== 'running') {
    throw domainError('RUNNING_RECORD_REQUIRED', '只有活动普通测试可以退回申请');
  }
  const channelKey = String(current.channelKey || current.keys?.[0] || '');
  const sourceChannel = state.channels.find(item => String(item?.key || '') === channelKey);
  if (!sourceChannel || String(sourceChannel.currentRecordId || '') !== recordId) {
    throw domainError('RUNNING_RECORD_POINTER_INVALID', '普通测试记录不是通道当前记录');
  }
  validateRunningReturnOwnership(state, current, sourceChannel);

  const next = structuredClone(state);
  const record = next.records.find(item => String(item.id) === recordId);
  const before = structuredClone(record);
  record.status = 'returned';
  record.endedAt = meta.now;
  record.actualEnd = meta.now;
  record.returnedAt = meta.now;
  record.returnReason = meta.reason;

  const sample = next.samples.find(item => String(item.id) === String(record.sampleId));
  clearSampleAssignment(sample, meta.now);

  const channel = next.channels.find(item => String(item.key) === channelKey);
  const queued = channel.nextRecordId
    ? next.records.find(item => {
        if (String(item?.id || '') !== String(channel.nextRecordId) || String(item?.status || '') !== 'reserved') return false;
        const recordChannelKeys = [item?.channelKey, ...(Array.isArray(item?.keys) ? item.keys : [])].map(String);
        if (!recordChannelKeys.includes(String(channel.key))) return false;
        const queuedSample = next.samples.find(sample => String(sample?.id || '') === String(item?.sampleId || ''));
        if (!queuedSample || String(queuedSample.status || '') !== 'reserved') return false;
        return !queuedSample.channelKey || String(queuedSample.channelKey) === String(channel.key);
      })
    : null;
  if (queued) applyQueuedDisplay(next, channel, queued);
  else clearChannel(channel);

  const requestNo = String(record.requestNo ?? record.no ?? sample.requestNo ?? '');
  recomputeLegacyRequestStatus(next, requestNo);
  next.auditLogs.unshift(auditEntry(meta, {
    action: 'running_returned_to_application',
    target: `record:${recordId}`,
    requestNo,
    sampleIds: [sample.id],
    before,
    after: record
  }));
  return next;
}

export function returnLegacyReservedToApplication(state, command) {
  requireState(state);
  const recordId = requireText(command?.recordId, 'recordId', '预约记录标识');
  const meta = metadata(state, command);
  const current = state.records.find(item => String(item?.id || '') === recordId);
  if (!current) throw domainError('RECORD_NOT_FOUND', `预约记录不存在：${recordId}`);
  if (String(current.status || '') !== 'reserved') {
    throw domainError('RESERVED_RECORD_REQUIRED', '只有已预约记录可以退回申请');
  }
  const channelKey = String(current.channelKey || current.keys?.[0] || '');
  const sourceChannel = state.channels.find(item => String(item?.key || '') === channelKey);
  if (!sourceChannel || String(sourceChannel.nextRecordId || '') !== recordId) {
    throw domainError('RESERVED_RECORD_POINTER_INVALID', '预约记录不是通道当前预约');
  }
  const sourceSample = state.samples.find(item => String(item?.id || '') === String(current.sampleId || ''));
  if (!sourceSample) throw domainError('SAMPLE_NOT_FOUND', '预约记录缺少对应子样品');
  const requestNo = String(current.requestNo ?? current.no ?? sourceSample.requestNo ?? '');
  if (
    String(sourceSample.status || '') !== 'reserved' ||
    String(sourceSample.channelKey || '') !== channelKey ||
    String(sourceSample.requestNo || '') !== requestNo
  ) {
    throw domainError('RESERVED_SAMPLE_POINTER_INVALID', '预约记录与子样品当前归属不一致');
  }
  const channelState = String(sourceChannel.state || '');
  if (channelState === 'booked') {
    if (String(sourceChannel.currentRecordId || '') !== '') {
      throw domainError('RESERVED_CHANNEL_STATE_INVALID', '已预约通道不能同时持有当前测试记录');
    }
  } else if (channelState === 'busy') {
    const runningRecordId = String(sourceChannel.currentRecordId || '');
    const runningRecord = state.records.find(item =>
      String(item?.id || '') === runningRecordId &&
      String(item?.status || '') === 'running' &&
      [item?.channelKey, ...(Array.isArray(item?.keys) ? item.keys : [])].map(String).includes(channelKey)
    );
    const runningSample = runningRecord
      ? state.samples.find(item => String(item?.id || '') === String(runningRecord.sampleId || ''))
      : null;
    if (
      !runningRecord ||
      !runningSample ||
      String(runningSample.status || '') !== 'running' ||
      String(runningSample.channelKey || '') !== channelKey
    ) {
      throw domainError('RESERVED_CHANNEL_STATE_INVALID', '忙碌通道缺少一致的当前测试归属');
    }
  } else {
    throw domainError('RESERVED_CHANNEL_STATE_INVALID', '预约记录所在通道状态无效');
  }

  const next = structuredClone(state);
  const record = next.records.find(item => String(item.id) === recordId);
  const before = structuredClone(record);
  record.status = 'returned';
  record.endedAt = meta.now;
  record.actualEnd = meta.now;
  record.returnedAt = meta.now;
  record.returnReason = meta.reason;

  const sample = next.samples.find(item => String(item.id) === String(record.sampleId));
  clearSampleAssignment(sample, meta.now);

  const channel = next.channels.find(item => String(item.key) === channelKey);
  if (channel.currentRecordId) channel.nextRecordId = '';
  else clearChannel(channel);

  recomputeLegacyRequestStatus(next, requestNo);
  next.auditLogs.unshift(auditEntry(meta, {
    action: 'reserved_returned_to_application',
    target: `record:${recordId}`,
    requestNo,
    sampleIds: [sample.id],
    before,
    after: record
  }));
  return next;
}

export function returnLegacyStorageToApplication(state, command) {
  requireState(state);
  const storageId = requireText(command?.storageId, 'storageId', '长期存储标识');
  const meta = metadata(state, command);
  const current = state.storageRecords.find(item => String(item?.id || '') === storageId);
  if (!current) throw domainError('STORAGE_NOT_FOUND', `长期存储不存在：${storageId}`);
  if (!ACTIVE_STORAGE_STATUSES.has(String(current.status || ''))) {
    throw domainError('STORAGE_NOT_ACTIVE', '只有活动长期存储可以退回申请');
  }
  validateStorageReturnOwnership(state, current);

  const next = structuredClone(state);
  const record = next.storageRecords.find(item => String(item.id) === storageId);
  const before = structuredClone(record);
  record.status = 'returned';
  record.endedAt = meta.now;
  record.returnReason = meta.reason;
  for (const sampleId of record.sampleIds) {
    const sample = next.samples.find(item => String(item?.id || '') === String(sampleId));
    if (!sample) throw domainError('SAMPLE_NOT_FOUND', '长期存储记录缺少对应子样品', { sampleId });
    clearSampleAssignment(sample, meta.now);
  }
  recomputeLegacyRequestStatus(next, String(record.requestNo || ''));
  next.auditLogs.unshift(auditEntry(meta, {
    action: 'storage_returned_to_application',
    target: `storage:${storageId}`,
    requestNo: String(record.requestNo || ''),
    sampleIds: record.sampleIds,
    before,
    after: record
  }));
  return next;
}
