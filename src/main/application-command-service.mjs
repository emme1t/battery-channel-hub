import {
  deleteRequests,
  deleteTester,
  editExecutionFields,
  importRequests,
  upsertTester
} from '../domain/legacy-request-transactions.mjs';

const ACTIVE_CHANNEL_STATES = new Set(['busy', 'booked']);
const ACTIVE_RECORD_STATES = new Set(['reserved', 'running']);

function domainError(code, message, details = undefined) {
  const error = new Error(message);
  error.code = code;
  if (details !== undefined) error.details = details;
  return error;
}

function failure(code, message, details = undefined) {
  const result = { ok: false, code, message };
  if (details !== undefined) result.details = details;
  return result;
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

function audit(metadata, action, target, before, after, options = {}) {
  const outcome = options.level === 'warning' ? 'warning' : 'success';
  return {
    id: metadata.auditId,
    time: metadata.now,
    at: metadata.now,
    user: metadata.actor,
    actor: metadata.actor,
    action,
    target,
    outcome,
    result: outcome,
    verified: true,
    level: options.level || 'normal',
    before: structuredClone(before),
    after: structuredClone(after),
    note: options.note || ''
  };
}

function recordKeys(record) {
  const keys = Array.isArray(record?.keys) ? record.keys.map(String) : [];
  if (record?.channelKey) keys.push(String(record.channelKey));
  return [...new Set(keys)];
}

function activeRecord(record) {
  return ACTIVE_RECORD_STATES.has(String(record?.status || '').trim());
}

function clearChannelRuntime(channel) {
  channel.project = '';
  channel.user = '';
  channel.start = '';
  channel.end = null;
  channel.requestNo = '';
  channel.test = '';
  channel.currentRecordId = '';
  channel.nextRecordId = '';
}

function deviceNameDuplicate(state, id, name) {
  return state.deviceProfiles.some(item =>
    String(item?.id || '') !== id && String(item?.name || '').trim() === name
  );
}

function deviceChannels(state, name) {
  return state.channels.filter(channel => String(channel?.device || '') === name);
}

function recordsReferenceAny(state, keys, { activeOnly = false } = {}) {
  const selected = new Set(keys);
  return state.records.some(record =>
    (!activeOnly || activeRecord(record)) && recordKeys(record).some(key => selected.has(key))
  );
}

export function upsertDeviceState(state, command) {
  if (!command?.device || typeof command.device !== 'object') {
    throw domainError('COMMAND_REQUIRED', '缺少设备保存命令');
  }
  const device = structuredClone(command.device);
  device.id = requireText(device.id, 'device.id', '设备标识');
  device.name = requireText(device.name, 'device.name', '设备名称');
  device.status = String(device.status || 'enabled');
  if (!['enabled', 'disabled'].includes(device.status)) {
    throw domainError('DEVICE_STATUS_INVALID', '设备状态必须是 enabled 或 disabled');
  }
  if (deviceNameDuplicate(state, device.id, device.name)) {
    throw domainError('DEVICE_NAME_DUPLICATE', `设备名称已存在：${device.name}`);
  }

  const index = state.deviceProfiles.findIndex(item => String(item?.id || '') === device.id);
  const before = index >= 0 ? structuredClone(state.deviceProfiles[index]) : null;
  const oldName = before?.name || '';
  const channels = before ? deviceChannels(state, oldName) : [];
  const channelKeys = channels.map(channel => channel.key);
  if (before && oldName !== device.name && recordsReferenceAny(state, channelKeys)) {
    throw domainError(
      'DEVICE_REFERENCED_RENAME_BLOCK',
      '设备已有使用记录，不能改名；可修改其它参数或新建设备'
    );
  }
  if (
    device.status === 'disabled' &&
    (channels.some(channel => ACTIVE_CHANNEL_STATES.has(channel.state)) ||
      recordsReferenceAny(state, channelKeys, { activeOnly: true }))
  ) {
    throw domainError('ACTIVE_DEVICE_STATUS_BLOCK', '设备仍有测试中或已预约通道，不能停用');
  }

  const metadata = requireMetadata(state, command);
  const next = structuredClone(state);
  if (index >= 0) next.deviceProfiles[index] = { ...next.deviceProfiles[index], ...device };
  else next.deviceProfiles.push(device);

  if (before && oldName !== device.name) {
    next.channels = next.channels.map(channel => channel.device === oldName
      ? { ...channel, device: device.name, key: `${device.name}|${channel.name}` }
      : channel
    );
  }
  if (device.status === 'disabled') {
    for (const channel of next.channels.filter(item => item.device === device.name)) {
      channel.state = 'fault';
      clearChannelRuntime(channel);
    }
  }
  next.auditLogs.unshift(audit(
    metadata,
    before ? '修改设备' : '新增设备',
    `设备 ${device.name}`,
    before,
    device,
    { level: before ? 'warning' : 'normal' }
  ));
  return next;
}

export function deleteDeviceState(state, command) {
  const deviceId = requireText(command?.deviceId, 'deviceId', '设备标识');
  const device = state.deviceProfiles.find(item => String(item?.id || '') === deviceId);
  if (!device) throw domainError('DEVICE_NOT_FOUND', `设备不存在：${deviceId}`);
  const channels = deviceChannels(state, device.name);
  const keys = channels.map(channel => channel.key);
  if (
    channels.some(channel => ACTIVE_CHANNEL_STATES.has(channel.state)) ||
    recordsReferenceAny(state, keys, { activeOnly: true })
  ) {
    throw domainError('ACTIVE_DEVICE_DELETE_BLOCK', '设备仍有测试中或已预约通道，不能删除');
  }
  const metadata = requireMetadata(state, command);
  const next = structuredClone(state);
  next.deviceProfiles = next.deviceProfiles.filter(item => String(item?.id || '') !== deviceId);
  next.channels = next.channels.filter(channel => channel.device !== device.name);
  next.auditLogs.unshift(audit(
    metadata,
    '删除设备',
    `设备 ${device.name}`,
    { device, channels },
    { deletedChannels: channels.length, historicalRecordsPreserved: true },
    { level: 'warning', note: '历史使用记录保持不变' }
  ));
  return next;
}

function channelIdentity(channel) {
  const device = requireText(channel?.device, 'channel.device', '所属设备');
  const name = requireText(channel?.name, 'channel.name', '通道号');
  return { device, name, key: `${device}|${name}` };
}

function findChannel(state, command, identity) {
  const originalKey = String(command?.channelKey || command?.channel?.originalKey || command?.channel?.key || '').trim();
  const index = originalKey
    ? state.channels.findIndex(item => String(item?.key || '') === originalKey)
    : -1;
  return { originalKey, index, channel: index >= 0 ? state.channels[index] : null, identity };
}

export function upsertChannelState(state, command) {
  if (!command?.channel || typeof command.channel !== 'object') {
    throw domainError('COMMAND_REQUIRED', '缺少通道保存命令');
  }
  const input = structuredClone(command.channel);
  const identity = channelIdentity(input);
  const device = state.deviceProfiles.find(item => String(item?.name || '') === identity.device);
  if (!device) throw domainError('CHANNEL_DEVICE_UNKNOWN', `所属设备不存在：${identity.device}`);
  const found = findChannel(state, command, identity);
  const before = found.channel ? structuredClone(found.channel) : null;
  if (state.channels.some((item, index) => item.key === identity.key && index !== found.index)) {
    throw domainError('CHANNEL_KEY_DUPLICATE', `通道已存在：${identity.key}`);
  }

  const desiredState = String(input.state || before?.state || 'free');
  if (!['free', 'fault', 'busy', 'booked'].includes(desiredState)) {
    throw domainError('CHANNEL_STATE_INVALID', `不支持的通道状态：${desiredState}`);
  }
  if (!before && !['free', 'fault'].includes(desiredState)) {
    throw domainError('CHANNEL_STATE_INVALID', '新通道只能初始化为空闲或停用');
  }
  if (device.status === 'disabled' && desiredState !== 'fault') {
    throw domainError('DISABLED_DEVICE_CHANNEL_BLOCK', '停用设备的通道只能保持停用');
  }
  if (before && ACTIVE_CHANNEL_STATES.has(before.state)) {
    if (identity.key !== before.key || desiredState !== before.state) {
      throw domainError('ACTIVE_CHANNEL_EDIT_BLOCK', '测试中或已预约通道不能改变标识或状态');
    }
  }
  if (before && identity.key !== before.key && recordsReferenceAny(state, [before.key])) {
    throw domainError('CHANNEL_REFERENCED_RENAME_BLOCK', '通道已有使用记录，不能改名或移动设备');
  }
  if (before && ACTIVE_CHANNEL_STATES.has(before.state)) {
    const pointer = before.state === 'busy' ? before.currentRecordId : before.nextRecordId;
    const record = state.records.find(item => String(item?.id || '') === String(pointer || ''))
      ?? state.records.find(item => activeRecord(item) && recordKeys(item).includes(before.key));
    const endText = String(input.end ?? '').trim();
    if (endText !== '') {
      const start = Date.parse(record?.actualStart ?? record?.start ?? record?.time ?? '');
      const end = Date.parse(endText);
      if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
        throw domainError('ACTIVE_CHANNEL_END_BEFORE_START', `活动通道预计结束时间 ${endText} 不能早于或等于开始时间`);
      }
      const commandTime = new Date(command?.now);
      if (Number.isFinite(commandTime.getTime())) {
        const latest = new Date(commandTime);
        latest.setFullYear(latest.getFullYear() + 100);
        if (end > latest.getTime()) {
          throw domainError('ACTIVE_CHANNEL_END_OUT_OF_RANGE', '活动通道预计结束时间不能晚于操作时间后 100 个日历年');
        }
      }
    }
  }

  const metadata = requireMetadata(state, command);
  const next = structuredClone(state);
  const replacement = {
    ...(before || {}),
    ...input,
    ...identity,
    state: desiredState
  };
  delete replacement.originalKey;
  if (desiredState === 'free' || desiredState === 'fault') clearChannelRuntime(replacement);
  if (found.index >= 0) next.channels[found.index] = replacement;
  else next.channels.push(replacement);
  if (before && ACTIVE_CHANNEL_STATES.has(before.state) && before.end !== replacement.end) {
    for (const record of next.records.filter(item => activeRecord(item) && recordKeys(item).includes(before.key))) {
      record.end = replacement.end || '';
      const sample = next.samples.find(item => item.id === record.sampleId);
      if (sample) sample.end = replacement.end || '';
    }
  }
  next.auditLogs.unshift(audit(
    metadata,
    before ? '修改通道' : '新增通道',
    `通道 ${identity.key}`,
    before,
    replacement,
    { level: before ? 'warning' : 'normal' }
  ));
  return next;
}

