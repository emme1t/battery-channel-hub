import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import {
  CHAOS_ACTIVITIES,
  createChaosPlanner,
  createRecordedActionSource,
  runChaosActivity
} from './chaos-planner.mjs';
import { seedWorkflowFixture } from './fixtures.mjs';
import { createWorkflowRunContext } from './run-context.mjs';
import { readWorkflowSnapshot } from './state-probe.mjs';

const projectRoot = path.resolve(import.meta.dirname, '..', '..');
const fixedClock = () => new Date('2026-08-27T00:00:00.000Z');

function snapshot() {
  return {
    state: {
      revision: 1,
      requests: [],
      samples: [],
      channels: [],
      deviceProfiles: [],
      records: [],
      storageRecords: [],
      testers: [],
      auditLogs: [],
      formChangeJournal: []
    },
    summary: { revision: 1 }
  };
}

function ui() {
  return {
    projection: {
      currentPage: 'dashboard',
      visible: {},
      summary: { revision: 1 }
    }
  };
}

function businessSnapshot() {
  const pending = { id: 'REQ-CHAOS-PENDING-001.001', status: 'pending' };
  const reserved = { id: 'REQ-CHAOS-RESERVED-001.001', status: 'reserved', channelKey: 'DEV|2' };
  const running = { id: 'REQ-CHAOS-RUNNING-001.001', status: 'running', channelKey: 'DEV|3' };
  return {
    state: {
      revision: 7,
      requests: [
        { id: 'REQ-CHAOS-PENDING-001' },
        { id: 'REQ-CHAOS-RESERVED-001' },
        { id: 'REQ-CHAOS-RUNNING-001' }
      ],
      samples: [pending, reserved, running],
      channels: [
        { key: 'DEV|1', name: '1', state: 'available', currentRecordId: '', nextRecordId: '' },
        { key: 'DEV|2', name: '2', state: 'booked', currentRecordId: '', nextRecordId: 'record-reserved' },
        { key: 'DEV|3', name: '3', state: 'busy', currentRecordId: 'record-running', nextRecordId: '' }
      ],
      deviceProfiles: [{ name: 'DEV' }],
      records: [
        { id: 'record-reserved', sampleId: reserved.id, status: 'reserved', channelKey: 'DEV|2', keys: ['DEV|2'] },
        { id: 'record-running', sampleId: running.id, status: 'running', channelKey: 'DEV|3', keys: ['DEV|3'], start: '2026-08-27T00:00:00.000Z' }
      ],
      storageRecords: [],
      testers: [{ name: 'WF tester' }],
      auditLogs: [],
      formChangeJournal: []
    },
    summary: { revision: 7 }
  };
}

function c03Snapshot() {
  const state = businessSnapshot().state;
  state.requests = [];
  state.samples = [];
  state.records = [];
  state.channels = [];
  for (let index = 0; index < 30; index += 1) {
    const suffix = String(index + 1).padStart(3, '0');
    const requestNo = `REQ-CHAOS-C03-${suffix}`;
    state.requests.push({ id: requestNo });
    state.samples.push({ id: `${requestNo}.001`, requestNo, status: 'pending' });
    state.channels.push({ key: `DEV|${suffix}`, name: suffix, state: 'available', currentRecordId: '', nextRecordId: '' });
  }
  return { state, summary: { revision: state.revision } };
}

function fakeChaosShell(state, revision, dataRoot) {
  const persisted = structuredClone(state);
  persisted.revision = revision;
  return {
    state: persisted,
    summary: { revision },
    auditLogs: structuredClone(persisted.auditLogs || []),
    formJournal: structuredClone(persisted.formChangeJournal || []),
    hash: `fake-chaos-hash-${revision}`,
    sqlitePath: path.join(dataRoot, 'battery-channel-hub.sqlite'),
    integrity: ['ok']
  };
}

