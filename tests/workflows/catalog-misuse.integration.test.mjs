import assert from 'node:assert/strict';
import { readFile, readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import XLSX from 'xlsx';

import { executeWorkflowAction } from './actions.mjs';
import { MISUSE_WORKFLOWS } from './catalog-misuse.mjs';
import { createWorkflowElectronDriver } from './electron-driver.mjs';
import { seedWorkflowFixture } from './fixtures.mjs';
import { createWorkflowRunContext } from './run-context.mjs';
import { readWorkflowSnapshot } from './state-probe.mjs';
import { parseFolder } from '../../src/main/excel-service.mjs';
import { verifyLegacyBackup } from '../../src/main/legacy-backup-service.mjs';
import { summarizeLegacyState } from '../../src/main/legacy-state-schema.mjs';

const projectRoot = path.resolve(import.meta.dirname, '..', '..');
const fixedClock = () => new Date('2026-08-27T00:00:00.000Z');
const BUSINESS_COLLECTIONS = Object.freeze([
  'requests', 'samples', 'channels', 'deviceProfiles', 'records',
  'storageRecords', 'requestSourceRows', 'testers', 'auditLogs', 'formChangeJournal'
]);
const RESTORE_COLLECTIONS = Object.freeze([
  'requests', 'samples', 'records', 'storageRecords', 'channels', 'deviceProfiles', 'testers',
  'requestSourceRows', 'formChangeJournal'
]);
const M04_NAVIGATION_PAGES = Object.freeze({
  '看板': 'dashboard', '预约': 'apply', '申请': 'requests', '日志': 'records',
  '设备': 'devices', '已预约': 'reserved', '及时率': 'timeliness', '测试人员': 'testers'
});
const M04_VIEW_LIMITS = Object.freeze({ request: 50, sample: 25, channel: 40, records: 50, audits: 50, channels: 50, todo: 10 });
let sequence = 0;

function workflowById(id) {
  const workflow = MISUSE_WORKFLOWS.find(item => item.id === id);
  if (!workflow) throw new Error(`missing misuse workflow: ${id}`);
  return workflow;
}

function actionById(workflow, id) {
  const action = workflow.actions.find(item => item.id === id);
  if (!action) throw new Error(`missing misuse action: ${workflow.id}/${id}`);
  return action;
}

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonicalValue(value[key])]));
  }
  return value;
}

function canonicalCollection(items) {
  return (Array.isArray(items) ? items : [])
    .map(canonicalValue)
    .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
}

function mergeByIdForRestore(...collections) {
  const merged = new Map();
  for (const collection of collections) {
    for (const item of Array.isArray(collection) ? collection : []) {
      if (item?.id) merged.set(String(item.id), structuredClone(item));
    }
  }
  return [...merged.values()];
}

function canonicalPersistedProjection(state, beforeState = null) {
  const journal = beforeState
    ? mergeByIdForRestore(state.formChangeJournal, beforeState.formChangeJournal)
    : state.formChangeJournal;
  return Object.freeze(Object.fromEntries(RESTORE_COLLECTIONS.map(name => [
    name,
    canonicalCollection(name === 'formChangeJournal' ? journal : state[name])
  ])));
}

function assertCompleteRestore(execution, backupState, label, actualState = execution.after.state) {
  const settlement = execution.result.settlement;
  const beforeState = settlement.beforeState;
  assert.deepEqual(
    canonicalPersistedProjection(actualState),
    canonicalPersistedProjection(backupState, beforeState),
    `${label} complete persisted projection`
  );

  assert.equal(settlement.auditEvidence.length, 1, `${label} restore audit count`);
  const restoreAudit = settlement.auditEvidence[0];
  assert.deepEqual({
    action: restoreAudit.action,
    target: restoreAudit.target,
    outcome: restoreAudit.outcome,
    result: restoreAudit.result,
    verified: restoreAudit.verified,
    level: restoreAudit.level,
    user: restoreAudit.user,
    actor: restoreAudit.actor,
    before: restoreAudit.before,
    after: restoreAudit.after
  }, {
    action: '恢复数据备份',
    target: '本机 SQLite 看板数据',
    outcome: 'warning',
    result: 'warning',
    verified: true,
    level: 'warning',
    user: 'WF tester',
    actor: 'WF tester',
    before: summarizeLegacyState(beforeState),
    after: summarizeLegacyState(backupState)
  }, `${label} restore audit semantics`);
  assert.equal(typeof restoreAudit.id === 'string' && restoreAudit.id.length > 0, true, `${label} restore audit id`);
  assert.equal(Number.isFinite(Date.parse(restoreAudit.time)), true, `${label} restore audit time`);
  assert.match(restoreAudit.note, /^恢复前备份已写后校验：before-restore-/, `${label} restore audit note`);

  const expectedAudits = [
    restoreAudit,
    ...mergeByIdForRestore(backupState.auditLogs, beforeState.auditLogs)
  ];
  assert.deepEqual(canonicalCollection(actualState.auditLogs), canonicalCollection(expectedAudits), `${label} complete audit set`);
  assert.equal(actualState.revision, settlement.beforeRevision + 1, `${label} revision increments once`);
  assert.equal(actualState.revision, settlement.persistedRevision, `${label} settlement revision`);
  assert.equal(Number.isFinite(Date.parse(actualState.savedAt)), true, `${label} savedAt is a persisted timestamp`);
}

function assertPreRestoreBackup(preRestoreState, beforeState, label) {
  assert.deepEqual(canonicalPersistedProjection(preRestoreState), canonicalPersistedProjection(beforeState), `${label} complete persisted projection`);
  assert.deepEqual(canonicalCollection(preRestoreState.auditLogs), canonicalCollection(beforeState.auditLogs), `${label} complete audit set`);
  assert.equal(preRestoreState.revision, beforeState.revision, `${label} revision`);
  assert.equal(preRestoreState.savedAt, beforeState.savedAt, `${label} savedAt`);
}

function armSqliteWriteLock(sqlitePath) {
  const database = new DatabaseSync(sqlitePath);
  try {
    database.exec('PRAGMA busy_timeout=0; BEGIN IMMEDIATE;');
  } catch (error) {
    database.close();
    throw error;
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    try {
      database.exec('ROLLBACK;');
    } finally {
      database.close();
    }
  };
}

