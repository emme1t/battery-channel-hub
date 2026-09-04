const DEFAULT_DURATIONS = Object.freeze({ ordinary: 5, storage: 15 });

function localDateTimeValue(value) {
  const pad = number => String(number).padStart(2, '0');
  return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}T${pad(value.getHours())}:${pad(value.getMinutes())}`;
}

export function createCompressedSchedule({ now, kind, offsetMinutes = 1, durationMinutes } = {}) {
  if (!Object.hasOwn(DEFAULT_DURATIONS, kind)) throw new TypeError('kind must be ordinary or storage');
  const clock = new Date(now);
  if (Number.isNaN(clock.getTime())) throw new TypeError('valid now is required');
  if (!Number.isSafeInteger(offsetMinutes) || offsetMinutes < 0) {
    throw new TypeError('offsetMinutes must be a non-negative integer');
  }
  const duration = durationMinutes ?? DEFAULT_DURATIONS[kind];
  if (!Number.isSafeInteger(duration) || duration <= 0) {
    throw new RangeError('compressed end must be after start');
  }
  const start = new Date(clock.getTime() + offsetMinutes * 60_000);
  const end = new Date(start.getTime() + duration * 60_000);
  return Object.freeze({
    kind,
    compressed: true,
    offsetMinutes,
    durationMinutes: duration,
    startValue: localDateTimeValue(start),
    endValue: localDateTimeValue(end)
  });
}

export function createFutureEndBeforeStartSchedule({ now } = {}) {
  const clock = new Date(now);
  if (Number.isNaN(clock.getTime())) throw new TypeError('valid now is required');
  const valueAfter = minutes => localDateTimeValue(new Date(clock.getTime() + minutes * 60_000));
  return Object.freeze({
    startValue: valueAfter(10),
    invalidEndValue: valueAfter(5),
    correctedEndValue: valueAfter(15)
  });
}