async function runFakeChaosPrefix({
  activityId,
  state,
  page = 'dashboard',
  fixtureManifest,
  allowAction,
  stopWhen,
  onExecute = async () => undefined
}) {
  const config = CHAOS_ACTIVITIES[activityId];
  const runRoot = path.join(projectRoot, '自动测试报告', 'workflows', `unit-chaos-${activityId.toLowerCase()}-runner`);
  const observations = [];
  const availability = Object.fromEntries(config.actionTypes.map(type => [type, async (snapshot, currentUi, params, context) => {
    observations.push({
      type,
      revision: snapshot.state.revision,
      uiMarker: currentUi.projection.marker,
      runtime: context.runtime,
      runContext: context.runContext,
      params: structuredClone(params)
    });
    return allowAction({ type, snapshot, ui: currentUi, params, context });
  }]));
  const runContext = {
    workflowId: activityId,
    fixture: config.fixture,
    fixtureSha256: `fixture-${activityId.toLowerCase()}`,
    runRoot,
    dataRoot: path.join(runRoot, 'work', 'data'),
    profileRoot: path.join(runRoot, 'profiles'),
    exportsRoot: path.join(runRoot, 'work', 'exports'),
    screenshotsRoot: path.join(runRoot, 'artifacts', 'screenshots'),
    fixtureManifest,
    availability,
    assertWritable(candidate) {
      const relative = path.relative(runRoot, candidate);
      assert.ok(relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative)), candidate);
      return candidate;
    },
    verifyProtected: async () => ({ ok: true, changed: [] }),
    cleanup: async () => undefined
  };
  let revision = 1;
  const mutableState = structuredClone(state);
  const currentUi = ui();
  currentUi.projection.currentPage = page;
  currentUi.projection.marker = `ui-${revision}`;
  currentUi.projection.summary.revision = revision;
  const executed = [];
  const executionContexts = [];
  const driverFactory = async () => ({
    async start() {},
    async close() {},
    async uiProjection() { return structuredClone(currentUi); }
  });
  const result = await runChaosActivity({
    activityId,
    seed: config.quickSeed,
    runContext,
    driverFactory,
    clock: fixedClock,
    dependencies: {
      readSnapshot: () => fakeChaosShell(mutableState, revision, runContext.dataRoot),
      executeAction: async ({ action, context }) => {
        executed.push(structuredClone(action));
        executionContexts.push(context);
        await onExecute({ action, context, state: mutableState });
        revision += 1;
        currentUi.projection.marker = `ui-${revision}`;
        currentUi.projection.summary.revision = revision;
        return { outcome: action.expect, uiEvidence: structuredClone(currentUi) };
      },
      isWriteAction: () => false,
      checkInvariants: ({ action }) => stopWhen({ action, executed })
        ? [{ code: 'TEST_PREFIX_COMPLETE', severity: 'P0', message: 'focused prefix complete', entityIds: [] }]
        : [],
      profileExists: async () => false,
      closeTimeoutMs: 20
    }
  });
  assert.equal(result.status, 'failed');
  assert.equal(result.failure.violation.code, 'TEST_PREFIX_COMPLETE');
  assert.deepEqual(result.plannedActions, executed);
  assert.equal(result.steps.length, executed.length);
  return { result, runContext, observations, executed, executionContexts };
}

test('同一 activity/seed 异步规划得到相同动作且不调用 Math.random', async () => {
  const original = Math.random;
  Math.random = () => { throw new Error('Math.random forbidden'); };
  try {
    const leftPlanner = createChaosPlanner({ activityId: 'C01', seed: 22001 });
    const rightPlanner = createChaosPlanner({ activityId: 'C01', seed: 22001 });
    const left = [];
    const right = [];
    for (let step = 0; step < 12; step += 1) {
      left.push(await leftPlanner.next({ snapshot: snapshot(), ui: ui(), step }));
      right.push(await rightPlanner.next({ snapshot: snapshot(), ui: ui(), step }));
    }
    assert.deepEqual(left, right);
    assert.ok(left.every(Boolean));
  } finally {
    Math.random = original;
  }
});

test('C01 在 200 步只读边界内实际覆盖导航、搜索、筛选与翻页', async () => {
  const planner = createChaosPlanner({ activityId: 'C01', seed: 22001 });
  const source = businessSnapshot();
  source.state.requests = [{ id: 'REQ-WF-529' }];
  source.state.samples = Array.from({ length: 529 }, (_, index) => ({
    id: `REQ-WF-529.${String(index + 1).padStart(3, '0')}`,
    requestNo: 'REQ-WF-529',
    status: 'pending'
  }));
  source.state.channels = Array.from({ length: 529 }, (_, index) => ({
    key: `DEV|${index + 1}`,
    name: String(index + 1),
    state: 'available'
  }));
  const currentUi = ui();
  let previousStep = null;
  const actions = [];
  const pageByLabel = { '看板': 'dashboard', '预约': 'apply', '申请': 'requests', '日志': 'records', '设备': 'devices', '及时率': 'timeliness', '测试人员': 'testers' };
  for (let step = 0; step < 200; step += 1) {
    const action = await planner.next({ snapshot: source, ui: currentUi, step, previousStep });
    assert.ok(action, `step ${step}`);
    actions.push(action);
    if (action.type === 'navigate') currentUi.projection.currentPage = pageByLabel[action.params.label];
    if (action.type === 'search' && action.params.targetPage) currentUi.projection.currentPage = action.params.targetPage;
    previousStep = { actionId: action.id, outcome: action.expect };
  }
  const types = new Set(actions.map(action => action.type));
  assert.ok(types.has('navigate'));
  assert.ok(types.has('search'));
  assert.ok(types.has('filter'));
  assert.ok(types.has('nextPage') || types.has('previousPage'));
  assert.ok(actions.filter(action => action.type === 'search').every(action => action.params.targetPage === undefined));
  assert.ok(actions.filter(action => action.type === 'filter').every(action => typeof action.params.value === 'string' && action.params.value.length > 0));
  assert.ok(actions.every(action => ['navigate', 'search', 'filter', 'expand', 'collapse', 'nextPage', 'previousPage'].includes(action.type)));
});

