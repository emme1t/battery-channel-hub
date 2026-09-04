import assert from 'node:assert/strict';
import test from 'node:test';

import {
  returnLegacyRunningToApplication,
  returnLegacyStorageToApplication
} from '../src/domain/legacy-return-to-application-transactions.mjs';
import * as returnTransactions from '../src/domain/legacy-return-to-application-transactions.mjs';
import { reservationCommandHandlers } from '../src/main/reservation-command-service.mjs';
import { storageCommandHandlers } from '../src/main/storage-command-service.mjs';
import { normalizeLegacyState } from '../src/main/legacy-state-schema.mjs';

const NOW = '2026-08-28T10:00:00.000Z';

function baseState(overrides = {}) {
  return {
    revision: 7,
    requests: [{ id: 'REQ-001', status: 'assigned' }],
    samples: [
      { id: 'REQ-001.001', requestNo: 'REQ-001', status: 'running', channelKey: '设备 A|001', hasHistory: true },
      { id: 'REQ-001.002', requestNo: 'REQ-001', status: 'reserved', channelKey: '设备 A|001', hasHistory: true }
    ],
    channels: [{
      key: '设备 A|001', device: '设备 A', name: '001', state: 'busy',
      currentRecordId: 'REC-CURRENT', nextRecordId: 'REC-NEXT',
      project: '当前项目', user: '测试员 A', requestNo: 'REQ-001', test: '循环',
      start: '2026-08-28T08:00:00.000Z', end: '2026-08-28T12:00:00.000Z'
    }],
    deviceProfiles: [{ id: 'DEV-A', name: '设备 A' }],
    records: [
      {
        id: 'REC-CURRENT', requestNo: 'REQ-001', no: 'REQ-001', sampleId: 'REQ-001.001',
        channelKey: '设备 A|001', keys: ['设备 A|001'], status: 'running',
        project: '当前项目', user: '测试员 A', start: '2026-08-28T08:00:00.000Z', end: '2026-08-28T12:00:00.000Z'
      },
      {
        id: 'REC-NEXT', requestNo: 'REQ-001', no: 'REQ-001', sampleId: 'REQ-001.002',
        channelKey: '设备 A|001', keys: ['设备 A|001'], status: 'reserved',
        project: '后续项目', user: '测试员 B', start: '2026-08-28T13:00:00.000Z', end: '2026-08-28T15:00:00.000Z'
      }
    ],
    storageRecords: [],
    auditLogs: [],
    ...overrides
  };
}

function metadata(overrides = {}) {
  return {
    actor: '管理员',
    auditId: 'AUD-RETURN',
    now: NOW,
    reason: '申请资料需要补充',
    ...overrides
  };
}

test('ordinary return requires a reason and rejects atomically', () => {
  const input = baseState();
  const snapshot = structuredClone(input);

  assert.throws(
    () => returnLegacyRunningToApplication(input, metadata({ recordId: 'REC-CURRENT', reason: '  ' })),
    error => error.code === 'COMMAND_FIELD_REQUIRED' && error.details?.field === 'reason'
  );
  assert.deepEqual(input, snapshot);
});

test('ordinary return preserves history, releases only current and keeps a valid next reservation', () => {
  const input = baseState();
  const next = returnLegacyRunningToApplication(input, metadata({ recordId: 'REC-CURRENT' }));

  assert.equal(next.records[0].status, 'returned');
  assert.equal(next.records[0].endedAt, NOW);
  assert.equal(next.records[0].returnReason, '申请资料需要补充');
  assert.equal(next.samples[0].status, 'pending');
  assert.equal(next.samples[0].channelKey, '');
  assert.equal(next.channels[0].currentRecordId, '');
  assert.equal(next.channels[0].nextRecordId, 'REC-NEXT');
  assert.equal(next.channels[0].state, 'booked');
  assert.equal(next.records[1].status, 'reserved');
  assert.equal(next.requests[0].status, 'partially_assigned');
  assert.equal(next.auditLogs.length, 1);
  assert.equal(next.auditLogs[0].action, 'running_returned_to_application');
  assert.equal(next.auditLogs[0].target, 'record:REC-CURRENT');
  assert.equal(next.auditLogs[0].note, '申请资料需要补充');
  assert.deepEqual(input, baseState());
});

