import assert from 'node:assert/strict';
import test from 'node:test';

import { checkWorkflowInvariants } from './invariants.mjs';
import { canonicalStateHash, summarizeState } from './state-probe.mjs';

function validState(revision = 4) {
  return {
    revision,
    savedAt: '2026-08-22T08:00:00.000Z',
    deviceProfiles: [{ id: 'D-1', name: '设备 A' }],
    requests: [
      { id: 'REQ-1', rawFields: { 委托单号: 'REQ-1' }, sourceFile: 'a.xlsx', sourcePath: 'C:/imports/a.xlsx' },
      { id: 'REQ-2', rawFields: { 委托单号: 'REQ-2' }, sourceFile: 'b.xlsx', sourcePath: 'C:/imports/b.xlsx' }
    ],
    channels: [
      { key: '设备 A|001', state: 'busy', currentRecordId: 'REC-1', nextRecordId: '' },
      { key: '设备 A|002', state: 'booked', currentRecordId: '', nextRecordId: 'REC-2' },
      { key: '设备 A|003', state: 'free', currentRecordId: '', nextRecordId: '' }
    ],
    samples: [
      { id: 'REQ-1.001', requestNo: 'REQ-1', status: 'running', channelKey: '设备 A|001' },
      { id: 'REQ-2.001', requestNo: 'REQ-2', status: 'reserved', channelKey: '设备 A|002' },
      { id: 'REQ-1.002', requestNo: 'REQ-1', status: 'completed', channelKey: '设备 A|003' }
    ],
    records: [
      { id: 'REC-1', requestNo: 'REQ-1', sampleId: 'REQ-1.001', channelKey: '设备 A|001', status: 'running' },
      { id: 'REC-2', requestNo: 'REQ-2', sampleId: 'REQ-2.001', channelKey: '设备 A|002', status: 'reserved' },
      { id: 'REC-3', requestNo: 'REQ-1', sampleId: 'REQ-1.002', channelKey: '设备 A|003', status: 'completed' }
    ],
    requestSourceRows: [
      { id: 'REQ-1', requestNo: 'REQ-1', sourceFile: 'a.xlsx', sourcePath: 'C:/imports/a.xlsx' },
      { id: 'REQ-2', requestNo: 'REQ-2', sourceFile: 'b.xlsx', sourcePath: 'C:/imports/b.xlsx' }
    ],
    auditLogs: [{
      id: 'AUDIT-1', action: '开始测试', target: 'REC-1', outcome: 'success', result: 'success', verified: true
    }],
    formChangeJournal: [],
    testers: [],
    storageRecords: []
  };
}

function snapshot(state, overrides = {}) {
  return {
    integrity: ['ok'],
    state,
    auditLogs: structuredClone(state.auditLogs || []),
    formJournal: [],
    summary: summarizeState(state),
    hash: canonicalStateHash(state),
    ...overrides
  };
}

function validInput() {
  const beforeState = validState(4);
  const afterState = validState(5);
  const before = snapshot(beforeState);
  const after = snapshot(afterState);
  return {
    before,
    after,
    action: { id: 'start', type: 'start', expect: 'success', outcome: 'success', revisionDelta: 1 },
    ui: {
      projection: {
        currentPage: 'dashboard',
        summary: structuredClone(after.summary),
        visible: {
          records: [{ id: 'REC-1', status: 'running' }],
          samples: [{ id: 'REQ-1.001', status: 'running' }],
          channels: [{ key: '设备 A|001', state: 'busy' }],
          todos: [{ id: 'REC-2', status: 'reserved' }],
          storageRecords: []
        }
      },
      renderedChannelCards: 529,
      consoleErrors: [],
      unhandledRejections: [],
      externalRequests: []
    },
    restart: { hash: after.hash }
  };
}

function codes(input) {
  return checkWorkflowInvariants(input).map(item => item.code).sort();
}

test('完整一致的工作流快照不产生 violation，navigate 接受 [0,1]', () => {
  const input = validInput();
  assert.deepEqual(checkWorkflowInvariants(input), []);

  input.action = { id: 'navigate', type: 'navigate', expect: 'success', outcome: 'success', revisionDelta: [0, 1] };
  input.after.state.revision = input.before.state.revision;
  input.ui.projection.summary = summarizeState(input.after.state);
  assert.deepEqual(checkWorkflowInvariants(input), []);
});