async function createHarness(t, id) {
  const workflow = workflowById(id);
  const value = sequence++;
  const runContext = await createWorkflowRunContext({
    projectRoot,
    mode: `misuse-${id.toLowerCase()}`,
    now: fixedClock,
    randomBytes: () => Buffer.from([(process.pid >>> 16) & 0xff, (process.pid >>> 8) & 0xff, process.pid & 0xff, value])
  });
  await seedWorkflowFixture({ dataRoot: runContext.dataRoot, kind: workflow.fixture, workflowId: id, clock: fixedClock });
  let driverSequence = 0;
  const makeDriver = () => createWorkflowElectronDriver({
    projectRoot,
    dataRoot: runContext.dataRoot,
    profileRoot: path.join(runContext.profileRoot, `${id.toLowerCase()}-${driverSequence++}`),
    viewport: '1366x768',
    timeoutMs: 25_000
  });
  const driver = makeDriver();
  const runtime = {};
  t.after(async () => {
    await runtime.secondDriver?.close().catch(() => undefined);
    await driver.close().catch(() => undefined);
    await rm(runContext.runRoot, { recursive: true, force: true });
  });
  await driver.start();
  const page = driver.page();
  await page.locator('#username').fill('WF tester');
  await page.locator('#login .btn.wide').click();
  await page.waitForFunction(() => window.__batteryAppReady === true);
  await driver.waitForPersistenceBarrier({ auditAction: '登录看板', actor: 'WF tester', timeoutMs: 5_000 });
  return { workflow, runContext, driver, runtime, makeDriver };
}

async function executeCatalogAction(harness, action) {
  const before = readWorkflowSnapshot({ dataRoot: harness.runContext.dataRoot });
  const ui = await harness.driver.uiProjection();
  let result;
  try {
    result = await executeWorkflowAction({
      driver: harness.driver,
      action,
      context: {
        snapshot: before,
        ui,
        runtime: harness.runtime,
        runContext: harness.runContext,
        createDriver: async () => harness.makeDriver(),
        armWriteLock: async () => armSqliteWriteLock(before.sqlitePath)
      }
    });
  } catch (error) {
    error.message = `${harness.workflow.id}/${action.id}: ${error.message}`;
    throw error;
  }
  const after = readWorkflowSnapshot({ dataRoot: harness.runContext.dataRoot });
  assert.equal(result.outcome, action.expect, `${harness.workflow.id}/${action.id} outcome`);
  return { before, after, result };
}

test('M06 真实 Electron 阻断结束早于开始及极远时间，hostile 搜索零写入', { timeout: 70_000 }, async t => {
  const harness = await createHarness(t, 'M06');
  for (const id of ['manage-end-before-start', 'manage-extreme-past', 'manage-extreme-future']) {
    const execution = await executeCatalogAction(harness, actionById(harness.workflow, id));
    assert.equal(execution.result.settlement.persistedRevision, execution.result.settlement.beforeRevision, id);
    assert.deepEqual(execution.result.settlement.state.records, execution.result.settlement.beforeState.records, id);
    assert.deepEqual(execution.result.settlement.state.channels, execution.result.settlement.beforeState.channels, id);
  }
  const navigationAction = actionById(harness.workflow, 'navigate-records-for-hostile-search');
  const navigated = await executeCatalogAction(harness, navigationAction);
  assert.equal(navigated.after.state.revision - navigated.before.state.revision, 1, 'records navigation persists its audit separately');
  const hostileAction = actionById(harness.workflow, 'hostile-search');
  const searched = await executeCatalogAction(harness, hostileAction);
  const searchInput = harness.driver.page().getByLabel(hostileAction.params.label, { exact: true });
  const visibleRecordRows = harness.driver.page().locator('[data-testid="bounded-record-row"]');
  const expectedAppliedValue = `${'超长中文'.repeat(80)} \"'_*%`;
  assert.equal(hostileAction.params.value.includes('\n'), true, 'hostile requested value contains a real LF');
  assert.equal(hostileAction.params.value.includes('\\n'), false, 'hostile requested value does not substitute backslash-n');
  assert.deepEqual(searched.result.searchEvidence, {
    requestedValue: hostileAction.params.value,
    appliedValue: expectedAppliedValue
  }, 'search action preserves requested LF and records the browser-normalized applied value');
  assert.equal(await searchInput.inputValue(), expectedAppliedValue, 'type=search replaces LF with one space and preserves remaining literal text');
  assert.equal(expectedAppliedValue.endsWith(' \"\'_*%'), true, 'quotes and wildcard characters remain literal after browser normalization');
  assert.equal(await visibleRecordRows.count(), 0, 'hostile literal query has no matching DOM rows');
  assert.deepEqual(await visibleRecordRows.allTextContents(), [], 'hostile literal query does not expose partial-match row text');
  for (const key of BUSINESS_COLLECTIONS.filter(key => key !== 'auditLogs')) {
    assert.deepEqual(searched.after.state[key], searched.before.state[key], `hostile search ${key}`);
  }
  const beforeAuditIds = new Set(searched.before.state.auditLogs.map(item => item.id));
  const searchAuditDelta = searched.after.state.auditLogs.filter(item => !beforeAuditIds.has(item.id));
  assert.deepEqual(searchAuditDelta, [], 'hostile search itself persists no audit after explicit records navigation');
  await harness.driver.page().locator('.nav[data-page="requests"]').click();
  await harness.driver.waitForPersistenceBarrier({
    auditAction: '查看页面', auditTarget: '页面 requests', actor: 'WF tester', timeoutMs: 5_000
  });
  const edited = await executeCatalogAction(harness, actionById(harness.workflow, 'whitespace-edit'));
  assert.equal(edited.after.revision, edited.before.revision, 'whitespace edit revision');
  for (const key of BUSINESS_COLLECTIONS) {
    assert.deepEqual(edited.after.state[key], edited.before.state[key], `whitespace edit ${key}`);
  }
});