test('C02 选择并记录 120 个满足 available 的完整回放动作', async () => {
  const planner = createChaosPlanner({ activityId: 'C02', seed: 22002 });
  const selected = [];
  for (let step = 0; step < 120; step += 1) {
    const action = await planner.next({ snapshot: businessSnapshot(), ui: ui(), step });
    assert.ok(action, `step ${step}`);
    selected.push(action);
  }
  assert.equal(await planner.next({ snapshot: businessSnapshot(), ui: ui(), step: 120 }), null);
  assert.equal(selected.length, 120);
  assert.equal(new Set(selected.map(action => action.id)).size, 120);
  for (const action of selected) {
    assert.equal(typeof action.expect, 'string');
    assert.equal(typeof action.params, 'object');
    assert.ok(Number.isInteger(action.revisionDelta) || Array.isArray(action.revisionDelta));
    assert.ok(Number.isInteger(action.evidenceRevisionDelta) || Array.isArray(action.evidenceRevisionDelta));
    assert.ok(Number.isFinite(action.maxMs) && action.maxMs > 0);
  }
});

test('baseline 保持通用空输出并只按 C02/C03/C06 activity ID 注入业务目标', async t => {
  const context = await createWorkflowRunContext({
    projectRoot,
    mode: 'chaos-fixture-contract',
    now: fixedClock,
    randomBytes: () => Buffer.from([0x10, 0x20, 0x30, 0x40])
  });
  t.after(() => rm(context.runRoot, { recursive: true, force: true }));
  const roots = Object.fromEntries(['generic', 'C02', 'C03', 'C06'].map(name => [name, path.join(context.dataRoot, name)]));
  await seedWorkflowFixture({ dataRoot: roots.generic, kind: 'baseline', clock: fixedClock });
  for (const id of ['C02', 'C03', 'C06']) {
    await seedWorkflowFixture({ dataRoot: roots[id], kind: 'baseline', workflowId: id, clock: fixedClock });
  }
  const generic = readWorkflowSnapshot({ dataRoot: roots.generic }).state;
  assert.equal(generic.requests.length, 0);
  assert.equal(generic.samples.length, 0);
  assert.equal(generic.records.length, 0);

  const c02 = readWorkflowSnapshot({ dataRoot: roots.C02 }).state;
  assert.ok(c02.samples.filter(item => item.status === 'pending').length >= 120);
  assert.ok(c02.records.some(item => item.status === 'reserved'));
  assert.ok(c02.records.some(item => item.status === 'running'));

  const c03 = readWorkflowSnapshot({ dataRoot: roots.C03 }).state;
  assert.ok(c03.samples.filter(item => item.status === 'pending').length >= 30);
  assert.equal(c03.records.length, 0);

  const c06 = readWorkflowSnapshot({ dataRoot: roots.C06 }).state;
  assert.ok(c06.samples.some(item => item.status === 'pending'));
  assert.ok(c06.records.some(item => item.status === 'reserved'));
  assert.ok(c06.records.some(item => item.status === 'running'));
});

