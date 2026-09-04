import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { createRecordedActionSource } from './chaos-planner.mjs';
import { exitCodeForWorkflow, runSelectedSuites, runWorkflowCli } from './cli.mjs';
import { checkWorkflowInvariants } from './invariants.mjs';
import { readReplayReport, validateWorkflowReport } from './report-writer.mjs';
import { runWorkflow } from './runner.mjs';
import { canonicalStateHash, summarizeState } from './state-probe.mjs';

const projectRoot = path.resolve(import.meta.dirname, '../..');

function validState() {
  return {
    revision: 4,
    savedAt: '2026-08-22T08:00:00.000Z',
    deviceProfiles: [{ id: 'D-1', name: '设备 A' }],
    requests: [{
      id: 'REQ-1',
      rawFields: { 委托单号: 'REQ-1' },
      sourceFile: 'request.xlsx',
      sourcePath: 'C:/isolated/request.xlsx'
    }],
    channels: [{ key: '设备 A|001', state: 'busy', currentRecordId: 'REC-1', nextRecordId: '' }],
    samples: [{ id: 'REQ-1.001', requestNo: 'REQ-1', status: 'running', channelKey: '设备 A|001' }],
    records: [{
      id: 'REC-1', requestNo: 'REQ-1', sampleId: 'REQ-1.001', channelKey: '设备 A|001', status: 'running'
    }],
    requestSourceRows: [{
      id: 'REQ-1', requestNo: 'REQ-1', sourceFile: 'request.xlsx', sourcePath: 'C:/isolated/request.xlsx'
    }],
    auditLogs: [],
    formChangeJournal: [],
    testers: []
  };
}

function snapshot(state) {
  return {
    integrity: ['ok'],
    state,
    auditLogs: structuredClone(state.auditLogs),
    formJournal: structuredClone(state.formChangeJournal),
    summary: summarizeState(state),
    hash: canonicalStateHash(state),
    sqlitePath: 'C:/isolated-task12/battery-channel-hub.sqlite'
  };
}

function mutationInput() {
  const beforeState = validState();
  const afterState = structuredClone(beforeState);
  afterState.channels[0].currentRecordId = 'MISSING-RECORD';
  return {
    before: snapshot(beforeState),
    after: snapshot(afterState),
    action: {
      id: 'inspect-current-pointer',
      type: 'navigate',
      params: { label: '看板' },
      expect: 'success',
      outcome: 'success',
      revisionDelta: 0,
      maxMs: 1_000
    },
    ui: null,
    restart: null
  };
}

test('故意制造的通道 currentRecordId 分裂产生 RUNNING_POINTER_SPLIT/P0', () => {
  const violations = checkWorkflowInvariants(mutationInput());
  const split = violations.find(item => item.code === 'RUNNING_POINTER_SPLIT');

  assert.ok(split);
  assert.equal(split.severity, 'P0');
  assert.deepEqual(split.entityIds, ['MISSING-RECORD', 'REC-1', 'REQ-1.001', '设备 A|001']);
});

test('真实 runner 将指针分裂保留为首个 blocking violation 且 CLI 映射为非零', async () => {
  const input = mutationInput();
  const snapshots = [input.before, input.after];
  const runRoot = path.resolve('C:/isolated-task12');
  const workflow = {
    id: 'TASK12-MUTATION',
    fixture: 'baseline',
    actions: [{ ...input.action, outcome: undefined }]
  };
  const result = await runWorkflow({
    workflow,
    runContext: {
      workflowId: workflow.id,
      fixture: workflow.fixture,
      fixtureSha256: 'task12-mutation-fixture',
      runRoot,
      dataRoot: path.join(runRoot, 'data'),
      profileRoot: path.join(runRoot, 'profiles'),
      exportsRoot: path.join(runRoot, 'exports'),
      screenshotsRoot: path.join(runRoot, 'screenshots'),
      assertWritable(candidate) { return candidate; },
      async verifyProtected() { return { ok: true, changed: [] }; },
      async cleanup() {}
    },
    async driverFactory() {
      return {
        async start() {},
        async close() {}
      };
    },
    clock: () => new Date('2026-08-22T08:00:00.000Z'),
    dependencies: {
      readSnapshot: async () => structuredClone(snapshots.shift()),
      executeAction: async () => ({ outcome: 'success' }),
      isWriteAction: () => false
    }
  });

  assert.equal(result.status, 'failed');
  assert.equal(result.failure.actionId, 'inspect-current-pointer');
  assert.equal(result.failure.violation.code, 'RUNNING_POINTER_SPLIT');
  assert.equal(result.failure.violation.severity, 'P0');
  assert.equal(exitCodeForWorkflow({
    result: { status: result.status, protectedVerification: { ok: true, changed: [] } }
  }), 1);
});