test('M01-M03 真实双击只产生一次预约、开始或取消迁移', { timeout: 180_000 }, async t => {
  for (const id of ['M01', 'M02', 'M03']) {
    await t.test(id, { timeout: 60_000 }, async subtest => {
      const harness = await createHarness(subtest, id);
      for (const action of harness.workflow.actions) await executeCatalogAction(harness, action);
      const state = readWorkflowSnapshot({ dataRoot: harness.runContext.dataRoot }).state;
      const sampleId = `REQ-WF-${id}-001.001`;
      const records = state.records.filter(item => item.sampleId === sampleId);
      const submitAudits = state.auditLogs.filter(item => item.action === '提交预约' && item.target?.includes(sampleId));
      assert.equal(records.length, 1, `${id} record count`);
      assert.equal(submitAudits.length, 1, `${id} submit audit count`);
      if (id === 'M01') {
        assert.equal(records[0].status, 'reserved');
      } else if (id === 'M02') {
        assert.equal(records[0].status, 'running');
        assert.equal(state.auditLogs.filter(item => item.action === '开始预约测试' && item.target?.includes(records[0].channelKey)).length, 1);
      } else {
        assert.equal(records[0].status, 'cancelled');
        const channel = state.channels.find(item => item.key === records[0].channelKey);
        assert.equal(channel?.state, 'free');
        assert.equal(String(channel?.currentRecordId || ''), '');
        assert.equal(String(channel?.nextRecordId || ''), '');
        assert.equal(state.auditLogs.filter(item => item.action === '取消预约' && item.target?.includes(records[0].channelKey)).length, 1);
      }
    });
  }
});

test('M04 真实 Electron 完成固定 80 步八入口导航与分页并可重启', { timeout: 480_000 }, async t => {
  const harness = await createHarness(t, 'M04');
  const observedPagers = [];
  const observedNavigations = [];
  for (const action of harness.workflow.actions) {
    const execution = await executeCatalogAction(harness, action);
    if (action.type === 'navigate') {
      assert.equal(execution.result.navigationEvidence?.to, M04_NAVIGATION_PAGES[action.params.label], `${action.id} navigation target`);
      assert.equal(execution.result.uiEvidence.projection.currentPage, M04_NAVIGATION_PAGES[action.params.label], `${action.id} final page`);
      observedNavigations.push(execution.result.navigationEvidence);
    }
    if (action.type === 'nextPage' || action.type === 'previousPage') {
      const evidence = execution.result.pageEvidence;
      const direction = action.type === 'nextPage' ? 'next' : 'previous';
      assert.equal(evidence?.view, action.params.view, `${action.id} view`);
      assert.equal(evidence?.direction, direction, `${action.id} direction`);
      assert.equal(evidence.after.page, evidence.before.page + (direction === 'next' ? 1 : -1), `${action.id} page delta`);
      assert.equal(evidence.before.pageCount, evidence.after.pageCount, `${action.id} page count`);
      assert.notEqual(evidence.before.token, evidence.after.token, `${action.id} token`);
      assert.notEqual(evidence.before.first, evidence.after.first, `${action.id} first row`);
      assert.notEqual(evidence.before.last, evidence.after.last, `${action.id} last row`);
      for (const snapshot of [evidence.before, evidence.after]) {
        assert.equal(snapshot.maxRows, M04_VIEW_LIMITS[action.params.view], `${action.id} max rows`);
        assert.equal(snapshot.domWithinLimit, true, `${action.id} DOM bound`);
        assert.ok(snapshot.rowCount > 0 && snapshot.rowCount <= snapshot.maxRows, `${action.id} DOM row count`);
      }
      observedPagers.push(evidence);
    }
  }
  assert.equal(observedNavigations.length, harness.workflow.actions.filter(action => action.type === 'navigate').length);
  assert.equal(observedPagers.length, harness.workflow.actions.filter(action => ['nextPage', 'previousPage'].includes(action.type)).length);
  assert.deepEqual([...new Set(observedPagers.map(item => item.view))].sort(), Object.keys(M04_VIEW_LIMITS).sort());
  const state = readWorkflowSnapshot({ dataRoot: harness.runContext.dataRoot }).state;
  assert.ok(state.records.filter(item => item.status === 'completed').length >= 2_000);
  assert.ok(state.records.filter(item => item.status === 'reserved').length >= 30);
  assert.equal((await harness.driver.uiProjection()).consoleErrors.length, 0);
});

test('M05 会话 B 在 A 写入前挂载旧提交入口，冲突后只保留 A 的记录', { timeout: 110_000 }, async t => {
  const harness = await createHarness(t, 'M05');
  const opened = await executeCatalogAction(harness, actionById(harness.workflow, 'open-session-b'));
  const cached = harness.runtime.staleDrafts?.get('B:reserve');
  assert.ok(cached?.locator);
  assert.equal(await cached.locator.evaluate(node => Boolean(node?.isConnected)), true);
  assert.ok(opened.after.state.revision >= opened.before.state.revision);

  await executeCatalogAction(harness, actionById(harness.workflow, 'reserve-session-a'));
  const stale = await executeCatalogAction(harness, actionById(harness.workflow, 'stale-submit-session-b'));
  assert.equal(stale.after.state.revision, stale.before.state.revision);
  assert.equal(harness.runtime.staleDrafts.has('B:reserve'), false);
  await executeCatalogAction(harness, actionById(harness.workflow, 'reload-session-b'));
  await executeCatalogAction(harness, actionById(harness.workflow, 'close-session-b'));

  const state = readWorkflowSnapshot({ dataRoot: harness.runContext.dataRoot }).state;
  const sampleId = 'REQ-WF-M05-001.001';
  const records = state.records.filter(item => item.sampleId === sampleId && item.status === 'reserved');
  assert.equal(records.length, 1);
  assert.equal(state.samples.find(item => item.id === sampleId)?.status, 'reserved');
  assert.equal(state.channels.find(item => item.key === records[0].channelKey)?.nextRecordId, records[0].id);
  assert.equal(state.auditLogs.filter(item => item.action === '提交预约' && item.target?.includes(sampleId)).length, 1);
});