test('ordinary return restores pending for a single-sample request', () => {
  const input = baseState({
    requests: [{ id: 'REQ-001', status: 'assigned' }],
    samples: [
      { id: 'REQ-001.001', requestNo: 'REQ-001', status: 'running', channelKey: '设备 A|001', hasHistory: true }
    ],
    channels: [{ ...baseState().channels[0], nextRecordId: '' }],
    records: [baseState().records[0]]
  });

  const next = returnLegacyRunningToApplication(input, metadata({ recordId: 'REC-CURRENT' }));

  assert.equal(next.samples[0].status, 'pending');
  assert.equal(next.requests[0].status, 'pending');
});

test('reserved return requires a reason, restores the sample and releases a booked channel atomically', () => {
  assert.equal(typeof returnTransactions.returnLegacyReservedToApplication, 'function');
  const reservedRecord = { ...baseState().records[1] };
  const input = baseState({
    requests: [{ id: 'REQ-001', status: 'assigned' }],
    samples: [{ id: 'REQ-001.002', requestNo: 'REQ-001', status: 'reserved', channelKey: '设备 A|001', hasHistory: true }],
    channels: [{ ...baseState().channels[0], state: 'booked', currentRecordId: '', nextRecordId: 'REC-NEXT' }],
    records: [reservedRecord]
  });
  const snapshot = structuredClone(input);

  assert.throws(
    () => returnTransactions.returnLegacyReservedToApplication(input, metadata({ recordId: 'REC-NEXT', reason: '   ' })),
    error => error.code === 'COMMAND_FIELD_REQUIRED' && error.details?.field === 'reason'
  );
  assert.deepEqual(input, snapshot);

  const next = returnTransactions.returnLegacyReservedToApplication(input, metadata({ recordId: 'REC-NEXT' }));
  assert.equal(next.records[0].status, 'returned');
  assert.equal(next.records[0].returnedAt, NOW);
  assert.equal(next.records[0].returnReason, '申请资料需要补充');
  assert.equal(next.samples[0].status, 'pending');
  assert.equal(next.samples[0].channelKey, '');
  assert.equal(next.channels[0].state, 'free');
  assert.equal(next.channels[0].nextRecordId, '');
  assert.equal(next.requests[0].status, 'pending');
  assert.equal(next.auditLogs[0].action, 'reserved_returned_to_application');
  assert.equal(next.auditLogs[0].note, '申请资料需要补充');
  assert.deepEqual(input, snapshot);
});

test('returning a queued reservation preserves the running owner and only clears the queue pointer', () => {
  assert.equal(typeof returnTransactions.returnLegacyReservedToApplication, 'function');
  const input = baseState();
  const next = returnTransactions.returnLegacyReservedToApplication(input, metadata({ recordId: 'REC-NEXT' }));

  assert.equal(next.channels[0].state, 'busy');
  assert.equal(next.channels[0].currentRecordId, 'REC-CURRENT');
  assert.equal(next.channels[0].nextRecordId, '');
  assert.equal(next.records[0].status, 'running');
  assert.equal(next.records[1].status, 'returned');
  assert.equal(next.samples[0].status, 'running');
  assert.equal(next.samples[1].status, 'pending');
});

test('reserved return rejects broken sample or channel ownership without mutating legacy state', () => {
  const cases = [
    baseState({
      samples: [
        baseState().samples[0],
        { ...baseState().samples[1], status: 'running' }
      ]
    }),
    baseState({
      samples: [
        baseState().samples[0],
        { ...baseState().samples[1], channelKey: '设备 A|999' }
      ]
    }),
    baseState({
      channels: [{ ...baseState().channels[0], state: 'free', currentRecordId: '' }]
    }),
    baseState({
      channels: [{ ...baseState().channels[0], state: 'busy', currentRecordId: 'REC-MISSING' }]
    })
  ];

  for (const input of cases) {
    const snapshot = structuredClone(input);
    assert.throws(
      () => returnTransactions.returnLegacyReservedToApplication(input, metadata({ recordId: 'REC-NEXT' })),
      error => ['RESERVED_SAMPLE_POINTER_INVALID', 'RESERVED_CHANNEL_STATE_INVALID'].includes(error.code)
    );
    assert.deepEqual(input, snapshot);
  }
});

