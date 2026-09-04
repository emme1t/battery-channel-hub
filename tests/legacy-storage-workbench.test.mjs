import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  buildStartStorageCommand,
  formatLegacyLocalDateTime,
  mountLegacySampleWorkbenches,
  renderRunningSampleWorkbench,
  renderStorageSampleWorkbench,
  runningSamplePage,
  storageSamplePage
} from '../src/renderer/legacy-storage-workbench.mjs';

test('local display formatter removes ISO punctuation without changing date-only or invalid values', () => {
  const date = new Date('2026-08-28T10:00:00.000Z');
  const expected = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
  assert.equal(formatLegacyLocalDateTime('2026-08-28T10:00:00.000Z'), expected);
  assert.equal(formatLegacyLocalDateTime('2026-08-28'), '2026-08-28');
  assert.equal(formatLegacyLocalDateTime('not-a-date'), 'not-a-date');
  assert.equal(formatLegacyLocalDateTime(''), '-');
});

test('running and storage rows render ISO timestamps in the local display format', () => {
  const input = state();
  const runningHtml = renderRunningSampleWorkbench(runningSamplePage(input, { text: 'REQ-001.001' }));
  const storageHtml = renderStorageSampleWorkbench(storageSamplePage(input, { text: 'SREQ-001.001' }));

  assert.ok(runningHtml.includes(formatLegacyLocalDateTime('2026-08-28T08:00:00.000Z')));
  assert.ok(storageHtml.includes(formatLegacyLocalDateTime('2026-08-01T08:00:00.000Z')));
  assert.equal(runningHtml.includes('T08:00:00.000Z'), false);
  assert.equal(storageHtml.includes('T08:00:00.000Z'), false);
});

test('requests and reserved rows keep their time display behind displayLocalDateTime', async () => {
  const source = await readFile(new URL('../feedback_patch.js', import.meta.url), 'utf8');
  const requestRows = source.slice(source.indexOf('function requestRows'), source.indexOf('renderRequestTable = function'));
  const reservedRows = source.slice(source.indexOf('function renderReservedPage'), source.indexOf('window.openReservedRecordDetails'));
  const requestContract = /html\(displayLocalDateTime\(plannedEnd\)\)/;
  const reservedStartContract = /html\(displayLocalDateTime\(record\.time\)\)/;
  const reservedEndContract = /record\.end \? displayLocalDateTime\(record\.end\)/;

  assert.match(requestRows, requestContract);
  assert.match(reservedRows, reservedStartContract);
  assert.match(reservedRows, reservedEndContract);

  // Counterfactual legacy direct rendering proves these contracts reject the old implementation.
  assert.doesNotMatch(requestRows.replace('displayLocalDateTime(plannedEnd)', 'plannedEnd || \'-\''), requestContract);
  assert.doesNotMatch(reservedRows.replace('displayLocalDateTime(record.time)', 'record.time || \'-\''), reservedStartContract);
});

function state() {
  const records = Array.from({ length: 27 }, (_, index) => ({
    id: `REC-${index + 1}`,
    requestNo: `REQ-${String(index + 1).padStart(3, '0')}`,
    no: `REQ-${String(index + 1).padStart(3, '0')}`,
    sampleId: `REQ-${String(index + 1).padStart(3, '0')}.001`,
    status: index < 23 ? 'running' : 'completed',
    project: index === 1 ? '说明包含 REQ-001' : `普通项目 ${index + 1}`,
    channelKey: `设备 A|${index + 1}`,
    start: '2026-08-28T08:00:00.000Z',
    end: '2026-08-28T12:00:00.000Z',
    user: '测试员 A'
  }));
  const storageRecords = Array.from({ length: 23 }, (_, index) => ({
    id: `STO-${index + 1}`,
    requestNo: `SREQ-${String(index + 1).padStart(3, '0')}`,
    sampleIds: [`SREQ-${String(index + 1).padStart(3, '0')}.001`],
    tester: '测试员 B',
    status: index < 11 ? 'storing' : index < 13 ? 'exception' : index < 18 ? 'completed' : 'returned',
    startedAt: '2026-08-01T08:00:00.000Z',
    expectedEndAt: '2026-09-01T08:00:00.000Z',
    endedAt: index < 13 ? '' : '2026-08-20T08:00:00.000Z',
    note: index === 1 ? '说明包含 SREQ-001.001' : `存储备注 ${index + 1}`,
    returnReason: ''
  }));
  return { revision: 5, records, storageRecords, samples: [], requests: [], channels: [] };
}

test('the two independent sample selectors paginate 10 rows and keep history out of the running page', () => {
  const input = state();
  const snapshot = structuredClone(input);
  const running = runningSamplePage(input, { page: 2 });
  const storage = storageSamplePage(input, { page: 3 });

  assert.equal(running.pageSize, 10);
  assert.equal(running.total, 23);
  assert.equal(running.items.length, 10);
  assert.ok(running.items.every(item => item.status === 'running'));
  assert.equal(storage.pageSize, 10);
  assert.equal(storage.total, 23);
  assert.equal(storage.items.length, 3);
  assert.ok(storage.items.some(item => ['completed', 'returned'].includes(item.status)));
  assert.deepEqual(input, snapshot);
});

test('sample workbench identifiers are exact and take priority over ordinary contains fields', () => {
  const input = state();
  input.storageRecords[2].note = '唯一普通关键字';
  assert.deepEqual(runningSamplePage(input, { text: ' req-001 ' }).items.map(item => item.id), ['REC-1']);
  assert.deepEqual(runningSamplePage(input, { text: ' REQ-001.001 ' }).items.map(item => item.id), ['REC-1']);
  assert.deepEqual(storageSamplePage(input, { text: ' sreq-001.001 ' }).items.map(item => item.id), ['STO-1']);
  assert.deepEqual(storageSamplePage(input, { text: '唯一普通' }).items.map(item => item.id), ['STO-3']);
});