test('同一通道合法 current running 与 next reserved 共存不算重复占用', () => {
  const input = validInput();
  input.after.state.channels[0].nextRecordId = 'REC-2';
  Object.assign(input.after.state.channels[1], { state: 'free', nextRecordId: '' });
  input.after.state.records[1].channelKey = '设备 A|001';
  input.after.state.samples[1].channelKey = '设备 A|001';
  input.ui = null;
  input.restart = null;

  assert.deepEqual(checkWorkflowInvariants(input), []);
});

test('storage 不变量拒绝活动重复、普通冲突、通道引用、状态分裂和通道突变', () => {
  const input = validInput(); input.ui = null; input.restart = null;
  input.after.state.samples.push({ id: 'REQ-STO.001', status: 'storing' }, { id: 'REQ-STO.002', status: 'running' });
  input.after.state.records.push({ id: 'REC-STO-CONFLICT', sampleId: 'REQ-STO.002', channelKey: '设备 A|003', status: 'running' });
  input.after.state.storageRecords = [
    { id: 'STO-1', sampleIds: ['REQ-STO.001', 'REQ-STO.002'], status: 'storing', channelKey: '设备 A|001' },
    { id: 'STO-2', sampleIds: ['REQ-STO.001'], status: 'exception' }
  ];
  input.after.state.channels[2].note = 'mutated'; input.action.type = 'startStorage';
  const relevant = codes(input).filter(code => code.startsWith('STORAGE') || code === 'SAMPLE_ACTIVE_ASSIGNMENT_CONFLICT');
  assert.deepEqual(relevant, ['SAMPLE_ACTIVE_ASSIGNMENT_CONFLICT', 'STORAGE_CHANNEL_MUTATION', 'STORAGE_CHANNEL_REFERENCE', 'STORAGE_SAMPLE_ACTIVE_DUPLICATE', 'STORAGE_SAMPLE_STATUS_SPLIT']);
});

test('合法 storage 完成保持通道字节且 returned 普通记录释放指针', () => {
  const input = validInput(); input.ui = null; input.restart = null; input.action.type = 'finishStorage';
  input.before.state.storageRecords = [{ id: 'STO-1', sampleIds: ['REQ-STO.001'], status: 'storing' }];
  input.before.state.samples.push({ id: 'REQ-STO.001', status: 'storing' });
  input.after.state.storageRecords = [{ id: 'STO-1', sampleIds: ['REQ-STO.001'], status: 'completed' }];
  input.after.state.samples.push({ id: 'REQ-STO.001', status: 'completed' });
  assert.deepEqual(checkWorkflowInvariants(input), []);
  input.after.state.records[0].status = 'returned'; input.after.state.samples[0].status = 'pending'; input.after.state.samples[0].channelKey = '';
  Object.assign(input.after.state.channels[0], { state: 'free', currentRecordId: '' });
  assert.equal(codes(input).includes('RUNNING_POINTER_SPLIT'), false);
});

test('不变量同时报告 running 指针分裂、重复通道占用和来源覆盖', () => {
  const input = validInput();
  input.after.state.channels[0].currentRecordId = 'REC-MISSING';
  input.after.state.records.push({
    id: 'REC-DUPLICATE', requestNo: 'REQ-2', sampleId: 'REQ-2.002', channelKey: '设备 A|001', status: 'running'
  });
  input.after.state.samples.push({ id: 'REQ-2.002', requestNo: 'REQ-2', status: 'running', channelKey: '设备 A|001' });
  input.after.state.requests[0].rawFields.委托单号 = 'COVERED';

  const violations = checkWorkflowInvariants({ ...input, ui: null, restart: null });

  assert.deepEqual(violations.map(item => item.code).sort(), [
    'CHANNEL_ACTIVE_DUPLICATE', 'RAW_FIELDS_CHANGED', 'RUNNING_POINTER_SPLIT'
  ]);
  assert.ok(violations.every(item => item.severity === 'P0'));
});

test('SQLite integrity、动作结果和 revision 分别报告具体 P0', () => {
  const integrity = validInput();
  integrity.after.integrity = ['database disk image is malformed'];
  integrity.ui = null;
  assert.deepEqual(codes(integrity), ['SQLITE_INTEGRITY']);

  const outcome = validInput();
  outcome.action.outcome = 'rejected';
  outcome.ui = null;
  assert.deepEqual(codes(outcome), ['ACTION_OUTCOME']);

  const revision = validInput();
  revision.after.state.revision = 7;
  revision.ui = null;
  assert.deepEqual(codes(revision), ['REVISION_DELTA']);
});

