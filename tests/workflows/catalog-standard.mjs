function freeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const item of Object.values(value)) freeze(item);
  return Object.freeze(value);
}

const CHANNELS = Object.freeze({
  first: '新威1#（16通道)|1-1',
  second: '新威1#（16通道)|1-2',
  third: '新威1#（16通道)|1-3'
});

export const STANDARD_WORKFLOWS = freeze([
  {
    id: 'S01', name: '完整申请生命周期', risk: 'P0', fixture: 'import-mixed', timeoutMs: 180_000,
    actions: [
      { id: 'import-vertical', type: 'importRequest', expect: 'success', revisionDelta: 1, params: { path: 'imports/vertical.xlsx', kind: 'file', expectedValidCount: 1 }, maxMs: 30_000 },
      { id: 'edit-execution', type: 'editExecution', expect: 'success', revisionDelta: 1, params: { requestNo: 'REQ-WF-IMPORT-001', fields: { '备注': 'S01 已核对' } }, maxMs: 10_000 },
      { id: 'reserve', type: 'reserve', expect: 'success', revisionDelta: 1, params: { requestNo: 'REQ-WF-IMPORT-001', sampleIds: ['REQ-WF-IMPORT-001.001'], channelKeys: [CHANNELS.first], confirm: true }, maxMs: 15_000 },
      { id: 'start-todo', type: 'startTodo', expect: 'success', revisionDelta: 1, params: { sampleId: 'REQ-WF-IMPORT-001.001' }, maxMs: 10_000 },
      { id: 'manage-running', type: 'manageRunning', expect: 'success', revisionDelta: 1, params: { sampleId: 'REQ-WF-IMPORT-001.001', endOffsetMinutes: 60, condition: '等待样品复核' }, maxMs: 10_000 },
      { id: 'navigate-running-samples', type: 'navigate', expect: 'success', revisionDelta: [0, 1], params: { label: '正在测试样品' }, maxMs: 5_000 },
      { id: 'search-running-sample', type: 'search', expect: 'success', revisionDelta: 0, params: { label: '精确搜索申请号或子样品号；其它字段支持包含搜索', value: '  req-wf-import-001.001  ', identity: 'sampleId', expectedVisibleIds: ['REQ-WF-IMPORT-001.001'] }, maxMs: 5_000 },
      { id: 'return-running', type: 'returnRunning', expect: 'success', revisionDelta: 1, params: { sampleId: 'REQ-WF-IMPORT-001.001', reason: 'S01 退回补充申请资料', confirm: true }, maxMs: 10_000 },
      { id: 'navigate-records', type: 'navigate', expect: 'success', revisionDelta: [0, 1], params: { label: '日志' }, maxMs: 5_000 },
      { id: 'export-log', type: 'exportLog', expect: 'success', revisionDelta: [0, 1], params: { path: 'exports/s01-log.xlsx' }, maxMs: 30_000 },
      { id: 'restart', type: 'restart', expect: 'success', revisionDelta: [2, 3], params: {}, maxMs: 30_000 }
    ]
  },
  {
    id: 'S02', name: '预约 TODO 开始', risk: 'P0', fixture: 'baseline', timeoutMs: 75_000,
    actions: [
      { id: 'reserve', type: 'reserve', expect: 'success', revisionDelta: 1, params: { requestNo: 'REQ-WF-003', sampleIds: ['REQ-WF-003.001'], channelKeys: [CHANNELS.first], confirm: true }, maxMs: 15_000 },
      { id: 'navigate-dashboard', type: 'navigate', expect: 'success', revisionDelta: [0, 1], params: { label: '看板' }, maxMs: 5_000 },
      { id: 'start-todo', type: 'startTodo', expect: 'success', revisionDelta: 1, params: { sampleId: 'REQ-WF-003.001' }, maxMs: 10_000 },
      { id: 'restart', type: 'restart', expect: 'success', revisionDelta: [2, 3], params: {}, maxMs: 30_000 }
    ]
  },
  {
    id: 'S03', name: '预约 TODO 取消', risk: 'P0', fixture: 'baseline', timeoutMs: 75_000,
    actions: [
      { id: 'reserve', type: 'reserve', expect: 'success', revisionDelta: 1, params: { requestNo: 'REQ-WF-003', sampleIds: ['REQ-WF-003.001'], channelKeys: [CHANNELS.first], confirm: true }, maxMs: 15_000 },
      { id: 'cancel-rejected', type: 'cancelTodo', expect: 'cancelled', revisionDelta: 0, params: { sampleId: 'REQ-WF-003.001', confirm: false }, maxMs: 10_000 },
      { id: 'cancel-confirmed', type: 'cancelTodo', expect: 'success', revisionDelta: 1, params: { sampleId: 'REQ-WF-003.001', confirm: true }, maxMs: 10_000 },
      { id: 'restart', type: 'restart', expect: 'success', revisionDelta: [2, 3], params: {}, maxMs: 30_000 }
    ]
  },
  {
    id: 'S04', name: '多样品混合处理', risk: 'P0', fixture: 'baseline', timeoutMs: 120_000,
    actions: [
      { id: 'start-001', type: 'startImmediately', expect: 'success', revisionDelta: 1, params: { requestNo: 'REQ-WF-003', sampleIds: ['REQ-WF-003.001'], channelKeys: [CHANNELS.first], confirm: true }, maxMs: 15_000 },
      { id: 'reserve-002', type: 'reserve', expect: 'success', revisionDelta: 1, params: { requestNo: 'REQ-WF-003', sampleIds: ['REQ-WF-003.002'], channelKeys: [CHANNELS.second], confirm: true }, maxMs: 15_000 },
      { id: 'reserve-003', type: 'reserve', expect: 'success', revisionDelta: 1, params: { requestNo: 'REQ-WF-003', sampleIds: ['REQ-WF-003.003'], channelKeys: [CHANNELS.third], confirm: true }, maxMs: 15_000 },
      { id: 'cancel-003', type: 'cancelTodo', expect: 'success', revisionDelta: 1, params: { sampleId: 'REQ-WF-003.003', confirm: true }, maxMs: 10_000 },
      { id: 'finish-001', type: 'finishRunning', expect: 'success', revisionDelta: 1, params: { sampleId: 'REQ-WF-003.001' }, maxMs: 10_000 },
      { id: 'start-002', type: 'startTodo', expect: 'success', revisionDelta: 1, params: { sampleId: 'REQ-WF-003.002' }, maxMs: 10_000 },
      { id: 'restart', type: 'restart', expect: 'success', revisionDelta: [2, 3], params: {}, maxMs: 30_000 }
    ]
  },
  {
    id: 'S05', name: '运行后排队预约', risk: 'P0', fixture: 'queue', timeoutMs: 75_000,
    actions: [
      { id: 'reserve-next', type: 'reserve', expect: 'success', revisionDelta: 1, params: { requestNo: 'REQ-WF-QUEUE-NEXT-001', sampleIds: ['REQ-WF-QUEUE-NEXT-001.001'], channelKeys: [CHANNELS.first], confirm: true }, maxMs: 15_000 },
      { id: 'finish-current', type: 'finishRunning', expect: 'success', revisionDelta: 1, params: { sampleId: 'REQ-WF-RUNNING-001.001', expectedPointers: { channelKey: CHANNELS.first, currentRecordId: null, nextSampleId: 'REQ-WF-QUEUE-NEXT-001.001' } }, maxMs: 10_000 },
      { id: 'start-next', type: 'startTodo', expect: 'success', revisionDelta: 1, params: { sampleId: 'REQ-WF-QUEUE-NEXT-001.001', expectedPointers: { channelKey: CHANNELS.first, currentSampleId: 'REQ-WF-QUEUE-NEXT-001.001', nextRecordId: null } }, maxMs: 10_000 },
      { id: 'restart', type: 'restart', expect: 'success', revisionDelta: [2, 3], params: {}, maxMs: 30_000 }
    ]
  },
  {
    id: 'S06', name: '设备、通道和人员维护', risk: 'P1', fixture: 'history', timeoutMs: 135_000,
    actions: [
      { id: 'create-tester', type: 'createTester', expect: 'success', revisionDelta: 1, params: { name: 'S06 临时测试员', dept: '测试部', phone: '00000000', note: '标准流程临时数据' }, maxMs: 10_000 },
      { id: 'create-device', type: 'createDevice', expect: 'success', revisionDelta: 1, params: { name: 'S06 临时设备', manufacturer: 'WF', temperature: '常温', note: '标准流程临时数据' }, maxMs: 10_000 },
      { id: 'create-channel', type: 'createChannel', expect: 'success', revisionDelta: 1, params: { device: 'S06 临时设备', name: 'S06-01', temperature: '常温', note: '标准流程临时数据' }, maxMs: 10_000 },
      { id: 'start-immediately', type: 'startImmediately', expect: 'success', revisionDelta: 1, params: { requestNo: 'REQ-WF-100', sampleIds: ['REQ-WF-100.001'], channelKeys: [CHANNELS.first], confirm: true }, maxMs: 15_000 },
      { id: 'finish-running', type: 'finishRunning', expect: 'success', revisionDelta: 1, params: { sampleId: 'REQ-WF-100.001' }, maxMs: 10_000 },
      { id: 'rename-tester', type: 'renameTester', expect: 'success', revisionDelta: 1, params: { name: 'S06 临时测试员', nextName: 'S06 已改名测试员' }, maxMs: 10_000 },
      { id: 'delete-channel', type: 'deleteResource', expect: 'success', revisionDelta: 1, params: { kind: 'channel', name: 'S06 临时设备|S06-01', confirm: true }, maxMs: 10_000 },
      { id: 'restart', type: 'restart', expect: 'success', revisionDelta: [2, 3], params: {}, maxMs: 30_000 }
    ]
  },
  {
    id: 'S07', name: '导入、编辑和导出闭环', risk: 'P0', fixture: 'import-mixed', timeoutMs: 160_000,
    actions: [
      { id: 'import-vertical', type: 'importRequest', expect: 'success', revisionDelta: 1, params: { path: 'imports/vertical.xlsx', kind: 'file', expectedValidCount: 1 }, maxMs: 30_000 },
      { id: 'import-flat', type: 'importRequest', expect: 'success', revisionDelta: 1, params: { path: 'imports/flat.xlsx', kind: 'file', expectedValidCount: 1 }, maxMs: 30_000 },
      { id: 'edit-execution', type: 'editExecution', expect: 'success', revisionDelta: 1, params: { requestNo: 'REQ-WF-IMPORT-001', fields: { '备注': 'S07 已核对' } }, maxMs: 10_000 },
      { id: 'export-cancelled', type: 'exportRequest', expect: 'cancelled', revisionDelta: 0, params: { cancel: true }, maxMs: 30_000 },
      { id: 'export-success', type: 'exportRequest', expect: 'success', revisionDelta: [0, 1], params: { path: 'exports/s07-requests.xlsx' }, maxMs: 30_000 },
      { id: 'restart', type: 'restart', expect: 'success', revisionDelta: [2, 3], params: {}, maxMs: 30_000 }
    ]
  },
  {
    id: 'S08', name: '备份与恢复闭环', risk: 'P0', fixture: 'history', timeoutMs: 180_000,
    actions: [
      { id: 'edit-execution', type: 'editExecution', expect: 'success', revisionDelta: 1, params: { requestNo: 'REQ-WF-100', fields: { '备注': 'S08 备份前修改' } }, maxMs: 10_000 },
      { id: 'start-storage', type: 'startStorage', expect: 'success', revisionDelta: 1, params: { storageId: 'STO-WF-S08-001', requestNo: 'REQ-WF-S08-STORAGE-001', sampleIds: ['REQ-WF-S08-STORAGE-001.001'], tester: 'Workflow S08', expectedEndAt: '2026-09-30T12:00:00.000Z', note: 'S08 长期存储' }, maxMs: 15_000 },
      { id: 'navigate-storage-samples', type: 'navigate', expect: 'success', revisionDelta: [0, 1], params: { label: '长期存储样品' }, maxMs: 5_000 },
      { id: 'search-storage-sample', type: 'search', expect: 'success', revisionDelta: 0, params: { label: '精确搜索申请号或子样品号；其它字段支持包含搜索', value: '  req-wf-s08-storage-001.001  ', identity: 'sampleId', expectedVisibleIds: ['REQ-WF-S08-STORAGE-001.001'] }, maxMs: 5_000 },
      { id: 'update-storage', type: 'updateStorage', expect: 'success', revisionDelta: 1, params: { storageId: 'STO-WF-S08-001', status: 'exception', expectedEndAt: '2026-10-15T12:00:00.000Z', note: 'S08 异常待复核' }, maxMs: 10_000 },
      { id: 'backup', type: 'backup', expect: 'success', revisionDelta: [0, 1], params: { path: 'backups/s08.batterydata' }, maxMs: 30_000 },
      { id: 'finish-storage', type: 'finishStorage', expect: 'success', revisionDelta: 1, params: { storageId: 'STO-WF-S08-001', confirm: true }, maxMs: 10_000 },
      { id: 'create-tester', type: 'createTester', expect: 'success', revisionDelta: 1, params: { name: 'S08 恢复前测试员', dept: '测试部', phone: '00000000', note: '待恢复数据' }, maxMs: 10_000 },
      { id: 'restore', type: 'restore', expect: 'success', revisionDelta: [0, 1], params: { path: 'backups/s08.batterydata', confirm: true }, maxMs: 30_000 },
      { id: 'return-storage', type: 'returnStorage', expect: 'success', revisionDelta: 1, params: { storageId: 'STO-WF-S08-001', reason: 'S08 退回补充申请资料', confirm: true }, maxMs: 10_000 },
      { id: 'restart', type: 'restart', expect: 'success', revisionDelta: [2, 3], params: {}, maxMs: 30_000 }
    ]
  }
]);
