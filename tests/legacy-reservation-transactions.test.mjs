import assert from 'node:assert/strict';
import test from 'node:test';

import {
  reconcileLegacySamples,
  reserveLegacySample,
  startLegacySample,
  transitionLegacyChannel
} from '../src/domain/legacy-reservation-transactions.mjs';

const at = hour => `2026-08-20T${String(hour).padStart(2, '0')}:00:00-07:00`;

function sample(id = 'REQ-001.001', overrides = {}) {
  return {
    id,
    requestNo: 'REQ-001',
    ordinal: Number(id.split('.').at(-1)),
    status: 'pending',
    channelKey: '',
    start: '',
    end: '',
    hasHistory: false,
    ...overrides
  };
}

function channel(overrides = {}) {
  return {
    key: '设备 A|001',
    device: '设备 A',
    name: '001',
    state: 'free',
    project: '',
    user: '',
    start: '',
    end: null,
    requestNo: '',
    test: '',
    currentRecordId: '',
    nextRecordId: '',
    ...overrides
  };
}

function baseState(overrides = {}) {
  return {
    revision: 1,
    requests: [{ id: 'REQ-001', qty: 1, project: '项目 A', test: '循环测试', sample: '35Ah' }],
    samples: [sample()],
    channels: [channel()],
    deviceProfiles: [{ id: 'D001', name: '设备 A' }],
    records: [],
    requestSourceRows: [],
    auditLogs: [],
    formChangeJournal: [],
    testers: [],
    username: '测试员 A',
    savedAt: '',
    ...overrides
  };
}

function assignment(overrides = {}) {
  return {
    requestNo: 'REQ-001',
    sampleId: 'REQ-001.001',
    channelKey: '设备 A|001',
    start: at(10),
    end: at(12),
    actor: '测试员 A',
    recordId: 'REC-NEW',
    auditId: 'AUDIT-NEW',
    now: at(9),
    note: '生产排程',
    acceptWarning: false,
    ...overrides
  };
}

function usageRecord(overrides = {}) {
  return {
    id: 'REC-CURRENT',
    no: 'REQ-001',
    requestNo: 'REQ-001',
    sampleId: 'REQ-001.001',
    channelKey: '设备 A|001',
    keys: ['设备 A|001'],
    state: '测试中',
    status: 'running',
    time: at(8),
    start: at(8),
    end: at(12),
    user: '测试员 A',
    actor: '测试员 A',
    ...overrides
  };
}

function transition(action, overrides = {}) {
  return {
    action,
    channelKey: '设备 A|001',
    actor: '测试员 A',
    auditId: `AUDIT-${action.toUpperCase()}`,
    now: at(13),
    ...overrides
  };
}

test('quantity 1 and 999 create fixed three-digit child identifiers', () => {
  const one = reconcileLegacySamples(baseState(), {
    requestNo: 'REQ-001', quantity: 1
  });
  assert.deepEqual(one.samples.map(item => item.id), ['REQ-001.001']);

  const many = reconcileLegacySamples(baseState(), {
    requestNo: 'REQ-001', quantity: 999
  });
  assert.equal(many.samples.length, 999);
  assert.equal(many.samples.at(-1).id, 'REQ-001.999');
  assert.equal(many.requests[0].qty, 999);
});

test('quantity outside 1..999 and unconfirmed reduction leave the input unchanged', () => {
  const before = baseState();
  const snapshot = structuredClone(before);
  assert.throws(
    () => reconcileLegacySamples(before, { requestNo: 'REQ-001', quantity: 1000 }),
    error => error.code === 'QUANTITY_INVALID'
  );
  assert.deepEqual(before, snapshot);

  const three = reconcileLegacySamples(before, { requestNo: 'REQ-001', quantity: 3 });
  assert.throws(
    () => reconcileLegacySamples(three, { requestNo: 'REQ-001', quantity: 1 }),
    error => error.code === 'SAMPLE_REDUCTION_CONFIRMATION_REQUIRED'
  );
  assert.equal(three.samples.length, 3);
});

