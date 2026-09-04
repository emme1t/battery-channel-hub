import assert from 'node:assert/strict';
import test from 'node:test';

import { DEVIATION_WORKFLOWS } from './catalog-deviation.mjs';
import { normalizeWorkflow } from './contracts.mjs';
import { ACTION_LIBRARY } from './actions.mjs';
import { seedWorkflowFixture } from './fixtures.mjs';
import { createWorkflowRunContext } from './run-context.mjs';
import { readWorkflowSnapshot } from './state-probe.mjs';
import { validateAssignment } from '../../src/domain/reservation-policy.mjs';
import path from 'node:path';

const projectRoot = path.resolve(import.meta.dirname, '..', '..');
const fixedClock = () => new Date('2026-08-27T00:00:00.000Z');
const EXPECTED_DEVIATION_CATALOG = [
  {
    id: 'D01', name: '无预计结束时间', risk: 'P0', fixture: 'baseline', timeoutMs: 90_000,
    actions: [
      { id: 'reserve-open-ended', type: 'reserve', expect: 'success', revisionDelta: 1, params: { requestNo: 'REQ-WF-D01-001', sampleIds: ['REQ-WF-D01-001.001'], channelKeys: ['新威1#（16通道)|1-2'], end: '', confirm: true }, maxMs: 15_000 },
      { id: 'reserve-conflict', type: 'reserve', expect: 'rejected', revisionDelta: 0, params: { requestNo: 'REQ-WF-D01-001', sampleIds: ['REQ-WF-D01-001.002'], channelKeys: ['新威1#（16通道)|1-1'], start: '2026-08-27T09:00', end: '2026-08-27T11:00', confirm: true }, maxMs: 15_000 },
      { id: 'manage-running-end', type: 'manageRunning', expect: 'success', revisionDelta: 1, params: { sampleId: 'REQ-WF-D01-RUNNING-001.001', endOffsetMinutes: 60 }, maxMs: 10_000 },
      { id: 'restart', type: 'restart', expect: 'success', revisionDelta: [2, 3], params: {}, maxMs: 30_000 }
    ]
  },
  {
    id: 'D02', name: '相邻时间与边界时间', risk: 'P0', fixture: 'baseline', timeoutMs: 105_000,
    actions: [
      { id: 'reserve-adjacent', type: 'reserve', expect: 'success', revisionDelta: 1, params: { requestNo: 'REQ-WF-D02-001', sampleIds: ['REQ-WF-D02-001.001'], channelKeys: ['新威1#（16通道)|1-1'], start: '2026-08-27T08:00', end: '2026-08-27T09:00', confirm: true }, maxMs: 15_000 },
      { id: 'reserve-overlap-one-minute', type: 'reserve', expect: 'success', revisionDelta: 1, params: { requestNo: 'REQ-WF-D02-001', sampleIds: ['REQ-WF-D02-001.002'], channelKeys: ['新威1#（16通道)|1-2'], start: '2026-08-27T09:59', end: '2026-08-27T10:30', confirm: true }, maxMs: 15_000 },
      { id: 'reserve-cross-day', type: 'reserve', expect: 'success', revisionDelta: 1, params: { requestNo: 'REQ-WF-D02-001', sampleIds: ['REQ-WF-D02-001.003'], channelKeys: ['新威1#（16通道)|1-3'], start: '2026-08-27T23:30', end: '2026-08-28T00:30', confirm: true }, maxMs: 15_000 },
      { id: 'reserve-date-only', type: 'reserve', expect: 'success', revisionDelta: 1, params: { requestNo: 'REQ-WF-D02-001', sampleIds: ['REQ-WF-D02-001.004'], channelKeys: ['新威1#（16通道)|1-4'], start: '2026-08-29', end: '2026-08-30', confirm: true }, maxMs: 15_000 },
      { id: 'restart', type: 'restart', expect: 'success', revisionDelta: [2, 3], params: {}, maxMs: 30_000 }
    ]
  },
  {
    id: 'D03', name: '临时插单', risk: 'P0', fixture: 'queue', timeoutMs: 60_000,
    actions: [
      { id: 'urgent-dismissed', type: 'reserve', expect: 'warning', revisionDelta: 0, params: { requestNo: 'REQ-WF-D03-URGENT-001', sampleIds: ['REQ-WF-D03-URGENT-001.001'], channelKeys: ['新威1#（16通道)|1-1'], start: '2026-08-27T09:00', end: '2026-08-27T10:00', confirm: false }, maxMs: 15_000 },
      { id: 'urgent-confirmed', type: 'reserve', expect: 'success', revisionDelta: 1, params: { requestNo: 'REQ-WF-D03-URGENT-001', sampleIds: ['REQ-WF-D03-URGENT-001.001'], channelKeys: ['新威1#（16通道)|1-1'], start: '2026-08-27T09:00', end: '2026-08-27T10:00', confirm: true }, maxMs: 15_000 },
      { id: 'restart', type: 'restart', expect: 'success', revisionDelta: [2, 3], params: {}, maxMs: 30_000 }
    ]
  },
  {
    id: 'D04', name: '预约页保持打开时导入', risk: 'P0', fixture: 'baseline', timeoutMs: 110_000,
    actions: [
      { id: 'navigate-apply', type: 'navigate', expect: 'success', revisionDelta: [0, 1], params: { label: '预约' }, maxMs: 5_000 },
      { id: 'search-request', type: 'search', expect: 'success', revisionDelta: 0, params: { label: '搜索申请单、项目、样品或人员', value: '  req-wf-d04-001  ', identity: 'requestNo', expectedVisibleIds: ['REQ-WF-D04-001'], excludedVisibleIds: ['REQ-WF-D04-001-EXTRA'] }, maxMs: 5_000 },
      { id: 'next-request-page', type: 'nextPage', expect: 'rejected', revisionDelta: 0, params: { view: 'request' }, maxMs: 5_000 },
      { id: 'expand-device', type: 'expand', expect: 'success', revisionDelta: 0, params: { requestNo: 'REQ-WF-D04-001', sampleIds: ['REQ-WF-D04-001.001'], channelKeys: ['新威1#（16通道)|1-1'], start: '2026-08-27T13:00', end: '2026-08-27T14:00' }, maxMs: 5_000 },
      { id: 'import-request', type: 'importRequest', expect: 'success', revisionDelta: 1, params: { path: 'imports/vertical.xlsx', kind: 'file', expectedValidCount: 1 }, maxMs: 30_000 },
      { id: 'stale-submit', type: 'staleSubmit', expect: 'rejected', revisionDelta: 0, params: { session: 'B', operation: 'reserve', requestNo: 'REQ-WF-D04-001', sampleIds: ['REQ-WF-D04-001.001'], channelKeys: ['新威1#（16通道)|1-1'], start: '2026-08-27T13:00', end: '2026-08-27T14:00', confirm: true }, maxMs: 10_000 },
      { id: 'reload-current', type: 'reloadCurrent', expect: 'success', revisionDelta: [2, 3], params: {}, maxMs: 10_000 },
      { id: 'reserve-fresh', type: 'reserve', expect: 'success', revisionDelta: 1, params: { requestNo: 'REQ-WF-D04-001', sampleIds: ['REQ-WF-D04-001.001'], channelKeys: ['新威1#（16通道)|1-1'], start: '2026-08-27T13:00', end: '2026-08-27T14:00', confirm: true }, maxMs: 15_000 }
    ]
  },
  {
    id: 'D05', name: '编辑中切页再返回', risk: 'P1', fixture: 'baseline', timeoutMs: 45_000,
    actions: [
      { id: 'navigate-apply', type: 'navigate', expect: 'success', revisionDelta: [0, 1], params: { label: '预约' }, maxMs: 5_000 },
      { id: 'edit-draft', type: 'editDraft', expect: 'success', revisionDelta: 0, params: { requestNo: 'REQ-WF-D05-001', sampleIds: ['REQ-WF-D05-001.001'], channelKeys: ['新威1#（16通道)|1-1'], label: '备注', value: 'D05 未提交草稿' }, maxMs: 5_000 },
      { id: 'navigate-dashboard', type: 'navigate', expect: 'success', revisionDelta: [0, 1], params: { label: '看板' }, maxMs: 5_000 },
      { id: 'navigate-records', type: 'navigate', expect: 'success', revisionDelta: [0, 1], params: { label: '日志' }, maxMs: 5_000 },
      { id: 'navigate-devices', type: 'navigate', expect: 'success', revisionDelta: [0, 1], params: { label: '设备' }, maxMs: 5_000 },
      { id: 'navigate-apply-return', type: 'navigate', expect: 'success', revisionDelta: [0, 1], params: { label: '预约' }, maxMs: 5_000 },
      { id: 'assert-draft-preserved', type: 'assertDraftPreserved', expect: 'success', revisionDelta: 0, params: { label: '备注' }, maxMs: 5_000 }
    ]
  },
  {
    id: 'D06', name: '步骤之间重启', risk: 'P0', fixture: 'baseline', timeoutMs: 225_000,
    actions: [
      { id: 'import-request', type: 'importRequest', expect: 'success', revisionDelta: 1, params: { path: 'imports/vertical.xlsx', kind: 'file', expectedValidCount: 1 }, maxMs: 30_000 },
      { id: 'restart-after-import', type: 'restart', expect: 'success', revisionDelta: [2, 3], params: {}, maxMs: 30_000 },
      { id: 'reserve', type: 'reserve', expect: 'success', revisionDelta: 1, params: { requestNo: 'REQ-WF-IMPORT-001', sampleIds: ['REQ-WF-IMPORT-001.001'], channelKeys: ['新威1#（16通道)|1-1'], confirm: true }, maxMs: 15_000 },
      { id: 'restart-after-reserve', type: 'restart', expect: 'success', revisionDelta: [2, 3], params: {}, maxMs: 30_000 },
      { id: 'start-todo', type: 'startTodo', expect: 'success', revisionDelta: 1, params: { sampleId: 'REQ-WF-IMPORT-001.001' }, maxMs: 10_000 },
      { id: 'restart-after-start', type: 'restart', expect: 'success', revisionDelta: [2, 3], params: {}, maxMs: 30_000 },
      { id: 'manage-running', type: 'manageRunning', expect: 'success', revisionDelta: 1, params: { sampleId: 'REQ-WF-IMPORT-001.001', endOffsetMinutes: 60 }, maxMs: 10_000 },
      { id: 'restart-after-manage', type: 'restart', expect: 'success', revisionDelta: [2, 3], params: {}, maxMs: 30_000 },
      { id: 'finish-running', type: 'finishRunning', expect: 'success', revisionDelta: 1, params: { sampleId: 'REQ-WF-IMPORT-001.001' }, maxMs: 10_000 },
      { id: 'restart-after-finish', type: 'restart', expect: 'success', revisionDelta: [2, 3], params: {}, maxMs: 30_000 }
    ]
  },
  {
    id: 'D07', name: '取消原生对话框后重试', risk: 'P1', fixture: 'import-mixed', timeoutMs: 240_000,
    actions: [
      { id: 'import-cancelled', type: 'importRequest', expect: 'cancelled', revisionDelta: 0, params: { cancel: true }, maxMs: 30_000 },
      { id: 'import-success', type: 'importRequest', expect: 'success', revisionDelta: 1, params: { path: 'imports/vertical.xlsx', kind: 'file', expectedValidCount: 1 }, maxMs: 30_000 },
      { id: 'export-log-cancelled', type: 'exportLog', expect: 'cancelled', revisionDelta: 0, params: { cancel: true }, maxMs: 30_000 },
      { id: 'export-log-success', type: 'exportLog', expect: 'success', revisionDelta: [0, 1], params: { path: 'exports/d07-log.xlsx' }, maxMs: 30_000 },
      { id: 'backup-cancelled', type: 'backup', expect: 'cancelled', revisionDelta: 0, params: { cancel: true }, maxMs: 30_000 },
      { id: 'backup-success', type: 'backup', expect: 'success', revisionDelta: [0, 1], params: { path: 'backups/d07.batterydata' }, maxMs: 30_000 },
      { id: 'restore-cancelled', type: 'restore', expect: 'cancelled', revisionDelta: 0, params: { cancel: true }, maxMs: 30_000 },
      { id: 'restore-success', type: 'restore', expect: 'success', revisionDelta: [0, 1], params: { path: 'backups/d07.batterydata', confirm: true }, maxMs: 30_000 }
    ]
  },
  {
    id: 'D08', name: '历史引用后维护名单', risk: 'P1', fixture: 'history', timeoutMs: 75_000,
    actions: [
      { id: 'rename-tester', type: 'renameTester', expect: 'success', revisionDelta: 1, params: { name: 'WF tester', nextName: 'D08 已改名测试员' }, maxMs: 10_000 },
      { id: 'delete-tester', type: 'deleteTester', expect: 'success', revisionDelta: 1, params: { name: 'D08 已改名测试员', confirm: true }, maxMs: 10_000 },
      { id: 'navigate-requests', type: 'navigate', expect: 'success', revisionDelta: [0, 1], params: { label: '申请' }, maxMs: 5_000 },
      { id: 'navigate-records', type: 'navigate', expect: 'success', revisionDelta: [0, 1], params: { label: '日志' }, maxMs: 5_000 },
      { id: 'create-tester', type: 'createTester', expect: 'success', revisionDelta: 1, params: { name: 'D08 新测试员', dept: '测试部', phone: '00000000', note: '历史名单维护' }, maxMs: 10_000 },
      { id: 'restart', type: 'restart', expect: 'success', revisionDelta: [2, 3], params: {}, maxMs: 30_000 }
    ]
  }
];