test('M07 活动申请、设备和通道删除均零写入，历史人员删除不改写旧身份', { timeout: 90_000 }, async t => {
  const harness = await createHarness(t, 'M07');
  const initial = readWorkflowSnapshot({ dataRoot: harness.runContext.dataRoot }).state;
  const historyRecordIdentities = initial.records
    .filter(item => item.status === 'completed')
    .map(item => ({ id: item.id, user: item.user ?? null, actor: item.actor ?? null }))
    .sort((left, right) => left.id.localeCompare(right.id));
  const historyAuditIdentities = initial.auditLogs
    .map(item => ({ id: item.id, user: item.user ?? null, actor: item.actor ?? null }))
    .sort((left, right) => left.id.localeCompare(right.id));
  const historyRecordIds = new Set(historyRecordIdentities.map(item => item.id));
  const historyAuditIds = new Set(historyAuditIdentities.map(item => item.id));
  for (const id of ['delete-active-request', 'delete-active-device', 'delete-active-channel']) {
    const rejected = await executeCatalogAction(harness, actionById(harness.workflow, id));
    assert.equal(rejected.result.settlement.persistedRevision, rejected.result.settlement.beforeRevision, id);
    for (const key of ['requests', 'samples', 'channels', 'deviceProfiles', 'records', 'requestSourceRows', 'testers', 'formChangeJournal']) {
      assert.deepEqual(rejected.result.settlement.state[key], rejected.result.settlement.beforeState[key], `${id} ${key}`);
    }
  }
  await executeCatalogAction(harness, actionById(harness.workflow, 'delete-history-tester'));
  await executeCatalogAction(harness, actionById(harness.workflow, 'restart'));
  const state = readWorkflowSnapshot({ dataRoot: harness.runContext.dataRoot }).state;
  assert.equal(state.testers.some(item => item.name === 'WF tester'), false);
  assert.deepEqual(
    state.records
      .filter(item => historyRecordIds.has(item.id))
      .map(item => ({ id: item.id, user: item.user ?? null, actor: item.actor ?? null }))
      .sort((left, right) => left.id.localeCompare(right.id)),
    historyRecordIdentities,
    'completed record ID/user/actor identities survive tester deletion and restart'
  );
  assert.deepEqual(
    state.auditLogs
      .filter(item => historyAuditIds.has(item.id))
      .map(item => ({ id: item.id, user: item.user ?? null, actor: item.actor ?? null }))
      .sort((left, right) => left.id.localeCompare(right.id)),
    historyAuditIdentities,
    'historical audit ID/user/actor identities survive tester deletion and restart'
  );
});

test('M08 真实跨 15 个样品页选择一一对应并只提交最终可见关系', { timeout: 840_000 }, async t => {
  const harness = await createHarness(t, 'M08');
  const navigation = await executeCatalogAction(harness, actionById(harness.workflow, 'navigate-apply-for-selection-chain'));
  assert.equal(navigation.after.state.revision - navigation.before.state.revision, 1, 'M08 apply navigation persists its audit separately');
  const selectionBaseline = readWorkflowSnapshot({ dataRoot: harness.runContext.dataRoot }).state;
  const selectionActions = harness.workflow.actions.slice(1, 151);
  for (const action of selectionActions) {
    const execution = await executeCatalogAction(harness, action);
    assert.equal(execution.after.state.revision, execution.before.state.revision, action.id);
    assert.equal(execution.after.state.auditLogs.length, execution.before.state.auditLogs.length, action.id);
    assert.equal(execution.after.state.formChangeJournal.length, execution.before.state.formChangeJournal.length, action.id);
  }
  const afterSelection = readWorkflowSnapshot({ dataRoot: harness.runContext.dataRoot }).state;
  assert.equal(afterSelection.revision, selectionBaseline.revision, 'all 150 selection-chain actions remain zero-write');
  assert.equal(afterSelection.auditLogs.length, selectionBaseline.auditLogs.length, 'all 150 selection-chain actions add no audit');
  assert.equal(afterSelection.formChangeJournal.length, selectionBaseline.formChangeJournal.length, 'all 150 selection-chain actions add no journal');
  const prepared = actionById(harness.workflow, 'reserve-prepared');
  const page = harness.driver.page();
  const bySampleId = (left, right) => left.sampleId.localeCompare(right.sampleId);
  const expectedAssignments = prepared.params.sampleIds
    .map((sampleId, index) => ({ sampleId, channelKey: prepared.params.channelKeys[index] }))
    .sort(bySampleId);
  assert.equal(expectedAssignments.length, 15, 'M08 expected assignment count');
  assert.equal(new Set(expectedAssignments.map(item => item.sampleId)).size, 15, 'M08 expected sample IDs are unique');
  assert.equal(new Set(expectedAssignments.map(item => item.channelKey)).size, 15, 'M08 expected channel keys are unique');
  assert.equal(
    (await page.locator('.legacy-sample-assignment > header span').textContent())?.trim(),
    `${expectedAssignments.length} 块已选`
  );
  const beforeSubmit = readWorkflowSnapshot({ dataRoot: harness.runContext.dataRoot }).state;
  const expectedDomAssignments = expectedAssignments.map(({ sampleId, channelKey }) => {
    const channel = beforeSubmit.channels.find(item => item.key === channelKey);
    assert.ok(channel, `fixture channel ${channelKey}`);
    return { sampleId, label: `${channel.device || channel.deviceName} / ${channel.name}` };
  }).sort(bySampleId);
  const domAssignments = [];
  let samplePage = await harness.driver.viewEvidence('sample');
  assert.equal(samplePage.page, 16, 'M08 selection chain must finish on sample page 16');
  while (true) {
    domAssignments.push(...await page.locator('[data-testid="legacy-sample-row"]').evaluateAll(rows => rows.flatMap(row => {
      const button = row.querySelector('[data-legacy-action="open-channel-picker"][data-sample-id]');
      const label = button?.querySelector('strong')?.textContent?.trim() || '';
      return button && label !== '选择通道' ? [{ sampleId: button.dataset.sampleId, label }] : [];
    })));
    if (samplePage.page === 1) break;
    const previous = await executeCatalogAction(harness, {
        id: `verify-page-${String(samplePage.page).padStart(3, '0')}-previous`,
        type: 'previousPage',
        expect: 'success',
        revisionDelta: 0,
        params: { view: 'sample' },
        maxMs: 5_000
    });
    assert.equal(previous.result.pageEvidence.after.page, samplePage.page - 1, 'M08 DOM traversal page delta');
    samplePage = previous.result.pageEvidence.after;
  }
  domAssignments.sort(bySampleId);
  assert.equal(domAssignments.length, 15, 'M08 complete DOM assignment count');
  assert.deepEqual(domAssignments, expectedDomAssignments, 'M08 complete DOM assignment set');

  await executeCatalogAction(harness, prepared);
  await executeCatalogAction(harness, actionById(harness.workflow, 'restart'));
  const state = readWorkflowSnapshot({ dataRoot: harness.runContext.dataRoot }).state;
  const requestSampleIds = new Set(state.samples
    .filter(item => item.requestNo === prepared.params.requestNo)
    .map(item => item.id));
  const reservedRecords = state.records
    .filter(item => requestSampleIds.has(item.sampleId) && item.status === 'reserved')
    .map(item => ({ sampleId: item.sampleId, channelKey: item.channelKey }))
    .sort(bySampleId);
  assert.equal(reservedRecords.length, 15, 'M08 persisted reserved record count');
  assert.deepEqual(reservedRecords, expectedAssignments, 'M08 complete persisted reserved record set');

  const sampleAssignments = state.samples
    .filter(item => item.requestNo === prepared.params.requestNo && (item.status !== 'pending' || item.channelKey))
    .map(item => ({ sampleId: item.id, channelKey: item.channelKey }))
    .sort(bySampleId);
  assert.equal(sampleAssignments.length, 15, 'M08 persisted sample assignment count');
  assert.deepEqual(sampleAssignments, expectedAssignments, 'M08 complete persisted sample status/channel set');

  const recordsById = new Map(state.records.map(item => [item.id, item]));
  const pointerAssignments = state.channels
    .filter(item => requestSampleIds.has(recordsById.get(item.nextRecordId)?.sampleId))
    .map(item => {
      const record = recordsById.get(item.nextRecordId);
      return { sampleId: record.sampleId, channelKey: item.key };
    })
    .sort(bySampleId);
  assert.equal(pointerAssignments.length, 15, 'M08 channel nextRecordId pointer count');
  assert.deepEqual(pointerAssignments, expectedAssignments, 'M08 complete channel nextRecordId pointer set');

  const reservationAudits = state.auditLogs
    .filter(item => item.action === '提交预约' && item.requestNo === prepared.params.requestNo)
    .map(item => ({ sampleId: item.sampleId, channelKey: item.channelKey }))
    .sort(bySampleId);
  assert.equal(reservationAudits.length, 15, 'M08 reservation audit count');
  assert.deepEqual(reservationAudits, expectedAssignments, 'M08 complete reservation audit set');
});

