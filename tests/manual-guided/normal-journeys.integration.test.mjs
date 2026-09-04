import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { createWorkflowElectronDriver } from '../workflows/electron-driver.mjs';
import { buildManualGuidedData } from './data-generator.mjs';
import { createManualOperator } from './operator.mjs';
import { assertManualSafety, assertZeroBusinessWrite, captureManualSnapshot } from './oracle.mjs';
import { createManualGuidedRunContext } from './run-context.mjs';

const projectRoot = path.resolve(import.meta.dirname, '..', '..');
const executablePath = process.env.MANUAL_GUIDED_EXECUTABLE_PATH || path.join(projectRoot, 'dist', 'win-unpacked', '电池测试通道预约与使用看板.exe');
const manualPath = process.env.MANUAL_GUIDED_MANUAL_PATH || 'C:\\Users\\ASUS\\Desktop\\使用说明\\01-软件使用说明.md';
const stylesRoot = process.env.MANUAL_GUIDED_STYLES_ROOT || 'C:\\Users\\ASUS\\Desktop\\使用说明\\文件样式';
const actor = '虚构测试工程师-正常旅程';
const deviceName = '虚构电池测试设备';
const channelName = '01';

let runContext;
let driver;
let operator;
let manifest;
let allPassed = true;

function data(id) {
  const entry = manifest.find(item => item.id === id);
  if (!entry) throw new Error(`missing generated fixture ${id}`);
  return entry;
}

function snapshot() {
  const value = captureManualSnapshot({ dataRoot: runContext.dataRoot });
  assertManualSafety(value);
  return value;
}

function journey(name, fn) {
  test(name, { timeout: 180_000 }, async () => {
    try {
      await fn();
    } catch (error) {
      allPassed = false;
      throw error;
    }
  });
}

before(async () => {
  runContext = await createManualGuidedRunContext({
    projectRoot,
    mode: 'quick',
    executablePath,
    manualPath,
    stylesRoot
  });
  manifest = await buildManualGuidedData({ runContext, clock: () => new Date('2026-09-02T09:00:00-07:00') });
  driver = createWorkflowElectronDriver({
    projectRoot,
    dataRoot: runContext.dataRoot,
    profileRoot: runContext.profileRoot,
    reportNamespace: 'manual-guided',
    viewport: '1366x768',
    timeoutMs: 30_000,
    packaged: true,
    executablePath
  });
  operator = createManualOperator({ driver, actor, timeoutMs: 20_000 });
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
  assert.equal(protection?.ok, true, 'EXE, manual and ten style files must remain unchanged');
});

journey('A01 first-use login follows the manual and reaches required visible pages', async () => {
  const login = await operator.login({ id: 'A01-login', username: actor });
  assert.equal(login.outcome, 'success');
  for (const label of ['设备与通道', '测试人员', '测试申请表格']) {
    const result = await operator.navigate({ id: `A01-${label}`, label });
    assert.equal(result.outcome, 'success');
    assert.equal(result.visiblePage, label);
  }
  assert.equal(snapshot().summary.requests, 0);
});

journey('B01 imports the manual-derived vertical XLSX through the GUI', async () => {
  const fixture = data('normal-vertical-1');
  const beforeState = snapshot();
  const result = await operator.perform({
    id: 'B01-import-vertical',
    type: 'importFile',
    params: { path: fixture.path, expectText: '单个 Excel 导入完成' }
  });
  assert.equal(result.outcome, 'success');
  const afterState = snapshot();
  const requestNo = fixture.expected.requestNumbers[0];
  assert.equal(afterState.summary.requests - beforeState.summary.requests, 1);
  assert.ok(afterState.state.requests.some(item => String(item.id ?? item.requestNo) === requestNo));
  assert.ok(afterState.state.samples.some(item => item.id === `${requestNo}.001`));
  assert.ok(afterState.state.requestSourceRows.some(item =>
    [item.id, item.requestNo, item.申请单号, item.委托单号].map(String).includes(requestNo)
  ));
});