function uiFor(snapshot, currentPage) {
  return { projection: { currentPage, summary: { revision: snapshot.state.revision }, visible: {} } };
}

test('偏差目录精确覆盖 D01-D08 且每条含恢复动作', () => {
  assert.deepEqual(DEVIATION_WORKFLOWS.map(item => normalizeWorkflow(item)), EXPECTED_DEVIATION_CATALOG);
  assert.ok(DEVIATION_WORKFLOWS.every(item => item.actions.some(action => ['restart', 'navigate', 'restore'].includes(action.type))));
  assert.deepEqual(DEVIATION_WORKFLOWS.map(item => item.actions.map(action => action.type)), [
    ['reserve', 'reserve', 'manageRunning', 'restart'],
    ['reserve', 'reserve', 'reserve', 'reserve', 'restart'],
    ['reserve', 'reserve', 'restart'],
    ['navigate', 'search', 'nextPage', 'expand', 'importRequest', 'staleSubmit', 'reloadCurrent', 'reserve'],
    ['navigate', 'editDraft', 'navigate', 'navigate', 'navigate', 'navigate', 'assertDraftPreserved'],
    ['importRequest', 'restart', 'reserve', 'restart', 'startTodo', 'restart', 'manageRunning', 'restart', 'finishRunning', 'restart'],
    ['importRequest', 'importRequest', 'exportLog', 'exportLog', 'backup', 'backup', 'restore', 'restore'],
    ['renameTester', 'deleteTester', 'navigate', 'navigate', 'createTester', 'restart']
  ]);
});

