import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

import { MISUSE_WORKFLOWS } from './catalog-misuse.mjs';
import { normalizeWorkflow } from './contracts.mjs';

const require = createRequire(import.meta.url);
const devicePreset = require('../../lib/device-preset.js');

const C1 = '新威1#（16通道)|1-1';
const C2 = '新威1#（16通道)|1-2';

const action = (id, type, expect, revisionDelta, params, maxMs) => ({ id, type, expect, revisionDelta, params, maxMs });

function m08ChannelKey(index) {
  const group = Math.floor((index - 1) / 8) + 1;
  const position = ((index - 1) % 8) + 1;
  return `新威1#（16通道)|${group}-${position}`;
}

function m04Actions() {
  const pattern = [
    ['navigate-dashboard', 'navigate', 'success', [0, 1], { label: '看板' }],
    ['todo-next', 'nextPage', 'success', 0, { view: 'todo' }],
    ['todo-previous', 'previousPage', 'success', 0, { view: 'todo' }],
    ['navigate-apply', 'navigate', 'success', [0, 1], { label: '预约' }],
    ['request-next', 'nextPage', 'success', 0, { view: 'request' }],
    ['request-previous', 'previousPage', 'success', 0, { view: 'request' }],
    ['sample-next', 'nextPage', 'success', 0, { view: 'sample', requestNo: 'REQ-WF-M04-001' }],
    ['sample-previous', 'previousPage', 'success', 0, { view: 'sample' }],
    ['channel-next', 'nextPage', 'success', 0, { view: 'channel', sampleId: 'REQ-WF-M04-001.001' }],
    ['channel-previous', 'previousPage', 'success', 0, { view: 'channel' }],
    ['navigate-requests', 'navigate', 'success', [0, 1], { label: '申请' }],
    ['navigate-records', 'navigate', 'success', [0, 1], { label: '日志' }],
    ['records-next', 'nextPage', 'success', 0, { view: 'records' }],
    ['records-previous', 'previousPage', 'success', 0, { view: 'records' }],
    ['audits-next', 'nextPage', 'success', 0, { view: 'audits' }],
    ['audits-previous', 'previousPage', 'success', 0, { view: 'audits' }],
    ['navigate-devices', 'navigate', 'success', [0, 1], { label: '设备' }],
    ['channels-next', 'nextPage', 'success', 0, { view: 'channels' }],
    ['channels-previous', 'previousPage', 'success', 0, { view: 'channels' }],
    ['navigate-reserved', 'navigate', 'success', [0, 1], { label: '已预约' }]
  ];
  const actions = [];
  for (let cycle = 1; cycle <= 4; cycle += 1) {
    const omittedPagerSuffix = ['todo-previous', 'request-previous', 'records-previous', 'channels-previous'][cycle - 1];
    for (const [suffix, type, expect, revisionDelta, params] of pattern.filter(item => item[0] !== omittedPagerSuffix)) {
      actions.push(action(`cycle-${cycle}-${suffix}`, type, expect, revisionDelta, params, 5_000));
    }
    actions.push(action(
      `cycle-${cycle}-navigate-auxiliary`, 'navigate', 'success', [0, 1],
      { label: cycle % 2 === 1 ? '及时率' : '测试人员' }, 5_000
    ));
  }
  return actions;
}

