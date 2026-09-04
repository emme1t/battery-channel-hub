import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { after, before, test } from 'node:test';
import { readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

import XLSX from 'xlsx';

import { createWorkflowElectronDriver } from '../workflows/electron-driver.mjs';
import { buildManualGuidedData } from './data-generator.mjs';
import { createManualOperator } from './operator.mjs';
import { assertManualSafety, captureManualSnapshot, compareManualSnapshots } from './oracle.mjs';
import { createManualGuidedRunContext } from './run-context.mjs';
import { createCompressedSchedule } from './time-policy.mjs';

const projectRoot = path.resolve(import.meta.dirname, '..', '..');
const executablePath = process.env.MANUAL_GUIDED_EXECUTABLE_PATH || path.join(projectRoot, 'dist', 'win-unpacked', '电池测试通道预约与使用看板.exe');
const manualPath = process.env.MANUAL_GUIDED_MANUAL_PATH || 'C:\\Users\\ASUS\\Desktop\\使用说明\\01-软件使用说明.md';
const stylesRoot = process.env.MANUAL_GUIDED_STYLES_ROOT || 'C:\\Users\\ASUS\\Desktop\\使用说明\\文件样式';
const actor = '虚构测试工程师-扩展旅程';
const deviceName = '虚构扩展电池测试设备';
const channelNames = Object.freeze(['01', '02', '03']);

let runContext;
let driver;
let operator;
let manifest;
let allPassed = true;

function data(id) {
  const entry = manifest.find(item => item.id === id);
  if (!entry) throw new Error(`missing fixture ${id}`);
  return entry;
}

function snapshot() {
  const value = captureManualSnapshot({ dataRoot: runContext.dataRoot });
  assertManualSafety(value);
  return value;
}

function businessHashes(value) {
  return Object.fromEntries(Object.entries(value.collectionHashes).filter(([name]) => name !== 'auditLogs'));
}

async function importFile(id, actionId, { outcome = 'success', expectText, timeoutMs } = {}) {
  return operator.perform({
    id: actionId,
    type: 'importFile',
    params: {
      path: data(id).path,
      outcome,
      ...(expectText ? { expectText } : {}),
      ...(timeoutMs ? { timeoutMs } : {})
    }
  });
}

async function defect(scenarioId, code, detail) {
  await writeFile(path.join(runContext.artifactsRoot, `${scenarioId}-${code}.json`), `${JSON.stringify({ scenarioId, code, ...detail }, null, 2)}\n`, 'utf8');
}

async function createVisibleResources() {
  await operator.navigate({ id: 'C-setup-devices', label: '设备与通道' });
  await operator.click({ name: '新建设备', exact: false });
  await operator.fill({ label: '设备名称', value: deviceName });
  await operator.fill({ label: '设备厂家', value: '虚构扩展仪器厂家' });
  await operator.fill({ label: '最大电压', value: '5' });
  await operator.fill({ label: '最大电流', value: '100' });
  await operator.click({ name: '保存设备', exact: true });
  await driver.page().getByText('设备参数已保存', { exact: true }).waitFor({ state: 'visible' });
  for (const name of channelNames) {
    await operator.click({ name: '新增通道', exact: false });
    await operator.choose({ label: '所属设备', value: deviceName });
    await operator.fill({ label: '通道号', value: name });
    await operator.fill({ label: '最大电压', value: '5' });
    await operator.fill({ label: '最大电流', value: '100' });
    await operator.click({ name: '保存通道', exact: true });
    await driver.page().getByText('通道参数已保存', { exact: true }).waitFor({ state: 'visible' });
  }
  await operator.navigate({ id: 'C-setup-testers', label: '测试人员' });
  await operator.click({ name: '新增测试人员', exact: false });
  await operator.fill({ label: '姓名', value: actor });
  await operator.fill({ label: '部门', value: '虚构电池测试部' });
  await operator.click({ name: '保存测试人员', exact: true });
  await driver.page().getByText('测试人员已保存', { exact: true }).waitFor({ state: 'visible' });
}

async function createOrdinary(requestNo, channelName, { reserve = false } = {}) {
  const schedule = createCompressedSchedule({ now: new Date(), kind: 'ordinary', offsetMinutes: 1 });
  await operator.navigate({ id: `${requestNo}-apply`, label: '开始/预约测试' });
  await operator.fill({ label: '搜索申请单、项目、样品或人员', value: requestNo });
  await operator.click({ name: '预约', exact: true });
  await operator.click({ name: reserve ? '提交预约' : '立即开始', role: 'radio', exact: true });
  await operator.fill({ label: reserve ? '预约开始时间' : '开始时间', value: schedule.startValue });
  await operator.fill({ label: '预计结束时间', value: schedule.endValue });
  await operator.click({ name: '选择通道', exact: false });
  await operator.click({ name: `${deviceName} ${channelName}`, exact: false });
  await operator.click({ name: reserve ? '提交预约' : '立即开始', exact: true });
  return schedule;
}

async function returnActiveRecord(requestNo, reason) {
  await operator.navigate({ id: `${requestNo}-running`, label: '正在测试样品' });
  await driver.page().getByText(`${requestNo}.001`, { exact: true }).waitFor({ state: 'visible' });
  await operator.click({ name: '退回申请', exact: true });
  await operator.fill({ label: '退回原因', value: reason });
  const submit = driver.page().getByRole('button', { name: /确认.*退回|提交.*退回/ });
  await submit.first().waitFor({ state: 'visible' });
  await submit.first().click();
}

async function startStorage(requestNo, id) {
  const schedule = createCompressedSchedule({ now: new Date(), kind: 'storage', offsetMinutes: 1 });
  await operator.navigate({ id: `${id}-apply`, label: '开始/预约测试' });
  await operator.fill({ label: '搜索申请单、项目、样品或人员', value: requestNo });
  await operator.click({ name: '预约', exact: true });
  await operator.click({ name: '长期存储', role: 'radio', exact: true });
  await operator.click({ name: '选择长期存储', exact: true });
  await operator.fill({ label: '预计结束时间', value: schedule.endValue });
  await operator.click({ name: '开始长期存储', exact: true });
  await driver.page().getByText('长期存储已开始', { exact: true }).waitFor({ state: 'visible' });
  return schedule;
}

function journey(name, fn, timeout = 300_000) {
  test(name, { timeout }, async () => {
    try { await fn(); } catch (error) { allPassed = false; throw error; }
  });
}

before(async () => {
  runContext = await createManualGuidedRunContext({ projectRoot, mode: 'full', executablePath, manualPath, stylesRoot });
  manifest = await buildManualGuidedData({ runContext, clock: () => new Date('2026-09-02T09:00:00-07:00') });
  driver = createWorkflowElectronDriver({
    projectRoot, dataRoot: runContext.dataRoot, profileRoot: runContext.profileRoot,
    reportNamespace: 'manual-guided', viewport: '1366x768', timeoutMs: 60_000,
    packaged: true, executablePath
  });
  operator = createManualOperator({ driver, actor, timeoutMs: 300_000 });
  await driver.start();
});

after(async () => {
  let closeError = null;
  await driver?.close().catch(error => { closeError = error; allPassed = false; });
  if (runContext && manifest) await writeFile(path.join(runContext.artifactsRoot, 'data-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  const protection = await runContext?.verifyProtected();
  if (protection && !protection.ok) allPassed = false;
  await runContext?.cleanup({ success: allPassed });
  if (closeError) throw closeError;
  assert.equal(protection?.ok, true);
});

journey('A02 rejects blank usernames and recovers with the manual-only fictional engineer', async () => {
  assert.throws(() => captureManualSnapshot({ dataRoot: runContext.dataRoot }), /app_state row id=1 is missing/);
  assert.equal((await operator.login({ id: 'A02-blank', username: '' })).outcome, 'rejected');
  assert.throws(() => captureManualSnapshot({ dataRoot: runContext.dataRoot }), /app_state row id=1 is missing/);
  assert.equal((await operator.login({ id: 'A02-spaces', username: '   ' })).outcome, 'rejected');
  assert.throws(() => captureManualSnapshot({ dataRoot: runContext.dataRoot }), /app_state row id=1 is missing/);
  assert.equal((await operator.login({ id: 'A02-recover', username: actor })).outcome, 'success');
  assert.equal(snapshot().summary.requests, 0);
});

journey('B02 imports horizontal XLSX, real XLS and CSV through the GUI', async () => {
  await operator.navigate({ id: 'B02-requests', label: '测试申请表格' });
  const beforeState = snapshot();
  for (const id of ['normal-horizontal-3', 'normal-xls-2', 'normal-csv-4']) {
    assert.equal((await importFile(id, `B02-${id}`, { expectText: '单个 Excel 导入完成' })).outcome, 'success');
  }
  const afterState = snapshot();
  assert.equal(afterState.summary.requests - beforeState.summary.requests, 9);
  for (const id of ['normal-horizontal-3', 'normal-xls-2', 'normal-csv-4']) {
    for (const requestNo of data(id).expected.requestNumbers) {
      assert.ok(afterState.state.requests.some(item => String(item.id ?? item.requestNo) === requestNo));
    }
  }
});

journey('B03 imports 300 vertical single applications and exports their generated summary', async () => {
  const source = data('folder-vertical-300');
  await operator.navigate({ id: 'B03-requests', label: '测试申请表格' });
  const beforeState = snapshot();
  const importResult = await operator.perform({
    id: 'B03-folder',
    type: 'importFolder',
    params: { path: source.path, outcome: 'success', timeoutMs: 60_000 }
  });
  assert.equal(importResult.outcome, 'success', importResult.visibleMessage);
  const visibleImportMessage = String(await driver.page().locator('#toast').textContent() || '').trim();
  const afterState = snapshot();
  assert.equal(afterState.summary.requests - beforeState.summary.requests, 300);
  for (const requestNo of source.expected.requestNumbers) {
    assert.ok(afterState.state.requests.some(item => String(item.id ?? item.requestNo) === requestNo));
  }
  const summaryPath = path.join(runContext.exportsRoot, 'B03-300份纵向单表汇总.xlsx');
  assert.equal((await operator.perform({
    id: 'B03-export-summary', type: 'exportRequests',
    params: { path: summaryPath, expectText: '测试申请汇总 XLSX 已导出' }
  })).outcome, 'success');
  const workbook = XLSX.readFile(summaryPath);
  const rows = XLSX.utils.sheet_to_json(workbook.Sheets['测试申请表格'], { header: 1, defval: '' });
  const exportedIds = new Set(rows.flat().map(String));
  assert.equal(source.expected.requestNumbers.every(id => exportedIds.has(id)), true);
  assert.equal((await operator.restart({ id: 'B03-restart-after-300-imports' })).outcome, 'success');
  assert.equal((await operator.login({ id: 'B03-login-after-300-imports', username: actor })).outcome, 'success');
  const persistedState = snapshot();
  assert.equal(persistedState.summary.requests, afterState.summary.requests);
  const persistedRequestNumbers = new Set(persistedState.state.requests.map(item => String(item.id ?? item.requestNo)));
  assert.equal(source.expected.requestNumbers.every(id => persistedRequestNumbers.has(id)), true);
  assert.equal((await operator.navigate({ id: 'B03-requests-after-restart', label: '测试申请表格' })).outcome, 'success');
  const screenshotPath = await driver.screenshot('B03-300-vertical-single-applications');
  await writeFile(path.join(runContext.artifactsRoot, 'B03-300-vertical-single-applications.json'), `${JSON.stringify({
    scenarioId: 'B03', sourceFileCount: 300, importedRequestCount: 300,
    exportedSummaryMatchedRequestCount: source.expected.requestNumbers.filter(id => exportedIds.has(id)).length,
    persistedAfterRestartCount: source.expected.requestNumbers.filter(id => persistedRequestNumbers.has(id)).length,
    visibleImportMessage, importStartedAt: importResult.startedAt, importEndedAt: importResult.endedAt, screenshotPath
  }, null, 2)}\n`, 'utf8');
}, 300_000);

journey('B04 records every abnormal quantity or request-number acceptance and continues', async () => {
  await operator.navigate({ id: 'B04-requests', label: '测试申请表格' });
  const cases = ['quantity-blank', 'quantity-0', 'quantity-1000', 'quantity-decimal', 'quantity-text', 'quantity-spaces', 'request-number-missing', 'request-number-duplicate', 'request-number-conflict'];
  const findings = [];
  for (const id of cases) {
    const beforeState = snapshot();
    await importFile(id, `B04-${id}`, { outcome: 'rejected' });
    const afterState = snapshot();
    const diff = compareManualSnapshots(beforeState, afterState);
    findings.push({ id, visibleMessage: String(await driver.page().locator('#toast').textContent().catch(() => '') || '').trim(), diff });
  }
  const accepted = findings.filter(item => item.diff.changedCollections.some(name => name !== 'auditLogs'));
  if (accepted.length > 0) await defect('B04', 'INVALID_APPLICATION_ACCEPTED', { accepted, recovery: '保留隔离现场并继续其他独立场景' });
  assert.ok(snapshot().state.requests.some(item => String(item.id || '').startsWith('BBX-')));
});

journey('B05 exercises damaged, size and row boundaries through the GUI', async () => {
  await operator.navigate({ id: 'B05-requests', label: '测试申请表格' });
  const rejected = ['damaged-xlsx', 'fake-extension', 'blank-workbook', 'file-over-25mb', 'sheet-50001'];
  const findings = [];
  for (const id of rejected) {
    const beforeState = snapshot();
    await importFile(id, `B05-${id}`, { outcome: 'rejected' });
    const afterState = snapshot();
    findings.push({ id, diff: compareManualSnapshots(beforeState, afterState), visibleMessage: String(await driver.page().locator('#toast').textContent().catch(() => '') || '').trim() });
  }
  const underSize = await importFile('file-under-25mb', 'B05-file-under-25mb', { expectText: '单个 Excel 导入完成' });
  assert.equal(underSize.outcome, 'success', underSize.visibleMessage);
  const rowBoundaryBefore = snapshot();
  const rowBoundary = await importFile('sheet-50000', 'B05-sheet-50000', {
    expectText: '单个 Excel 导入完成',
    timeoutMs: 60_000
  });
  if (rowBoundary.outcome !== 'success') {
    assert.equal((await operator.restart({ id: 'B05-restart-after-row-timeout' })).outcome, 'success');
    assert.equal((await operator.login({ id: 'B05-relogin-after-row-timeout', username: actor })).outcome, 'success');
    const recovered = snapshot();
    await defect('B05', 'ALLOWED_50000_ROW_IMPORT_TIMEOUT', {
      visibleMessage: rowBoundary.visibleMessage,
      beforeSummary: rowBoundaryBefore.summary,
      recoveredSummary: recovered.summary,
      requestPersisted: recovered.state.requests.some(item => String(item.id ?? item.requestNo) === data('sheet-50000').expected.requestNumbers[0]),
      recovery: '关闭无响应窗口并以同一 profile 重启；重新登录后只读核验 SQLite 安全'
    });
  }
  const acceptedInvalid = findings.filter(item => item.diff.changedCollections.some(name => name !== 'auditLogs'));
  if (acceptedInvalid.length > 0) await defect('B05', 'INVALID_BOUNDARY_ACCEPTED', { acceptedInvalid });
  await writeFile(path.join(runContext.artifactsRoot, 'B05-boundary-results.json'), `${JSON.stringify({ rejected: findings, allowed: { underSize, rowBoundary } }, null, 2)}\n`, 'utf8');
  await operator.navigate({ id: 'B05-cleanup-requests', label: '测试申请表格' });
  const cleanupIds = [
    data('fake-extension').expected.requestNumbers[0],
    data('file-under-25mb').expected.requestNumbers[0],
    data('sheet-50000').expected.requestNumbers[0]
  ].filter(id => snapshot().state.requests.some(item => String(item.id ?? item.requestNo) === id));
  for (const id of cleanupIds) await driver.page().locator(`.request-check[value="${id}"]`).check();
  if (cleanupIds.length > 0) {
    driver.page().once('dialog', dialog => void dialog.accept());
    await operator.click({ name: '删除选中', exact: true });
    await driver.page().locator('#toast').filter({ hasText: '已删除' }).waitFor({ state: 'visible' });
  }
  const cleaned = snapshot();
  assert.ok(cleanupIds.every(id => !cleaned.state.requests.some(item => String(item.id ?? item.requestNo) === id)));
});

journey('C02 reserves, starts and finishes an ordinary test through visible stages', async () => {
  await createVisibleResources();
  const requestNo = data('normal-horizontal-3').expected.requestNumbers[0];
  const schedule = await createOrdinary(requestNo, channelNames[0], { reserve: true });
  let state = snapshot();
  const reserved = state.state.records.find(item => item.requestNo === requestNo && item.status === 'reserved');
  assert.ok(reserved);
  assert.equal(state.state.channels.find(item => item.key === `${deviceName}|${channelNames[0]}`)?.state, 'booked');

  await operator.navigate({ id: 'C02-reserved', label: '已预约表单处理' });
  await driver.page().locator('#reservedTable').getByText(requestNo, { exact: true }).waitFor({ state: 'visible' });
  await operator.click({ name: '开始测试', exact: true });
  await driver.page().getByText('已开始预约测试', { exact: true }).waitFor({ state: 'visible' });
  state = snapshot();
  assert.equal(state.state.records.find(item => item.id === reserved.id)?.status, 'running');

  await operator.navigate({ id: 'C02-dashboard', label: '通道看板' });
  await operator.click({ name: '展开', exact: false });
  await operator.click({ name: '结束测试', exact: true });
  await driver.page().getByText('通道状态已更新', { exact: true }).waitFor({ state: 'visible' });
  state = snapshot();
  assert.equal(state.state.records.find(item => item.id === reserved.id)?.status, 'completed');
  assert.equal(state.state.channels.find(item => item.key === `${deviceName}|${channelNames[0]}`)?.state, 'free');
  await writeFile(path.join(runContext.artifactsRoot, 'C02-compressed-schedule.json'), `${JSON.stringify(schedule, null, 2)}\n`, 'utf8');
});

journey('C03 returns running and reserved tests to the application with required reasons', async () => {
  const [runningRequest, reservedRequest] = data('normal-horizontal-3').expected.requestNumbers.slice(1, 3);
  if (await driver.page().getByLabel('用户名', { exact: true }).isVisible().catch(() => false)) {
    assert.equal((await operator.login({ id: 'C03-login', username: actor })).outcome, 'success');
  }
  let setupState = snapshot();
  if (!setupState.state.requests.some(item => String(item.id ?? item.requestNo) === runningRequest)) {
    await operator.navigate({ id: 'C03-import-page', label: '测试申请表格' });
    assert.equal((await importFile('normal-horizontal-3', 'C03-import', { expectText: '单个 Excel 导入完成' })).outcome, 'success');
    setupState = snapshot();
  }
  if (!setupState.state.channels.some(item => item.device === deviceName)) {
    await createVisibleResources();
  }
  await createOrdinary(runningRequest, channelNames[0]);
  await returnActiveRecord(runningRequest, 'C03 虚构运行中退回补充申请资料');
  let state = snapshot();
  const returned = state.state.records.find(item => item.requestNo === runningRequest);
  assert.equal(returned?.status, 'returned');
  assert.equal(returned?.returnReason, 'C03 虚构运行中退回补充申请资料');
  assert.equal(state.state.samples.find(item => item.id === `${runningRequest}.001`)?.status, 'pending');

  await createOrdinary(reservedRequest, channelNames[0], { reserve: true });
  await operator.navigate({ id: 'C03-reserved', label: '已预约表单处理' });
  await driver.page().locator('#reservedTable').getByText(reservedRequest, { exact: true }).waitFor({ state: 'visible' });
  const beforeBlankReason = snapshot();
  await operator.click({ name: '退回申请', exact: true });
  await operator.fill({ label: '退回原因', value: '   ' });
  await operator.click({ name: '确认退回', exact: true });
  await driver.page().getByText('退回申请必须填写原因', { exact: true }).waitFor({ state: 'visible' });
  assert.deepEqual(businessHashes(snapshot()), businessHashes(beforeBlankReason));

  const reason = 'C03 虚构预约退回补充申请资料';
  await operator.click({ name: '退回申请', exact: true });
  await operator.fill({ label: '退回原因', value: reason });
  await operator.click({ name: '确认退回', exact: true });
  await driver.page().getByText('普通测试已退回申请', { exact: true }).waitFor({ state: 'visible' });
  state = snapshot();
  const returnedReservation = state.state.records.find(item => item.requestNo === reservedRequest);
  assert.equal(returnedReservation?.status, 'returned');
  assert.equal(returnedReservation?.returnReason, reason);
  assert.equal(state.state.samples.find(item => item.id === `${reservedRequest}.001`)?.status, 'pending');
  assert.equal(state.state.channels.find(item => item.key === `${deviceName}|${channelNames[0]}`)?.state, 'free');
  assert.equal(state.state.auditLogs.some(item => item.action === 'reserved_returned_to_application' && item.note === reason), true);
  assert.equal((await operator.restart({ id: 'C03-restart-after-reserved-return' })).outcome, 'success');
  assert.equal((await operator.login({ id: 'C03-relogin-after-reserved-return', username: actor })).outcome, 'success');
  const persisted = snapshot();
  assert.equal(persisted.state.records.find(item => item.id === returnedReservation.id)?.returnReason, reason);
  assert.equal(persisted.state.samples.find(item => item.id === `${reservedRequest}.001`)?.status, 'pending');
  assert.equal(persisted.state.channels.find(item => item.key === `${deviceName}|${channelNames[0]}`)?.state, 'free');
});

journey('C04 assigns three child samples to three independent channels and cleans up visibly', async () => {
  await operator.navigate({ id: 'C04-requests', label: '测试申请表格' });
  assert.equal((await importFile('normal-quantity-3', 'C04-import', { expectText: '单个 Excel 导入完成' })).outcome, 'success');
  const requestNo = data('normal-quantity-3').expected.requestNumbers[0];
  const sampleIds = channelNames.map((_, index) => `${requestNo}.${String(index + 1).padStart(3, '0')}`);
  await operator.navigate({ id: 'C04-apply', label: '开始/预约测试' });
  await operator.fill({ label: '搜索申请单、项目、样品或人员', value: requestNo });
  await operator.click({ name: '预约', exact: true });
  await operator.click({ name: '立即开始', role: 'radio', exact: true });
  const schedule = createCompressedSchedule({ now: new Date(), kind: 'ordinary', offsetMinutes: 1 });
  await operator.fill({ label: '开始时间', value: schedule.startValue });
  await operator.fill({ label: '预计结束时间', value: schedule.endValue });
  for (let index = 0; index < sampleIds.length; index += 1) {
    await driver.page().locator(`[data-legacy-action="open-channel-picker"][data-sample-id="${sampleIds[index]}"]`).click();
    await driver.page().locator(`[data-legacy-action="choose-channel"][data-channel-key="${deviceName}|${channelNames[index]}"]`).click();
  }
  await operator.click({ name: '立即开始', exact: true });
  await driver.page().getByText('测试已开始', { exact: true }).waitFor({ state: 'visible' });
  let state = snapshot();
  const active = state.state.records.filter(item => item.requestNo === requestNo && item.status === 'running');
  assert.equal(active.length, 3);
  assert.deepEqual(new Set(active.map(item => item.sampleId)), new Set(sampleIds));
  assert.deepEqual(new Set(active.map(item => item.channelKey)), new Set(channelNames.map(name => `${deviceName}|${name}`)));

  await operator.navigate({ id: 'C04-dashboard', label: '通道看板' });
  if (await driver.page().getByRole('button', { name: '结束测试', exact: true }).count() === 0) {
    await operator.click({ name: '展开', exact: false });
  }
  for (let remaining = 3; remaining > 0; remaining -= 1) {
    await driver.page().getByRole('button', { name: '结束测试', exact: true }).first().click();
    await driver.page().getByText('通道状态已更新', { exact: true }).waitFor({ state: 'visible' });
  }
  state = snapshot();
  assert.equal(state.state.records.filter(item => item.requestNo === requestNo && item.status === 'completed').length, 3);
  assert.equal(state.state.channels.filter(item => channelNames.includes(item.name) && item.state !== 'free').length, 0);
});

journey('D02 returns an active long-term storage record to the application', async () => {
  const requestNo = data('normal-xls-2').expected.requestNumbers[0];
  const schedule = await startStorage(requestNo, 'D02');
  let state = snapshot();
  const storage = state.state.storageRecords.find(item => item.requestNo === requestNo && item.status === 'storing');
  assert.ok(storage);
  await operator.navigate({ id: 'D02-storage', label: '长期存储样品' });
  await operator.click({ name: '退回申请', exact: true });
  await operator.fill({ label: '退回原因', value: 'D02 虚构长期存储退回补充资料' });
  await driver.page().getByRole('button', { name: /确认.*退回|提交.*退回/ }).first().click();
  await driver.page().locator('#toast').filter({ hasText: '长期存储已退回申请' }).waitFor({ state: 'visible' });
  state = snapshot();
  const returned = state.state.storageRecords.find(item => item.id === storage.id);
  assert.equal(returned?.status, 'returned');
  assert.equal(returned?.returnReason, 'D02 虚构长期存储退回补充资料');
  assert.ok(returned.sampleIds.every(id => state.state.samples.find(item => item.id === id)?.status === 'pending'));
  await writeFile(path.join(runContext.artifactsRoot, 'D02-compressed-schedule.json'), `${JSON.stringify(schedule, null, 2)}\n`, 'utf8');
});

journey('D03 blocks ordinary and storage sample overlap without assigning storage channels', async () => {
  const requestNo = data('normal-xls-2').expected.requestNumbers[1];
  await createOrdinary(requestNo, channelNames[0]);
  const beforeOverlap = snapshot();
  await operator.navigate({ id: 'D03-overlap-apply', label: '开始/预约测试' });
  await operator.fill({ label: '搜索申请单、项目、样品或人员', value: requestNo });
  await operator.click({ name: '预约', exact: true });
  const activeSampleId = `${requestNo}.001`;
  const ordinarySelector = driver.page().locator(`[data-legacy-action="open-channel-picker"][data-sample-id="${activeSampleId}"]`);
  assert.equal(await ordinarySelector.isDisabled(), true, 'active sample ordinary channel selector must be disabled');
  await operator.click({ name: '长期存储', role: 'radio', exact: true });
  assert.equal(await driver.page().locator(`[data-sample-action="storage-sample-toggle"][data-sample-id="${activeSampleId}"]`).count(), 0,
    'active sample must not receive a long-term storage selector');
  await operator.click({ name: '取消', exact: true });
  const candidate = data('normal-csv-4').expected.requestNumbers[0];
  await operator.fill({ label: '搜索申请单、项目、样品或人员', value: candidate });
  await operator.click({ name: '预约', exact: true });
  await operator.click({ name: '立即开始', role: 'radio', exact: true });
  await operator.click({ name: '选择通道', exact: false });
  const occupiedOption = driver.page().locator(`[data-legacy-action="choose-channel"][data-channel-key="${deviceName}|${channelNames[0]}"]`);
  assert.equal(await occupiedOption.count(), 0, 'busy channel must not be offered to another sample');
  await operator.click({ name: '取消', exact: true });
  const afterOverlap = snapshot();
  assert.deepEqual(businessHashes(afterOverlap), businessHashes(beforeOverlap));
  await operator.navigate({ id: 'D03-dashboard', label: '通道看板' });
  if (await driver.page().getByRole('button', { name: '结束测试', exact: true }).count() === 0) {
    await operator.click({ name: '展开', exact: false });
  }
  await operator.click({ name: '结束测试', exact: true });
  assert.equal(snapshot().state.channels.find(item => item.key === `${deviceName}|${channelNames[0]}`)?.state, 'free');

  await startStorage(candidate, 'D03-storage-owner');
  const storageOwner = snapshot();
  assert.equal(storageOwner.state.channels.filter(item => item.state !== 'free' && item.state !== 'fault').length, 0,
    'long-term storage must leave every test channel unchanged');
  await operator.navigate({ id: 'D03-storage-to-ordinary', label: '开始/预约测试' });
  await operator.fill({ label: '搜索申请单、项目、样品或人员', value: candidate });
  await operator.click({ name: '预约', exact: true });
  const storageSampleId = `${candidate}.001`;
  const ordinaryAfterStorage = driver.page().locator(`[data-legacy-action="open-channel-picker"][data-sample-id="${storageSampleId}"]`);
  assert.ok(await ordinaryAfterStorage.count() === 0 || await ordinaryAfterStorage.isDisabled(),
    'a storing sample must not be available for ordinary channel assignment');
  await operator.click({ name: '取消', exact: true });
  assert.deepEqual(businessHashes(snapshot()), businessHashes(storageOwner));
  await operator.navigate({ id: 'D03-storage-finish', label: '长期存储样品' });
  driver.page().once('dialog', dialog => void dialog.accept());
  await operator.click({ name: '结束存储', exact: true });
  await driver.page().getByText('长期存储已结束', { exact: true }).waitFor({ state: 'visible' });
});

journey('E01 exports and reopens PNG or records the native-dialog limitation with recovery', async () => {
  await operator.navigate({ id: 'E01-timeliness', label: '测试及时率' });
  const beforeExport = snapshot();
  const output = path.join(runContext.exportsRoot, 'E01-timeliness.png');
  const result = await operator.perform({
    id: 'E01-export', type: 'exportTimeliness',
    params: { path: output, expectText: '及时率图片已导出', timeoutMs: 5_000 }
  });
  if (result.outcome === 'success') {
    const bytes = await readFile(output);
    assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
    assert.ok((await stat(output)).size > 1000);
  } else {
    await defect('E01', 'PNG_NATIVE_SAVE_DIALOG_ROUTE_BYPASSED', {
      visibleMessage: result.visibleMessage,
      outputCreated: await stat(output).then(() => true, () => false),
      limitation: 'PNG 服务在启动时捕获原生 showSaveDialog；Playwright 启动后的 Electron dialog 路由无法接管',
      recovery: '关闭原生保存框所在窗口并以同一 profile 重启，不使用 computer control'
    });
    assert.equal((await operator.restart({ id: 'E01-restart-after-native-dialog' })).outcome, 'success');
    assert.equal((await operator.login({ id: 'E01-relogin-after-native-dialog', username: actor })).outcome, 'success');
  }
  assert.deepEqual(businessHashes(snapshot()), businessHashes(beforeExport));
});

journey('E02 exports and reopens three manual-specified XLSX workbooks', async () => {
  const beforeExport = snapshot();
  const requestsPath = path.join(runContext.exportsRoot, 'E02-requests.xlsx');
  await operator.navigate({ id: 'E02-requests', label: '测试申请表格' });
  assert.equal((await operator.perform({
    id: 'E02-request-export', type: 'exportRequests',
    params: { path: requestsPath, expectText: '测试申请汇总 XLSX 已导出' }
  })).outcome, 'success');
  await operator.click({ name: '全选/取消全选', exact: true });
  const selectedPath = path.join(runContext.exportsRoot, 'E02-selected.xlsx');
  assert.equal((await operator.perform({
    id: 'E02-selected-export', type: 'exportSelectedRequests',
    params: { path: selectedPath, buttonName: '导出选中', expectText: '已导出' }
  })).outcome, 'success');
  await operator.navigate({ id: 'E02-logs', label: '日志' });
  const logsPath = path.join(runContext.exportsRoot, 'E02-logs.xlsx');
  assert.equal((await operator.perform({
    id: 'E02-log-export', type: 'exportLogs',
    params: { path: logsPath, expectText: '真实日志和使用数据已导出' }
  })).outcome, 'success');
  assert.deepEqual(XLSX.readFile(requestsPath).SheetNames, ['测试申请表格', '测试项目明细']);
  assert.deepEqual(XLSX.readFile(selectedPath).SheetNames, ['选中申请表格']);
  assert.deepEqual(XLSX.readFile(logsPath).SheetNames, ['日志', '使用记录', '测试设备使用表2', '通道当前状态']);
  assert.deepEqual(businessHashes(snapshot()), businessHashes(beforeExport));
});

journey('E03 creates both backup extensions, changes GUI state and restores the original hashes', async () => {
  await operator.navigate({ id: 'E03-dashboard', label: '通道看板' });
  const beforeBackup = snapshot();
  const batterydataPath = path.join(runContext.exportsRoot, 'E03-state.batterydata');
  const jsonPath = path.join(runContext.exportsRoot, 'E03-state.json');
  assert.equal((await operator.perform({ id: 'E03-batterydata', type: 'backup', params: { path: batterydataPath, expectText: '数据备份成功并已校验' } })).outcome, 'success');
  assert.equal((await operator.perform({ id: 'E03-json', type: 'backup', params: { path: jsonPath, expectText: '数据备份成功并已校验' } })).outcome, 'success');
  const packages = await Promise.all([batterydataPath, jsonPath].map(async file => ({
    file,
    sha256: createHash('sha256').update(await readFile(file)).digest('hex'),
    payload: JSON.parse(await readFile(file, 'utf8'))
  })));
  assert.ok(packages.every(item => typeof item.payload.stateSha256 === 'string' && item.payload.stateSha256.length === 64));

  await operator.navigate({ id: 'E03-testers', label: '测试人员' });
  const row = driver.page().locator('#testerTable tr').filter({ hasText: actor }).first();
  await row.getByRole('button', { name: '编辑', exact: true }).click();
  await operator.fill({ label: '部门', value: '虚构恢复前临时部门' });
  await operator.click({ name: '保存测试人员', exact: true });
  assert.notDeepEqual(businessHashes(snapshot()), businessHashes(beforeBackup));

  await operator.navigate({ id: 'E03-restore-page', label: '通道看板' });
  const restore = await operator.perform({
    id: 'E03-restore', type: 'restore',
    params: { path: batterydataPath, buttonName: '恢复数据包', acceptConfirmation: true, expectText: '数据恢复成功' }
  });
  assert.equal(restore.outcome, 'success', restore.visibleMessage);
  const restored = snapshot();
  assert.deepEqual(businessHashes(restored), businessHashes(beforeBackup));
  await writeFile(path.join(runContext.artifactsRoot, 'E03-backup-evidence.json'), `${JSON.stringify({ packages: packages.map(({ file, sha256, payload }) => ({ file, sha256, stateSha256: payload.stateSha256 })), before: businessHashes(beforeBackup), restored: businessHashes(restored) }, null, 2)}\n`, 'utf8');
});
