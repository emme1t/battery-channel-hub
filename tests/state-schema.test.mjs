import test from 'node:test';
import assert from 'node:assert/strict';

import {
  assertValidState,
  createEmptyState,
  summarizeState,
  validateState
} from '../src/domain/state-schema.mjs';

function validState(overrides = {}) {
  return {
    schemaVersion: 2,
    dataRevision: 0,
    username: '测试员',
    requests: [{ requestNo: 'R-001', quantity: 1 }],
    samples: [{ id: 'R-001.001', requestNo: 'R-001', ordinal: 1, status: 'running', channelKey: 'D-001|1' }],
    devices: [{ id: 'D-001', name: '设备 A' }],
    channels: [{ key: 'D-001|1', deviceId: 'D-001', name: '1', state: 'busy', currentRecordId: 'REC-001' }],
    records: [{ id: 'REC-001', requestNo: 'R-001', sampleId: 'R-001.001', channelKey: 'D-001|1', status: 'running' }],
    audits: [{ id: 'AUD-001', action: 'start-sample', result: 'success' }],
    requestSourceRows: [],
    ...structuredClone(overrides)
  };
}

test('empty schema v2 state contains every required collection', () => {
  assert.deepEqual(createEmptyState(), {
    schemaVersion: 2,
    dataRevision: 0,
    username: '',
    requests: [],
    samples: [],
    devices: [],
    channels: [],
    records: [],
    audits: [],
    requestSourceRows: []
  });
});

test('a referentially consistent schema v2 state is accepted and summarized', () => {
  const state = validState();
  const result = validateState(state);

  assert.equal(result.ok, true);
  assert.deepEqual(result.blockers, []);
  assert.deepEqual(result.summary, {
    revision: 0,
    requests: 1,
    samples: 1,
    devices: 1,
    channels: 1,
    records: 1,
    audits: 1,
    requestSourceRows: 0
  });
  assert.deepEqual(summarizeState(state), result.summary);
});

test('duplicate identifiers and unknown references are blockers without mutation', () => {
  const state = validState({
    samples: [
      { id: 'R-001.001', requestNo: 'MISSING', ordinal: 1, status: 'pending' },
      { id: 'R-001.001', requestNo: 'R-001', ordinal: 1, status: 'pending' }
    ],
    channels: [
      { key: 'D-001|1', deviceId: 'D-001', name: '1', state: 'free' },
      { key: 'D-001|1', deviceId: 'UNKNOWN', name: '2', state: 'free' }
    ],
    records: []
  });
  const before = structuredClone(state);

  const result = validateState(state);

  assert.equal(result.ok, false);
  assert.match(result.blockers.join('\n'), /duplicate sample id R-001\.001/i);
  assert.match(result.blockers.join('\n'), /duplicate channel key D-001\|1/i);
  assert.match(result.blockers.join('\n'), /sample R-001\.001 references missing request MISSING/i);
  assert.match(result.blockers.join('\n'), /channel D-001\|1 references missing device UNKNOWN/i);
  assert.deepEqual(state, before);
});

test('record ownership and active channel collisions are blocked', () => {
  const state = validState({
    samples: [
      { id: 'R-001.001', requestNo: 'R-001', ordinal: 1, status: 'running' },
      { id: 'R-001.002', requestNo: 'R-001', ordinal: 2, status: 'running' }
    ],
    records: [
      { id: 'REC-001', requestNo: 'R-001', sampleId: 'R-001.001', channelKey: 'D-001|1', status: 'running' },
      { id: 'REC-002', requestNo: 'R-001', sampleId: 'R-001.002', channelKey: 'D-001|1', status: 'running' },
      { id: 'REC-003', requestNo: 'MISSING', sampleId: 'R-001.001', channelKey: 'UNKNOWN', status: 'completed' }
    ]
  });

  const result = validateState(state);

  assert.equal(result.ok, false);
  assert.match(result.blockers.join('\n'), /multiple active records/i);
  assert.match(result.blockers.join('\n'), /record REC-003 references missing request MISSING/i);
  assert.match(result.blockers.join('\n'), /record REC-003 references missing channel UNKNOWN/i);
});

test('malformed top-level shape, revision and unsupported statuses are blocked', () => {
  const state = validState({
    schemaVersion: 1,
    dataRevision: -1,
    requests: {},
    samples: [{ id: 'R-001.001', requestNo: 'R-001', ordinal: 0, status: 'mystery' }],
    channels: [{ key: 'D-001|1', deviceId: 'D-001', name: '1', state: 'mystery' }],
    records: []
  });

  const result = validateState(state);

  assert.equal(result.ok, false);
  assert.match(result.blockers.join('\n'), /schemaVersion must equal 2/);
  assert.match(result.blockers.join('\n'), /dataRevision must be a non-negative integer/);
  assert.match(result.blockers.join('\n'), /requests must be an array/);
  assert.match(result.blockers.join('\n'), /sample ordinal must be an integer from 1 to 999/i);
  assert.match(result.blockers.join('\n'), /unsupported sample status mystery/i);
  assert.match(result.blockers.join('\n'), /unsupported channel state mystery/i);
});

test('assertValidState returns an isolated clone and exposes structured blockers', () => {
  const state = validState();
  const clone = assertValidState(state);
  clone.username = '另一个用户';
  assert.equal(state.username, '测试员');

  assert.throws(
    () => assertValidState({}),
    (error) => error.code === 'INVALID_VNEXT_STATE' && Array.isArray(error.blockers) && error.blockers.length > 0
  );
});