test('D04 精确申请号搜索排除包含式诱饵', () => {
  const search = DEVIATION_WORKFLOWS.find(item => item.id === 'D04').actions.find(item => item.id === 'search-request');
  assert.deepEqual(search.params, {
    label: '搜索申请单、项目、样品或人员', value: '  req-wf-d04-001  ', identity: 'requestNo',
    expectedVisibleIds: ['REQ-WF-D04-001'], excludedVisibleIds: ['REQ-WF-D04-001-EXTRA']
  });
});

test('偏差目录通过 Workflow normalization 且动作合同完整', () => {
  for (const workflow of DEVIATION_WORKFLOWS) {
    assert.doesNotThrow(() => normalizeWorkflow(workflow), workflow.id);
    for (const action of workflow.actions) {
      assert.equal(typeof action.expect, 'string', `${workflow.id}/${action.id} expect`);
      assert.notEqual(action.revisionDelta, undefined, `${workflow.id}/${action.id} revisionDelta`);
      assert.equal(typeof action.params, 'object', `${workflow.id}/${action.id} params`);
      assert.equal(Number.isFinite(action.maxMs), true, `${workflow.id}/${action.id} maxMs`);
    }
  }
  const d01 = DEVIATION_WORKFLOWS.find(item => item.id === 'D01');
  assert.equal(d01.actions[0].params.end, '');
  assert.deepEqual(d01.actions[1], {
    id: 'reserve-conflict', type: 'reserve', expect: 'rejected', revisionDelta: 0,
    params: { requestNo: 'REQ-WF-D01-001', sampleIds: ['REQ-WF-D01-001.002'], channelKeys: ['新威1#（16通道)|1-1'], start: '2026-08-27T09:00', end: '2026-08-27T11:00', confirm: true },
    maxMs: 15_000
  });
  const d06 = DEVIATION_WORKFLOWS.find(item => item.id === 'D06');
  const d07 = DEVIATION_WORKFLOWS.find(item => item.id === 'D07');
  assert.deepEqual(d06.actions.find(item => item.id === 'manage-running').params, {
    sampleId: 'REQ-WF-IMPORT-001.001',
    endOffsetMinutes: 60
  });
  assert.equal(
    d06.actions.some(item => Object.values(item.params).some(value => typeof value === 'string' && /^20\d{2}-\d{2}-\d{2}T/.test(value))),
    false,
    'D06 catalog must not contain a near-future fixed datetime'
  );
  assert.ok(d06.timeoutMs >= d06.actions.reduce((total, item) => total + item.maxMs, 0));
  assert.ok(d07.timeoutMs >= d07.actions.reduce((total, item) => total + item.maxMs, 0));
});