export function deleteChannelState(state, command) {
  const channelKey = requireText(command?.channelKey, 'channelKey', '通道标识');
  const channel = state.channels.find(item => String(item?.key || '') === channelKey);
  if (!channel) throw domainError('CHANNEL_NOT_FOUND', `通道不存在：${channelKey}`);
  if (
    ACTIVE_CHANNEL_STATES.has(channel.state) ||
    recordsReferenceAny(state, [channelKey], { activeOnly: true })
  ) {
    throw domainError('ACTIVE_CHANNEL_DELETE_BLOCK', '测试中或已预约通道不能删除');
  }
  const metadata = requireMetadata(state, command);
  const next = structuredClone(state);
  next.channels = next.channels.filter(item => String(item?.key || '') !== channelKey);
  next.auditLogs.unshift(audit(
    metadata,
    '删除通道',
    `通道 ${channelKey}`,
    channel,
    { deleted: true, historicalRecordsPreserved: true },
    { level: 'warning', note: '历史使用记录保持不变' }
  ));
  return next;
}

const TRANSACTIONS = Object.freeze({
  editRequest: editExecutionFields,
  importRequests,
  deleteRequests,
  upsertTester,
  deleteTester,
  upsertDevice: upsertDeviceState,
  deleteDevice: deleteDeviceState,
  upsertChannel: upsertChannelState,
  deleteChannel: deleteChannelState
});

