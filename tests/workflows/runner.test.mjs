import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { channelCandidates } from '../../src/renderer/legacy-list-selectors.mjs';
import { STANDARD_WORKFLOWS } from './catalog-standard.mjs';
import { createWorkflowElectronDriver } from './electron-driver.mjs';
import { seedWorkflowFixture } from './fixtures.mjs';
import { checkWorkflowInvariants } from './invariants.mjs';
import {
  runWorkflow as runWorkflowImplementation,
  runWorkflowSet as runWorkflowSetImplementation
} from './runner.mjs';
import { createWorkflowRunContext } from './run-context.mjs';
import { readWorkflowSnapshot } from './state-probe.mjs';

const fixedClock = () => new Date('2026-08-23T08:00:00.000Z');
const projectRoot = path.resolve(import.meta.dirname, '..', '..');
let integrationSequence = 220;

function state(revision, overrides = {}) {
  return {
    revision,
    savedAt: '2026-08-23T08:00:00.000Z',
    deviceProfiles: [],
    channels: [],
    requests: [],
    samples: [],
    records: [],
    storageRecords: [],
    auditLogs: [],
    formChangeJournal: [],
    requestSourceRows: [],
    testers: [],
    ...structuredClone(overrides)
  };
}

function shellSnapshot(revision, overrides = {}) {
  const persistedState = overrides.state ?? state(revision);
  return {
    sqlitePath: `X:/isolated-workflow-data/revision-${revision}.sqlite`,
    integrity: ['ok'],
    state: persistedState,
    summary: overrides.summary ?? { revision, marker: `shell-${revision}` },
    auditLogs: overrides.auditLogs ?? structuredClone(persistedState.auditLogs),
    formJournal: overrides.formJournal ?? structuredClone(persistedState.formChangeJournal),
    hash: `shell-hash-${revision}`
  };
}

function workflow(id, actions) {
  return { id, name: id, risk: 'P0', fixture: 'baseline', actions };
}

function runContextFor(item, overrides = {}) {
  const runRoot = `X:/workflow-runs/${item.id}`;
  return {
    workflowId: item.id,
    fixture: item.fixture,
    fixtureSha256: `fixture-${item.id}`,
    runRoot,
    dataRoot: `${runRoot}/work/data`,
    profileRoot: `${runRoot}/profiles`,
    exportsRoot: `${runRoot}/work/exports`,
    screenshotsRoot: `${runRoot}/artifacts/screenshots`,
    assertWritable: candidate => candidate,
    verifyProtected: async () => ({ ok: true, changed: [] }),
    cleanup: async () => undefined,
    ...overrides
  };
}

function legacyRunContext(item, context) {
  if (context?.workflowId !== undefined) return { context, legacy: false };
  const base = runContextFor(item);
  const runRoot = context?.runRoot ?? context?.dataRoot ?? base.runRoot;
  return {
    legacy: true,
    context: {
      ...base,
      ...context,
      workflowId: item.id,
      fixture: item.fixture,
      runRoot,
      dataRoot: context?.dataRoot ?? path.join(runRoot, 'work', 'data'),
      profileRoot: context?.profileRoot ?? path.join(runRoot, 'profiles'),
      exportsRoot: context?.exportsRoot ?? path.join(runRoot, 'work', 'exports'),
      screenshotsRoot: context?.screenshotsRoot ?? path.join(runRoot, 'artifacts', 'screenshots')
    }
  };
}

function legacyDependencies(dependencies, legacy) {
  if (!legacy || !dependencies?.checkInvariants) return dependencies;
  const checkInvariants = dependencies.checkInvariants;
  return {
    ...dependencies,
    checkInvariants: input => input.action?.type === 'restartVerification' ? [] : checkInvariants(input)
  };
}

function quietVerifier() {
  return {
    async start() {},
    async close() {},
    async uiProjection() { return {}; }
  };
}

async function runWorkflow(options) {
  const normalized = legacyRunContext(options.workflow, options.runContext);
  if (!normalized.legacy) return runWorkflowImplementation(options);
  const driverFactory = options.driverFactory;
  return runWorkflowImplementation({
    ...options,
    runContext: normalized.context,
    driverFactory: input => input.role === 'restart-verifier' ? quietVerifier() : driverFactory(input),
    dependencies: legacyDependencies(options.dependencies, true)
  });
}

async function runWorkflowSet(options) {
  const originalFactory = options.runContextFactory;
  const originalDriverFactory = options.driverFactory;
  return runWorkflowSetImplementation({
    ...options,
    runContextFactory: async input => {
      const context = await originalFactory(input);
      return legacyRunContext(input.workflow, context).context;
    },
    driverFactory: input => input.role === 'restart-verifier' ? quietVerifier() : originalDriverFactory(input),
    dependencies: legacyDependencies(options.dependencies, true)
  });
}

function writeAction(id = 'reserve-1') {
  return {
    id,
    type: 'reserve',
    expect: 'success',
    revisionDelta: 1,
    params: {
      requestNo: 'REQ-001',
      sampleIds: ['REQ-001.001'],
      channelKeys: ['DEV|3']
    }
  };
}

function readAction(id = 'navigate-1') {
  return {
    id,
    type: 'navigate',
    expect: 'success',
    revisionDelta: 0,
    params: { label: '看板' }
  };
}

function executionWithSettlement({ beforeState = state(10), afterState = state(11), auditIds = [] } = {}) {
  return {
    outcome: 'success',
    message: 'settled',
    uiEvidence: { projection: { currentPage: 'dashboard', summary: { revision: afterState.revision }, visible: {} } },
    settlement: Object.freeze({
      beforeRevision: beforeState.revision,
      beforeState: Object.freeze(structuredClone(beforeState)),
      persistedRevision: afterState.revision,
      state: Object.freeze(structuredClone(afterState)),
      auditIds: Object.freeze([...auditIds])
    })
  };
}

function basicDependencies({ snapshots, executeAction, checkInvariants = () => [] }) {
  let snapshotIndex = 0;
  return {
    readSnapshot: () => snapshots[Math.min(snapshotIndex++, snapshots.length - 1)],
    executeAction,
    checkInvariants,
    closeTimeoutMs: 20
  };
}

function unstartedDriver(close = async () => undefined) {
  return { start: async () => undefined, close };
}

function emptyUi(revision, overrides = {}) {
  return {
    projection: {
      currentPage: 'dashboard',
      summary: {
        revision,
        devices: 0,
        channels: 0,
        requests: 0,
        samples: 0,
        records: 0,
        storageRecords: 0,
        audits: 0,
        journalEntries: 0,
        runningRecords: 0,
        reservedRecords: 0,
        activeRecords: 0
      },
      visible: { records: [], samples: [], channels: [], todos: [], storageRecords: [] }
    },
    ...overrides
  };
}

test('已创建 context 后的 fallible setup validation 全部归一化并各保护一次', async t => {
  const cases = [
    {
      name: 'invalid workflow actions',
      selected: { ...workflow('S60', []), actions: null },
      driverFactory: async () => unstartedDriver(),
      clock: fixedClock,
      dependencies: undefined,
      expected: /workflow actions are required/i
    },
    {
      name: 'invalid driverFactory',
      selected: workflow('S61', []),
      driverFactory: null,
      clock: fixedClock,
      dependencies: undefined,
      expected: /driverFactory is required/i
    },
    {
      name: 'invalid dependency timeout',
      selected: workflow('S62', []),
      driverFactory: async () => unstartedDriver(),
      clock: fixedClock,
      dependencies: { closeTimeoutMs: 0 },
      expected: /closeTimeoutMs must be positive/i
    },
    {
      name: 'throwing clock',
      selected: workflow('S63', []),
      driverFactory: async () => unstartedDriver(),
      clock: () => { throw new Error('clock failed before driver start'); },
      dependencies: undefined,
      expected: /clock failed before driver start/i
    }
  ];

  for (const item of cases) {
    await t.test(item.name, async () => {
      let protectedCalls = 0;
      let driverCalls = 0;
      const context = runContextFor(item.selected, {
        verifyProtected: async () => {
          protectedCalls += 1;
          return { ok: true, changed: [] };
        }
      });
      const suppliedFactory = typeof item.driverFactory === 'function'
        ? async input => {
            driverCalls += 1;
            return item.driverFactory(input);
          }
        : item.driverFactory;

      const result = await runWorkflowImplementation({
        workflow: item.selected,
        runContext: context,
        driverFactory: suppliedFactory,
        clock: item.clock,
        dependencies: item.dependencies
      });

      assert.equal(result.status, 'failed');
      assert.equal(result.failure.stage, 'setup');
      assert.match(result.failure.error.message, item.expected);
      assert.equal(result.cleanup.status, 'not_started');
      assert.equal(protectedCalls, 1);
      assert.equal(driverCalls, 0);
    });
  }
});

test('runWorkflowSet 将 post-context runner reject 归一化并保留首错汇总', async () => {
  const selected = workflow('S64', []);
  let protectedCalls = 0;
  const result = await runWorkflowSetImplementation({
    workflows: [selected, workflow('S64-NOT-RUN', [])],
    runContextFactory: async () => runContextFor(selected, {
      verifyProtected: async () => {
        protectedCalls += 1;
        return { ok: true, changed: [] };
      }
    }),
    driverFactory: null,
    clock: fixedClock
  });

  assert.equal(result.status, 'failed');
  assert.equal(result.workflows.length, 1);
  assert.equal(result.workflows[0].failure.stage, 'setup');
  assert.match(result.workflows[0].failure.error.message, /driverFactory is required/i);
  assert.equal(result.failure.workflowId, 'S64');
  assert.deepEqual(result.summary, { total: 2, passed: 0, failed: 1, notRun: 1 });
  assert.equal(protectedCalls, 1);
});

