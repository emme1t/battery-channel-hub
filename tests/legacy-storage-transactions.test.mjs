import assert from 'node:assert/strict';
import test from 'node:test';

import {
  finishLegacyStorage,
  startLegacyStorage,
  updateLegacyStorage
} from '../src/domain/legacy-storage-transactions.mjs';

function state(overrides = {}) {
  return {
    requests: [{ id: 'REQ-1', project: '长期项目', status: 'pending' }],
    samples: [{ id: 'REQ-1.001', requestNo: 'REQ-1', status: 'pending' }],
    channels: [{ key: '设备一|1', state: 'busy', currentRecordId: 'REC-9', nextRecordId: '' }],
    records: [{ id: 'REC-9', sampleId: 'REQ-9.001', status: 'running', channelKey: '设备一|1' }],
    storageRecords: [],
    auditLogs: [],
    ...overrides
  };
}

function metadata(overrides = {}) {
  return {
    actor: 'tester',
    auditId: 'AUD-1',
    now: '2026-08-28T08:00:00.000Z',
    ...overrides
  };
}

function startCommand(overrides = {}) {
  return {
    storageId: 'STO-1',
    requestNo: 'REQ-1',
    sampleIds: ['REQ-1.001'],
    tester: 'tester',
    expectedEndAt: '2026-09-28T08:00:00.000Z',
    note: '干燥保存',
    ...metadata(),
    ...overrides
  };
}

test('start storage adds a storage record and audit without changing ordinary channels or records', () => {
  const input = state();
  const channelsBefore = structuredClone(input.channels);
  const recordsBefore = structuredClone(input.records);

  const next = startLegacyStorage(input, startCommand());

  assert.deepEqual(input, state());
  assert.deepEqual(next.channels, channelsBefore);
  assert.deepEqual(next.records, recordsBefore);
  assert.deepEqual(next.storageRecords, [{
    id: 'STO-1', requestNo: 'REQ-1', sampleIds: ['REQ-1.001'], tester: 'tester',
    status: 'storing', startedAt: '2026-08-28T08:00:00.000Z',
    expectedEndAt: '2026-09-28T08:00:00.000Z', endedAt: '', note: '干燥保存', returnReason: ''
  }]);
  assert.equal(next.samples[0].status, 'storing');
  assert.equal(next.requests[0].status, 'assigned');
  assert.equal(next.auditLogs.length, 1);
  assert.equal(next.auditLogs[0].action, 'storage_started');
  assert.equal(next.auditLogs[0].id, 'AUD-1');
  assert.equal(next.auditLogs[0].target, 'storage:STO-1');
});

test('start storage marks a request partially assigned when another sample remains pending', () => {
  const input = state({
    requests: [{ id: 'REQ-1', project: '长期项目', status: 'pending' }],
    samples: [
      { id: 'REQ-1.001', requestNo: 'REQ-1', status: 'pending' },
      { id: 'REQ-1.002', requestNo: 'REQ-1', status: 'pending' }
    ]
  });

  const next = startLegacyStorage(input, startCommand());

  assert.equal(next.samples[0].status, 'storing');
  assert.equal(next.samples[1].status, 'pending');
  assert.equal(next.requests[0].status, 'partially_assigned');
  assert.equal(input.requests[0].status, 'pending');
});

test('update storage changes only the allowed active fields and adds one canonical audit', () => {
  const started = startLegacyStorage(state(), startCommand());
  const channelsBefore = structuredClone(started.channels);
  const recordsBefore = structuredClone(started.records);

  const next = updateLegacyStorage(started, {
    storageId: 'STO-1', expectedEndAt: '2026-10-01T08:00:00.000Z', note: '改期', status: 'exception',
    ...metadata({ auditId: 'AUD-2', now: '2026-08-29T08:00:00.000Z' })
  });

  assert.equal(next.storageRecords[0].expectedEndAt, '2026-10-01T08:00:00.000Z');
  assert.equal(next.storageRecords[0].note, '改期');
  assert.equal(next.storageRecords[0].status, 'exception');
  assert.equal(next.samples[0].status, 'exception');
  assert.equal(next.auditLogs.length, 2);
  assert.equal(next.auditLogs[0].action, 'storage_updated');
  assert.equal(next.auditLogs[0].target, 'storage:STO-1');
  assert.deepEqual(next.channels, channelsBefore);
  assert.deepEqual(next.records, recordsBefore);
});

test('finish storage preserves historical storage data and adds exactly one completion audit', () => {
  const started = startLegacyStorage(state(), startCommand());
  const channelsBefore = structuredClone(started.channels);
  const recordsBefore = structuredClone(started.records);

  const next = finishLegacyStorage(started, {
    storageId: 'STO-1',
    ...metadata({ auditId: 'AUD-2', now: '2026-09-28T08:00:00.000Z' })
  });

  assert.equal(next.storageRecords.length, 1);
  assert.equal(next.storageRecords[0].status, 'completed');
  assert.equal(next.storageRecords[0].endedAt, '2026-09-28T08:00:00.000Z');
  assert.equal(next.storageRecords[0].note, '干燥保存');
  assert.equal(next.samples[0].status, 'completed');
  assert.equal(next.auditLogs.length, 2);
  assert.equal(next.auditLogs[0].action, 'storage_finished');
  assert.equal(next.auditLogs[0].target, 'storage:STO-1');
  assert.deepEqual(next.channels, channelsBefore);
  assert.deepEqual(next.records, recordsBefore);
});

test('invalid or duplicate storage operations reject without changing their input state', () => {
  const occupied = state({ samples: [{ id: 'REQ-1.001', requestNo: 'REQ-1', status: 'running' }] });
  const occupiedBefore = structuredClone(occupied);
  assert.throws(
    () => startLegacyStorage(occupied, startCommand()),
    error => error.code === 'SAMPLE_NOT_PENDING'
  );
  assert.deepEqual(occupied, occupiedBefore);

  const started = startLegacyStorage(state(), startCommand());
  const startedBefore = structuredClone(started);
  assert.throws(
    () => startLegacyStorage(started, startCommand({ auditId: 'AUD-2' })),
    error => error.code === 'STORAGE_ID_DUPLICATE'
  );
  assert.throws(
    () => finishLegacyStorage(started, { storageId: 'MISSING', ...metadata({ auditId: 'AUD-3' }) }),
    error => error.code === 'STORAGE_NOT_FOUND'
  );
  assert.deepEqual(started, startedBefore);
});
