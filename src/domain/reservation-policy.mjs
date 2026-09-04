const RESERVED_STATUSES = new Set(['reserved', 'booked']);
const RUNNING_STATUSES = new Set(['running', 'testing', 'busy']);

function result(allowed, severity, code, message) {
  return { allowed, severity, code, message };
}

function parseTime(value, label) {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    throw new TypeError(`${label}时间无效`);
  }
  return timestamp;
}

function normalizedInterval(interval) {
  if (!interval || typeof interval !== 'object') {
    throw new TypeError('时间区间无效');
  }
  const start = parseTime(interval.start, '开始');
  const end = interval.end === '' || interval.end === null || interval.end === undefined
    ? Number.POSITIVE_INFINITY
    : parseTime(interval.end, '结束');
  if (end <= start) {
    throw new RangeError('结束时间必须晚于开始时间');
  }
  return { start, end };
}

export function intervalsOverlap(left, right) {
  const a = normalizedInterval(left);
  const b = normalizedInterval(right);
  return a.start < b.end && b.start < a.end;
}

function recordsForChannel(records, channelKey, statuses) {
  return records.filter((record) =>
    record.channelKey === channelKey && statuses.has(record.status)
  );
}

export function channelEligibility({ mode, channel, records = [] }) {
  if (mode !== 'start' && mode !== 'reserve') {
    throw new TypeError('操作模式必须是 start 或 reserve');
  }
  if (!channel || typeof channel.key !== 'string') {
    throw new TypeError('缺少通道数据');
  }
  if (!Array.isArray(records)) {
    throw new TypeError('使用记录必须是数组');
  }

  if (mode === 'start') {
    return channel.state === 'free'
      ? result(true, 'normal', 'CHANNEL_AVAILABLE', '通道可立即开始')
      : result(false, 'error', 'START_REQUIRES_FREE_CHANNEL', '立即开始只允许空闲通道');
  }

  if (channel.state === 'free') {
    return result(true, 'normal', 'CHANNEL_AVAILABLE', '通道可预约');
  }
  if (channel.state === 'fault') {
    return result(false, 'error', 'CHANNEL_FAULT', '异常通道不可预约');
  }
  if (channel.state === 'booked') {
    return result(false, 'error', 'CHANNEL_ALREADY_QUEUED', '该通道已有后续预约');
  }
  if (channel.state !== 'busy') {
    return result(false, 'error', 'CHANNEL_STATE_UNSUPPORTED', '当前通道状态不可预约');
  }
  if (!channel.end) {
    return result(false, 'error', 'BUSY_CHANNEL_END_REQUIRED', '该通道未填写预计结束时间，无法排队预约');
  }
  if (recordsForChannel(records, channel.key, RESERVED_STATUSES).length > 0) {
    return result(false, 'error', 'CHANNEL_ALREADY_QUEUED', '该通道已有后续预约');
  }
  return result(true, 'normal', 'CHANNEL_AVAILABLE_AFTER_CURRENT', '当前测试结束后可预约');
}

export function validateAssignment({ mode, channel, records = [], start, end = '' }) {
  const requestedInterval = { start, end };
  normalizedInterval(requestedInterval);

  const eligibility = channelEligibility({ mode, channel, records });
  if (!eligibility.allowed) {
    return eligibility;
  }

  const reserved = recordsForChannel(records, channel?.key, RESERVED_STATUSES);
  const overlappingReservation = reserved.find((record) =>
    intervalsOverlap(requestedInterval, { start: record.start, end: record.end })
  );
  if (overlappingReservation) {
    return result(false, 'error', 'RESERVATION_OVERLAP', '预约时间与该通道已有预约重叠');
  }

  if (reserved.length > 0) {
    return result(false, 'error', 'CHANNEL_ALREADY_QUEUED', '该通道已有后续预约');
  }

  if (mode === 'reserve') {
    const running = recordsForChannel(records, channel.key, RUNNING_STATUSES);
    const overlappingRunning = running.find((record) =>
      intervalsOverlap(requestedInterval, { start: record.start, end: record.end })
    );
    if (overlappingRunning) {
      return result(
        true,
        'warning',
        'OVERLAPS_RUNNING_TEST',
        '预约开始早于当前测试的预计结束时间'
      );
    }
  }

  return result(true, 'normal', 'ASSIGNMENT_VALID', '通道与时间可用');
}
