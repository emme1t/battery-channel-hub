import assert from 'node:assert/strict';
import { readFile, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { verifyLegacyBackup } from '../../src/main/legacy-backup-service.mjs';
import { executeWorkflowAction } from './actions.mjs';
import { DEVIATION_WORKFLOWS } from './catalog-deviation.mjs';
import { createWorkflowElectronDriver } from './electron-driver.mjs';
import { seedWorkflowFixture } from './fixtures.mjs';
import { createWorkflowRunContext } from './run-context.mjs';
import { runWorkflow } from './runner.mjs';
import { readWorkflowSnapshot } from './state-probe.mjs';

const projectRoot = path.resolve(import.meta.dirname, '..', '..');
const fixedClock = () => new Date('2026-08-27T00:00:00.000Z');
let integrationSequence = 0;
const BUSINESS_COLLECTIONS = Object.freeze([
  'requests', 'samples', 'channels', 'deviceProfiles', 'records',
  'storageRecords', 'requestSourceRows', 'testers', 'auditLogs', 'formChangeJournal'
]);

function catalogWorkflow(id) {
  const workflow = DEVIATION_WORKFLOWS.find(item => item.id === id);
  if (!workflow) throw new Error(`missing deviation workflow: ${id}`);
  return workflow;
}

function actionById(workflow, id) {
  const action = workflow.actions.find(item => item.id === id);
  if (!action) throw new Error(`missing deviation action: ${workflow.id}/${id}`);
  return action;
}

async function createRealHarness(t, id) {
  const workflow = catalogWorkflow(id);
  const value = integrationSequence++;
  const runContext = await createWorkflowRunContext({
    projectRoot,
    mode: `deviation-${id.toLowerCase()}`,
    now: fixedClock,
    randomBytes: () => Buffer.from([
      (process.pid >>> 16) & 0xff,
      (process.pid >>> 8) & 0xff,
      process.pid & 0xff,
      value
    ])
  });
  await seedWorkflowFixture({
    dataRoot: runContext.dataRoot,
    kind: workflow.fixture,
    workflowId: workflow.id,
    clock: fixedClock
  });
  const rawDriver = createWorkflowElectronDriver({
    projectRoot,
    dataRoot: runContext.dataRoot,
    profileRoot: path.join(runContext.profileRoot, id.toLowerCase()),
    viewport: '1366x768',
    timeoutMs: 25_000
  });
  const dialogRoutes = [];
  const driver = {
    ...rawDriver,
    async configureDialogs(routes) {
      dialogRoutes.push(structuredClone(routes));
      return rawDriver.configureDialogs(routes);
    }
  };
  const runtime = {};
  t.after(async () => {
    await driver.close().catch(() => undefined);
    await rm(runContext.runRoot, { recursive: true, force: true });
  });
  await driver.start();
  const page = driver.page();
  await page.locator('#username').fill('WF tester');
  await page.locator('#login .btn.wide').click();
  await page.waitForFunction(() => window.__batteryAppReady === true);
  await driver.waitForPersistenceBarrier({ auditAction: '登录看板', actor: 'WF tester', timeoutMs: 5_000 });
  return { workflow, runContext, driver, runtime, dialogRoutes };
}

async function executeCatalogAction(harness, action) {
  const before = readWorkflowSnapshot({ dataRoot: harness.runContext.dataRoot });
  const ui = await harness.driver.uiProjection();
  const result = await executeWorkflowAction({
    driver: harness.driver,
    action,
    context: {
      snapshot: before,
      ui,
      runtime: harness.runtime,
      runContext: harness.runContext
    }
  });
  const after = readWorkflowSnapshot({ dataRoot: harness.runContext.dataRoot });
  assert.equal(result.outcome, action.expect, `${harness.workflow.id}/${action.id} outcome`);
  const allowedDeltas = Array.isArray(action.revisionDelta) ? action.revisionDelta : [action.revisionDelta];
  const observedDelta = result.settlement
    ? result.settlement.persistedRevision - result.settlement.beforeRevision
    : after.state.revision - before.state.revision;
  assert.ok(allowedDeltas.includes(observedDelta), `${harness.workflow.id}/${action.id} revision delta`);
  return { before, after, result };
}

function assertSettledStatePreserved(execution, label) {
  const settlement = execution.result.settlement;
  assert.ok(settlement, `${label} settlement`);
  assert.equal(settlement.persistedRevision, settlement.beforeRevision, `${label} formal revision`);
  for (const key of BUSINESS_COLLECTIONS) {
    assert.deepEqual(settlement.state[key], settlement.beforeState[key], `${label} must preserve ${key}`);
  }
}

async function createSeededContext(t, id) {
  const workflow = catalogWorkflow(id);
  const value = integrationSequence++;
  const baseRunContext = await createWorkflowRunContext({
    projectRoot,
    mode: `deviation-${id.toLowerCase()}-runner`,
    now: fixedClock,
    randomBytes: () => Buffer.from([
      (process.pid >>> 16) & 0xff,
      (process.pid >>> 8) & 0xff,
      process.pid & 0xff,
      value
    ])
  });
  await seedWorkflowFixture({
    dataRoot: baseRunContext.dataRoot,
    kind: workflow.fixture,
    workflowId: workflow.id,
    clock: fixedClock
  });
  const seeded = readWorkflowSnapshot({ dataRoot: baseRunContext.dataRoot });
  const runContext = Object.freeze({
    ...baseRunContext,
    workflowId: workflow.id,
    fixture: workflow.fixture,
    fixtureSha256: seeded.hash
  });
  t.after(() => rm(runContext.runRoot, { recursive: true, force: true }));
  return { workflow, runContext };
}

function readyDriverFactory(runContext, id, actor = 'WF tester') {
  return async ({ profileRoot }) => {
    const raw = createWorkflowElectronDriver({
      projectRoot,
      dataRoot: runContext.dataRoot,
      profileRoot,
      viewport: '1366x768',
      timeoutMs: 25_000
    });
    return Object.freeze({
      ...raw,
      async start() {
        await raw.start();
        const page = raw.page();
        await page.locator('#username').fill(actor);
        await page.locator('#login .btn.wide').click();
        await page.waitForFunction(() => window.__batteryAppReady === true);
        await raw.waitForPersistenceBarrier({ auditAction: '登录看板', actor, timeoutMs: 5_000 });
      }
    });
  };
}

test('D01 真实动作允许开放结束时间、拒绝持续占用冲突并保存运行记录结束时间', { timeout: 90_000 }, async t => {
  const harness = await createRealHarness(t, 'D01');
  const openEnded = await executeCatalogAction(harness, actionById(harness.workflow, 'reserve-open-ended'));
  const openRecord = openEnded.after.state.records.find(item => item.sampleId === 'REQ-WF-D01-001.001');
  const openChannel = openEnded.after.state.channels.find(item => item.key === '新威1#（16通道)|1-2');
  assert.equal(openRecord?.status, 'reserved');
  assert.equal(openRecord?.end, '');
  assert.equal(openChannel?.nextRecordId, openRecord?.id);

  const conflict = await executeCatalogAction(harness, actionById(harness.workflow, 'reserve-conflict'));
  assertSettledStatePreserved(conflict, 'D01 conflict rejection');

  const manageAction = actionById(harness.workflow, 'manage-running-end');
  const managed = await executeCatalogAction(harness, manageAction);
  const runningBeforeManagement = managed.before.state.records.find(item => item.sampleId === manageAction.params.sampleId);
  const runningStart = runningBeforeManagement?.actualStart ?? runningBeforeManagement?.start ?? runningBeforeManagement?.time;
  const runningStartTime = Date.parse(runningStart);
  assert.equal(Number.isFinite(runningStartTime), true, `D01 running start must be parseable: ${runningStart}`);
  const expectedEndDate = new Date(runningStartTime + manageAction.params.endOffsetMinutes * 60_000);
  const pad = value => String(value).padStart(2, '0');
  const expectedEnd = `${expectedEndDate.getFullYear()}-${pad(expectedEndDate.getMonth() + 1)}-${pad(expectedEndDate.getDate())}T${pad(expectedEndDate.getHours())}:${pad(expectedEndDate.getMinutes())}`;
  const managedRecord = managed.after.state.records.find(item => item.sampleId === 'REQ-WF-D01-RUNNING-001.001');
  const managedSample = managed.after.state.samples.find(item => item.id === managedRecord?.sampleId);
  const managedChannel = managed.after.state.channels.find(item => item.key === managedRecord?.channelKey);
  assert.equal(managedRecord?.status, 'running');
  assert.equal(managedRecord?.end, expectedEnd);
  assert.equal(managedSample?.end, expectedEnd);
  assert.equal(managedChannel?.end, expectedEnd);

  await executeCatalogAction(harness, actionById(harness.workflow, 'restart'));
  const persisted = readWorkflowSnapshot({ dataRoot: harness.runContext.dataRoot });
  assert.equal(persisted.state.records.find(item => item.sampleId === openRecord.sampleId)?.end, '');
  assert.equal(persisted.state.records.find(item => item.sampleId === managedRecord.sampleId)?.end, expectedEnd);
  assert.equal(persisted.state.samples.find(item => item.id === managedRecord.sampleId)?.end, expectedEnd);
  assert.equal(persisted.state.channels.find(item => item.key === managedRecord.channelKey)?.end, expectedEnd);
});

test('D02 真实动作在相邻、重叠一分钟、跨日和 date-only 边界形成四个唯一预约', { timeout: 110_000 }, async t => {
  const harness = await createRealHarness(t, 'D02');
  for (const action of harness.workflow.actions) await executeCatalogAction(harness, action);
  const persisted = readWorkflowSnapshot({ dataRoot: harness.runContext.dataRoot });
  const expected = [
    ['REQ-WF-D02-001.001', '新威1#（16通道)|1-1'],
    ['REQ-WF-D02-001.002', '新威1#（16通道)|1-2'],
    ['REQ-WF-D02-001.003', '新威1#（16通道)|1-3'],
    ['REQ-WF-D02-001.004', '新威1#（16通道)|1-4']
  ];
  for (const [sampleId, channelKey] of expected) {
    const records = persisted.state.records.filter(item => item.sampleId === sampleId && item.status === 'reserved');
    const sample = persisted.state.samples.find(item => item.id === sampleId);
    const channel = persisted.state.channels.find(item => item.key === channelKey);
    assert.equal(records.length, 1, `${sampleId} unique reserved record`);
    assert.equal(sample?.status, 'reserved', `${sampleId} status`);
    assert.equal(channel?.nextRecordId, records[0].id, `${channelKey} pointer`);
  }
});

test('D03 真实动作取消插单警告时零写入，确认后只建立一个待开始预约', { timeout: 70_000 }, async t => {
  const harness = await createRealHarness(t, 'D03');
  const dismissed = await executeCatalogAction(harness, actionById(harness.workflow, 'urgent-dismissed'));
  assertSettledStatePreserved(dismissed, 'D03 dismissed warning');

  const confirmed = await executeCatalogAction(harness, actionById(harness.workflow, 'urgent-confirmed'));
  const records = confirmed.after.state.records.filter(item => item.sampleId === 'REQ-WF-D03-URGENT-001.001' && item.status === 'reserved');
  const channel = confirmed.after.state.channels.find(item => item.key === '新威1#（16通道)|1-1');
  assert.equal(records.length, 1);
  assert.equal(channel?.nextRecordId, records[0].id);
  await executeCatalogAction(harness, actionById(harness.workflow, 'restart'));
  const persisted = readWorkflowSnapshot({ dataRoot: harness.runContext.dataRoot });
  assert.equal(persisted.state.records.filter(item => item.sampleId === 'REQ-WF-D03-URGENT-001.001' && item.status === 'reserved').length, 1);
});

test('D04 真实顺序只消费 import 前冻结的旧 DOM 入口，reload 后 fresh reserve 成功', { timeout: 80_000 }, async t => {
  const harness = await createRealHarness(t, 'D04');
  const { workflow, runtime } = harness;

  await executeCatalogAction(harness, actionById(workflow, 'navigate-apply'));
  await executeCatalogAction(harness, actionById(workflow, 'search-request'));
  await executeCatalogAction(harness, actionById(workflow, 'next-request-page'));
  await executeCatalogAction(harness, actionById(workflow, 'expand-device'));

  const cached = runtime.staleDrafts?.get('B:reserve');
  assert.ok(cached?.locator, 'expand must cache a mounted submit entry');
  assert.equal(await cached.locator.evaluate(node => Boolean(node?.isConnected)), true);
  assert.equal(typeof cached.locator.elementHandle, 'undefined', 'cached entry must be an ElementHandle, not a lazy Locator');

  await executeCatalogAction(harness, actionById(workflow, 'import-request'));
  assert.equal(await cached.locator.evaluate(node => Boolean(node?.isConnected)), false, 'import replaceState must detach the old submit entry');

  const stale = await executeCatalogAction(harness, actionById(workflow, 'stale-submit'));
  assert.equal(stale.after.state.revision - stale.before.state.revision, 0);
  assert.equal(runtime.staleDrafts.has('B:reserve'), false, 'stale entry must be consumed exactly once');
  for (const key of ['requests', 'samples', 'channels', 'deviceProfiles', 'records', 'requestSourceRows', 'testers', 'auditLogs', 'formChangeJournal']) {
    assert.deepEqual(stale.after.state[key], stale.before.state[key], `stale rejection must preserve ${key}`);
  }

  const reload = await executeCatalogAction(harness, actionById(workflow, 'reload-current'));
  assert.equal(await harness.driver.page().evaluate(() => window.__batteryAppReady === true), true);
  assert.ok([2, 3].includes(reload.after.state.revision - reload.before.state.revision), 'reload must include normal enterApp persistence and login audit writes');
  const reloadAudits = reload.after.state.auditLogs.filter(item => !reload.before.state.auditLogs.some(before => before.id === item.id));
  assert.deepEqual(reloadAudits.map(item => [item.action, item.user ?? item.actor]), [['登录看板', 'WF tester']]);
  for (const key of ['requests', 'samples', 'channels', 'deviceProfiles', 'records', 'requestSourceRows', 'testers', 'formChangeJournal']) {
    assert.deepEqual(reload.after.state[key], reload.before.state[key], `reload/login must preserve ${key}`);
  }
  const fresh = await executeCatalogAction(harness, actionById(workflow, 'reserve-fresh'));
  const sample = fresh.after.state.samples.find(item => item.id === 'REQ-WF-D04-001.001');
  const records = fresh.after.state.records.filter(item => item.sampleId === sample?.id && item.status === 'reserved');
  const channel = fresh.after.state.channels.find(item => item.key === '新威1#（16通道)|1-1');
  assert.equal(sample?.status, 'reserved');
  assert.equal(records.length, 1);
  assert.equal(channel?.nextRecordId, records[0].id);
});

test('D05 真实切页链保留未提交预约草稿且不产生业务记录', { timeout: 60_000 }, async t => {
  const harness = await createRealHarness(t, 'D05');
  const initial = readWorkflowSnapshot({ dataRoot: harness.runContext.dataRoot });
  const actions = [...harness.workflow.actions];
  const assertion = actions.pop();
  for (const action of actions) {
    const execution = await executeCatalogAction(harness, action);
    assert.equal(execution.result.outcome, action.expect, action.id);
  }

  const page = harness.driver.page();
  const uiState = await page.evaluate(() => window.__legacyReservationWorkspace?.getUiState?.() || null);
  assert.equal(uiState?.selectedRequestNo, 'REQ-WF-D05-001', JSON.stringify(uiState));
  assert.equal(uiState?.note, 'D05 未提交草稿', JSON.stringify(uiState));
  const rendered = await page.evaluate(() => ({
    currentPage: document.querySelector('.page.active')?.id || '',
    applyClass: document.getElementById('apply')?.className || '',
    details: document.querySelectorAll('.legacy-reservation-details').length,
    rootChildren: document.getElementById('legacyReservationRoot')?.children.length || 0,
    toast: document.getElementById('toast')?.textContent || ''
  }));
  assert.equal(rendered.details, 1, JSON.stringify(rendered));
  const noteField = page.locator('.legacy-reservation-details').locator('[data-legacy-action="note"]');
  assert.equal(await noteField.count(), 1);
  const execution = await executeCatalogAction(harness, assertion);
  assert.equal(execution.result.outcome, assertion.expect, assertion.id);
  assert.equal(await noteField.inputValue(), 'D05 未提交草稿');
  assert.equal(harness.runtime.draft?.value, 'D05 未提交草稿');
  const persisted = readWorkflowSnapshot({ dataRoot: harness.runContext.dataRoot });
  assert.equal(persisted.state.records.length, initial.state.records.length);
  assert.equal(persisted.state.samples.find(item => item.id === 'REQ-WF-D05-001.001')?.status, 'pending');
  assert.equal(persisted.state.channels.every(item => item.state === 'free'), true);
});

test('D06 runWorkflow 在每个业务步骤之间真实重启并保持完整状态机', { timeout: 240_000 }, async t => {
  const { workflow, runContext } = await createSeededContext(t, 'D06');
  const shellSnapshots = [];
  const result = await runWorkflow({
    workflow,
    runContext,
    driverFactory: readyDriverFactory(runContext, workflow.id),
    clock: fixedClock,
    dependencies: {
      readSnapshot(options) {
        const snapshot = readWorkflowSnapshot(options);
        shellSnapshots.push(snapshot);
        return snapshot;
      }
    }
  });
  const failureEntityIds = new Set(result.failure?.violation?.entityIds || []);
  const failureAudits = shellSnapshots
    .flatMap(snapshot => snapshot.auditLogs || [])
    .filter(item => failureEntityIds.has(item.id));
  assert.equal(
    result.status,
    'passed',
    result.failure?.error?.stack || JSON.stringify({
      actionId: result.failure?.actionId,
      violation: result.failure?.violation || result.failure,
      audits: failureAudits
    })
  );
  assert.equal(result.steps.length, workflow.actions.length);
  assert.equal(shellSnapshots.length, workflow.actions.length * 2 + 2);
  assert.deepEqual(result.steps.map(item => item.outcome), workflow.actions.map(item => item.expect));
  for (const step of result.steps.filter(item => item.actionId.startsWith('restart-'))) {
    assert.ok([2, 3].includes(step.revisionAfter - step.revisionBefore), `${step.actionId} lifecycle delta`);
    assert.deepEqual(step.auditEvidence.auditLogs.map(item => [item.action, item.user ?? item.actor]), [['登录看板', 'WF tester']]);
  }

  const stateAfter = actionIndex => shellSnapshots[actionIndex * 2 + 1].state;
  const importedAfterRestart = stateAfter(1);
  assert.equal(importedAfterRestart.requests.filter(item => item.id === 'REQ-WF-IMPORT-001').length, 1);
  assert.equal(importedAfterRestart.samples.filter(item => item.requestNo === 'REQ-WF-IMPORT-001').length, 2);

  const reservedAfterRestart = stateAfter(3);
  const reservedRecord = reservedAfterRestart.records.find(item => item.sampleId === 'REQ-WF-IMPORT-001.001' && item.status === 'reserved');
  const reservedChannel = reservedAfterRestart.channels.find(item => item.key === '新威1#（16通道)|1-1');
  assert.ok(reservedRecord);
  assert.equal(reservedChannel?.nextRecordId, reservedRecord.id);

  const runningAfterRestart = stateAfter(5);
  const runningRecord = runningAfterRestart.records.find(item => item.sampleId === 'REQ-WF-IMPORT-001.001' && item.status === 'running');
  const runningChannel = runningAfterRestart.channels.find(item => item.key === '新威1#（16通道)|1-1');
  assert.ok(runningRecord);
  assert.equal(runningChannel?.currentRecordId, runningRecord.id);
  assert.equal(String(runningChannel?.nextRecordId || ''), '');

  const manageAction = workflow.actions.find(item => item.id === 'manage-running');
  const runningStart = runningRecord.actualStart ?? runningRecord.start ?? runningRecord.time;
  const runningStartTime = Date.parse(runningStart);
  assert.equal(Number.isFinite(runningStartTime), true, `D06 running start must be parseable: ${runningStart}`);
  const expectedEndDate = new Date(runningStartTime + manageAction.params.endOffsetMinutes * 60_000);
  const pad = value => String(value).padStart(2, '0');
  const expectedEnd = `${expectedEndDate.getFullYear()}-${pad(expectedEndDate.getMonth() + 1)}-${pad(expectedEndDate.getDate())}T${pad(expectedEndDate.getHours())}:${pad(expectedEndDate.getMinutes())}`;

  const managedAfterRestart = stateAfter(7);
  const managedRecord = managedAfterRestart.records.find(item => item.sampleId === 'REQ-WF-IMPORT-001.001' && item.status === 'running');
  const managedSample = managedAfterRestart.samples.find(item => item.id === 'REQ-WF-IMPORT-001.001');
  const managedChannel = managedAfterRestart.channels.find(item => item.key === '新威1#（16通道)|1-1');
  assert.equal(managedRecord?.end, expectedEnd);
  assert.equal(managedSample?.end, expectedEnd);
  assert.equal(managedChannel?.end, expectedEnd);
  assert.equal(managedChannel?.currentRecordId, managedRecord.id);

  const completedAfterRestart = stateAfter(9);
  const completedRecord = completedAfterRestart.records.find(item => item.sampleId === 'REQ-WF-IMPORT-001.001');
  const completedChannel = completedAfterRestart.channels.find(item => item.key === '新威1#（16通道)|1-1');
  assert.equal(completedRecord?.status, 'completed');
  assert.equal(completedChannel?.state, 'free');
  assert.equal(String(completedChannel?.currentRecordId || ''), '');
  assert.equal(String(completedChannel?.nextRecordId || ''), '');

  const persisted = readWorkflowSnapshot({ dataRoot: runContext.dataRoot });
  const sample = persisted.state.samples.find(item => item.id === 'REQ-WF-IMPORT-001.001');
  const records = persisted.state.records.filter(item => item.sampleId === sample?.id);
  const channel = persisted.state.channels.find(item => item.key === '新威1#（16通道)|1-1');
  assert.equal(sample?.status, 'completed');
  assert.equal(records.length, 1);
  assert.equal(records[0].status, 'completed');
  assert.equal(channel?.state, 'free');
  assert.equal(String(channel?.currentRecordId || ''), '');
  assert.equal(String(channel?.nextRecordId || ''), '');
  assert.equal(
    persisted.state.auditLogs.filter(item => item.action === '登录看板' && (item.user ?? item.actor) === 'WF tester').length,
    7,
    'initial login, five catalog restarts and the independent fresh verifier each persist one login audit'
  );
});

test('D07 真实文件链对四次取消零写入，四次成功留下可校验文件和精确审计', { timeout: 240_000 }, async t => {
  const harness = await createRealHarness(t, 'D07');
  const exportPath = path.join(harness.runContext.exportsRoot, 'exports', 'd07-log.xlsx');
  const backupPath = path.join(harness.runContext.exportsRoot, 'backups', 'd07.batterydata');
  for (const target of [exportPath, backupPath]) {
    const relative = path.relative(harness.runContext.exportsRoot, target);
    assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative), `${target} must stay inside exportsRoot`);
  }

  const importCancelled = await executeCatalogAction(harness, actionById(harness.workflow, 'import-cancelled'));
  assertSettledStatePreserved(importCancelled, 'D07 import cancel');
  const imported = await executeCatalogAction(harness, actionById(harness.workflow, 'import-success'));
  assert.equal(imported.after.state.requests.filter(item => item.id === 'REQ-WF-IMPORT-001').length, 1);
  assert.equal(imported.after.state.samples.filter(item => item.requestNo === 'REQ-WF-IMPORT-001').length, 2);
  assert.deepEqual(imported.result.settlement.auditEvidence.map(item => item.action), ['导入申请单']);

  const exportCancelled = await executeCatalogAction(harness, actionById(harness.workflow, 'export-log-cancelled'));
  assertSettledStatePreserved(exportCancelled, 'D07 export cancel');
  await assert.rejects(stat(exportPath), error => error?.code === 'ENOENT');
  const exported = await executeCatalogAction(harness, actionById(harness.workflow, 'export-log-success'));
  assert.ok((await stat(exportPath)).size > 0);
  assert.equal((await readFile(exportPath)).subarray(0, 2).toString('ascii'), 'PK');
  assert.deepEqual(exported.result.settlement.auditEvidence.map(item => item.action), ['导出日志与使用数据']);

  const backupCancelled = await executeCatalogAction(harness, actionById(harness.workflow, 'backup-cancelled'));
  assertSettledStatePreserved(backupCancelled, 'D07 backup cancel');
  await assert.rejects(stat(backupPath), error => error?.code === 'ENOENT');
  const backedUp = await executeCatalogAction(harness, actionById(harness.workflow, 'backup-success'));
  const backupPackage = JSON.parse(await readFile(backupPath, 'utf8'));
  const verifiedBackupState = verifyLegacyBackup(backupPackage);
  assert.equal(verifiedBackupState.requests.filter(item => item.id === 'REQ-WF-IMPORT-001').length, 1);
  assert.equal(verifiedBackupState.testers.some(item => item.name === 'D07 恢复哨兵'), false);
  assert.deepEqual(backedUp.result.settlement.auditEvidence.map(item => item.action), ['手动备份数据']);

  const sentinel = await executeCatalogAction(harness, {
    id: 'restore-sentinel', type: 'createTester', expect: 'success', revisionDelta: 1,
    params: { name: 'D07 恢复哨兵', dept: '自动测试', phone: '0707', note: '必须被备份恢复移除' }, maxMs: 10_000
  });
  assert.equal(sentinel.after.state.testers.filter(item => item.name === 'D07 恢复哨兵').length, 1);

  const restoreCancelled = await executeCatalogAction(harness, actionById(harness.workflow, 'restore-cancelled'));
  assertSettledStatePreserved(restoreCancelled, 'D07 restore cancel');
  assert.equal(restoreCancelled.after.state.testers.filter(item => item.name === 'D07 恢复哨兵').length, 1);
  const restored = await executeCatalogAction(harness, actionById(harness.workflow, 'restore-success'));
  assert.equal(restored.after.state.requests.filter(item => item.id === 'REQ-WF-IMPORT-001').length, 1);
  assert.equal(restored.after.state.testers.some(item => item.name === 'D07 恢复哨兵'), false, 'restore must consume the selected backup state');
  assert.equal(restored.after.state.auditLogs.some(item => item.action === '新增测试人员' && item.target === '测试人员 D07 恢复哨兵'), true, 'restore must preserve post-backup history while replacing roster state');
  assert.deepEqual(restored.result.settlement.auditEvidence.map(item => item.action), ['恢复数据备份']);
  assert.equal(verifyLegacyBackup(JSON.parse(await readFile(backupPath, 'utf8'))).requests.filter(item => item.id === 'REQ-WF-IMPORT-001').length, 1);
  assert.ok(harness.dialogRoutes.some(routes => (
    routes.openFiles?.length === 1
    && routes.openFiles[0]?.length === 1
    && path.resolve(routes.openFiles[0][0]) === path.resolve(backupPath)
  )), 'restore must select the exact backupPath through the real open-dialog route');
});

