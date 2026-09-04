const fs = require('node:fs');
const path = require('node:path');

const { app, BrowserWindow, dialog, ipcMain } = require('electron');

const isPackaged = app.isPackaged;
const isSmokeTest = !isPackaged &&
  process.env.BATTERY_CHANNEL_SMOKE === '1' &&
  process.argv.includes('--smoke-test');

function resolveDataRoot() {
  if (!isPackaged && process.env.BATTERY_CHANNEL_DATA_DIR) {
    return path.resolve(process.env.BATTERY_CHANNEL_DATA_DIR);
  }
  return isPackaged
    ? path.join(app.getPath('userData'), 'data')
    : path.join(__dirname, 'data');
}

let store;
let reservationService;
let storageService;
let applicationService;
let excelDialogs;
let backupService;
let dashboardPngService;
let adminSmokeExportSelections = 0;

function runtimeDialog() {
  if (!isSmokeTest || process.env.BATTERY_CHANNEL_SMOKE_MODE !== 'admin') return dialog;
  return {
    showOpenDialog: options => dialog.showOpenDialog(options),
    showSaveDialog: async options => {
      if (String(options?.title || '').includes('导出')) {
        adminSmokeExportSelections += 1;
        if (adminSmokeExportSelections === 1) return { canceled: true };
        const filePath = process.env.BATTERY_CHANNEL_SMOKE_ADMIN_EXPORT;
        if (!filePath) throw new Error('Admin Smoke 缺少导出目标路径');
        return { canceled: false, filePath: path.resolve(filePath) };
      }
      return dialog.showSaveDialog(options);
    }
  };
}

function injectedPersistenceFailure(scope) {
  const configured = process.env.BATTERY_CHANNEL_SMOKE_PERSISTENCE_FAILURE;
  return isSmokeTest && (configured === '1' || configured === scope)
    ? {
        ok: false,
        code: 'SMOKE_INJECTED_PERSISTENCE_FAILURE',
        message: 'Smoke 注入：持久化失败，状态未保存'
      }
    : null;
}

function registerIpc() {
  ipcMain.handle('state:load', async () => {
    const result = await store.load();
    if (!result.ok) throw Object.assign(new Error(result.message), { code: result.code });
    return result.state;
  });
  ipcMain.handle('state:save', (_event, command) => {
    const injected = injectedPersistenceFailure('state');
    if (injected) return injected;
    return store.save(command || {});
  });
  ipcMain.handle('reservation:execute', (_event, command) => {
    const injected = injectedPersistenceFailure('reservation');
    if (injected) return injected;
    return reservationService.execute(command || {});
  });
  ipcMain.handle('storage:execute', (_event, command) => {
    const injected = injectedPersistenceFailure('storage');
    if (injected) return injected;
    return storageService.execute(command || {});
  });
  ipcMain.handle('application:execute', (_event, command) => {
    const injected = injectedPersistenceFailure('application');
    if (injected) return injected;
    return applicationService.execute(command || {});
  });
  ipcMain.handle('excel:import', () => excelDialogs.importFile());
  ipcMain.handle('excel:import-folder', () => excelDialogs.importFolder());
  ipcMain.handle('excel:export', (_event, payload) => excelDialogs.exportWorkbook(payload || {}));
  ipcMain.handle('dashboard:export-png', (_event, payload) => dashboardPngService.exportPng(payload || {}));
  ipcMain.handle('state:backup', () => backupService.backupState());
  ipcMain.handle('state:restore', (_event, command) => {
    const injected = injectedPersistenceFailure('restore');
    if (injected) return injected;
    return backupService.restoreState(command || {});
  });
}

