import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

import {
  auditPage,
  deviceChannelPage,
  recordPage,
  renderBoardView
} from '../src/renderer/legacy-list-selectors.mjs';
import {
  renderRunningSampleWorkbench,
  renderStorageSampleWorkbench,
  runningSamplePage,
  storageSamplePage
} from '../src/renderer/legacy-storage-workbench.mjs';

const require = createRequire(import.meta.url);
const preset = require('../lib/device-preset.js');

function productionState() {
  return {
    deviceProfiles: preset.devices(),
    channels: preset.channels(),
    records: Array.from({ length: 2000 }, (_, index) => ({
      id: `REC-${index + 1}`, no: `REQ-${index + 1}`, project: `项目 ${index + 1}`,
      state: index % 3 === 0 ? '测试中' : '已结束', time: `2026-08-20 ${String(index % 24).padStart(2, '0')}:00`,
      end: '', user: '测试员', keys: []
    })),
    auditLogs: Array.from({ length: 2000 }, (_, index) => ({
      id: `AUDIT-${index + 1}`, time: `2026-08-20 ${String(index % 24).padStart(2, '0')}:00`,
      user: '测试员', action: `操作 ${index + 1}`, target: '对象', level: index % 5 === 0 ? 'warning' : 'normal'
    }))
  };
}

function count(html, testId) {
  return (html.match(new RegExp(`data-testid="${testId}"`, 'g')) || []).length;
}

test('collapsed dashboard renders 26 device summaries without 529 channel cards', () => {
  const state = productionState();
  const html = renderBoardView(state, { expandedDevices: [] });
  assert.equal(count(html, 'bounded-board-device'), 26);
  assert.equal(count(html, 'bounded-channel-card'), 0);
  assert.equal(html.includes('data-device="'), true);
});

test('one expanded device renders only that device channels and escapes visible content', () => {
  const state = productionState();
  const firstDevice = state.deviceProfiles[0].name;
  const expected = state.channels.filter(item => item.device === firstDevice).length;
  state.channels.find(item => item.device === firstDevice).project = '<script>危险</script>';
  const html = renderBoardView(state, { expandedDevices: [firstDevice] });
  assert.equal(count(html, 'bounded-board-device'), 26);
  assert.equal(count(html, 'bounded-channel-card'), expected);
  assert.equal(html.includes('<script>危险</script>'), false);
  assert.equal(html.includes('&lt;script&gt;危险&lt;/script&gt;'), true);
});

test('busy channel card shows its running sample and exposes test management', () => {
  const state = productionState();
  const channel = state.channels[0];
  channel.state = 'busy';
  channel.currentRecordId = 'REC-RUNNING';
  channel.project = '进行中项目';
  state.records.push({
    id: 'REC-RUNNING', requestNo: 'REQ-ACTIVE-001', sampleId: 'REQ-ACTIVE-001.026',
    status: 'running', state: '测试中', channelKey: channel.key, keys: [channel.key]
  });

  const html = renderBoardView(state, { expandedDevices: [channel.device] });

  assert.match(html, /样品：REQ-ACTIVE-001\.026/);
  assert.match(html, /data-bounded-action="manage-running"/);
  assert.equal(html.includes(`data-channel-key="${encodeURIComponent(channel.key)}"`), true);
});

test('device, record and audit selectors cap every page at 50 and clamp page numbers', () => {
  const state = productionState();
  const snapshot = structuredClone(state);
  const channels = deviceChannelPage(state, { page: 999 });
  const records = recordPage(state, { page: 999 });
  const audits = auditPage(state, { page: 999 });
  assert.ok(channels.items.length <= 50);
  assert.ok(records.items.length <= 50);
  assert.ok(audits.items.length <= 50);
  assert.equal(channels.total, 529);
  assert.equal(records.total, 2000);
  assert.equal(audits.total, 2000);
  assert.equal(channels.page, channels.pageCount);
  assert.equal(records.page, records.pageCount);
  assert.equal(audits.page, audits.pageCount);
  assert.deepEqual(state, snapshot);
});

test('record and audit text filters compose with state and risk filters', () => {
  const state = productionState();
  const records = recordPage(state, { text: '项目 1999', state: '测试中' });
  assert.ok(records.items.every(item => item.state === '测试中'));
  assert.ok(records.items.every(item => JSON.stringify(item).includes('项目 1999')));

  const audits = auditPage(state, { text: '操作 1996', level: 'warning' });
  assert.ok(audits.items.every(item => item.level === 'warning'));
  assert.ok(audits.items.every(item => JSON.stringify(item).includes('操作 1996')));
});

test('sample workbench render stays bounded to 10 rows at all supported laptop viewports', () => {
  const state = productionState();
  state.records = Array.from({ length: 75 }, (_, index) => ({
    id: `RUN-${index + 1}`, requestNo: `REQ-${index + 1}`, sampleId: `REQ-${index + 1}.001`,
    status: 'running', channelKey: `设备|${index + 1}`, project: `项目 ${index + 1}`
  }));
  state.storageRecords = Array.from({ length: 75 }, (_, index) => ({
    id: `STO-${index + 1}`, requestNo: `REQ-${index + 1}`, sampleIds: [`REQ-${index + 1}.001`],
    status: index < 50 ? 'storing' : 'completed', tester: '测试员'
  }));

  for (const viewport of [
    { width: 1366, height: 768 },
    { width: 1440, height: 900 },
    { width: 1536, height: 864 }
  ]) {
    const runningHtml = renderRunningSampleWorkbench(runningSamplePage(state, { page: 1 }), viewport);
    const storageHtml = renderStorageSampleWorkbench(storageSamplePage(state, { page: 1 }), viewport);
    assert.equal(count(runningHtml, 'running-sample-row'), 10);
    assert.equal(count(storageHtml, 'storage-sample-row'), 10);
    assert.match(runningHtml, /class="sample-workbench-table"/);
    assert.match(storageHtml, /class="sample-workbench-table"/);
    assert.equal(runningHtml.includes('min-width:'), false);
    assert.equal(storageHtml.includes('min-width:'), false);
  }
});