test('runWorkflowSet 在 actionSourceFactory 首错后的时间戳失败中保留归一化结果并保护 context', async () => {
  const selected = workflow('S64-ACTION-SOURCE-CLOCK', []);
  const primaryError = new Error('action source factory failed');
  const timestampError = new Error('clock-after-context');
  const setStartedAt = '2026-08-23T08:00:00.000Z';
  const setFinishedAt = '2026-08-23T08:00:03.000Z';
  let clockCalls = 0;
  let protectedCalls = 0;
  let result;

  await assert.doesNotReject(async () => {
    result = await runWorkflowSetImplementation({
      workflows: [selected, workflow('S64-ACTION-SOURCE-NOT-RUN', [])],
      runContextFactory: async () => runContextFor(selected, {
        verifyProtected: async () => {
          protectedCalls += 1;
          return { ok: true, changed: [] };
        }
      }),
      driverFactory: async () => unstartedDriver(),
      actionSourceFactory: async () => { throw primaryError; },
      clock: () => {
        clockCalls += 1;
        if (clockCalls === 2) throw timestampError;
        return new Date(clockCalls === 1 ? setStartedAt : setFinishedAt);
      }
    });
  });

  assert.equal(result.status, 'failed');
  assert.equal(result.startedAt, setStartedAt);
  assert.equal(result.finishedAt, setFinishedAt);
  assert.equal(result.workflows.length, 1);
  assert.equal(result.workflows[0].startedAt, setStartedAt);
  assert.equal(result.workflows[0].finishedAt, setStartedAt);
  assert.equal(result.workflows[0].failure.error, primaryError);
  assert.equal(result.workflows[0].failure.finishedAtError, timestampError);
  assert.equal(result.failure.error, primaryError);
  assert.equal(result.failure.finishedAtError, timestampError);
  assert.deepEqual(result.summary, { total: 2, passed: 0, failed: 1, notRun: 1 });
  assert.equal(protectedCalls, 1);
});

test('runWorkflowSet 在最终时间戳失败后保留既有 workflow 结果和汇总', async () => {
  const selected = workflow('S64-SET-FINAL-CLOCK', []);
  const finalTimestampError = new Error('set-finished-clock');
  const setStartedAt = '2026-08-23T08:00:00.000Z';
  const workflowStartedAt = '2026-08-23T08:00:01.000Z';
  const workflowFinishedAt = '2026-08-23T08:00:02.000Z';
  const timestamps = [setStartedAt, workflowStartedAt, workflowFinishedAt];
  const snapshot = shellSnapshot(1);
  let protectedCalls = 0;
  let clockCalls = 0;
  let driverCalls = 0;
  let result;

  await assert.doesNotReject(async () => {
    result = await runWorkflowSetImplementation({
      workflows: [selected],
      runContextFactory: async () => runContextFor(selected, {
        verifyProtected: async () => {
          protectedCalls += 1;
          return { ok: true, changed: [] };
        }
      }),
      driverFactory: async ({ role }) => {
        driverCalls += 1;
        return role === 'restart-verifier' ? quietVerifier() : unstartedDriver();
      },
      clock: () => {
        if (clockCalls === timestamps.length) throw finalTimestampError;
        return new Date(timestamps[clockCalls++]);
      },
      dependencies: {
        readSnapshot: () => snapshot,
        checkInvariants: () => [],
        closeTimeoutMs: 20,
        profileExists: async () => false
      }
    });
  });

  assert.equal(result.status, 'failed');
  assert.equal(result.startedAt, setStartedAt);
  assert.equal(result.finishedAt, setStartedAt);
  assert.equal(result.workflows.length, 1);
  assert.equal(result.workflows[0].status, 'passed');
  assert.equal(result.workflows[0].startedAt, workflowStartedAt);
  assert.equal(result.workflows[0].finishedAt, workflowFinishedAt);
  assert.equal(result.failure.stage, 'finalize');
  assert.equal(result.failure.workflowId, null);
  assert.equal(result.failure.error, finalTimestampError);
  assert.deepEqual(result.summary, { total: 1, passed: 1, failed: 0, notRun: 0 });
  assert.equal(protectedCalls, 1);
  assert.equal(driverCalls, 2);
});

test('runWorkflowSet 原样传递 workflow/index 且 metadata mismatch 在 driver start 前 fail-close', async () => {
  const selected = workflow('S70', [readAction()]);
  const factoryInputs = [];
  let driverCalls = 0;
  let protectedCalls = 0;
  const result = await runWorkflowSetImplementation({
    workflows: [selected],
    runContextFactory: async input => {
      factoryInputs.push(input);
      return runContextFor(selected, {
        fixture: 'history',
        verifyProtected: async () => {
          protectedCalls += 1;
          return { ok: true, changed: [] };
        }
      });
    },
    driverFactory: async () => {
      driverCalls += 1;
      return unstartedDriver();
    },
    clock: fixedClock
  });

  assert.equal(factoryInputs.length, 1);
  assert.equal(factoryInputs[0].workflow, selected);
  assert.equal(factoryInputs[0].index, 0);
  assert.equal(driverCalls, 0);
  assert.equal(protectedCalls, 1);
  assert.equal(result.status, 'failed');
  assert.equal(result.workflows[0].failure.stage, 'setup');
  assert.match(result.workflows[0].failure.error.message, /fixture.*mismatch/i);
});

test('dynamic actionSource 第二次 next 收到上一步后的 fresh snapshot/UI 且 plannedActions 只含执行前缀', async () => {
  const selected = workflow('S71', []);
  const snapshots = [shellSnapshot(1), shellSnapshot(2), shellSnapshot(2)];
  let snapshotIndex = 0;
  let projectionCalls = 0;
  const nextInputs = [];
  const dynamicAction = readAction('dynamic-1');
  const result = await runWorkflow({
    workflow: selected,
    runContext: runContextFor(selected),
    driverFactory: async ({ role }) => role === 'restart-verifier'
      ? { ...unstartedDriver(), uiProjection: async () => ({ marker: 'restart' }) }
      : {
          ...unstartedDriver(),
          uiProjection: async () => ({ marker: `planning-${++projectionCalls}` })
        },
    actionSource: {
      kind: 'dynamic',
      needsUi: true,
      maxSteps: 3,
      next(input) {
        nextInputs.push(input);
        return nextInputs.length === 1 ? dynamicAction : null;
      }
    },
    clock: fixedClock,
    dependencies: {
      readSnapshot: () => snapshots[Math.min(snapshotIndex++, snapshots.length - 1)],
      executeAction: async () => ({ outcome: 'success', uiEvidence: { marker: 'action-ui' } }),
      checkInvariants: () => [],
      closeTimeoutMs: 20
    }
  });

  assert.equal(result.status, 'passed', result.failure?.error?.stack);
  assert.equal(nextInputs.length, 2);
  assert.equal(nextInputs[0].step, 0);
  assert.equal(nextInputs[0].snapshot.state.revision, 1);
  assert.equal(nextInputs[0].ui.marker, 'planning-1');
  assert.equal(nextInputs[1].step, 1);
  assert.equal(nextInputs[1].snapshot.state.revision, 2);
  assert.equal(nextInputs[1].ui.marker, 'planning-2');
  assert.equal(nextInputs[1].previousStep.actionId, 'dynamic-1');
  assert.deepEqual(result.plannedActions.map(item => item.id), ['dynamic-1']);
  assert.deepEqual(result.steps.map(item => item.actionId), ['dynamic-1']);
});

test('dynamic actionSource 与执行 context 共享 run-local runtime/runContext/armWriteLock capability', async () => {
  const selected = workflow('S71-CAPABILITY', []);
  const armWriteLock = async () => () => {};
  const runContext = runContextFor(selected, { armWriteLock });
  const nextInputs = [];
  const executionContexts = [];
  let issued = false;
  const result = await runWorkflow({
    workflow: selected,
    runContext,
    driverFactory: async ({ role }) => role === 'restart-verifier'
      ? { ...unstartedDriver(), uiProjection: async () => ({}) }
      : { ...unstartedDriver(), uiProjection: async () => ({ projection: { currentPage: 'dashboard', visible: {} } }) },
    actionSource: {
      kind: 'dynamic',
      needsUi: true,
      maxSteps: 1,
      next(input) {
        nextInputs.push(input);
        if (issued) return null;
        issued = true;
        return readAction('dynamic-capability');
      }
    },
    clock: fixedClock,
    dependencies: {
      readSnapshot: () => shellSnapshot(1),
      executeAction: async ({ context }) => {
        executionContexts.push(context);
        return { outcome: 'success', uiEvidence: {} };
      },
      checkInvariants: () => [],
      closeTimeoutMs: 20
    }
  });

  assert.equal(result.status, 'passed', result.failure?.error?.stack);
  assert.equal(nextInputs[0].runContext, runContext);
  assert.equal(nextInputs[0].runtime, executionContexts[0].runtime);
  assert.equal(executionContexts[0].armWriteLock, armWriteLock);
});