function m08Actions() {
  const actions = [];
  for (let index = 1; index <= 15; index += 1) {
    const suffix = String(index).padStart(3, '0');
    const cancelSampleId = `REQ-WF-999.${String((index - 1) * 25 + 2).padStart(3, '0')}`;
    const sampleId = `REQ-WF-999.${String(index * 25 + 1).padStart(3, '0')}`;
    const channelKey = m08ChannelKey(index);
    actions.push(
      action(`round-${suffix}-open-picker-cancel`, 'selectSample', 'success', 0, { ...(index === 1 ? { requestNo: 'REQ-WF-999' } : {}), sampleId: cancelSampleId }, 5_000),
      action(`round-${suffix}-search-hostile`, 'search', 'success', 0, { label: '搜索设备、通道或量程', value: `新威${index}*\"` }, 5_000),
      action(`round-${suffix}-clear-search`, 'search', 'success', 0, { label: '搜索设备、通道或量程', value: '' }, 5_000),
      action(`round-${suffix}-channel-next`, 'nextPage', 'success', 0, { view: 'channel' }, 5_000),
      action(`round-${suffix}-channel-previous`, 'previousPage', 'success', 0, { view: 'channel' }, 5_000),
      action(`round-${suffix}-close-picker`, 'unselectSample', 'success', 0, { sampleId: cancelSampleId }, 5_000),
      action(`round-${suffix}-sample-next`, 'nextPage', 'success', 0, { view: 'sample' }, 5_000),
      action(`round-${suffix}-open-picker-assign`, 'selectSample', 'success', 0, { sampleId }, 5_000),
      action(`round-${suffix}-search-exact-channel`, 'search', 'success', 0, { label: '搜索设备、通道或量程', value: channelKey }, 5_000),
      action(`round-${suffix}-select-channel`, 'selectChannel', 'success', 0, { channelKey }, 5_000)
    );
  }
  return actions;
}