test('D01 管理运行使用正的相对结束时间，不依赖历史绝对时间', () => {
  const d01 = DEVIATION_WORKFLOWS.find(item => item.id === 'D01');
  const manageRunning = d01.actions.find(item => item.id === 'manage-running-end');
  assert.equal(manageRunning.params.endOffsetMinutes > 0, true);
  assert.equal(Object.hasOwn(manageRunning.params, 'end'), false);
});

test('偏差夹具中的首个业务动作和关键恢复动作可用，错误 ID fail-close', async t => {
  const context = await createWorkflowRunContext({ projectRoot, mode: 'deviation-catalog-contract', now: fixedClock });
  t.after(() => context.cleanup({ success: true }));

  const checks = [
    { id: 'D01', first: 0, recovery: 2, page: 'apply', recoveryPage: 'records', wrong: 'sampleIds' },
    { id: 'D02', first: 0, recovery: 4, page: 'apply', recoveryPage: 'dashboard', wrong: 'sampleIds' },
    { id: 'D03', first: 0, recovery: 2, page: 'apply', recoveryPage: 'dashboard', wrong: 'sampleIds' },
    { id: 'D04', first: 4, recovery: 3, page: 'requests', recoveryPage: 'apply', wrong: 'sampleIds', wrongAction: 7, wrongPage: 'apply' },
    { id: 'D05', first: 1, recovery: 1, page: 'apply', recoveryPage: 'apply' },
    { id: 'D06', first: 0, recovery: 1, page: 'requests', recoveryPage: 'dashboard' },
    { id: 'D07', first: 0, recovery: 7, page: 'requests', recoveryPage: 'dashboard' },
    { id: 'D08', first: 0, recovery: 5, page: 'testers', recoveryPage: 'dashboard', wrong: 'name' }
  ];

  for (const check of checks) {
    const workflow = DEVIATION_WORKFLOWS.find(item => item.id === check.id);
    const dataRoot = path.join(context.dataRoot, workflow.id);
    await seedWorkflowFixture({ dataRoot, kind: workflow.fixture, workflowId: workflow.id, clock: fixedClock });
    const snapshot = await readWorkflowSnapshot({ dataRoot });
    const first = workflow.actions[check.first];
    const recovery = workflow.actions[check.recovery];
    const runtime = {};
    assert.equal(await ACTION_LIBRARY[first.type].available(snapshot, uiFor(snapshot, check.page), first.params, { runtime }), true, `${check.id} first`);
    assert.equal(await ACTION_LIBRARY[recovery.type].available(snapshot, uiFor(snapshot, check.recoveryPage), recovery.params, { runtime }), true, `${check.id} recovery`);
    if (check.wrong) {
      const checked = workflow.actions[check.wrongAction ?? check.first];
      const wrong = structuredClone(checked.params);
      wrong[check.wrong] = check.wrong === 'sampleIds' ? ['MISSING.001'] : 'MISSING';
      assert.equal(await ACTION_LIBRARY[checked.type].available(snapshot, uiFor(snapshot, check.wrongPage ?? check.page), wrong, { runtime }), false, `${check.id} wrong ${check.wrong}`);
    }
  }
});