test('真实 C01 revision mutation 由默认报告写入并被 CLI replay 原样复现', {
  skip: process.env.BATTERY_GATE_MUTATION_REPLAY !== '1',
  timeout: 180_000
}, async () => {
  const action = Object.freeze({
    id: 'C01-22001-step-000',
    type: 'navigate',
    params: Object.freeze({ label: '看板' }),
    expect: 'success',
    revisionDelta: 99,
    evidenceRevisionDelta: 1,
    maxMs: 5_000
  });
  let generatedActionSourceCalls = 0;
  const generated = await runWorkflowCli([
    '--mode', 'quick', '--ids', 'C01', '--seed', '22001', '--keep-workdir'
  ], {
    projectRoot,
    runSelectedSuites(input) {
      return runSelectedSuites({
        ...input,
        dependencies: {
          async runChaosActivity({ activityId, seed, runContext, driverFactory, clock }) {
            assert.equal(activityId, 'C01');
            assert.equal(seed, 22_001);
            generatedActionSourceCalls += 1;
            return runWorkflow({
              workflow: { id: activityId, name: 'C01 revision mutation', risk: 'P0', fixture: 'production-529', actions: [] },
              runContext,
              driverFactory,
              clock,
              actionSource: createRecordedActionSource([action])
            });
          }
        }
      });
    }
  });

  assert.equal(generatedActionSourceCalls, 1);
  assert.equal(generated.exitCode, 1);
  assert.equal(generated.result.failure.actionId, action.id);
  assert.equal(generated.result.failure.violation.code, 'REVISION_DELTA');
  assert.equal(generated.result.failure.violation.severity, 'P0');
  assert.equal(generated.result.seed, 22_001);
  assert.deepEqual(generated.result.plannedActions, [action]);
  assert.equal(generated.result.protectedVerification.ok, true);
  assert.equal(generated.result.protectedVerification.changed.length, 0);
  const generatedRunRoot = path.join(projectRoot, '自动测试报告', 'workflows', generated.result.runId);
  assert.equal(path.relative(generatedRunRoot, generated.reports.jsonPath), path.join('artifacts', 'result.json'));

  const persistedGenerated = JSON.parse(await readFile(generated.reports.jsonPath, 'utf8'));
  validateWorkflowReport(persistedGenerated);
  const replayInput = await readReplayReport(generated.reports.jsonPath);
  assert.deepEqual(replayInput.plannedActions, [action]);

  const replayed = await runWorkflowCli([
    '--mode', 'replay', '--report', generated.reports.jsonPath, '--keep-workdir'
  ], {
    projectRoot
  });
  assert.equal(replayed.exitCode, 1);
  assert.equal(replayed.result.failure.actionId, generated.result.failure.actionId);
  assert.equal(replayed.result.failure.violation.code, generated.result.failure.violation.code);
  assert.equal(replayed.result.failure.violation.severity, generated.result.failure.violation.severity);
  assert.equal(replayed.result.seed, generated.result.seed);
  assert.deepEqual(replayed.result.plannedActions, generated.result.plannedActions);
  assert.equal(replayed.result.plannedActions.length, 1);
  assert.equal(replayed.result.protectedVerification.ok, true);
  assert.equal(replayed.result.protectedVerification.changed.length, 0);

  const persistedReplay = JSON.parse(await readFile(replayed.reports.jsonPath, 'utf8'));
  validateWorkflowReport(persistedReplay);
  assert.equal(persistedReplay.failure.actionId, action.id);
  assert.equal(persistedReplay.failure.violation.code, 'REVISION_DELTA');
  assert.equal(persistedReplay.seed, 22_001);
  assert.deepEqual(persistedReplay.plannedActions, [action]);
});
