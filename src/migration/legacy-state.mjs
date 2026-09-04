import {
  assertValidState,
  summarizeState
} from '../domain/state-schema.mjs';

const RECORD_STATUS = new Map([
  ['已预约', 'reserved'],
  ['reserved', 'reserved'],
  ['booked', 'reserved'],
  ['测试中', 'running'],
  ['running', 'running'],
  ['testing', 'running'],
  ['busy', 'running'],
  ['已结束', 'completed'],
  ['completed', 'completed'],
  ['已取消', 'cancelled'],
  ['cancelled', 'cancelled']
]);

const CHANNEL_STATE = new Map([
  ['空闲', 'free'],
  ['free', 'free'],
  ['测试中', 'busy'],
  ['busy', 'busy'],
  ['已预约', 'booked'],
  ['booked', 'booked'],
  ['停用', 'fault'],
  ['异常', 'fault'],
  ['fault', 'fault']
]);

function text(value) {
  return value === null || value === undefined ? '' : String(value).trim();
}

function copy(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function legacySummary(source) {
  const count = (name) => Array.isArray(source?.[name]) ? source[name].length : 0;
  return {
    requests: count('requests'),
    deviceProfiles: count('deviceProfiles'),
    channels: count('channels'),
    records: count('records'),
    auditLogs: count('auditLogs'),
    requestSourceRows: count('requestSourceRows')
  };
}

function requireArray(source, name, blockers) {
  if (source[name] === undefined) return [];
  if (!Array.isArray(source[name])) {
    blockers.push(`legacy ${name} must be an array`);
    return [];
  }
  return source[name];
}

function unique(items, keyOf, label, blockers) {
  const seen = new Set();
  for (const item of items) {
    const key = text(keyOf(item));
    if (!key) {
      blockers.push(`${label} must not be empty`);
      continue;
    }
    if (seen.has(key)) blockers.push(`duplicate ${label} ${key}`);
    seen.add(key);
  }
  return seen;
}

function convertRequests(sourceRequests, blockers) {
  unique(sourceRequests, (item) => item?.id ?? item?.requestNo, 'request id', blockers);
  return sourceRequests.map((item) => {
    const requestNo = text(item?.id ?? item?.requestNo);
    const quantity = Number(item?.qty ?? item?.quantity);
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 999) {
      blockers.push(`request ${requestNo || '(unknown)'} quantity must be an integer from 1 to 999`);
    }
    return {
      requestNo,
      project: text(item?.project),
      projectNo: text(item?.projectNo),
      testName: text(item?.test ?? item?.testName),
      sampleModel: text(item?.sample ?? item?.sampleModel),
      sampleName: text(item?.sampleName),
      quantity,
      expectedStart: text(item?.startDate ?? item?.expectedStart),
      rawFields: copy(item?.rawFields) || {},
      execution: {
        tester: text(item?.tester),
        fee: Number(item?.fee) || 0,
        device: text(item?.device),
        plannedStart: text(item?.startDate),
        plannedEnd: text(item?.end),
        note: text(item?.note)
      },
      sourceFileName: text(item?.sourceFile ?? item?.sourceFileName),
      sourceFilePath: text(item?.sourcePath ?? item?.sourceFilePath),
      legacySnapshot: copy(item)
    };
  });
}

function convertDevices(sourceProfiles, sourceChannels, blockers) {
  const devices = [];
  const byName = new Map();

  for (const [index, profile] of sourceProfiles.entries()) {
    const name = text(profile?.name);
    const id = text(profile?.id) || `legacy-device-${String(index + 1).padStart(3, '0')}`;
    if (!name) blockers.push(`legacy device ${id} name must not be empty`);
    if (byName.has(name)) blockers.push(`duplicate legacy device name ${name}`);
    const converted = {
      id,
      name,
      manufacturer: text(profile?.manufacturer),
      type: text(profile?.type),
      temperatureRange: text(profile?.tempRange),
      voltageLimit: Number.isFinite(Number(profile?.voltage)) ? Number(profile.voltage) : null,
      currentLimit: Number.isFinite(Number(profile?.current)) ? Number(profile.current) : null,
      status: text(profile?.status),
      note: text(profile?.note),
      legacySnapshot: copy(profile)
    };
    devices.push(converted);
    byName.set(name, converted);
  }

  for (const channel of sourceChannels) {
    const name = text(channel?.device ?? channel?.deviceName);
    if (!name || byName.has(name)) continue;
    const converted = {
      id: `legacy-device-${String(devices.length + 1).padStart(3, '0')}`,
      name,
      manufacturer: '',
      type: '',
      temperatureRange: '',
      voltageLimit: null,
      currentLimit: null,
      status: '',
      note: '',
      legacySnapshot: null
    };
    devices.push(converted);
    byName.set(name, converted);
  }

  unique(devices, (item) => item.id, 'device id', blockers);
  return { devices, byName };
}