test('reduction touching booked, running or historical tail is an atomic failure', () => {
  for (const tail of [
    { status: 'reserved', hasHistory: true },
    { status: 'running', hasHistory: true },
    { status: 'pending', hasHistory: true }
  ]) {
    const before = baseState({
      requests: [{ id: 'REQ-001', qty: 2 }],
      samples: [sample(), sample('REQ-001.002', tail)]
    });
    const snapshot = structuredClone(before);
    assert.throws(
      () => reconcileLegacySamples(before, { requestNo: 'REQ-001', quantity: 1, confirmed: true }),
      error => error.code === 'SAMPLE_HISTORY_BLOCK'
    );
    assert.deepEqual(before, snapshot);
  }
});

test('starting a pending sample updates channel, sample, record and audit together', () => {
  const before = baseState();
  const next = startLegacySample(before, assignment());
  assert.equal(next.channels[0].state, 'busy');
  assert.equal(next.channels[0].currentRecordId, 'REC-NEW');
  assert.equal(next.samples[0].status, 'running');
  assert.equal(next.samples[0].channelKey, '设备 A|001');
  assert.equal('state' in next.records[0], false);
  assert.equal(next.records[0].status, 'running');
  assert.equal(next.records[0].no, 'REQ-001');
  assert.equal(next.auditLogs[0].id, 'AUDIT-NEW');
  assert.equal(before.channels[0].state, 'free');
  assert.equal(before.records.length, 0);
});

test('fault channel, duplicate queue and busy channel without expected end are hard blockers', () => {
  const cases = [
    [baseState({ channels: [channel({ state: 'fault' })] }), 'CHANNEL_FAULT'],
    [baseState({
      channels: [channel({ state: 'busy', end: at(12), nextRecordId: 'REC-QUEUE' })],
      records: [usageRecord(), usageRecord({ id: 'REC-QUEUE', status: 'reserved', state: '已预约', sampleId: 'REQ-001.002', start: at(13), end: at(15) })]
    }), 'CHANNEL_ALREADY_QUEUED'],
    [baseState({
      channels: [channel({ state: 'busy', end: null, currentRecordId: 'REC-CURRENT' })],
      records: [usageRecord({ end: '' })]
    }), 'BUSY_CHANNEL_END_REQUIRED']
  ];
  for (const [before, code] of cases) {
    const snapshot = structuredClone(before);
    assert.throws(() => reserveLegacySample(before, assignment()), error => error.code === code);
    assert.deepEqual(before, snapshot);
  }
});

test('busy-channel overlap requires WARNING confirmation while adjacent intervals do not', () => {
  const current = usageRecord({ end: at(12) });
  const before = baseState({
    channels: [channel({ state: 'busy', start: at(8), end: at(12), currentRecordId: current.id })],
    records: [current]
  });
  const snapshot = structuredClone(before);

  assert.throws(
    () => reserveLegacySample(before, assignment({ start: at(11), end: at(13) })),
    error => error.code === 'WARNING_CONFIRMATION_REQUIRED'
  );
  assert.deepEqual(before, snapshot);

  const accepted = reserveLegacySample(before, assignment({
    start: at(11), end: at(13), acceptWarning: true
  }));
  assert.equal(accepted.channels[0].state, 'busy');
  assert.equal(accepted.channels[0].nextRecordId, 'REC-NEW');
  assert.equal('state' in accepted.records.find(item => item.id === 'REC-NEW'), false);
  assert.equal(accepted.auditLogs[0].level, 'warning');

  const adjacent = reserveLegacySample(before, assignment({ start: at(12), end: at(14) }));
  assert.equal(adjacent.records.find(item => item.id === 'REC-NEW').status, 'reserved');
});

