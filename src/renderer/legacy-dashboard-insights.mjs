const RESERVED_STATUSES = new Set(['reserved']);
const CANCELLED_STATUSES = new Set(['cancelled']);

function positiveInteger(value, fallback) {
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function dateValue(value, endOfDate = false) {
  const text = String(value || '').trim();
  if (!text) return null;
  const date = /^\d{4}-\d{2}-\d{2}$/.test(text)
    ? new Date(`${text}T${endOfDate ? '23:59:59.999' : '00:00:00.000'}`)
    : new Date(text);
  return Number.isNaN(date.getTime()) ? null : date;
}

function localDateKey(value) {
  const date = value instanceof Date ? value : dateValue(value);
  if (!date) return '';
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function requestNumber(request) {
  return String(request?.id ?? request?.requestNo ?? '').trim();
}

function recordRequestNumber(record, sampleToRequest) {
  return String(record?.requestNo ?? record?.no ?? sampleToRequest.get(String(record?.sampleId || '')) ?? '').trim();
}

function plannedStart(request) {
  return request?.execution?.plannedStart ?? request?.startDate ?? request?.expectedStart ?? '';
}

function recordStatus(record) {
  return String(record?.status || '').trim();
}

function actualStart(record) {
  return record?.actualStart ?? record?.start ?? record?.time ?? '';
}

export function timelyStartInsight(state, query = {}) {
  const requests = new Map((state?.requests || []).map(request => [requestNumber(request), request]));
  const sampleToRequest = new Map((state?.samples || []).map(sample => [String(sample?.id || ''), String(sample?.requestNo || '')]));
  const from = dateValue(query.from);
  const to = dateValue(query.to, true);
  const rows = [];

  for (const record of state?.records || []) {
    const status = recordStatus(record);
    if (RESERVED_STATUSES.has(status) || CANCELLED_STATUSES.has(status)) continue;
    const startedAt = dateValue(actualStart(record));
    if (!startedAt || (from && startedAt < from) || (to && startedAt > to)) continue;
    const request = requests.get(recordRequestNumber(record, sampleToRequest));
    const rawPlan = plannedStart(request);
    const plan = dateValue(rawPlan, /^\d{4}-\d{2}-\d{2}$/.test(String(rawPlan || '').trim()));
    rows.push({
      date: localDateKey(startedAt),
      timely: plan ? startedAt <= plan : null
    });
  }

  const known = rows.filter(row => row.timely !== null);
  const timely = known.filter(row => row.timely).length;
  const late = known.length - timely;
  const missingPlan = rows.length - known.length;
  const startKey = query.from || rows.map(row => row.date).filter(Boolean).sort()[0] || localDateKey(new Date());
  const endKey = query.to || rows.map(row => row.date).filter(Boolean).sort().at(-1) || startKey;
  const points = [];
  const byDate = new Map();
  for (const row of known) {
    const daily = byDate.get(row.date) || { total: 0, timely: 0 };
    daily.total += 1;
    if (row.timely) daily.timely += 1;
    byDate.set(row.date, daily);
  }
  const cursor = dateValue(startKey);
  const finish = dateValue(endKey, true);
  if (cursor && finish && cursor <= finish) {
    for (let guard = 0; cursor <= finish && guard < 3660; guard += 1) {
      const key = localDateKey(cursor);
      const daily = byDate.get(key) || { total: 0, timely: 0 };
      points.push({
        date: key,
        total: daily.total,
        timely: daily.timely,
        late: daily.total - daily.timely,
        rate: daily.total ? Math.round(daily.timely * 1000 / daily.total) / 10 : null
      });
      cursor.setDate(cursor.getDate() + 1);
    }
  }

  return {
    total: known.length,
    timely,
    late,
    missingPlan,
    rate: known.length ? Math.round(timely * 1000 / known.length) / 10 : null,
    points
  };
}

export function reservationTodoPage(state, query = {}) {
  const pageSize = Math.min(positiveInteger(query.pageSize, 10), 25);
  const rows = (state?.records || [])
    .map((record, index) => ({ ...structuredClone(record), __legacyIndex: index }))
    .filter(record => RESERVED_STATUSES.has(recordStatus(record)))
    .sort((left, right) => {
      const leftTime = dateValue(left.start ?? left.time)?.getTime() ?? Number.MAX_SAFE_INTEGER;
      const rightTime = dateValue(right.start ?? right.time)?.getTime() ?? Number.MAX_SAFE_INTEGER;
      return leftTime - rightTime || left.__legacyIndex - right.__legacyIndex;
    });
  const pageCount = Math.max(1, Math.ceil(rows.length / pageSize));
  const page = Math.min(positiveInteger(query.page, 1), pageCount);
  return {
    items: rows.slice((page - 1) * pageSize, page * pageSize),
    total: rows.length,
    page,
    pageSize,
    pageCount
  };
}

function numericCurrent(value) {
  const match = String(value ?? '').replace(',', '.').match(/-?\d+(?:\.\d+)?/);
  return match ? Number(match[0]) : null;
}

export function dashboardChannelSummary(state, query = {}) {
  const profiles = new Map((state?.deviceProfiles || []).map(profile => [String(profile?.name || ''), profile]));
  const tokens = String(query.text || '').trim().toLocaleLowerCase('zh-CN').split(/\s+/).filter(Boolean);
  const maxCurrent = numericCurrent(query.maxCurrent);
  const channels = (state?.channels || []).filter(channel => {
    if (query.state && channel.state !== query.state) return false;
    const profile = profiles.get(String(channel.device || channel.deviceName || ''));
    const current = numericCurrent(channel.current) ?? numericCurrent(profile?.current);
    if (maxCurrent !== null && (current === null || current > maxCurrent)) return false;
    const text = [channel.key, channel.device, channel.deviceName, channel.name, channel.spec, channel.type, channel.location]
      .filter(Boolean).join(' ').toLocaleLowerCase('zh-CN');
    return tokens.every(token => text.includes(token));
  }).map(channel => structuredClone(channel));
  const deviceNames = [...new Set(channels.map(channel => String(channel.device || channel.deviceName || '')).filter(Boolean))];
  const counts = Object.fromEntries(['free', 'busy', 'booked', 'fault'].map(status => [status, channels.filter(channel => channel.state === status).length]));
  return { channels, deviceNames, counts };
}