const EXPECTED = [
  {
    id: 'M01', name: '连续双击预约提交', risk: 'P0', fixture: 'baseline', timeoutMs: 45_000,
    actions: [
      action('reserve-double', 'reserve', 'success', 1, { requestNo: 'REQ-WF-M01-001', sampleIds: ['REQ-WF-M01-001.001'], channelKeys: [C1], double: true, confirm: true }, 15_000),
      action('restart', 'restart', 'success', [2, 3], {}, 30_000)
    ]
  },
  {
    id: 'M02', name: '连续双击待开始', risk: 'P0', fixture: 'baseline', timeoutMs: 55_000,
    actions: [
      action('reserve', 'reserve', 'success', 1, { requestNo: 'REQ-WF-M02-001', sampleIds: ['REQ-WF-M02-001.001'], channelKeys: [C1], confirm: true }, 15_000),
      action('start-todo-double', 'startTodo', 'success', 1, { sampleId: 'REQ-WF-M02-001.001', double: true }, 10_000),
      action('restart', 'restart', 'success', [2, 3], {}, 30_000)
    ]
  },
  {
    id: 'M03', name: '连续双击取消预约', risk: 'P0', fixture: 'baseline', timeoutMs: 55_000,
    actions: [
      action('reserve', 'reserve', 'success', 1, { requestNo: 'REQ-WF-M03-001', sampleIds: ['REQ-WF-M03-001.001'], channelKeys: [C1], confirm: true }, 15_000),
      action('cancel-todo-double', 'cancelTodo', 'success', 1, { sampleId: 'REQ-WF-M03-001.001', double: true, confirm: true }, 10_000),
      action('restart', 'restart', 'success', [2, 3], {}, 30_000)
    ]
  },
  {
    id: 'M04', name: '高速导航与翻页', risk: 'P1', fixture: 'history-2000', timeoutMs: 430_000,
    actions: [...m04Actions(), action('restart', 'restart', 'success', [2, 3], {}, 30_000)]
  },
  {
    id: 'M05', name: '双会话过期页面提交', risk: 'P0', fixture: 'baseline', timeoutMs: 95_000,
    actions: [
      action('open-session-b', 'openSecondSession', 'success', [0, 1, 2, 3], { prepareStale: { operation: 'reserve', requestNo: 'REQ-WF-M05-001', sampleIds: ['REQ-WF-M05-001.001'], channelKeys: [C1], start: '2026-08-27T09:00', end: '2026-08-27T10:00', username: 'WF tester B' } }, 30_000),
      action('reserve-session-a', 'reserve', 'success', 1, { session: 'A', requestNo: 'REQ-WF-M05-001', sampleIds: ['REQ-WF-M05-001.001'], channelKeys: [C1], start: '2026-08-27T09:00', end: '2026-08-27T10:00', confirm: true }, 15_000),
      action('stale-submit-session-b', 'staleSubmit', 'rejected', 0, { session: 'B', operation: 'reserve', requestNo: 'REQ-WF-M05-001', sampleIds: ['REQ-WF-M05-001.001'], channelKeys: [C1], start: '2026-08-27T09:00', end: '2026-08-27T10:00', confirm: true }, 10_000),
      action('reload-session-b', 'reloadCurrent', 'success', [2, 3], { session: 'B' }, 10_000),
      action('close-session-b', 'closeSecondSession', 'success', [0, 1], {}, 30_000)
    ]
  },
  {
    id: 'M06', name: '荒谬时间和文本', risk: 'P1', fixture: 'baseline', timeoutMs: 50_000,
    actions: [
      action('manage-end-before-start', 'manageRunning', 'rejected', 0, { sampleId: 'REQ-WF-M06-RUNNING-001.001', end: '2026-08-26T07:59', condition: '结束早于开始' }, 10_000),
      action('manage-extreme-past', 'manageRunning', 'rejected', 0, { sampleId: 'REQ-WF-M06-RUNNING-001.001', end: '0001-01-01T00:00', condition: '极远过去' }, 10_000),
      action('manage-extreme-future', 'manageRunning', 'rejected', 0, { sampleId: 'REQ-WF-M06-RUNNING-001.001', end: '9999-12-31T23:59', condition: '极远未来' }, 10_000),
      action('navigate-records-for-hostile-search', 'navigate', 'success', [0, 1], { label: '日志' }, 5_000),
      action('hostile-search', 'search', 'success', 0, { label: '搜索申请、样品、项目、通道或人员', value: `${'超长中文'.repeat(80)}\n\"'_*%` }, 5_000),
      action('whitespace-edit', 'editExecution', 'rejected', 0, { requestNo: 'REQ-WF-M06-RUNNING-001', fields: { '备注': '   ' } }, 10_000)
    ]
  },
  {
    id: 'M07', name: '删除活动资源与历史人员', risk: 'P0', fixture: 'history', timeoutMs: 80_000,
    actions: [
      action('delete-active-request', 'deleteRequest', 'rejected', 0, { requestNo: 'REQ-WF-M07-ACTIVE-001', confirm: true }, 10_000),
      action('delete-active-storage-request', 'deleteRequest', 'rejected', 0, { requestNo: 'REQ-WF-M07-STORAGE-001', confirm: true }, 10_000),
      action('delete-active-device', 'deleteResource', 'rejected', 0, { kind: 'device', name: '新威1#（16通道)', confirm: true }, 10_000),
      action('delete-active-channel', 'deleteResource', 'rejected', 0, { kind: 'channel', name: C1, confirm: true }, 10_000),
      action('delete-history-tester', 'deleteTester', 'success', 1, { name: 'WF tester', confirm: true }, 10_000),
      action('restart', 'restart', 'success', [2, 3], {}, 30_000)
    ]
  },
  {
    id: 'M08', name: '999 子样品跨页乱序选择', risk: 'P1', fixture: 'production-999', timeoutMs: 805_000,
    actions: [
      action('navigate-apply-for-selection-chain', 'navigate', 'success', [0, 1], { label: '预约' }, 5_000),
      ...m08Actions(),
      action('reserve-prepared', 'reserve', 'success', 1, {
        requestNo: 'REQ-WF-999',
        sampleIds: Array.from({ length: 15 }, (_, index) => `REQ-WF-999.${String((index + 1) * 25 + 1).padStart(3, '0')}`),
        channelKeys: Array.from({ length: 15 }, (_, index) => m08ChannelKey(index + 1)),
        usePrepared: true,
        confirm: true
      }, 15_000),
      action('restart', 'restart', 'success', [2, 3], {}, 30_000)
    ]
  },
  {
    id: 'M09', name: '重复与损坏导入', risk: 'P0', fixture: 'import-mixed', timeoutMs: 150_000,
    actions: [
      action('import-valid', 'importRequest', 'success', 1, { path: 'imports/vertical.xlsx', kind: 'file', expectedValidCount: 1 }, 30_000),
      action('import-duplicate-skip', 'importRequest', 'success', 1, { path: 'imports/vertical.xlsx', kind: 'file', duplicatePolicy: 'skip', expectedValidCount: 1 }, 30_000),
      action('import-duplicate-overwrite', 'importRequest', 'success', 1, { path: 'imports/vertical.xlsx', kind: 'file', duplicatePolicy: 'cover', expectedValidCount: 1 }, 30_000),
      action('import-mixed-invalid', 'importRequest', 'cancelled', 0, { path: 'imports', kind: 'folder', invalidConfirm: false, duplicatePolicy: 'skip', expectedValidCount: 4 }, 30_000),
      action('restart', 'restart', 'success', [2, 3], {}, 30_000)
    ]
  },
  {
    id: 'M10', name: '重复取消与重试文件操作', risk: 'P1', fixture: 'history', timeoutMs: 360_000,
    actions: [
      action('export-cancel-1', 'exportLog', 'cancelled', 0, { cancel: true }, 30_000),
      action('export-cancel-2', 'exportLog', 'cancelled', 0, { cancel: true }, 30_000),
      action('export-success-1', 'exportLog', 'success', [0, 1], { path: 'exports/m10-log-1.xlsx' }, 30_000),
      action('export-success-2', 'exportLog', 'success', [0, 1], { path: 'exports/m10-log-2.xlsx' }, 30_000),
      action('backup-cancel-1', 'backup', 'cancelled', 0, { cancel: true }, 30_000),
      action('backup-cancel-2', 'backup', 'cancelled', 0, { cancel: true }, 30_000),
      action('backup-success-1', 'backup', 'success', [0, 1], { path: 'backups/m10-1.batterydata' }, 30_000),
      action('backup-success-2', 'backup', 'success', [0, 1], { path: 'backups/m10-2.batterydata' }, 30_000),
      action('restore-cancel-1', 'restore', 'cancelled', 0, { cancel: true }, 30_000),
      action('restore-cancel-2', 'restore', 'cancelled', 0, { cancel: true }, 30_000),
      action('restore-success-1', 'restore', 'success', [0, 1], { path: 'backups/m10-1.batterydata', confirm: true }, 30_000),
      action('restore-success-2', 'restore', 'success', [0, 1], { path: 'backups/m10-2.batterydata', confirm: true }, 30_000)
    ]
  },
  {
    id: 'M11', name: '结束后继续使用旧 DOM', risk: 'P0', fixture: 'history', timeoutMs: 65_000,
    actions: [
      { ...action('retain-old-dom', 'retainOldDom', 'success', 3, { targets: [
        { type: 'manageRunning', sampleId: 'REQ-WF-M11-RUNNING-001.001', channelKey: C1 },
        { type: 'startTodo', sampleId: 'REQ-WF-M11-RESERVED-001.001' },
        { type: 'cancelTodo', sampleId: 'REQ-WF-M11-RESERVED-001.001' }
      ] }, 5_000), evidenceRevisionDelta: 0 },
      action('finish-running', 'finishRunning', 'success', 1, { sampleId: 'REQ-WF-M11-RUNNING-001.001' }, 10_000),
      action('manage-running-old', 'manageRunning', 'rejected', 0, { sampleId: 'REQ-WF-M11-RUNNING-001.001', old: true }, 10_000),
      { ...action('start-todo-old', 'startTodo', 'rejected', [0, 1], { sampleId: 'REQ-WF-M11-RESERVED-001.001', old: true }, 10_000), evidenceRevisionDelta: 0 },
      action('cancel-todo-old', 'cancelTodo', 'rejected', 0, { sampleId: 'REQ-WF-M11-RESERVED-001.001', old: true }, 10_000),
      action('reload-current', 'reloadCurrent', 'success', [2, 3], {}, 10_000)
    ]
  },
  {
    id: 'M12', name: '写入失败后继续工作', risk: 'P0', fixture: 'baseline', timeoutMs: 95_000,
    actions: [
      action('locked-reserve', 'lockedWrite', 'rejected', 0, { operation: 'reserve', requestNo: 'REQ-WF-M12-PENDING-001', sampleIds: ['REQ-WF-M12-PENDING-001.001'], channelKeys: [C2], confirm: true }, 20_000),
      action('reserve-after-release', 'reserve', 'success', 1, { requestNo: 'REQ-WF-M12-PENDING-001', sampleIds: ['REQ-WF-M12-PENDING-001.001'], channelKeys: [C2], confirm: true }, 15_000),
      action('locked-manage-running', 'lockedWrite', 'rejected', 0, { operation: 'manageRunning', sampleId: 'REQ-WF-M12-RUNNING-001.001', channelKey: C1, endOffsetMinutes: 60, condition: '锁失败不应采用' }, 20_000),
      action('manage-after-release', 'manageRunning', 'success', 1, { sampleId: 'REQ-WF-M12-RUNNING-001.001', channelKey: C1, endOffsetMinutes: 90, condition: '解除锁后保存' }, 10_000),
      action('restart', 'restart', 'success', [2, 3], {}, 30_000)
    ]
  }
];

