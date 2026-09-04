import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

import {
  channelCandidates,
  recordPage,
  requestPage,
  samplePage
} from '../src/renderer/legacy-list-selectors.mjs';

const require = createRequire(import.meta.url);
const preset = require('../lib/device-preset.js');

function scaleState() {
  const requests = Array.from({ length: 100 }, (_, index) => ({
    id: `REQ-${String(index + 1).padStart(3, '0')}`,
    qty: index === 0 ? 999 : 1,
    test: index % 2 === 0 ? '循环测试' : '倍率测试',
    project: index % 2 === 0 ? '无人机项目' : '储能项目',
    sample: index === 0 ? '35Ah [A+B]' : '50Ah',
    client: `委托人 ${index + 1}`,
    tester: index % 3 === 0 ? '测试员 A' : '测试员 B',
    status: '待安排'
  }));
  const samples = [
    ...Array.from({ length: 999 }, (_, index) => ({
      id: `REQ-001.${String(index + 1).padStart(3, '0')}`,
      requestNo: 'REQ-001',
      ordinal: index + 1,
      status: index < 5 ? 'running' : 'pending',
      channelKey: '',
      start: '',
      end: '',
      hasHistory: index < 5
    })),
    ...requests.slice(1).map(request => ({
      id: `${request.id}.001`, requestNo: request.id, ordinal: 1, status: 'pending',
      channelKey: '', start: '', end: '', hasHistory: false
    }))
  ];
  return {
    requests,
    samples,
    channels: preset.channels(),
    deviceProfiles: preset.devices(),
    records: []
  };
}

test('legacy request, sample and channel selectors enforce 50/25/40 result caps', () => {
  const state = scaleState();
  const requests = requestPage(state, {});
  const samples = samplePage(state, 'REQ-001', 1);
  const channels = channelCandidates(state, {});

  assert.equal(requests.items.length, 50);
  assert.equal(requests.total, 100);
  assert.equal(samples.items.length, 25);
  assert.equal(samples.total, 999);
  assert.equal(channels.items.length, 40);
  assert.equal(channels.total, 529);
  assert.equal(channels.hasMore, true);
  assert.equal(channels.page, 1);
  assert.equal(channels.pageCount, 14);
  assert.equal(requests.items[0].requestNo, 'REQ-001');
  assert.equal(requests.items[0].quantity, 999);
  assert.equal(requests.items[0].pendingCount, 994);
});

test('all 529 eligible channels remain reachable through bounded non-overlapping pages', () => {
  const state = scaleState();
  const pages = Array.from({ length: 14 }, (_, index) => channelCandidates(state, {
    mode: 'reserve',
    page: index + 1
  }));
  const keys = pages.flatMap(page => page.items.map(channel => channel.key));

  assert.equal(keys.length, 529);
  assert.equal(new Set(keys).size, 529);
  assert.equal(pages.at(-1).items.length, 9);
  assert.equal(pages.at(-1).page, 14);
  assert.equal(pages.at(-1).hasMore, false);
});

test('request filters combine text and pending-only and clamp page numbers', () => {
  const state = scaleState();
  state.samples = state.samples.map(item => item.requestNo === 'REQ-002'
    ? { ...item, status: 'completed', hasHistory: true }
    : item);

  const filtered = requestPage(state, {
    text: '储能 测试员', pendingOnly: true, page: 999, pageSize: 10
  });
  assert.ok(filtered.items.every(item => item.project === '储能项目'));
  assert.ok(filtered.items.every(item => item.pendingCount > 0));
  assert.equal(filtered.page, filtered.pageCount);
  assert.ok(filtered.items.every(item => item.requestNo !== 'REQ-002'));
});

test('sample selector sorts by ordinal, caps pages and leaves source collections unchanged', () => {
  const state = scaleState();
  state.samples = [...state.samples].reverse();
  const snapshot = structuredClone(state);
  const page = samplePage(state, 'REQ-001', 999);
  assert.equal(page.page, page.pageCount);
  assert.equal(page.items.at(-1).id, 'REQ-001.999');
  assert.ok(page.items.length <= 25);
  assert.deepEqual(state, snapshot);
});

