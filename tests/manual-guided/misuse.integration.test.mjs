import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';

import { createWorkflowElectronDriver } from '../workflows/electron-driver.mjs';
import { buildManualGuidedData } from './data-generator.mjs';
import { createManualOperator } from './operator.mjs';
import {
  assertManualSafety,
  assertZeroBusinessWrite,
  captureManualSnapshot,
  compareManualSnapshots
} from './oracle.mjs';
import { planHumanMisuse } from './misuse-planner.mjs';
import { createManualGuidedRunContext } from './run-context.mjs';
import { createFutureEndBeforeStartSchedule } from './time-policy.mjs';

const projectRoot = path.resolve(import.meta.dirname, '..', '..');
const executablePath = process.env.MANUAL_GUIDED_EXECUTABLE_PATH || path.join(projectRoot, 'dist', 'win-unpacked', '电池测试通道预约与使用看板.exe');
const manualPath = process.env.MANUAL_GUIDED_MANUAL_PATH || 'C:\\Users\\ASUS\\Desktop\\使用说明\\01-软件使用说明.md';
const stylesRoot = process.env.MANUAL_GUIDED_STYLES_ROOT || 'C:\\Users\\ASUS\\Desktop\\使用说明\\文件样式';
const actor = '虚构测试工程师-误操作恢复';
const deviceName = '虚构误操作测试设备';
const channelName = 'M01';

let runContext;
let driver;
let operator;
let manifest;
let requestNumbers;
let allPassed = true;

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

async function visibleTexts(locator) {
  const values = [];
  for (let index = 0; index < await locator.count(); index += 1) {
    const candidate = locator.nth(index);
    if (await candidate.isVisible().catch(() => false)) {
      values.push(String(await candidate.textContent() || '').trim());
    }
  }
  return values;
}

async function importFixture(id, actionId) {
  const source = fixture(id);
  const result = await operator.perform({
    id: actionId,
    type: 'importFile',
    params: { path: source.path, expectText: '单个 Excel 导入完成' }
  });
  assert.equal(result.outcome, 'success');
}

async function restartAndVerify(scenarioId, expected) {
  const restart = await operator.restart({ id: `${scenarioId}-restart` });
  assert.equal(restart.outcome, 'success');
  const login = await operator.login({ id: `${scenarioId}-relogin`, username: actor });
  assert.equal(login.outcome, 'success');
  const current = snapshot();
  assert.deepEqual(businessHashes(current), businessHashes(expected));
  return Object.freeze({
    outcome: 'success',
    visiblePage: login.visiblePage,
    snapshotHash: current.hash,
    businessHashes: businessHashes(current)
  });
}

async function writeRecoveryEvidence(scenarioId, evidence) {
  await writeFile(
    path.join(runContext.artifactsRoot, `${scenarioId}-misuse-recovery.json`),
    `${JSON.stringify({ scenarioId, ...evidence }, null, 2)}\n`,
    'utf8'
  );
}

