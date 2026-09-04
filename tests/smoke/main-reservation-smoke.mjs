import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createLegacySqliteStore } from '../../src/main/legacy-sqlite-store.mjs';

const require = createRequire(import.meta.url);
const electronPath = require('electron');
const preset = require('../../lib/device-preset.js');
const projectRoot = path.resolve(import.meta.dirname, '..', '..');
const viewports = ['1366x768', '1440x900', '1536x864'];
const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'battery-main-reservation-smoke-'));

function initialState() {
  return {
    revision: 0,
    requests: [{
      id: 'REQ-SMOKE-001', qty: 30, test: '循环测试', project: '无人机项目',
      sample: '35Ah', client: '委托人 A', dept: '研发部', tester: 'smoke-user', status: '待安排'
    }],
    samples: Array.from({ length: 30 }, (_, index) => ({
      id: `REQ-SMOKE-001.${String(index + 1).padStart(3, '0')}`,
      requestNo: 'REQ-SMOKE-001', ordinal: index + 1, status: 'pending',
      channelKey: '', start: '', end: '', hasHistory: false
    })),
    records: [],
    requestSourceRows: [],
    auditLogs: [{
      id: 'AUDIT-SMOKE-INIT', time: '2026-08-20T20:00:00.000Z', user: '系统',
      action: '初始化预约 Smoke', target: '30 子样品 / 529 通道', level: 'normal'
    }],
    formChangeJournal: [],
    testers: [],
    deviceProfiles: preset.devices(),
    channels: preset.channels(),
    username: 'smoke-user',
    savedAt: ''
  };
}

async function seed(dataRoot) {
  const store = await createLegacySqliteStore({
    dataRoot,
    clock: () => '2026-08-20T20:00:00.000Z'
  });
  try {
    const saved = await store.save({ expectedRevision: 0, state: initialState(), journalEntries: [] });
    assert.equal(saved.ok, true);
  } finally {
    store.close();
  }
}

async function launch({ dataRoot, profileRoot, viewport, phase, screenshotPath = '' }) {
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
        BATTERY_CHANNEL_SMOKE_MODE: 'reservation',
        BATTERY_CHANNEL_SMOKE_PHASE: phase,
        BATTERY_CHANNEL_SMOKE_VIEWPORT: viewport,
        ...(screenshotPath ? { BATTERY_CHANNEL_SMOKE_SCREENSHOT: screenshotPath } : {})
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
    }, 25000);
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('exit', code => {
      clearTimeout(timeout);
      if (timedOut) return reject(new Error(`预约 Smoke 超时 ${viewport}/${phase}\n${stdout}\n${stderr}`));
      const marker = stdout.split(/\r?\n/).find(line => line.startsWith('SMOKE_RESULT='));
      if (!marker) return reject(new Error(`缺少 SMOKE_RESULT ${viewport}/${phase}\n${stdout}\n${stderr}`));
      resolve({ code, report: JSON.parse(marker.slice('SMOKE_RESULT='.length)), stdout, stderr });
    });
  });
}

