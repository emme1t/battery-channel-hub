import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

import {
  closeLegacyReservation,
  createLegacyReservationUiState,
  mountLegacyReservationWorkspace,
  renderLegacyReservationWorkspace,
  selectLegacyRequest,
  submitLegacyReservation
} from '../src/renderer/legacy-reservation-workspace.mjs';

const require = createRequire(import.meta.url);
const preset = require('../lib/device-preset.js');

function stateFixture() {
  return {
    revision: 7,
    username: '测试员 A',
    requests: [{
      id: 'REQ-001', qty: 30, test: '循环测试', project: '无人机项目',
      sample: '<35Ah & 特殊>', client: '委托人 A', status: '待安排'
    }],
    samples: Array.from({ length: 30 }, (_, index) => ({
      id: `REQ-001.${String(index + 1).padStart(3, '0')}`,
      requestNo: 'REQ-001', ordinal: index + 1, status: 'pending',
      channelKey: '', start: '', end: '', hasHistory: false
    })),
    channels: preset.channels(),
    deviceProfiles: preset.devices(),
    records: [],
    auditLogs: [],
    requestSourceRows: [],
    formChangeJournal: [],
    testers: [],
    savedAt: ''
  };
}

function count(html, marker) {
  return (html.match(new RegExp(`data-testid="${marker}"`, 'g')) || []).length;
}

function fakeRoot() {
  const handlers = {};
  return {
    handlers,
    innerHTML: '',
    querySelector() { return null; },
    addEventListener(type, handler) { handlers[type] = handler; },
    removeEventListener(type) { delete handlers[type]; },
    contains() { return true; },
    replaceChildren() { this.innerHTML = ''; }
  };
}

function clickAction(root, action, data = {}) {
  const target = {
    dataset: { legacyAction: action, ...data },
    disabled: false,
    closest(selector) { return selector === '[data-legacy-action]' ? this : null; }
  };
  root.handlers.click({ target });
}

async function settleWorkspaceSubmit() {
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));
}

test('default workspace renders only the full-width compressed request list', () => {
  const html = renderLegacyReservationWorkspace(stateFixture(), createLegacyReservationUiState());
  assert.equal(html.includes('data-testid="legacy-reservation-details"'), false);
  assert.equal(html.includes('data-testid="legacy-channel-picker"'), false);
  assert.equal(html.includes('计划开始'), false);
  assert.equal(html.includes('REQ-001'), true);
  assert.equal(html.includes('&lt;35Ah &amp; 特殊&gt;'), true);
});

test('selecting a request opens details with at most 25 samples and 40 channel options', () => {
  const state = stateFixture();
  let ui = selectLegacyRequest(createLegacyReservationUiState(), 'REQ-001');
  let html = renderLegacyReservationWorkspace(state, ui);
  assert.equal(html.includes('data-testid="legacy-reservation-details"'), true);
  assert.match(html, /data-testid="legacy-reservation-details"\s+data-request-no="REQ-001"/);
  assert.equal(count(html, 'legacy-sample-row'), 25);
  assert.equal(count(html, 'legacy-channel-option'), 0);

  ui = { ...ui, channelPickerSampleId: 'REQ-001.001', channelSearch: '' };
  html = renderLegacyReservationWorkspace(state, ui);
  assert.equal(html.includes('data-testid="legacy-channel-picker"'), true);
  assert.equal(count(html, 'legacy-channel-option'), 40);
  assert.equal(html.includes('data-legacy-action="channel-next"'), true);

  ui = { ...ui, channelPage: 14 };
  html = renderLegacyReservationWorkspace(state, ui);
  assert.equal(count(html, 'legacy-channel-option'), 9);
  assert.equal(html.includes('第 14 / 14 页'), true);
});

test('带有既有备注的详情为备注字段提供稳定的可访问名称', () => {
  const state = stateFixture();
  const ui = { ...selectLegacyRequest(createLegacyReservationUiState(), 'REQ-001'), note: 'chaos 2' };
  const html = renderLegacyReservationWorkspace(state, ui);
  assert.match(html, /<textarea[^>]*data-legacy-action="note"[^>]*aria-label="备注"[^>]*>chaos 2<\/textarea>/);
});

