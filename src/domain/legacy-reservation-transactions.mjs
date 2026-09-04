import { validateAssignment } from './reservation-policy.mjs';
import { reconcileSamples } from './sample-quantity.mjs';
import { recomputeLegacyRequestStatus } from './legacy-request-transactions.mjs';

const ACTIVE_RECORD_STATUS = new Map([
  ['reserved', 'reserved'],
  ['running', 'running'],
  ['completed', 'completed'],
  ['cancelled', 'cancelled']
]);

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
  for (const name of ['requests', 'samples', 'channels', 'records', 'auditLogs']) {
    if (!Array.isArray(state[name])) {
      throw domainError('STATE_COLLECTION_INVALID', `状态集合 ${name} 无效`, { collection: name });
    }
  }
}

function requestNumber(request) {
  return String(request?.id ?? request?.requestNo ?? '').trim();
}

function requestQuantity(request) {
  return Number(request?.qty ?? request?.quantity);
}

function findRequest(state, requestNo) {
  const normalized = String(requestNo || '').trim();
  const request = state.requests.find(item => requestNumber(item) === normalized);
  if (!request) throw domainError('REQUEST_NOT_FOUND', `申请不存在：${normalized || '(空)'}`);
  return request;
}

function translateQuantityError(error) {
  if (error instanceof RangeError) {
    return domainError('QUANTITY_INVALID', error.message);
  }
  if (error.message.includes('二次确认')) {
    return domainError('SAMPLE_REDUCTION_CONFIRMATION_REQUIRED', error.message);
  }
  if (error.message.includes('活动或历史')) {
    return domainError('SAMPLE_HISTORY_BLOCK', error.message);
  }
  if (error.message.includes('数量不一致')) {
    return domainError('SAMPLE_COLLECTION_INCONSISTENT', error.message);
  }
  return error;
}

export function reconcileLegacySamples(state, command) {
  requireState(state);
  if (!command || typeof command !== 'object') {
    throw domainError('COMMAND_REQUIRED', '缺少数量调整命令');
  }
  const request = findRequest(state, command.requestNo);
  const requestNo = requestNumber(request);
  const currentQuantity = requestQuantity(request);
  const requestSamples = state.samples.filter(item => String(item?.requestNo) === requestNo);
  let result;
  try {
    result = reconcileSamples({
      request: { requestNo, quantity: currentQuantity },
      samples: requestSamples,
      nextQuantity: command.quantity,
      confirmReduction: command.confirmed === true
    });
  } catch (error) {
    throw translateQuantityError(error);
  }

  const next = structuredClone(state);
  const nextRequest = next.requests.find(item => requestNumber(item) === requestNo);
  nextRequest.qty = result.request.quantity;
  if (Object.hasOwn(nextRequest, 'quantity')) nextRequest.quantity = result.request.quantity;

  const firstIndex = next.samples.findIndex(item => String(item?.requestNo) === requestNo);
  next.samples = next.samples.filter(item => String(item?.requestNo) !== requestNo);
  next.samples.splice(firstIndex < 0 ? next.samples.length : firstIndex, 0, ...result.samples);
  return next;
}

function requireText(command, field, label) {
  if (typeof command?.[field] !== 'string' || command[field].trim() === '') {
    throw domainError('COMMAND_FIELD_REQUIRED', `${label}不能为空`, { field });
  }
}

function requireAssignmentCommand(command) {
  if (!command || typeof command !== 'object') {
    throw domainError('COMMAND_REQUIRED', '缺少预约命令');
  }
  for (const [field, label] of [
    ['requestNo', '申请单号'],
    ['sampleId', '子样品编号'],
    ['channelKey', '通道标识'],
    ['start', '开始时间'],
    ['actor', '操作者'],
    ['recordId', '使用记录标识'],
    ['auditId', '审计标识'],
    ['now', '操作时间']
  ]) requireText(command, field, label);
  if (!Number.isFinite(Date.parse(command.now))) {
    throw domainError('COMMAND_TIME_INVALID', '操作时间无效');
  }
}