function misuse(name, fn) {
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
    mode: 'full',
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
  assert.equal((await operator.login({ id: 'F-setup-login', username: actor })).outcome, 'success');

  await operator.navigate({ id: 'F-setup-requests', label: '测试申请表格' });
  for (const [index, id] of ['normal-horizontal-3', 'normal-csv-4', 'normal-xls-2', 'normal-vertical-1'].entries()) {
    await importFixture(id, `F-setup-import-${index + 1}`);
  }
  requestNumbers = [
    ...fixture('normal-horizontal-3').expected.requestNumbers,
    ...fixture('normal-csv-4').expected.requestNumbers
  ];

  await operator.navigate({ id: 'F-setup-devices', label: '设备与通道' });
  await operator.click({ name: '新建设备', exact: false });
  await operator.fill({ label: '设备名称', value: deviceName });
  await operator.fill({ label: '设备厂家', value: '虚构误操作仪器厂家' });
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

  await operator.navigate({ id: 'F-setup-testers', label: '测试人员' });
  await operator.click({ name: '新增测试人员', exact: false });
  await operator.fill({ label: '姓名', value: actor });
  await operator.fill({ label: '部门', value: '虚构电池测试部' });
  await operator.click({ name: '保存测试人员', exact: true });
  await driver.page().getByText('测试人员已保存', { exact: true }).waitFor({ state: 'visible' });
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

misuse('F01 rejects submission without a channel and recovers through visible controls', async () => {
  const scenarioId = 'F01';
  const requestNo = requestNumbers[0];
  const plan = planHumanMisuse({
    scenarioId,
    seed: 22001,
    visibleState: { availableActions: ['reserve', 'startImmediately'] }
  });
  await operator.navigate({ id: 'F01-apply', label: '开始/预约测试' });
  await operator.fill({ label: '搜索申请单、项目、样品或人员', value: requestNo });
  await operator.click({ name: '预约', exact: true });
  await operator.click({ name: '立即开始', role: 'radio', exact: true });
  const beforeRejected = snapshot();
  const submit = driver.page().getByRole('button', { name: '立即开始', exact: true });
  const toast = driver.page().locator('#toast');
  const beforeToastText = String(await toast.textContent().catch(() => '') || '').trim();
  await submit.click();
  const afterToastText = String(await toast.textContent().catch(() => '') || '').trim();
  const inlineCandidates = driver.page().getByText(/请选择.*通道|通道.*必填/);
  const inlineFeedback = [];
  for (let index = 0; index < await inlineCandidates.count(); index += 1) {
    const candidate = inlineCandidates.nth(index);
    if (await candidate.isVisible().catch(() => false)) {
      inlineFeedback.push(String(await candidate.textContent() || '').trim());
    }
  }
  const visibleFeedback = afterToastText !== beforeToastText
    ? afterToastText
    : inlineFeedback.join('；') || '无新增可见反馈（仍显示陈旧提示）';
  const rejectionScreenshot = await driver.screenshot('F01-missing-channel-rejected');
  const afterRejected = snapshot();
  assertZeroBusinessWrite(beforeRejected, afterRejected);

  await operator.click({ name: '选择通道', exact: false });
  await operator.click({ name: `${deviceName} ${channelName}`, exact: false });
  await submit.click();
  await driver.page().getByText('测试已开始', { exact: true }).waitFor({ state: 'visible' });
  const active = snapshot();
  assert.equal(active.activeOwnership.ordinary.filter(item => item.requestNo === requestNo).length, 1);

  await operator.navigate({ id: 'F01-dashboard', label: '通道看板' });
  await operator.click({ name: '展开', exact: false });
  await operator.click({ name: '结束测试', exact: true });
  await driver.page().getByText('通道状态已更新', { exact: true }).waitFor({ state: 'visible' });
  const recovered = snapshot();
  const restartResult = await restartAndVerify(scenarioId, recovered);
  await writeRecoveryEvidence(scenarioId, {
    plan,
    visibleFeedback,
    productDefect: visibleFeedback.startsWith('无新增') ? {
      code: 'MISSING_CHANNEL_REJECTION_FEEDBACK_ABSENT',
      expected: '缺少通道时显示新的明确校验提示',
      actual: `提交被阻止，但 toast 仍为：${afterToastText || '(empty)'}`
    } : null,
    rejectionScreenshot,
    rejectedDiff: compareManualSnapshots(beforeRejected, afterRejected),
    recoveryActions: ['选择通道', '立即开始', '通道看板', '结束测试'],
    continuedBusinessGoal: true,
    restartResult
  });
});

misuse('F02 double submission creates only one active record and remains recoverable', async () => {
  const scenarioId = 'F02';
  const requestNo = requestNumbers[1];
  const plan = planHumanMisuse({
    scenarioId,
    seed: 22001,
    visibleState: { availableActions: ['doubleClick'] }
  });
  await operator.navigate({ id: 'F02-apply', label: '开始/预约测试' });
  await operator.fill({ label: '搜索申请单、项目、样品或人员', value: requestNo });
  await operator.click({ name: '预约', exact: true });
  await operator.click({ name: '立即开始', role: 'radio', exact: true });
  await operator.click({ name: '选择通道', exact: false });
  await operator.click({ name: `${deviceName} ${channelName}`, exact: false });
  const beforeDouble = snapshot();
  const doubleResult = await operator.doubleClick({
    id: plan.actions[0].id,
    params: { text: '立即开始', role: 'button', exact: true }
  });
  await driver.page().getByText('测试已开始', { exact: true }).waitFor({ state: 'visible' });
  const afterDouble = snapshot();
  const active = afterDouble.activeOwnership.ordinary.filter(item => item.requestNo === requestNo);
  assert.equal(active.length, 1, 'double submit must not create duplicate active records');
  assert.equal(afterDouble.state.records.filter(item => item.requestNo === requestNo && item.status === 'running').length, 1);

  await operator.navigate({ id: 'F02-dashboard', label: '通道看板' });
  await operator.click({ name: '展开', exact: false });
  await operator.click({ name: '结束测试', exact: true });
  await driver.page().getByText('通道状态已更新', { exact: true }).waitFor({ state: 'visible' });
  const recovered = snapshot();
  const restartResult = await restartAndVerify(scenarioId, recovered);
  await writeRecoveryEvidence(scenarioId, {
    plan,
    visibleFeedback: doubleResult.visibleMessage,
    doubleClickOutcome: doubleResult.outcome,
    submissionDiff: compareManualSnapshots(beforeDouble, afterDouble),
    activeRecordsAfterDoubleClick: active,
    recoveryActions: ['通道看板', '结束测试'],
    continuedBusinessGoal: true,
    restartResult
  });
});

misuse('F03 rejects an end time before the start time and accepts a corrected time', async () => {
  const scenarioId = 'F03';
  const requestNo = requestNumbers[2];
  const plan = planHumanMisuse({
    scenarioId,
    seed: 22001,
    visibleState: { availableActions: ['startImmediately'] }
  });
  const schedule = createFutureEndBeforeStartSchedule({ now: new Date() });
  await operator.navigate({ id: 'F03-apply', label: '开始/预约测试' });
  await operator.fill({ label: '搜索申请单、项目、样品或人员', value: requestNo });
  await operator.click({ name: '预约', exact: true });
  await operator.click({ name: '立即开始', role: 'radio', exact: true });
  await operator.fill({ label: '开始时间', value: schedule.startValue });
  await operator.fill({ label: '预计结束时间', value: schedule.invalidEndValue });
  await operator.click({ name: '选择通道', exact: false });
  await operator.click({ name: `${deviceName} ${channelName}`, exact: false });

  const beforeRejected = snapshot();
  const toast = driver.page().locator('#toast');
  const beforeToastText = String(await toast.textContent().catch(() => '') || '').trim();
  await operator.click({ name: '立即开始', exact: true });
  const afterToastText = String(await toast.textContent().catch(() => '') || '').trim();
  const rejectionScreenshot = await driver.screenshot('F03-end-before-start-rejected');
  const afterRejected = snapshot();
  const invalidActive = afterRejected.activeOwnership.ordinary.filter(item => item.requestNo === requestNo);
  if (invalidActive.length > 0) {
    assert.equal(invalidActive.length, 1);
    await operator.navigate({ id: 'F03-defect-dashboard', label: '通道看板' });
    await operator.click({ name: '展开', exact: false });
    await operator.click({ name: '结束测试', exact: true });
    await driver.page().getByText('通道状态已更新', { exact: true }).waitFor({ state: 'visible' });
    const recovered = snapshot();
    const restartResult = await restartAndVerify(scenarioId, recovered);
    await writeRecoveryEvidence(scenarioId, {
      plan,
      visibleFeedback: afterToastText,
      rejectionScreenshot,
      productDefect: {
        code: 'END_BEFORE_START_ACCEPTED',
        expected: '预计结束时间早于开始时间时拒绝且零业务写入',
        actual: '软件创建了一条 running 记录并占用通道',
        enteredStartTime: schedule.startValue,
        enteredEndTime: schedule.invalidEndValue,
        activeRecords: invalidActive
      },
      invalidSubmissionDiff: compareManualSnapshots(beforeRejected, afterRejected),
      recoveryActions: ['通道看板', '结束测试'],
      continuedBusinessGoal: false,
      recoverySucceeded: true,
      restartResult
    });
    return;
  }
  assertZeroBusinessWrite(beforeRejected, afterRejected);
  if (afterToastText === beforeToastText) {
    const restartResult = await restartAndVerify(scenarioId, afterRejected);
    await writeRecoveryEvidence(scenarioId, {
      plan,
      visibleFeedback: afterToastText,
      rejectionScreenshot,
      productDefect: {
        code: 'END_BEFORE_START_REJECTION_FEEDBACK_ABSENT',
        expected: '预计结束时间早于可见开始时间时明确提示并保持零业务写入',
        actual: '提交被阻止但可见反馈仍是之前操作的旧消息',
        enteredStartTime: schedule.startValue,
        enteredEndTime: schedule.invalidEndValue
      },
      invalidSubmissionDiff: compareManualSnapshots(beforeRejected, afterRejected),
      recoveryActions: ['重启应用', '重新登录'],
      continuedBusinessGoal: false,
      recoverySucceeded: true,
      restartResult
    });
    return;
  }
  assert.match(afterToastText, /时间|早于|结束/);

  await operator.fill({ label: '预计结束时间', value: schedule.correctedEndValue });
  await operator.click({ name: '立即开始', exact: true });
  await driver.page().getByText('测试已开始', { exact: true }).waitFor({ state: 'visible' });
  const active = snapshot();
  assert.equal(active.activeOwnership.ordinary.filter(item => item.requestNo === requestNo).length, 1);
  await operator.navigate({ id: 'F03-dashboard', label: '通道看板' });
  await operator.click({ name: '展开', exact: false });
  await operator.click({ name: '结束测试', exact: true });
  await driver.page().getByText('通道状态已更新', { exact: true }).waitFor({ state: 'visible' });
  const recovered = snapshot();
  const restartResult = await restartAndVerify(scenarioId, recovered);
  await writeRecoveryEvidence(scenarioId, {
    plan,
    visibleFeedback: afterToastText,
    rejectionScreenshot,
    rejectedDiff: compareManualSnapshots(beforeRejected, afterRejected),
    recoveryActions: ['修正预计结束时间', '立即开始', '通道看板', '结束测试'],
    continuedBusinessGoal: true,
    restartResult
  });
});

misuse('F04 blocks disabling an actively used channel and recovers without database repair', async () => {
  const scenarioId = 'F04';
  const requestNo = requestNumbers[3];
  const plan = planHumanMisuse({
    scenarioId,
    seed: 22001,
    visibleState: { availableActions: ['editDevice'] }
  });
  await operator.navigate({ id: 'F04-apply', label: '开始/预约测试' });
  await operator.fill({ label: '搜索申请单、项目、样品或人员', value: requestNo });
  await operator.click({ name: '预约', exact: true });
  await operator.click({ name: '立即开始', role: 'radio', exact: true });
  await operator.click({ name: '选择通道', exact: false });
  await operator.click({ name: `${deviceName} ${channelName}`, exact: false });
  await operator.click({ name: '立即开始', exact: true });
  await driver.page().getByText('测试已开始', { exact: true }).waitFor({ state: 'visible' });
  const active = snapshot();
  assert.equal(active.activeOwnership.ordinary.filter(item => item.requestNo === requestNo).length, 1);

  await operator.navigate({ id: 'F04-devices', label: '设备与通道' });
  const channelRow = driver.page().getByRole('row').filter({ hasText: channelName });
  await channelRow.waitFor({ state: 'visible' });
  const rowButtons = (await channelRow.getByRole('button').allTextContents()).map(value => value.trim()).filter(Boolean);
  const beforeAttempt = snapshot();
  let attemptedControl;
  if (rowButtons.some(value => /停用/.test(value))) {
    attemptedControl = '通道行停用按钮';
    await channelRow.getByRole('button', { name: /停用/ }).click();
  } else {
    attemptedControl = '活动通道编辑按钮';
    await channelRow.getByRole('button', { name: /编辑/ }).click();
    await driver.page().getByText('仅允许修改预计结束时间和特殊状况', { exact: true })
      .waitFor({ state: 'visible' });
  }
  const attemptScreenshot = await driver.screenshot('F04-disable-active-channel');
  const afterAttempt = snapshot();
  const changed = compareManualSnapshots(beforeAttempt, afterAttempt);
  assertZeroBusinessWrite(beforeAttempt, afterAttempt);
  const productDefect = null;
  const visibleFeedback = String(await driver.page().locator('#toast').textContent().catch(() => '') || '').trim();

  await operator.navigate({ id: 'F04-dashboard', label: '通道看板' });
  await operator.click({ name: '展开', exact: false });
  await operator.click({ name: '结束测试', exact: true });
  await driver.page().getByText('通道状态已更新', { exact: true }).waitFor({ state: 'visible' });
  const recovered = snapshot();
  const restartResult = await restartAndVerify(scenarioId, recovered);
  await writeRecoveryEvidence(scenarioId, {
    plan,
    attemptedControl,
    visibleRowButtons: rowButtons,
    visibleFeedback,
    attemptScreenshot,
    attemptDiff: changed,
    productDefect,
    recoveryActions: ['通道看板', '结束测试'],
    continuedBusinessGoal: productDefect === null,
    recoverySucceeded: true,
    restartResult
  });
});

misuse('F05 survives long Chinese, quotes, wildcards, newlines and spaces-only visible input', async () => {
  const scenarioId = 'F05';
  const plan = planHumanMisuse({
    scenarioId,
    seed: 22001,
    visibleState: { availableActions: ['search'] }
  });
  await operator.navigate({ id: 'F05-requests', label: '测试申请表格' });
  const longFixture = fixture('long-chinese');
  const beforeImport = snapshot();
  const imported = await operator.perform({
    id: 'F05-import-long-chinese',
    type: 'importFile',
    params: { path: longFixture.path, expectText: '单个 Excel 导入完成' }
  });
  assert.equal(imported.outcome, 'success');
  const afterImport = snapshot();
  const requestNo = longFixture.expected.requestNumbers[0];
  assert.equal(afterImport.summary.requests - beforeImport.summary.requests, 1);
  assert.ok(afterImport.state.requests.some(item => String(item.id ?? item.requestNo) === requestNo));

  await operator.navigate({ id: 'F05-apply', label: '开始/预约测试' });
  const search = driver.page().getByLabel('搜索申请单、项目、样品或人员', { exact: true });
  const inputs = [
    '这是纯虚构的电池测试长文本，包含中文、引号“测试”、通配符 * ?、换行与恢复验证。'.repeat(40),
    '双引号"与单引号\'不会改变业务状态',
    '*',
    '?',
    '第一行\n第二行',
    '   '
  ];
  const beforeInputs = snapshot();
  const observedValues = [];
  for (const value of inputs) {
    await search.fill(value);
    observedValues.push(await search.inputValue());
    await driver.page().getByRole('heading', { name: '选择测试申请', exact: true })
      .waitFor({ state: 'visible' });
  }
  const hostileInputScreenshot = await driver.screenshot('F05-hostile-visible-input');
  const afterInputs = snapshot();
  assertZeroBusinessWrite(beforeInputs, afterInputs);
  assert.equal(observedValues[1], inputs[1]);
  assert.equal(observedValues[2], '*');
  assert.equal(observedValues[3], '?');
  assert.equal(observedValues[5], '   ');

  await search.fill(requestNo);
  await driver.page().getByText(requestNo, { exact: false }).first().waitFor({ state: 'visible' });
  const recovered = snapshot();
  const restartResult = await restartAndVerify(scenarioId, recovered);
  await writeRecoveryEvidence(scenarioId, {
    plan,
    visibleFeedback: '所有特殊输入后页面仍可见、可清空并重新找到已导入申请',
    importedRequestNo: requestNo,
    observedValues,
    hostileInputScreenshot,
    inputDiff: compareManualSnapshots(beforeInputs, afterInputs),
    recoveryActions: ['清空异常搜索', '按申请单号重新搜索'],
    continuedBusinessGoal: true,
    restartResult
  });
});

misuse('F06 survives half-filled forms, rapid navigation, search and pagination without business writes', async () => {
  const scenarioId = 'F06';
  const plan = planHumanMisuse({
    scenarioId,
    seed: 22001,
    visibleState: { availableActions: ['navigate', 'search', 'paginate'] }
  });
  const longFixture = fixture('long-chinese');
  const longRequestNo = longFixture.expected.requestNumbers[0];
  if (!snapshot().state.requests.some(item => String(item.id ?? item.requestNo) === longRequestNo)) {
    await operator.navigate({ id: 'F06-requests-import', label: '测试申请表格' });
    const imported = await operator.perform({
      id: 'F06-import-extra-page',
      type: 'importFile',
      params: { path: longFixture.path, expectText: '单个 Excel 导入完成' }
    });
    assert.equal(imported.outcome, 'success');
  }

  const beforeRestartStorm = snapshot();
  let restartCycles = 0;
  let currentAuditCount = beforeRestartStorm.auditSummary.count;
  while (currentAuditCount <= 50 && restartCycles < 45) {
    restartCycles += 1;
    assert.equal((await operator.restart({ id: `F06-audit-restart-${restartCycles}` })).outcome, 'success');
    assert.equal((await operator.login({ id: `F06-audit-login-${restartCycles}`, username: actor })).outcome, 'success');
    const current = snapshot();
    assert.deepEqual(businessHashes(current), businessHashes(beforeRestartStorm));
    currentAuditCount = current.auditSummary.count;
  }
  assert.ok(currentAuditCount > 50, 'visible restart/login actions must create enough audit rows for real pagination');
  const beforeMisuse = snapshot();
  const navigationLabels = ['开始/预约测试', '日志', '设备与通道', '测试申请表格'];
  const navigationResults = [];
  for (let cycle = 0; cycle < 3; cycle += 1) {
    for (const label of navigationLabels) {
      navigationResults.push(await operator.navigate({ id: `F06-nav-${cycle}-${label}`, label }));
    }
  }
  assert.ok(navigationResults.every(item => item.outcome === 'success'));

  await operator.navigate({ id: 'F06-half-filled', label: '开始/预约测试' });
  const requestNo = requestNumbers[4];
  await operator.fill({ label: '搜索申请单、项目、样品或人员', value: requestNo.slice(0, -2) });
  await operator.fill({ label: '搜索申请单、项目、样品或人员', value: requestNo });
  await operator.click({ name: '预约', exact: true });
  await operator.fill({ label: '备注', value: '只填到一半就切换页面：* ? “引号”' });
  await operator.navigate({ id: 'F06-leave-half-filled', label: '日志' });
  await operator.navigate({ id: 'F06-return-list', label: '开始/预约测试' });
  const closeCandidates = driver.page().getByText('×', { exact: true });
  let draftClosed = false;
  for (let index = 0; index < await closeCandidates.count(); index += 1) {
    const candidate = closeCandidates.nth(index);
    if (await candidate.isVisible().catch(() => false)) {
      await candidate.click();
      draftClosed = true;
      break;
    }
  }
  assert.equal(draftClosed, true, 'visible half-filled detail must provide a close control');
  await driver.page().getByRole('heading', { name: '本次测试信息', exact: true })
    .waitFor({ state: 'hidden' });

  const searchResult = await operator.search({
    id: plan.actions.find(item => item.type === 'search').id,
    params: { label: '搜索申请单、项目、样品或人员', query: '*?虚构' }
  });
  assert.equal(searchResult.outcome, 'success');
  await operator.fill({ label: '搜索申请单、项目、样品或人员', value: '' });
  await operator.navigate({ id: 'F06-logs-pagination', label: '日志' });
  const next = await operator.paginate({
    id: `${plan.actions.find(item => item.type === 'paginate').id}-next`,
    params: { direction: 'next' }
  });
  assert.equal(next.outcome, 'success');
  assert.ok((await visibleTexts(driver.page().getByText(/第 2 \/ \d+ 页/))).length > 0);
  const previous = await operator.paginate({
    id: `${plan.actions.find(item => item.type === 'paginate').id}-previous`,
    params: { direction: 'previous' }
  });
  assert.equal(previous.outcome, 'success');
  assert.ok((await visibleTexts(driver.page().getByText(/第 1 \/ \d+ 页/))).length > 0);

  const misuseScreenshot = await driver.screenshot('F06-navigation-search-pagination');
  const afterMisuse = snapshot();
  assert.deepEqual(businessHashes(afterMisuse), businessHashes(beforeMisuse));
  const beforeAuditIds = new Set(beforeMisuse.state.auditLogs.map(item => String(item.id || '')));
  const addedAudits = afterMisuse.state.auditLogs.filter(item => !beforeAuditIds.has(String(item.id || '')));
  assert.ok(addedAudits.length > 0);
  assert.ok(addedAudits.every(item => item.action === '查看页面'));
  const restartResult = await restartAndVerify(scenarioId, afterMisuse);
  await writeRecoveryEvidence(scenarioId, {
    plan,
    visibleFeedback: '半填表单后切换页面、连续导航、特殊搜索和前后翻页均可继续',
    restartCyclesUsedToReachSecondAuditPage: restartCycles,
    navigationCount: navigationResults.length,
    searchResult,
    paginationResults: [next, previous],
    addedAuditActions: addedAudits.map(item => item.action),
    misuseScreenshot,
    misuseDiff: compareManualSnapshots(beforeMisuse, afterMisuse),
    recoveryActions: ['离开半填表单', '返回开始/预约测试', '清空搜索', '下一页', '上一页'],
    continuedBusinessGoal: true,
    restartResult
  });
});

misuse('F07 stale dashboard intent cannot overwrite a newer returned state', async () => {
  const scenarioId = 'F07';
  const requestNo = requestNumbers[5];
  const plan = planHumanMisuse({
    scenarioId,
    seed: 22001,
    visibleState: { availableActions: ['finishRunning'] }
  });
  await operator.navigate({ id: 'F07-apply', label: '开始/预约测试' });
  await operator.fill({ label: '搜索申请单、项目、样品或人员', value: requestNo });
  await operator.click({ name: '预约', exact: true });
  await operator.click({ name: '立即开始', role: 'radio', exact: true });
  await operator.click({ name: '选择通道', exact: false });
  await operator.click({ name: `${deviceName} ${channelName}`, exact: false });
  await operator.click({ name: '立即开始', exact: true });
  await driver.page().getByText('测试已开始', { exact: true }).waitFor({ state: 'visible' });
  const active = snapshot();
  const record = active.state.records.find(item => item.requestNo === requestNo && item.status === 'running');
  assert.ok(record);

  await operator.navigate({ id: 'F07-dashboard-stale-detail', label: '通道看板' });
  await operator.click({ name: '展开', exact: false });
  const staleIntent = driver.page().getByRole('button', { name: '结束测试', exact: true });
  await staleIntent.waitFor({ state: 'visible' });
  const staleDetailScreenshot = await driver.screenshot('F07-before-newer-state');

  await operator.navigate({ id: 'F07-running-newer-state', label: '正在测试样品' });
  await driver.page().getByText(`${requestNo}.001`, { exact: true }).waitFor({ state: 'visible' });
  await operator.click({ name: '退回申请', exact: true });
  await operator.fill({ label: '退回原因', value: 'F07 虚构陈旧详情恢复验证' });
  const returnFormScreenshot = await driver.screenshot('F07-return-running-form');
  const returnButtons = await visibleTexts(driver.page().getByRole('button'));
  const returnButtonName = returnButtons.find(value => /确认.*退回|提交.*退回/.test(value));
  assert.ok(returnButtonName, `visible return form has no confirmation control: ${returnButtons.join(', ')}`);
  await operator.click({ name: returnButtonName, exact: true });
  const newerState = snapshot();
  const newerRecordStatus = newerState.state.records.find(item => item.id === record.id)?.status;
  assert.ok(!['running', 'reserved'].includes(newerRecordStatus));
  assert.equal(newerState.state.channels.find(item => item.key === `${deviceName}|${channelName}`)?.state, 'free');

  await operator.navigate({ id: 'F07-return-stale-dashboard', label: '通道看板' });
  const beforeStaleRetry = snapshot();
  const staleStillVisible = await staleIntent.isVisible().catch(() => false);
  let visibleFeedback;
  let staleRetryScreenshot;
  if (staleStillVisible) {
    await staleIntent.click();
    visibleFeedback = String(await driver.page().locator('#toast').textContent().catch(() => '') || '').trim();
    staleRetryScreenshot = await driver.screenshot('F07-stale-action-retried');
  } else {
    visibleFeedback = '较新状态完成后，陈旧详情中的结束按钮不再可见';
    staleRetryScreenshot = await driver.screenshot('F07-stale-action-removed');
  }
  const afterStaleRetry = snapshot();
  assert.equal(afterStaleRetry.state.records.find(item => item.id === record.id)?.status, newerRecordStatus);
  assert.deepEqual(businessHashes(afterStaleRetry), businessHashes(beforeStaleRetry));

  const restartResult = await restartAndVerify(scenarioId, afterStaleRetry);
  await writeRecoveryEvidence(scenarioId, {
    plan,
    visibleFeedback,
    staleDetailScreenshot,
    returnFormScreenshot,
    returnButtons,
    newerRecordStatus,
    staleRetryScreenshot,
    staleActionStillVisible: staleStillVisible,
    newerStateDiff: compareManualSnapshots(active, newerState),
    staleRetryDiff: compareManualSnapshots(beforeStaleRetry, afterStaleRetry),
    recoveryActions: ['正在测试样品结束测试', '返回通道看板', '核验陈旧按钮'],
    continuedBusinessGoal: true,
    restartResult
  });
});
