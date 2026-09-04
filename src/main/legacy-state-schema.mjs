import { sampleId } from '../domain/sample-quantity.mjs';

const COLLECTIONS = Object.freeze([
  'requests',
  'channels',
  'deviceProfiles',
  'records',
  'samples',
  'requestSourceRows',
  'auditLogs',
  'formChangeJournal',
  'testers',
  'storageRecords'
]);

const REQUEST_STATUS = new Map([
  ['pending', 'pending'], ['待安排', 'pending'],
  ['partially_assigned', 'partially_assigned'], ['部分安排', 'partially_assigned'],
  ['assigned', 'assigned'], ['已安排', 'assigned'],
  ['reserved', 'reserved'], ['已预约', 'reserved'],
  ['running', 'running'], ['测试中', 'running'],
  ['completed', 'completed'], ['已完成', 'completed'], ['已结束', 'completed'],
  ['cancelled', 'cancelled'], ['已取消', 'cancelled']
]);

const RECORD_STATUS = new Map([
  ['pending', 'pending'], ['待安排', 'pending'],
  ['reserved', 'reserved'], ['booked', 'reserved'], ['已预约', 'reserved'],
  ['running', 'running'], ['testing', 'running'], ['busy', 'running'], ['测试中', 'running'],
  ['completed', 'completed'], ['已完成', 'completed'], ['已结束', 'completed'],
  ['cancelled', 'cancelled'], ['已取消', 'cancelled'],
  ['returned', 'returned'], ['已退回', 'returned']
]);

const ENABLED_STATUS = new Map([
  ['enabled', 'enabled'], ['active', 'enabled'], ['启用', 'enabled'],
  ['disabled', 'disabled'], ['inactive', 'disabled'], ['停用', 'disabled']
]);

const STORAGE_STATUS = new Map([
  ['storing', 'storing'],
  ['paused', 'exception'],
  ['exception', 'exception'],
  ['completed', 'completed'],
  ['returned', 'returned']
]);

const SAMPLE_STATUS = new Map([
  ...RECORD_STATUS,
  ['storing', 'storing'],
  ['paused', 'exception'],
  ['exception', 'exception'],
  ['returned', 'returned']
]);

const ACTIVE_RECORD_STATUS = new Set(['reserved', 'running']);
const ACTIVE_STORAGE_STATUS = new Set(['storing', 'exception']);

function codedError(code, message, details = undefined) {
  const error = new Error(message);
  error.code = code;
  if (details !== undefined) error.details = details;
  return error;
}

function assertUnique(items, keyOf, code, label) {
  const seen = new Set();
  for (const item of items) {
    const key = String(keyOf(item) ?? '').trim();
    if (!key) throw codedError(`${label}_KEY_MISSING`, `${label} 缺少唯一键`);
    if (seen.has(key)) throw codedError(code, `${label} 唯一键重复：${key}`, { key });
    seen.add(key);
  }
}

function validateDeviceAndChannelReferences(state) {
  assertUnique(state.deviceProfiles, item => item?.id, 'DEVICE_ID_DUPLICATE', 'DEVICE');
  assertUnique(state.deviceProfiles, item => item?.name, 'DEVICE_NAME_DUPLICATE', 'DEVICE_NAME');
  assertUnique(state.channels, item => item?.key, 'CHANNEL_KEY_DUPLICATE', 'CHANNEL');

  const deviceNames = new Set(state.deviceProfiles.map(item => String(item.name)));
  for (const channel of state.channels) {
    const device = String(channel?.device ?? '').trim();
    if (!deviceNames.has(device)) {
      throw codedError(
        'CHANNEL_DEVICE_UNKNOWN',
        `通道 ${String(channel?.key ?? '')} 引用了不存在的设备：${device}`,
        { channelKey: channel?.key, device }
      );
    }
  }
}

function canonicalStatus(value, mapping, code, label, fallback = '') {
  const raw = String(value ?? '').trim();
  if (!raw) return fallback;
  const status = mapping.get(raw);
  if (!status) throw codedError(code, `${label}状态无效：${raw}`, { status: raw });
  return status;
}