function normalizedRecordStatus(record) {
  return ACTIVE_RECORD_STATUS.get(String(record?.status || '').trim()) || '';
}

function removeLegacyRecordStates(state) {
  for (const record of state.records) {
    const status = normalizedRecordStatus(record);
    if (status) record.status = status;
    delete record.state;
  }
}

function recordKeys(record) {
  const keys = Array.isArray(record?.keys) ? record.keys.map(String) : [];
  if (record?.channelKey) keys.push(String(record.channelKey));
  return [...new Set(keys)];
}

function recordsForPolicy(state, channel) {
  return state.records
    .filter(record => recordKeys(record).includes(channel.key))
    .map(record => ({
      ...record,
      channelKey: channel.key,
      status: normalizedRecordStatus(record),
      start: String(record.start ?? record.time ?? ''),
      end: String(record.end ?? (normalizedRecordStatus(record) === 'running' ? channel.end ?? '' : ''))
    }))
    .filter(record => record.status);
}

function findAssignmentEntities(state, command) {
  const request = findRequest(state, command.requestNo);
  const requestNo = requestNumber(request);
  const sample = state.samples.find(item => item?.id === command.sampleId);
  if (!sample || String(sample.requestNo) !== requestNo) {
    throw domainError('SAMPLE_NOT_FOUND', '子样品不存在或不属于当前申请');
  }
  if (sample.status !== 'pending') {
    throw domainError('SAMPLE_NOT_PENDING', '只有待安排子样品可以开始或预约');
  }
  const channel = state.channels.find(item => item?.key === command.channelKey);
  if (!channel) throw domainError('CHANNEL_NOT_FOUND', '通道不存在');
  if (
    state.records.some(item => String(item?.id || '') === command.recordId) ||
    state.auditLogs.some(item => String(item?.id || '') === command.auditId)
  ) {
    throw domainError('IDENTIFIER_ALREADY_EXISTS', '使用记录或审计标识已存在');
  }
  return { request, requestNo, sample, channel };
}

function assignmentAudit({ command, mode, request, sample, channel, nextChannel, policy }) {
  const outcome = policy.severity === 'warning' ? 'warning' : 'success';
  return {
    id: command.auditId,
    time: command.now,
    at: command.now,
    user: command.actor,
    actor: command.actor,
    action: mode === 'start' ? '开始测试' : '提交预约',
    target: `申请单 ${requestNumber(request)} / 子样品 ${sample.id} / 通道 ${channel.key}`,
    outcome,
    result: outcome,
    verified: true,
    level: policy.severity === 'warning' ? 'warning' : 'normal',
    requestNo: requestNumber(request),
    sampleId: sample.id,
    channelKey: channel.key,
    before: { channelState: channel.state, sampleStatus: sample.status },
    after: {
      channelState: nextChannel.state,
      sampleStatus: mode === 'start' ? 'running' : 'reserved',
      recordStatus: mode === 'start' ? 'running' : 'reserved'
    },
    note: policy.severity === 'warning' ? policy.message : String(command.note || '')
  };
}