test('M09 真实 parser 精确分类并区分 valid、skip、cover 与整批取消', { timeout: 180_000 }, async t => {
  const harness = await createHarness(t, 'M09');
  const importsRoot = path.join(harness.runContext.dataRoot, 'imports');
  const parsed = parseFolder(importsRoot);
  assert.equal(parsed.files, 6, 'M09 parser excludes the lock file from its file count');
  assert.deepEqual(
    parsed.records.map(item => ({ id: item.id, file: item.sourceFile })).sort((left, right) => left.file.localeCompare(right.file)),
    [
      { id: 'REQ-WF-IMPORT-002', file: 'flat.xlsx' },
      { id: 'REQ-WF-SAME-001', file: 'same-id-left.xlsx' },
      { id: 'REQ-WF-SAME-001', file: 'same-id-right.xlsx' },
      { id: 'REQ-WF-IMPORT-001', file: 'vertical.xlsx' }
    ],
    'M09 parser returns the four valid source records including both same-ID sources'
  );
  assert.deepEqual(
    parsed.errors.map(item => ({ file: item.file, code: item.code })).sort((left, right) => left.file.localeCompare(right.file)),
    [
      { file: 'blank.xlsx', code: 'UNRECOGNIZED_APPLICATION_WORKBOOK' },
      { file: 'corrupt.xlsx', code: 'UNRECOGNIZED_APPLICATION_WORKBOOK' }
    ],
    'M09 parser classifies blank and corrupt workbooks exactly'
  );
  assert.equal(
    [...parsed.records, ...parsed.errors].some(item => String(item.sourceFile || item.file).startsWith('~$')),
    false,
    'M09 parser omits the lock file completely'
  );

  const valid = await executeCatalogAction(harness, actionById(harness.workflow, 'import-valid'));
  const validAudit = valid.result.settlement.auditEvidence[0];
  assert.deepEqual(validAudit.after, { committed: 1, skipped: 0, covered: 0, errors: [] }, 'M09 valid import audit summary');
  const validRequest = valid.after.state.requests.find(item => item.id === 'REQ-WF-IMPORT-001');
  assert.ok(validRequest, 'M09 valid request persisted');
  assert.equal(validRequest.sourceFile, 'vertical.xlsx');
  assert.equal(valid.after.state.samples.filter(item => item.requestNo === validRequest.id).length, 2);
  assert.equal(valid.after.state.requestSourceRows.find(item => item.requestNo === validRequest.id)?.sourceFile, 'vertical.xlsx');
  assert.equal(valid.after.state.formChangeJournal.length, valid.before.state.formChangeJournal.length);

  const skipped = await executeCatalogAction(harness, actionById(harness.workflow, 'import-duplicate-skip'));
  const skippedAudit = skipped.result.settlement.auditEvidence[0];
  assert.deepEqual(skippedAudit.after, { committed: 0, skipped: 1, covered: 0, errors: [] }, 'M09 duplicate skip audit summary');
  for (const key of BUSINESS_COLLECTIONS.filter(key => key !== 'auditLogs')) {
    assert.deepEqual(skipped.after.state[key], skipped.before.state[key], `M09 duplicate skip ${key}`);
  }
  assert.equal(skipped.after.state.auditLogs.length, skipped.before.state.auditLogs.length + 1, 'M09 duplicate skip only appends one audit');

  const covered = await executeCatalogAction(harness, actionById(harness.workflow, 'import-duplicate-overwrite'));
  const coveredAudit = covered.result.settlement.auditEvidence[0];
  assert.deepEqual(coveredAudit.after, { committed: 0, skipped: 0, covered: 1, errors: [] }, 'M09 duplicate cover audit summary');
  const coveredRequest = covered.after.state.requests.find(item => item.id === 'REQ-WF-IMPORT-001');
  const beforeCoveredRequest = covered.before.state.requests.find(item => item.id === 'REQ-WF-IMPORT-001');
  assert.deepEqual(coveredRequest.execution, beforeCoveredRequest.execution, 'M09 cover preserves execution fields');
  assert.deepEqual(coveredRequest.rawHistory, [{
    rawFields: beforeCoveredRequest.rawFields,
    sourceFile: beforeCoveredRequest.sourceFile,
    sourcePath: beforeCoveredRequest.sourcePath,
    replacedAt: coveredAudit.time
  }], 'M09 cover records the exact prior raw source');
  const coverJournalDelta = covered.after.state.formChangeJournal.slice(covered.before.state.formChangeJournal.length);
  assert.equal(coverJournalDelta.length, 1, 'M09 cover appends exactly one form journal entry');
  assert.equal(coverJournalDelta[0].requestNo, 'REQ-WF-IMPORT-001');
  assert.equal(coverJournalDelta[0].action, '覆盖导入申请原始字段');
  assert.deepEqual(coverJournalDelta[0].before.rawFields, beforeCoveredRequest.rawFields);
  assert.deepEqual(coverJournalDelta[0].after.rawFields, coveredRequest.rawFields);

  const mixed = await executeCatalogAction(harness, actionById(harness.workflow, 'import-mixed-invalid'));
  assert.equal(mixed.after.state.revision, mixed.before.state.revision);
  for (const key of BUSINESS_COLLECTIONS) {
    assert.deepEqual(mixed.after.state[key], mixed.before.state[key], `mixed-invalid ${key}`);
  }
  const issuesText = (await harness.driver.page().locator('#importIssues').innerText()).replace(/\r/g, '');
  assert.match(issuesText, /批量导入发现 2 个异常文件/);
  assert.match(issuesText, /blank\.xlsx：无法识别申请单工作簿/);
  assert.match(issuesText, /corrupt\.xlsx：无法识别申请单工作簿/);
  assert.doesNotMatch(issuesText, /~\$locked\.xlsx|same-id-left\.xlsx|same-id-right\.xlsx/);

  assert.deepEqual(
    mixed.result.importEvidence,
    {
      enumeration: { workbookFiles: 7, parserFiles: 6, skippedLockFiles: ['~$locked.xlsx'] },
      parser: {
        records: [
          { requestNo: 'REQ-WF-IMPORT-002', sourceFile: 'flat.xlsx' },
          { requestNo: 'REQ-WF-SAME-001', sourceFile: 'same-id-left.xlsx' },
          { requestNo: 'REQ-WF-SAME-001', sourceFile: 'same-id-right.xlsx' },
          { requestNo: 'REQ-WF-IMPORT-001', sourceFile: 'vertical.xlsx' }
        ],
        errors: [
          { file: 'blank.xlsx', code: 'UNRECOGNIZED_APPLICATION_WORKBOOK' },
          { file: 'corrupt.xlsx', code: 'UNRECOGNIZED_APPLICATION_WORKBOOK' }
        ]
      },
      domain: {
        validCount: 3,
        committed: 2,
        skipped: 1,
        covered: 0,
        errors: [
          { file: 'blank.xlsx', requestNo: '', code: 'UNRECOGNIZED_APPLICATION_WORKBOOK' },
          { file: 'corrupt.xlsx', requestNo: '', code: 'UNRECOGNIZED_APPLICATION_WORKBOOK' },
          { file: '', requestNo: 'REQ-WF-SAME-001', code: 'DUPLICATE_REQUEST_IN_IMPORT' }
        ],
        wouldPersist: [
          { requestNo: 'REQ-WF-IMPORT-002', sourceFile: 'flat.xlsx' },
          { requestNo: 'REQ-WF-SAME-001', sourceFile: 'same-id-left.xlsx' }
        ]
      }
    },
    'M09 cancelled mixed-folder action exposes exact parser/domain dry-run evidence'
  );
  await executeCatalogAction(harness, actionById(harness.workflow, 'restart'));
});

