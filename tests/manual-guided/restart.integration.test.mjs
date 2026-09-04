import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { after, before, test } from 'node:test';
import { promisify } from 'node:util';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';

import { createWorkflowElectronDriver } from '../workflows/electron-driver.mjs';
import { buildManualGuidedData } from './data-generator.mjs';
import { createManualOperator } from './operator.mjs';
import { assertManualSafety, captureManualSnapshot } from './oracle.mjs';
import { createManualGuidedRunContext } from './run-context.mjs';
import { createCompressedSchedule } from './time-policy.mjs';

const execFileAsync = promisify(execFile);
const projectRoot = path.resolve(import.meta.dirname, '..', '..');
const executablePath = process.env.MANUAL_GUIDED_EXECUTABLE_PATH || path.join(projectRoot, 'dist', 'win-unpacked', '电池测试通道预约与使用看板.exe');
const manualPath = process.env.MANUAL_GUIDED_MANUAL_PATH || 'C:\\Users\\ASUS\\Desktop\\使用说明\\01-软件使用说明.md';
const stylesRoot = process.env.MANUAL_GUIDED_STYLES_ROOT || 'C:\\Users\\ASUS\\Desktop\\使用说明\\文件样式';
const actor = '虚构测试工程师-重启恢复';
const deviceName = '虚构重启测试设备';
const channelName = 'G01';

let runContext;
let driver;
let operator;
let manifest;
let requestNumbers;
let allPassed = true;
const checkpoints = [];

function fixture(id) {
  const value = manifest.find(item => item.id === id);
  if (!value) throw new Error(`missing generated fixture ${id}`);
  return value;
}

function snapshot() {
  const value = captureManualSnapshot({ dataRoot: runContext.dataRoot });
  assertManualSafety(value);
  return value;
}

function businessHashes(value) {
  return Object.fromEntries(Object.entries(value.collectionHashes).filter(([name]) => name !== 'auditLogs'));
}

async function checkpoint(stage, rediscoverPage) {
  const beforeRestart = snapshot();
  assert.equal((await operator.restart({ id: `G01-${stage}-restart` })).outcome, 'success');
  assert.equal((await operator.login({ id: `G01-${stage}-login`, username: actor })).outcome, 'success');
  const afterRestart = snapshot();
  assert.deepEqual(businessHashes(afterRestart), businessHashes(beforeRestart));
  const rediscovered = await operator.navigate({ id: `G01-${stage}-rediscover`, label: rediscoverPage });
  assert.equal(rediscovered.outcome, 'success');
  checkpoints.push(Object.freeze({
    stage,
    rediscoverPage,
    beforeHash: beforeRestart.hash,
    afterHash: afterRestart.hash,
    businessHashes: businessHashes(afterRestart),
    screenshotPath: rediscovered.screenshotPath
  }));
  return afterRestart;
}

async function createOrdinary(requestNo, { reserve = false } = {}) {
  const schedule = createCompressedSchedule({ now: new Date(), kind: 'ordinary', offsetMinutes: 1 });
  await operator.navigate({ id: `G01-${requestNo}-apply`, label: '开始/预约测试' });
  await operator.fill({ label: '搜索申请单、项目、样品或人员', value: requestNo });
  await operator.click({ name: '预约', exact: true });
  await operator.click({ name: reserve ? '提交预约' : '立即开始', role: 'radio', exact: true });
  await operator.fill({ label: '开始时间', value: schedule.startValue });
  await operator.fill({ label: '预计结束时间', value: schedule.endValue });
  await operator.click({ name: '选择通道', exact: false });
  await operator.click({ name: `${deviceName} ${channelName}`, exact: false });
  await operator.click({ name: reserve ? '提交预约' : '立即开始', exact: true });
  return schedule;
}