test('dynamic actionSource 超过 maxSteps 时产生 P0 且不执行越界 action', async () => {
  const selected = workflow('S72', []);
  let executeCalls = 0;
  const result = await runWorkflow({
    workflow: selected,
    runContext: runContextFor(selected),
    driverFactory: async ({ role }) => role === 'restart-verifier'
      ? { ...unstartedDriver(), uiProjection: async () => ({}) }
      : { ...unstartedDriver(), uiProjection: async () => ({}) },
    actionSource: {
      kind: 'dynamic',
      needsUi: true,
      maxSteps: 1,
      next: () => readAction(`dynamic-${executeCalls + 1}`)
    },
    clock: fixedClock,
    dependencies: {
      readSnapshot: () => shellSnapshot(executeCalls),
      executeAction: async () => {
        executeCalls += 1;
        return { outcome: 'success', uiEvidence: {} };
      },
      checkInvariants: () => [],
      closeTimeoutMs: 20
    }
  });

  assert.equal(result.status, 'failed');
  assert.equal(result.failure.violation.code, 'ACTION_SOURCE_MAX_STEPS');
  assert.equal(result.failure.violation.severity, 'P0');
  assert.equal(executeCalls, 1);
  assert.deepEqual(result.plannedActions.map(item => item.id), ['dynamic-1']);
});

test('custom actionSource 缺少 dynamic/replay kind 时在 next 前 fail-close', async () => {
  const selected = workflow('S72-KIND', []);
  let nextCalls = 0;
  let driverCalls = 0;
  const result = await runWorkflowImplementation({
    workflow: selected,
    runContext: runContextFor(selected),
    driverFactory: async ({ role }) => {
      driverCalls += 1;
      return role === 'restart-verifier'
        ? quietVerifier()
        : { ...unstartedDriver(), uiProjection: async () => ({}) };
    },
    actionSource: {
      needsUi: false,
      maxSteps: 1,
      next() { nextCalls += 1; return null; }
    },
    clock: fixedClock,
    dependencies: {
      readSnapshot: () => shellSnapshot(1),
      checkInvariants: () => [],
      closeTimeoutMs: 20
    }
  });

  assert.equal(result.status, 'failed');
  assert.equal(result.failure.stage, 'setup');
  assert.match(result.failure.error.message, /actionSource\.kind.*dynamic.*replay/i);
  assert.equal(nextCalls, 0);
  assert.equal(driverCalls, 0);
});

test('dynamic actionSource 必须显式 needsUi true 并在 next 前 fail-close', async () => {
  const selected = workflow('S72-UI-DECLARATION', []);
  let nextCalls = 0;
  const result = await runWorkflowImplementation({
    workflow: selected,
    runContext: runContextFor(selected),
    driverFactory: async ({ role }) => role === 'restart-verifier'
      ? quietVerifier()
      : { ...unstartedDriver(), uiProjection: async () => ({}) },
    actionSource: {
      kind: 'dynamic',
      needsUi: false,
      maxSteps: 1,
      next() { nextCalls += 1; return null; }
    },
    clock: fixedClock,
    dependencies: {
      readSnapshot: () => shellSnapshot(1),
      checkInvariants: () => [],
      closeTimeoutMs: 20
    }
  });

  assert.equal(result.status, 'failed');
  assert.equal(result.failure.stage, 'setup');
  assert.match(result.failure.error.message, /dynamic.*needsUi.*true/i);
  assert.equal(nextCalls, 0);
});

test('dynamic actionSource 在 primary 缺 uiProjection 时关闭 driver 且不调用 next', async () => {
  const selected = workflow('S72-UI-CAPABILITY', []);
  const events = [];
  let nextCalls = 0;
  let protectedCalls = 0;
  const result = await runWorkflowImplementation({
    workflow: selected,
    runContext: runContextFor(selected, {
      verifyProtected: async () => {
        protectedCalls += 1;
        events.push('verifyProtected');
        return { ok: true, changed: [] };
      }
    }),
    driverFactory: async ({ role }) => role === 'restart-verifier'
      ? quietVerifier()
      : {
          async start() { events.push('start:primary'); },
          async close() { events.push('close:primary'); }
        },
    actionSource: {
      kind: 'dynamic',
      needsUi: true,
      maxSteps: 1,
      next() { nextCalls += 1; return null; }
    },
    clock: fixedClock,
    dependencies: {
      readSnapshot: () => shellSnapshot(1),
      checkInvariants: () => [],
      closeTimeoutMs: 20
    }
  });

  assert.equal(result.status, 'failed');
  assert.match(result.failure.error.message, /dynamic.*uiProjection.*required/i);
  assert.equal(nextCalls, 0);
  assert.equal(protectedCalls, 1);
  assert.deepEqual(events, ['close:primary', 'verifyProtected']);
});

test('runWorkflowSet 的 actionSourceFactory 精确绑定 workflow/index/context', async () => {
  const selected = workflow('S68', []);
  const context = runContextFor(selected);
  const factoryInputs = [];
  let issued = false;
  const result = await runWorkflowSetImplementation({
    workflows: [selected],
    runContextFactory: async () => context,
    actionSourceFactory: input => {
      factoryInputs.push(input);
      return {
        kind: 'replay',
        needsUi: false,
        maxSteps: 1,
        next() {
          if (issued) return null;
          issued = true;
          return readAction('factory-action');
        }
      };
    },
    driverFactory: async () => ({ ...unstartedDriver(), uiProjection: async () => ({}) }),
    clock: fixedClock,
    dependencies: {
      readSnapshot: () => shellSnapshot(1),
      executeAction: async () => ({ outcome: 'success', uiEvidence: {} }),
      checkInvariants: () => [],
      closeTimeoutMs: 20
    }
  });

  assert.equal(result.status, 'passed');
  assert.equal(factoryInputs.length, 1);
  assert.equal(factoryInputs[0].workflow, selected);
  assert.equal(factoryInputs[0].index, 0);
  assert.equal(factoryInputs[0].runContext, context);
  assert.deepEqual(result.workflows[0].plannedActions.map(item => item.id), ['factory-action']);
});

test('成功动作后按 secondary/returned → primary → fresh restart-verifier → verifyProtected 顺序收口', async () => {
  const selected = workflow('S73', [readAction()]);
  const events = [];
  const factoryInputs = [];
  const durableState = state(10, {
    requests: [{ id: 'REQ-001', rawFields: { 备注: '保留业务字段' } }],
    auditLogs: [{ id: 'AUDIT-BUSINESS', action: '提交预约', target: 'REQ-001' }]
  });
  const restartedState = state(13, {
    requests: [{ id: 'REQ-001', rawFields: { 备注: '保留业务字段' } }],
    auditLogs: [
      { id: 'AUDIT-BUSINESS', action: '提交预约', target: 'REQ-001' },
      { id: 'AUDIT-LOGIN', action: '登录看板', target: 'dashboard' },
      { id: 'AUDIT-INIT', action: '日志初始化', target: 'logs' },
      { id: 'AUDIT-PAGE', action: '查看页面', target: 'dashboard' }
    ]
  });
  const snapshots = [
    shellSnapshot(10, { state: durableState }),
    shellSnapshot(10, { state: durableState }),
    shellSnapshot(10, { state: durableState }),
    shellSnapshot(13, { state: restartedState })
  ];
  let snapshotIndex = 0;
  const makeDriver = name => ({
    name,
    async start() { events.push(`start:${name}`); },
    async close() { events.push(`close:${name}`); },
    async uiProjection() { return { marker: name }; }
  });
  const primary = makeDriver('primary');
  const secondary = makeDriver('secondary');
  const returned = makeDriver('returned');
  const verifier = makeDriver('restart-verifier');
  let secondaryIssued = false;
  let cleanupCalls = 0;
  const context = runContextFor(selected, {
    verifyProtected: async () => {
      events.push('verifyProtected');
      return { ok: true, changed: [] };
    },
    cleanup: async () => { cleanupCalls += 1; }
  });

  const result = await runWorkflow({
    workflow: selected,
    runContext: context,
    driverFactory: async input => {
      factoryInputs.push(input);
      if (input.role === 'restart-verifier') return verifier;
      if (input.secondary === true) {
        assert.equal(secondaryIssued, false);
        secondaryIssued = true;
        return secondary;
      }
      return primary;
    },
    clock: fixedClock,
    dependencies: {
      readSnapshot: () => snapshots[Math.min(snapshotIndex++, snapshots.length - 1)],
      executeAction: async ({ context: actionContext }) => {
        const activeSecondary = await actionContext.createDriver({ session: 'B' });
        await activeSecondary.start();
        return { outcome: 'success', uiEvidence: { marker: 'action' }, drivers: [returned] };
      },
      checkInvariants: () => [],
      closeTimeoutMs: 20
    }
  });

  assert.equal(result.status, 'passed', result.failure?.error?.stack);
  assert.deepEqual(events, [
    'start:primary', 'start:secondary',
    'close:returned', 'close:secondary', 'close:primary',
    'start:restart-verifier', 'close:restart-verifier', 'verifyProtected'
  ]);
  const primaryInput = factoryInputs.find(item => item.role === 'primary');
  const verifierInput = factoryInputs.find(item => item.role === 'restart-verifier');
  assert.equal(path.relative(context.profileRoot, primaryInput.profileRoot).startsWith('..'), false);
  assert.equal(path.relative(context.profileRoot, verifierInput.profileRoot).startsWith('..'), false);
  assert.notEqual(verifierInput.profileRoot, primaryInput.profileRoot);
  assert.equal(result.restart.businessHashBefore, result.restart.businessHashAfter);
  assert.equal(result.protection.status, 'passed');
  assert.equal(cleanupCalls, 0);
});