test('M10 十二次文件操作的取消零文件，成功文件可重读且按匹配备份恢复', { timeout: 390_000 }, async t => {
  const harness = await createHarness(t, 'M10');
  const exportPaths = [1, 2].map(index => path.join(harness.runContext.exportsRoot, 'exports', `m10-log-${index}.xlsx`));
  const backupPaths = [1, 2].map(index => path.join(harness.runContext.exportsRoot, 'backups', `m10-${index}.batterydata`));
  const autoBackupRoot = path.join(harness.runContext.dataRoot, 'auto-backups');
  const doesNotExist = async target => assert.rejects(stat(target), error => error?.code === 'ENOENT', target);
  const assertCancelled = (execution, label) => {
    assert.equal(execution.result.settlement.persistedRevision, execution.result.settlement.beforeRevision, `${label} revision`);
    for (const key of BUSINESS_COLLECTIONS) {
      assert.deepEqual(execution.result.settlement.state[key], execution.result.settlement.beforeState[key], `${label} ${key}`);
    }
    assert.deepEqual(execution.result.settlement.auditEvidence, [], `${label} audit evidence`);
  };

  for (const id of ['export-cancel-1', 'export-cancel-2']) {
    assertCancelled(await executeCatalogAction(harness, actionById(harness.workflow, id)), id);
  }
  for (const target of exportPaths) await doesNotExist(target);

  for (const [index, id] of ['export-success-1', 'export-success-2'].entries()) {
    const execution = await executeCatalogAction(harness, actionById(harness.workflow, id));
    const details = await stat(exportPaths[index]);
    assert.equal(details.isFile(), true, `${id} is a regular file`);
    assert.ok(details.size > 0, `${id} is non-empty`);
    assert.equal((await readFile(exportPaths[index])).subarray(0, 2).toString('ascii'), 'PK', `${id} XLSX signature`);
    const workbook = XLSX.readFile(exportPaths[index], { cellFormula: true, cellDates: false });
    assert.deepEqual(workbook.SheetNames, ['日志', '使用记录', '测试设备使用表2', '通道当前状态'], `${id} sheet names`);
    assert.deepEqual(execution.result.settlement.auditEvidence.map(item => item.action), ['导出日志与使用数据'], `${id} audit`);
    assert.equal(path.resolve(execution.result.settlement.auditEvidence[0].after.file), path.resolve(exportPaths[index]), `${id} audited file path`);
  }

  for (const id of ['backup-cancel-1', 'backup-cancel-2']) {
    assertCancelled(await executeCatalogAction(harness, actionById(harness.workflow, id)), id);
  }
  for (const target of backupPaths) await doesNotExist(target);
  await doesNotExist(autoBackupRoot);

  const backup1Execution = await executeCatalogAction(harness, actionById(harness.workflow, 'backup-success-1'));
  const backup1Package = JSON.parse(await readFile(backupPaths[0], 'utf8'));
  const backup1State = verifyLegacyBackup(backup1Package);
  assert.equal(backup1Package.format, 'battery-channel-hub-legacy-backup');
  assert.equal(backup1Package.version, 1);
  assert.equal(backup1Package.sourceRevision, backup1State.revision);
  assert.match(backup1Package.stateSha256, /^[a-f0-9]{64}$/);
  assert.equal(path.resolve(backup1Execution.result.settlement.auditEvidence[0].after.file), path.resolve(backupPaths[0]));

  const firstSentinel = await executeCatalogAction(harness, {
    id: 'm10-first-backup-sentinel', type: 'createTester', expect: 'success', revisionDelta: 1,
    params: { name: 'M10 仅第二份备份包含', dept: '自动测试', phone: '1010', note: 'restore-2 必须恢复' }, maxMs: 10_000
  });
  assert.equal(firstSentinel.after.state.testers.some(item => item.name === 'M10 仅第二份备份包含'), true);

  const backup2Execution = await executeCatalogAction(harness, actionById(harness.workflow, 'backup-success-2'));
  const backup2Package = JSON.parse(await readFile(backupPaths[1], 'utf8'));
  const backup2State = verifyLegacyBackup(backup2Package);
  assert.equal(backup2Package.format, 'battery-channel-hub-legacy-backup');
  assert.equal(backup2Package.version, 1);
  assert.equal(backup2Package.sourceRevision, backup2State.revision);
  assert.match(backup2Package.stateSha256, /^[a-f0-9]{64}$/);
  assert.equal(path.resolve(backup2Execution.result.settlement.auditEvidence[0].after.file), path.resolve(backupPaths[1]));
  assert.equal(backup1State.testers.some(item => item.name === 'M10 仅第二份备份包含'), false, 'backup-1 excludes first sentinel');
  assert.equal(backup2State.testers.some(item => item.name === 'M10 仅第二份备份包含'), true, 'backup-2 includes first sentinel');

  const secondSentinel = await executeCatalogAction(harness, {
    id: 'm10-pre-restore-sentinel', type: 'createTester', expect: 'success', revisionDelta: 1,
    params: { name: 'M10 两份备份都不包含', dept: '自动测试', phone: '1011', note: '两次恢复都必须移除' }, maxMs: 10_000
  });
  assert.equal(secondSentinel.after.state.testers.some(item => item.name === 'M10 两份备份都不包含'), true);

  for (const id of ['restore-cancel-1', 'restore-cancel-2']) {
    const cancelled = await executeCatalogAction(harness, actionById(harness.workflow, id));
    assertCancelled(cancelled, id);
    assert.equal(cancelled.after.state.testers.some(item => item.name === 'M10 仅第二份备份包含'), true, `${id} preserves first sentinel`);
    assert.equal(cancelled.after.state.testers.some(item => item.name === 'M10 两份备份都不包含'), true, `${id} preserves second sentinel`);
  }
  await doesNotExist(autoBackupRoot);

  const restored1 = await executeCatalogAction(harness, actionById(harness.workflow, 'restore-success-1'));
  assert.equal(restored1.after.state.testers.some(item => item.name === 'M10 仅第二份备份包含'), false, 'restore-1 adopts backup-1 roster');
  assert.equal(restored1.after.state.testers.some(item => item.name === 'M10 两份备份都不包含'), false, 'restore-1 removes post-backup sentinel');
  assert.deepEqual(restored1.result.settlement.auditEvidence.map(item => item.action), ['恢复数据备份']);
  assertCompleteRestore(restored1, backup1State, 'restore-1');
  const afterRestore1Files = (await readdir(autoBackupRoot)).sort();
  assert.equal(afterRestore1Files.length, 1, 'restore-1 creates one automatic pre-restore backup');
  const preRestore1State = verifyLegacyBackup(JSON.parse(await readFile(path.join(autoBackupRoot, afterRestore1Files[0]), 'utf8')));
  assertPreRestoreBackup(
    preRestore1State,
    restored1.result.settlement.beforeState,
    'restore-1 automatic pre-restore backup'
  );

  const restored2 = await executeCatalogAction(harness, actionById(harness.workflow, 'restore-success-2'));
  assert.equal(restored2.after.state.testers.some(item => item.name === 'M10 仅第二份备份包含'), true, 'restore-2 adopts backup-2 roster');
  assert.equal(restored2.after.state.testers.some(item => item.name === 'M10 两份备份都不包含'), false, 'restore-2 does not adopt post-backup sentinel');
  assert.deepEqual(restored2.result.settlement.auditEvidence.map(item => item.action), ['恢复数据备份']);
  assertCompleteRestore(restored2, backup2State, 'restore-2');
  const afterRestore2Files = (await readdir(autoBackupRoot)).sort();
  assert.equal(afterRestore2Files.length, 2, 'restore-2 creates a second automatic pre-restore backup');
  const preRestore2Name = afterRestore2Files.find(item => item !== afterRestore1Files[0]);
  const preRestore2State = verifyLegacyBackup(JSON.parse(await readFile(path.join(autoBackupRoot, preRestore2Name), 'utf8')));
  assertPreRestoreBackup(
    preRestore2State,
    restored2.result.settlement.beforeState,
    'restore-2 automatic pre-restore backup'
  );

  const state = readWorkflowSnapshot({ dataRoot: harness.runContext.dataRoot }).state;
  assert.equal(state.auditLogs.filter(item => item.action === '导出日志与使用数据').length, 2);
  assert.equal(state.auditLogs.filter(item => item.action === '手动备份数据').length, 2);
  assert.equal(state.auditLogs.filter(item => item.action === '恢复数据备份').length, 2);
});