function canonicalizeBusinessStatuses(state) {
  for (const request of state.requests) {
    request.status = canonicalStatus(request.status, REQUEST_STATUS, 'REQUEST_STATUS_INVALID', '申请单', 'pending');
  }
  for (const profile of state.deviceProfiles) {
    profile.status = canonicalStatus(profile.status, ENABLED_STATUS, 'DEVICE_STATUS_INVALID', '设备', 'enabled');
  }
  for (const tester of state.testers) {
    tester.status = canonicalStatus(tester.status, ENABLED_STATUS, 'TESTER_STATUS_INVALID', '测试人员', 'enabled');
  }
  for (const sample of state.samples) {
    sample.status = canonicalStatus(sample.status, SAMPLE_STATUS, 'SAMPLE_STATUS_INVALID', '子样品', 'pending');
  }

  const channels = new Map(state.channels.map(channel => [String(channel?.key || ''), channel]));
  for (const record of state.records) {
    const canonical = canonicalStatus(record.status, RECORD_STATUS, 'RECORD_STATUS_INVALID', '使用记录');
    const legacy = canonicalStatus(record.state, RECORD_STATUS, 'RECORD_STATUS_INVALID', '使用记录');
    let status = canonical || legacy;
    if (canonical && legacy && canonical !== legacy) {
      const channelKey = String(record.channelKey || record.keys?.[0] || '');
      const channel = channels.get(channelKey);
      const halfStarted = canonical === 'reserved' && legacy === 'running'
        && channel?.state === 'busy'
        && String(channel.currentRecordId || '') === ''
        && String(channel.nextRecordId || '') === String(record.id || '');
      if (!halfStarted) {
        throw codedError('RECORD_STATUS_CONFLICT', `使用记录 ${String(record.id || '')} 的 status 与旧 state 冲突`, {
          id: record.id, status: canonical, legacyState: legacy
        });
      }
      status = 'running';
      channel.currentRecordId = record.id;
      channel.nextRecordId = '';
      const sample = state.samples.find(item => String(item?.id || '') === String(record.sampleId || ''));
      if (sample) sample.status = 'running';
    }
    if (status) record.status = status;
    delete record.state;
  }

  for (const storageRecord of state.storageRecords) {
    storageRecord.status = canonicalStatus(
      storageRecord.status,
      STORAGE_STATUS,
      'STORAGE_STATUS_INVALID',
      '长期存储',
      'storing'
    );
  }
}

function recordChannelKeys(record) {
  return [...new Set([
    record?.channelKey,
    ...(Array.isArray(record?.keys) ? record.keys : [])
  ].map(value => String(value ?? '').trim()).filter(Boolean))];
}

function firstText(...values) {
  return values.map(value => String(value ?? '').trim()).find(Boolean) || '';
}

function inferMissingSample(state, { id, requestNo, ordinal }) {
  const ordinaryOwners = state.records.filter(record =>
    ACTIVE_RECORD_STATUS.has(String(record?.status || '')) &&
    String(record?.sampleId || '').trim() === id
  );
  const storageOwners = state.storageRecords.filter(record =>
    ACTIVE_STORAGE_STATUS.has(String(record?.status || '')) &&
    Array.isArray(record?.sampleIds) && record.sampleIds.map(value => String(value ?? '').trim()).includes(id)
  );
  const ownerCount = ordinaryOwners.length + storageOwners.length;
  if (ownerCount > 1) {
    throw codedError(
      'MISSING_SAMPLE_OWNER_CONFLICT',
      `缺失子样品存在多个活动归属，拒绝猜测：${id}`,
      { sampleId: id, ordinaryOwners: ordinaryOwners.map(item => item.id), storageOwners: storageOwners.map(item => item.id) }
    );
  }
  if (ownerCount === 0) {
    return {
      id, requestNo, ordinal, status: 'pending',
      channelKey: '', start: '', end: '', hasHistory: false
    };
  }

  if (ordinaryOwners.length === 1) {
    const record = ordinaryOwners[0];
    const recordRequestNo = firstText(record.requestNo, record.no);
    const channelKeys = recordChannelKeys(record);
    const start = firstText(record.start, record.time, record.actualStart);
    if (
      recordRequestNo !== requestNo || channelKeys.length !== 1 || !start ||
      !state.channels.some(channel => String(channel?.key || '') === channelKeys[0])
    ) {
      throw codedError(
        'MISSING_SAMPLE_OWNER_INVALID',
        `缺失子样品的活动普通记录无法唯一推导：${id}`,
        { sampleId: id, recordId: record.id, requestNo: recordRequestNo, channelKeys }
      );
    }
    return {
      id,
      requestNo,
      ordinal,
      status: record.status,
      channelKey: channelKeys[0],
      start,
      end: firstText(record.end),
      hasHistory: true
    };
  }

  const storageRecord = storageOwners[0];
  const storageRequestNo = firstText(storageRecord.requestNo, storageRecord.no);
  const start = firstText(storageRecord.startedAt, storageRecord.start);
  if (storageRequestNo !== requestNo || !start) {
    throw codedError(
      'MISSING_SAMPLE_OWNER_INVALID',
      `缺失子样品的活动长期存储记录无法唯一推导：${id}`,
      { sampleId: id, storageId: storageRecord.id, requestNo: storageRequestNo }
    );
  }
  return {
    id,
    requestNo,
    ordinal,
    status: storageRecord.status,
    channelKey: '',
    start,
    end: firstText(storageRecord.expectedEndAt, storageRecord.end),
    hasHistory: true
  };
}