journey('C01 completes an immediate ordinary test and releases its channel', async () => {
  await operator.navigate({ id: 'C01-devices', label: '设备与通道' });
  await operator.click({ name: '新建设备', exact: false });
  await operator.fill({ label: '设备名称', value: deviceName });
  await operator.fill({ label: '设备厂家', value: '虚构仪器厂家' });
  await operator.fill({ label: '最大电压', value: '5' });
  await operator.fill({ label: '最大电流', value: '100' });
  await operator.click({ name: '保存设备', exact: true });
  await driver.page().getByText('设备参数已保存', { exact: true }).waitFor({ state: 'visible' });

  await operator.click({ name: '新增通道', exact: false });
  await operator.choose({ label: '所属设备', value: deviceName });
  await operator.fill({ label: '通道号', value: channelName });
  await operator.fill({ label: '最大电压', value: '5' });
  await operator.fill({ label: '最大电流', value: '100' });
  await operator.click({ name: '保存通道', exact: true });
  await driver.page().getByText('通道参数已保存', { exact: true }).waitFor({ state: 'visible' });

  await operator.navigate({ id: 'C01-testers', label: '测试人员' });
  await operator.click({ name: '新增测试人员', exact: false });
  await operator.fill({ label: '姓名', value: actor });
  await operator.fill({ label: '部门', value: '虚构电池测试部' });
  await operator.click({ name: '保存测试人员', exact: true });
  await driver.page().getByText('测试人员已保存', { exact: true }).waitFor({ state: 'visible' });

  const requestNo = data('normal-vertical-1').expected.requestNumbers[0];
  await operator.navigate({ id: 'C01-apply', label: '开始/预约测试' });
  await driver.page().getByRole('heading', { name: '选择测试申请', exact: true }).waitFor({ state: 'visible' });
  await operator.fill({ label: '搜索申请单、项目、样品或人员', value: requestNo });
  await operator.click({ name: '预约', exact: true });
  await operator.click({ name: '立即开始', role: 'radio', exact: true });
  await operator.click({ name: '选择通道', exact: false });
  await operator.click({ name: `${deviceName} ${channelName}`, exact: false });
  await operator.click({ name: '立即开始', exact: true });
  await driver.page().getByText('测试已开始', { exact: true }).waitFor({ state: 'visible' });

  const running = snapshot();
  const active = running.state.records.find(item => item.status === 'running' && String(item.requestNo ?? item.no) === requestNo);
  assert.ok(active, 'ordinary record must be running after visible submission');
  assert.equal(running.state.channels.find(item => item.key === `${deviceName}|${channelName}`)?.state, 'busy');
  assert.equal(running.state.samples.find(item => item.id === `${requestNo}.001`)?.status, 'running');

  await operator.navigate({ id: 'C01-running', label: '正在测试样品' });
  await driver.page().getByText(`${requestNo}.001`, { exact: true }).waitFor({ state: 'visible' });
  await operator.navigate({ id: 'C01-dashboard', label: '通道看板' });
  await operator.click({ name: '展开', exact: false });
  await operator.click({ name: '结束测试', exact: true });
  await driver.page().getByText('通道状态已更新', { exact: true }).waitFor({ state: 'visible' });

  const completed = snapshot();
  assert.equal(completed.state.records.find(item => item.id === active.id)?.status, 'completed');
  assert.equal(completed.state.channels.find(item => item.key === `${deviceName}|${channelName}`)?.state, 'free');
  assert.equal(completed.state.samples.find(item => item.id === `${requestNo}.001`)?.status, 'completed');
});