test('复用 runContext 时 verifier 跳过 stale path 且每次 launch 与所有已用 profile 唯一', async () => {
  const selected = workflow('S73-UNIQUE', [readAction()]);
  const writableCandidates = [];
  let protectedCalls = 0;
  const context = runContextFor(selected, {
    assertWritable(candidate) {
      writableCandidates.push(path.resolve(candidate));
      return candidate;
    },
    verifyProtected: async () => {
      protectedCalls += 1;
      return { ok: true, changed: [] };
    }
  });
  const existenceChecks = [];
  let staleCandidate = null;
  const verifierPaths = [];
  const usedProfilesByRun = [];

  for (let run = 1; run <= 2; run += 1) {
    const factoryProfiles = [];
    const returnedProfile = path.join(context.profileRoot, `returned-${run}`);
    const returned = { ...unstartedDriver(), profileRoot: returnedProfile };
    const result = await runWorkflowImplementation({
      workflow: selected,
      runContext: context,
      driverFactory: async input => {
        factoryProfiles.push({ role: input.role, profileRoot: input.profileRoot });
        if (input.role === 'restart-verifier') {
          verifierPaths.push(input.profileRoot);
          return { ...unstartedDriver(), profileRoot: input.profileRoot, uiProjection: async () => ({}) };
        }
        return { ...unstartedDriver(), profileRoot: input.profileRoot, uiProjection: async () => ({}) };
      },
      clock: fixedClock,
      dependencies: {
        readSnapshot: () => shellSnapshot(1),
        executeAction: async ({ context: actionContext }) => {
          await actionContext.createDriver({ session: 'B' });
          return { outcome: 'success', uiEvidence: {}, drivers: [returned] };
        },
        checkInvariants: () => [],
        profileExists: async candidate => {
          existenceChecks.push(path.resolve(candidate));
          if (staleCandidate === null) {
            staleCandidate = path.resolve(candidate);
            return true;
          }
          return false;
        },
        closeTimeoutMs: 20
      }
    });

    assert.equal(result.status, 'passed', result.failure?.error?.stack);
    usedProfilesByRun.push([
      ...factoryProfiles.filter(item => item.role !== 'restart-verifier').map(item => item.profileRoot),
      returnedProfile
    ]);
  }

  assert.equal(existenceChecks.length, 3, 'first stale candidate plus one fresh candidate per launch');
  assert.equal(verifierPaths.length, 2);
  assert.notEqual(path.resolve(verifierPaths[0]), staleCandidate);
  assert.notEqual(path.resolve(verifierPaths[0]), path.resolve(verifierPaths[1]));
  for (let index = 0; index < verifierPaths.length; index += 1) {
    const verifier = path.resolve(verifierPaths[index]);
    const otherProfiles = usedProfilesByRun[index].map(item => path.resolve(item));
    assert.equal(otherProfiles.includes(verifier), false);
    assert.equal(path.relative(context.profileRoot, verifier).startsWith('..'), false);
    assert.equal(writableCandidates.includes(verifier), true);
  }
  assert.equal(protectedCalls, 2);
});

test('fresh verifier 改变业务 request/rawFields 时产生 RESTART_BUSINESS_HASH_MISMATCH/P0', async () => {
  const selected = workflow('S74', [readAction()]);
  const beforeState = state(4, { requests: [{ id: 'REQ-001', rawFields: { 备注: 'before' } }] });
  const changedState = state(6, {
    requests: [{ id: 'REQ-001', rawFields: { 备注: 'after' } }],
    auditLogs: [{ id: 'AUDIT-LOGIN', action: '登录看板' }]
  });
  const snapshots = [
    shellSnapshot(4, { state: beforeState }),
    shellSnapshot(4, { state: beforeState }),
    shellSnapshot(4, { state: beforeState }),
    shellSnapshot(6, { state: changedState })
  ];
  let snapshotIndex = 0;
  const result = await runWorkflow({
    workflow: selected,
    runContext: runContextFor(selected),
    driverFactory: async () => ({ ...unstartedDriver(), uiProjection: async () => ({}) }),
    clock: fixedClock,
    dependencies: {
      readSnapshot: () => snapshots[Math.min(snapshotIndex++, snapshots.length - 1)],
      executeAction: async () => ({ outcome: 'success', uiEvidence: {} }),
      checkInvariants: () => [],
      closeTimeoutMs: 20
    }
  });

  assert.equal(result.status, 'failed');
  assert.equal(result.failure.stage, 'restart-verification');
  assert.equal(result.failure.violation.code, 'RESTART_BUSINESS_HASH_MISMATCH');
  assert.equal(result.failure.violation.severity, 'P0');
});

test('fresh verifier 改变 channel current/next pointers 时 business hash 产生 P0', async () => {
  const selected = workflow('S74-CHANNEL-POINTER', [readAction()]);
  const beforeState = state(4, {
    channels: [{ key: 'DEV|1', state: 'busy', currentRecordId: 'REC-1', nextRecordId: 'REC-2' }]
  });
  const changedState = state(6, {
    channels: [{ key: 'DEV|1', state: 'busy', currentRecordId: 'REC-CHANGED', nextRecordId: 'REC-NEXT-CHANGED' }],
    auditLogs: [{ id: 'AUDIT-LOGIN', action: '登录看板' }]
  });
  const snapshots = [
    shellSnapshot(4, { state: beforeState }),
    shellSnapshot(4, { state: beforeState }),
    shellSnapshot(4, { state: beforeState }),
    shellSnapshot(6, { state: changedState })
  ];
  let snapshotIndex = 0;
  const result = await runWorkflowImplementation({
    workflow: selected,
    runContext: runContextFor(selected),
    driverFactory: async () => ({ ...unstartedDriver(), uiProjection: async () => ({}) }),
    clock: fixedClock,
    dependencies: {
      readSnapshot: () => snapshots[Math.min(snapshotIndex++, snapshots.length - 1)],
      executeAction: async () => ({ outcome: 'success', uiEvidence: {} }),
      checkInvariants: () => [],
      profileExists: async () => false,
      closeTimeoutMs: 20
    }
  });

  assert.equal(result.status, 'failed');
  assert.equal(result.failure.stage, 'restart-verification');
  assert.equal(result.failure.violation.code, 'RESTART_BUSINESS_HASH_MISMATCH');
  assert.equal(result.failure.violation.severity, 'P0');
});

test('fresh verifier 改变非 lifecycle business audit field 时 business hash 产生 P0', async () => {
  const selected = workflow('S74-BUSINESS-AUDIT', [readAction()]);
  const beforeState = state(4, {
    auditLogs: [{ id: 'AUDIT-BUSINESS', action: '提交预约', target: 'REQ-001', result: 'success', verified: true }]
  });
  const changedState = state(6, {
    auditLogs: [
      { id: 'AUDIT-BUSINESS', action: '提交预约', target: 'REQ-CHANGED', result: 'success', verified: true },
      { id: 'AUDIT-LOGIN', action: '登录看板', target: 'dashboard' }
    ]
  });
  const snapshots = [
    shellSnapshot(4, { state: beforeState }),
    shellSnapshot(4, { state: beforeState }),
    shellSnapshot(4, { state: beforeState }),
    shellSnapshot(6, { state: changedState })
  ];
  let snapshotIndex = 0;
  const result = await runWorkflowImplementation({
    workflow: selected,
    runContext: runContextFor(selected),
    driverFactory: async () => ({ ...unstartedDriver(), uiProjection: async () => ({}) }),
    clock: fixedClock,
    dependencies: {
      readSnapshot: () => snapshots[Math.min(snapshotIndex++, snapshots.length - 1)],
      executeAction: async () => ({ outcome: 'success', uiEvidence: {} }),
      checkInvariants: () => [],
      profileExists: async () => false,
      closeTimeoutMs: 20
    }
  });

  assert.equal(result.status, 'failed');
  assert.equal(result.failure.stage, 'restart-verification');
  assert.equal(result.failure.violation.code, 'RESTART_BUSINESS_HASH_MISMATCH');
  assert.equal(result.failure.violation.severity, 'P0');
});

test('verifier start 失败仍 close 后仅 verifyProtected 一次', async () => {
  const selected = workflow('S75', [readAction()]);
  const events = [];
  const snapshot = shellSnapshot(1);
  let invariantCalls = 0;
  let protectedCalls = 0;
  const restartError = new Error('restart login failed');
  const result = await runWorkflow({
    workflow: selected,
    runContext: runContextFor(selected, {
      verifyProtected: async () => {
        protectedCalls += 1;
        events.push('verifyProtected');
        return { ok: true, changed: [] };
      }
    }),
    driverFactory: async ({ role }) => role === 'restart-verifier'
      ? {
          async start() { events.push('start:restart-verifier'); throw restartError; },
          async close() { events.push('close:restart-verifier'); },
          async uiProjection() { return { consoleErrors: ['restart console error'] }; }
        }
      : {
          async start() { events.push('start:primary'); },
          async close() { events.push('close:primary'); },
          async uiProjection() { return {}; }
        },
    clock: fixedClock,
    dependencies: {
      readSnapshot: () => snapshot,
      executeAction: async () => ({ outcome: 'success', uiEvidence: {} }),
      checkInvariants: () => {
        invariantCalls += 1;
        return [];
      },
      closeTimeoutMs: 20
    }
  });

  assert.equal(result.status, 'failed');
  assert.equal(result.failure.stage, 'restart-verification');
  assert.equal(result.failure.error, restartError);
  assert.equal(invariantCalls, 2, 'durable restart invariants run before verifier start failure');
  assert.equal(protectedCalls, 1);
  assert.deepEqual(events, [
    'start:primary', 'close:primary',
    'start:restart-verifier', 'close:restart-verifier', 'verifyProtected'
  ]);
});

