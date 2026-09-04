import { channelEligibility } from '../domain/reservation-policy.mjs';

export const LEGACY_REQUEST_PAGE_MAX = 50;
export const LEGACY_SAMPLE_PAGE_SIZE = 25;
export const LEGACY_CHANNEL_RESULT_MAX = 40;

const RECORD_STATUS = new Map([
  ['reserved', 'reserved'],
  ['running', 'running'],
  ['completed', 'completed'],
  ['cancelled', 'cancelled']
]);

function positiveInteger(value, fallback) {
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function pageSlice(items, requestedPage, pageSize) {
  const pageCount = Math.max(1, Math.ceil(items.length / pageSize));
  const page = Math.min(positiveInteger(requestedPage, 1), pageCount);
  const start = (page - 1) * pageSize;
  return {
    items: items.slice(start, start + pageSize),
    total: items.length,
    page,
    pageSize,
    pageCount
  };
}

function searchableText(values) {
  return values
    .filter(value => value !== null && value !== undefined)
    .map(value => typeof value === 'object' ? JSON.stringify(value) : String(value))
    .join(' ')
    .toLocaleLowerCase('zh-CN');
}

function matchesTokens(text, query) {
  const tokens = String(query ?? '')
    .trim()
    .toLocaleLowerCase('zh-CN')
    .split(/\s+/)
    .filter(Boolean);
  return tokens.every(token => text.includes(token));
}

function normalizedSearch(value) {
  return String(value ?? '').trim().toLocaleLowerCase('zh-CN');
}

function ordinaryRawFields(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => {
    const normalized = String(key).replaceAll(/\s+/g, '').toLocaleLowerCase('zh-CN');
    return !['id', 'requestno', '申请单号', '申请编号', '申请号', '子样品号', '子样品编号', 'sampleid'].includes(normalized);
  }));
}

function requestNumber(request) {
  return String(request?.id ?? request?.requestNo ?? '').trim();
}

function requestQuantity(request) {
  const value = Number(request?.qty ?? request?.quantity);
  return Number.isInteger(value) ? value : 0;
}

function requestView(request, pendingCount) {
  return {
    ...structuredClone(request),
    requestNo: requestNumber(request),
    quantity: requestQuantity(request),
    testName: request.test ?? request.testName ?? '',
    sampleModel: request.sample ?? request.sampleModel ?? '',
    pendingCount
  };
}

export function requestPage(state, query = {}) {
  const requests = Array.isArray(state?.requests) ? state.requests : [];
  const samples = Array.isArray(state?.samples) ? state.samples : [];
  const pendingByRequest = new Map();
  for (const sample of samples) {
    if (sample?.status === 'pending') {
      const requestNo = String(sample.requestNo || '');
      pendingByRequest.set(requestNo, (pendingByRequest.get(requestNo) ?? 0) + 1);
    }
  }

  const views = requests.map(request => requestView(request, pendingByRequest.get(requestNumber(request)) ?? 0));
  const needle = normalizedSearch(query.text);
  const exactIdentifierMatch = needle
    ? views.some(request => normalizedSearch(request.requestNo) === needle)
    : false;
  const filtered = views
    .filter(request => exactIdentifierMatch
      ? normalizedSearch(request.requestNo) === needle
      : matchesTokens(searchableText([
      request.project,
      request.testName,
      request.sampleModel,
      request.sampleName,
      request.client,
      request.dept,
      request.tester,
      ordinaryRawFields(request.rawFields)
    ]), query.text))
    .filter(request => query.pendingOnly !== true || request.pendingCount > 0);

  const pageSize = Math.min(
    positiveInteger(query.pageSize, LEGACY_REQUEST_PAGE_MAX),
    LEGACY_REQUEST_PAGE_MAX
  );
  return pageSlice(filtered, query.page, pageSize);
}

export function samplePage(state, requestNo, page = 1) {
  const samples = Array.isArray(state?.samples) ? state.samples : [];
  const filtered = samples
    .filter(sample => String(sample?.requestNo) === String(requestNo))
    .map(sample => structuredClone(sample))
    .sort((left, right) => Number(left.ordinal) - Number(right.ordinal));
  return pageSlice(filtered, page, LEGACY_SAMPLE_PAGE_SIZE);
}

