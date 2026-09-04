import assert from 'node:assert/strict';
import test from 'node:test';

import { STANDARD_WORKFLOWS } from './catalog-standard.mjs';
import { normalizeWorkflow } from './contracts.mjs';
import { ACTION_LIBRARY } from './actions.mjs';
import { resolveWorkflowFileRoute } from './actions.mjs';
import { seedWorkflowFixture } from './fixtures.mjs';
import { createWorkflowRunContext } from './run-context.mjs';
import { parseWorkbook } from '../../src/main/excel-service.mjs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

test('标准目录精确覆盖 S01-S08', () => {
  assert.deepEqual(STANDARD_WORKFLOWS.map(item => item.id), ['S01', 'S02', 'S03', 'S04', 'S05', 'S06', 'S07', 'S08']);
  assert.deepEqual(STANDARD_WORKFLOWS.filter(item => item.risk === 'P0').map(item => item.id), ['S01', 'S02', 'S03', 'S04', 'S05', 'S07', 'S08']);
  assert.deepEqual(STANDARD_WORKFLOWS.find(item => item.id === 'S03').actions.map(item => item.type), [
    'reserve', 'cancelTodo', 'cancelTodo', 'restart'
  ]);
});

test('标准目录的首个业务动作在其真实夹具中可用，错误样品 ID 不可用', async t => {
  const projectRoot = path.resolve(import.meta.dirname, '..', '..');
  const context = await createWorkflowRunContext({ projectRoot, mode: 'catalog-contract' });
  t.after(() => context.cleanup({ success: true }));
  for (const workflow of STANDARD_WORKFLOWS.filter(item => ['S02', 'S03', 'S04', 'S05'].includes(item.id))) {
    const dataRoot = path.join(context.dataRoot, workflow.id);
    await seedWorkflowFixture({ dataRoot, kind: workflow.fixture, workflowId: workflow.id, clock: () => new Date('2026-08-27T00:00:00.000Z') });
    const state = (await import('./state-probe.mjs')).readWorkflowSnapshot({ dataRoot });
    const snapshot = await state;
    const action = workflow.actions[0];
    const ui = { projection: { currentPage: 'dashboard', summary: { revision: snapshot.state.revision }, visible: {} } };
    assert.equal(await ACTION_LIBRARY[action.type].available(snapshot, ui, action.params, {}), true, workflow.id);
    const wrong = structuredClone(action.params);
    wrong.sampleIds = ['MISSING.001'];
    assert.equal(await ACTION_LIBRARY[action.type].available(snapshot, ui, wrong, {}), false, `${workflow.id} wrong sample`);
  }
});

test('标准目录通过 Workflow normalization，文件路径只能在当前 run root 解析', async t => {
  for (const workflow of STANDARD_WORKFLOWS) assert.doesNotThrow(() => normalizeWorkflow(workflow), workflow.id);
  const projectRoot = path.resolve(import.meta.dirname, '..', '..');
  const context = await createWorkflowRunContext({ projectRoot, mode: 'catalog-path-contract' });
  t.after(() => context.cleanup({ success: true }));
  await mkdir(path.join(context.dataRoot, 'imports'), { recursive: true });
  await writeFile(path.join(context.dataRoot, 'imports', 'vertical.xlsx'), 'fixture');
  const route = await resolveWorkflowFileRoute({ path: 'imports/vertical.xlsx', kind: 'file' }, { runContext: context }, 'input');
  assert.equal(route.openFiles[0][0], path.join(context.dataRoot, 'imports', 'vertical.xlsx'));
  const directoryRoute = await resolveWorkflowFileRoute({ path: 'imports', kind: 'directory' }, { runContext: context }, 'input');
  assert.equal(directoryRoute.openFiles[0][0], path.join(context.dataRoot, 'imports'));
  await assert.rejects(() => resolveWorkflowFileRoute({ path: 'imports', kind: 'file' }, { runContext: context }, 'input'), /file/i);
  await assert.rejects(() => resolveWorkflowFileRoute({ path: 'escape.xlsx' }, {}, 'output'), /runContext/i);
  await assert.rejects(() => resolveWorkflowFileRoute({ path: '../vertical.xlsx', kind: 'file' }, { runContext: context }, 'input'), /run root|outside/i);
  await assert.rejects(() => resolveWorkflowFileRoute({ path: '../escape.xlsx' }, { runContext: context }, 'output'), /run root|writable|outside/i);
});

