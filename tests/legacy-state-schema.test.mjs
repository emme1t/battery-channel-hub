import assert from 'node:assert/strict';
import test from 'node:test';

import {
  normalizeLegacyState,
  summarizeLegacyState
} from '../src/main/legacy-state-schema.mjs';

function baseState(overrides = {}) {
  return {
    revision: 0,
    requests: [],
    channels: [],
    deviceProfiles: [],
    records: [],
    samples: [],
    requestSourceRows: [],
    auditLogs: [],
    formChangeJournal: [],
    testers: [],
    storageRecords: [],
    ...overrides
  };
}

test('legacy state preserves every original collection and clones input', () => {
  const input = baseState();

  const state = normalizeLegacyState(input);

  assert.deepEqual(Object.keys(state).sort(), [...Object.keys(input), 'savedAt'].sort());
  assert.notStrictEqual(state.channels, input.channels);
  assert.deepEqual(state, { ...input, savedAt: '' });
});

test('legacy state fills missing collections without mutating input', () => {
  const input = { revision: 3, username: 'operator' };

  const state = normalizeLegacyState(input);

  assert.deepEqual(input, { revision: 3, username: 'operator' });
  assert.equal(state.revision, 3);
  assert.equal(state.username, 'operator');
  for (const name of [
    'requests', 'channels', 'deviceProfiles', 'records', 'samples',
    'requestSourceRows', 'auditLogs', 'formChangeJournal', 'testers', 'storageRecords'
  ]) {
    assert.deepEqual(state[name], []);
  }
});

test('legacy state restores every missing battery identifier from the application batch quantity', () => {
  const input = baseState({
    requests: [{ id: 'REQ-BATCH-007', qty: 3, status: '部分安排' }],
    samples: [{
      id: 'REQ-BATCH-007.001',
      requestNo: 'REQ-BATCH-007',
      ordinal: 1,
      status: '测试中',
      channelKey: '设备一|1',
      hasHistory: true
    }],
    deviceProfiles: [{ id: 'D-1', name: '设备一', status: '启用' }],
    channels: [{ key: '设备一|1', device: '设备一', name: '1', state: 'busy' }]
  });

  const state = normalizeLegacyState(input);

  assert.deepEqual(state.samples.map(item => item.id), [
    'REQ-BATCH-007.001',
    'REQ-BATCH-007.002',
    'REQ-BATCH-007.003'
  ]);
  assert.deepEqual(state.samples.map(item => item.ordinal), [1, 2, 3]);
  assert.equal(state.samples[0].status, 'running');
  assert.equal(state.samples[0].channelKey, '设备一|1');
  assert.equal(state.samples[0].hasHistory, true);
  assert.deepEqual(state.samples.slice(1), [
    {
      id: 'REQ-BATCH-007.002', requestNo: 'REQ-BATCH-007', ordinal: 2,
      status: 'pending', channelKey: '', start: '', end: '', hasHistory: false
    },
    {
      id: 'REQ-BATCH-007.003', requestNo: 'REQ-BATCH-007', ordinal: 3,
      status: 'pending', channelKey: '', start: '', end: '', hasHistory: false
    }
  ]);
  assert.equal(input.samples.length, 1);
});

test('missing samples inherit reserved or running ownership from one active ordinary record', () => {
  for (const status of ['reserved', 'running']) {
    const start = `2026-08-20T0${status === 'reserved' ? '9' : '8'}:00:00.000Z`;
    const end = '2026-08-20T12:00:00.000Z';
    const state = normalizeLegacyState(baseState({
      requests: [{ id: 'REQ-INFER-ORDINARY', qty: 1, status }],
      deviceProfiles: [{ id: 'D-1', name: '设备一', status: 'enabled' }],
      channels: [{
        key: '设备一|001', device: '设备一', name: '001',
        state: status === 'running' ? 'busy' : 'booked'
      }],
      records: [{
        id: `REC-${status}`, requestNo: 'REQ-INFER-ORDINARY',
        sampleId: 'REQ-INFER-ORDINARY.001', channelKey: '设备一|001',
        keys: ['设备一|001'], status, start, end
      }]
    }));

    assert.deepEqual(state.samples, [{
      id: 'REQ-INFER-ORDINARY.001', requestNo: 'REQ-INFER-ORDINARY', ordinal: 1,
      status, channelKey: '设备一|001', start, end, hasHistory: true
    }]);
  }
});