test('C03 以真实 60×2 group/phase 状态机记录双会话读写、旧提交和 reload', async () => {
  const planner = createChaosPlanner({ activityId: 'C03', seed: 22003 });
  const snapshot = c03Snapshot();
  const runtime = { staleDrafts: new Map() };
  const actions = [];
  const expectedGroups = Array.from({ length: 60 }, (_, group) => {
    const cycle = group % 3;
    if (cycle === 0) return [
      { type: 'openSecondSession', groupKind: 'open-write', session: 'B', behavior: 'read', stateBefore: 'closed', stateAfter: 'stale-open' },
      { type: 'reserve', groupKind: 'open-write', session: 'A', behavior: 'write', stateBefore: 'stale-open', stateAfter: 'committed' }
    ];
    if (cycle === 1) return [
      { type: 'staleSubmit', groupKind: 'stale-reload', session: 'B', behavior: 'staleSubmit', stateBefore: 'committed', stateAfter: 'stale-rejected' },
      { type: 'reloadCurrent', groupKind: 'stale-reload', session: 'A', behavior: 'reload', stateBefore: 'stale-rejected', stateAfter: 'reloaded' }
    ];
    return [
      { type: 'reloadCurrent', groupKind: 'reload-close', session: 'A', behavior: 'reload', stateBefore: 'reloaded', stateAfter: 'reloaded' },
      { type: 'closeSecondSession', groupKind: 'reload-close', session: 'B', behavior: 'read', stateBefore: 'reloaded', stateAfter: 'closed' }
    ];
  });
  for (let step = 0; step < 120; step += 1) {
    const group = Math.floor(step / 2);
    const phase = step % 2;
    assert.deepEqual(
      { group: planner.state().group, phase: planner.state().phase },
      { group, phase },
      `state before step ${step}`
    );
    const action = await planner.next({ snapshot, ui: ui(), step, context: { runtime } });
    assert.ok(action, `step ${step}`);
    actions.push(action);
    assert.deepEqual(action.chaos, {
      activityId: 'C03',
      group,
      phase,
      ...expectedGroups[group][phase]
    });
    if (action.type === 'openSecondSession') {
      runtime.secondDriver = {};
      runtime.staleDrafts.set('B:reserve', {
        operation: 'reserve',
        params: structuredClone(action.params.prepareStale)
      });
    } else if (action.type === 'reserve') {
      const sample = snapshot.state.samples.find(item => item.id === action.params.sampleIds[0]);
      const channel = snapshot.state.channels.find(item => item.key === action.params.channelKeys[0]);
      sample.status = 'reserved';
      channel.state = 'booked';
    } else if (action.type === 'staleSubmit') {
      runtime.staleDrafts.delete('B:reserve');
    } else if (action.type === 'closeSecondSession') {
      runtime.secondDriver = null;
    }
    assert.deepEqual(
      { group: planner.state().group, phase: planner.state().phase },
      phase === 0 ? { group, phase: 1 } : { group: group + 1, phase: 0 },
      `state after step ${step}`
    );
  }
  assert.deepEqual(
    expectedGroups.flat().map(item => item.type),
    actions.map(action => action.type)
  );
  assert.deepEqual(
    Array.from({ length: 60 }, (_, group) => actions.slice(group * 2, group * 2 + 2).map(action => [action.chaos.group, action.chaos.phase])),
    Array.from({ length: 60 }, (_, group) => [[group, 0], [group, 1]])
  );
  assert.equal(new Set(actions.map(action => action.id)).size, 120);
  assert.deepEqual(planner.state().group, 60);
  assert.deepEqual(planner.state().phase, 0);
});

test('C04 从 fixture/runtime closure 生成受 run root 约束的导入路径和确定性新名称', async () => {
  const planner = createChaosPlanner({ activityId: 'C04', seed: 22004 });
  const snapshot = businessSnapshot();
  snapshot.state.requests[0].id = 'REQ-WF-IMPORT-001';
  snapshot.state.deviceProfiles[0].name = '新威1#（16通道)';
  const dataRoot = path.join(projectRoot, '自动测试报告', 'workflows', 'unit-c04', 'work', 'data');
  const vertical = path.join(dataRoot, 'imports', 'vertical.xlsx');
  const context = { runContext: { dataRoot }, fixtureManifest: { imports: { vertical } } };
  const actions = [];
  for (let step = 0; step < 120; step += 1) {
    const action = await planner.next({ snapshot, ui: ui(), step, context });
    assert.ok(action, `step ${step}`);
    actions.push(action);
  }
  const imports = actions.filter(action => action.type === 'importRequest' && action.expect === 'success');
  assert.ok(imports.length > 0);
  assert.ok(imports.every(action => action.params.path === path.join('imports', 'vertical.xlsx')));
  assert.ok(imports.every(action => action.params.expectedValidCount === 1), 'C04 vertical import must declare one valid request row');
  const generatedNames = actions
    .filter(action => ['createTester', 'createDevice', 'createChannel'].includes(action.type))
    .map(action => action.params.name);
  assert.equal(new Set(generatedNames).size, generatedNames.length);
  assert.ok(generatedNames.every(name => name.includes('C04-22004-step-')));
});

test('C04 deleteResource 按目标设备空闲或活动引用生成 success/rejected', async () => {
  const scenarios = [
    {
      name: 'free device',
      channels: [{ key: 'DEV|1', device: 'DEV', state: 'free', currentRecordId: '', nextRecordId: '' }],
      records: [], expect: 'success'
    },
    {
      name: 'busy channel',
      channels: [{ key: 'DEV|1', device: 'DEV', state: 'busy', currentRecordId: 'REC-1', nextRecordId: '' }],
      records: [{ id: 'REC-1', status: 'running', channelKey: 'DEV|1', keys: ['DEV|1'] }], expect: 'rejected'
    },
    {
      name: 'active record reference',
      channels: [{ key: 'DEV|1', device: 'DEV', state: 'free', currentRecordId: '', nextRecordId: '' }],
      records: [{ id: 'REC-1', status: 'reserved', channelKey: 'DEV|1', keys: ['DEV|1'] }], expect: 'rejected'
    }
  ];

  for (const scenario of scenarios) {
    const planner = createChaosPlanner({ activityId: 'C04', seed: 22004 });
    const state = businessSnapshot().state;
    state.deviceProfiles = [{ id: 'DEV-1', name: 'DEV' }];
    state.channels = scenario.channels;
    state.records = scenario.records;
    const actions = [];
    for (let step = 0; step < 120; step += 1) {
      const action = await planner.next({ snapshot: { state, summary: { revision: state.revision } }, ui: ui(), step });
      assert.ok(action, `${scenario.name} step ${step}`);
      if (action.type === 'deleteResource') actions.push(action);
    }
    assert.ok(actions.length > 0, `${scenario.name} must plan device deletion`);
    assert.ok(actions.every(action => action.expect === scenario.expect), `${scenario.name} delete expectation`);
    if (scenario.expect === 'rejected') {
      assert.ok(actions.every(action => action.revisionDelta === 0 && action.evidenceRevisionDelta === 0), `${scenario.name} must be non-mutating`);
    }
  }
});