function applyAssignment(mode, state, command) {
  requireState(state);
  requireAssignmentCommand(command);
  const { request, requestNo, sample, channel } = findAssignmentEntities(state, command);
  let policy;
  try {
    policy = validateAssignment({
      mode,
      channel,
      records: recordsForPolicy(state, channel),
      start: command.start,
      end: command.end ?? ''
    });
  } catch (error) {
    throw domainError('TIME_INTERVAL_INVALID', error.message);
  }
  if (!policy.allowed) throw domainError(policy.code, policy.message);
  if (policy.severity === 'warning' && command.acceptWarning !== true) {
    throw domainError('WARNING_CONFIRMATION_REQUIRED', `需要确认 WARNING：${policy.message}`);
  }

  const next = structuredClone(state);
  removeLegacyRecordStates(next);
  const nextChannel = next.channels.find(item => item.key === channel.key);
  const nextSample = next.samples.find(item => item.id === sample.id);
  const recordStatus = mode === 'start' ? 'running' : 'reserved';
  const channelLabel = `${channel.device || ''} · ${channel.name || channel.key}`.trim();

  nextSample.status = recordStatus;
  nextSample.channelKey = channel.key;
  nextSample.start = command.start;
  nextSample.end = command.end ?? '';
  nextSample.hasHistory = true;

  if (mode === 'start') {
    nextChannel.state = 'busy';
    nextChannel.currentRecordId = command.recordId;
    nextChannel.nextRecordId = '';
    nextChannel.start = command.start;
    nextChannel.end = command.end ?? '';
  } else {
    if (nextChannel.state === 'free') {
      nextChannel.state = 'booked';
      nextChannel.start = command.start;
      nextChannel.end = command.end ?? '';
    }
    nextChannel.nextRecordId = command.recordId;
  }
  if (mode === 'start' || channel.state === 'free') {
    nextChannel.project = request.project || '';
    nextChannel.user = command.actor;
    nextChannel.requestNo = requestNo;
    nextChannel.test = request.test || request.testName || '';
  }

  next.records.unshift({
    id: command.recordId,
    no: requestNo,
    requestNo,
    sampleId: sample.id,
    channelKey: channel.key,
    keys: [channel.key],
    project: request.project || '',
    test: request.test || request.testName || '',
    sample: request.sample || request.sampleName || '',
    client: request.client || '',
    dept: request.dept || '',
    channels: channelLabel,
    status: recordStatus,
    time: command.start,
    start: command.start,
    end: command.end ?? '',
    actualEnd: '',
    user: command.actor,
    actor: command.actor,
    note: command.note ?? '',
    source: '软件操作',
    createdAt: command.now,
    warningCode: policy.severity === 'warning' ? policy.code : ''
  });
  next.auditLogs.unshift(assignmentAudit({
    command, mode, request, sample, channel, nextChannel, policy
  }));
  recomputeLegacyRequestStatus(next, requestNo);
  return next;
}

export function startLegacySample(state, command) {
  return applyAssignment('start', state, command);
}

export function reserveLegacySample(state, command) {
  return applyAssignment('reserve', state, command);
}

function requireTransitionCommand(command) {
  if (!command || typeof command !== 'object') {
    throw domainError('COMMAND_REQUIRED', '缺少通道迁移命令');
  }
  for (const [field, label] of [
    ['action', '迁移动作'],
    ['channelKey', '通道标识'],
    ['actor', '操作者'],
    ['auditId', '审计标识'],
    ['now', '操作时间']
  ]) requireText(command, field, label);
  if (!['end', 'start', 'cancel', 'extend', 'fault', 'recover'].includes(command.action)) {
    throw domainError('TRANSITION_UNSUPPORTED', `不支持的通道迁移动作：${command.action}`);
  }
  if (!Number.isFinite(Date.parse(command.now))) {
    throw domainError('COMMAND_TIME_INVALID', '操作时间无效');
  }
}

function recordsForChannel(state, channelKey, status) {
  return state.records.filter(record =>
    recordKeys(record).includes(channelKey) && normalizedRecordStatus(record) === status
  );
}

function recordRequestNumber(record) {
  return String(record?.requestNo ?? record?.no ?? '').trim();
}

function validateTransitionOwner(state, channel, status, pointerField, code) {
  const pointer = String(channel?.[pointerField] || '');
  const candidates = recordsForChannel(state, channel.key, status);
  if (!pointer || candidates.length !== 1 || String(candidates[0]?.id || '') !== pointer) {
    throw domainError(code, '通道指针与活动使用记录不一致', {
      channelKey: channel.key, pointerField, pointer, count: candidates.length
    });
  }
  const record = candidates[0];
  const channelKeys = recordKeys(record);
  const requestNo = recordRequestNumber(record);
  const sampleId = String(record?.sampleId || '').trim();
  const samples = state.samples.filter(sample => String(sample?.id || '') === sampleId);
  const sample = samples[0];
  const requestMatches = state.requests.filter(request => requestNumber(request) === requestNo);
  const activeSampleOwners = state.records.filter(item => {
    const itemStatus = normalizedRecordStatus(item);
    return String(item?.sampleId || '').trim() === sampleId &&
      (itemStatus === 'reserved' || itemStatus === 'running');
  });
  if (
    normalizedRecordStatus(record) !== status ||
    channelKeys.length !== 1 || channelKeys[0] !== channel.key ||
    !sampleId || samples.length !== 1 || String(sample?.status || '') !== status ||
    String(sample?.channelKey || '') !== channel.key ||
    !requestNo || String(sample?.requestNo || '') !== requestNo || requestMatches.length !== 1 ||
    activeSampleOwners.length !== 1 || activeSampleOwners[0] !== record
  ) {
    throw domainError(code, '使用记录、子样品、申请与通道归属不一致', {
      channelKey: channel.key, recordId: record?.id, sampleId, requestNo
    });
  }
  return record;
}