test('D01-D03 时间边界按夹具和目录参数得到可达的产品策略结果', async t => {
  const context = await createWorkflowRunContext({ projectRoot, mode: 'deviation-time-policy', now: fixedClock });
  t.after(() => context.cleanup({ success: true }));
  for (const id of ['D01', 'D02', 'D03']) {
    const workflow = DEVIATION_WORKFLOWS.find(item => item.id === id);
    const dataRoot = path.join(context.dataRoot, id);
    await seedWorkflowFixture({ dataRoot, kind: workflow.fixture, workflowId: id, clock: fixedClock });
    const { state } = await readWorkflowSnapshot({ dataRoot });
    const checks = id === 'D01' ? [workflow.actions[1]] : id === 'D02' ? workflow.actions.slice(0, 4) : workflow.actions.slice(0, 2);
    for (const item of checks) {
      const channel = state.channels.find(value => value.key === item.params.channelKeys[0]);
      const result = validateAssignment({ mode: 'reserve', channel, records: state.records, start: item.params.start, end: item.params.end });
      const expected = item.expect === 'rejected' ? [false, 'error'] : (['warning', 'cancelled'].includes(item.expect) || /overlap|urgent/.test(item.id)) ? [true, 'warning'] : [true, 'normal'];
      assert.deepEqual([result.allowed, result.severity], expected, `${id}/${item.id}`);
    }
  }
});
