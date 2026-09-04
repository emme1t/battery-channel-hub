import test from 'node:test';
import assert from 'node:assert/strict';

import {
  reserveSample,
  startSample
} from '../src/domain/reservation-transactions.mjs';
import {
  makeChannel,
  makeRecord,
  makeRequest,
  makeSample,
  makeState
} from './fixtures/state-fixtures.mjs';

const at = (hour) => `2026-08-20T${String(hour).padStart(2, '0')}:00:00-07:00`;

function stateFor(channelOverrides = {}, stateOverrides = {}) {
  return makeState({
    requests: [makeRequest()],
    samples: [makeSample()],
    channels: [makeChannel(channelOverrides)],
    records: [],
    audits: [],
    ...stateOverrides
  });
}

function commandFor(channelKey = 'device-01|001', overrides = {}) {
  return {
    requestNo: 'R-001',
    sampleId: 'R-001.001',
    channelKey,
    start: at(10),
    end: at(12),
    actor: '测试员 A',
    recordId: 'record-new',
    auditId: 'audit-new',
    now: at(9),
    note: '生产排程',
    acceptWarning: false,
    ...overrides
  };
}

test('a rejected reservation leaves every collection byte-for-byte unchanged', () => {
  const before = stateFor({ state: 'fault' });
  const snapshot = structuredClone(before);

  assert.throws(() => reserveSample(before, commandFor()), /异常通道不可预约/);
  assert.deepEqual(before, snapshot);
});

test('a successful start updates channel, sample, record and audit in one returned state', () => {
  const before = stateFor();
  const result = startSample(before, commandFor());

  assert.notEqual(result.state, before);
  assert.equal(result.state.channels[0].state, 'busy');
  assert.equal(result.state.channels[0].currentRecordId, 'record-new');
  assert.equal(result.state.samples[0].status, 'running');
  assert.equal(result.state.samples[0].channelKey, 'device-01|001');
  assert.equal(result.state.records[0].status, 'running');
  assert.equal(result.state.audits[0].result, 'success');
  assert.equal(result.state.audits[0].level, 'NORMAL');
  assert.deepEqual(result.warnings, []);
  assert.equal(before.channels[0].state, 'free');
  assert.equal(before.records.length, 0);
});

test('a free-channel reservation becomes booked without overwriting raw request fields', () => {
  const before = stateFor({}, {
    requests: [makeRequest({ rawFields: { 委托人: '原始委托人' }, execution: { tester: '旧测试员' } })]
  });
  const result = reserveSample(before, commandFor());

  assert.equal(result.state.channels[0].state, 'booked');
  assert.equal(result.state.samples[0].status, 'reserved');
  assert.equal(result.state.records[0].status, 'reserved');
  assert.deepEqual(result.state.requests[0].rawFields, { 委托人: '原始委托人' });
  assert.deepEqual(result.state.requests[0].execution, { tester: '旧测试员' });
});

test('overlap with a running test requires explicit warning acceptance', () => {
  const current = makeRecord({
    id: 'record-current',
    status: 'running',
    start: at(8),
    end: at(12)
  });
  const before = stateFor(
    { state: 'busy', end: at(12), currentRecordId: current.id },
    { records: [current] }
  );
  const snapshot = structuredClone(before);

  assert.throws(
    () => reserveSample(before, commandFor(undefined, { start: at(11), end: at(13) })),
    /确认 WARNING/
  );
  assert.deepEqual(before, snapshot);

  const accepted = reserveSample(before, commandFor(undefined, {
    start: at(11),
    end: at(13),
    acceptWarning: true
  }));
  assert.equal(accepted.state.channels[0].state, 'busy');
  assert.equal(accepted.state.channels[0].currentRecordId, 'record-current');
  assert.equal(accepted.state.records.length, 2);
  assert.equal(accepted.state.records[1].status, 'reserved');
  assert.equal(accepted.state.audits[0].level, 'WARNING');
  assert.deepEqual(accepted.warnings, ['预约开始早于当前测试的预计结束时间']);
});

test('unknown entities and non-pending samples are rejected without writes', () => {
  const cases = [
    [stateFor(), commandFor('missing'), /通道不存在/],
    [stateFor(), commandFor(undefined, { requestNo: 'missing' }), /申请不存在/],
    [stateFor(), commandFor(undefined, { sampleId: 'missing' }), /子样品不存在/],
    [stateFor({}, { samples: [makeSample({ status: 'completed', hasHistory: true })] }), commandFor(), /待安排/]
  ];

  for (const [before, command, pattern] of cases) {
    const snapshot = structuredClone(before);
    assert.throws(() => reserveSample(before, command), pattern);
    assert.deepEqual(before, snapshot);
  }
});

test('duplicate record and audit identifiers are rejected atomically', () => {
  const existing = makeRecord({ id: 'record-new', status: 'completed' });
  const before = stateFor({}, {
    records: [existing],
    audits: [{ id: 'audit-new', result: 'success' }]
  });
  const snapshot = structuredClone(before);

  assert.throws(() => startSample(before, commandFor()), /标识已存在/);
  assert.deepEqual(before, snapshot);
});