async function returnRunning(requestNo) {
  await operator.navigate({ id: `G01-${requestNo}-running`, label: '正在测试样品' });
  await driver.page().getByText(`${requestNo}.001`, { exact: true }).waitFor({ state: 'visible' });
  await operator.click({ name: '退回申请', exact: true });
  await operator.fill({ label: '退回原因', value: 'G01 虚构重启后的退回验证' });
  const buttons = driver.page().getByRole('button');
  let confirmation = null;
  for (let index = 0; index < await buttons.count(); index += 1) {
    const button = buttons.nth(index);
    const name = String(await button.textContent() || '').trim();
    if (await button.isVisible().catch(() => false) && /确认.*退回|提交.*退回/.test(name)) {
      confirmation = name;
      break;
    }
  }
  assert.ok(confirmation);
  await operator.click({ name: confirmation, exact: true });
}

function integration(name, fn, timeout = 240_000) {
  test(name, { timeout }, async () => {
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
    projectRoot, mode: 'full', executablePath, manualPath, stylesRoot
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
  assert.equal((await operator.login({ id: 'G-setup-login', username: actor })).outcome, 'success');

  await operator.navigate({ id: 'G-setup-devices', label: '设备与通道' });
  await operator.click({ name: '新建设备', exact: false });
  await operator.fill({ label: '设备名称', value: deviceName });
  await operator.fill({ label: '设备厂家', value: '虚构重启仪器厂家' });
  await operator.fill({ label: '最大电压', value: '5' });
  await operator.fill({ label: '最大电流', value: '100' });
  await operator.click({ name: '保存设备', exact: true });
  await operator.click({ name: '新增通道', exact: false });
  await operator.choose({ label: '所属设备', value: deviceName });
  await operator.fill({ label: '通道号', value: channelName });
  await operator.fill({ label: '最大电压', value: '5' });
  await operator.fill({ label: '最大电流', value: '100' });
  await operator.click({ name: '保存通道', exact: true });

  await operator.navigate({ id: 'G-setup-testers', label: '测试人员' });
  await operator.click({ name: '新增测试人员', exact: false });
  await operator.fill({ label: '姓名', value: actor });
  await operator.fill({ label: '部门', value: '虚构电池测试部' });
  await operator.click({ name: '保存测试人员', exact: true });
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

integration('G01 preserves every compressed GUI lifecycle checkpoint across restart', async () => {
  const input = fixture('normal-csv-4');
  await operator.navigate({ id: 'G01-requests', label: '测试申请表格' });
  const imported = await operator.perform({
    id: 'G01-import', type: 'importFile',
    params: { path: input.path, expectText: '单个 Excel 导入完成' }
  });
  assert.equal(imported.outcome, 'success');
  requestNumbers = input.expected.requestNumbers;
  await checkpoint('after-import', '测试申请表格');

  const reservationSchedule = await createOrdinary(requestNumbers[0], { reserve: true });
  assert.equal(snapshot().state.records.filter(item => item.requestNo === requestNumbers[0] && item.status === 'reserved').length, 1);
  await checkpoint('after-reservation', '通道看板');
  await operator.click({ name: '展开', exact: false });
  await operator.click({ name: '开始测试', exact: false });
  assert.equal(snapshot().state.records.filter(item => item.requestNo === requestNumbers[0] && item.status === 'running').length, 1);
  await checkpoint('after-ordinary-start', '通道看板');
  await operator.click({ name: '展开', exact: false });
  await operator.click({ name: '结束测试', exact: true });
  assert.equal(snapshot().state.records.find(item => item.requestNo === requestNumbers[0])?.status, 'completed');
  await checkpoint('after-ordinary-finish', '通道看板');

  const returnSchedule = await createOrdinary(requestNumbers[1]);
  await returnRunning(requestNumbers[1]);
  const returned = snapshot().state.records.find(item => item.requestNo === requestNumbers[1]);
  assert.ok(returned && !['running', 'reserved'].includes(returned.status));
  await checkpoint('after-return', '正在测试样品');

  const storageSchedule = createCompressedSchedule({ now: new Date(), kind: 'storage', offsetMinutes: 1 });
  await operator.navigate({ id: 'G01-storage-apply', label: '开始/预约测试' });
  await operator.fill({ label: '搜索申请单、项目、样品或人员', value: requestNumbers[2] });
  await operator.click({ name: '预约', exact: true });
  await operator.click({ name: '长期存储', role: 'radio', exact: true });
  await operator.click({ name: '选择长期存储', exact: true });
  await operator.fill({ label: '预计结束时间', value: storageSchedule.endValue });
  await operator.click({ name: '开始长期存储', exact: true });
  assert.equal(snapshot().state.storageRecords.filter(item => item.requestNo === requestNumbers[2] && item.status === 'storing').length, 1);
  await checkpoint('after-storage-start', '长期存储样品');
  driver.page().once('dialog', dialog => void dialog.accept());
  await operator.click({ name: '结束存储', exact: true });
  assert.equal(snapshot().state.storageRecords.find(item => item.requestNo === requestNumbers[2])?.status, 'completed');
  await checkpoint('after-storage-finish', '长期存储样品');

  await operator.navigate({ id: 'G01-backup-page', label: '通道看板' });
  const backupPath = path.join(runContext.exportsRoot, 'G01-checkpoint.batterydata');
  assert.equal((await operator.perform({
    id: 'G01-backup', type: 'backup',
    params: { path: backupPath, expectText: '数据备份成功并已校验' }
  })).outcome, 'success');
  await checkpoint('after-backup', '通道看板');
  assert.equal((await operator.perform({
    id: 'G01-restore', type: 'restore',
    params: { path: backupPath, buttonName: '恢复数据包', acceptConfirmation: true, expectText: '数据恢复成功' }
  })).outcome, 'success');
  await checkpoint('after-restore', '日志');

  await writeFile(path.join(runContext.artifactsRoot, 'G01-restart-checkpoints.json'), `${JSON.stringify({
    scenarioId: 'G01',
    compressed: true,
    schedules: { reservationSchedule, returnSchedule, storageSchedule },
    checkpoints
  }, null, 2)}\n`, 'utf8');
});

integration('G02 second launch with the same profile leaves one usable primary window and zero business writes', async () => {
  const beforeSecond = snapshot();
  let secondExit = 'exited';
  try {
    await execFileAsync(executablePath, [`--user-data-dir=${runContext.profileRoot}`, '--disable-gpu'], {
      cwd: projectRoot,
      env: { ...process.env },
      timeout: 10_000,
      windowsHide: true
    });
  } catch (error) {
    if (error?.killed || error?.signal) secondExit = `terminated:${error.signal || 'timeout'}`;
    else throw error;
  }
  await driver.page().getByRole('heading', { name: /测试通道看板|日志/ }).first().waitFor({ state: 'visible' });
  const afterSecond = snapshot();
  assert.deepEqual(businessHashes(afterSecond), businessHashes(beforeSecond));
  const screenshotPath = await driver.screenshot('G02-single-instance');
  await writeFile(path.join(runContext.artifactsRoot, 'G02-single-instance.json'), `${JSON.stringify({
    scenarioId: 'G02', secondExit, businessHashes: businessHashes(afterSecond), primaryWindowUsable: true, screenshotPath
  }, null, 2)}\n`, 'utf8');
});

integration('G03 visible pages and independently reopened SQLite remain consistent', async () => {
  const beforePages = snapshot();
  const pages = ['通道看板', '开始/预约测试', '正在测试样品', '长期存储样品', '测试申请表格', '日志', '测试人员', '设备与通道'];
  const visible = [];
  for (const label of pages) {
    const result = await operator.navigate({ id: `G03-${label}`, label });
    assert.equal(result.outcome, 'success');
    visible.push({ label, screenshotPath: result.screenshotPath });
  }
  const afterPages = snapshot();
  assert.deepEqual(businessHashes(afterPages), businessHashes(beforePages));
  assertManualSafety(afterPages);
  await writeFile(path.join(runContext.artifactsRoot, 'G03-cross-page-sqlite.json'), `${JSON.stringify({
    scenarioId: 'G03', visible, integrity: afterPages.integrity, summary: afterPages.summary,
    businessHashes: businessHashes(afterPages)
  }, null, 2)}\n`, 'utf8');
});