test('误操作目录逐字段精确声明 M01-M12', () => {
  assert.deepEqual(MISUSE_WORKFLOWS.map(item => normalizeWorkflow(item)), EXPECTED);
  assert.deepEqual(MISUSE_WORKFLOWS.map(item => item.id), Array.from({ length: 12 }, (_, index) => `M${String(index + 1).padStart(2, '0')}`));
});

test('80 步导航、150 步选择和文件重试数量不能缩水', () => {
  const byId = Object.fromEntries(MISUSE_WORKFLOWS.map(item => [item.id, item]));
  assert.equal(byId.M04.actions.slice(0, -1).length, 80);
  assert.deepEqual([...new Set(byId.M04.actions.filter(item => item.type === 'navigate').map(item => item.params.label))].sort(), ['及时率', '已预约', '测试人员', '看板', '申请', '设备', '预约', '日志'].sort());
  assert.equal(byId.M08.actions.length, 153);
  assert.equal(byId.M08.actions.slice(1, 151).length, 150);
  assert.equal(byId.M08.actions.some(item => item.type === 'unselectChannel'), false);
  assert.equal(byId.M08.actions.at(-2).params.usePrepared, true);
  assert.deepEqual(byId.M08.actions.at(-2).params.sampleIds, Array.from({ length: 15 }, (_, index) => `REQ-WF-999.${String((index + 1) * 25 + 1).padStart(3, '0')}`));
  assert.deepEqual(byId.M10.actions.map(item => item.type), [
    'exportLog', 'exportLog', 'exportLog', 'exportLog',
    'backup', 'backup', 'backup', 'backup',
    'restore', 'restore', 'restore', 'restore'
  ]);
});