test('restart verifier profile path guard 拒绝后仍归一化失败并 verifyProtected 一次', async () => {
  const selected = workflow('S67', [readAction()]);
  let protectedCalls = 0;
  let driverCalls = 0;
  const context = runContextFor(selected, {
    assertWritable(candidate) {
      if (path.basename(candidate).startsWith('restart-verifier-')) throw new Error('verifier profile rejected by path guard');
      return candidate;
    },
    verifyProtected: async () => {
      protectedCalls += 1;
      return { ok: true, changed: [] };
    }
  });
  const result = await runWorkflow({
    workflow: selected,
    runContext: context,
    driverFactory: async () => {
      driverCalls += 1;
      return { ...unstartedDriver(), uiProjection: async () => ({}) };
    },
    clock: fixedClock,
    dependencies: {
      readSnapshot: () => shellSnapshot(1),
      executeAction: async () => ({ outcome: 'success', uiEvidence: {} }),
      checkInvariants: () => [],
      closeTimeoutMs: 20
    }
  });

  assert.equal(result.status, 'failed');
  assert.equal(result.failure.stage, 'restart-verification');
  assert.match(result.failure.error.message, /profile rejected by path guard/i);
  assert.equal(driverCalls, 1, 'path guard rejects before verifier factory');
  assert.equal(protectedCalls, 1);
});

test('restart verifier 缺 uiProjection capability 时 fail-close 并 verifyProtected', async () => {
  const selected = workflow('S65', [readAction()]);
  let protectedCalls = 0;
  const result = await runWorkflow({
    workflow: selected,
    runContext: runContextFor(selected, {
      verifyProtected: async () => {
        protectedCalls += 1;
        return { ok: true, changed: [] };
      }
    }),
    driverFactory: async ({ role }) => role === 'restart-verifier'
      ? unstartedDriver()
      : { ...unstartedDriver(), uiProjection: async () => emptyUi(1) },
    clock: fixedClock,
    dependencies: {
      readSnapshot: () => shellSnapshot(1),
      executeAction: async () => ({ outcome: 'success', uiEvidence: emptyUi(1) }),
      checkInvariants: () => [],
      closeTimeoutMs: 20
    }
  });

  assert.equal(result.status, 'failed');
  assert.equal(result.failure.stage, 'restart-verification');
  assert.match(result.failure.error.message, /uiProjection.*required/i);
  assert.equal(protectedCalls, 1);
});

test('context 缺 cleanup capability 时在 driver start 前 setup fail-close', async () => {
  const selected = workflow('S66', [readAction()]);
  let driverCalls = 0;
  const result = await runWorkflowImplementation({
    workflow: selected,
    runContext: runContextFor(selected, { cleanup: undefined }),
    driverFactory: async () => {
      driverCalls += 1;
      return unstartedDriver();
    },
    clock: fixedClock
  });

  assert.equal(result.status, 'failed');
  assert.equal(result.failure.stage, 'setup');
  assert.match(result.failure.error.message, /cleanup.*required/i);
  assert.equal(driverCalls, 0);
});

test('restart durable 与 fresh SQLite/UI 分别进入两次显式 invariants', async () => {
  const selected = workflow('S69', [readAction()]);
  const actionSnapshot = shellSnapshot(1);
  const restartSnapshot = shellSnapshot(1);
  const snapshots = [actionSnapshot, actionSnapshot, actionSnapshot, restartSnapshot];
  let snapshotIndex = 0;
  const inputs = [];
  const restartUi = emptyUi(1, { consoleErrors: ['restart console error'] });
  const result = await runWorkflow({
    workflow: selected,
    runContext: runContextFor(selected),
    driverFactory: async ({ role }) => role === 'restart-verifier'
      ? { ...unstartedDriver(), uiProjection: async () => restartUi }
      : { ...unstartedDriver(), uiProjection: async () => emptyUi(1) },
    clock: fixedClock,
    dependencies: {
      readSnapshot: () => snapshots[Math.min(snapshotIndex++, snapshots.length - 1)],
      executeAction: async () => ({ outcome: 'success', uiEvidence: emptyUi(1) }),
      checkInvariants: input => {
        inputs.push(input);
        return checkWorkflowInvariants(input);
      },
      closeTimeoutMs: 20
    }
  });

  assert.equal(inputs.length, 3);
  assert.equal(inputs[1].action.id, 'restart-durable');
  assert.equal(inputs[1].before, actionSnapshot);
  assert.equal(inputs[1].after, actionSnapshot);
  assert.equal(inputs[1].ui, null);
  assert.equal(inputs[2].action.id, 'restart-fresh');
  assert.equal(inputs[2].before, actionSnapshot);
  assert.equal(inputs[2].after, restartSnapshot);
  assert.equal(inputs[2].ui, restartUi);
  assert.equal(result.status, 'failed');
  assert.equal(result.failure.violation.code, 'CONSOLE_ERROR');
  assert.equal(result.failure.stage, 'restart-verification');
});

test('action failure 与 protected failure 同时保留且保护校验晚于所有 close', async () => {
  const selected = workflow('S76', [readAction()]);
  const events = [];
  const actionError = new Error('original action failure');
  const result = await runWorkflow({
    workflow: selected,
    runContext: runContextFor(selected, {
      verifyProtected: async () => {
        events.push('verifyProtected');
        return { ok: false, changed: [{ path: 'C:/protected.sqlite' }] };
      },
      cleanup: async () => { throw new Error('runner must not cleanup'); }
    }),
    driverFactory: async () => ({
      async start() { events.push('start:primary'); },
      async close() { events.push('close:primary'); }
    }),
    clock: fixedClock,
    dependencies: {
      readSnapshot: () => shellSnapshot(1),
      executeAction: async () => { throw actionError; },
      checkInvariants: () => [],
      closeTimeoutMs: 20
    }
  });

  assert.equal(result.status, 'failed');
  assert.equal(result.failure.error, actionError);
  assert.equal(result.failure.protection.violation.code, 'PROTECTED_PATH_CHANGED');
  assert.equal(result.protection.violation.severity, 'P0');
  assert.deepEqual(events, ['start:primary', 'close:primary', 'verifyProtected']);
});

test('runner 只在 action settlement 完成后读取 after snapshot', async () => {
  const events = [];
  const before = shellSnapshot(10);
  const after = shellSnapshot(11);
  let resolveSettlement;
  const settlementGate = new Promise(resolve => { resolveSettlement = resolve; });
  const fakeDriver = unstartedDriver(async () => { events.push('close'); });

  const pending = runWorkflow({
    workflow: workflow('S90', [writeAction()]),
    runContext: { dataRoot: 'X:/isolated-workflow-data' },
    driverFactory: async () => fakeDriver,
    clock: fixedClock,
    dependencies: {
      readSnapshot: () => {
        events.push(events.includes('settled') ? 'snapshot-after' : 'snapshot-before');
        return events.includes('settled') ? after : before;
      },
      executeAction: async () => {
        events.push('execute');
        await settlementGate;
        events.push('settled');
        return executionWithSettlement();
      },
      checkInvariants: () => [],
      closeTimeoutMs: 20
    }
  });

  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(events, ['snapshot-before', 'execute']);
  resolveSettlement();
  const result = await pending;

  assert.deepEqual(events, [
    'snapshot-before', 'execute', 'settled', 'snapshot-after', 'close',
    'snapshot-after', 'snapshot-after'
  ]);
  assert.equal(result.status, 'passed');
  assert.equal(result.steps[0].settlement.persistedRevision, 11);
});

test('runner 可协调冻结的正式 driver 并只关闭一次', async () => {
  let closes = 0;
  const driver = Object.freeze({
    async start() {},
    async close() { closes += 1; },
    async uiProjection() { return { projection: { currentPage: 'dashboard', summary: { revision: 10 } } }; }
  });
  const snapshot = shellSnapshot(10);
  const result = await runWorkflow({
    workflow: workflow('S89', [readAction()]),
    runContext: { dataRoot: 'X:/isolated-workflow-data' },
    driverFactory: async () => driver,
    clock: fixedClock,
    dependencies: basicDependencies({
      snapshots: [snapshot, snapshot],
      executeAction: async () => ({ outcome: 'success' })
    })
  });

  assert.equal(result.status, 'passed', result.failure?.error?.stack);
  assert.equal(result.cleanup.status, 'closed');
  assert.equal(closes, 1);
});

test('runner 在 cached stale execute 前不自行读取 projection 或 persistence boundary', async () => {
  const events = [];
  const driver = {
    async start() { events.push('start'); },
    async uiProjection() { events.push('runner-projection'); throw new Error('unexpected projection'); },
    async capturePersistenceBoundary() { events.push('runner-boundary'); throw new Error('unexpected boundary'); },
    async close() { events.push('close'); }
  };
  const result = await runWorkflow({
    workflow: workflow('S78', [writeAction('cached-stale')]),
    runContext: { dataRoot: 'X:/isolated-workflow-data' },
    driverFactory: async () => driver,
    clock: fixedClock,
    dependencies: basicDependencies({
      snapshots: [shellSnapshot(10), shellSnapshot(11)],
      executeAction: async () => {
        assert.equal(events.includes('runner-projection'), false);
        assert.equal(events.includes('runner-boundary'), false);
        events.push('cached-stale-click');
        return executionWithSettlement();
      }
    })
  });

  assert.equal(result.status, 'passed');
  assert.deepEqual(events, ['start', 'cached-stale-click', 'close']);
});

test('driverFactory 返回未启动 primary，runner 在首个 snapshot 前负责 start', async () => {
  const events = [];
  const result = await runWorkflow({
    workflow: workflow('S79', [readAction()]),
    runContext: { dataRoot: 'X:/isolated-workflow-data' },
    driverFactory: async () => {
      events.push('factory');
      return {
        async start() { events.push('start'); },
        async close() { events.push('close'); }
      };
    },
    clock: fixedClock,
    dependencies: {
      readSnapshot: () => { events.push('snapshot'); return shellSnapshot(1); },
      executeAction: async () => { events.push('execute'); return { outcome: 'success', uiEvidence: {} }; },
      checkInvariants: () => { events.push('invariants'); return []; },
      closeTimeoutMs: 20
    }
  });

  assert.equal(result.status, 'passed');
  assert.deepEqual(events, [
    'factory', 'start', 'snapshot', 'execute', 'snapshot', 'invariants', 'close',
    'snapshot', 'snapshot'
  ]);
});