test('声明预期结果但执行器漏传实际 outcome 时不能静默通过', () => {
  const input = validInput();
  delete input.action.outcome;
  input.ui = null;

  assert.deepEqual(codes(input), ['ACTION_OUTCOME']);
});

test('reserved/next 分裂与取消或完成后未释放分别报告具体 P0', () => {
  const reserved = validInput();
  reserved.after.state.channels[1].nextRecordId = '';
  assert.deepEqual(codes(reserved), ['RESERVED_POINTER_SPLIT']);

  const terminal = validInput();
  terminal.after.state.channels[2].currentRecordId = 'REC-3';
  assert.deepEqual(codes(terminal), ['TERMINAL_CHANNEL_NOT_RELEASED']);
});

test('busy/current 与 booked/next 的反向指针缺损均产生 P0', () => {
  const cases = [
    ['busy 无 current/running', input => {
      input.after.state.channels[0].currentRecordId = '';
      input.after.state.records = input.after.state.records.filter(record => record.id !== 'REC-1');
      input.after.state.samples = input.after.state.samples.filter(sample => sample.id !== 'REQ-1.001');
    }, 'RUNNING_POINTER_SPLIT'],
    ['current 指向 pending', input => {
      input.after.state.records[0].status = 'pending';
      input.after.state.samples[0].status = 'pending';
    }, 'RUNNING_POINTER_SPLIT'],
    ['booked 无 next/queue', input => {
      input.after.state.channels[1].nextRecordId = '';
      input.after.state.records = input.after.state.records.filter(record => record.id !== 'REC-2');
      input.after.state.samples = input.after.state.samples.filter(sample => sample.id !== 'REQ-2.001');
    }, 'RESERVED_POINTER_SPLIT']
  ];

  for (const [name, breakState, expectedCode] of cases) {
    const input = validInput();
    breakState(input);
    input.ui = null;
    input.restart = null;
    const violation = checkWorkflowInvariants(input).find(item => item.code === expectedCode);
    assert.ok(violation, name);
    assert.equal(violation.severity, 'P0', name);
  }
});

test('样品和通道的重复活动记录独立报告并包含实体 ID', () => {
  const sample = validInput();
  sample.after.state.records.push({
    id: 'REC-SAMPLE-DUP', requestNo: 'REQ-1', sampleId: 'REQ-1.001', channelKey: '设备 A|004', status: 'reserved'
  });
  const sampleViolation = checkWorkflowInvariants(sample).find(item => item.code === 'SAMPLE_ACTIVE_DUPLICATE');
  assert.deepEqual(sampleViolation.entityIds, ['REC-1', 'REC-SAMPLE-DUP', 'REQ-1.001']);

  const channel = validInput();
  channel.after.state.records.push({
    id: 'REC-CHANNEL-DUP', requestNo: 'REQ-1', sampleId: 'REQ-1.004', channelKey: '设备 A|001', status: 'running'
  });
  assert.ok(codes(channel).includes('CHANNEL_ACTIVE_DUPLICATE'));
});

test('仅携带 keys 的活动记录也参与通道唯一性检查', () => {
  const input = validInput();
  input.after.state.records.push({
    id: 'REC-KEYS-ONLY', requestNo: 'REQ-1', sampleId: 'REQ-1.004', keys: ['设备 A|001'], status: 'running'
  });

  assert.ok(codes(input).includes('CHANNEL_ACTIVE_DUPLICATE'));
});

test('rawFields 与来源路径不可变且分别指出申请 ID', () => {
  const raw = validInput();
  raw.after.state.requests[0].rawFields = { 委托单号: 'REWRITTEN' };
  assert.deepEqual(checkWorkflowInvariants(raw).find(item => item.code === 'RAW_FIELDS_CHANGED').entityIds, ['REQ-1']);

  const source = validInput();
  source.after.state.requests[1].sourcePath = 'D:/moved/b.xlsx';
  const violation = checkWorkflowInvariants(source).find(item => item.code === 'SOURCE_CHANGED');
  assert.deepEqual(violation.entityIds, ['REQ-2']);
});

test('审计 ID 重复与成功语义缺损独立报告 P0', () => {
  const input = validInput();
  input.after.state.auditLogs.push({ id: 'AUDIT-1', action: '', outcome: 'success', result: 'failure', verified: false });
  input.ui = null;

  assert.deepEqual(codes(input), ['AUDIT_ID_DUPLICATE', 'AUDIT_SEMANTICS']);
});