function convertChannels(sourceChannels, devicesByName, blockers) {
  const converted = sourceChannels.map((item) => {
    const deviceName = text(item?.device ?? item?.deviceName);
    const name = text(item?.name);
    const key = text(item?.key) || `${deviceName}|${name}`;
    const state = CHANNEL_STATE.get(text(item?.state));
    if (!state) blockers.push(`unsupported legacy channel state ${text(item?.state) || '(empty)'} for ${key}`);
    const device = devicesByName.get(deviceName);
    if (!device) blockers.push(`channel ${key} references unknown device ${deviceName || '(empty)'}`);
    return {
      key,
      deviceId: device?.id || '',
      deviceName,
      name,
      state: state || text(item?.state),
      start: text(item?.start),
      end: text(item?.end),
      currentRecordId: '',
      nextRecordId: '',
      spec: text(item?.spec),
      type: text(item?.type),
      temperatureRange: text(item?.tempRange),
      voltageLimit: Number.isFinite(Number(item?.voltage)) ? Number(item.voltage) : null,
      currentLimit: Number.isFinite(Number(item?.current)) ? Number(item.current) : null,
      note: text(item?.note),
      legacySnapshot: copy(item)
    };
  });
  unique(converted, (item) => item.key, 'channel key', blockers);
  return converted;
}

function createSamples(requests) {
  return requests.flatMap((request) => {
    if (!Number.isInteger(request.quantity) || request.quantity < 1 || request.quantity > 999) return [];
    return Array.from({ length: request.quantity }, (_, index) => ({
      id: `${request.requestNo}.${String(index + 1).padStart(3, '0')}`,
      requestNo: request.requestNo,
      ordinal: index + 1,
      status: 'pending',
      channelKey: '',
      start: '',
      end: '',
      hasHistory: false
    }));
  });
}

function convertRecords(sourceRecords, requests, channels, samples, blockers) {
  const requestById = new Map(requests.map((item) => [item.requestNo, item]));
  const channelByKey = new Map(channels.map((item) => [item.key, item]));
  const samplesByRequest = new Map();
  for (const sample of samples) {
    if (!samplesByRequest.has(sample.requestNo)) samplesByRequest.set(sample.requestNo, []);
    samplesByRequest.get(sample.requestNo).push(sample);
  }
  const cursorByRequest = new Map();
  const records = [];

  for (const [recordIndex, item] of sourceRecords.entries()) {
    const requestNo = text(item?.no ?? item?.requestNo);
    const request = requestById.get(requestNo);
    if (!request) blockers.push(`legacy record ${text(item?.id) || recordIndex + 1} references unknown request ${requestNo || '(empty)'}`);
    const statusText = text(item?.state ?? item?.status);
    const status = RECORD_STATUS.get(statusText);
    if (!status) blockers.push(`unsupported legacy record status ${statusText || '(empty)'}`);
    const keys = Array.isArray(item?.keys)
      ? item.keys.map(text).filter(Boolean)
      : [text(item?.key ?? item?.channelKey)].filter(Boolean);
    if (keys.length === 0) blockers.push(`legacy record ${text(item?.id) || recordIndex + 1} has no channel key`);

    for (const [keyIndex, channelKey] of keys.entries()) {
      if (!channelByKey.has(channelKey)) {
        blockers.push(`legacy record ${text(item?.id) || recordIndex + 1} references unknown channel ${channelKey}`);
        continue;
      }
      if (!request || !status) continue;
      const sampleIndex = cursorByRequest.get(requestNo) || 0;
      const sample = samplesByRequest.get(requestNo)?.[sampleIndex];
      if (!sample) {
        blockers.push(`request ${requestNo} has more channel records than quantity ${request.quantity}`);
        continue;
      }
      cursorByRequest.set(requestNo, sampleIndex + 1);
      const legacyId = text(item?.id) || `LEGACY-RECORD-${String(recordIndex + 1).padStart(4, '0')}`;
      const id = `${legacyId}.${String(keyIndex + 1).padStart(3, '0')}`;
      sample.status = status;
      sample.channelKey = channelKey;
      sample.start = text(item?.time ?? item?.start);
      sample.end = text(item?.end);
      sample.hasHistory = true;
      records.push({
        id,
        requestNo,
        sampleId: sample.id,
        channelKey,
        status,
        start: text(item?.time ?? item?.start),
        end: text(item?.end),
        actualEnd: text(item?.actualEnd),
        actor: text(item?.user ?? item?.actor),
        note: text(item?.note),
        source: 'legacy',
        legacySnapshot: copy(item)
      });
    }
  }
  unique(records, (item) => item.id, 'record id', blockers);
  return records;
}