test('write action 缺少 settlement 时拒绝且不读取 after snapshot', async () => {
  let snapshotCalls = 0;
  let closeCalls = 0;
  const result = await runWorkflow({
    workflow: workflow('S91', [writeAction()]),
    runContext: { dataRoot: 'X:/isolated-workflow-data' },
    driverFactory: async () => unstartedDriver(async () => { closeCalls += 1; }),
    clock: fixedClock,
    dependencies: {
      readSnapshot: () => { snapshotCalls += 1; return shellSnapshot(10); },
      executeAction: async () => ({ outcome: 'success', uiEvidence: {} }),
      checkInvariants: () => [],
      closeTimeoutMs: 20
    }
  });

  assert.equal(result.status, 'failed');
  assert.match(result.failure.error.message, /reserve.*missing settled action evidence/i);
  assert.equal(snapshotCalls, 1);
  assert.equal(closeCalls, 1);
});

test('settlement 与 fresh shell revision 漂移产生 P0 并停止下一动作', async () => {
  let executeCalls = 0;
  const before = shellSnapshot(10);
  const driftedShell = shellSnapshot(12);
  const result = await runWorkflow({
    workflow: workflow('S92', [writeAction('first'), readAction('second')]),
    runContext: { dataRoot: 'X:/isolated-workflow-data' },
    driverFactory: async () => unstartedDriver(),
    clock: fixedClock,
    dependencies: basicDependencies({
      snapshots: [before, driftedShell],
      executeAction: async () => { executeCalls += 1; return executionWithSettlement(); }
    })
  });

  assert.equal(result.status, 'failed');
  assert.equal(result.failure.violation.code, 'SETTLEMENT_SNAPSHOT_DRIFT');
  assert.equal(result.failure.violation.severity, 'P0');
  assert.deepEqual(result.failure.violation.entityIds, ['first']);
  assert.equal(result.steps.length, 0);
  assert.equal(executeCalls, 1);
});

test('page preparation revision 只计入 step-start 成本，formal before 使用 settlement boundary', async () => {
  const stepStart = shellSnapshot(10);
  const formalBefore = state(11, {
    auditLogs: [{ id: 'AUDIT-PREPARE', action: '查看页面' }]
  });
  const formalAfter = state(12, {
    auditLogs: [
      { id: 'AUDIT-PREPARE', action: '查看页面' },
      { id: 'AUDIT-WRITE', action: '提交预约' }
    ]
  });
  const freshAfter = shellSnapshot(12);
  let invariantInput;

  const result = await runWorkflow({
    workflow: workflow('S88', [writeAction()]),
    runContext: { dataRoot: 'X:/isolated-workflow-data' },
    driverFactory: async () => unstartedDriver(),
    clock: fixedClock,
    dependencies: basicDependencies({
      snapshots: [stepStart, freshAfter],
      executeAction: async () => executionWithSettlement({
        beforeState: formalBefore,
        afterState: formalAfter,
        auditIds: ['AUDIT-WRITE']
      }),
      checkInvariants: input => { invariantInput = input; return []; }
    })
  });

  assert.equal(result.status, 'passed');
  assert.equal(invariantInput.before.state.revision, 11);
  assert.equal(invariantInput.before.summary.revision, 11);
  assert.equal(invariantInput.before.sqlitePath, stepStart.sqlitePath);
  assert.deepEqual(invariantInput.before.integrity, stepStart.integrity);
  assert.deepEqual(invariantInput.before.boundaryMetadata, {
    source: 'step-start-shell',
    shellRevision: 10,
    sqlitePath: stepStart.sqlitePath,
    integrity: ['ok']
  });
  assert.equal(invariantInput.after.state.revision, 12);
  assert.equal(result.steps[0].revisionBefore, 11);
  assert.equal(result.steps[0].revisionAfter, 12);
  assert.deepEqual(result.steps[0].auditEvidence.auditLogs.map(item => item.id), ['AUDIT-WRITE']);
});

test('write step 从 settlement state 重建 boundary、精确过滤 auditIds 并计算 journal 差异', async () => {
  const beforeState = state(10, {
    requests: [{ id: 'REQ-001', rawFields: {}, sourceFile: 'a.xlsx', sourcePath: 'X:/a.xlsx' }],
    auditLogs: [{ id: 'AUDIT-OLD', action: 'old' }],
    formChangeJournal: [{ id: 'J-OLD', value: 'old' }]
  });
  const afterState = state(11, {
    requests: [{ id: 'REQ-001', rawFields: {}, sourceFile: 'a.xlsx', sourcePath: 'X:/a.xlsx' }],
    auditLogs: [
      { id: 'AUDIT-OLD', action: 'old' },
      { id: 'AUDIT-MATCH', action: '提交预约' },
      { id: 'AUDIT-OTHER', action: '查看页面' }
    ],
    formChangeJournal: [
      { id: 'J-OLD', value: 'old' },
      { id: 'J-NEW', value: 'new' }
    ]
  });
  const beforeShell = shellSnapshot(10, {
    state: state(10),
    summary: { revision: 999, marker: 'stale-before-shell' },
    auditLogs: [{ id: 'SHELL-BEFORE' }],
    formJournal: [{ id: 'SHELL-JOURNAL-BEFORE' }]
  });
  const afterShell = shellSnapshot(11, {
    state: state(11),
    summary: { revision: 999, marker: 'stale-after-shell' },
    auditLogs: [{ id: 'SHELL-AFTER' }],
    formJournal: [{ id: 'SHELL-JOURNAL-AFTER' }]
  });
  let invariantInput;

  const result = await runWorkflow({
    workflow: workflow('S93', [writeAction()]),
    runContext: { dataRoot: 'X:/isolated-workflow-data' },
    driverFactory: async () => unstartedDriver(),
    clock: fixedClock,
    dependencies: basicDependencies({
      snapshots: [beforeShell, afterShell],
      executeAction: async () => executionWithSettlement({
        beforeState,
        afterState,
        auditIds: ['AUDIT-MATCH']
      }),
      checkInvariants: input => { invariantInput = input; return []; }
    })
  });

  assert.notEqual(invariantInput.before.state, beforeState, 'runner uses an immutable clone, not the same state reference');
  assert.equal(invariantInput.before.state.revision, 10);
  assert.deepEqual(invariantInput.before.auditLogs.map(item => item.id), ['AUDIT-OLD']);
  assert.deepEqual(invariantInput.after.auditLogs.map(item => item.id), ['AUDIT-OLD', 'AUDIT-MATCH', 'AUDIT-OTHER']);
  assert.equal(invariantInput.before.summary.revision, 10);
  assert.equal(invariantInput.before.summary.requests, 1);
  assert.equal(invariantInput.after.summary.revision, 11);
  assert.deepEqual(invariantInput.after.integrity, ['ok']);
  assert.equal(invariantInput.after.sqlitePath, afterShell.sqlitePath);
  assert.deepEqual(result.steps[0].auditEvidence.auditLogs.map(item => item.id), ['AUDIT-MATCH']);
  assert.deepEqual(result.steps[0].auditEvidence.formJournal.map(item => item.id), ['J-NEW']);
});

test('read action 无 settlement 时使用 shell snapshots，P2 记录但不阻断', async () => {
  let executeCalls = 0;
  let invariantCalls = 0;
  const snapshots = [shellSnapshot(20), shellSnapshot(20), shellSnapshot(20), shellSnapshot(20)];
  const result = await runWorkflow({
    workflow: workflow('S94', [readAction('first'), readAction('second')]),
    runContext: { dataRoot: 'X:/isolated-workflow-data' },
    driverFactory: async () => unstartedDriver(),
    clock: fixedClock,
    dependencies: basicDependencies({
      snapshots,
      executeAction: async () => {
        executeCalls += 1;
        return { outcome: 'success', uiEvidence: { marker: executeCalls } };
      },
      checkInvariants: () => {
        invariantCalls += 1;
        return invariantCalls === 1
          ? [{ code: 'CHANNEL_DOM_LIMIT', severity: 'P2', message: 'advisory', entityIds: [] }]
          : [];
      }
    })
  });

  assert.equal(result.status, 'passed');
  assert.equal(executeCalls, 2);
  assert.equal(result.steps.length, 2);
  assert.deepEqual(result.steps[0].violations.map(item => item.code), ['CHANNEL_DOM_LIMIT']);
  assert.equal(result.steps[0].settlement, null);
});

for (const severity of ['P0', 'P1']) {
  test(`runner 在第一项 ${severity} 后停止并保留首个 blocking violation`, async () => {
    let executeCalls = 0;
    const blocking = { code: `${severity}_FIRST`, severity, message: 'first blocking', entityIds: ['first'] };
    const result = await runWorkflow({
      workflow: workflow('S95', [readAction('first'), readAction('second')]),
      runContext: { dataRoot: 'X:/isolated-workflow-data' },
      driverFactory: async () => unstartedDriver(),
      clock: fixedClock,
      dependencies: basicDependencies({
        snapshots: [shellSnapshot(1)],
        executeAction: async () => { executeCalls += 1; return { outcome: 'success', uiEvidence: {} }; },
        checkInvariants: () => [
          { code: 'P2_BEFORE', severity: 'P2', message: 'advisory', entityIds: [] },
          blocking,
          { code: 'P0_LATER', severity: 'P0', message: 'later', entityIds: [] }
        ]
      })
    });

    assert.equal(result.status, 'failed');
    assert.equal(result.steps.length, 1);
    assert.equal(result.failure.violation.code, `${severity}_FIRST`);
    assert.equal(executeCalls, 1);
  });
}