function restoreMissingRequestSamples(state) {
  const knownIds = new Set(state.samples.map(sample => String(sample?.id || '').trim()));
  for (const request of state.requests) {
    const requestNo = String(request?.id ?? request?.requestNo ?? '').trim();
    const quantity = Number(request?.qty ?? request?.quantity);
    if (!requestNo || !Number.isInteger(quantity) || quantity < 1 || quantity > 999) continue;

    for (let ordinal = 1; ordinal <= quantity; ordinal += 1) {
      const id = sampleId(requestNo, ordinal);
      if (knownIds.has(id)) continue;
      state.samples.push(inferMissingSample(state, { id, requestNo, ordinal }));
      knownIds.add(id);
    }
  }
}

function validateStorageRecords(state) {
  assertUnique(state.storageRecords, item => item?.id, 'STORAGE_ID_DUPLICATE', 'STORAGE');
  const activeSampleIds = new Set();
  const ordinaryActiveSampleIds = new Set(
    state.records
      .filter(record => ACTIVE_RECORD_STATUS.has(String(record?.status || '')))
      .map(record => String(record?.sampleId || '').trim())
      .filter(Boolean)
  );
  for (const record of state.storageRecords) {
    if (!Array.isArray(record.sampleIds) || record.sampleIds.length === 0) {
      throw codedError('STORAGE_SAMPLE_IDS_INVALID', '长期存储必须包含至少一个子样品', { id: record.id });
    }
    const recordSampleIds = new Set();
    for (const sampleId of record.sampleIds) {
      const normalized = String(sampleId ?? '').trim();
      if (!normalized || recordSampleIds.has(normalized)) {
        throw codedError('STORAGE_SAMPLE_IDS_INVALID', '长期存储子样品标识无效或重复', { id: record.id });
      }
      recordSampleIds.add(normalized);
      if (!ACTIVE_STORAGE_STATUS.has(record.status)) continue;
      if (ordinaryActiveSampleIds.has(normalized) || activeSampleIds.has(normalized)) {
        throw codedError(
          'SAMPLE_ACTIVE_ASSIGNMENT_CONFLICT',
          `子样品不能同时处于普通测试/预约和长期存储：${normalized}`,
          { sampleId: normalized }
        );
      }
      activeSampleIds.add(normalized);
    }
  }
}

export function normalizeLegacyState(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw codedError('STATE_INVALID', '原 MAIN 状态必须是对象');
  }

  const state = structuredClone(value);
  for (const name of COLLECTIONS) {
    if (state[name] === undefined) state[name] = [];
    if (!Array.isArray(state[name])) {
      throw codedError('COLLECTION_INVALID', `${name} 必须是数组`, { collection: name });
    }
  }

  if (state.revision === undefined) state.revision = 0;
  if (!Number.isInteger(state.revision) || state.revision < 0) {
    throw codedError('REVISION_INVALID', 'revision 必须是非负整数');
  }
  if (state.savedAt === undefined) state.savedAt = '';
  if (typeof state.savedAt !== 'string') {
    throw codedError('SAVED_AT_INVALID', 'savedAt 必须是字符串');
  }

  canonicalizeBusinessStatuses(state);
  restoreMissingRequestSamples(state);
  assertUnique(state.samples, item => item?.id, 'SAMPLE_ID_DUPLICATE', 'SAMPLE');
  validateDeviceAndChannelReferences(state);
  validateStorageRecords(state);
  return state;
}

export function summarizeLegacyState(value) {
  const state = normalizeLegacyState(value);
  return {
    revision: state.revision,
    requests: state.requests.length,
    samples: state.samples.length,
    devices: state.deviceProfiles.length,
    channels: state.channels.length,
    records: state.records.length,
    audits: state.auditLogs.length,
    requestSourceRows: state.requestSourceRows.length,
    formChangeJournal: state.formChangeJournal.length,
    testers: state.testers.length,
    storageRecords: state.storageRecords.length
  };
}

export { COLLECTIONS };