test('C05 从 dashboard 开始时先规划预约页导航，不让 selectSample 吞掉页面审计 revision', async () => {
  const planner = createChaosPlanner({ activityId: 'C05', seed: 22005 });
  const snapshot = businessSnapshot();
  snapshot.state.requests = [{ id: 'REQ-WF-999' }];
  snapshot.state.samples = [{ id: 'REQ-WF-999.001', requestNo: 'REQ-WF-999', status: 'pending' }];
  const action = await planner.next({ snapshot, ui: ui(), step: 0, previousStep: null });

  assert.equal(action.type, 'navigate');
  assert.deepEqual(action.params, { label: '预约' });
  assert.deepEqual(action.revisionDelta, [0, 1]);
  assert.deepEqual(action.evidenceRevisionDelta, [0, 1]);
});

test('C05 有界执行 300 个大列表动作且永久 unavailable 的 unselectChannel 不进入计划', async () => {
  const planner = createChaosPlanner({ activityId: 'C05', seed: 22005 });
  const snapshot = businessSnapshot();
  snapshot.state.requests = [{ id: 'REQ-WF-999' }];
  snapshot.state.samples = Array.from({ length: 999 }, (_, index) => ({
    id: `REQ-WF-999.${String(index + 1).padStart(3, '0')}`,
    requestNo: 'REQ-WF-999',
    status: 'pending'
  }));
  snapshot.state.channels = Array.from({ length: 529 }, (_, index) => ({
    key: `DEV|${index + 1}`,
    name: String(index + 1),
    state: 'available',
    currentRecordId: '',
    nextRecordId: ''
  }));
  const applyUi = ui();
  applyUi.projection.currentPage = 'apply';
  let previousStep = null;
  const actions = [];
  for (let step = 0; step < 300; step += 1) {
    const action = await planner.next({ snapshot, ui: applyUi, step, previousStep });
    assert.ok(action, `step ${step}`);
    actions.push(action);
    previousStep = { actionId: action.id, outcome: action.expect };
  }
  assert.equal(actions.length, 300);
  assert.equal(actions.some(action => action.type === 'unselectChannel'), false);
  assert.ok(actions.some(action => action.type === 'unselectSample'));
  assert.ok(actions.some(action => ['nextPage', 'previousPage'].includes(action.type)));
  let pickerOpen = false;
  for (const action of actions) {
    if (action.type === 'nextPage') pickerOpen = false;
    if (action.type === 'selectSample') pickerOpen = true;
    if (action.type === 'unselectSample' && action.expect === 'success') {
      assert.equal(pickerOpen, true, `${action.id} may only close a visible picker`);
      pickerOpen = false;
    }
    if (action.type === 'selectChannel') {
      assert.equal(pickerOpen, true, `${action.id} may only choose from a visible picker`);
      pickerOpen = false;
    }
  }
});

test('C06 在 100 步内插入 restart 并最多选择一次 run-local lockedWrite', async () => {
  const planner = createChaosPlanner({ activityId: 'C06', seed: 22006 });
  const snapshot = businessSnapshot();
  const context = { runContext: { armWriteLock: async () => () => {} } };
  let previousStep = null;
  const actions = [];
  for (let step = 0; step < 100; step += 1) {
    const action = await planner.next({ snapshot, ui: ui(), step, previousStep, context });
    assert.ok(action, `step ${step}`);
    actions.push(action);
    previousStep = { actionId: action.id, outcome: action.expect };
  }
  assert.ok(actions.some(action => action.type === 'restart'));
  assert.equal(actions.filter(action => action.type === 'lockedWrite').length, 1);
  assert.equal(actions.filter(action => action.type === 'lockedWrite')[0].expect, 'rejected');
});

test('活动目录固定 quick/full uint32 seeds、硬边界和 60/25/10/5 家族权重', () => {
  for (let index = 1; index <= 6; index += 1) {
    const id = `C0${index}`;
    const config = CHAOS_ACTIVITIES[id];
    const quick = 22_000 + index;
    assert.equal(config.quickSeed, quick);
    assert.deepEqual(config.fullSeeds, [quick, quick + 1_000, quick + 2_000, quick + 3_000, quick + 4_000]);
    assert.deepEqual(config.familyWeights, {
      legal: 60,
      rejectCancel: 25,
      uiPerturbation: 10,
      restartStaleFailure: 5
    });
    assert.ok(config.maxActions > 0);
    assert.ok(config.fullSeeds.every(seed => Number.isInteger(seed) && seed >= 0 && seed <= 0xffff_ffff));
  }
  assert.deepEqual(
    { groups: CHAOS_ACTIVITIES.C03.groups, actionsPerGroup: CHAOS_ACTIVITIES.C03.actionsPerGroup, maxActions: CHAOS_ACTIVITIES.C03.maxActions },
    { groups: 60, actionsPerGroup: 2, maxActions: 120 }
  );
});

