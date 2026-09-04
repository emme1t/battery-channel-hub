import { validateAssignment } from './reservation-policy.mjs';

function domainError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function requireCollections(state) {
  const names = ['requests', 'samples', 'channels', 'records', 'audits'];
  if (!state || typeof state !== 'object') {
    throw domainError('缺少状态数据', 'STATE_REQUIRED');
  }
  for (const name of names) {
    if (!Array.isArray(state[name])) {
      throw domainError(`状态集合 ${name} 无效`, 'STATE_COLLECTION_INVALID');
    }
  }
}

function requireCommand(command) {
  const required = [
    ['requestNo', '申请单号'],
    ['sampleId', '子样品编号'],
    ['channelKey', '通道标识'],
    ['start', '开始时间'],
    ['actor', '操作者'],
    ['recordId', '使用记录标识'],
    ['auditId', '审计标识'],
    ['now', '操作时间']
  ];
  if (!command || typeof command !== 'object') {
    throw domainError('缺少操作命令', 'COMMAND_REQUIRED');
  }
  for (const [field, label] of required) {
    if (typeof command[field] !== 'string' || command[field].trim() === '') {
      throw domainError(`${label}不能为空`, 'COMMAND_FIELD_REQUIRED');
    }
  }
  if (!Number.isFinite(Date.parse(command.now))) {
    throw domainError('操作时间无效', 'COMMAND_TIME_INVALID');
  }
}

function findEntities(state, command) {
  const request = state.requests.find((item) => item.requestNo === command.requestNo);
  if (!request) {
    throw domainError('申请不存在', 'REQUEST_NOT_FOUND');
  }
  const sample = state.samples.find((item) => item.id === command.sampleId);
  if (!sample || sample.requestNo !== request.requestNo) {
    throw domainError('子样品不存在或不属于当前申请', 'SAMPLE_NOT_FOUND');
  }
  if (sample.status !== 'pending') {
    throw domainError('只有待安排子样品可以开始或预约', 'SAMPLE_NOT_PENDING');
  }
  const channel = state.channels.find((item) => item.key === command.channelKey);
  if (!channel) {
    throw domainError('通道不存在', 'CHANNEL_NOT_FOUND');
  }
  if (
    state.records.some((item) => item.id === command.recordId) ||
    state.audits.some((item) => item.id === command.auditId)
  ) {
    throw domainError('使用记录或审计标识已存在', 'IDENTIFIER_ALREADY_EXISTS');
  }
  return { request, sample, channel };
}

function applyTransaction(mode, state, command) {
  requireCollections(state);
  requireCommand(command);
  const { request, sample, channel } = findEntities(state, command);
  const policy = validateAssignment({
    mode,
    channel,
    records: state.records,
    start: command.start,
    end: command.end ?? ''
  });

  if (!policy.allowed) {
    throw domainError(policy.message, policy.code);
  }
  if (policy.severity === 'warning' && command.acceptWarning !== true) {
    throw domainError(`需要确认 WARNING：${policy.message}`, 'WARNING_CONFIRMATION_REQUIRED');
  }

  const next = structuredClone(state);
  const nextChannel = next.channels.find((item) => item.key === channel.key);
  const nextSample = next.samples.find((item) => item.id === sample.id);
  const status = mode === 'start' ? 'running' : 'reserved';
  const previousChannelState = nextChannel.state;

  nextSample.status = status;
  nextSample.channelKey = channel.key;
  nextSample.start = command.start;
  nextSample.end = command.end ?? '';
  nextSample.hasHistory = true;

  if (mode === 'start') {
    nextChannel.state = 'busy';
    nextChannel.currentRecordId = command.recordId;
    nextChannel.start = command.start;
    nextChannel.end = command.end ?? '';
  } else if (nextChannel.state === 'free') {
    nextChannel.state = 'booked';
    nextChannel.nextRecordId = command.recordId;
  } else {
    nextChannel.nextRecordId = command.recordId;
  }

  next.records.push({
    id: command.recordId,
    requestNo: request.requestNo,
    sampleId: sample.id,
    channelKey: channel.key,
    status,
    start: command.start,
    end: command.end ?? '',
    actualEnd: '',
    actor: command.actor,
    note: command.note ?? '',
    createdAt: command.now,
    warningCode: policy.severity === 'warning' ? policy.code : ''
  });

  next.audits.push({
    id: command.auditId,
    at: command.now,
    actor: command.actor,
    action: mode === 'start' ? 'start-sample' : 'reserve-sample',
    result: 'success',
    level: policy.severity === 'warning' ? 'WARNING' : 'NORMAL',
    requestNo: request.requestNo,
    sampleId: sample.id,
    channelKey: channel.key,
    note: policy.severity === 'warning' ? policy.message : (command.note ?? ''),
    before: {
      channelState: previousChannelState,
      sampleStatus: sample.status
    },
    after: {
      channelState: nextChannel.state,
      sampleStatus: nextSample.status,
      recordStatus: status
    }
  });

  return {
    state: next,
    warnings: policy.severity === 'warning' ? [policy.message] : []
  };
}

export function startSample(state, command) {
  return applyTransaction('start', state, command);
}

export function reserveSample(state, command) {
  return applyTransaction('reserve', state, command);
}