test('M11 真实旧 ElementHandle 在结束重绘后 detached 或隐藏拒绝且零写入', { timeout: 90_000 }, async t => {
  const harness = await createHarness(t, 'M11');
  const retained = await executeCatalogAction(harness, actionById(harness.workflow, 'retain-old-dom'));
  const beforeAuditIds = new Set(retained.before.state.auditLogs.map(item => item.id));
  const retentionAudits = retained.after.state.auditLogs.filter(item => !beforeAuditIds.has(item.id));
  assert.deepEqual(retentionAudits.map(item => [item.action, item.target]).sort(), [
    ['查看页面', '页面 dashboard'],
    ['查看页面', '页面 records'],
    ['查看页面', '页面 reserved']
  ]);
  assert.equal(harness.runtime.retainedDom.size, 3);
  const handles = [...harness.runtime.retainedDom.values()];
  assert.ok(handles.every(handle => typeof handle.elementHandle === 'undefined'));
  await executeCatalogAction(harness, actionById(harness.workflow, 'finish-running'));
  const connected = Object.fromEntries(await Promise.all([...harness.runtime.retainedDom.entries()].map(async ([key, handle]) => [
    key,
    await handle.evaluate(node => Boolean(node?.isConnected)).catch(() => false)
  ])));
  assert.equal(connected['manageRunning:REQ-WF-M11-RUNNING-001.001'], false);
  assert.equal(connected['startTodo:REQ-WF-M11-RESERVED-001.001'], true);
  assert.equal(connected['cancelTodo:REQ-WF-M11-RESERVED-001.001'], true);
  for (const id of ['manage-running-old', 'start-todo-old', 'cancel-todo-old']) {
    const rejected = await executeCatalogAction(harness, actionById(harness.workflow, id));
    const navigationDelta = rejected.after.state.revision - rejected.before.state.revision;
    const expectedNavigationDeltas = id === 'start-todo-old' ? [0, 1] : [0];
    assert.ok(expectedNavigationDeltas.includes(navigationDelta), `${id} navigation delta ${navigationDelta}`);
    for (const key of ['requests', 'samples', 'channels', 'deviceProfiles', 'records', 'requestSourceRows', 'testers', 'formChangeJournal']) {
      assert.deepEqual(rejected.after.state[key], rejected.before.state[key], `${id} ${key}`);
    }
    if (id === 'start-todo-old' && navigationDelta === 1) {
      const previousAudits = new Set(rejected.before.state.auditLogs.map(item => item.id));
      assert.deepEqual(
        rejected.after.state.auditLogs.filter(item => !previousAudits.has(item.id)).map(item => [item.action, item.target]),
        [['查看页面', '页面 dashboard']]
      );
    }
    assert.match(rejected.result.message, /detached|hidden/, id);
  }
  await executeCatalogAction(harness, actionById(harness.workflow, 'reload-current'));
});