test('ending a running record preserves the queued reservation and books the channel', () => {
  const running = usageRecord();
  const queued = usageRecord({
    id: 'REC-QUEUE',
    sampleId: 'REQ-001.002',
    status: 'reserved',
    state: '已预约',
    start: at(12),
    end: at(15),
    project: '排队项目'
  });
  const before = baseState({
    requests: [{ id: 'REQ-001', qty: 2, project: '项目 A', test: '循环测试' }],
    samples: [
      sample('REQ-001.001', { status: 'running', hasHistory: true, channelKey: '设备 A|001' }),
      sample('REQ-001.002', { status: 'reserved', hasHistory: true, channelKey: '设备 A|001' })
    ],
    channels: [channel({
      state: 'busy',
      currentRecordId: running.id,
      nextRecordId: queued.id,
      start: running.start,
      end: running.end
    })],
    records: [running, queued]
  });

  const next = transitionLegacyChannel(before, transition('end'));
  assert.equal(next.channels[0].state, 'booked');
  assert.equal(next.channels[0].currentRecordId, '');
  assert.equal(next.channels[0].nextRecordId, 'REC-QUEUE');
  assert.equal('state' in next.records.find(item => item.id === running.id), false);
  assert.equal('state' in next.records.find(item => item.id === queued.id), false);
  assert.equal(next.samples.find(item => item.id === running.sampleId).status, 'completed');
  assert.equal(next.samples.find(item => item.id === queued.sampleId).status, 'reserved');
});

test('a booked channel starts its queued record and clears the queue pointer', () => {
  const queued = usageRecord({ status: 'reserved', state: '已预约', start: at(14), end: at(16) });
  const before = baseState({
    samples: [sample(undefined, { status: 'reserved', hasHistory: true, channelKey: '设备 A|001' })],
    channels: [channel({ state: 'booked', nextRecordId: queued.id, end: queued.end })],
    records: [queued]
  });
  const next = transitionLegacyChannel(before, transition('start'));
  assert.equal(next.channels[0].state, 'busy');
  assert.equal(next.channels[0].currentRecordId, queued.id);
  assert.equal(next.channels[0].nextRecordId, '');
  assert.equal('state' in next.records[0], false);
  assert.equal(next.records[0].status, 'running');
  assert.equal(next.samples[0].status, 'running');
});

test('cancelling a booked channel cancels its queued record and sample then releases the channel', () => {
  const queued = usageRecord({ status: 'reserved', state: '已预约', start: at(14), end: at(16) });
  const before = baseState({
    samples: [sample(undefined, { status: 'reserved', hasHistory: true, channelKey: '设备 A|001' })],
    channels: [channel({ state: 'booked', nextRecordId: queued.id, end: queued.end })],
    records: [queued]
  });

  const next = transitionLegacyChannel(before, transition('cancel'));

  assert.equal(next.channels[0].state, 'free');
  assert.equal(next.channels[0].currentRecordId, '');
  assert.equal(next.channels[0].nextRecordId, '');
  assert.equal('state' in next.records[0], false);
  assert.equal(next.records[0].status, 'cancelled');
  assert.equal(next.records[0].cancelledAt, at(13));
  assert.equal(next.samples[0].status, 'cancelled');
  assert.equal(next.samples[0].end, at(13));
  assert.equal(next.auditLogs[0].action, '取消预约');
  assert.equal(before.channels[0].state, 'booked');
  assert.equal(before.samples[0].status, 'reserved');
  assert.equal(before.records[0].status, 'reserved');
});

test('end, start and cancel reject broken record-channel-sample-request ownership atomically', () => {
  const running = usageRecord();
  const busy = baseState({
    samples: [sample(undefined, { status: 'running', hasHistory: true, channelKey: '设备 A|001' })],
    channels: [channel({ state: 'busy', currentRecordId: running.id, end: running.end })],
    records: [running]
  });
  const reserved = usageRecord({ status: 'reserved', state: '已预约', start: at(14), end: at(16) });
  const booked = baseState({
    samples: [sample(undefined, { status: 'reserved', hasHistory: true, channelKey: '设备 A|001' })],
    channels: [channel({ state: 'booked', nextRecordId: reserved.id, end: reserved.end })],
    records: [reserved]
  });
  const cases = [
    ['end-record-channel', busy, input => { input.records[0].channelKey = '设备 A|999'; input.records[0].keys = ['设备 A|999']; }],
    ['end-sample-status', busy, input => { input.samples[0].status = 'reserved'; }],
    ['end-sample-channel', busy, input => { input.samples[0].channelKey = '设备 A|999'; }],
    ['end-request', busy, input => { input.records[0].requestNo = 'REQ-MISSING'; input.records[0].no = 'REQ-MISSING'; }],
    ['end-current-pointer', busy, input => { input.channels[0].currentRecordId = ''; }],
    ['end-duplicate-owner', busy, input => { input.records.push({ ...input.records[0], id: 'REC-OTHER' }); }],
    ['start-sample-status', booked, input => { input.samples[0].status = 'pending'; }],
    ['start-next-pointer', booked, input => { input.channels[0].nextRecordId = ''; }],
    ['cancel-sample-request', booked, input => { input.samples[0].requestNo = 'REQ-MISSING'; }],
    ['cancel-current-pointer', booked, input => { input.channels[0].currentRecordId = 'REC-GHOST'; }]
  ];

  for (const [label, source, mutate] of cases) {
    const input = structuredClone(source);
    mutate(input);
    const snapshot = structuredClone(input);
    const action = label.split('-')[0];
    assert.throws(
      () => transitionLegacyChannel(input, transition(action, { auditId: `AUDIT-${label}` })),
      error => ['RUNNING_RECORD_INVALID', 'QUEUED_RECORD_INVALID'].includes(error.code),
      label
    );
    assert.deepEqual(input, snapshot, label);
  }
});