test('首错后逆序有界关闭 runner 创建和 action 返回的全部 driver', async () => {
  const events = [];
  const closeCounts = new Map();
  const makeDriver = name => ({
    name,
    async start() { events.push(`start:${name}`); },
    async close() {
      closeCounts.set(name, (closeCounts.get(name) || 0) + 1);
      events.push(`close:${name}`);
    }
  });
  const primary = makeDriver('primary');
  const secondary = makeDriver('secondary');
  const returned = makeDriver('returned');
  let factoryCalls = 0;

  const result = await runWorkflow({
    workflow: workflow('S87', [readAction()]),
    runContext: { dataRoot: 'X:/isolated-workflow-data' },
    driverFactory: async () => factoryCalls++ === 0 ? primary : secondary,
    clock: fixedClock,
    dependencies: basicDependencies({
      snapshots: [shellSnapshot(1), shellSnapshot(1)],
      executeAction: async ({ context }) => {
        const activeSecondary = await context.createDriver({ session: 'B' });
        await activeSecondary.start();
        return {
          outcome: 'success',
          uiEvidence: {},
          drivers: [returned]
        };
      },
      checkInvariants: () => [{
        code: 'STOP_AFTER_DRIVER_CREATION', severity: 'P0', message: 'stop', entityIds: []
      }]
    })
  });

  assert.equal(result.status, 'failed');
  assert.deepEqual(events.filter(item => item.startsWith('close:')), [
    'close:returned', 'close:secondary', 'close:primary'
  ]);
  assert.deepEqual(Object.fromEntries(closeCounts), {
    returned: 1,
    secondary: 1,
    primary: 1
  });
  assert.deepEqual(result.cleanup.drivers.map(item => item.name), [
    'returned', 'secondary', 'primary'
  ]);
});

test('M05 在 closeSecondSession 前失败不会泄漏已启动的 secondary driver', async () => {
  const events = [];
  const original = new Error('M05 failed before closeSecondSession');
  const makeDriver = name => ({
    name,
    async start() { events.push(`start:${name}`); },
    async close() { events.push(`close:${name}`); }
  });
  const primary = makeDriver('primary');
  const secondary = makeDriver('secondary');
  let factoryCalls = 0;
  let actionCalls = 0;

  const result = await runWorkflow({
    workflow: workflow('M05', [readAction('open-second'), readAction('fails-before-close')]),
    runContext: { dataRoot: 'X:/isolated-workflow-data' },
    driverFactory: async () => factoryCalls++ === 0 ? primary : secondary,
    clock: fixedClock,
    dependencies: basicDependencies({
      snapshots: [shellSnapshot(1), shellSnapshot(1), shellSnapshot(1)],
      executeAction: async ({ context }) => {
        actionCalls += 1;
        if (actionCalls === 2) throw original;
        const activeSecondary = await context.createDriver({ session: 'B' });
        context.runtime.secondDriver = activeSecondary;
        await activeSecondary.start();
        return { outcome: 'success', uiEvidence: {} };
      }
    })
  });

  assert.equal(result.status, 'failed');
  assert.equal(result.failure.error, original);
  assert.equal(result.lastSuccessfulActionId, 'open-second');
  assert.deepEqual(events, [
    'start:primary', 'start:secondary', 'close:secondary', 'close:primary'
  ]);
});

test('action timeout/poisoned error 返回失败、停止后续动作并在 finally close 一次', async () => {
  const original = Object.assign(new Error('[reserve] execute: timed out'), { code: 'ACTION_TIMEOUT', poisoned: true });
  let executeCalls = 0;
  let closeCalls = 0;
  const result = await runWorkflow({
    workflow: workflow('S96', [writeAction('timeout'), readAction('never')]),
    runContext: { dataRoot: 'X:/isolated-workflow-data' },
    driverFactory: async () => unstartedDriver(async () => { closeCalls += 1; }),
    clock: fixedClock,
    dependencies: basicDependencies({
      snapshots: [shellSnapshot(10)],
      executeAction: async () => { executeCalls += 1; throw original; }
    })
  });

  assert.equal(result.status, 'failed');
  assert.equal(result.failure.error, original);
  assert.equal(result.failure.error.code, 'ACTION_TIMEOUT');
  assert.equal(executeCalls, 1);
  assert.equal(closeCalls, 1);
});

test('默认 action executor 已关闭 poisoned active driver 时 runner 不重复实质 close', async () => {
  let closeCalls = 0;
  let rejectClick;
  const clickGate = new Promise((_, reject) => { rejectClick = reject; });
  void clickGate.catch(() => undefined);
  const locator = {
    async count() { return 1; },
    click() { return clickGate; }
  };
  const driver = {
    name: 'default-timeout-driver',
    async start() {},
    page: () => ({ locator: () => locator }),
    uiProjection: async () => ({
      projection: {
        currentPage: 'dashboard',
        summary: { revision: 1 },
        visible: { records: [], samples: [], channels: [], todos: [] }
      }
    }),
    async close() {
      closeCalls += 1;
      rejectClick(new Error('click cancelled by driver close'));
    }
  };

  const result = await runWorkflow({
    workflow: workflow('S86', [{ ...readAction(), maxMs: 10 }]),
    runContext: { dataRoot: 'X:/isolated-workflow-data' },
    driverFactory: async () => driver,
    clock: fixedClock,
    dependencies: {
      readSnapshot: () => shellSnapshot(1),
      checkInvariants: () => [],
      closeTimeoutMs: 50
    }
  });

  assert.equal(result.status, 'failed');
  assert.equal(result.failure.error.code, 'ACTION_TIMEOUT');
  assert.equal(closeCalls, 1);
  assert.deepEqual(result.cleanup.drivers.map(item => item.status), ['closed']);
});

test('close 失败保留原 action error 并追加 cleanup 上下文', async () => {
  const original = new Error('original action failure');
  const closeError = new Error('close failed');
  let closeCalls = 0;
  const result = await runWorkflow({
    workflow: workflow('S97', [readAction()]),
    runContext: { dataRoot: 'X:/isolated-workflow-data' },
    driverFactory: async () => unstartedDriver(async () => { closeCalls += 1; throw closeError; }),
    clock: fixedClock,
    dependencies: basicDependencies({
      snapshots: [shellSnapshot(1)],
      executeAction: async () => { throw original; }
    })
  });

  assert.equal(result.status, 'failed');
  assert.equal(result.failure.error, original);
  assert.equal(result.failure.cleanup.status, 'failed');
  assert.equal(result.failure.cleanup.error, closeError);
  assert.equal(closeCalls, 1);
});

test('close 挂起通过注入 scheduler 有界返回且不掩盖原 action error', { timeout: 1_000 }, async () => {
  const original = new Error('original before hanging close');
  let closeCalls = 0;
  const scheduled = [];
  const cleared = [];
  const result = await runWorkflow({
    workflow: workflow('S98', [readAction()]),
    runContext: { dataRoot: 'X:/isolated-workflow-data' },
    driverFactory: async () => unstartedDriver(async () => {
      closeCalls += 1;
      return new Promise(() => {});
    }),
    clock: fixedClock,
    dependencies: {
      ...basicDependencies({
        snapshots: [shellSnapshot(1)],
        executeAction: async () => { throw original; }
      }),
      closeTimeoutMs: 30,
      scheduleTimeout(callback, timeoutMs) {
        scheduled.push(timeoutMs);
        queueMicrotask(callback);
        return 'cleanup-timer';
      },
      clearScheduledTimeout(token) { cleared.push(token); }
    }
  });

  assert.deepEqual(scheduled, [30]);
  assert.deepEqual(cleared, ['cleanup-timer']);
  assert.equal(result.failure.error, original);
  assert.equal(result.failure.cleanup.status, 'timed_out');
  assert.equal(closeCalls, 1);
});

test('成功 workflow 的 close 失败会转为 cleanup failure', async () => {
  const closeError = new Error('cannot close');
  const result = await runWorkflow({
    workflow: workflow('S89', [readAction()]),
    runContext: { dataRoot: 'X:/isolated-workflow-data' },
    driverFactory: async () => unstartedDriver(async () => { throw closeError; }),
    clock: fixedClock,
    dependencies: basicDependencies({
      snapshots: [shellSnapshot(1), shellSnapshot(1)],
      executeAction: async () => ({ outcome: 'success', uiEvidence: {} })
    })
  });

  assert.equal(result.status, 'failed');
  assert.equal(result.failure.stage, 'cleanup');
  assert.equal(result.failure.error, closeError);
  assert.equal(result.failure.cleanup.status, 'failed');
});

test('runWorkflowSet 顺序汇总全部成功 workflow', async () => {
  const contextIds = [];
  const result = await runWorkflowSet({
    workflows: [workflow('S80', [readAction()]), workflow('S81', [readAction()])],
    runContextFactory: async ({ workflow: item }) => {
      contextIds.push(item.id);
      return { dataRoot: `X:/runs/${item.id}` };
    },
    driverFactory: async () => unstartedDriver(),
    clock: fixedClock,
    dependencies: basicDependencies({
      snapshots: [shellSnapshot(1)],
      executeAction: async () => ({ outcome: 'success', uiEvidence: {} })
    })
  });

  assert.equal(result.status, 'passed');
  assert.deepEqual(contextIds, ['S80', 'S81']);
  assert.deepEqual(result.workflows.map(item => item.workflowId), ['S80', 'S81']);
  assert.deepEqual(result.summary, { total: 2, passed: 2, failed: 0, notRun: 0 });
});