test('missing samples inherit storing or exception ownership from one active storage record without a channel', () => {
  for (const status of ['storing', 'exception']) {
    const state = normalizeLegacyState(baseState({
      requests: [{ id: 'REQ-INFER-STORAGE', qty: 1, status: 'assigned' }],
      storageRecords: [{
        id: `STO-${status}`, requestNo: 'REQ-INFER-STORAGE',
        sampleIds: ['REQ-INFER-STORAGE.001'], status,
        startedAt: '2026-08-01T08:00:00.000Z',
        expectedEndAt: '2026-09-01T08:00:00.000Z'
      }]
    }));

    assert.deepEqual(state.samples, [{
      id: 'REQ-INFER-STORAGE.001', requestNo: 'REQ-INFER-STORAGE', ordinal: 1,
      status, channelKey: '', start: '2026-08-01T08:00:00.000Z',
      end: '2026-09-01T08:00:00.000Z', hasHistory: true
    }]);
  }
});

test('missing sample recovery rejects multiple owners, non-unique channels and incomplete active lineage', () => {
  const request = { id: 'REQ-INFER-BLOCK', qty: 1, status: 'assigned' };
  const activeRecord = {
    id: 'REC-ONE', requestNo: request.id, sampleId: `${request.id}.001`,
    channelKey: '设备一|001', keys: ['设备一|001'], status: 'running',
    start: '2026-08-20T08:00:00.000Z', end: '2026-08-20T12:00:00.000Z'
  };
  const deviceProfiles = [{ id: 'D-1', name: '设备一', status: 'enabled' }];
  const channels = [
    { key: '设备一|001', device: '设备一', name: '001', state: 'busy' },
    { key: '设备一|002', device: '设备一', name: '002', state: 'busy' }
  ];
  const cases = [
    baseState({
      requests: [request], deviceProfiles, channels,
      records: [activeRecord, { ...activeRecord, id: 'REC-TWO' }]
    }),
    baseState({
      requests: [request], deviceProfiles, channels,
      records: [{ ...activeRecord, keys: ['设备一|001', '设备一|002'] }]
    }),
    baseState({
      requests: [request], deviceProfiles, channels,
      records: [{ ...activeRecord, start: '' }]
    }),
    baseState({
      requests: [request],
      storageRecords: [{
        id: 'STO-ONE', requestNo: request.id, sampleIds: [`${request.id}.001`],
        status: 'storing', startedAt: ''
      }]
    })
  ];

  for (const input of cases) {
    const snapshot = structuredClone(input);
    assert.throws(
      () => normalizeLegacyState(input),
      error => ['MISSING_SAMPLE_OWNER_CONFLICT', 'MISSING_SAMPLE_OWNER_INVALID'].includes(error.code)
    );
    assert.deepEqual(input, snapshot);
  }
});

test('missing samples with no active owner remain pending and unassigned', () => {
  const state = normalizeLegacyState(baseState({
    requests: [{ id: 'REQ-INFER-PENDING', qty: 1, status: 'pending' }],
    records: [{
      id: 'REC-HISTORY', requestNo: 'REQ-INFER-PENDING', sampleId: 'REQ-INFER-PENDING.001',
      channelKey: '设备一|001', status: 'completed', start: '2026-08-01T08:00:00.000Z'
    }]
  }));

  assert.deepEqual(state.samples, [{
    id: 'REQ-INFER-PENDING.001', requestNo: 'REQ-INFER-PENDING', ordinal: 1,
    status: 'pending', channelKey: '', start: '', end: '', hasHistory: false
  }]);
});