test('closing details preserves request search, pending filter and pagination context', () => {
  const original = createLegacyReservationUiState({
    searchText: '无人机', pendingOnly: true, requestPage: 2
  });
  const selected = selectLegacyRequest(original, 'REQ-001');
  const closed = closeLegacyReservation(selected);
  assert.equal(closed.detailsOpen, false);
  assert.equal(closed.selectedRequestNo, null);
  assert.equal(closed.searchText, '无人机');
  assert.equal(closed.pendingOnly, true);
  assert.equal(closed.requestPage, 2);
});

test('same request detail rerender emits a new monotonic details generation', () => {
  const root = fakeRoot();
  const workspace = mountLegacyReservationWorkspace(root, {}, { initialState: stateFixture() });
  workspace.openRequest('REQ-001');
  const first = root.innerHTML.match(/data-details-generation="(\d+)"/)?.[1];
  workspace.openRequest('REQ-001');
  const second = root.innerHTML.match(/data-details-generation="(\d+)"/)?.[1];
  assert.equal(first, '1');
  assert.equal(second, '2');
  workspace.destroy();
});

test('successful multi-sample submit sends one batch command and adopts only returned state', async () => {
  const before = stateFixture();
  const saved = structuredClone(before);
  saved.revision = 8;
  saved.records = [{ id: 'REC-SAVED' }];
  const calls = [];
  const repository = {
    async executeReservation(command) {
      calls.push(command);
      return { ok: true, state: saved };
    }
  };
  const ui = selectLegacyRequest(createLegacyReservationUiState({
    mode: 'reserve',
    start: '2026-08-20T10:00',
    end: '2026-08-20T12:00'
  }), 'REQ-001');
  ui.assignments = {
    'REQ-001.001': before.channels[0].key,
    'REQ-001.002': before.channels[1].key
  };
  let nextId = 0;
  const result = await submitLegacyReservation(repository, before, ui, {
    idFactory: () => `ID-${++nextId}`,
    clock: () => new Date('2026-08-20T09:00:00-07:00')
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].type, 'reserve');
  assert.equal(calls[0].payload.items.length, 2);
  assert.deepEqual(calls[0].payload.items.map(item => item.sampleId), ['REQ-001.001', 'REQ-001.002']);
  assert.strictEqual(result.state, saved);
  assert.equal(before.revision, 7);
  assert.equal(before.records.length, 0);
});

test('immediate start submits the visible start time so an earlier end can be rejected consistently', async () => {
  const before = stateFixture();
  const calls = [];
  const repository = {
    async executeReservation(command) {
      calls.push(command);
      return { ok: true, state: { ...structuredClone(before), revision: 8 } };
    }
  };
  const ui = selectLegacyRequest(createLegacyReservationUiState({
    mode: 'start',
    start: '2026-09-03T12:00',
    end: '2026-09-03T11:00'
  }), 'REQ-001');
  ui.assignments = { 'REQ-001.001': before.channels[0].key };

  await submitLegacyReservation(repository, before, ui, {
    idFactory: () => crypto.randomUUID(),
    clock: () => new Date('2026-09-03T10:00:00-07:00')
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].type, 'start');
  assert.equal(calls[0].payload.start, new Date('2026-09-03T12:00').toISOString());
  assert.equal(calls[0].payload.end, new Date('2026-09-03T11:00').toISOString());
});

test('failed submit never adopts a draft and WARNING retry requires explicit confirmation', async () => {
  const before = stateFixture();
  const snapshot = structuredClone(before);
  const ui = selectLegacyRequest(createLegacyReservationUiState({
    mode: 'reserve', start: '2026-08-20T10:00', end: '2026-08-20T12:00'
  }), 'REQ-001');
  ui.assignments = { 'REQ-001.001': before.channels[0].key };

  const rejectedRepository = {
    async executeReservation() {
      return { ok: false, code: 'CHANNEL_NOT_FOUND', message: '通道不存在' };
    }
  };
  await assert.rejects(
    submitLegacyReservation(rejectedRepository, before, ui),
    error => error.code === 'CHANNEL_NOT_FOUND'
  );
  assert.deepEqual(before, snapshot);

  const calls = [];
  const warningRepository = {
    async executeReservation(command) {
      calls.push(command);
      if (calls.length === 1) {
        return { ok: false, code: 'WARNING_CONFIRMATION_REQUIRED', message: '需要确认 WARNING' };
      }
      return { ok: true, state: { ...structuredClone(before), revision: 8 } };
    }
  };
  const confirmed = await submitLegacyReservation(warningRepository, before, ui, {
    confirmAction: async () => true,
    idFactory: () => crypto.randomUUID(),
    clock: () => new Date('2026-08-20T09:00:00-07:00')
  });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].payload.acceptWarning, false);
  assert.equal(calls[1].payload.acceptWarning, true);
  assert.equal(confirmed.state.revision, 8);
});

