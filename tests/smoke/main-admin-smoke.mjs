import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';

import XLSX from 'xlsx';

import { createLegacySqliteStore } from '../../src/main/legacy-sqlite-store.mjs';

const require = createRequire(import.meta.url);
const electronPath = require('electron');
const preset = require('../../lib/device-preset.js');
const projectRoot = path.resolve(import.meta.dirname, '..', '..');
const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'battery-main-admin-smoke-'));

function initialState() {
  return {
    revision: 0,
    requests: [{
      id: 'REQ-ADMIN-001', qty: 2, test: '循环测试', project: '管理回归项目',
      sample: '35Ah', client: '原始委托人', dept: '研发部', tester: '旧平铺姓名', status: '待安排',
      rawFields: { 委托单号: 'REQ-ADMIN-001', 申请人: '原始委托人', 嵌套: { 值: 1 } },
      sourceFile: 'REQ-ADMIN-001.xlsx',
      sourcePath: 'C:\\imports\\REQ-ADMIN-001.xlsx',
      execution: { tester: '执行测试员 A', fee: 10, device: '', plannedStart: '', plannedEnd: '', note: '' }
    }],
    samples: [1, 2].map(ordinal => ({
      id: `REQ-ADMIN-001.${String(ordinal).padStart(3, '0')}`,
      requestNo: 'REQ-ADMIN-001', ordinal, status: 'pending',
      channelKey: '', start: '', end: '', hasHistory: false
    })),
    records: [],
    requestSourceRows: [{
      id: 'REQ-ADMIN-001', requestNo: 'REQ-ADMIN-001',
      sourceFile: 'REQ-ADMIN-001.xlsx', sourcePath: 'C:\\imports\\REQ-ADMIN-001.xlsx'
    }],
    auditLogs: [{
      id: 'AUDIT-ADMIN-SMOKE-INIT', time: '2026-08-20T23:00:00.000Z', user: '系统',
      action: '初始化管理 Smoke', target: '申请/人员/导出', level: 'normal'
    }],
    formChangeJournal: [],
    testers: [{ id: 'T-BASE', name: '执行测试员 A', dept: '测试部', status: '启用' }],
    deviceProfiles: preset.devices(),
    channels: preset.channels(),
    username: 'smoke-admin',
    savedAt: ''
  };
}

async function seed(dataRoot) {
  const store = await createLegacySqliteStore({
    dataRoot,
    clock: () => '2026-08-20T23:00:00.000Z'
  });
  try {
    const result = await store.save({ expectedRevision: 0, state: initialState(), journalEntries: [] });
    assert.equal(result.ok, true);
  } finally {
    store.close();
  }
}

async function launch({ dataRoot, profileRoot, exportFile, phase }) {
  await mkdir(profileRoot, { recursive: true });
  return new Promise((resolve, reject) => {
    const child = spawn(electronPath, [
      '.', '--smoke-test', `--user-data-dir=${profileRoot}`, '--disable-gpu'
    ], {
      cwd: projectRoot,
      env: {
        ...process.env,
        BATTERY_CHANNEL_DATA_DIR: dataRoot,
        BATTERY_CHANNEL_SMOKE: '1',
        BATTERY_CHANNEL_SMOKE_MODE: 'admin',
        BATTERY_CHANNEL_SMOKE_PHASE: phase,
        BATTERY_CHANNEL_SMOKE_ADMIN_EXPORT: exportFile
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, 30000);
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('exit', code => {
      clearTimeout(timeout);
      if (timedOut) return reject(new Error(`管理 Smoke 超时 ${phase}\n${stdout}\n${stderr}`));
      const marker = stdout.split(/\r?\n/).find(line => line.startsWith('SMOKE_RESULT='));
      if (!marker) return reject(new Error(`缺少 SMOKE_RESULT ${phase}\n${stdout}\n${stderr}`));
      resolve({ code, report: JSON.parse(marker.slice('SMOKE_RESULT='.length)), stdout, stderr });
    });
  });
}

try {
  const dataRoot = path.join(temporaryRoot, 'data');
  const exportFile = path.join(temporaryRoot, 'exports', 'admin-smoke.xlsx');
  await mkdir(dataRoot, { recursive: true });
  await mkdir(path.dirname(exportFile), { recursive: true });
  await seed(dataRoot);

  const submitted = await launch({
    dataRoot,
    profileRoot: path.join(temporaryRoot, 'profile-submit'),
    exportFile,
    phase: 'submit'
  });
  assert.equal(submitted.code, 0, `${submitted.stdout}\n${submitted.stderr}`);
  assert.deepEqual(submitted.report.consoleErrors, []);
  assert.equal(submitted.report.rawUnchanged, true);
  assert.equal(submitted.report.sourceFile, 'REQ-ADMIN-001.xlsx');
  assert.equal(submitted.report.sourcePath, 'C:\\imports\\REQ-ADMIN-001.xlsx');
  assert.equal(submitted.report.execution.tester, '执行测试员 B');
  assert.equal(submitted.report.execution.fee, 25);
  assert.equal(submitted.report.temporaryTesterPresent, false);
  assert.equal(submitted.report.cancelRevisionDelta, 0);
  assert.equal(submitted.report.cancelAuditDelta, 0);
  assert.equal(submitted.report.exportSuccessAudits, 1);
  assert.equal(submitted.report.exportVerified, true);
  assert.equal(submitted.report.formJournalEntries, 1);
  assert.equal(submitted.report.channelFilterText, 'zhong');
  assert.equal(submitted.report.channelFilterCaret, 5);
  assert.equal(submitted.report.channelCompositionTargetPreserved, true);
  assert.equal(submitted.report.channelCompositionText, '中文');
  assert.deepEqual(submitted.report.pagesVisited, ['requests', 'testers', 'records', 'devices']);

  const workbook = XLSX.readFile(exportFile, { cellFormula: true });
  assert.deepEqual(workbook.SheetNames, ['测试申请表格', '测试项目明细']);
  assert.equal(XLSX.utils.sheet_to_json(workbook.Sheets['测试申请表格']).length, 1);
  assert.equal(XLSX.utils.sheet_to_json(workbook.Sheets['测试项目明细']).length, 1);
  assert.equal(Object.values(workbook.Sheets).flatMap(sheet =>
    Object.entries(sheet).filter(([key, cell]) => !key.startsWith('!') && cell?.t === 'e')
  ).length, 0);

  const restarted = await launch({
    dataRoot,
    profileRoot: path.join(temporaryRoot, 'profile-verify'),
    exportFile,
    phase: 'verify'
  });
  assert.equal(restarted.code, 0, `${restarted.stdout}\n${restarted.stderr}`);
  assert.deepEqual(restarted.report.consoleErrors, []);
  assert.deepEqual(restarted.report.rawFields, initialState().requests[0].rawFields);
  assert.equal(restarted.report.sourceFile, 'REQ-ADMIN-001.xlsx');
  assert.equal(restarted.report.sourcePath, 'C:\\imports\\REQ-ADMIN-001.xlsx');
  assert.equal(restarted.report.execution.tester, '执行测试员 B');
  assert.equal(restarted.report.temporaryTesterPresent, false);
  assert.equal(restarted.report.exportSuccessAudits, 1);
  assert.equal(restarted.report.formJournalEntries, 1);

  process.stdout.write(`Electron main admin Smoke PASS ${JSON.stringify({ submit: submitted.report, restart: restarted.report })}\n`);
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