test('M12 真实 SQLite 写锁失败零采用，释放后同一预约和管理流程可继续并经重启保留', { timeout: 120_000 }, async t => {
  const harness = await createHarness(t, 'M12');
  const initial = readWorkflowSnapshot({ dataRoot: harness.runContext.dataRoot }).state;
  const initialRunning = structuredClone(initial.records.find(item => item.sampleId === 'REQ-WF-M12-RUNNING-001.001'));
  assert.ok(initialRunning);
  const initialRunningChannel = structuredClone(initial.channels.find(item => item.key === initialRunning.channelKey));
  assert.ok(initialRunningChannel);

  const lockedReserve = await executeCatalogAction(harness, actionById(harness.workflow, 'locked-reserve'));
  assert.equal(lockedReserve.result.settlement.persistedRevision, lockedReserve.result.settlement.beforeRevision);
  assert.equal(lockedReserve.after.state.samples.find(item => item.id === 'REQ-WF-M12-PENDING-001.001')?.status, 'pending');
  assert.equal(lockedReserve.after.state.records.some(item => item.sampleId === 'REQ-WF-M12-PENDING-001.001'), false);

  const reserved = await executeCatalogAction(harness, actionById(harness.workflow, 'reserve-after-release'));
  const reservedRecord = reserved.after.state.records.find(item => item.sampleId === 'REQ-WF-M12-PENDING-001.001');
  assert.equal(reservedRecord?.status, 'reserved');
  assert.equal(reserved.after.state.channels.find(item => item.key === reservedRecord?.channelKey)?.nextRecordId, reservedRecord?.id);

  const lockedManage = await executeCatalogAction(harness, actionById(harness.workflow, 'locked-manage-running'));
  const unchangedRunning = lockedManage.after.state.records.find(item => item.id === initialRunning.id);
  const unchangedChannel = lockedManage.after.state.channels.find(item => item.key === initialRunning.channelKey);
  assert.equal(lockedManage.result.settlement.persistedRevision, lockedManage.result.settlement.beforeRevision);
  assert.equal(unchangedRunning?.end, initialRunning.end);
  assert.equal(unchangedChannel?.end, initialRunningChannel.end);
  assert.equal(unchangedChannel?.specialCondition, initialRunningChannel.specialCondition);

  const managed = await executeCatalogAction(harness, actionById(harness.workflow, 'manage-after-release'));
  const managedRunning = managed.after.state.records.find(item => item.id === initialRunning.id);
  const managedChannel = managed.after.state.channels.find(item => item.key === initialRunning.channelKey);
  assert.notEqual(managedRunning?.end, initialRunning.end);
  assert.equal(managedRunning?.end, managedChannel?.end);
  assert.equal(managedChannel?.specialCondition, '解除锁后保存');

  await executeCatalogAction(harness, actionById(harness.workflow, 'restart'));
  const restarted = readWorkflowSnapshot({ dataRoot: harness.runContext.dataRoot }).state;
  assert.equal(restarted.records.find(item => item.id === reservedRecord.id)?.status, 'reserved');
  assert.equal(restarted.channels.find(item => item.key === initialRunning.channelKey)?.specialCondition, '解除锁后保存');
});