function normalizedRecords(records) {
  return records.flatMap(record => {
    const status = RECORD_STATUS.get(String(record?.status || '').trim());
    if (!status) return [];
    const keys = new Set(Array.isArray(record?.keys) ? record.keys.map(String) : []);
    if (record?.channelKey) keys.add(String(record.channelKey));
    return [...keys].map(channelKey => ({
      ...record,
      channelKey,
      status,
      start: String(record.start ?? record.time ?? ''),
      end: String(record.end ?? '')
    }));
  });
}

export function channelCandidates(state, criteria = {}) {
  const channels = Array.isArray(state?.channels) ? state.channels : [];
  const records = normalizedRecords(Array.isArray(state?.records) ? state.records : []);
  const mode = criteria.mode === 'start' ? 'start' : 'reserve';
  const limit = Math.min(
    positiveInteger(criteria.limit, LEGACY_CHANNEL_RESULT_MAX),
    LEGACY_CHANNEL_RESULT_MAX
  );

  const matches = channels
    .filter(channel => !criteria.device || channel.device === criteria.device || channel.deviceName === criteria.device)
    .filter(channel => matchesTokens(searchableText([
      channel.key,
      channel.device,
      channel.deviceName,
      channel.name,
      channel.spec,
      channel.type,
      channel.tempRange,
      channel.location
    ]), criteria.text))
    .map(channel => ({
      channel,
      eligibility: channelEligibility({ mode, channel, records })
    }))
    .filter(({ eligibility }) => eligibility.allowed)
    .sort((left, right) =>
      String(left.channel.device ?? left.channel.deviceName ?? '').localeCompare(
        String(right.channel.device ?? right.channel.deviceName ?? ''),
        'zh-CN'
      ) ||
      String(left.channel.name ?? '').localeCompare(
        String(right.channel.name ?? ''),
        'zh-CN',
        { numeric: true }
      )
    );

  const pageCount = Math.max(1, Math.ceil(matches.length / limit));
  const page = Math.min(positiveInteger(criteria.page, 1), pageCount);
  const start = (page - 1) * limit;
  return {
    items: matches.slice(start, start + limit).map(({ channel, eligibility }) => ({
      ...structuredClone(channel),
      eligibility
    })),
    total: matches.length,
    page,
    pageSize: limit,
    pageCount,
    limit,
    hasMore: page < pageCount
  };
}

function boundedPage(items, query = {}, searchable = item => searchableText([item])) {
  const filtered = items
    .filter(item => matchesTokens(searchable(item), query.text))
    .map(item => structuredClone(item));
  return pageSlice(filtered, query.page, 50);
}

export function deviceChannelPage(state, query = {}) {
  const channels = Array.isArray(state?.channels) ? state.channels : [];
  return boundedPage(
    channels.filter(channel => !query.device || channel.device === query.device),
    query,
    channel => searchableText([
      channel.key, channel.device, channel.name, channel.spec, channel.type,
      channel.tempRange, channel.state, channel.project, channel.user
    ])
  );
}

export function recordPage(state, query = {}) {
  const records = Array.isArray(state?.records) ? state.records : [];
  const indexed = records
    .map((record, index) => ({ ...record, __legacyIndex: index }))
    .filter(record => !query.state || record.status === query.state);
  const needle = normalizedSearch(query.text);
  const exactIdentifierMatch = needle
    ? indexed.some(record => [record.no, record.requestNo, record.sampleId]
      .some(value => normalizedSearch(value) === needle))
    : false;
  return boundedPage(
    indexed.filter(record => !exactIdentifierMatch || [record.no, record.requestNo, record.sampleId]
      .some(value => normalizedSearch(value) === needle)),
    exactIdentifierMatch ? { ...query, text: '' } : query,
    record => searchableText([
      record.id, record.project, record.test,
      record.channels, record.keys, record.status,
      record.time, record.start, record.end, record.user, record.actor, record.note
    ])
  );
}