test('storage history is read-only and the long-term table never renders channel fields', () => {
  const input = state();
  const html = renderStorageSampleWorkbench(storageSamplePage(input, { page: 2 }));

  assert.match(html, /data-sample-action="storage-detail"/);
  assert.equal(html.includes('data-sample-action="storage-edit" data-storage-id="STO-14"'), false);
  assert.equal(html.includes('data-sample-action="storage-return" data-storage-id="STO-14"'), false);
  assert.equal(html.includes('data-sample-action="storage-finish" data-storage-id="STO-14"'), false);
  assert.equal(html.includes('通道'), false);
  assert.equal(html.includes('channelKey'), false);
});

test('sample workbench rows expose stable request and sample identities for exact-search evidence', () => {
  const input = state();
  const runningHtml = renderRunningSampleWorkbench(runningSamplePage(input, { text: 'REQ-001.001' }));
  const storageHtml = renderStorageSampleWorkbench(storageSamplePage(input, { text: 'SREQ-001.001' }));
  assert.match(runningHtml, /data-request-no="REQ-001"/);
  assert.match(runningHtml, /data-sample-id="REQ-001\.001"/);
  assert.match(storageHtml, /data-request-no="SREQ-001"/);
  assert.match(storageHtml, /data-sample-id="SREQ-001\.001"/);
});

function fakeDocument() {
  const elements = new Map([
    ['runningSamplesTable', { innerHTML: '' }],
    ['storageSamplesTable', { innerHTML: '' }],
    ['runningSamplesSummary', { textContent: '' }],
    ['storageSamplesSummary', { textContent: '' }]
  ]);
  const listeners = new Map();
  const view = {
    confirm() { this.confirmCalls += 1; return true; }
  };
  return {
    defaultView: view,
    getElementById(id) { return elements.get(id) || null; },
    addEventListener(type, listener) { listeners.set(type, listener); },
    removeEventListener(type) { listeners.delete(type); },
    async dispatch(type, target) { return listeners.get(type)?.({ target }); },
    elements
  };
}

function actionTarget(action, data = {}) {
  const target = { disabled: false, dataset: { sampleAction: action, ...data } };
  target.closest = selector => selector === '[data-sample-action]' ? target : null;
  return target;
}

test('each return action uses one in-app reason form and calls only preload after explicit submit', async () => {
  let current = state();
  const document = fakeDocument();
  const calls = [];
  const desktop = {
    async executeReservation(command) {
      calls.push(['reservation', command]);
      return { ok: true, state: { ...current, revision: 6, marker: 'ordinary-returned' } };
    },
    async executeStorage(command) {
      calls.push(['storage', command]);
      return { ok: true, state: { ...current, revision: 7, marker: 'storage-returned' } };
    }
  };
  const adopted = [];
  const formCalls = [];
  const mounted = mountLegacySampleWorkbenches({
    document,
    desktop,
    getState: () => current,
    adoptState(next) { current = next; adopted.push(next.marker); },
    async openForm(spec) {
      formCalls.push(spec);
      return { reason: '  资料补充  ' };
    }
  });

  assert.equal(typeof mounted.returnReservedToApplication, 'function');

  await document.dispatch('click', actionTarget('running-return', { recordId: 'REC-1' }));
  await document.dispatch('click', actionTarget('storage-return', { storageId: 'STO-1' }));
  await mounted.returnReservedToApplication('REC-RESERVED');

  assert.deepEqual(formCalls.map(spec => [spec.kind, spec.submitLabel, spec.fields.map(field => field.name)]), [
    ['return', '确认退回', ['reason']],
    ['return', '确认退回', ['reason']],
    ['return', '确认退回', ['reason']]
  ]);
  assert.deepEqual(calls.map(([channel, command]) => [channel, command.type, command.payload.reason]), [
    ['reservation', 'returnRunningToApplication', '资料补充'],
    ['storage', 'returnStorageToApplication', '资料补充'],
    ['reservation', 'returnReservedToApplication', '资料补充']
  ]);
  assert.deepEqual(adopted, ['ordinary-returned', 'storage-returned', 'ordinary-returned']);
  mounted.destroy();
});

test('long-term execution builds a direct storage command without any channel assignment', () => {
  const command = buildStartStorageCommand({
    requestNo: 'REQ-001',
    sampleIds: ['REQ-001.001', 'REQ-001.002'],
    tester: '测试员 A',
    expectedEndAt: '2026-09-28T10:00',
    note: '干燥保存'
  }, {
    now: new Date('2026-08-28T10:00:00.000Z'),
    idFactory: () => 'FIXED-ID'
  });

  assert.equal(command.type, 'startStorage');
  assert.deepEqual(command.payload.sampleIds, ['REQ-001.001', 'REQ-001.002']);
  assert.equal(command.payload.storageId, 'FIXED-ID');
  assert.equal(command.payload.auditId, 'FIXED-ID');
  assert.equal(command.payload.expectedEndAt, new Date('2026-09-28T10:00').toISOString());
  assert.equal('channelKey' in command.payload, false);
  assert.equal('keys' in command.payload, false);

  assert.throws(
    () => buildStartStorageCommand({ requestNo: 'REQ-001', sampleIds: [], tester: '测试员 A', expectedEndAt: '2026-09-28T10:00' }),
    error => error.code === 'STORAGE_SAMPLE_IDS_INVALID'
  );
});
