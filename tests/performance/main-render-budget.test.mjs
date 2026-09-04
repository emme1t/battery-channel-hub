import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { performance } from 'node:perf_hooks';
import test from 'node:test';

import {
  auditPage,
  channelCandidates,
  deviceChannelPage,
  recordPage,
  renderBoardView,
  requestPage,
  samplePage
} from '../../src/renderer/legacy-list-selectors.mjs';
import {
  createLegacyReservationUiState,
  renderLegacyReservationWorkspace,
  selectLegacyRequest
} from '../../src/renderer/legacy-reservation-workspace.mjs';

const require = createRequire(import.meta.url);
const preset = require('../../lib/device-preset.js');

function productionState() {
  const requests = Array.from({ length: 100 }, (_, index) => ({
    id: `REQ-${String(index + 1).padStart(3, '0')}`,
    qty: index === 0 ? 999 : 1,
    test: '循环测试', project: `项目 ${index + 1}`, sample: '35Ah',
    client: `委托人 ${index + 1}`, tester: '测试员'
  }));
  return {
    revision: 1,
    username: '性能测试员',
    requests,
    samples: [
      ...Array.from({ length: 999 }, (_, index) => ({
        id: `REQ-001.${String(index + 1).padStart(3, '0')}`,
        requestNo: 'REQ-001', ordinal: index + 1, status: 'pending',
        channelKey: '', start: '', end: '', hasHistory: false
      })),
      ...requests.slice(1).map(request => ({
        id: `${request.id}.001`, requestNo: request.id, ordinal: 1, status: 'pending',
        channelKey: '', start: '', end: '', hasHistory: false
      }))
    ],
    deviceProfiles: preset.devices(),
    channels: preset.channels(),
    records: Array.from({ length: 2000 }, (_, index) => ({
      id: `REC-${index}`, no: `REQ-${index}`, project: `项目 ${index}`,
      state: '已结束', time: '2026-08-20 10:00', end: '2026-08-20 12:00', user: '测试员'
    })),
    auditLogs: Array.from({ length: 2000 }, (_, index) => ({
      id: `AUDIT-${index}`, time: '2026-08-20 10:00', user: '测试员',
      action: `操作 ${index}`, target: `对象 ${index}`, level: index % 5 === 0 ? 'warning' : 'normal'
    }))
  };
}

function count(html, marker) {
  return (html.match(new RegExp(`data-testid="${marker}"`, 'g')) || []).length;
}

test('production-scale legacy selectors stay below 300 ms per combined pass', t => {
  const state = productionState();
  const timings = [];
  for (let index = 0; index < 20; index += 1) {
    const started = performance.now();
    requestPage(state, { text: index % 2 ? '项目' : '', page: index + 1 });
    samplePage(state, 'REQ-001', index + 1);
    channelCandidates(state, { text: index % 2 ? '新威' : '', mode: 'reserve' });
    deviceChannelPage(state, { page: index + 1 });
    recordPage(state, { text: '项目', page: index + 1 });
    auditPage(state, { level: 'warning', page: index + 1 });
    timings.push(performance.now() - started);
  }
  const maximum = Math.max(...timings);
  const average = timings.reduce((sum, value) => sum + value, 0) / timings.length;
  assert.ok(maximum < 300, `combined selector max ${maximum.toFixed(2)}ms`);
  t.diagnostic(`combined selectors average=${average.toFixed(2)}ms max=${maximum.toFixed(2)}ms`);
});

test('reservation workspace keeps 50/25/40 DOM budgets at production scale', t => {
  const state = productionState();
  const closed = renderLegacyReservationWorkspace(state, createLegacyReservationUiState());
  assert.equal(count(closed, 'legacy-request-row'), 50);
  assert.equal(count(closed, 'legacy-sample-row'), 0);
  assert.equal(count(closed, 'legacy-channel-option'), 0);

  const open = selectLegacyRequest(createLegacyReservationUiState(), 'REQ-001');
  open.channelPickerSampleId = 'REQ-001.001';
  const started = performance.now();
  const html = renderLegacyReservationWorkspace(state, open);
  const elapsed = performance.now() - started;
  assert.equal(count(html, 'legacy-request-row'), 50);
  assert.equal(count(html, 'legacy-sample-row'), 25);
  assert.equal(count(html, 'legacy-channel-option'), 40);
  assert.ok(elapsed < 300, `workspace render ${elapsed.toFixed(2)}ms`);
  t.diagnostic(`workspace render=${elapsed.toFixed(2)}ms bytes=${Buffer.byteLength(html)}`);
});

test('collapsed 529-channel board creates no cards and one expansion stays bounded', t => {
  const state = productionState();
  const started = performance.now();
  const collapsed = renderBoardView(state, { expandedDevices: [] });
  const collapsedElapsed = performance.now() - started;
  assert.equal(count(collapsed, 'bounded-board-device'), 26);
  assert.equal(count(collapsed, 'bounded-channel-card'), 0);

  const device = state.deviceProfiles[0].name;
  const expandedStarted = performance.now();
  const expanded = renderBoardView(state, { expandedDevices: [device] });
  const expandedElapsed = performance.now() - expandedStarted;
  assert.equal(
    count(expanded, 'bounded-channel-card'),
    state.channels.filter(channel => channel.device === device).length
  );
  assert.ok(collapsedElapsed < 300);
  assert.ok(expandedElapsed < 300);
  t.diagnostic(`board collapsed=${collapsedElapsed.toFixed(2)}ms expanded=${expandedElapsed.toFixed(2)}ms`);
});

test('all large-list page caps remain enforced', () => {
  const state = productionState();
  assert.ok(requestPage(state, {}).items.length <= 50);
  assert.ok(samplePage(state, 'REQ-001', 1).items.length <= 25);
  assert.ok(channelCandidates(state, {}).items.length <= 40);
  assert.ok(deviceChannelPage(state, {}).items.length <= 50);
  assert.ok(recordPage(state, {}).items.length <= 50);
  assert.ok(auditPage(state, {}).items.length <= 50);
});
