import test from 'node:test';
import assert from 'node:assert/strict';

import {
  channelEligibility,
  intervalsOverlap,
  validateAssignment
} from '../src/domain/reservation-policy.mjs';

const at = (hour) => `2026-08-20T${String(hour).padStart(2, '0')}:00:00-07:00`;

test('half-open intervals may touch but not overlap', () => {
  assert.equal(
    intervalsOverlap({ start: at(8), end: at(10) }, { start: at(10), end: at(12) }),
    false
  );
  assert.equal(
    intervalsOverlap({ start: at(8), end: at(11) }, { start: at(10), end: at(12) }),
    true
  );
  assert.equal(
    intervalsOverlap({ start: at(8), end: '' }, { start: at(20), end: at(21) }),
    true
  );
});

test('rejects malformed or reversed intervals', () => {
  assert.throws(
    () => intervalsOverlap({ start: 'bad', end: at(10) }, { start: at(10), end: at(12) }),
    /时间/
  );
  assert.throws(
    () => intervalsOverlap({ start: at(12), end: at(10) }, { start: at(10), end: at(12) }),
    /结束时间必须晚于开始时间/
  );
});

test('start mode accepts only a free channel', () => {
  assert.equal(
    channelEligibility({ mode: 'start', channel: { key: 'A', state: 'free' }, records: [] }).allowed,
    true
  );
  for (const state of ['busy', 'booked', 'fault']) {
    const result = channelEligibility({ mode: 'start', channel: { key: state, state }, records: [] });
    assert.equal(result.allowed, false);
    assert.equal(result.severity, 'error');
  }
});

test('reserve mode accepts free or unqueued busy channels with an expected end', () => {
  assert.equal(
    channelEligibility({ mode: 'reserve', channel: { key: 'A', state: 'free' }, records: [] }).allowed,
    true
  );
  assert.equal(
    channelEligibility({ mode: 'reserve', channel: { key: 'B', state: 'busy', end: at(12) }, records: [] }).allowed,
    true
  );
  const missingEnd = channelEligibility({
    mode: 'reserve',
    channel: { key: 'C', state: 'busy', end: '' },
    records: []
  });
  assert.equal(missingEnd.allowed, false);
  assert.equal(missingEnd.code, 'BUSY_CHANNEL_END_REQUIRED');
});

test('reserve mode blocks fault, booked and already queued busy channels', () => {
  for (const state of ['fault', 'booked']) {
    assert.equal(
      channelEligibility({ mode: 'reserve', channel: { key: state, state }, records: [] }).allowed,
      false
    );
  }
  const result = channelEligibility({
    mode: 'reserve',
    channel: { key: 'A', state: 'busy', end: at(12) },
    records: [{ id: 'queued', channelKey: 'A', status: 'reserved', start: at(13), end: at(15) }]
  });
  assert.equal(result.allowed, false);
  assert.equal(result.code, 'CHANNEL_ALREADY_QUEUED');
});

test('reserve mode warns when a request starts before the running test ends', () => {
  const current = {
    id: 'current',
    channelKey: 'A',
    status: 'running',
    start: at(8),
    end: at(12)
  };
  const result = validateAssignment({
    mode: 'reserve',
    channel: { key: 'A', state: 'busy', end: current.end },
    records: [current],
    start: at(11),
    end: at(13)
  });
  assert.equal(result.allowed, true);
  assert.equal(result.severity, 'warning');
  assert.equal(result.code, 'OVERLAPS_RUNNING_TEST');
});

test('reserve mode does not warn when it starts at the running test end', () => {
  const current = {
    id: 'current',
    channelKey: 'A',
    status: 'running',
    start: at(8),
    end: at(12)
  };
  const result = validateAssignment({
    mode: 'reserve',
    channel: { key: 'A', state: 'busy', end: current.end },
    records: [current],
    start: at(12),
    end: at(13)
  });
  assert.equal(result.allowed, true);
  assert.equal(result.severity, 'normal');
});

test('existing reservations are a hard block, including open-ended reservations', () => {
  const existing = {
    id: 'next',
    channelKey: 'A',
    status: 'reserved',
    start: at(13),
    end: ''
  };
  const result = validateAssignment({
    mode: 'reserve',
    channel: { key: 'A', state: 'busy', end: at(12) },
    records: [existing],
    start: at(20),
    end: at(21)
  });
  assert.equal(result.allowed, false);
  assert.equal(result.severity, 'error');
  assert.equal(result.code, 'CHANNEL_ALREADY_QUEUED');
});

test('free channel still rejects an overlapping reservation record', () => {
  const result = validateAssignment({
    mode: 'reserve',
    channel: { key: 'A', state: 'free' },
    records: [{ id: 'next', channelKey: 'A', status: 'reserved', start: at(13), end: at(15) }],
    start: at(14),
    end: at(16)
  });
  assert.equal(result.allowed, false);
  assert.equal(result.code, 'RESERVATION_OVERLAP');
});