test('ordinary return rejects a next pointer whose reserved owner belongs to another channel', () => {
  const input = baseState({
    samples: [
      { id: 'REQ-001.001', requestNo: 'REQ-001', status: 'running', channelKey: '设备 A|001', hasHistory: true },
      { id: 'REQ-001.002', requestNo: 'REQ-001', status: 'reserved', channelKey: '设备 A|002', hasHistory: true }
    ],
    channels: [
      {
        ...baseState().channels[0],
        nextRecordId: 'REC-NEXT'
      },
      {
        key: '设备 A|002', device: '设备 A', name: '002', state: 'booked',
        currentRecordId: '', nextRecordId: 'REC-NEXT', project: '后续项目', user: '测试员 B',
        requestNo: 'REQ-001', test: '循环', start: '2026-08-28T13:00:00.000Z', end: '2026-08-28T15:00:00.000Z'
      }
    ],
    records: [
      baseState().records[0],
      { ...baseState().records[1], channelKey: '设备 A|002', keys: ['设备 A|002'] }
    ]
  });

  const snapshot = structuredClone(input);
  assert.throws(
    () => returnLegacyRunningToApplication(input, metadata({ recordId: 'REC-CURRENT' })),
    error => error.code === 'RUNNING_CHANNEL_OWNERSHIP_INVALID'
  );
  assert.deepEqual(input, snapshot);
});

test('ordinary return rejects broken record, sample, request or channel ownership atomically', () => {
  const cases = [
    input => { input.records[0].channelKey = '设备 A|999'; input.records[0].keys = ['设备 A|999']; },
    input => { input.samples[0].status = 'reserved'; },
    input => { input.samples[0].channelKey = '设备 A|999'; },
    input => { input.samples[0].requestNo = 'REQ-MISSING'; },
    input => { input.records[0].requestNo = 'REQ-MISSING'; input.records[0].no = 'REQ-MISSING'; },
    input => { input.channels[0].state = 'booked'; },
    input => { input.records.push({ ...input.records[0], id: 'REC-DUPLICATE' }); }
  ];

  for (const mutate of cases) {
    const input = baseState();
    mutate(input);
    const snapshot = structuredClone(input);
    assert.throws(
      () => returnLegacyRunningToApplication(input, metadata({ recordId: 'REC-CURRENT' })),
      error => ['RUNNING_RECORD_POINTER_INVALID', 'RUNNING_OWNERSHIP_INVALID'].includes(error.code)
    );
    assert.deepEqual(input, snapshot);
  }
});

test('storage return requires a reason and leaves every channel byte-for-byte unchanged', () => {
  const input = baseState({
    samples: [{ id: 'REQ-001.001', requestNo: 'REQ-001', status: 'storing', hasHistory: true }],
    records: [],
    storageRecords: [{
      id: 'STO-001', requestNo: 'REQ-001', sampleIds: ['REQ-001.001'], tester: '测试员 C',
      status: 'storing', startedAt: '2026-08-01T08:00:00.000Z',
      expectedEndAt: '2026-09-01T08:00:00.000Z', endedAt: '', note: '干燥保存', returnReason: ''
    }]
  });
  const snapshot = structuredClone(input);

  assert.throws(
    () => returnLegacyStorageToApplication(input, metadata({ storageId: 'STO-001', reason: '' })),
    error => error.code === 'COMMAND_FIELD_REQUIRED' && error.details?.field === 'reason'
  );
  assert.deepEqual(input, snapshot);

  const next = returnLegacyStorageToApplication(input, metadata({ storageId: 'STO-001' }));
  assert.equal(next.storageRecords[0].status, 'returned');
  assert.equal(next.storageRecords[0].endedAt, NOW);
  assert.equal(next.storageRecords[0].returnReason, '申请资料需要补充');
  assert.equal(next.samples[0].status, 'pending');
  assert.equal(next.requests[0].status, 'pending');
  assert.deepEqual(next.channels, input.channels);
  assert.deepEqual(next.records, input.records);
  assert.equal(next.auditLogs.length, 1);
  assert.equal(next.auditLogs[0].action, 'storage_returned_to_application');
  assert.equal(next.auditLogs[0].target, 'storage:STO-001');
  assert.equal(next.auditLogs[0].note, '申请资料需要补充');
});