test('mounted workspace sends a visible notification when a submission is rejected', async () => {
  const before = stateFixture();
  const repository = {
    async executeReservation() {
      return { ok: false, code: 'TIME_INTERVAL_INVALID', message: '结束时间必须晚于开始时间' };
    }
  };
  const root = fakeRoot();
  const notifications = [];
  const workspace = mountLegacyReservationWorkspace(root, repository, {
    initialState: before,
    notify(message, tone) { notifications.push([message, tone]); }
  });
  workspace.openRequest('REQ-001');
  clickAction(root, 'open-channel-picker', { sampleId: 'REQ-001.001' });
  clickAction(root, 'choose-channel', { channelKey: before.channels[0].key });
  clickAction(root, 'submit-operation');
  await settleWorkspaceSubmit();

  assert.deepEqual(notifications, [['结束时间必须晚于开始时间', 'error']]);
  assert.equal(workspace.getUiState().message, '结束时间必须晚于开始时间');
  workspace.destroy();
});

test('REVISION_CONFLICT refreshes workspace and host state without retrying the stale submit', async () => {
  const before = stateFixture();
  const latest = structuredClone(before);
  latest.revision = 9;
  latest.records = [{ id: 'REC-A', sampleId: 'REQ-001.001', channelKey: before.channels[0].key, status: 'reserved' }];
  const calls = { execute: 0, load: 0 };
  const repository = {
    async executeReservation() {
      calls.execute += 1;
      return { ok: false, code: 'REVISION_CONFLICT', message: '数据已被其它操作更新，请重新加载' };
    },
    async loadState() {
      calls.load += 1;
      return latest;
    }
  };
  const root = fakeRoot();
  let adopted = null;
  const workspace = mountLegacyReservationWorkspace(root, repository, {
    initialState: before,
    onStateChange(state) { adopted = state; }
  });
  workspace.openRequest('REQ-001');
  clickAction(root, 'open-channel-picker', { sampleId: 'REQ-001.001' });
  clickAction(root, 'choose-channel', { channelKey: before.channels[0].key });
  clickAction(root, 'submit-operation');
  await settleWorkspaceSubmit();

  assert.equal(calls.execute, 1);
  assert.equal(calls.load, 1);
  assert.strictEqual(workspace.getState(), latest);
  assert.strictEqual(adopted, latest);
  assert.match(workspace.getUiState().message, /数据已被其它操作更新/);
});

test('REVISION_CONFLICT refresh failure stays rejected and keeps the old workspace state', async () => {
  const before = stateFixture();
  const calls = { execute: 0, load: 0 };
  const repository = {
    async executeReservation() {
      calls.execute += 1;
      return { ok: false, code: 'REVISION_CONFLICT', message: '数据已被其它操作更新，请重新加载' };
    },
    async loadState() {
      calls.load += 1;
      throw new Error('SQLite 读取失败');
    }
  };
  const root = fakeRoot();
  let adopted = null;
  const workspace = mountLegacyReservationWorkspace(root, repository, {
    initialState: before,
    onStateChange(state) { adopted = state; }
  });
  workspace.openRequest('REQ-001');
  clickAction(root, 'open-channel-picker', { sampleId: 'REQ-001.001' });
  clickAction(root, 'choose-channel', { channelKey: before.channels[0].key });
  clickAction(root, 'submit-operation');
  await settleWorkspaceSubmit();

  assert.equal(calls.execute, 1);
  assert.equal(calls.load, 1);
  assert.strictEqual(workspace.getState(), before);
  assert.equal(adopted, null);
  assert.match(workspace.getUiState().message, /数据已被其它操作更新.*刷新.*失败/);
});