function reconcileChannels(channels, records, blockers) {
  for (const channel of channels) {
    const running = records.filter((item) => item.channelKey === channel.key && item.status === 'running');
    const reserved = records.filter((item) => item.channelKey === channel.key && item.status === 'reserved');
    if (running.length > 1) blockers.push(`channel ${channel.key} has multiple running records`);
    if (reserved.length > 1) blockers.push(`channel ${channel.key} has multiple reserved records`);

    const derived = running.length > 0 ? 'busy' : reserved.length > 0 ? 'booked' : channel.state;
    if ((running.length > 0 || reserved.length > 0) && channel.state !== derived) {
      blockers.push(`channel ${channel.key} state ${channel.state} conflicts with derived ${derived}`);
    }
    if (running.length === 0 && reserved.length === 0 && ['busy', 'booked'].includes(channel.state)) {
      blockers.push(`channel ${channel.key} state ${channel.state} has no active record`);
    }

    channel.state = derived;
    channel.currentRecordId = running[0]?.id || '';
    channel.nextRecordId = reserved[0]?.id || '';
    if (running[0]) {
      channel.start = running[0].start;
      channel.end = running[0].end;
    }
  }
}

function convertAudits(sourceAudits, warnings) {
  return sourceAudits.map((item, index) => {
    const id = text(item?.id) || `LEGACY-AUDIT-${String(index + 1).padStart(5, '0')}`;
    if (/查看页面|page.view/i.test(text(item?.action))) {
      warnings.push(`legacy page-view audit ${id} is retained as non-business evidence`);
    }
    return {
      id,
      at: text(item?.at ?? item?.time),
      actor: text(item?.actor ?? item?.user),
      action: text(item?.action) || 'legacy-operation',
      result: 'legacy',
      level: text(item?.level).toUpperCase() || 'LEGACY',
      target: text(item?.target),
      before: copy(item?.before) ?? null,
      after: copy(item?.after) ?? null,
      note: text(item?.note),
      source: 'legacy',
      legacySnapshot: copy(item)
    };
  });
}

export function analyzeLegacyState(value, {
  migratedAt = new Date().toISOString(),
  migrationAuditId = `AUD-MIGRATE-${Date.now()}`,
  migrationToolVersion = 'vnext-migration/0.1',
  sourceDescriptor = null
} = {}) {
  const blockers = [];
  const warnings = [];
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {
      ok: false,
      blockers: ['legacy state must be an object'],
      warnings,
      sourceSummary: legacySummary(value),
      targetSummary: null
    };
  }

  const source = structuredClone(value);
  const sourceRequests = requireArray(source, 'requests', blockers);
  const sourceProfiles = requireArray(source, 'deviceProfiles', blockers);
  const sourceChannels = requireArray(source, 'channels', blockers);
  const sourceRecords = requireArray(source, 'records', blockers);
  const sourceAudits = requireArray(source, 'auditLogs', blockers);
  const sourceRows = requireArray(source, 'requestSourceRows', blockers);
  const requests = convertRequests(sourceRequests, blockers);
  const { devices, byName } = convertDevices(sourceProfiles, sourceChannels, blockers);
  const channels = convertChannels(sourceChannels, byName, blockers);
  const samples = createSamples(requests);
  const records = convertRecords(sourceRecords, requests, channels, samples, blockers);
  reconcileChannels(channels, records, blockers);
  const audits = convertAudits(sourceAudits, warnings);
  unique(audits, (item) => item.id, 'audit id', blockers);
  if (audits.some((item) => item.id === migrationAuditId)) {
    blockers.push(`migration audit id ${migrationAuditId} already exists`);
  }

  const sourceSummary = legacySummary(source);
  if (blockers.length > 0) {
    return { ok: false, blockers, warnings, sourceSummary, targetSummary: null };
  }

  let state = {
    schemaVersion: 2,
    dataRevision: 0,
    username: text(source.username),
    requests,
    samples,
    devices,
    channels,
    records,
    audits,
    requestSourceRows: copy(sourceRows)
  };
  const beforeMigrationAudit = summarizeState(state);
  state.audits.push({
    id: migrationAuditId,
    at: migratedAt,
    actor: 'migration-tool',
    action: 'migrate-legacy-state',
    result: 'success',
    level: warnings.length > 0 ? 'WARNING' : 'NORMAL',
    source: 'migration',
    sourceFile: sourceDescriptor ? copy(sourceDescriptor) : null,
    toolVersion: migrationToolVersion,
    warningCount: warnings.length,
    before: sourceSummary,
    after: beforeMigrationAudit,
    note: `旧版转换完成；warning ${warnings.length} 项`
  });

  try {
    state = assertValidState(state);
  } catch (error) {
    return {
      ok: false,
      blockers: [...blockers, ...(error.blockers || [error.message])],
      warnings,
      sourceSummary,
      targetSummary: null
    };
  }
  return {
    ok: true,
    blockers,
    warnings,
    sourceSummary,
    targetSummary: summarizeState(state),
    state
  };
}