test('未知 result、未验证成功/警告及错误 failure/cancel 语义均报告 P0', () => {
  const invalidAudits = [
    { id: 'AUDIT-X', action: '未知结果', result: 'garbage' },
    { id: 'AUDIT-X', action: '未验证成功', result: 'success' },
    { id: 'AUDIT-X', action: '未验证警告', outcome: 'warning', result: 'warning', verified: false },
    { id: 'AUDIT-X', action: '无错误码失败', outcome: 'failure', result: 'failure', verified: false },
    { id: 'AUDIT-X', action: '错误取消审计', outcome: 'cancelled', result: 'cancelled', verified: false }
  ];

  for (const audit of invalidAudits) {
    const input = validInput();
    input.after.state.auditLogs = [audit];
    input.ui = null;
    const violation = checkWorkflowInvariants(input).find(item => item.code === 'AUDIT_SEMANTICS');
    assert.ok(violation, audit.action);
    assert.equal(violation.severity, 'P0');
  }
});

test('明确 source=legacy 且 result=legacy 的历史审计仍兼容', () => {
  const input = validInput();
  input.after.state.auditLogs = [{ id: 'AUDIT-LEGACY', action: '查看页面', result: 'legacy', source: 'legacy' }];
  input.ui = null;

  assert.ok(!codes(input).includes('AUDIT_SEMANTICS'));
});

test('精确 legacy 登录生命周期审计可通过，任一身份或结果字段偏差仍为 P0', () => {
  const exactLogin = {
    id: 'AUDIT-LOGIN',
    time: '2026/8/27 13:57:34',
    user: 'WF tester',
    action: '登录看板',
    target: '用户 WF tester',
    before: null,
    after: { 结果: '登录成功' },
    note: '进入本机看板',
    source: '软件操作',
    level: 'normal'
  };
  const valid = validInput();
  valid.after.state.auditLogs = [exactLogin];
  valid.ui = null;
  assert.ok(!codes(valid).includes('AUDIT_SEMANTICS'));

  const invalidAudits = [
    { ...exactLogin, user: '' },
    { ...exactLogin, target: '用户 other' },
    { ...exactLogin, after: { 结果: '登录失败' } },
    { ...exactLogin, note: '普通页面访问' },
    { ...exactLogin, outcome: 'success' },
    { ...exactLogin, verified: true }
  ];
  for (const audit of invalidAudits) {
    const input = validInput();
    input.after.state.auditLogs = [audit];
    input.ui = null;
    const violation = checkWorkflowInvariants(input).find(item => item.code === 'AUDIT_SEMANTICS');
    assert.ok(violation, JSON.stringify(audit));
    assert.equal(violation.severity, 'P0');
  }
});

test('精确 legacy 初始化与页面生命周期审计可通过，宽松变体仍为 P0', () => {
  const exactAudits = [{
    id: 'AUDIT-INITIALIZE',
    time: '2026/8/27 14:12:07',
    user: 'WF fixture',
    action: '日志初始化',
    target: '本机看板',
    before: null,
    after: { 历史使用日志: 0, 申请单数量: 0 },
    note: '首次启用软件操作审计；当前版本不接入真实设备',
    source: '软件操作',
    level: 'normal'
  }, {
    id: 'AUDIT-PAGE',
    time: '2026/8/27 14:12:07',
    user: 'WF tester',
    action: '查看页面',
    target: '页面 requests',
    before: null,
    after: { 页面: 'requests' },
    note: '页面访问',
    source: '软件操作',
    level: 'normal'
  }];
  const valid = validInput();
  valid.after.state.auditLogs = exactAudits;
  valid.ui = null;
  assert.ok(!codes(valid).includes('AUDIT_SEMANTICS'));

  const invalidAudits = [
    { ...exactAudits[0], after: { 历史使用日志: -1, 申请单数量: 0 } },
    { ...exactAudits[0], note: '普通初始化' },
    { ...exactAudits[1], target: '页面 dashboard' },
    { ...exactAudits[1], after: { 页面: 'requests', 宽松字段: true } },
    { ...exactAudits[1], result: 'legacy' }
  ];
  for (const audit of invalidAudits) {
    const input = validInput();
    input.after.state.auditLogs = [audit];
    input.ui = null;
    const violation = checkWorkflowInvariants(input).find(item => item.code === 'AUDIT_SEMANTICS');
    assert.ok(violation, JSON.stringify(audit));
    assert.equal(violation.severity, 'P0');
  }
});

