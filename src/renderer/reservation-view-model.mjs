import { channelEligibility } from '../domain/reservation-policy.mjs';

const REQUEST_PAGE_MAX = 50;
const SAMPLE_PAGE_SIZE = 25;
const CHANNEL_RESULT_MAX = 40;

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
  return values.filter((value) => value !== null && value !== undefined).join(' ').toLocaleLowerCase('zh-CN');
}

function matchesTokens(text, query) {
  const tokens = String(query ?? '')
    .trim()
    .toLocaleLowerCase('zh-CN')
    .split(/\s+/)
    .filter(Boolean);
  return tokens.every((token) => text.includes(token));
}

export function requestPage(state, query = {}) {
  const requests = Array.isArray(state?.requests) ? state.requests : [];
  const samples = Array.isArray(state?.samples) ? state.samples : [];
  const pendingByRequest = new Map();
  for (const sample of samples) {
    if (sample.status === 'pending') {
      pendingByRequest.set(sample.requestNo, (pendingByRequest.get(sample.requestNo) ?? 0) + 1);
    }
  }

  const filtered = requests
    .map((request) => ({
      ...structuredClone(request),
      pendingCount: pendingByRequest.get(request.requestNo) ?? 0
    }))
    .filter((request) => matchesTokens(searchableText([
      request.requestNo,
      request.project,
      request.testName,
      request.sampleModel,
      request.rawFields?.委托人,
      request.execution?.tester
    ]), query.text))
    .filter((request) => query.pendingOnly !== true || request.pendingCount > 0);

  const pageSize = Math.min(positiveInteger(query.pageSize, REQUEST_PAGE_MAX), REQUEST_PAGE_MAX);
  return pageSlice(filtered, query.page, pageSize);
}

export function samplePage(state, requestNo, page = 1) {
  const samples = Array.isArray(state?.samples) ? state.samples : [];
  const filtered = samples
    .filter((sample) => sample.requestNo === requestNo)
    .map((sample) => structuredClone(sample))
    .sort((left, right) => left.ordinal - right.ordinal);
  return pageSlice(filtered, page, SAMPLE_PAGE_SIZE);
}

export function channelCandidates(state, criteria = {}) {
  const channels = Array.isArray(state?.channels) ? state.channels : [];
  const records = Array.isArray(state?.records) ? state.records : [];
  const mode = criteria.mode === 'start' ? 'start' : 'reserve';
  const limit = Math.min(positiveInteger(criteria.limit, CHANNEL_RESULT_MAX), CHANNEL_RESULT_MAX);

  const matches = channels
    .filter((channel) => !criteria.deviceId || channel.deviceId === criteria.deviceId)
    .filter((channel) => matchesTokens(searchableText([
      channel.key,
      channel.deviceId,
      channel.deviceName,
      channel.name,
      channel.spec,
      channel.type,
      channel.location
    ]), criteria.text))
    .map((channel) => ({
      channel,
      eligibility: channelEligibility({ mode, channel, records })
    }))
    .filter(({ eligibility }) => eligibility.allowed)
    .sort((left, right) =>
      String(left.channel.deviceName ?? '').localeCompare(String(right.channel.deviceName ?? ''), 'zh-CN') ||
      String(left.channel.name ?? '').localeCompare(String(right.channel.name ?? ''), 'zh-CN', { numeric: true })
    );

  return {
    items: matches.slice(0, limit).map(({ channel, eligibility }) => ({
      ...structuredClone(channel),
      eligibility
    })),
    total: matches.length,
    limit,
    hasMore: matches.length > limit
  };
}