test('异步 availability 在加权前过滤；全空时只 fallback restart 一次后正常 no-action', async () => {
  const calls = [];
  const unavailable = async (_snapshot, _ui, params) => {
    calls.push(structuredClone(params));
    return false;
  };
  const planner = createChaosPlanner({ activityId: 'C01', seed: 22001 });
  const context = {
    availability: {
      navigate: unavailable,
      search: unavailable,
      filter: unavailable,
      nextPage: unavailable,
      previousPage: unavailable,
      restart: async () => true
    }
  };
  const first = await planner.next({ snapshot: snapshot(), ui: ui(), step: 0, context });
  const second = await planner.next({ snapshot: snapshot(), ui: ui(), step: 1, context });
  assert.equal(first.type, 'restart');
  assert.equal(second, null);
  assert.ok(calls.length > 0);
  assert.ok(calls.every(params => params && typeof params === 'object'));
  assert.equal(planner.state().restartFallbackUsed, true);
});

test('recorded action source 原样消费完整动作且不创建 planner 或调用 PRNG', async () => {
  const planner = createChaosPlanner({ activityId: 'C01', seed: 22001 });
  const actions = [
    await planner.next({ snapshot: snapshot(), ui: ui(), step: 0 }),
    await planner.next({ snapshot: snapshot(), ui: ui(), step: 1 })
  ];
  const original = Math.random;
  Math.random = () => { throw new Error('recorded source must not call randomness'); };
  try {
    const source = createRecordedActionSource(actions);
    assert.deepEqual({ kind: source.kind, needsUi: source.needsUi, maxSteps: source.maxSteps }, {
      kind: 'replay', needsUi: false, maxSteps: 2
    });
    assert.deepEqual(await source.next(), actions[0]);
    assert.deepEqual(await source.next(), actions[1]);
    assert.equal(await source.next(), null);
  } finally {
    Math.random = original;
  }
  assert.throws(() => createRecordedActionSource([]), /recorded actions.*non-empty/i);
  assert.throws(
    () => createRecordedActionSource([{ ...actions[0], type: 'reserve', params: {} }]),
    /missing parameter: requestNo/i
  );
});

test('planner 与 recorded source 的完整 replay payload 均独立深冻结', async () => {
  const planner = createChaosPlanner({ activityId: 'C03', seed: 22003 });
  const runtime = { staleDrafts: new Map() };
  const planned = await planner.next({ snapshot: c03Snapshot(), ui: ui(), step: 0, context: { runtime } });
  const originalSampleId = planned.params.prepareStale.sampleIds[0];

  assert.ok(Object.isFrozen(planned));
  assert.ok(Object.isFrozen(planned.params));
  assert.ok(Object.isFrozen(planned.params.prepareStale));
  assert.ok(Object.isFrozen(planned.params.prepareStale.sampleIds));
  assert.ok(Object.isFrozen(planned.revisionDelta));
  assert.ok(Object.isFrozen(planned.evidenceRevisionDelta));
  assert.ok(Object.isFrozen(planned.chaos));
  assert.throws(() => planned.params.prepareStale.sampleIds.push('tampered'), TypeError);
  assert.throws(() => { planned.params.prepareStale.note = 'tampered'; }, TypeError);

  const callerPayload = structuredClone(planned);
  const source = createRecordedActionSource([callerPayload]);
  callerPayload.params.prepareStale.sampleIds[0] = 'caller-mutated';
  callerPayload.params.prepareStale.channelKeys.push('caller-mutated');
  const replayed = await source.next();

  assert.notEqual(replayed, callerPayload);
  assert.equal(replayed.params.prepareStale.sampleIds[0], originalSampleId);
  assert.equal(replayed.params.prepareStale.channelKeys.length, 1);
  assert.ok(Object.isFrozen(replayed));
  assert.ok(Object.isFrozen(replayed.params));
  assert.ok(Object.isFrozen(replayed.params.prepareStale));
  assert.ok(Object.isFrozen(replayed.params.prepareStale.sampleIds));
  assert.ok(Object.isFrozen(replayed.params.prepareStale.channelKeys));
  assert.ok(Object.isFrozen(replayed.revisionDelta));
  assert.ok(Object.isFrozen(replayed.evidenceRevisionDelta));
  assert.ok(Object.isFrozen(replayed.chaos));
  assert.throws(() => { replayed.params.prepareStale.sampleIds[0] = 'tampered'; }, TypeError);
  assert.throws(() => replayed.params.prepareStale.channelKeys.push('tampered'), TypeError);
  assert.throws(() => { replayed.chaos.group = 999; }, TypeError);
});