test('UI/SQLite 投影和 529 DOM 上限分别报告 P1 与 P2', () => {
  const projection = validInput();
  projection.ui.projection.summary.records = 99;
  const projectionViolation = checkWorkflowInvariants(projection).find(item => item.code === 'UI_SQLITE_PROJECTION');
  assert.equal(projectionViolation.severity, 'P1');
  assert.deepEqual(projectionViolation.entityIds, ['records']);

  const dom = validInput();
  dom.ui.renderedChannelCards = 530;
  const domViolation = checkWorkflowInvariants(dom).find(item => item.code === 'CHANNEL_DOM_LIMIT');
  assert.equal(domViolation.severity, 'P2');
});

test('传入 UI 对象时空或错误 projection 结构不能通过', () => {
  for (const projection of [
    {},
    { currentPage: 'dashboard', summary: {}, visible: {} },
    { currentPage: 'dashboard', summary: summarizeState(validState(5)), visible: { records: {}, samples: [], channels: [], todos: [] } }
  ]) {
    const input = validInput();
    input.ui.projection = projection;
    const violation = checkWorkflowInvariants(input).find(item => item.code === 'UI_PROJECTION_INVALID');
    assert.ok(violation);
    assert.equal(violation.severity, 'P1');
  }
});

test('最小 UI 契约接受 MAIN 的全部实际页面 ID', () => {
  for (const currentPage of ['dashboard', 'apply', 'requests', 'records', 'devices', 'testers', 'reserved', 'timeliness', 'runningSamples', 'storageSamples']) {
    const input = validInput();
    input.ui.projection.currentPage = currentPage;
    assert.ok(!codes(input).includes('UI_PROJECTION_INVALID'), currentPage);
  }
});

test('visible record/sample/channel/TODO 的 ID 或 status 必须来自 SQLite 投影', () => {
  const input = validInput();
  input.ui.projection.visible = {
    records: [{ id: 'REC-MISSING', status: 'running' }],
    samples: [{ id: 'REQ-1.001', status: 'completed' }],
    channels: [{ key: '设备 A|001', state: 'free' }],
    todos: [{ id: 'REC-1', status: 'reserved' }],
    storageRecords: []
  };

  const violation = checkWorkflowInvariants(input).find(item => item.code === 'UI_SQLITE_PROJECTION');
  assert.equal(violation.severity, 'P1');
  assert.deepEqual(violation.entityIds, ['REC-1', 'REC-MISSING', 'REQ-1.001', '设备 A|001']);
});

test('陈旧的快照 summary 不能掩盖 UI 与当前 SQLite state 的差异', () => {
  const input = validInput();
  input.after.state.records.push({ id: 'REC-NEW', status: 'completed' });

  assert.ok(codes(input).includes('UI_SQLITE_PROJECTION'));
});

test('控制台、Promise 与外网请求分别报告具体 P1', () => {
  const input = validInput();
  input.ui.consoleErrors = ['render failed'];
  input.ui.unhandledRejections = ['promise failed'];
  input.ui.externalRequests = ['https://example.com/track'];

  const violations = checkWorkflowInvariants(input);
  assert.deepEqual(violations.map(item => item.code).sort(), [
    'CONSOLE_ERROR', 'EXTERNAL_NETWORK_REQUEST', 'UNHANDLED_REJECTION'
  ]);
  assert.ok(violations.every(item => item.severity === 'P1'));
});

test('重启后规范化哈希漂移报告 P0', () => {
  const input = validInput();
  input.restart.hash = '0'.repeat(64);

  const violation = checkWorkflowInvariants(input).find(item => item.code === 'RESTART_HASH_MISMATCH');
  assert.equal(violation.severity, 'P0');
  assert.deepEqual(violation.entityIds, []);
});

test('每个 violation 都满足统一结构且 entityIds 互不重复', () => {
  const input = validInput();
  input.after.integrity = ['bad'];
  input.after.state.revision = 8;
  input.ui.renderedChannelCards = 800;

  for (const violation of checkWorkflowInvariants(input)) {
    assert.match(violation.code, /^[A-Z][A-Z0-9_]+$/);
    assert.ok(['P0', 'P1', 'P2'].includes(violation.severity));
    assert.equal(typeof violation.message, 'string');
    assert.ok(violation.message.length > 0);
    assert.deepEqual(violation.entityIds, [...new Set(violation.entityIds)]);
  }
});
