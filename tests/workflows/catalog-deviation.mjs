function freeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const item of Object.values(value)) freeze(item);
  return Object.freeze(value);
}

const CHANNELS = Object.freeze({
  first: '新威1#（16通道)|1-1',
  second: '新威1#（16通道)|1-2',
  third: '新威1#（16通道)|1-3',
  fourth: '新威1#（16通道)|1-4'
});

const action = (id, type, expect, revisionDelta, params, maxMs) => ({
  id, type, expect, revisionDelta, params, maxMs
});

export const DEVIATION_WORKFLOWS = freeze([
  {
    id: 'D01', name: '无预计结束时间', risk: 'P0', fixture: 'baseline', timeoutMs: 90_000,
    actions: [
      action('reserve-open-ended', 'reserve', 'success', 1, { requestNo: 'REQ-WF-D01-001', sampleIds: ['REQ-WF-D01-001.001'], channelKeys: [CHANNELS.second], end: '', confirm: true }, 15_000),
      action('reserve-conflict', 'reserve', 'rejected', 0, { requestNo: 'REQ-WF-D01-001', sampleIds: ['REQ-WF-D01-001.002'], channelKeys: [CHANNELS.first], start: '2026-08-27T09:00', end: '2026-08-27T11:00', confirm: true }, 15_000),
      action('manage-running-end', 'manageRunning', 'success', 1, { sampleId: 'REQ-WF-D01-RUNNING-001.001', endOffsetMinutes: 60 }, 10_000),
      action('restart', 'restart', 'success', [2, 3], {}, 30_000)
    ]
  },
  {
    id: 'D02', name: '相邻时间与边界时间', risk: 'P0', fixture: 'baseline', timeoutMs: 105_000,
    actions: [
      action('reserve-adjacent', 'reserve', 'success', 1, { requestNo: 'REQ-WF-D02-001', sampleIds: ['REQ-WF-D02-001.001'], channelKeys: [CHANNELS.first], start: '2026-08-27T08:00', end: '2026-08-27T09:00', confirm: true }, 15_000),
      action('reserve-overlap-one-minute', 'reserve', 'success', 1, { requestNo: 'REQ-WF-D02-001', sampleIds: ['REQ-WF-D02-001.002'], channelKeys: [CHANNELS.second], start: '2026-08-27T09:59', end: '2026-08-27T10:30', confirm: true }, 15_000),
      action('reserve-cross-day', 'reserve', 'success', 1, { requestNo: 'REQ-WF-D02-001', sampleIds: ['REQ-WF-D02-001.003'], channelKeys: [CHANNELS.third], start: '2026-08-27T23:30', end: '2026-08-28T00:30', confirm: true }, 15_000),
      action('reserve-date-only', 'reserve', 'success', 1, { requestNo: 'REQ-WF-D02-001', sampleIds: ['REQ-WF-D02-001.004'], channelKeys: [CHANNELS.fourth], start: '2026-08-29', end: '2026-08-30', confirm: true }, 15_000),
      action('restart', 'restart', 'success', [2, 3], {}, 30_000)
    ]
  },
  {
    id: 'D03', name: '临时插单', risk: 'P0', fixture: 'queue', timeoutMs: 60_000,
    actions: [
      action('urgent-dismissed', 'reserve', 'warning', 0, { requestNo: 'REQ-WF-D03-URGENT-001', sampleIds: ['REQ-WF-D03-URGENT-001.001'], channelKeys: [CHANNELS.first], start: '2026-08-27T09:00', end: '2026-08-27T10:00', confirm: false }, 15_000),
      action('urgent-confirmed', 'reserve', 'success', 1, { requestNo: 'REQ-WF-D03-URGENT-001', sampleIds: ['REQ-WF-D03-URGENT-001.001'], channelKeys: [CHANNELS.first], start: '2026-08-27T09:00', end: '2026-08-27T10:00', confirm: true }, 15_000),
      action('restart', 'restart', 'success', [2, 3], {}, 30_000)
    ]
  },
  {
    id: 'D04', name: '预约页保持打开时导入', risk: 'P0', fixture: 'baseline', timeoutMs: 110_000,
    actions: [
      action('navigate-apply', 'navigate', 'success', [0, 1], { label: '预约' }, 5_000),
      action('search-request', 'search', 'success', 0, { label: '搜索申请单、项目、样品或人员', value: '  req-wf-d04-001  ', identity: 'requestNo', expectedVisibleIds: ['REQ-WF-D04-001'], excludedVisibleIds: ['REQ-WF-D04-001-EXTRA'] }, 5_000),
      action('next-request-page', 'nextPage', 'rejected', 0, { view: 'request' }, 5_000),
      action('expand-device', 'expand', 'success', 0, { requestNo: 'REQ-WF-D04-001', sampleIds: ['REQ-WF-D04-001.001'], channelKeys: [CHANNELS.first], start: '2026-08-27T13:00', end: '2026-08-27T14:00' }, 5_000),
      action('import-request', 'importRequest', 'success', 1, { path: 'imports/vertical.xlsx', kind: 'file', expectedValidCount: 1 }, 30_000),
      action('stale-submit', 'staleSubmit', 'rejected', 0, { session: 'B', operation: 'reserve', requestNo: 'REQ-WF-D04-001', sampleIds: ['REQ-WF-D04-001.001'], channelKeys: [CHANNELS.first], start: '2026-08-27T13:00', end: '2026-08-27T14:00', confirm: true }, 10_000),
      action('reload-current', 'reloadCurrent', 'success', [2, 3], {}, 10_000),
      action('reserve-fresh', 'reserve', 'success', 1, { requestNo: 'REQ-WF-D04-001', sampleIds: ['REQ-WF-D04-001.001'], channelKeys: [CHANNELS.first], start: '2026-08-27T13:00', end: '2026-08-27T14:00', confirm: true }, 15_000)
    ]
  },
  {
    id: 'D05', name: '编辑中切页再返回', risk: 'P1', fixture: 'baseline', timeoutMs: 45_000,
    actions: [
      action('navigate-apply', 'navigate', 'success', [0, 1], { label: '预约' }, 5_000),
      action('edit-draft', 'editDraft', 'success', 0, { requestNo: 'REQ-WF-D05-001', sampleIds: ['REQ-WF-D05-001.001'], channelKeys: [CHANNELS.first], label: '备注', value: 'D05 未提交草稿' }, 5_000),
      action('navigate-dashboard', 'navigate', 'success', [0, 1], { label: '看板' }, 5_000),
      action('navigate-records', 'navigate', 'success', [0, 1], { label: '日志' }, 5_000),
      action('navigate-devices', 'navigate', 'success', [0, 1], { label: '设备' }, 5_000),
      action('navigate-apply-return', 'navigate', 'success', [0, 1], { label: '预约' }, 5_000),
      action('assert-draft-preserved', 'assertDraftPreserved', 'success', 0, { label: '备注' }, 5_000)
    ]
  },
  {
    id: 'D06', name: '步骤之间重启', risk: 'P0', fixture: 'baseline', timeoutMs: 225_000,
    actions: [
      action('import-request', 'importRequest', 'success', 1, { path: 'imports/vertical.xlsx', kind: 'file', expectedValidCount: 1 }, 30_000),
      action('restart-after-import', 'restart', 'success', [2, 3], {}, 30_000),
      action('reserve', 'reserve', 'success', 1, { requestNo: 'REQ-WF-IMPORT-001', sampleIds: ['REQ-WF-IMPORT-001.001'], channelKeys: [CHANNELS.first], confirm: true }, 15_000),
      action('restart-after-reserve', 'restart', 'success', [2, 3], {}, 30_000),
      action('start-todo', 'startTodo', 'success', 1, { sampleId: 'REQ-WF-IMPORT-001.001' }, 10_000),
      action('restart-after-start', 'restart', 'success', [2, 3], {}, 30_000),
      action('manage-running', 'manageRunning', 'success', 1, { sampleId: 'REQ-WF-IMPORT-001.001', endOffsetMinutes: 60 }, 10_000),
      action('restart-after-manage', 'restart', 'success', [2, 3], {}, 30_000),
      action('finish-running', 'finishRunning', 'success', 1, { sampleId: 'REQ-WF-IMPORT-001.001' }, 10_000),
      action('restart-after-finish', 'restart', 'success', [2, 3], {}, 30_000)
    ]
  },
  {
    id: 'D07', name: '取消原生对话框后重试', risk: 'P1', fixture: 'import-mixed', timeoutMs: 240_000,
    actions: [
      action('import-cancelled', 'importRequest', 'cancelled', 0, { cancel: true }, 30_000),
      action('import-success', 'importRequest', 'success', 1, { path: 'imports/vertical.xlsx', kind: 'file', expectedValidCount: 1 }, 30_000),
      action('export-log-cancelled', 'exportLog', 'cancelled', 0, { cancel: true }, 30_000),
      action('export-log-success', 'exportLog', 'success', [0, 1], { path: 'exports/d07-log.xlsx' }, 30_000),
      action('backup-cancelled', 'backup', 'cancelled', 0, { cancel: true }, 30_000),
      action('backup-success', 'backup', 'success', [0, 1], { path: 'backups/d07.batterydata' }, 30_000),
      action('restore-cancelled', 'restore', 'cancelled', 0, { cancel: true }, 30_000),
      action('restore-success', 'restore', 'success', [0, 1], { path: 'backups/d07.batterydata', confirm: true }, 30_000)
    ]
  },
  {
    id: 'D08', name: '历史引用后维护名单', risk: 'P1', fixture: 'history', timeoutMs: 75_000,
    actions: [
      action('rename-tester', 'renameTester', 'success', 1, { name: 'WF tester', nextName: 'D08 已改名测试员' }, 10_000),
      action('delete-tester', 'deleteTester', 'success', 1, { name: 'D08 已改名测试员', confirm: true }, 10_000),
      action('navigate-requests', 'navigate', 'success', [0, 1], { label: '申请' }, 5_000),
      action('navigate-records', 'navigate', 'success', [0, 1], { label: '日志' }, 5_000),
      action('create-tester', 'createTester', 'success', 1, { name: 'D08 新测试员', dept: '测试部', phone: '00000000', note: '历史名单维护' }, 10_000),
      action('restart', 'restart', 'success', [2, 3], {}, 30_000)
    ]
  }
]);