test('legacy state canonicalizes persisted Chinese business statuses and repairs an unambiguous half-started reservation', () => {
  const input = baseState({
    requests: [
      { id: 'REQ-1', status: '待安排' },
      { id: 'REQ-2', status: '部分安排' },
      { id: 'REQ-3', status: '已安排' }
    ],
    deviceProfiles: [{ id: 'D-1', name: '设备一', status: '停用' }],
    channels: [{
      key: '设备一|1', device: '设备一', name: '1', state: 'busy',
      currentRecordId: '', nextRecordId: 'REC-1'
    }],
    records: [{
      id: 'REC-1', requestNo: 'REQ-1', sampleId: 'REQ-1.001',
      channelKey: '设备一|1', keys: ['设备一|1'], status: 'reserved', state: '测试中'
    }],
    samples: [{ id: 'REQ-1.001', requestNo: 'REQ-1', status: '已预约' }],
    testers: [{ id: 'T-1', name: '测试员', status: '启用' }]
  });

  const state = normalizeLegacyState(input);

  assert.deepEqual(state.requests.map(item => item.status), ['pending', 'partially_assigned', 'assigned']);
  assert.equal(state.deviceProfiles[0].status, 'disabled');
  assert.equal(state.testers[0].status, 'enabled');
  assert.equal(state.records[0].status, 'running');
  assert.equal('state' in state.records[0], false);
  assert.equal(state.samples[0].status, 'running');
  assert.equal(state.channels[0].state, 'busy');
  assert.equal(state.channels[0].currentRecordId, 'REC-1');
  assert.equal(state.channels[0].nextRecordId, '');
  assert.equal(input.records[0].state, '测试中');
  assert.equal(input.records[0].status, 'reserved');
});

test('legacy state rejects unknown persisted business statuses instead of retaining mixed-language values', () => {
  assert.throws(
    () => normalizeLegacyState(baseState({ requests: [{ id: 'REQ-X', status: '正在搞' }] })),
    error => error.code === 'REQUEST_STATUS_INVALID'
  );
  assert.throws(
    () => normalizeLegacyState(baseState({ testers: [{ id: 'T-X', name: '测试员', status: '在岗' }] })),
    error => error.code === 'TESTER_STATUS_INVALID'
  );
});

test('legacy state rejects malformed top-level values and revisions', () => {
  assert.throws(() => normalizeLegacyState(null), error => error.code === 'STATE_INVALID');
  assert.throws(() => normalizeLegacyState([]), error => error.code === 'STATE_INVALID');
  assert.throws(
    () => normalizeLegacyState(baseState({ revision: -1 })),
    error => error.code === 'REVISION_INVALID'
  );
});

test('legacy state rejects duplicate devices, channel keys and unknown device references', () => {
  const device = { id: 'P001', name: '设备一' };
  assert.throws(
    () => normalizeLegacyState(baseState({ deviceProfiles: [device, { ...device }] })),
    error => error.code === 'DEVICE_ID_DUPLICATE'
  );
  assert.throws(
    () => normalizeLegacyState(baseState({
      deviceProfiles: [device],
      channels: [
        { key: '设备一|1', device: '设备一', name: '1', state: 'free' },
        { key: '设备一|1', device: '设备一', name: '2', state: 'free' }
      ]
    })),
    error => error.code === 'CHANNEL_KEY_DUPLICATE'
  );
  assert.throws(
    () => normalizeLegacyState(baseState({
      deviceProfiles: [device],
      channels: [{ key: '不存在|1', device: '不存在', name: '1', state: 'free' }]
    })),
    error => error.code === 'CHANNEL_DEVICE_UNKNOWN'
  );
});

test('legacy state rejects duplicate battery identifiers so one battery cannot occupy two rows', () => {
  assert.throws(
    () => normalizeLegacyState(baseState({
      requests: [{ id: 'REQ-BATCH-009', qty: 1, status: '待安排' }],
      samples: [
        { id: 'REQ-BATCH-009.001', requestNo: 'REQ-BATCH-009', ordinal: 1, status: '待安排' },
        { id: 'REQ-BATCH-009.001', requestNo: 'REQ-BATCH-009', ordinal: 1, status: '待安排' }
      ]
    })),
    error => error.code === 'SAMPLE_ID_DUPLICATE'
  );
});