journey('D01 starts and finishes long-term storage without occupying a test channel', async () => {
  await operator.navigate({ id: 'D01-requests', label: '测试申请表格' });
  const fixture = data('normal-horizontal-3');
  await operator.perform({
    id: 'D01-import',
    type: 'importFile',
    params: { path: fixture.path, expectText: '单个 Excel 导入完成' }
  });
  const requestNo = fixture.expected.requestNumbers[0];
  await operator.navigate({ id: 'D01-apply', label: '开始/预约测试' });
  await operator.fill({ label: '搜索申请单、项目、样品或人员', value: requestNo });
  await operator.click({ name: '预约', exact: true });
  await operator.click({ name: '长期存储', role: 'radio', exact: true });
  await operator.click({ name: '选择长期存储', exact: true });
  await operator.fill({ label: '预计结束时间', value: '2026-09-02T17:30' });
  await operator.click({ name: '开始长期存储', exact: true });
  await driver.page().getByText('长期存储已开始', { exact: true }).waitFor({ state: 'visible' });

  const active = snapshot();
  const storage = active.state.storageRecords.find(item => item.status === 'storing' && item.requestNo === requestNo);
  assert.ok(storage, 'long-term storage must enter an active visible stage');
  const occupiedChannels = active.state.channels.filter(item => item.state !== 'free' && item.state !== 'fault');
  await driver.screenshot('D01-storage-active-without-channel');
  assert.equal(occupiedChannels.length, 0, 'long-term storage must not occupy a test channel');

  await operator.navigate({ id: 'D01-storage', label: '长期存储样品' });
  driver.page().once('dialog', dialog => void dialog.accept());
  await operator.click({ name: '结束存储', exact: true });
  await driver.page().getByText('长期存储已结束', { exact: true }).waitFor({ state: 'visible' });
  const finished = snapshot();
  assert.equal(finished.state.storageRecords.find(item => item.id === storage.id)?.status, 'completed');
  assert.equal(finished.state.channels.filter(item => item.state !== 'free' && item.state !== 'fault').length, 0);
});

journey('E04 cancels and retries file routes, then rejects a tampered GUI backup', async () => {
  await operator.navigate({ id: 'E04-requests', label: '测试申请表格' });
  const beforeCancel = snapshot();
  const cancelled = await operator.cancelDialog({ id: 'E04-cancel-import', params: { buttonName: '导入单个 Excel' } });
  assert.equal(cancelled.outcome, 'cancelled');
  assertZeroBusinessWrite(beforeCancel, snapshot());

  const csv = data('normal-csv-4');
  const imported = await operator.perform({
    id: 'E04-retry-import',
    type: 'importFile',
    params: { path: csv.path, expectText: '单个 Excel 导入完成' }
  });
  assert.equal(imported.outcome, 'success');
  for (const requestNo of csv.expected.requestNumbers) {
    assert.ok(snapshot().state.requests.some(item => String(item.id ?? item.requestNo) === requestNo));
  }

  await operator.navigate({ id: 'E04-dashboard', label: '通道看板' });
  const cancelledBackup = await operator.cancelDialog({ id: 'E04-cancel-backup', params: { buttonName: '备份数据' } });
  assert.equal(cancelledBackup.outcome, 'cancelled');
  await driver.page().getByText('已取消备份', { exact: true }).waitFor({ state: 'visible' });

  const backupPath = path.join(runContext.exportsRoot, 'E04-valid.batterydata');
  const backup = await operator.perform({
    id: 'E04-backup',
    type: 'backup',
    params: { path: backupPath, expectText: '数据备份成功并已校验' }
  });
  assert.equal(backup.outcome, 'success');
  const payload = JSON.parse(await readFile(backupPath, 'utf8'));
  payload.state.username = '篡改但未重新计算哈希';
  const tamperedPath = path.join(runContext.exportsRoot, 'E04-tampered.batterydata');
  await writeFile(tamperedPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');

  const beforeRestore = snapshot();
  const rejected = await operator.perform({
    id: 'E04-tampered-restore',
    type: 'restore',
    params: {
      path: tamperedPath,
      buttonName: '恢复数据包',
      acceptConfirmation: true,
      outcome: 'rejected',
      expectText: '校验'
    }
  });
  assert.equal(rejected.outcome, 'rejected');
  assertZeroBusinessWrite(beforeRestore, snapshot(), { allowedAuditActions: ['恢复数据备份'] });
});