test('M08 的十五个选择目标均为真实且互异的生产通道', () => {
  const workflow = MISUSE_WORKFLOWS.find(item => item.id === 'M08');
  const selectedChannelKeys = workflow.actions
    .filter(item => item.type === 'selectChannel')
    .map(item => item.params.channelKey);
  const knownChannelKeys = new Set(devicePreset.channels().map(item => item.key));

  assert.equal(selectedChannelKeys.length, 15);
  assert.equal(new Set(selectedChannelKeys).size, 15);
  assert.deepEqual(selectedChannelKeys.filter(key => !knownChannelKeys.has(key)), []);
  assert.deepEqual(workflow.actions.at(-2).params.channelKeys, selectedChannelKeys);
});

test('每条误操作 workflow 归一化、动作 ID 唯一且预算覆盖全部动作', () => {
  for (const workflow of MISUSE_WORKFLOWS) {
    assert.doesNotThrow(() => normalizeWorkflow(workflow), workflow.id);
    assert.equal(new Set(workflow.actions.map(item => item.id)).size, workflow.actions.length, `${workflow.id} action ids`);
    assert.ok(workflow.timeoutMs >= workflow.actions.reduce((sum, item) => sum + item.maxMs, 0), `${workflow.id} timeout`);
  }
});

test('误操作目录及其嵌套参数递归冻结', () => {
  assert.equal(Object.isFrozen(MISUSE_WORKFLOWS), true);
  for (const workflow of MISUSE_WORKFLOWS) {
    assert.equal(Object.isFrozen(workflow), true, workflow.id);
    assert.equal(Object.isFrozen(workflow.actions), true, `${workflow.id} actions`);
    for (const item of workflow.actions) {
      assert.equal(Object.isFrozen(item), true, `${workflow.id}/${item.id}`);
      assert.equal(Object.isFrozen(item.params), true, `${workflow.id}/${item.id} params`);
    }
  }
});