test('legacy state summary reports every production-relevant collection', () => {
  const state = baseState({
    requests: [{ id: 'REQ-1' }],
    channels: [
      { key: 'D|1', device: 'D', name: '1', state: 'free' },
      { key: 'D|2', device: 'D', name: '2', state: 'free' }
    ],
    deviceProfiles: [{ id: 'D', name: 'D' }],
    records: [{ id: 'REC-1' }],
    samples: [{ id: 'REQ-1.001' }],
    requestSourceRows: [{ id: 'SRC-1' }],
    auditLogs: [{ id: 'AUD-1' }],
    formChangeJournal: [{ id: 'FORM-1' }],
    testers: [{ id: 'T-1' }],
    storageRecords: [{ id: 'STO-1', sampleIds: ['REQ-1.001'], status: 'completed' }]
  });

  assert.deepEqual(summarizeLegacyState(state), {
    revision: 0,
    requests: 1,
    samples: 1,
    devices: 1,
    channels: 2,
    records: 1,
    audits: 1,
    requestSourceRows: 1,
    formChangeJournal: 1,
    testers: 1,
    storageRecords: 1
  });
});

test('legacy state fills missing storage records and canonicalizes the paused legacy status', () => {
  const missing = normalizeLegacyState({ revision: 3, username: 'operator' });
  const paused = normalizeLegacyState(baseState({
    storageRecords: [{
      id: 'STO-1', requestNo: 'REQ-1', sampleIds: ['REQ-1.001'],
      status: 'paused', startedAt: '2026-08-28T08:00:00.000Z'
    }]
  }));

  assert.deepEqual(missing.storageRecords, []);
  assert.equal(paused.storageRecords[0].status, 'exception');
});

test('legacy state rejects invalid or duplicate storage records and active sample conflicts', () => {
  assert.throws(
    () => normalizeLegacyState(baseState({
      storageRecords: [{ id: 'STO-1', requestNo: 'REQ-1', sampleIds: ['REQ-1.001'], status: 'waiting' }]
    })),
    error => error.code === 'STORAGE_STATUS_INVALID'
  );
  assert.throws(
    () => normalizeLegacyState(baseState({
      storageRecords: [
        { id: 'STO-1', requestNo: 'REQ-1', sampleIds: ['REQ-1.001'], status: 'completed' },
        { id: 'STO-1', requestNo: 'REQ-2', sampleIds: ['REQ-2.001'], status: 'completed' }
      ]
    })),
    error => error.code === 'STORAGE_ID_DUPLICATE'
  );
  assert.throws(
    () => normalizeLegacyState(baseState({
      storageRecords: [{ id: 'STO-1', requestNo: 'REQ-1', sampleIds: ['REQ-1.001'], status: 'storing' }],
      records: [{ id: 'REC-1', sampleId: 'REQ-1.001', status: 'running' }]
    })),
    error => error.code === 'SAMPLE_ACTIVE_ASSIGNMENT_CONFLICT'
  );
  assert.throws(
    () => normalizeLegacyState(baseState({
      storageRecords: [
        { id: 'STO-1', requestNo: 'REQ-1', sampleIds: ['REQ-1.001'], status: 'storing' },
        { id: 'STO-2', requestNo: 'REQ-1', sampleIds: ['REQ-1.001'], status: 'exception' }
      ]
    })),
    error => error.code === 'SAMPLE_ACTIVE_ASSIGNMENT_CONFLICT'
  );
});

test('legacy state accepts storage sample statuses produced by storage transactions', () => {
  const state = normalizeLegacyState(baseState({
    samples: [{ id: 'REQ-1.001', requestNo: 'REQ-1', status: 'storing' }],
    storageRecords: [{ id: 'STO-1', requestNo: 'REQ-1', sampleIds: ['REQ-1.001'], status: 'storing' }]
  }));

  assert.equal(state.samples[0].status, 'storing');
});