test('storage return restores pending when every sample in a multi-sample request is returned', () => {
  const input = baseState({
    requests: [{ id: 'REQ-001', status: 'assigned' }],
    samples: [
      { id: 'REQ-001.001', requestNo: 'REQ-001', status: 'storing', hasHistory: true },
      { id: 'REQ-001.002', requestNo: 'REQ-001', status: 'storing', hasHistory: true }
    ],
    records: [],
    storageRecords: [{
      id: 'STO-001', requestNo: 'REQ-001', sampleIds: ['REQ-001.001', 'REQ-001.002'], tester: '测试员 C',
      status: 'storing', startedAt: '2026-08-01T08:00:00.000Z',
      expectedEndAt: '2026-09-01T08:00:00.000Z', endedAt: '', note: '干燥保存', returnReason: ''
    }]
  });

  const next = returnLegacyStorageToApplication(input, metadata({ storageId: 'STO-001' }));

  assert.deepEqual(next.samples.map(item => item.status), ['pending', 'pending']);
  assert.equal(next.requests[0].status, 'pending');
});

test('storage return requires exclusive active ownership of every sample and fails atomically', () => {
  const storageState = () => baseState({
    samples: [{
      id: 'REQ-001.001', requestNo: 'REQ-001', status: 'storing',
      channelKey: '', hasHistory: true
    }],
    records: [],
    storageRecords: [{
      id: 'STO-001', requestNo: 'REQ-001', sampleIds: ['REQ-001.001'], tester: '测试员 C',
      status: 'storing', startedAt: '2026-08-01T08:00:00.000Z',
      expectedEndAt: '2026-09-01T08:00:00.000Z', endedAt: '', note: '', returnReason: ''
    }]
  });
  const cases = [
    input => { input.samples[0].status = 'exception'; },
    input => { input.samples[0].channelKey = '设备 A|001'; },
    input => { input.samples[0].requestNo = 'REQ-MISSING'; },
    input => { input.storageRecords[0].requestNo = 'REQ-MISSING'; },
    input => { input.storageRecords[0].sampleIds.push('REQ-001.001'); },
    input => { input.records.push({ ...baseState().records[0], sampleId: 'REQ-001.001' }); },
    input => { input.storageRecords.push({ ...input.storageRecords[0], id: 'STO-OTHER' }); }
  ];

  for (const mutate of cases) {
    const input = storageState();
    mutate(input);
    const snapshot = structuredClone(input);
    assert.throws(
      () => returnLegacyStorageToApplication(input, metadata({ storageId: 'STO-001' })),
      error => error.code === 'STORAGE_OWNERSHIP_INVALID'
    );
    assert.deepEqual(input, snapshot);
  }
});

test('both command services expose the return handlers through their existing whitelist', () => {
  assert.equal(reservationCommandHandlers.returnRunningToApplication, returnLegacyRunningToApplication);
  assert.equal(reservationCommandHandlers.returnReservedToApplication, returnTransactions.returnLegacyReservedToApplication);
  assert.equal(storageCommandHandlers.returnStorageToApplication, returnLegacyStorageToApplication);
});

test('returned ordinary history remains valid at the SQLite normalization boundary', () => {
  const returned = returnLegacyRunningToApplication(baseState(), metadata({ recordId: 'REC-CURRENT' }));
  const normalized = normalizeLegacyState(returned);
  assert.equal(normalized.records.find(item => item.id === 'REC-CURRENT').status, 'returned');
  assert.equal(normalized.samples.find(item => item.id === 'REQ-001.001').status, 'pending');
});
