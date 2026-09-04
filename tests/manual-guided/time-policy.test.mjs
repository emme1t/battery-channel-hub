import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { createCompressedSchedule, createFutureEndBeforeStartSchedule } from './time-policy.mjs';

test('invalid chronological schedule stays in the future while end remains before start', () => {
  assert.deepEqual(
    createFutureEndBeforeStartSchedule({ now: '2026-09-02T09:00:30-07:00' }),
    {
      startValue: '2026-09-02T09:10',
      invalidEndValue: '2026-09-02T09:05',
      correctedEndValue: '2026-09-02T09:15'
    }
  );
});

test('ordinary and storage schedules use short visible durations after the run clock', () => {
  assert.deepEqual(
    createCompressedSchedule({ now: '2026-09-02T09:00:00-07:00', kind: 'ordinary', offsetMinutes: 2 }),
    {
      kind: 'ordinary', compressed: true, offsetMinutes: 2, durationMinutes: 5,
      startValue: '2026-09-02T09:02', endValue: '2026-09-02T09:07'
    }
  );
  assert.deepEqual(
    createCompressedSchedule({ now: '2026-09-02T09:00:00-07:00', kind: 'storage', offsetMinutes: 3 }),
    {
      kind: 'storage', compressed: true, offsetMinutes: 3, durationMinutes: 15,
      startValue: '2026-09-02T09:03', endValue: '2026-09-02T09:18'
    }
  );
});

test('compressed schedule preserves adjacent and cross-day ordering', () => {
  const adjacent = createCompressedSchedule({
    now: '2026-09-02T09:00:00-07:00', kind: 'ordinary', offsetMinutes: 0, durationMinutes: 1
  });
  assert.equal(adjacent.startValue, '2026-09-02T09:00');
  assert.equal(adjacent.endValue, '2026-09-02T09:01');
  const crossDay = createCompressedSchedule({
    now: '2026-09-02T23:58:00-07:00', kind: 'storage', offsetMinutes: 3, durationMinutes: 2
  });
  assert.equal(crossDay.startValue, '2026-09-03T00:01');
  assert.equal(crossDay.endValue, '2026-09-03T00:03');
});

test('compressed schedule rejects invalid kinds, clocks and end-before-start durations', () => {
  assert.throws(() => createCompressedSchedule({ now: 'bad', kind: 'ordinary', offsetMinutes: 1 }), /valid now/i);
  assert.throws(() => createCompressedSchedule({ now: '2026-09-02T09:00:00-07:00', kind: 'other', offsetMinutes: 1 }), /ordinary or storage/i);
  assert.throws(() => createCompressedSchedule({ now: '2026-09-02T09:00:00-07:00', kind: 'ordinary', offsetMinutes: 1, durationMinutes: 0 }), /after start/i);
  assert.throws(() => createCompressedSchedule({ now: '2026-09-02T09:00:00-07:00', kind: 'storage', offsetMinutes: 1, durationMinutes: -1 }), /after start/i);
});

test('time compression never changes the system clock or writes SQLite timestamps', async () => {
  const source = await readFile(path.join(import.meta.dirname, 'time-policy.mjs'), 'utf8');
  assert.doesNotMatch(source, /Set-Date|settimeofday|clock_settime|w32tm|timedatectl/i);
  assert.doesNotMatch(source, /\b(?:INSERT|UPDATE|DELETE|REPLACE)\b/i);
  assert.doesNotMatch(source, /DatabaseSync|sqlite|state-probe|src[\\/](?:main|domain)/i);
});