test('channel filters are AND-composed, mode-aware and treat special characters as text', () => {
  const state = scaleState();
  const target = state.channels.find(item => item.device && item.name);
  const snapshot = structuredClone(state);
  const filtered = channelCandidates(state, {
    device: target.device,
    text: `${target.device} ${target.name}`,
    mode: 'start',
    limit: 1000
  });
  assert.ok(filtered.items.length >= 1);
  assert.ok(filtered.items.length <= 40);
  assert.ok(filtered.items.every(item => item.device === target.device));
  assert.ok(filtered.items.every(item => item.state === 'free'));

  const special = channelCandidates(state, { text: '[A+B] (不存在)?', mode: 'reserve' });
  assert.equal(special.items.length, 0);
  assert.deepEqual(state, snapshot);
});

test('busy channel eligibility uses legacy records and blocks an existing queue', () => {
  const state = scaleState();
  const target = state.channels[0];
  target.state = 'busy';
  target.start = '2026-08-20T08:00:00-07:00';
  target.end = '2026-08-20T12:00:00-07:00';
  state.records = [{
    id: 'REC-CURRENT', no: 'REQ-001', channelKey: target.key, keys: [target.key],
    state: '测试中', status: 'running', start: target.start, time: target.start, end: target.end
  }];

  const available = channelCandidates(state, { text: target.key, mode: 'reserve' });
  assert.equal(available.items.some(item => item.key === target.key), true);

  state.records.push({
    id: 'REC-QUEUE', no: 'REQ-002', channelKey: target.key, keys: [target.key],
    state: '已预约', status: 'reserved', start: '2026-08-20T12:00:00-07:00', end: '2026-08-20T15:00:00-07:00'
  });
  const blocked = channelCandidates(state, { text: target.key, mode: 'reserve' });
  assert.equal(blocked.items.some(item => item.key === target.key), false);
});

test('request identifiers use trimmed case-insensitive equality while ordinary fields keep contains matching', () => {
  const state = scaleState();
  state.requests[1].project = '项目说明包含 REQ-001 但不是该申请';
  state.requests[2].project = '精确搜索演示项目';

  const exact = requestPage(state, { text: '  req-001  ' });
  assert.deepEqual(exact.items.map(item => item.requestNo), ['REQ-001']);

  state.requests[1].project = '储能项目';
  const partialIdentifier = requestPage(state, { text: 'REQ-00' });
  assert.equal(partialIdentifier.items.length, 0);

  const ordinaryContains = requestPage(state, { text: '搜索演示' });
  assert.deepEqual(ordinaryContains.items.map(item => item.requestNo), ['REQ-003']);
});

test('record request and child sample identifiers are exact and take priority over text contains', () => {
  const state = scaleState();
  state.records = [
    { id: 'REC-1', requestNo: 'REQ-001', sampleId: 'REQ-001.001', status: 'running', project: '目标项目' },
    { id: 'REC-2', requestNo: 'REQ-010', sampleId: 'REQ-010.001', status: 'running', project: '说明包含 REQ-001.001' },
    { id: 'REC-3', requestNo: 'REQ-020', sampleId: 'REQ-020.001', status: 'completed', project: '普通关键字项目' }
  ];

  assert.deepEqual(recordPage(state, { text: ' req-001 ' }).items.map(item => item.id), ['REC-1']);
  assert.deepEqual(recordPage(state, { text: ' REQ-001.001 ' }).items.map(item => item.id), ['REC-1']);
  state.records[1].project = '其它说明';
  assert.equal(recordPage(state, { text: 'REQ-00' }).items.length, 0);
  assert.deepEqual(recordPage(state, { text: '关键字' }).items.map(item => item.id), ['REC-3']);
});