for (const [action, status, pointerField, errorCode] of [
  ['end', 'running', 'currentRecordId', 'RUNNING_RECORD_INVALID'],
  ['start', 'reserved', 'nextRecordId', 'QUEUED_RECORD_INVALID'],
  ['cancel', 'reserved', 'nextRecordId', 'QUEUED_RECORD_INVALID']
]) {
  test(`${action} rejects a cross-channel active record sharing the selected sample atomically`, () => {
    const selected = usageRecord({
      status,
      state: status === 'running' ? '测试中' : '已预约',
      start: status === 'running' ? at(8) : at(14),
      end: status === 'running' ? at(12) : at(16)
    });
    const duplicate = usageRecord({
      id: `REC-CROSS-${action.toUpperCase()}`,
      channelKey: '设备 A|002',
      keys: ['设备 A|002'],
      status,
      state: status === 'running' ? '测试中' : '已预约',
      start: selected.start,
      end: selected.end
    });
    const input = baseState({
      samples: [sample(undefined, { status, hasHistory: true, channelKey: '设备 A|001' })],
      channels: [
        channel({
          state: status === 'running' ? 'busy' : 'booked',
          [pointerField]: selected.id,
          end: selected.end
        }),
        channel({
          key: '设备 A|002',
          name: '002',
          state: status === 'running' ? 'busy' : 'booked',
          [pointerField]: duplicate.id,
          end: duplicate.end
        })
      ],
      records: [selected, duplicate]
    });
    const snapshot = structuredClone(input);

    assert.throws(
      () => transitionLegacyChannel(input, transition(action, { auditId: `AUDIT-CROSS-${action.toUpperCase()}` })),
      error => error.code === errorCode
    );
    assert.deepEqual(input, snapshot);
  });
}

test('extend and fault recovery enforce legal transitions without mutating rejected inputs', () => {
  const running = usageRecord();
  const busy = baseState({
    samples: [sample(undefined, { status: 'running', hasHistory: true, channelKey: '设备 A|001' })],
    channels: [channel({ state: 'busy', currentRecordId: running.id, end: at(12) })],
    records: [running]
  });
  const extended = transitionLegacyChannel(busy, transition('extend', { hours: 24 }));
  assert.equal(extended.channels[0].end, '2026-08-21T19:00:00.000Z');
  assert.equal(extended.records[0].end, extended.channels[0].end);

  const busySnapshot = structuredClone(busy);
  assert.throws(
    () => transitionLegacyChannel(busy, transition('fault')),
    error => error.code === 'ACTIVE_CHANNEL_FAULT_BLOCKED'
  );
  assert.deepEqual(busy, busySnapshot);

  const faulted = transitionLegacyChannel(baseState(), transition('fault'));
  assert.equal(faulted.channels[0].state, 'fault');
  const recovered = transitionLegacyChannel(faulted, transition('recover', { auditId: 'AUDIT-RECOVER' }));
  assert.equal(recovered.channels[0].state, 'free');
});