export function auditPage(state, query = {}) {
  const audits = Array.isArray(state?.auditLogs) ? state.auditLogs : [];
  return boundedPage(
    audits.filter(audit => !query.level || String(audit.level || 'normal').toLowerCase() === String(query.level).toLowerCase()),
    query,
    audit => searchableText([
      audit.id, audit.time, audit.at, audit.user, audit.actor, audit.action,
      audit.target, audit.level, audit.note, audit.before, audit.after
    ])
  );
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function channelStateLabel(state) {
  return {
    free: '空闲',
    busy: '测试中',
    booked: '已预约',
    fault: '停用'
  }[state] || '未知';
}

function runningRecordIndex(state) {
  const byId = new Map();
  const byChannel = new Map();
  for (const record of Array.isArray(state?.records) ? state.records : []) {
    const status = RECORD_STATUS.get(String(record?.status || '').trim());
    if (status !== 'running') continue;
    if (record?.id) byId.set(String(record.id), record);
    const keys = new Set(Array.isArray(record?.keys) ? record.keys.map(String) : []);
    if (record?.channelKey) keys.add(String(record.channelKey));
    for (const key of keys) {
      if (!byChannel.has(key)) byChannel.set(key, record);
    }
  }
  return { byId, byChannel };
}

function runningRecordForChannel(channel, index) {
  const current = channel?.currentRecordId
    ? index.byId.get(String(channel.currentRecordId))
    : null;
  return current || index.byChannel.get(String(channel?.key ?? '')) || null;
}

function boardChannelCard(channel, runningRecord) {
  const encodedKey = escapeHtml(encodeURIComponent(channel.key));
  const sampleId = String(runningRecord?.sampleId || '').trim();
  const encodedSampleId = escapeHtml(encodeURIComponent(sampleId));
  const primary = channel.state === 'free'
    ? `<button class="link-btn" type="button" data-bounded-action="reserve-channel" data-channel-key="${encodedKey}">预约 / 开始 →</button>`
    : channel.state === 'busy'
      ? `<button class="link-btn" type="button" data-bounded-action="manage-running" data-channel-key="${encodedKey}" data-sample-id="${encodedSampleId}">管理测试 →</button><button class="link-btn" type="button" data-bounded-action="transition-channel" data-transition="end" data-channel-key="${encodedKey}">结束测试</button>`
      : channel.state === 'booked'
        ? `<button class="link-btn" type="button" data-bounded-action="transition-channel" data-transition="start" data-channel-key="${encodedKey}">开始测试</button>`
        : `<button class="link-btn" type="button" data-bounded-action="transition-channel" data-transition="recover" data-channel-key="${encodedKey}">恢复空闲</button>`;
  const sample = channel.state === 'busy'
    ? `<span class="channel-sample">样品：${escapeHtml(sampleId || '未关联')}</span>`
    : '';
  return `<article class="card ${escapeHtml(channel.state)}" data-testid="bounded-channel-card"><div class="ctop"><span class="ch">${escapeHtml(channel.name)}</span><span class="badge">${channelStateLabel(channel.state)}</span></div><div class="spec">${escapeHtml(channel.spec || '参数待完善')}</div><div class="content">${escapeHtml(channel.project || '当前无测试任务')}<br>${sample}${escapeHtml(channel.user ? `操作人：${channel.user}` : '可立即开始或预约')}</div><div class="time">${escapeHtml(channel.end || (channel.state === 'fault' ? '设备停用，待恢复' : '当前无占用'))}</div><div class="card-main">${primary}</div></article>`;
}

export function renderBoardView(state, options = {}) {
  const channels = Array.isArray(state?.channels) ? state.channels : [];
  const profiles = Array.isArray(state?.deviceProfiles) ? state.deviceProfiles : [];
  const runningRecords = runningRecordIndex(state);
  const names = [];
  const seen = new Set();
  for (const name of [...profiles.map(item => item?.name), ...channels.map(item => item?.device)]) {
    const normalized = String(name || '').trim();
    if (normalized && !seen.has(normalized)) {
      seen.add(normalized);
      names.push(normalized);
    }
  }
  const expanded = new Set(options.expandedDevices || []);
  return names.map(device => {
    const deviceChannels = channels.filter(channel => channel.device === device);
    const isExpanded = expanded.has(device);
    const counts = ['free', 'busy', 'booked', 'fault']
      .map(status => `${channelStateLabel(status)} ${deviceChannels.filter(channel => channel.state === status).length}`)
      .join(' · ');
    return `<section class="board-device" data-testid="bounded-board-device" data-device="${escapeHtml(encodeURIComponent(device))}"><div class="device-h"><div><b>${escapeHtml(device)}</b><span>${deviceChannels.length} 个通道 · ${escapeHtml(counts)}</span></div><button class="device-toggle" type="button" data-bounded-action="toggle-device" data-device="${escapeHtml(encodeURIComponent(device))}">${isExpanded ? '收起 −' : '展开 ＋'}</button></div>${isExpanded ? `<div class="channels">${deviceChannels.map(channel => boardChannelCard(channel, runningRecordForChannel(channel, runningRecords))).join('')}</div>` : ''}</section>`;
  }).join('');
}
