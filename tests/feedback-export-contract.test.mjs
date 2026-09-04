import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createEdgeDriver } from '../scripts/edge-regression/edge-driver.mjs';
import { startTestHost } from '../scripts/edge-regression/test-host.mjs';

const projectRoot = path.resolve(import.meta.dirname, '..');

function initialState({ requests = [], records = [] } = {}) {
  return {
    revision: 0,
    requests,
    samples: [],
    channels: [],
    deviceProfiles: [],
    records,
    storageRecords: [],
    requestSourceRows: [],
    auditLogs: [],
    formChangeJournal: [],
    testers: [],
    username: '导出契约测试员',
    savedAt: ''
  };
}

function fakeHarness(seed) {
  let state = structuredClone(seed);
  const exports = [];
  return {
    exports,
    snapshot() { return structuredClone(state); },
    async loadState() { return structuredClone(state); },
    async saveState(next) {
      state = structuredClone(next);
      return structuredClone(state);
    },
    async exportExcel(payload) {
      exports.push(structuredClone(payload));
      return { ok: true, verified: true, file: 'C:\\isolated-test-output\\export.xlsx' };
    }
  };
}

async function runGuiExport(name, seed, action, { expectedExports = 1 } = {}) {
  const runRoot = await mkdtemp(path.join(os.tmpdir(), 'feedback-export-contract-'));
  const harness = fakeHarness(seed);
  const token = 'feedback-export-contract-secret';
  const run = {
    snapshot: () => ({ runId: name, scenarios: [] }),
    requestStop: () => ({ ok: true })
  };
  const host = await startTestHost({ projectRoot, run, harness, token });
  const edge = await createEdgeDriver({ origin: host.origin, token, runRoot });
  try {
    const result = await edge.run(name, async ({ page }) => {
      await page.goto(`${host.origin}/app/`);
      await page.locator('#username').fill('导出契约测试员');
      await page.locator('#login .btn.wide').click();
      await page.waitForFunction(() => globalThis.__batteryAppReady === true);
      return action(page);
    });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.deepEqual(result.consoleErrors, []);
    assert.equal(harness.exports.length, expectedExports);
    return {
      exports: structuredClone(harness.exports),
      state: harness.snapshot(),
      visibleMessage: result.value
    };
  } finally {
    await edge.close();
    await host.close();
  }
}

function requestFixtures() {
  return [
    { id: 'REQ-START', project: '起始边界', test: '循环', sample: 'A', qty: 1, end: '2026-07-01', execution: { plannedEnd: '2026-08-15' } },
    { id: 'REQ-END', project: '结束边界', test: '循环', sample: 'B', qty: 1, end: '2026-07-02', execution: { plannedEnd: '2026-08-20' } },
    { id: 'REQ-OUTSIDE', project: '范围之外', test: '循环', sample: 'C', qty: 1, end: '2026-07-03', execution: { plannedEnd: '2026-08-21' } }
  ];
}

async function triggerRequestExport(page, { from = '', to = '', errorText = '' } = {}) {
  await page.locator('button.nav[data-page="requests"]').click();
  await page.locator('#requestExportStartDate').fill(from);
  await page.locator('#requestExportEndDate').fill(to);
  const button = page.getByRole('button', { name: '导出指定日期范围', exact: true });
  if (errorText) {
    await button.click();
    const toast = page.locator('#toast').filter({ hasText: errorText });
    await toast.waitFor({ state: 'visible' });
    return String(await toast.textContent() || '').trim();
  }
  await Promise.all([
    page.waitForResponse(response => response.url().endsWith('/api/excel/export')),
    button.click()
  ]);
  const toast = page.locator('#toast').filter({ hasText: '已导出' });
  await toast.waitFor({ state: 'visible' });
  return String(await toast.textContent() || '').trim();
}

test('GUI 申请汇总按当前计划完成日期闭区间导出两张筛选后的表', async () => {
  const result = await runGuiExport('date-filtered-request-export', initialState({ requests: requestFixtures() }), page => (
    triggerRequestExport(page, { from: '2026-08-15', to: '2026-08-20' })
  ));
  const payload = result.exports[0];

  assert.equal(payload.title, '导出指定日期范围申请表');
  assert.equal(payload.defaultFileName, '申请表单汇总_2026-08-15至2026-08-20.xlsx');
  assert.deepEqual(payload.sheets.map(sheet => sheet.name), ['测试申请表格', '测试项目明细']);
  assert.deepEqual(payload.sheets[0].rows.map(row => row['系统申请单号']), ['REQ-START', 'REQ-END']);
  assert.deepEqual(payload.sheets[1].rows.map(row => row['系统申请单号']), ['REQ-START', 'REQ-END']);
  assert.ok(result.visibleMessage.includes('测试申请汇总 XLSX 已导出'));
  assert.ok(result.visibleMessage.includes('2 条申请表'));
  assert.ok(result.visibleMessage.includes('申请表单汇总_2026-08-15至2026-08-20.xlsx'));

  const audits = result.state.auditLogs.filter(item => item.action === '导出申请汇总');
  assert.equal(audits.length, 1);
  assert.equal(audits[0].outcome, 'success');
  assert.equal(audits[0].result, 'success');
  assert.equal(audits[0].verified, true);
  assert.deepEqual(audits[0].after, {
    requests: 2,
    details: 2,
    plannedEndFrom: '2026-08-15',
    plannedEndTo: '2026-08-20',
    file: 'C:\\isolated-test-output\\export.xlsx'
  });
  assert.equal(audits[0].note, '按计划完成日期范围导出');
});