function attachSmokeOrchestration(win) {
  if (!isSmokeTest) return;
  const smokeMode = process.env.BATTERY_CHANNEL_SMOKE_MODE || 'full-shell';
  const consoleErrors = [];
  const smokeTimeout = setTimeout(() => {
    process.stderr.write('Electron Smoke main timeout\n');
    app.exit(1);
  }, 22000);

  win.webContents.on('console-message', (_event, detailsOrLevel, legacyMessage) => {
    const details = typeof detailsOrLevel === 'object'
      ? detailsOrLevel
      : { level: detailsOrLevel, message: legacyMessage };
    if (details.level === 'error' || details.level === 3) {
      consoleErrors.push(String(details.message || 'unknown console error'));
    }
  });

  win.webContents.once('did-finish-load', async () => {
    try {
      let payload;
      if (smokeMode === 'full-shell') {
        payload = await win.webContents.executeJavaScript(`
        (async () => {
          const waitFor = async (predicate, label) => {
            const started = performance.now();
            while (performance.now() - started < 12000) {
              const value = predicate();
              if (value) return value;
              await new Promise(resolve => setTimeout(resolve, 25));
            }
            throw new Error('等待超时: ' + label);
          };

          await waitFor(() => typeof window.enterApp === 'function', 'legacy enterApp');
          const initialState = await window.batteryDesktop.loadState();
          document.getElementById('username').value = 'smoke-user';
          document.querySelector('#login .btn.wide').click();
          await waitFor(
            () => window.__batteryAppReady === true && document.getElementById('app')?.style.display !== 'none',
            'legacy application ready'
          );
          await waitFor(
            () => document.querySelector('.nav[data-page="testers"]'),
            'tester navigation'
          );

          const pages = [
            'dashboard', 'timeliness', 'apply', 'runningSamples', 'storageSamples',
            'reserved', 'requests', 'records', 'testers', 'devices'
          ];
          const navigationIds = [...document.querySelectorAll('.nav[data-page]')].map(nav => nav.dataset.page);
          const missingPages = [];
          for (const id of pages) {
            const nav = document.querySelector('.nav[data-page="' + id + '"]');
            const page = document.getElementById(id);
            if (!nav || !page) {
              missingPages.push(id);
              continue;
            }
            nav.click();
            await waitFor(() => page.classList.contains('active'), id + ' active');
          }

          const state = await window.batteryDesktop.loadState();
          return {
            pages,
            navigationIds,
            missingPages,
            disabledNavigation: document.querySelectorAll('.nav:disabled,.nav[aria-disabled="true"]').length,
            initialStateSummary: {
              revision: initialState.revision,
              devices: initialState.deviceProfiles.length,
              channels: initialState.channels.length,
               requests: initialState.requests.length,
               records: initialState.records.length,
               storageRecords: initialState.storageRecords.length
            },
            stateSummary: {
              revision: state.revision,
              devices: state.deviceProfiles.length,
              channels: state.channels.length,
               requests: state.requests.length,
               records: state.records.length,
               storageRecords: state.storageRecords.length
            }
          };
        })()
      `, true);
      } else if (smokeMode === 'reservation') {
        const phase = process.env.BATTERY_CHANNEL_SMOKE_PHASE || 'submit';
        const viewport = process.env.BATTERY_CHANNEL_SMOKE_VIEWPORT || '1366x768';
        payload = await win.webContents.executeJavaScript(`
          (async () => {
            const phase = ${JSON.stringify(phase)};
            const viewport = ${JSON.stringify(viewport)};
            const waitFor = async (predicate, label) => {
              const started = performance.now();
              while (performance.now() - started < 15000) {
                const value = predicate();
                if (value) return value;
                await new Promise(resolve => setTimeout(resolve, 25));
              }
              const message = document.querySelector('.legacy-inline-message')?.textContent || '';
              throw new Error('等待超时: ' + label + (message ? ' / ' + message : ''));
            };
            const setInput = (element, value) => {
              element.value = value;
              element.dispatchEvent(new Event('input', { bubbles: true }));
            };
            const summary = state => {
              const runningRecord = state.records.find(item => item.status === 'running');
              const managedRunningChannel = state.channels.find(item => item.specialCondition === '等待样品复核');
              const managedRunningRecord = state.records.find(item => item.id === managedRunningChannel?.currentRecordId);
              const runningChannel = managedRunningChannel || state.channels.find(item => item.currentRecordId === runningRecord?.id);
              return {
                revision: state.revision,
                records: state.records.length,
                reservedSamples: state.samples.filter(item => item.status === 'reserved').length,
                runningSamples: state.samples.filter(item => item.status === 'running').length,
                bookedChannels: state.channels.filter(item => item.state === 'booked').length,
                busyChannels: state.channels.filter(item => item.state === 'busy').length,
                runningEnd: managedRunningRecord?.end || runningRecord?.end || '',
                runningCondition: runningChannel?.specialCondition || ''
              };
            };

            await waitFor(() => typeof window.enterApp === 'function', 'legacy enterApp');
            document.getElementById('username').value = 'smoke-user';
            document.querySelector('#login .btn.wide').click();
            await waitFor(
              () => window.__batteryAppReady === true && document.getElementById('app')?.style.display !== 'none',
              'legacy application ready'
            );

            if (phase === 'verify') {
              return { viewport, persisted: summary(await window.batteryDesktop.loadState()) };
            }

            const defaultBoardCards = document.querySelectorAll('[data-testid="bounded-channel-card"]').length;
            const hiddenRecordRows = document.querySelectorAll('[data-testid="bounded-record-row"]').length;
            const hiddenChannelRows = document.querySelectorAll('[data-testid="bounded-channel-row"]').length;
            document.querySelector('.nav[data-page="apply"]').click();
            await waitFor(() => document.querySelector('[data-testid="legacy-reservation-workspace"]'), 'reservation workspace');
            const defaultDetailsPresent = Boolean(document.querySelector('[data-testid="legacy-reservation-details"]'));

            setInput(document.querySelector('[data-legacy-action="search-requests"]'), '无人机');
            document.querySelector('[data-legacy-action="select-request"]').click();
            const details = await waitFor(() => document.querySelector('[data-testid="legacy-reservation-details"]'), 'details open');
            const workspace = document.querySelector('[data-testid="legacy-reservation-workspace"]');
            const list = document.querySelector('.legacy-reservation-list');
            const workspaceWidth = workspace.getBoundingClientRect().width;
            const listRect = list.getBoundingClientRect();
            const detailsRect = details.getBoundingClientRect();
            const splitColumns = detailsRect.left > listRect.left;
            const detailsNarrowerThanList = detailsRect.width < listRect.width;
            const sampleRows = document.querySelectorAll('[data-testid="legacy-sample-row"]').length;

            const startBeforeClick = document.querySelector('[data-legacy-action="start-time"]');
            startBeforeClick.focus();
            startBeforeClick.click();
            const editableControlSurvivedClick = startBeforeClick.isConnected;
            const clickedControlFocused = document.activeElement === startBeforeClick;
            const startMode = document.querySelector('[data-legacy-action="mode"][value="start"]');
            startMode.click();
            const executionModeChangedByClick = document.querySelector('[data-legacy-action="mode"][value="start"]')?.checked === true;
            document.querySelector('[data-legacy-action="mode"][value="reserve"]').click();

            const persistedBeforeSync = await window.batteryDesktop.loadState();
            const synthetic = structuredClone(persistedBeforeSync);
            synthetic.requests.push({ id: 'REQ-SYNC-PROBE', qty: 1, test: '同步探针', project: '自动测试', sample: 'N/A' });
            window.adoptLegacyApplicationState(synthetic);
            const mountedWorkspaceSynced = window.__legacyReservationWorkspace.getState().requests.some(item => item.id === 'REQ-SYNC-PROBE');
            window.adoptLegacyApplicationState(persistedBeforeSync);

            if (phase === 'layout') {
              return {
                viewport,
                innerWidth: window.innerWidth,
                workspaceWidth,
                defaultDetailsPresent,
                defaultBoardCards,
                hiddenRecordRows,
                hiddenChannelRows,
                openedDetails: true,
                splitColumns,
                detailsNarrowerThanList,
                sampleRows,
                editableControlSurvivedClick,
                clickedControlFocused,
                executionModeChangedByClick,
                mountedWorkspaceSynced
              };
            }

            document.querySelector('[data-legacy-action="close-details"]').click();
            await waitFor(() => !document.querySelector('[data-testid="legacy-reservation-details"]'), 'details closed');
            const closedDetailsPresent = Boolean(document.querySelector('[data-testid="legacy-reservation-details"]'));
            const searchRetained = document.querySelector('[data-legacy-action="search-requests"]').value;

            document.querySelector('[data-legacy-action="select-request"]').click();
            await waitFor(() => document.querySelector('[data-testid="legacy-reservation-details"]'), 'details reopened');
            document.querySelector('[data-legacy-action="open-channel-picker"]').click();
            await waitFor(() => document.querySelector('[data-testid="legacy-channel-picker"]'), 'channel picker');
            const channelOptions = document.querySelectorAll('[data-testid="legacy-channel-option"]').length;
            const firstPageKeys = [...document.querySelectorAll('[data-testid="legacy-channel-option"]')].map(item => item.dataset.channelKey);
            const detailsScrollBeforePage = document.querySelector('.legacy-details-scroll');
            const channelListBeforePage = document.querySelector('.legacy-channel-options');
            detailsScrollBeforePage.scrollTop = detailsScrollBeforePage.scrollHeight;
            channelListBeforePage.scrollTop = channelListBeforePage.scrollHeight;
            const channelOuterScrollBefore = detailsScrollBeforePage.scrollTop;
            document.querySelector('[data-legacy-action="channel-next"]')?.click();
            const secondPageKeys = [...document.querySelectorAll('[data-testid="legacy-channel-option"]')].map(item => item.dataset.channelKey);
            const channelPagesDisjoint = firstPageKeys.every(key => !secondPageKeys.includes(key));
            const channelOuterScrollAfter = document.querySelector('.legacy-details-scroll')?.scrollTop ?? -1;
            const channelInnerScrollAfter = document.querySelector('.legacy-channel-options')?.scrollTop ?? -1;
            document.querySelector('[data-testid="legacy-channel-option"]:not(:disabled)').click();
            setInput(document.querySelector('[data-legacy-action="start-time"]'), '2026-08-21T10:00');
            setInput(document.querySelector('[data-legacy-action="end-time"]'), '2026-08-21T12:00');
            const beforeFailure = phase === 'failure' ? summary(await window.batteryDesktop.loadState()) : null;
            document.querySelector('[data-legacy-action="submit-operation"]').click();
            if (phase === 'failure') {
              const failureMessage = await waitFor(() => document.querySelector('.legacy-inline-message.error')?.textContent, 'visible persistence failure');
              return {
                viewport,
                detailsOpen: Boolean(document.querySelector('[data-testid="legacy-reservation-details"]')),
                message: failureMessage,
                beforeFailure,
                saved: summary(await window.batteryDesktop.loadState())
              };
            }
            await waitFor(() => !document.querySelector('[data-testid="legacy-reservation-details"]'), 'reservation saved');
            const savedState = await window.batteryDesktop.loadState();
            if (phase !== 'management') return { viewport, saved: summary(savedState) };
            const firstRecord = savedState.records[0];
            const firstChannelKey = firstRecord.channelKey || firstRecord.keys?.[0];
            const startedResult = await window.batteryDesktop.executeReservation({
              type: 'transition',
              payload: {
                action: 'start',
                channelKey: firstChannelKey,
                actor: 'smoke-user',
                auditId: 'AUDIT-SMOKE-START',
                now: '2026-08-21T12:05:00.000Z'
              }
            });
            if (!startedResult.ok) throw new Error('启动已预约测试失败: ' + startedResult.message);
            const secondSample = startedResult.state.samples.find(item => item.status === 'pending');
            const secondChannel = startedResult.state.channels.find(item => item.state === 'free');
            const reservedResult = await window.batteryDesktop.executeReservation({
              type: 'reserve',
              payload: {
                requestNo: 'REQ-SMOKE-001',
                start: '2026-08-22T10:00:00.000Z',
                end: '2026-08-22T12:00:00.000Z',
                actor: 'smoke-user',
                now: '2026-08-21T12:06:00.000Z',
                acceptWarning: false,
                items: [{
                  sampleId: secondSample.id,
                  channelKey: secondChannel.key,
                  recordId: 'REC-SMOKE-RESERVED-SECOND',
                  auditId: 'AUDIT-SMOKE-RESERVED-SECOND'
                }]
              }
            });
            if (!reservedResult.ok) throw new Error('准备预约待办失败: ' + reservedResult.message);
            window.adoptLegacyApplicationState(reservedResult.state);
            document.querySelector('.nav[data-page="dashboard"]').click();
            await waitFor(() => document.getElementById('dashboard')?.classList.contains('active'), 'dashboard running management');
            const runningChannel = reservedResult.state.channels.find(item => item.key === firstChannelKey);
            const runningRecord = reservedResult.state.records.find(item => item.id === runningChannel.currentRecordId);
            const runningDeviceGroup = [...document.querySelectorAll('[data-testid="bounded-board-device"]')]
              .find(item => decodeURIComponent(item.dataset.device) === runningChannel.device);
            runningDeviceGroup.querySelector('[data-bounded-action="toggle-device"]').click();
            const runningManageButton = await waitFor(
              () => document.querySelector(
                '[data-bounded-action="manage-running"][data-channel-key="' + encodeURIComponent(firstChannelKey) + '"]'
              ),
              'running channel management action'
            );
            const runningSampleVisible = runningManageButton.closest('[data-testid="bounded-channel-card"]')?.textContent.includes(runningRecord.sampleId) === true;
            runningManageButton.click();
            await waitFor(
              () => document.getElementById('devices')?.classList.contains('active') && document.getElementById('channelEditor')?.style.display === 'block',
              'running channel editor'
            );
            const runningEditorOpened = true;
            const runningEditorTitle = document.getElementById('channelEditorTitle')?.textContent || '';
            const runningEditorLocked = ['cDevice', 'cName', 'cType', 'cTemp', 'cVoltage', 'cCurrent', 'cStatus', 'cNote']
              .every(id => document.getElementById(id)?.disabled === true);
            document.getElementById('cEnd').value = '2026-08-21T15:30';
            document.getElementById('cCondition').value = '等待样品复核';
            await window.saveChannel();
            const managedState = await window.batteryDesktop.loadState();
            const managedChannel = managedState.channels.find(item => item.key === firstChannelKey);
            const managedRecord = managedState.records.find(item => item.id === runningRecord.id);
            const managedSample = managedState.samples.find(item => item.id === runningRecord.sampleId);
            const runningManagementPersisted = managedChannel.end === '2026-08-21T15:30' &&
              managedRecord.end === '2026-08-21T15:30' && managedSample.end === '2026-08-21T15:30' &&
              managedChannel.specialCondition === '等待样品复核';
            const runningManagementAudited = managedState.auditLogs.some(item =>
              item.action === '修改通道' && String(item.target || '').includes(firstChannelKey)
            );
            const runningLinkagePreserved = managedChannel.state === 'busy' &&
              managedChannel.currentRecordId === runningRecord.id && managedRecord.status === 'running' &&
              (managedRecord.channelKey === firstChannelKey || managedRecord.keys?.includes(firstChannelKey));
            document.querySelector('.nav[data-page="records"]').click();
            await waitFor(() => document.getElementById('records')?.classList.contains('active'), 'running usage record');
            const runningUsageRow = [...document.querySelectorAll('[data-testid="bounded-record-row"]')]
              .find(item => item.textContent.includes(runningRecord.sampleId));
            const runningUsageManagePresent = Boolean(runningUsageRow?.querySelector('[data-bounded-action="manage-running"]'));
            const dashboardProbe = structuredClone(managedState);
            window.adoptLegacyApplicationState(dashboardProbe);
            document.querySelector('.nav[data-page="dashboard"]').click();
            await waitFor(() => document.getElementById('dashboard')?.classList.contains('active'), 'dashboard after reservation');
            const expandedRunningDevice = [...document.querySelectorAll('[data-testid="bounded-board-device"]')]
              .find(item => decodeURIComponent(item.dataset.device) === runningChannel.device);
            const collapseRunningDevice = expandedRunningDevice?.querySelector('[data-bounded-action="toggle-device"]');
            if (collapseRunningDevice?.textContent.includes('收起')) collapseRunningDevice.click();
            const dashboardScrollY = window.scrollY;
            const dashboardTimelinessAbsent = !document.querySelector('#dashboard #dashboardTrendPanel') && !document.querySelector('#dashboard #timelyRateNum');
            const dashboardFiltersPresent = Boolean(document.getElementById('dashboardBoardFilter'));
            const reservationTodoItems = document.querySelectorAll('.dashboard-todo').length;
            const dashboardDefaultCardsAfterSave = document.querySelectorAll('[data-testid="bounded-channel-card"]').length;
            setInput(document.querySelector('[data-dashboard-filter="max-current"]'), '100');
            const dashboardFilteredCount = Number(/显示 (\\d+)/.exec(document.getElementById('dashboardFilterCount')?.textContent || '')?.[1]);
            const dashboardScrollAfterFilter = window.scrollY;
            const reservationTodoDetail = document.querySelector('[data-dashboard-action="todo-detail"]');
            const reservationTodoRecordIndex = Number(reservationTodoDetail?.dataset.recordIndex);
            const reservationTodoRecordBefore = dashboardProbe.records[reservationTodoRecordIndex];
            reservationTodoDetail.click();
            await waitFor(() => document.getElementById('reserved')?.classList.contains('active'), 'reserved TODO detail');
            const reservationTodoFocusedRow = document.querySelector('.reserved-focus');
            const reservationTodoDetailFocused = Boolean(reservationTodoFocusedRow);
            const reservationTodoStartButton = reservationTodoFocusedRow?.querySelector('[data-res-start]');
            const reservationTodoCancelButton = reservationTodoFocusedRow?.querySelector('[data-res-cancel]');
            const reservationTodoStartPresent = Boolean(reservationTodoStartButton);
            const reservationTodoCancelPresent = Boolean(reservationTodoCancelButton);
            reservationTodoStartButton?.click();
            await waitFor(
              () => !document.querySelector('[data-reserved-row="' + reservationTodoRecordIndex + '"]'),
              'reserved TODO start action'
            );
            let reservationTodoActionState = await window.batteryDesktop.loadState();
            const reservationTodoDeadline = performance.now() + 3000;
            while (performance.now() < reservationTodoDeadline) {
              const persistedRecord = reservationTodoActionState.records.find(item =>
                item.id === reservationTodoRecordBefore?.id ||
                (item.sampleId === reservationTodoRecordBefore?.sampleId && item.channelKey === reservationTodoRecordBefore?.channelKey)
              );
              if (persistedRecord?.status === 'running') break;
              await new Promise(resolve => setTimeout(resolve, 50));
              reservationTodoActionState = await window.batteryDesktop.loadState();
            }
            const reservationTodoRecord = reservationTodoActionState.records.find(item =>
              item.id === reservationTodoRecordBefore?.id ||
              (item.sampleId === reservationTodoRecordBefore?.sampleId && item.channelKey === reservationTodoRecordBefore?.channelKey)
            );
            const reservationTodoSample = reservationTodoActionState.samples.find(item => item.id === reservationTodoRecordBefore?.sampleId);
            const reservationTodoChannel = reservationTodoActionState.channels.find(item => item.key === reservationTodoRecordBefore?.channelKey);
            const reservationTodoActionPersisted = reservationTodoActionState.revision > managedState.revision;
            const reservationTodoRecordRunning = reservationTodoRecord?.status === 'running';
            const reservationTodoSampleRunning = reservationTodoSample?.status === 'running';
            const reservationTodoChannelBusy = reservationTodoChannel?.state === 'busy' &&
              reservationTodoChannel?.currentRecordId === reservationTodoRecordBefore?.id;
            const reservationTodoRemoved = !reservationTodoActionState.records.some(item => item.status === 'reserved');
            const reservationTodoStartAudited = reservationTodoActionState.auditLogs.some(item =>
              item.action === '开始预约测试' && String(item.target || '').includes(reservationTodoRecordBefore?.channelKey || '')
            );
            const reservationTodoRecentAudits = reservationTodoActionState.auditLogs.slice(0, 3).map(item => ({
              action: item.action,
              target: item.target,
              requestNo: item.requestNo
            }));
            const cancelSample = reservationTodoActionState.samples.find(item => item.status === 'pending');
            const cancelChannel = reservationTodoActionState.channels.find(item => item.state === 'free');
            const cancelReservation = await window.batteryDesktop.executeReservation({
              type: 'reserve',
              payload: {
                requestNo: 'REQ-SMOKE-001',
                start: '2026-08-23T10:00:00.000Z',
                end: '2026-08-23T12:00:00.000Z',
                actor: 'smoke-user',
                now: '2026-08-21T12:07:00.000Z',
                acceptWarning: false,
                items: [{
                  sampleId: cancelSample.id,
                  channelKey: cancelChannel.key,
                  recordId: 'REC-SMOKE-TODO-CANCEL',
                  auditId: 'AUDIT-SMOKE-TODO-CANCEL-RESERVE'
                }]
              }
            });
            if (!cancelReservation.ok) throw new Error('准备取消预约待办失败: ' + cancelReservation.message);
            window.adoptLegacyApplicationState(cancelReservation.state);
            document.querySelector('.nav[data-page="dashboard"]').click();
            await waitFor(
              () => document.getElementById('dashboard')?.classList.contains('active') && document.querySelector('[data-dashboard-action="todo-detail"]'),
              'dashboard cancel TODO'
            );
            const cancelTodoDetail = document.querySelector('[data-dashboard-action="todo-detail"]');
            const cancelTodoRecordIndex = Number(cancelTodoDetail.dataset.recordIndex);
            cancelTodoDetail.click();
            await waitFor(
              () => document.getElementById('reserved')?.classList.contains('active') && document.querySelector('.reserved-focus [data-res-cancel]'),
              'reserved cancel TODO detail'
            );
            const originalConfirm = window.confirm;
            window.confirm = () => true;
            document.querySelector('.reserved-focus [data-res-cancel]').click();
            window.confirm = originalConfirm;
            await waitFor(
              () => !document.querySelector('[data-reserved-row="' + cancelTodoRecordIndex + '"]'),
              'reserved TODO cancel action'
            );
            let reservationTodoCancelState = await window.batteryDesktop.loadState();
            const reservationTodoCancelDeadline = performance.now() + 3000;
            while (performance.now() < reservationTodoCancelDeadline) {
              const persistedRecord = reservationTodoCancelState.records.find(item => item.id === 'REC-SMOKE-TODO-CANCEL');
              if (persistedRecord?.status === 'cancelled') break;
              await new Promise(resolve => setTimeout(resolve, 50));
              reservationTodoCancelState = await window.batteryDesktop.loadState();
            }
            const reservationTodoCancelRecord = reservationTodoCancelState.records.find(item => item.id === 'REC-SMOKE-TODO-CANCEL');
            const reservationTodoCancelSample = reservationTodoCancelState.samples.find(item => item.id === cancelSample.id);
            const reservationTodoCancelChannel = reservationTodoCancelState.channels.find(item => item.key === cancelChannel.key);
            const reservationTodoCancelActionPersisted = reservationTodoCancelState.revision > cancelReservation.state.revision;
            const reservationTodoCancelRecordCancelled = reservationTodoCancelRecord?.status === 'cancelled';
            const reservationTodoCancelSampleCancelled = reservationTodoCancelSample?.status === 'cancelled';
            const reservationTodoCancelChannelReleased = reservationTodoCancelChannel?.state === 'free' &&
              !reservationTodoCancelChannel?.currentRecordId && !reservationTodoCancelChannel?.nextRecordId;
            const reservationTodoCancelRemoved = !reservationTodoCancelState.records.some(item => item.status === 'reserved');
            const reservationTodoCancelAudited = reservationTodoCancelState.auditLogs.some(item =>
              item.action === '取消预约' && String(item.target || '').includes(cancelChannel.key)
            );
            document.querySelector('.nav[data-page="dashboard"]').click();
            await waitFor(() => document.getElementById('dashboard')?.classList.contains('active'), 'dashboard restored');
            const dashboardReturnScrollY = window.scrollY;
            const timelinessNav = document.querySelector('.nav[data-page="timeliness"]');
            timelinessNav?.click();
            if (timelinessNav) await waitFor(() => document.getElementById('timeliness')?.classList.contains('active'), 'timeliness page');
            const timelinessPanelPresent = Boolean(document.getElementById('timelinessTrendPanel'));
            const timelinessNavActive = timelinessNav?.classList.contains('active') === true;
            const timelinessRate = document.getElementById('timelyRateNum')?.textContent || '';
            const timelinessKnown = Number(document.getElementById('timelyKnown')?.textContent);
            const timelinessMissingPlan = Number(document.getElementById('missingPlanCount')?.textContent);
            const timelinessDateControls = document.querySelectorAll('#timeliness [data-timeliness-filter]').length;
            const timelinessExportPresent = Boolean(document.querySelector('#timeliness [data-timeliness-action="export-png"]'));

            return {
              viewport,
              innerWidth: window.innerWidth,
              workspaceWidth,
              defaultDetailsPresent,
              defaultBoardCards,
              hiddenRecordRows,
              hiddenChannelRows,
              openedDetails: true,
              splitColumns,
              detailsNarrowerThanList,
              closedDetailsPresent,
              searchRetained,
              sampleRows,
              channelOptions,
              channelPagesDisjoint,
              channelOuterScrollBefore,
              channelOuterScrollAfter,
              channelInnerScrollAfter,
              editableControlSurvivedClick,
              clickedControlFocused,
              executionModeChangedByClick,
              mountedWorkspaceSynced,
              runningSampleVisible,
              runningEditorOpened,
              runningEditorTitle,
              runningEditorLocked,
              runningManagementPersisted,
              runningManagementAudited,
              runningLinkagePreserved,
              runningUsageManagePresent,
              dashboardTimelinessAbsent,
              dashboardFiltersPresent,
              reservationTodoItems,
              dashboardDefaultCardsAfterSave,
              dashboardFilteredCount,
              dashboardScrollY,
              dashboardScrollAfterFilter,
              reservationTodoDetailFocused,
              reservationTodoStartPresent,
              reservationTodoCancelPresent,
              reservationTodoActionPersisted,
              reservationTodoRecordRunning,
              reservationTodoSampleRunning,
              reservationTodoChannelBusy,
              reservationTodoRemoved,
              reservationTodoStartAudited,
              reservationTodoRecentAudits,
              postTodo: summary(reservationTodoActionState),
              reservationTodoCancelActionPersisted,
              reservationTodoCancelRecordCancelled,
              reservationTodoCancelSampleCancelled,
              reservationTodoCancelChannelReleased,
              reservationTodoCancelRemoved,
              reservationTodoCancelAudited,
              dashboardReturnScrollY,
              timelinessPanelPresent,
              timelinessNavActive,
              timelinessRate,
              timelinessKnown,
              timelinessMissingPlan,
              timelinessDateControls,
              timelinessExportPresent,
              saved: summary(managedState)
            };
          })()
        `, true);
       } else if (smokeMode === 'storage') {
         const phase = process.env.BATTERY_CHANNEL_SMOKE_PHASE || 'start';
         payload = await win.webContents.executeJavaScript(`
           (async () => {
             const phase = ${JSON.stringify(phase)};
             const waitFor = async (predicate, label) => {
               const started = performance.now();
               while (performance.now() - started < 15000) {
                 const value = await predicate();
                 if (value) return value;
                 await new Promise(resolve => setTimeout(resolve, 25));
               }
               const message = document.querySelector('.legacy-inline-message')?.textContent || '';
               throw new Error('等待超时: ' + label + (message ? ' / ' + message : ''));
             };
             const setInput = (element, value) => {
               element.value = value;
               element.dispatchEvent(new Event('input', { bubbles: true }));
             };
             const storageCommand = (type, payload) => window.batteryDesktop.executeStorage({ type, payload });
             const metadata = suffix => ({
               actor: 'smoke-user',
               auditId: 'AUDIT-SMOKE-' + suffix,
               now: '2026-08-28T10:00:00.000Z'
             });
             const adopt = state => window.adoptLegacyApplicationState(state);
             const navigate = async id => {
               document.querySelector('.nav[data-page="' + id + '"]').click();
               await waitFor(() => document.getElementById(id)?.classList.contains('active'), id + ' page');
             };
             const visibleSampleIds = testId => [...document.querySelectorAll('[data-testid="' + testId + '"]')]
               .map(row => row.children[1]?.textContent?.trim() || '')
               .filter(Boolean);
             const submitWorkbenchForm = async values => {
               const dialog = await waitFor(() => {
                 const candidate = document.getElementById('sampleWorkbenchDialog');
                 return candidate?.open ? candidate : null;
               }, 'sample workbench form');
               for (const [name, value] of Object.entries(values)) {
                 const field = dialog.querySelector('[data-workbench-field="' + name + '"]');
                 if (!field) throw new Error('缺少样品工作台字段：' + name);
                 field.value = value;
                 field.dispatchEvent(new Event('input', { bubbles: true }));
                 field.dispatchEvent(new Event('change', { bubbles: true }));
               }
               dialog.querySelector('[data-workbench-submit]').click();
             };

             await waitFor(() => typeof window.enterApp === 'function', 'legacy enterApp');
             document.getElementById('username').value = 'smoke-user';
             document.querySelector('#login .btn.wide').click();
             await waitFor(
               () => window.__batteryAppReady === true && document.getElementById('app')?.style.display !== 'none',
               'legacy application ready'
             );
             await waitFor(() => window.__legacySampleWorkbenches, 'sample workbenches');

             if (phase === 'start') {
               const result = await storageCommand('startStorage', {
                 storageId: 'STO-SMOKE-LIFECYCLE',
                 requestNo: 'REQ-SMOKE-STORAGE',
                 sampleIds: ['REQ-SMOKE-STORAGE.001'],
                 tester: 'smoke-user',
                 expectedEndAt: '2026-09-28T10:00:00.000Z',
                 note: 'Smoke 生命周期',
                 ...metadata('STORAGE-START')
               });
               if (!result?.ok) throw new Error(result?.message || '长期存储开始失败');
               adopt(result.state);
               await navigate('storageSamples');
               const search = document.querySelector('[data-sample-filter="storage"]');
               setInput(search, '  req-smoke-storage.001  ');
               await waitFor(() => visibleSampleIds('storage-sample-row').length === 1, 'storage exact search');
               return {
                 activePage: document.querySelector('.page.active')?.id || '',
                 visibleSampleIds: visibleSampleIds('storage-sample-row'),
                 storageStatus: result.state.storageRecords.find(item => item.id === 'STO-SMOKE-LIFECYCLE')?.status
               };
             }

             if (phase === 'exception') {
               await navigate('storageSamples');
               document.querySelector('[data-sample-action="storage-edit"][data-storage-id="STO-SMOKE-LIFECYCLE"]').click();
               await submitWorkbenchForm({
                 status: 'exception',
                 expectedEndAt: '2026-09-30T10:00',
                 note: 'Smoke 异常更新'
               });
               const state = await waitFor(async () => {
                 const current = await window.batteryDesktop.loadState();
                 return current.storageRecords.find(item => item.id === 'STO-SMOKE-LIFECYCLE')?.status === 'exception'
                   ? current
                   : null;
               }, 'storage exception persisted');
               return {
                 activePage: document.querySelector('.page.active')?.id || '',
                 storageStatus: state.storageRecords.find(item => item.id === 'STO-SMOKE-LIFECYCLE')?.status,
                 sampleStatus: state.samples.find(item => item.id === 'REQ-SMOKE-STORAGE.001')?.status
               };
             }

             if (phase === 'finish') {
               await navigate('storageSamples');
               window.confirm = () => true;
               document.querySelector('[data-sample-action="storage-finish"][data-storage-id="STO-SMOKE-LIFECYCLE"]').click();
               const state = await waitFor(async () => {
                 const current = await window.batteryDesktop.loadState();
                 return current.storageRecords.find(item => item.id === 'STO-SMOKE-LIFECYCLE')?.status === 'completed'
                   ? current
                   : null;
               }, 'storage finish persisted');
               return {
                 activePage: document.querySelector('.page.active')?.id || '',
                 storageStatus: state.storageRecords.find(item => item.id === 'STO-SMOKE-LIFECYCLE')?.status,
                 sampleStatus: state.samples.find(item => item.id === 'REQ-SMOKE-STORAGE.001')?.status
               };
             }

             if (phase === 'returns') {
               const started = await storageCommand('startStorage', {
                 storageId: 'STO-SMOKE-RETURN',
                 requestNo: 'REQ-SMOKE-STORAGE-RETURN',
                 sampleIds: ['REQ-SMOKE-STORAGE-RETURN.001'],
                 tester: 'smoke-user',
                 expectedEndAt: '2026-09-28T10:00:00.000Z',
                 note: 'Smoke 退回',
                 ...metadata('STORAGE-RETURN-START')
               });
               if (!started?.ok) throw new Error(started?.message || '退回用长期存储开始失败');
               adopt(started.state);

               await navigate('runningSamples');
               setInput(document.querySelector('[data-sample-filter="running"]'), '  req-smoke-running.001  ');
               await waitFor(() => visibleSampleIds('running-sample-row').length === 1, 'running exact search');
               const runningIds = visibleSampleIds('running-sample-row');
               document.querySelector('[data-sample-action="running-return"][data-record-id="REC-SMOKE-RUNNING"]').click();
               await submitWorkbenchForm({ reason: '普通测试退回 Smoke' });
               await waitFor(async () => {
                 const current = await window.batteryDesktop.loadState();
                 return current.records.find(item => item.id === 'REC-SMOKE-RUNNING')?.status === 'returned';
               }, 'running return persisted');

               await navigate('storageSamples');
               setInput(document.querySelector('[data-sample-filter="storage"]'), '  req-smoke-storage-return.001  ');
               await waitFor(() => visibleSampleIds('storage-sample-row').length === 1, 'storage return exact search');
               const storageIds = visibleSampleIds('storage-sample-row');
               document.querySelector('[data-sample-action="storage-return"][data-storage-id="STO-SMOKE-RETURN"]').click();
               await submitWorkbenchForm({ reason: '长期存储退回 Smoke' });
               const returned = await waitFor(async () => {
                 const current = await window.batteryDesktop.loadState();
                 return current.storageRecords.find(item => item.id === 'STO-SMOKE-RETURN')?.status === 'returned'
                   ? current
                   : null;
               }, 'storage return persisted');
               const channel = returned.channels.find(item => item.nextRecordId === 'REC-SMOKE-NEXT');
               return {
                 activePage: document.querySelector('.page.active')?.id || '',
                 runningVisibleSampleIds: runningIds,
                 storageVisibleSampleIds: storageIds,
                 currentRecordId: channel?.currentRecordId || '',
                 nextRecordId: channel?.nextRecordId || ''
               };
             }

             if (phase === 'failure') {
               const before = await window.batteryDesktop.loadState();
               const result = await storageCommand('startStorage', {
                 storageId: 'STO-SMOKE-FAILURE',
                 requestNo: 'REQ-SMOKE-STORAGE',
                 sampleIds: ['REQ-SMOKE-STORAGE.001'],
                 tester: 'smoke-user',
                 expectedEndAt: '2026-09-28T10:00:00.000Z',
                 note: 'Smoke 注入失败',
                 ...metadata('STORAGE-FAILURE')
               });
               const after = await window.batteryDesktop.loadState();
               return {
                 ok: result?.ok === true,
                 code: result?.code || '',
                 stateUnchanged: JSON.stringify(before) === JSON.stringify(after)
               };
             }

             throw new Error('Unsupported storage Smoke phase: ' + phase);
           })()
         `, true);
       } else if (smokeMode === 'admin') {
        const phase = process.env.BATTERY_CHANNEL_SMOKE_PHASE || 'submit';
        payload = await win.webContents.executeJavaScript(`
          (async () => {
            const phase = ${JSON.stringify(phase)};
            const waitFor = async (predicate, label) => {
              const started = performance.now();
              while (performance.now() - started < 15000) {
                const value = predicate();
                if (value) return value;
                await new Promise(resolve => setTimeout(resolve, 25));
              }
              throw new Error('等待超时: ' + label);
            };
            const setInput = (element, value) => {
              element.value = value;
              element.dispatchEvent(new Event('input', { bubbles: true }));
              element.dispatchEvent(new Event('change', { bubbles: true }));
            };
            const typeIncrementally = (selector, value) => {
              for (const character of value) {
                const input = document.querySelector(selector);
                input.focus();
                const start = input.selectionStart ?? input.value.length;
                const end = input.selectionEnd ?? start;
                input.setRangeText(character, start, end, 'end');
                input.dispatchEvent(new InputEvent('input', {
                  bubbles: true,
                  data: character,
                  inputType: 'insertText'
                }));
              }
              return document.querySelector(selector);
            };

            await waitFor(() => typeof window.enterApp === 'function', 'legacy enterApp');
            document.getElementById('username').value = 'smoke-admin';
            document.querySelector('#login .btn.wide').click();
            await waitFor(
              () => window.__batteryAppReady === true && document.getElementById('app')?.style.display !== 'none',
              'legacy application ready'
            );
            window.confirm = () => true;

            if (phase === 'verify') {
              const state = await window.batteryDesktop.loadState();
              const request = state.requests.find(item => item.id === 'REQ-ADMIN-001');
              return {
                revision: state.revision,
                rawFields: request?.rawFields || null,
                sourceFile: request?.sourceFile || '',
                sourcePath: request?.sourcePath || '',
                execution: request?.execution || null,
                temporaryTesterPresent: state.testers.some(item => item.name === '临时测试员'),
                exportSuccessAudits: state.auditLogs.filter(item => item.action === '导出申请汇总' && item.outcome === 'success').length,
                formJournalEntries: state.formChangeJournal.filter(item => item.requestId === 'REQ-ADMIN-001').length
              };
            }

            const initial = await window.batteryDesktop.loadState();
            const rawBefore = JSON.stringify(initial.requests.find(item => item.id === 'REQ-ADMIN-001').rawFields);
            document.querySelector('.nav[data-page="requests"]').click();
            await waitFor(() => document.getElementById('requests')?.classList.contains('active'), 'requests page');
            window.editRequest(encodeURIComponent('REQ-ADMIN-001'));
            await waitFor(() => document.getElementById('eTester'), 'execution editor');
            setInput(document.getElementById('eTester'), '执行测试员 B');
            setInput(document.getElementById('eFee'), '25');
            setInput(document.getElementById('eNote'), 'Smoke 执行字段');
            await window.saveRequestEdit();
            const edited = await waitFor(async () => {
              const state = await window.batteryDesktop.loadState();
              return state.requests.find(item => item.id === 'REQ-ADMIN-001')?.execution?.tester === '执行测试员 B' ? state : null;
            }, 'request edit persisted');

            document.querySelector('.nav[data-page="testers"]').click();
            await waitFor(() => document.getElementById('testers')?.classList.contains('active'), 'testers page');
            window.openTesterEditor();
            setInput(document.getElementById('tName'), '临时测试员');
            setInput(document.getElementById('tDept'), 'Smoke 部门');
            await window.saveTester();
            const withTester = await waitFor(async () => {
              const state = await window.batteryDesktop.loadState();
              return state.testers.find(item => item.name === '临时测试员') ? state : null;
            }, 'tester added');
            const temporaryTester = withTester.testers.find(item => item.name === '临时测试员');
            await window.deleteTester(encodeURIComponent(temporaryTester.id));
            await waitFor(async () => {
              const state = await window.batteryDesktop.loadState();
              return state.testers.some(item => item.name === '临时测试员') ? null : state;
            }, 'tester deleted');

            document.querySelector('.nav[data-page="requests"]').click();
            const beforeCancel = await window.batteryDesktop.loadState();
            await window.exportRequests();
            const afterCancel = await window.batteryDesktop.loadState();
            await window.exportRequests();
            const afterExport = await window.batteryDesktop.loadState();

            document.querySelector('.nav[data-page="records"]').click();
            await waitFor(() => document.getElementById('records')?.classList.contains('active'), 'records page');
            document.querySelector('.nav[data-page="devices"]').click();
            await waitFor(() => document.getElementById('devices')?.classList.contains('active'), 'devices page');
            const channelFilterSelector = '[data-bounded-filter="channels"]';
            const typedChannelFilter = typeIncrementally(channelFilterSelector, 'zhong');
            const channelFilterText = typedChannelFilter.value;
            const channelFilterCaret = typedChannelFilter.selectionStart;
            setInput(typedChannelFilter, '');
            const composingChannelFilter = document.querySelector(channelFilterSelector);
            composingChannelFilter.focus();
            composingChannelFilter.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
            composingChannelFilter.value = '中文';
            composingChannelFilter.setSelectionRange(2, 2);
            composingChannelFilter.dispatchEvent(new InputEvent('input', {
              bubbles: true,
              data: '中文',
              inputType: 'insertCompositionText',
              isComposing: true
            }));
            const channelCompositionTargetPreserved = composingChannelFilter.isConnected;
            const channelCompositionText = document.querySelector(channelFilterSelector)?.value || '';

            const request = afterExport.requests.find(item => item.id === 'REQ-ADMIN-001');
            return {
              rawUnchanged: JSON.stringify(request.rawFields) === rawBefore,
              sourceFile: request.sourceFile,
              sourcePath: request.sourcePath,
              execution: request.execution,
              temporaryTesterPresent: afterExport.testers.some(item => item.name === '临时测试员'),
              cancelRevisionDelta: afterCancel.revision - beforeCancel.revision,
              cancelAuditDelta: afterCancel.auditLogs.length - beforeCancel.auditLogs.length,
              exportSuccessAudits: afterExport.auditLogs.filter(item => item.action === '导出申请汇总' && item.outcome === 'success').length,
              exportVerified: afterExport.auditLogs.some(item => item.action === '导出申请汇总' && item.verified === true),
              formJournalEntries: afterExport.formChangeJournal.filter(item => item.requestId === 'REQ-ADMIN-001').length,
              channelFilterText,
              channelFilterCaret,
              channelCompositionTargetPreserved,
              channelCompositionText,
              pagesVisited: ['requests', 'testers', 'records', 'devices']
            };
          })()
        `, true);
      } else {
        throw new Error(`Unsupported legacy Smoke mode: ${smokeMode}`);
      }

      if (process.env.BATTERY_CHANNEL_SMOKE_SCREENSHOT) {
        const screenshotPath = path.resolve(process.env.BATTERY_CHANNEL_SMOKE_SCREENSHOT);
        fs.mkdirSync(path.dirname(screenshotPath), { recursive: true });
        await new Promise(resolve => setTimeout(resolve, 150));
        const screenshot = await win.webContents.capturePage();
        fs.writeFileSync(screenshotPath, screenshot.toPNG());
      }

      clearTimeout(smokeTimeout);
      process.stdout.write(`SMOKE_RESULT=${JSON.stringify({ ...payload, consoleErrors })}\n`);
      app.exit(consoleErrors.length === 0 ? 0 : 1);
    } catch (error) {
      clearTimeout(smokeTimeout);
      process.stderr.write(`Electron Smoke failed: ${error.stack || error.message}\n`);
      app.exit(1);
    }
  });
}

