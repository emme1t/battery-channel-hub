import test from 'node:test';
import assert from 'node:assert/strict';

import {
  channelCandidates,
  requestPage,
  samplePage
} from '../src/renderer/reservation-view-model.mjs';
import { makeProductionScaleState } from './fixtures/production-scale.mjs';
import {
  makeChannel,
  makeRequest,
  makeSample,
  makeState
} from './fixtures/state-fixtures.mjs';

function makeStateWithSamples(count) {
  const request = makeRequest({ requestNo: 'R-999', quantity: count });
  const samples = Array.from({ length: count }, (_, index) =>
    makeSample({
      id: `R-999.${String(index + 1).padStart(3, '0')}`,
      requestNo: 'R-999',
      ordinal: index + 1
    })
  );
  return makeState({ requests: [request], samples });
}

test('sample page never returns more than 25 rows for 999 samples', () => {
  const result = samplePage(makeStateWithSamples(999), 'R-999', 1);

  assert.equal(result.items.length, 25);
  assert.equal(result.total, 999);
  assert.equal(result.pageCount, 40);
  assert.equal(result.items[0].id, 'R-999.001');
  assert.equal(result.items[24].id, 'R-999.025');
});

test('sample page clamps page numbers and preserves ordinal order', () => {
  const state = makeStateWithSamples(30);
  state.samples.reverse();

  const result = samplePage(state, 'R-999', 99);

  assert.equal(result.page, 2);
  assert.deepEqual(result.items.map((sample) => sample.ordinal), [26, 27, 28, 29, 30]);
});

test('request page caps rows at 50 and derives pending counts', () => {
  const state = makeProductionScaleState({ requestCount: 100, channelCount: 529, auditCount: 2000 });
  state.samples.find((sample) => sample.requestNo === 'R-0001').status = 'running';

  const result = requestPage(state, { text: '生产项目', page: 1, pageSize: 999 });

  assert.equal(result.items.length, 50);
  assert.equal(result.total, 100);
  assert.equal(result.items[0].quantity, 999);
  assert.equal(result.items[0].pendingCount, 998);
});

test('request filters combine text and pending-only conditions without mutation', () => {
  const state = makeState({
    requests: [
      makeRequest({ requestNo: 'A-中文', project: '无人机平台', quantity: 1 }),
      makeRequest({ requestNo: 'B-02', project: '储能平台', quantity: 1 })
    ],
    samples: [
      makeSample({ id: 'A-中文.001', requestNo: 'A-中文', status: 'pending' }),
      makeSample({ id: 'B-02.001', requestNo: 'B-02', status: 'completed', hasHistory: true })
    ]
  });
  const snapshot = structuredClone(state);

  const result = requestPage(state, { text: '无人机', pendingOnly: true, page: 1, pageSize: 50 });

  assert.deepEqual(result.items.map((request) => request.requestNo), ['A-中文']);
  assert.deepEqual(state, snapshot);
});

test('candidate search returns at most 40 shared results for 529 channels', () => {
  const state = makeProductionScaleState({ requestCount: 100, channelCount: 529, auditCount: 2000 });
  const result = channelCandidates(state, { mode: 'reserve', text: '', limit: 999 });

  assert.equal(result.items.length, 40);
  assert.equal(result.total, 529);
  assert.equal(result.hasMore, true);
  assert.equal(new Set(result.items.map((channel) => channel.key)).size, 40);
});

test('candidate filters are AND-composed and mode-aware', () => {
  const state = makeState({
    channels: [
      makeChannel({ key: 'D1|001', deviceId: 'D1', deviceName: '设备甲', name: '001', state: 'free', spec: '100A' }),
      makeChannel({ key: 'D1|002', deviceId: 'D1', deviceName: '设备甲', name: '002', state: 'busy', end: '2026-08-20T12:00:00-07:00', spec: '100A' }),
      makeChannel({ key: 'D2|001', deviceId: 'D2', deviceName: '设备乙', name: '001', state: 'free', spec: '20A' }),
      makeChannel({ key: 'D1|003', deviceId: 'D1', deviceName: '设备甲', name: '003', state: 'fault', spec: '100A' })
    ]
  });

  const start = channelCandidates(state, { mode: 'start', deviceId: 'D1', text: '100A' });
  const reserve = channelCandidates(state, { mode: 'reserve', deviceId: 'D1', text: '100A' });

  assert.deepEqual(start.items.map((channel) => channel.key), ['D1|001']);
  assert.deepEqual(reserve.items.map((channel) => channel.key), ['D1|001', 'D1|002']);
});

test('candidate query handles special characters as text and never mutates channels', () => {
  const state = makeState({
    channels: [makeChannel({ key: "设备 1%|通道'01", deviceName: '设备 1%', name: "通道'01" })]
  });
  const snapshot = structuredClone(state);

  const result = channelCandidates(state, { mode: 'start', text: "1% 通道'01" });

  assert.deepEqual(result.items.map((channel) => channel.key), ["设备 1%|通道'01"]);
  assert.deepEqual(state, snapshot);
});