test('GUI 申请汇总在日期均留空时导出全部申请', async () => {
  const result = await runGuiExport('unbounded-request-export', initialState({ requests: requestFixtures() }), page => (
    triggerRequestExport(page)
  ));
  const payload = result.exports[0];
  assert.equal(payload.title, '导出申请表汇总');
  assert.match(payload.defaultFileName, /^申请表单汇总_\d{4}-\d{2}-\d{2}\.xlsx$/);
  assert.deepEqual(payload.sheets[0].rows.map(row => row['系统申请单号']), ['REQ-START', 'REQ-END', 'REQ-OUTSIDE']);
  assert.deepEqual(payload.sheets[1].rows.map(row => row['系统申请单号']), ['REQ-START', 'REQ-END', 'REQ-OUTSIDE']);
});

test('GUI 申请汇总只填开始日期时导出该日及之后申请', async () => {
  const result = await runGuiExport('start-bounded-request-export', initialState({ requests: requestFixtures() }), page => (
    triggerRequestExport(page, { from: '2026-08-20' })
  ));
  const payload = result.exports[0];
  assert.equal(payload.defaultFileName, '申请表单汇总_2026-08-20起.xlsx');
  assert.deepEqual(payload.sheets[0].rows.map(row => row['系统申请单号']), ['REQ-END', 'REQ-OUTSIDE']);
});

test('GUI 申请汇总只填结束日期时导出该日及之前申请', async () => {
  const result = await runGuiExport('end-bounded-request-export', initialState({ requests: requestFixtures() }), page => (
    triggerRequestExport(page, { to: '2026-08-20' })
  ));
  const payload = result.exports[0];
  assert.equal(payload.defaultFileName, '申请表单汇总_2026-08-20止.xlsx');
  assert.deepEqual(payload.sheets[0].rows.map(row => row['系统申请单号']), ['REQ-START', 'REQ-END']);
});

test('GUI 申请汇总拒绝倒置日期并且不调用 Excel 导出', async () => {
  const expected = '开始日期不能晚于结束日期';
  const result = await runGuiExport('reversed-request-export', initialState({ requests: requestFixtures() }), page => (
    triggerRequestExport(page, { from: '2026-08-21', to: '2026-08-20', errorText: expected })
  ), { expectedExports: 0 });
  assert.equal(result.visibleMessage, expected);
  assert.equal(result.state.auditLogs.some(item => item.action === '导出申请汇总'), false);
});

test('GUI 申请汇总无匹配日期时显示范围并且不调用 Excel 导出', async () => {
  const expected = '计划完成日期 2026-09-01 至 2026-09-02 没有申请表';
  const result = await runGuiExport('empty-request-export', initialState({ requests: requestFixtures() }), page => (
    triggerRequestExport(page, { from: '2026-09-01', to: '2026-09-02', errorText: expected })
  ), { expectedExports: 0 });
  assert.equal(result.visibleMessage, expected);
  assert.equal(result.state.auditLogs.some(item => item.action === '导出申请汇总'), false);
});

test('GUI 日志导出的使用记录从 canonical status 输出中文状态', async () => {
  const records = [{
    id: 'REC-STATUS',
    no: 'REQ-STATUS',
    requestNo: 'REQ-STATUS',
    project: '状态契约项目',
    test: '循环',
    channels: '设备 A · 001',
    status: 'completed',
    time: '2026-08-15 09:00',
    end: '2026-08-15 12:00',
    user: '导出契约测试员',
    source: '软件操作'
  }];
  const result = await runGuiExport('usage-record-status-export', initialState({ records }), async page => {
    await page.locator('button.nav[data-page="records"]').click();
    await Promise.all([
      page.waitForResponse(response => response.url().endsWith('/api/excel/export')),
      page.locator('#records .actions button').filter({ hasText: '导出 Excel' }).click()
    ]);
  });
  const payload = result.exports[0];

  const usageSheet = payload.sheets.find(sheet => sheet.name === '使用记录');
  assert.ok(usageSheet);
  assert.equal(usageSheet.rows.length, 1);
  assert.equal(usageSheet.rows[0]['申请单号'], 'REQ-STATUS');
  assert.equal(usageSheet.rows[0]['状态'], '已结束');
});

test('GUI 日志导出的两张使用数据表把 returned 显示为已退回', async () => {
  const records = [{
    id: 'REC-RETURNED',
    no: 'REQ-RETURNED',
    requestNo: 'REQ-RETURNED',
    project: '退回状态项目',
    test: '循环',
    channels: '设备 A · 002',
    keys: [],
    status: 'returned',
    time: '2026-08-16 09:00',
    end: '2026-08-16 12:00',
    user: '导出契约测试员',
    source: '软件操作'
  }];
  const result = await runGuiExport('returned-status-export', initialState({ records }), async page => {
    await page.locator('button.nav[data-page="records"]').click();
    await Promise.all([
      page.waitForResponse(response => response.url().endsWith('/api/excel/export')),
      page.locator('#records .actions button').filter({ hasText: '导出 Excel' }).click()
    ]);
  });
  const payload = result.exports[0];
  const recordSheet = payload.sheets.find(sheet => sheet.name === '使用记录');
  const deviceUsageSheet = payload.sheets.find(sheet => sheet.name === '测试设备使用表2');

  assert.ok(recordSheet);
  assert.ok(deviceUsageSheet);
  assert.equal(recordSheet.rows.length, 1);
  assert.equal(deviceUsageSheet.rows.length, 1);
  assert.equal(recordSheet.rows[0]['状态'], '已退回');
  assert.equal(deviceUsageSheet.rows[0]['状态'], '已退回');
});