test('M07 同时拒绝删除活动普通测试与 storage 来源申请', () => {
  const m07 = MISUSE_WORKFLOWS.find(item => item.id === 'M07');
  assert.deepEqual(m07.actions.slice(0, 2).map(item => item.params.requestNo), [
    'REQ-WF-M07-ACTIVE-001', 'REQ-WF-M07-STORAGE-001'
  ]);
  assert.deepEqual(m07.actions.slice(0, 2).map(item => item.expect), ['rejected', 'rejected']);
});

test('M06 将 records 导航与零写入的 hostile 搜索分离', () => {
  const m06 = MISUSE_WORKFLOWS.find(item => item.id === 'M06');
  const navigateIndex = m06.actions.findIndex(item => item.id === 'navigate-records-for-hostile-search');
  const search = m06.actions.find(item => item.id === 'hostile-search');
  assert.ok(navigateIndex >= 0);
  assert.deepEqual(m06.actions[navigateIndex], {
    id: 'navigate-records-for-hostile-search', type: 'navigate', expect: 'success', revisionDelta: [0, 1],
    params: { label: '日志' }, maxMs: 5_000
  });
  assert.equal(m06.actions[navigateIndex + 1], search);
  assert.equal(search.revisionDelta, 0);
  assert.equal(Object.hasOwn(search.params, 'targetPage'), false);
});

test('M12 管理运行用不同的正相对结束时间，避免固定日期干扰锁语义', () => {
  const m12 = MISUSE_WORKFLOWS.find(item => item.id === 'M12');
  const locked = m12.actions.find(item => item.id === 'locked-manage-running');
  const released = m12.actions.find(item => item.id === 'manage-after-release');
  assert.equal(locked.params.endOffsetMinutes > 0, true);
  assert.equal(released.params.endOffsetMinutes > 0, true);
  assert.notEqual(locked.params.endOffsetMinutes, released.params.endOffsetMinutes);
  assert.equal(Object.hasOwn(locked.params, 'end'), false);
  assert.equal(Object.hasOwn(released.params, 'end'), false);
});

test('M08 显式进入 apply 后再执行原有 150 步零写入选择链', () => {
  const m08 = MISUSE_WORKFLOWS.find(item => item.id === 'M08');
  assert.deepEqual(m08.actions[0], {
    id: 'navigate-apply-for-selection-chain', type: 'navigate', expect: 'success', revisionDelta: [0, 1],
    params: { label: '预约' }, maxMs: 5_000
  });
  assert.equal(m08.actions[1].id, 'round-001-open-picker-cancel');
  assert.equal(m08.actions[1].revisionDelta, 0);
  assert.equal(m08.actions.slice(1, 151).length, 150);
  assert.ok(m08.actions.slice(1, 151).every(item => item.revisionDelta === 0));
});