function validateEndOwnership(state, channel) {
  const running = validateTransitionOwner(state, channel, 'running', 'currentRecordId', 'RUNNING_RECORD_INVALID');
  const reserved = recordsForChannel(state, channel.key, 'reserved');
  let queued = null;
  if (channel.nextRecordId) {
    queued = validateTransitionOwner(state, channel, 'reserved', 'nextRecordId', 'QUEUED_RECORD_INVALID');
  } else if (reserved.length !== 0) {
    throw domainError('QUEUED_RECORD_INVALID', '通道存在未由 nextRecordId 指向的预约记录');
  }
  return { running, queued };
}

function validateBookedOwnership(state, channel) {
  if (String(channel.currentRecordId || '') !== '' || recordsForChannel(state, channel.key, 'running').length !== 0) {
    throw domainError('QUEUED_RECORD_INVALID', '已预约通道不能同时持有当前测试记录');
  }
  return validateTransitionOwner(state, channel, 'reserved', 'nextRecordId', 'QUEUED_RECORD_INVALID');
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

function applyQueuedDisplay(state, channel, record) {
  const request = state.requests.find(item => requestNumber(item) === String(record.requestNo ?? record.no));
  channel.state = 'booked';
  channel.project = record.project || request?.project || '';
  channel.user = record.user || record.actor || '';
  channel.start = record.start || record.time || '';
  channel.end = record.end || '';
  channel.requestNo = record.requestNo || record.no || '';
  channel.test = record.test || request?.test || request?.testName || '';
  channel.currentRecordId = '';
  channel.nextRecordId = record.id || channel.nextRecordId;
}

function transitionAudit(command, channelKey, before, after) {
  const labels = {
    end: '结束测试',
    start: '开始预约测试',
    cancel: '取消预约',
    extend: '延期通道',
    fault: '停用通道',
    recover: '恢复通道'
  };
  const level = command.action === 'extend' || command.action === 'fault' || command.action === 'recover'
    ? 'warning'
    : 'normal';
  const outcome = level === 'warning' ? 'warning' : 'success';
  return {
    id: command.auditId,
    time: command.now,
    at: command.now,
    user: command.actor,
    actor: command.actor,
    action: labels[command.action],
    target: `通道 ${channelKey}`,
    outcome,
    result: outcome,
    verified: true,
    level,
    channelKey,
    before,
    after,
    note: String(command.note || '状态流转')
  };
}

export function transitionLegacyChannel(state, command) {
  requireState(state);
  requireTransitionCommand(command);
  if (state.auditLogs.some(item => String(item?.id || '') === command.auditId)) {
    throw domainError('IDENTIFIER_ALREADY_EXISTS', '审计标识已存在');
  }
  const originalChannel = state.channels.find(item => item?.key === command.channelKey);
  if (!originalChannel) throw domainError('CHANNEL_NOT_FOUND', '通道不存在');

  let transitionOwner = null;
  if (command.action === 'end') {
    if (originalChannel.state !== 'busy') throw domainError('END_REQUIRES_BUSY_CHANNEL', '只有测试中通道可以结束');
    transitionOwner = validateEndOwnership(state, originalChannel);
  }
  if (command.action === 'start' || command.action === 'cancel') {
    const code = command.action === 'start' ? 'START_REQUIRES_BOOKED_CHANNEL' : 'CANCEL_REQUIRES_BOOKED_CHANNEL';
    if (originalChannel.state !== 'booked') {
      throw domainError(code, command.action === 'start' ? '只有已预约通道可以转为测试中' : '只有已预约通道可以取消预约');
    }
    transitionOwner = validateBookedOwnership(state, originalChannel);
  }

  const next = structuredClone(state);
  removeLegacyRecordStates(next);
  const channel = next.channels.find(item => item.key === command.channelKey);
  const before = structuredClone(channel);

  if (command.action === 'end') {
    const running = next.records.find(item => item.id === transitionOwner.running.id);
    running.status = 'completed';
    running.actualEnd = command.now;
    running.completedAt = command.now;
    const runningSample = next.samples.find(item => item.id === running.sampleId);
    if (runningSample) {
      runningSample.status = 'completed';
      runningSample.end = command.now;
      runningSample.hasHistory = true;
    }
    const queued = transitionOwner.queued
      ? next.records.find(item => item.id === transitionOwner.queued.id)
      : null;
    if (queued) applyQueuedDisplay(next, channel, queued);
    else clearChannel(channel);
  }

  if (command.action === 'start') {
    const queued = next.records.find(item => item.id === transitionOwner.id);
    queued.scheduledStart = queued.start || queued.time || '';
    queued.status = 'running';
    queued.time = command.now;
    queued.start = command.now;
    queued.actualStart = command.now;
    const queuedSample = next.samples.find(item => item.id === queued.sampleId);
    if (queuedSample) {
      queuedSample.status = 'running';
      queuedSample.start = command.now;
      queuedSample.hasHistory = true;
    }
    channel.state = 'busy';
    channel.currentRecordId = queued.id || '';
    channel.nextRecordId = '';
    channel.start = command.now;
    channel.end = queued.end || '';
  }

  if (command.action === 'cancel') {
    const queued = next.records.find(item => item.id === transitionOwner.id);
    queued.status = 'cancelled';
    queued.cancelledAt = command.now;
    const queuedSample = next.samples.find(item => item.id === queued.sampleId);
    if (queuedSample) {
      queuedSample.status = 'cancelled';
      queuedSample.end = command.now;
      queuedSample.hasHistory = true;
    }
    clearChannel(channel);
  }

  if (command.action === 'extend') {
    if (channel.state !== 'busy') throw domainError('EXTEND_REQUIRES_BUSY_CHANNEL', '只有测试中通道可以延期');
    const end = Date.parse(channel.end);
    if (!Number.isFinite(end)) throw domainError('CHANNEL_END_REQUIRED', '通道缺少有效预计结束时间，不能延期');
    const hours = command.hours ?? 24;
    if (!Number.isInteger(hours) || hours < 1 || hours > 168) {
      throw domainError('EXTENSION_HOURS_INVALID', '延期小时数必须是 1–168 的整数');
    }
    channel.end = new Date(end + hours * 60 * 60 * 1000).toISOString();
    const running = channel.currentRecordId
      ? next.records.find(item => item.id === channel.currentRecordId)
      : recordsForChannel(next, channel.key, 'running')[0];
    if (running) running.end = channel.end;
    const runningSample = running ? next.samples.find(item => item.id === running.sampleId) : null;
    if (runningSample) runningSample.end = channel.end;
  }

  if (command.action === 'fault') {
    if (channel.state === 'busy' || channel.state === 'booked') {
      throw domainError('ACTIVE_CHANNEL_FAULT_BLOCKED', '活动或已预约通道必须先结束或取消，不能直接标记故障');
    }
    if (channel.state !== 'free') throw domainError('FAULT_REQUIRES_FREE_CHANNEL', '只有空闲通道可以标记故障');
    clearChannel(channel);
    channel.state = 'fault';
  }

  if (command.action === 'recover') {
    if (channel.state !== 'fault') throw domainError('RECOVER_REQUIRES_FAULT_CHANNEL', '只有故障通道可以恢复');
    clearChannel(channel);
  }

  next.auditLogs.unshift(transitionAudit(command, channel.key, before, structuredClone(channel)));
  return next;
}