function createWindow() {
  const viewportMatch = isSmokeTest
    ? /^(\d{3,4})x(\d{3,4})$/.exec(process.env.BATTERY_CHANNEL_SMOKE_VIEWPORT || '')
    : null;
  const win = new BrowserWindow({
    width: viewportMatch ? Number(viewportMatch[1]) : isSmokeTest ? 1366 : 1500,
    height: viewportMatch ? Number(viewportMatch[2]) : isSmokeTest ? 768 : 950,
    minWidth: 1060,
    minHeight: 700,
    backgroundColor: '#f3f7fa',
    autoHideMenuBar: true,
    show: !isSmokeTest || Boolean(process.env.BATTERY_CHANNEL_SMOKE_SCREENSHOT),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });
  attachSmokeOrchestration(win);
  void win.loadFile(path.join(__dirname, '电池测试通道预约Demo.html'));
}

const hasSingleInstanceLock = app.requestSingleInstanceLock();

if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const existingWindow = BrowserWindow.getAllWindows()[0];
    if (!existingWindow) return;
    if (existingWindow.isMinimized()) existingWindow.restore();
    existingWindow.show();
    existingWindow.focus();
  });

  app.whenReady().then(async () => {
    const { createLegacySqliteStore } = await import('./src/main/legacy-sqlite-store.mjs');
    const { createReservationCommandService } = await import('./src/main/reservation-command-service.mjs');
    const { createStorageCommandService } = await import('./src/main/storage-command-service.mjs');
    const { createDashboardPngService } = await import('./src/main/dashboard-png-service.mjs');
    const { createApplicationCommandService } = await import('./src/main/application-command-service.mjs');
    const { createExcelDialogService } = await import('./src/main/excel-service.mjs');
    const { createLegacyBackupService } = await import('./src/main/legacy-backup-service.mjs');
    const dataRoot = resolveDataRoot();
    const fileDialogs = runtimeDialog();
    store = await createLegacySqliteStore({ dataRoot });
    reservationService = createReservationCommandService({ store });
    storageService = createStorageCommandService({ store });
    dashboardPngService = createDashboardPngService({ dialog: fileDialogs });
    applicationService = createApplicationCommandService({ store });
    excelDialogs = createExcelDialogService({ dialog: fileDialogs, documentsPath: app.getPath('documents') });
    backupService = createLegacyBackupService({
      dialog: fileDialogs,
      store,
      dataRoot,
      documentsRoot: app.getPath('documents')
    });
    registerIpc();
    createWindow();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  }).catch(error => {
    process.stderr.write(`Application initialization failed: ${error.stack || error.message}\n`);
    app.exit(1);
  });

  app.on('will-quit', () => {
    store?.close();
    store = null;
    reservationService = null;
    storageService = null;
    dashboardPngService = null;
    applicationService = null;
    excelDialogs = null;
    backupService = null;
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