export function createApplicationCommandService({ store }) {
  if (!store || typeof store.load !== 'function' || typeof store.save !== 'function') {
    throw new TypeError('application command service requires a store');
  }
  return {
    async execute(command) {
      if (!command || typeof command !== 'object') {
        return failure('COMMAND_REQUIRED', '缺少管理命令');
      }
      const transaction = TRANSACTIONS[command.type];
      if (!transaction) return failure('COMMAND_UNSUPPORTED', `不支持的管理命令：${String(command.type || '')}`);

      let loaded;
      try {
        loaded = await store.load();
      } catch (error) {
        return failure(error.code || 'STATE_READ_FAILED', error.message);
      }
      if (!loaded?.ok) return loaded;
      if (!Number.isInteger(command.expectedRevision) || command.expectedRevision !== loaded.state.revision) {
        return failure(
          'REVISION_CONFLICT',
          `状态修订冲突：当前 ${loaded.state.revision}，提交 ${String(command.expectedRevision)}`,
          { currentRevision: loaded.state.revision, expectedRevision: command.expectedRevision }
        );
      }

      let nextState;
      try {
        nextState = transaction(loaded.state, command.payload || {});
      } catch (error) {
        return failure(error.code || 'COMMAND_REJECTED', error.message, error.details);
      }
      try {
        return await store.save({
          expectedRevision: loaded.state.revision,
          state: nextState,
          journalEntries: nextState.formChangeJournal || []
        });
      } catch (error) {
        return failure(error.code || 'PERSISTENCE_FAILED', error.message);
      }
    }
  };
}
