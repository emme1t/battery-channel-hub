const COLLECTIONS = [
  'requests',
  'samples',
  'devices',
  'channels',
  'records',
  'audits',
  'requestSourceRows'
];

const SAMPLE_STATUSES = new Set(['pending', 'reserved', 'running', 'completed', 'cancelled']);
const CHANNEL_STATES = new Set(['free', 'busy', 'booked', 'fault']);
const RECORD_STATUSES = new Set(['reserved', 'running', 'completed', 'cancelled']);

export function createEmptyState(overrides = {}) {
  return {
    schemaVersion: 2,
    dataRevision: 0,
    username: '',
    requests: [],
    samples: [],
    devices: [],
    channels: [],
    records: [],
    audits: [],
    requestSourceRows: [],
    ...structuredClone(overrides)
  };
}

function textKey(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function uniqueIndex(items, keyOf, label, blockers) {
  const keys = new Set();
  for (const item of Array.isArray(items) ? items : []) {
    const key = textKey(keyOf(item));
    if (!key) {
      blockers.push(`${label} must not be empty`);
      continue;
    }
    if (keys.has(key)) blockers.push(`duplicate ${label} ${key}`);
    keys.add(key);
  }
  return keys;
}

function validateRequests(requests, blockers) {
  const requestIds = uniqueIndex(requests, (item) => item?.requestNo, 'requestNo', blockers);
  for (const request of Array.isArray(requests) ? requests : []) {
    if (!Number.isInteger(request?.quantity) || request.quantity < 1 || request.quantity > 999) {
      blockers.push(`request ${textKey(request?.requestNo) || '(unknown)'} quantity must be an integer from 1 to 999`);
    }
  }
  return requestIds;
}

function validateDevices(devices, blockers) {
  return uniqueIndex(devices, (item) => item?.id, 'device id', blockers);
}

function validateSamples(samples, requestIds, blockers) {
  const sampleIds = uniqueIndex(samples, (item) => item?.id, 'sample id', blockers);
  for (const sample of Array.isArray(samples) ? samples : []) {
    const id = textKey(sample?.id) || '(unknown)';
    const requestNo = textKey(sample?.requestNo);
    if (!requestIds.has(requestNo)) blockers.push(`sample ${id} references missing request ${requestNo || '(empty)'}`);
    if (!Number.isInteger(sample?.ordinal) || sample.ordinal < 1 || sample.ordinal > 999) {
      blockers.push(`sample ordinal must be an integer from 1 to 999 for ${id}`);
    } else if (requestNo && id !== `${requestNo}.${String(sample.ordinal).padStart(3, '0')}`) {
      blockers.push(`sample ${id} does not match request and ordinal`);
    }
    if (!SAMPLE_STATUSES.has(sample?.status)) blockers.push(`unsupported sample status ${String(sample?.status)}`);
  }
  return sampleIds;
}

function validateChannels(channels, deviceIds, blockers) {
  const channelIds = uniqueIndex(channels, (item) => item?.key, 'channel key', blockers);
  for (const channel of Array.isArray(channels) ? channels : []) {
    const key = textKey(channel?.key) || '(unknown)';
    const deviceId = textKey(channel?.deviceId);
    if (!deviceIds.has(deviceId)) blockers.push(`channel ${key} references missing device ${deviceId || '(empty)'}`);
    if (!CHANNEL_STATES.has(channel?.state)) blockers.push(`unsupported channel state ${String(channel?.state)}`);
  }
  return channelIds;
}

function validateRecords(records, requestIds, sampleIds, channelIds, samples, channels, blockers) {
  uniqueIndex(records, (item) => item?.id, 'record id', blockers);
  const sampleById = new Map((Array.isArray(samples) ? samples : []).map((item) => [item.id, item]));
  const channelById = new Map((Array.isArray(channels) ? channels : []).map((item) => [item.key, item]));
  const runningChannels = new Set();
  const reservedChannels = new Set();
  const activeSamples = new Set();

  for (const record of Array.isArray(records) ? records : []) {
    const id = textKey(record?.id) || '(unknown)';
    const requestNo = textKey(record?.requestNo);
    const sampleId = textKey(record?.sampleId);
    const channelKey = textKey(record?.channelKey);
    if (!requestIds.has(requestNo)) blockers.push(`record ${id} references missing request ${requestNo || '(empty)'}`);
    if (!sampleIds.has(sampleId)) blockers.push(`record ${id} references missing sample ${sampleId || '(empty)'}`);
    if (!channelIds.has(channelKey)) blockers.push(`record ${id} references missing channel ${channelKey || '(empty)'}`);
    if (!RECORD_STATUSES.has(record?.status)) blockers.push(`unsupported record status ${String(record?.status)}`);

    const sample = sampleById.get(sampleId);
    if (sample && requestNo && sample.requestNo !== requestNo) {
      blockers.push(`record ${id} request does not own sample ${sampleId}`);
    }

    if (record?.status === 'running' || record?.status === 'reserved') {
      if (activeSamples.has(sampleId)) blockers.push(`sample ${sampleId} has multiple active records`);
      activeSamples.add(sampleId);
      if (sample && (sample.status !== record.status || sample.channelKey !== channelKey)) {
        blockers.push(`record ${id} is inconsistent with sample ${sampleId}`);
      }
    }

    const channel = channelById.get(channelKey);
    if (record?.status === 'running') {
      if (runningChannels.has(channelKey)) blockers.push(`channel ${channelKey} has multiple active records`);
      runningChannels.add(channelKey);
      if (channel && (channel.state !== 'busy' || channel.currentRecordId !== id)) {
        blockers.push(`running record ${id} is inconsistent with channel ${channelKey}`);
      }
    }
    if (record?.status === 'reserved') {
      if (reservedChannels.has(channelKey)) blockers.push(`channel ${channelKey} has multiple active records`);
      reservedChannels.add(channelKey);
      if (channel && !['busy', 'booked'].includes(channel.state)) {
        blockers.push(`reserved record ${id} is inconsistent with channel ${channelKey}`);
      }
      if (channel && channel.nextRecordId !== id) {
        blockers.push(`reserved record ${id} is not the next record for channel ${channelKey}`);
      }
    }
  }
}

export function summarizeState(value) {
  const count = (name) => Array.isArray(value?.[name]) ? value[name].length : 0;
  return {
    revision: Number.isInteger(value?.dataRevision) ? value.dataRevision : null,
    requests: count('requests'),
    samples: count('samples'),
    devices: count('devices'),
    channels: count('channels'),
    records: count('records'),
    audits: count('audits'),
    requestSourceRows: count('requestSourceRows')
  };
}

export function validateState(value) {
  const blockers = [];
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    blockers.push('state must be an object');
  }
  if (value?.schemaVersion !== 2) blockers.push('schemaVersion must equal 2');
  if (!Number.isInteger(value?.dataRevision) || value.dataRevision < 0) {
    blockers.push('dataRevision must be a non-negative integer');
  }
  for (const name of COLLECTIONS) {
    if (!Array.isArray(value?.[name])) blockers.push(`${name} must be an array`);
  }

  const requestIds = validateRequests(value?.requests, blockers);
  const deviceIds = validateDevices(value?.devices, blockers);
  const sampleIds = validateSamples(value?.samples, requestIds, blockers);
  const channelIds = validateChannels(value?.channels, deviceIds, blockers);
  validateRecords(
    value?.records,
    requestIds,
    sampleIds,
    channelIds,
    value?.samples,
    value?.channels,
    blockers
  );
  uniqueIndex(value?.audits, (item) => item?.id, 'audit id', blockers);

  return {
    ok: blockers.length === 0,
    blockers,
    summary: summarizeState(value)
  };
}

export function assertValidState(value) {
  const result = validateState(value);
  if (!result.ok) {
    const error = new Error(`vNext 状态校验失败：${result.blockers.join('；')}`);
    error.code = 'INVALID_VNEXT_STATE';
    error.blockers = result.blockers;
    throw error;
  }
  return structuredClone(value);
}