test('runWorkflowSet 在首个 workflow 失败后停止并显式汇总未运行数量', async () => {
  let contextCalls = 0;
  const original = new Error('first workflow failed');
  const result = await runWorkflowSet({
    workflows: [workflow('S82', [readAction()]), workflow('S83', [readAction()])],
    runContextFactory: async ({ workflow: item }) => {
      contextCalls += 1;
      return { dataRoot: `X:/runs/${item.id}` };
    },
    driverFactory: async () => unstartedDriver(),
    clock: fixedClock,
    dependencies: basicDependencies({
      snapshots: [shellSnapshot(1)],
      executeAction: async () => { throw original; }
    })
  });

  assert.equal(result.status, 'failed');
  assert.equal(result.workflows.length, 1);
  assert.equal(result.failure.workflowId, 'S82');
  assert.equal(result.failure.error, original);
  assert.deepEqual(result.summary, { total: 2, passed: 0, failed: 1, notRun: 1 });
  assert.equal(contextCalls, 1);
});

test('runWorkflowSet 将 runContextFactory setup 错误归一化并汇总未运行 workflow', async () => {
  const setupError = new Error('fixture setup failed');
  let driverCalls = 0;
  const result = await runWorkflowSet({
    workflows: [workflow('S84', [readAction()]), workflow('S85', [readAction()])],
    runContextFactory: async () => { throw setupError; },
    driverFactory: async () => { driverCalls += 1; return unstartedDriver(); },
    clock: fixedClock
  });

  assert.equal(result.status, 'failed');
  assert.equal(result.workflows.length, 1);
  assert.equal(result.workflows[0].workflowId, 'S84');
  assert.equal(result.workflows[0].status, 'failed');
  assert.equal(result.workflows[0].failure.stage, 'setup');
  assert.equal(result.workflows[0].failure.error, setupError);
  assert.equal(result.failure.workflowId, 'S84');
  assert.equal(result.failure.error, setupError);
  assert.deepEqual(result.summary, { total: 2, passed: 0, failed: 1, notRun: 1 });
  assert.equal(driverCalls, 0);
});

test('真实 ready-driver 默认链从 dashboard 准备 apply 后以 formal settlement boundary 运行首个 write', { timeout: 40_000 }, async t => {
  const value = integrationSequence++;
  const baseRunContext = await createWorkflowRunContext({
    projectRoot,
    mode: 'quick',
    now: fixedClock,
    randomBytes: () => Buffer.from([
      (process.pid >>> 16) & 0xff,
      (process.pid >>> 8) & 0xff,
      process.pid & 0xff,
      value
    ])
  });
  const selectedWorkflow = {
    ...workflow('S77', [{
      ...writeAction('real-reserve'),
      maxMs: 15_000,
      params: {}
    }]),
    fixture: 'production-529'
  };
  await seedWorkflowFixture({
    dataRoot: baseRunContext.dataRoot,
    kind: selectedWorkflow.fixture,
    workflowId: selectedWorkflow.id,
    clock: fixedClock
  });
  const runContext = Object.freeze({
    ...baseRunContext,
    workflowId: selectedWorkflow.id,
    fixture: selectedWorkflow.fixture,
    fixtureSha256: 'runner-ready-production-529'
  });
  t.after(() => rm(runContext.runRoot, { recursive: true, force: true }));
  const seeded = readWorkflowSnapshot({ dataRoot: runContext.dataRoot });
  const pending = seeded.state.samples.find(item => item.status === 'pending');
  const freeChannel = channelCandidates(seeded.state, { mode: 'reserve', limit: 40 }).items[0];
  assert.ok(pending && freeChannel);
  const result = await runWorkflow({
    workflow: {
      ...selectedWorkflow,
      actions: [{
      ...writeAction('real-reserve'),
      maxMs: 15_000,
      params: {
        requestNo: pending.requestNo || pending.id.split('.')[0],
        sampleIds: [pending.id],
        channelKeys: [freeChannel.key],
        start: '2026-08-22T09:00',
        end: '2026-08-22T10:00',
        actor: 'runner-ready-integration'
      }
    }]
    },
    runContext,
    driverFactory: async ({ role, profileRoot }) => {
      const actor = 'runner-ready-integration';
      const raw = createWorkflowElectronDriver({
        projectRoot,
        dataRoot: runContext.dataRoot,
        profileRoot,
        viewport: '1366x768',
        timeoutMs: 25_000
      });
      return {
        name: role,
        async start() {
          await raw.start();
          const page = raw.page();
          await page.locator('#username').fill(actor);
          await page.locator('#login .btn.wide').click();
          await page.waitForFunction(() => window.__batteryAppReady === true);
          await raw.waitForPersistenceBarrier({
            auditAction: '登录看板', actor, timeoutMs: 5_000
          });
        },
        close: () => raw.close(),
        page: () => raw.page(),
        uiProjection: () => raw.uiProjection(),
        capturePersistenceBoundary: options => raw.capturePersistenceBoundary(options),
        waitForPersistenceBarrier: options => raw.waitForPersistenceBarrier(options)
      };
    },
    clock: fixedClock
  });

  assert.equal(
    result.status,
    'passed',
    result.failure?.error?.stack || JSON.stringify(result.failure?.violation || result.failure)
  );
  assert.equal(result.steps.length, 1);
  assert.equal(result.steps[0].revisionAfter - result.steps[0].revisionBefore, 1);
  assert.ok(result.steps[0].revisionBefore > seeded.state.revision, 'apply page preparation has its own revision cost');
  assert.equal(result.steps[0].settlement.finalPage, 'apply');
  assert.equal(result.steps[0].auditEvidence.auditLogs.length, 1);
  assert.equal(result.steps[0].auditEvidence.auditLogs[0].action, '提交预约');
});

test('真实 S02/S03 完整目录各连续两轮并通过 fresh profile 与 protected verification', { timeout: 360_000 }, async t => {
  const selected = STANDARD_WORKFLOWS.filter(item => ['S02', 'S03'].includes(item.id));
  const runRoots = [];

  for (let round = 1; round <= 2; round += 1) {
    const factoryEvidence = [];
    const result = await runWorkflowSetImplementation({
      workflows: selected,
      runContextFactory: async ({ workflow: item, index }) => {
        const base = await createWorkflowRunContext({
          projectRoot,
          mode: `task9-${item.id.toLowerCase()}-round-${round}-index-${index}`
        });
        await seedWorkflowFixture({
          dataRoot: base.dataRoot,
          kind: item.fixture,
          workflowId: item.id,
          clock: fixedClock
        });
        const seeded = readWorkflowSnapshot({ dataRoot: base.dataRoot });
        const context = Object.freeze({
          ...base,
          workflowId: item.id,
          fixture: item.fixture,
          fixtureSha256: seeded.hash
        });
        runRoots.push(context.runRoot);
        return context;
      },
      driverFactory: async ({ workflow: item, runContext, role, profileRoot }) => {
        factoryEvidence.push({ workflowId: item.id, role, profileRoot, parent: runContext.profileRoot });
        const actor = `Task 9 ${item.id}`;
        const raw = createWorkflowElectronDriver({
          projectRoot,
          dataRoot: runContext.dataRoot,
          profileRoot,
          viewport: '1366x768',
          timeoutMs: 25_000
        });
        return {
          name: `${item.id}-${role}`,
          async start() {
            await raw.start();
            const page = raw.page();
            await page.locator('#username').fill(actor);
            await page.locator('#login .btn.wide').click();
            await page.waitForFunction(() => window.__batteryAppReady === true);
            await raw.waitForPersistenceBarrier({ auditAction: '登录看板', actor, timeoutMs: 5_000 });
          },
          restart: () => raw.restart(),
          close: () => raw.close(),
          page: () => raw.page(),
          uiProjection: () => raw.uiProjection(),
          capturePersistenceBoundary: options => raw.capturePersistenceBoundary(options),
          waitForPersistenceBarrier: options => raw.waitForPersistenceBarrier(options)
        };
      },
      clock: fixedClock
    });

    assert.equal(
      result.status,
      'passed',
      result.failure?.error?.stack || JSON.stringify(result.failure?.violation || result.failure)
    );
    assert.deepEqual(result.workflows.map(item => item.workflowId), ['S02', 'S03']);
    for (const workflowResult of result.workflows) {
      const catalog = selected.find(item => item.id === workflowResult.workflowId);
      assert.equal(workflowResult.status, 'passed');
      assert.deepEqual(workflowResult.plannedActions.map(item => item.id), catalog.actions.map(item => item.id));
      assert.equal(workflowResult.steps.length, catalog.actions.length);
      assert.equal(workflowResult.cleanup.status, 'closed');
      assert.equal(workflowResult.restart.cleanup.status, 'closed');
      assert.equal(workflowResult.protection.status, 'passed');
      const profiles = factoryEvidence.filter(item => item.workflowId === workflowResult.workflowId);
      const primary = profiles.find(item => item.role === 'primary');
      const verifier = profiles.find(item => item.role === 'restart-verifier');
      assert.ok(primary && verifier);
      assert.notEqual(path.resolve(primary.profileRoot), path.resolve(verifier.profileRoot));
      assert.equal(path.relative(verifier.parent, verifier.profileRoot).startsWith('..'), false);
    }
    t.diagnostic(`Task 9 S02/S03 round ${round} run roots: ${runRoots.slice(-2).join(' | ')}`);
  }
});