try {
  const reports = [];
  for (const viewport of viewports) {
    const viewportRoot = path.join(temporaryRoot, viewport);
    const dataRoot = path.join(viewportRoot, 'data');
    await mkdir(dataRoot, { recursive: true });
    await seed(dataRoot);

    if (viewport === viewports[0]) {
      const layout = await launch({
        dataRoot,
        profileRoot: path.join(viewportRoot, 'profile-layout'),
        viewport,
        phase: 'layout',
        screenshotPath: process.env.BATTERY_CHANNEL_VISUAL_SCREENSHOT || ''
      });
      assert.equal(layout.code, 0, `${layout.stdout}\n${layout.stderr}`);
      assert.deepEqual(layout.report.consoleErrors, []);
      assert.equal(layout.report.openedDetails, true);
      assert.equal(layout.report.splitColumns, true);
      assert.equal(layout.report.detailsNarrowerThanList, true);
      assert.equal(layout.report.editableControlSurvivedClick, true);
      assert.equal(layout.report.clickedControlFocused, true);
      assert.equal(layout.report.executionModeChangedByClick, true);
      assert.equal(layout.report.mountedWorkspaceSynced, true);
    }

    const submitted = await launch({
      dataRoot,
      profileRoot: path.join(viewportRoot, 'profile-submit'),
      viewport,
      phase: 'management',
      screenshotPath: viewport === viewports[0] ? process.env.BATTERY_CHANNEL_DASHBOARD_SCREENSHOT || '' : ''
    });
    assert.equal(submitted.code, 0, `${submitted.stdout}\n${submitted.stderr}`);
    assert.deepEqual(submitted.report.consoleErrors, []);
    assert.equal(submitted.report.viewport, viewport);
    assert.equal(submitted.report.defaultDetailsPresent, false);
    assert.equal(submitted.report.defaultBoardCards, 0);
    assert.equal(submitted.report.hiddenRecordRows, 0);
    assert.equal(submitted.report.hiddenChannelRows, 0);
    assert.equal(submitted.report.openedDetails, true);
    assert.equal(submitted.report.splitColumns, true);
    assert.equal(submitted.report.detailsNarrowerThanList, true);
    assert.equal(submitted.report.closedDetailsPresent, false);
    assert.equal(submitted.report.searchRetained, '无人机');
    assert.ok(submitted.report.sampleRows <= 25);
    assert.ok(submitted.report.channelOptions <= 40);
    assert.equal(submitted.report.channelPagesDisjoint, true);
    assert.ok(submitted.report.channelOuterScrollBefore > 0, JSON.stringify(submitted.report));
    assert.ok(
      Math.abs(submitted.report.channelOuterScrollAfter - submitted.report.channelOuterScrollBefore) <= 2,
      JSON.stringify(submitted.report)
    );
    assert.equal(submitted.report.channelInnerScrollAfter, 0);
    assert.equal(submitted.report.editableControlSurvivedClick, true);
    assert.equal(submitted.report.clickedControlFocused, true);
    assert.equal(submitted.report.executionModeChangedByClick, true);
    assert.equal(submitted.report.mountedWorkspaceSynced, true);
    assert.equal(submitted.report.runningSampleVisible, true);
    assert.equal(submitted.report.runningEditorOpened, true);
    assert.match(submitted.report.runningEditorTitle, /管理进行中测试.*REQ-SMOKE-001\.001/);
    assert.equal(submitted.report.runningEditorLocked, true);
    assert.equal(submitted.report.runningManagementPersisted, true);
    assert.equal(submitted.report.runningManagementAudited, true);
    assert.equal(submitted.report.runningLinkagePreserved, true);
    assert.equal(submitted.report.runningUsageManagePresent, true);
    assert.equal(submitted.report.dashboardTimelinessAbsent, true);
    assert.equal(submitted.report.dashboardFiltersPresent, true);
    assert.equal(submitted.report.reservationTodoItems, 1);
    assert.equal(submitted.report.dashboardDefaultCardsAfterSave, 0);
    assert.ok(submitted.report.dashboardFilteredCount > 0, JSON.stringify(submitted.report));
    assert.ok(submitted.report.dashboardFilteredCount < 529);
    assert.equal(submitted.report.dashboardScrollY, 0);
    assert.equal(submitted.report.dashboardScrollAfterFilter, 0);
    assert.equal(submitted.report.reservationTodoDetailFocused, true);
    assert.equal(submitted.report.reservationTodoStartPresent, true);
    assert.equal(submitted.report.reservationTodoCancelPresent, true);
    assert.equal(submitted.report.reservationTodoActionPersisted, true);
    assert.equal(submitted.report.reservationTodoRecordRunning, true, JSON.stringify(submitted.report));
    assert.equal(submitted.report.reservationTodoSampleRunning, true);
    assert.equal(submitted.report.reservationTodoChannelBusy, true);
    assert.equal(submitted.report.reservationTodoRemoved, true);
    assert.equal(submitted.report.reservationTodoStartAudited, true, JSON.stringify(submitted.report));
    assert.equal(submitted.report.reservationTodoCancelActionPersisted, true);
    assert.equal(submitted.report.reservationTodoCancelRecordCancelled, true);
    assert.equal(submitted.report.reservationTodoCancelSampleCancelled, true);
    assert.equal(submitted.report.reservationTodoCancelChannelReleased, true);
    assert.equal(submitted.report.reservationTodoCancelRemoved, true);
    assert.equal(submitted.report.reservationTodoCancelAudited, true);
    assert.equal(submitted.report.postTodo.records, 2);
    assert.equal(submitted.report.postTodo.reservedSamples, 0);
    assert.equal(submitted.report.postTodo.runningSamples, 2);
    assert.equal(submitted.report.postTodo.bookedChannels, 0);
    assert.equal(submitted.report.postTodo.busyChannels, 2);
    assert.equal(submitted.report.dashboardReturnScrollY, 0);
    assert.equal(submitted.report.timelinessPanelPresent, true);
    assert.equal(submitted.report.timelinessNavActive, true);
    assert.equal(submitted.report.timelinessRate, '--');
    assert.equal(submitted.report.timelinessKnown, 0);
    assert.equal(submitted.report.timelinessMissingPlan, 2);
    assert.equal(submitted.report.timelinessDateControls, 2);
    assert.equal(submitted.report.timelinessExportPresent, true);
    assert.equal(submitted.report.saved.records, 2);
    assert.equal(submitted.report.saved.reservedSamples, 1);
    assert.equal(submitted.report.saved.runningSamples, 1);
    assert.equal(submitted.report.saved.bookedChannels, 1);
    assert.equal(submitted.report.saved.busyChannels, 1);
    assert.equal(submitted.report.saved.runningEnd, '2026-08-21T15:30');
    assert.equal(submitted.report.saved.runningCondition, '等待样品复核');

    const restarted = await launch({
      dataRoot,
      profileRoot: path.join(viewportRoot, 'profile-restart'),
      viewport,
      phase: 'verify'
    });
    assert.equal(restarted.code, 0, `${restarted.stdout}\n${restarted.stderr}`);
    assert.deepEqual(restarted.report.consoleErrors, []);
    assert.equal(restarted.report.persisted.records, 3);
    assert.equal(restarted.report.persisted.reservedSamples, 0);
    assert.equal(restarted.report.persisted.runningSamples, 2);
    assert.equal(restarted.report.persisted.bookedChannels, 0);
    assert.equal(restarted.report.persisted.busyChannels, 2);
    assert.equal(restarted.report.persisted.runningEnd, '2026-08-21T15:30');
    assert.equal(restarted.report.persisted.runningCondition, '等待样品复核');
    reports.push({ viewport, submit: submitted.report, restart: restarted.report });
  }
  process.stdout.write(`Electron main reservation Smoke PASS ${JSON.stringify(reports)}\n`);
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