test('runChaosActivity 复用 runner dynamic 生命周期并从 settled 后 fresh snapshot 继续规划', async () => {
  const runRoot = path.join(projectRoot, '自动测试报告', 'workflows', 'unit-chaos-runner');
  const seenRevisions = [];
  const runContext = {
    workflowId: 'C01',
    fixture: 'production-529',
    fixtureSha256: 'fixture-c01',
    runRoot,
    dataRoot: path.join(runRoot, 'work', 'data'),
    profileRoot: path.join(runRoot, 'profiles'),
    exportsRoot: path.join(runRoot, 'work', 'exports'),
    screenshotsRoot: path.join(runRoot, 'artifacts', 'screenshots'),
    availability: {
      navigate: async snapshot => {
        seenRevisions.push(snapshot.state.revision);
        return snapshot.state.revision === 1;
      },
      search: false,
      filter: false,
      nextPage: false,
      previousPage: false,
      restart: false
    },
    assertWritable: candidate => candidate,
    verifyProtected: async () => ({ ok: true, changed: [] }),
    cleanup: async () => undefined
  };
  let snapshotCalls = 0;
  const snapshotForRevision = revision => ({
    ...snapshot(),
    state: { ...snapshot().state, revision },
    summary: { revision },
    auditLogs: [],
    formJournal: [],
    hash: `hash-${revision}`,
    sqlitePath: path.join(runContext.dataRoot, 'battery-channel-hub.sqlite'),
    integrity: ['ok']
  });
  const snapshots = [snapshotForRevision(1), snapshotForRevision(2), snapshotForRevision(2), snapshotForRevision(2), snapshotForRevision(2)];
  const driverFactory = async () => ({
    async start() {},
    async close() {},
    async uiProjection() { return ui(); }
  });
  const result = await runChaosActivity({
    activityId: 'C01',
    seed: 22001,
    runContext,
    driverFactory,
    clock: fixedClock,
    dependencies: {
      readSnapshot: () => snapshots[Math.min(snapshotCalls++, snapshots.length - 1)],
      executeAction: async () => ({ outcome: 'success', uiEvidence: ui() }),
      checkInvariants: () => [],
      profileExists: async () => false,
      closeTimeoutMs: 20
    }
  });
  assert.equal(result.status, 'passed', result.failure?.error?.stack);
  assert.equal(result.plannedActions.length, 1);
  assert.ok(seenRevisions.includes(1));
  assert.ok(seenRevisions.includes(2));
});