test('标准目录声明动作合同、取消零写入和队列指针切换', () => {
  assert.equal(Object.isFrozen(STANDARD_WORKFLOWS), true);
  for (const workflow of STANDARD_WORKFLOWS) {
    for (const action of workflow.actions) {
      assert.equal(typeof action.expect, 'string');
      assert.notEqual(action.revisionDelta, undefined);
      assert.equal(typeof action.params, 'object');
      assert.equal(Number.isFinite(action.maxMs), true);
    }
  }

  const s03 = STANDARD_WORKFLOWS.find(item => item.id === 'S03');
  assert.deepEqual(s03.actions[1], {
    id: 'cancel-rejected',
    type: 'cancelTodo',
    expect: 'cancelled',
    revisionDelta: 0,
    params: { sampleId: 'REQ-WF-003.001', confirm: false },
    maxMs: 10_000
  });

  const s05 = STANDARD_WORKFLOWS.find(item => item.id === 'S05');
  assert.deepEqual(s05.actions.slice(1, 3).map(item => item.params.expectedPointers), [
    { channelKey: '新威1#（16通道)|1-1', currentRecordId: null, nextSampleId: 'REQ-WF-QUEUE-NEXT-001.001' },
    { channelKey: '新威1#（16通道)|1-1', currentSampleId: 'REQ-WF-QUEUE-NEXT-001.001', nextRecordId: null }
  ]);
});

test('S05 将 pending next 预约到 current 所在通道', () => {
  const s05 = STANDARD_WORKFLOWS.find(item => item.id === 'S05');
  assert.equal(s05.actions[0].params.channelKeys[0], s05.actions[1].params.expectedPointers.channelKey);
  assert.equal(s05.actions[0].params.channelKeys[0], s05.actions[2].params.expectedPointers.channelKey);
});

test('S07 导入动作的有效申请数与导入夹具解析结果一致', async t => {
  const projectRoot = path.resolve(import.meta.dirname, '..', '..');
  const context = await createWorkflowRunContext({ projectRoot, mode: 'catalog-import-count-contract' });
  t.after(() => context.cleanup({ success: true }));
  const manifest = await seedWorkflowFixture({
    dataRoot: context.dataRoot,
    kind: 'import-mixed',
    workflowId: 'S07',
    clock: () => new Date('2026-08-27T00:00:00.000Z')
  });
  const s07 = STANDARD_WORKFLOWS.find(item => item.id === 'S07');
  for (const action of s07.actions.filter(item => ['import-vertical', 'import-flat'].includes(item.id))) {
    const fixturePath = manifest.imports[action.id === 'import-vertical' ? 'vertical' : 'flat'];
    assert.equal(action.params.expectedValidCount, parseWorkbook(fixturePath).records.length, action.id);
  }
});

test('所有标准流程 restart 只允许正常重新登录产生的 2 或 3 次持久化', () => {
  for (const workflow of STANDARD_WORKFLOWS) {
    const restart = workflow.actions.find(action => action.type === 'restart');
    assert.deepEqual(restart?.revisionDelta, [2, 3], workflow.id);
  }
});

test('S01/S08 覆盖两个样品页、两类退回和 storage 生命周期且总目录不增加', () => {
  const s01 = STANDARD_WORKFLOWS.find(item => item.id === 'S01');
  assert.deepEqual(s01.actions.map(item => item.type), [
    'importRequest', 'editExecution', 'reserve', 'startTodo', 'manageRunning',
    'navigate', 'search', 'returnRunning', 'navigate', 'exportLog', 'restart'
  ]);
  const s08 = STANDARD_WORKFLOWS.find(item => item.id === 'S08');
  assert.deepEqual(s08.actions.map(item => item.type), [
    'editExecution', 'startStorage', 'navigate', 'search', 'updateStorage',
    'backup', 'finishStorage', 'createTester', 'restore', 'returnStorage', 'restart'
  ]);
  assert.ok(s08.timeoutMs >= s08.actions.reduce((sum, item) => sum + item.maxMs, 0));
});