test('D08 删除当前名单人员后历史记录保留原身份，新名单在重启后独立持久化', { timeout: 90_000 }, async t => {
  const harness = await createRealHarness(t, 'D08');
  const initial = readWorkflowSnapshot({ dataRoot: harness.runContext.dataRoot });
  const historicalRecordIds = initial.state.records.map(item => item.id);
  const historicalAuditIds = initial.state.auditLogs.filter(item => /^WF-audit-\d{4}$/.test(item.id)).map(item => item.id);
  assert.equal(initial.state.records.filter(item => item.user === 'WF tester').length, 100);
  assert.equal(historicalAuditIds.length, 100);
  assert.equal(initial.state.auditLogs.filter(item => (item.user ?? item.actor) === 'WF tester').length, 101);
  assert.equal(initial.state.auditLogs.filter(item => item.action === '登录看板' && (item.user ?? item.actor) === 'WF tester').length, 1);

  const renamed = await executeCatalogAction(harness, actionById(harness.workflow, 'rename-tester'));
  assert.equal(renamed.after.state.testers.filter(item => item.name === 'D08 已改名测试员').length, 1);
  const renamedRow = harness.driver.page().getByRole('row', { name: /D08 已改名测试员/ });
  await renamedRow.waitFor({ state: 'visible' });
  assert.match(await renamedRow.innerText(), /D08 已改名测试员/);
  const deleted = await executeCatalogAction(harness, actionById(harness.workflow, 'delete-tester'));
  assert.equal(deleted.after.state.testers.some(item => ['WF tester', 'D08 已改名测试员'].includes(item.name)), false);
  assert.equal(deleted.after.state.records.filter(item => historicalRecordIds.includes(item.id) && item.user === 'WF tester').length, 100);
  assert.equal(deleted.after.state.auditLogs.filter(item => historicalAuditIds.includes(item.id) && (item.user ?? item.actor) === 'WF tester').length, 100);

  await executeCatalogAction(harness, actionById(harness.workflow, 'navigate-requests'));
  await executeCatalogAction(harness, actionById(harness.workflow, 'navigate-records'));
  assert.ok(await harness.driver.page().getByText('WF tester', { exact: true }).first().isVisible());
  await executeCatalogAction(harness, actionById(harness.workflow, 'create-tester'));
  await executeCatalogAction(harness, actionById(harness.workflow, 'restart'));

  const persisted = readWorkflowSnapshot({ dataRoot: harness.runContext.dataRoot });
  assert.equal(persisted.state.testers.some(item => item.name === 'WF tester' || item.name === 'D08 已改名测试员'), false);
  assert.deepEqual(
    persisted.state.testers.filter(item => item.name === 'D08 新测试员').map(item => [item.dept, item.phone, item.note]),
    [['测试部', '00000000', '历史名单维护']]
  );
  assert.equal(persisted.state.records.filter(item => historicalRecordIds.includes(item.id) && item.user === 'WF tester').length, 100);
  assert.equal(persisted.state.auditLogs.filter(item => historicalAuditIds.includes(item.id) && (item.user ?? item.actor) === 'WF tester').length, 100);
});