test('C02-C05 通过 runChaosActivity fake runner 消费 fresh state/UI/runtime 与精确执行前缀', async t => {
  await t.test('C02 下一步只使用前一动作后的 fresh pending target 与 UI', async () => {
    const state = c03Snapshot().state;
    const evidence = await runFakeChaosPrefix({
      activityId: 'C02',
      state,
      allowAction: ({ type }) => type === 'reserve',
      stopWhen: ({ executed }) => executed.length === 3,
      onExecute: async ({ action, state: mutableState }) => {
        const selected = mutableState.samples.find(item => item.id === action.params.sampleIds[0]);
        selected.status = 'reserved';
      }
    });
    assert.deepEqual(evidence.executed.map(action => action.params.sampleIds[0]), [
      'REQ-CHAOS-C03-001.001',
      'REQ-CHAOS-C03-002.001',
      'REQ-CHAOS-C03-003.001'
    ]);
    assert.deepEqual(evidence.executionContexts.map(context => context.snapshot.state.revision), [1, 2, 3]);
    assert.ok(evidence.observations.every(item => item.uiMarker === `ui-${item.revision}`));
  });

  await t.test('C03 六动作跨组前缀共享 live runtime/runContext 并实际到达 reload', async () => {
    const evidence = await runFakeChaosPrefix({
      activityId: 'C03',
      state: c03Snapshot().state,
      allowAction: () => true,
      stopWhen: ({ executed }) => executed.length === 6,
      onExecute: async ({ action, context, state: mutableState }) => {
        if (action.type === 'openSecondSession') {
          context.runtime.secondDriver = { close: async () => undefined };
          context.runtime.staleDrafts = new Map([['B:reserve', {
            operation: 'reserve',
            params: structuredClone(action.params.prepareStale)
          }]]);
        } else if (action.type === 'reserve') {
          const selected = mutableState.samples.find(item => item.id === action.params.sampleIds[0]);
          selected.status = 'reserved';
        } else if (action.type === 'staleSubmit') {
          context.runtime.staleDrafts.delete('B:reserve');
        } else if (action.type === 'closeSecondSession') {
          context.runtime.secondDriver = null;
        }
      }
    });
    assert.deepEqual(evidence.executed.map(action => action.type), [
      'openSecondSession', 'reserve', 'staleSubmit', 'reloadCurrent', 'reloadCurrent', 'closeSecondSession'
    ]);
    assert.equal(new Set(evidence.executionContexts.map(context => context.runtime)).size, 1);
    assert.ok(evidence.executionContexts.every(context => context.runContext === evidence.runContext));
    assert.ok(evidence.observations.every(item => item.runtime === evidence.executionContexts[0].runtime));
    assert.ok(evidence.observations.every(item => item.runContext === evidence.runContext));
  });

  await t.test('C04 仅从 live fixtureManifest 解析当前 run-root 内相对导入路径', async () => {
    const runRoot = path.join(projectRoot, '自动测试报告', 'workflows', 'unit-chaos-c04-runner');
    const vertical = path.join(runRoot, 'work', 'data', 'imports', 'vertical.xlsx');
    const state = businessSnapshot().state;
    state.requests[0].id = 'REQ-WF-IMPORT-001';
    const evidence = await runFakeChaosPrefix({
      activityId: 'C04',
      state,
      fixtureManifest: { imports: { vertical } },
      allowAction: ({ type, params }) => type === 'importRequest' && params.cancel !== true,
      stopWhen: ({ executed }) => executed.length === 1
    });
    assert.equal(evidence.runContext.fixtureManifest.imports.vertical, vertical);
    assert.equal(evidence.executed[0].type, 'importRequest');
    assert.equal(evidence.executed[0].params.path, path.join('imports', 'vertical.xlsx'));
    assert.equal(path.resolve(evidence.runContext.dataRoot, evidence.executed[0].params.path), vertical);
  });

  await t.test('C05 previousStep 将 fresh UI 上的选择转为成功取消选择', async () => {
    const state = businessSnapshot().state;
    state.requests = [{ id: 'REQ-WF-999' }];
    state.samples = [{ id: 'REQ-WF-999.001', requestNo: 'REQ-WF-999', status: 'pending' }];
    const evidence = await runFakeChaosPrefix({
      activityId: 'C05',
      state,
      page: 'apply',
      allowAction: ({ type, snapshot }) => (snapshot.state.revision === 1 && type === 'selectSample')
        || (snapshot.state.revision === 2 && type === 'unselectSample'),
      stopWhen: ({ executed }) => executed.length === 2
    });
    assert.deepEqual(evidence.executed.map(action => [action.type, action.expect]), [
      ['selectSample', 'success'],
      ['unselectSample', 'success']
    ]);
    assert.deepEqual(evidence.executionContexts.map(context => context.snapshot.state.revision), [1, 2]);
    assert.ok(evidence.observations.every(item => item.uiMarker === `ui-${item.revision}`));
  });
});

test('runChaosActivity 仅向 C06 run context 注入一次性 armWriteLock', async () => {
  const runRoot = path.join(projectRoot, '自动测试报告', 'workflows', 'unit-chaos-c06-lock');
  let baseArmCalls = 0;
  let lockedExecutions = 0;
  const runContext = {
    workflowId: 'C06',
    fixture: 'baseline',
    fixtureSha256: 'fixture-c06',
    runRoot,
    dataRoot: path.join(runRoot, 'work', 'data'),
    profileRoot: path.join(runRoot, 'profiles'),
    exportsRoot: path.join(runRoot, 'work', 'exports'),
    screenshotsRoot: path.join(runRoot, 'artifacts', 'screenshots'),
    armWriteLock: async () => {
      baseArmCalls += 1;
      return () => {};
    },
    assertWritable: candidate => candidate,
    verifyProtected: async () => ({ ok: true, changed: [] }),
    cleanup: async () => undefined
  };
  const shell = {
    ...businessSnapshot(),
    auditLogs: [],
    formJournal: [],
    hash: 'c06-hash',
    sqlitePath: path.join(runContext.dataRoot, 'battery-channel-hub.sqlite'),
    integrity: ['ok']
  };
  const driverFactory = async () => ({
    async start() {},
    async close() {},
    async uiProjection() { return ui(); }
  });
  const result = await runChaosActivity({
    activityId: 'C06',
    seed: 22006,
    runContext,
    driverFactory,
    clock: fixedClock,
    dependencies: {
      readSnapshot: () => shell,
      executeAction: async ({ action, context }) => {
        if (action.type === 'lockedWrite') {
          lockedExecutions += 1;
          const release = await context.armWriteLock({ operation: 'reserve' });
          release();
          await assert.rejects(() => context.armWriteLock({ operation: 'reserve' }), /one-shot/i);
        }
        return { outcome: action.expect, uiEvidence: ui() };
      },
      isWriteAction: () => false,
      checkInvariants: () => [],
      profileExists: async () => false,
      closeTimeoutMs: 20
    }
  });
  assert.equal(result.status, 'passed', result.failure?.error?.stack);
  assert.equal(result.plannedActions.length, 100);
  assert.equal(lockedExecutions, 1);
  assert.equal(baseArmCalls, 1);
});
