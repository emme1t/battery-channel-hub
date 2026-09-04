import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFile, mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import * as actionModule from './actions.mjs';
import { createWorkflowElectronDriver } from './electron-driver.mjs';
import { seedWorkflowFixture } from './fixtures.mjs';
import { createWorkflowRunContext } from './run-context.mjs';
import { readWorkflowSnapshot } from './state-probe.mjs';

const projectRoot = path.resolve(import.meta.dirname, '..', '..');
const { ACTION_LIBRARY, executeWorkflowAction } = actionModule;
let actionRunSequence = 160;

const READ_ACTIONS = [
  'navigate', 'search', 'filter', 'expand', 'collapse', 'nextPage', 'previousPage',
  'selectSample', 'unselectSample', 'selectChannel', 'unselectChannel', 'focusBlur'
];
const WRITE_ACTIONS = [
  'importRequest', 'editExecution', 'reserve', 'startTodo', 'cancelTodo', 'startImmediately',
  'manageRunning', 'finishRunning', 'delayRunning', 'deleteRequest', 'createTester',
  'startStorage', 'updateStorage', 'finishStorage', 'returnStorage', 'returnRunning',
  'renameTester', 'deleteTester', 'createDevice', 'createChannel', 'deleteResource',
  'exportLog', 'exportRequest', 'backup', 'restore', 'staleSubmit', 'lockedWrite'
];
const CONTROL_ACTIONS = [
  'restart', 'editDraft', 'assertDraftDiscarded', 'assertDraftPreserved', 'reloadCurrent',
  'openSecondSession', 'closeSecondSession', 'retainOldDom'
];

test('storage 与退回动作是写动作并有明确 required/available/terminal 合同', () => {
  const state = {
    revision: 1, username: 'WF', requests: [{ id: 'REQ-STO' }, { id: 'REQ-RUN' }],
    samples: [{ id: 'REQ-STO.001', requestNo: 'REQ-STO', status: 'pending' }, { id: 'REQ-RUN.001', requestNo: 'REQ-RUN', status: 'running', channelKey: 'DEV|1' }],
    channels: [{ key: 'DEV|1', state: 'busy', currentRecordId: 'REC-RUN', nextRecordId: '' }], deviceProfiles: [],
    records: [{ id: 'REC-RUN', requestNo: 'REQ-RUN', sampleId: 'REQ-RUN.001', channelKey: 'DEV|1', status: 'running' }],
    storageRecords: [{ id: 'STO-ACTIVE', requestNo: 'REQ-ACTIVE', sampleIds: ['REQ-ACTIVE.001'], status: 'exception' }],
    requestSourceRows: [], testers: [], auditLogs: [], formChangeJournal: []
  };
  const snapshot = { state };
  const ui = currentPage => ({ projection: { currentPage, summary: { revision: 1 }, visible: {} } });
  assert.equal(ACTION_LIBRARY.startStorage.available(snapshot, ui('apply'), { storageId: 'STO-NEW', requestNo: 'REQ-STO', sampleIds: ['REQ-STO.001'], tester: 'WF', expectedEndAt: '2026-09-01T00:00:00.000Z' }, {}), true);
  assert.equal(ACTION_LIBRARY.startStorage.available(snapshot, ui('apply'), { storageId: 'STO-NEW', requestNo: 'REQ-STO', sampleIds: ['REQ-STO.001'], tester: 'OTHER', expectedEndAt: '2026-09-01T00:00:00.000Z' }, {}), false, 'workflow tester must match the logged-in UI identity');
  assert.equal(ACTION_LIBRARY.startStorage.available(snapshot, ui('requests'), { storageId: 'STO-NEW', requestNo: 'REQ-STO', sampleIds: ['REQ-STO.001'], tester: 'WF', expectedEndAt: '2026-09-01T00:00:00.000Z' }, {}), true, 'valid storage start must remain available before automatic target-page navigation');
  assert.equal(ACTION_LIBRARY.updateStorage.available(snapshot, ui('storageSamples'), { storageId: 'STO-ACTIVE', status: 'storing' }, {}), true);
  assert.equal(ACTION_LIBRARY.finishStorage.available(snapshot, ui('storageSamples'), { storageId: 'STO-ACTIVE' }, {}), true);
  assert.equal(ACTION_LIBRARY.returnStorage.available(snapshot, ui('storageSamples'), { storageId: 'STO-ACTIVE', reason: '补资料' }, {}), true);
  assert.equal(ACTION_LIBRARY.returnRunning.available(snapshot, ui('runningSamples'), { sampleId: 'REQ-RUN.001', reason: '补资料' }, {}), true);
  assert.equal(ACTION_LIBRARY.finishStorage.available(snapshot, ui('dashboard'), { storageId: 'STO-ACTIVE' }, {}), true, 'backup may leave the workflow on dashboard before automatic storage-page navigation');
  assert.equal(ACTION_LIBRARY.returnStorage.available(snapshot, ui('dashboard'), { storageId: 'STO-ACTIVE', reason: '补资料' }, {}), true, 'restore may leave the workflow on dashboard before automatic storage-page navigation');
  assert.equal(ACTION_LIBRARY.returnRunning.available(snapshot, ui('dashboard'), { sampleId: 'REQ-RUN.001', reason: '补资料' }, {}), true, 'valid return remains available before automatic running-page navigation');
  for (const type of ['startStorage', 'updateStorage', 'finishStorage', 'returnStorage', 'returnRunning']) {
    assert.equal(ACTION_LIBRARY[type].write, true, type);
    assert.equal(ACTION_LIBRARY[type].revisionDelta, 1, type);
    assert.equal(typeof ACTION_LIBRARY[type].settlement.terminal, 'function', type);
  }

  const storageTerminal = ACTION_LIBRARY.startStorage.settlement.terminal;
  const terminalState = {
    ...state,
    storageRecords: [{ id: 'STO-NEW', requestNo: 'REQ-STO', sampleIds: ['REQ-STO.001'], tester: 'OTHER', status: 'storing' }],
    samples: state.samples.map(item => item.id === 'REQ-STO.001' ? { ...item, status: 'storing' } : item)
  };
  assert.equal(storageTerminal({ outcome: 'success', state: terminalState, params: { storageId: 'STO-NEW', requestNo: 'REQ-STO', sampleIds: ['REQ-STO.001'], tester: 'WF' } }), false);
  terminalState.storageRecords[0].tester = 'WF';
  assert.equal(storageTerminal({ outcome: 'success', state: terminalState, params: { storageId: 'STO-NEW', requestNo: 'REQ-STO', sampleIds: ['REQ-STO.001'], tester: 'WF' } }), true);
});

test('storage datetime-local input round-trips the requested UTC instant in the local timezone', () => {
  const instant = '2026-10-15T12:00:00.000Z';
  const value = actionModule.datetimeLocalInstant(instant);
  assert.match(value, /^2026-10-15T\d{2}:\d{2}$/);
  assert.equal(new Date(value).toISOString(), instant);
});

test('search identity 与可见/排除 ID 参数 fail-close', () => {
  const base = { id: 'SEARCH-1', type: 'search', params: { label: '搜索', value: ' req ', identity: 'requestNo', expectedVisibleIds: ['REQ'] }, expect: 'success', revisionDelta: 0, evidenceRevisionDelta: 0, maxMs: 5_000 };
  assert.doesNotThrow(() => actionModule.validateWorkflowActionContract(base));
  assert.throws(() => actionModule.validateWorkflowActionContract({ ...base, params: { ...base.params, identity: 'project' } }), /identity/i);
  assert.throws(() => actionModule.validateWorkflowActionContract({ ...base, params: { ...base.params, expectedVisibleIds: [''] } }), /expectedVisibleIds/i);
});

test('纯 action contract validator 在无 driver 时校验完整 replay payload 与动作专属参数', () => {
  assert.equal(typeof actionModule.validateWorkflowActionContract, 'function');
  const valid = {
    id: 'C02-22002-step-000',
    type: 'reserve',
    params: {
      requestNo: 'REQ-001',
      sampleIds: ['REQ-001.001'],
      channelKeys: ['DEV-1::CH-1'],
      note: 'replay'
    },
    expect: 'success',
    revisionDelta: 1,
    evidenceRevisionDelta: 1,
    maxMs: 1_000
  };
  const contract = actionModule.validateWorkflowActionContract(valid);
  assert.deepEqual(contract, {
    type: 'reserve', params: valid.params, revisionDelta: 1, evidenceRevisionDelta: 1, maxMs: 1_000
  });
  assert.throws(
    () => actionModule.validateWorkflowActionContract({ ...valid, type: 'unknown-action' }),
    /unknown action type/i
  );
  assert.throws(
    () => actionModule.validateWorkflowActionContract({ ...valid, params: { sampleIds: valid.params.sampleIds, channelKeys: valid.params.channelKeys } }),
    /missing parameter: requestNo/i
  );
  const missingFullField = { ...valid };
  delete missingFullField.evidenceRevisionDelta;
  assert.throws(() => actionModule.validateWorkflowActionContract(missingFullField), /missing.*evidenceRevisionDelta/i);
});

function controlledPromise() {
  let resolve;
  let reject;
  const promise = new Promise((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

function fakeDriver({ outcome = 'success', doubleMode = 'single-success', executionDelayMs = 0, pickerTitle = '为 REQ-001.001 选择通道', initialPage = 'dashboard', toggleText = '展开 ＋', dialogCount = 0, dialogOnlyOnCancel = false, blockWrites = false, disabledPattern = null, throwOnClickPattern = null, visibleTargets = [], requestVisibleAfterSearch = false, manageRunningVisibleAfterRecordSearch = false, recordTransitionVisibleAfterRecordSearch = false, recordTransitionRequiresRecordsReentry = false, initialTodoPage = 1, todoDetailVisibleAfterPage = 1, todoDetailVisibleOnPages = null, reservationFieldsRequireDetailsScope = false, reservationDetailsMountAfterRequestSelection = false, reservationDetailsRequireRequestIdentity = false, reservationDetailsGenerationReplacement = false, reservationDetailsReplacementAfterSearchClear = false, reservationDetailsGenerationMissing = false, reservationModeAlreadyChecked = false, persistenceBarrierNeverSettles = false, fixtureAudits = [], persistedFixtureAudits = fixtureAudits, actionAuditDelay, extraActionAudits = [], finalBoundaryAudits = [], importAuditTarget = '申请单批次（1 条有效）', finalBoundaryMutation, finalBoundaryRevisionDelta = 0, inputSanitizer = value => String(value), clearAssignmentsOnStartMode = false, preselectedChannelDevice = '', pageLevelChannelFieldsAmbiguous = false, pageLevelDeviceFieldsAmbiguous = false, channelEntryMissingUntilDevicesReentered = false, deviceDeleteEntryMissingUntilDevicesReentered = false, samePageNavigationWrites = false } = {}) {
  const calls = [];
  const barriers = [];
  const rendererAudits = structuredClone(fixtureAudits);
  const auditLogs = structuredClone(persistedFixtureAudits);
  const auditWaiters = new Set();
  const pendingActionAuditBatches = [];
  const persistedState = structuredClone(conservativeContext(initialPage).snapshot.state);
  persistedState.revision = 0;
  persistedState.auditLogs = auditLogs;
  const assignedChannels = new Map();
  let selectedSample = '';
  let revision = 0;
  let currentPage = initialPage;
  let successfulWrites = 0;
  let writeAttempts = 0;
  let pendingDialogs = dialogCount;
  let inputValue = '';
  let reservationDetailsMounted = !reservationDetailsMountAfterRequestSelection;
  let reservationModeFieldsMounted = !reservationDetailsMountAfterRequestSelection;
  let reservationDetailsRequestNo = '';
  let reservationDetailsGeneration = 0;
  let selectedOption = preselectedChannelDevice;
  let channelName = '';
  let channelEntryAvailable = !(channelEntryMissingUntilDevicesReentered || deviceDeleteEntryMissingUntilDevicesReentered);
  let recordsDomReady = !recordTransitionRequiresRecordsReentry;
  const viewPages = Object.fromEntries(['request', 'sample', 'channel', 'records', 'audits', 'channels', 'todo'].map(view => [view, view === 'todo' ? initialTodoPage : 1]));
  let testerMode = '';
  let testerName = '';
  let deviceMode = '';
  let deviceName = '';
  let channelMode = '';
  let boundaryCaptures = 0;
  const notifyAuditWaiters = () => {
    for (const notify of auditWaiters) notify();
    auditWaiters.clear();
  };
  const publishAudits = audits => {
    rendererAudits.push(...structuredClone(audits));
    auditLogs.push(...structuredClone(audits));
    notifyAuditWaiters();
  };
  const actionAuditsFor = target => {
    const text = String(target);
    const reservationAction = text === '提交预约' ? '提交预约' : text === '立即开始' ? '开始测试' : '';
    if (reservationAction) {
      const sampleIds = [...assignedChannels.keys()];
      return (sampleIds.length ? sampleIds : ['UNKNOWN']).map((sampleId, index) => ({
        id: `${reservationAction === '提交预约' ? 'AUDIT-RESERVE' : 'AUDIT-START'}${index === 0 ? '' : `-${index + 1}`}`,
        action: reservationAction,
        user: 'workflow-user',
        target: `申请单 ${sampleId.split('.').slice(0, -1).join('.')} / 子样品 ${sampleId} / 通道 ${assignedChannels.get(sampleId)}`
      }));
    }
    const matches = label => target instanceof RegExp ? target.test(label) : text.includes(label);
    const recordIndex = Number(text.match(/data-record-index="(\d+)"/)?.[1]);
    const record = Number.isInteger(recordIndex) ? persistedState.records[recordIndex] : null;
    const entry = (action, auditTarget) => [{
      id: `AUDIT-FAKE-${successfulWrites}-${action.replace(/\s+/g, '-')}`,
      action,
      user: 'workflow-user',
      ...(auditTarget ? { target: auditTarget } : {})
    }];
    if (matches('导入单个 Excel') || matches('导入文件夹')) return entry('导入申请单', importAuditTarget);
    if (text === '保存本次修改' || text === '保存执行字段') return entry('修改申请执行字段', '申请单 REQ-001');
    if (text.includes('[data-res-start=')) return entry('开始预约测试', `通道 ${record?.channelKey || 'DEV|1'}`);
    if (text.includes('[data-res-cancel=')) return entry('取消预约', `通道 ${record?.channelKey || 'DEV|1'}`);
    if (text === '保存测试管理') return entry('修改通道', '通道 DEV|2');
    if (text.includes('record-transition') && text.includes('transition="end"')) return entry('结束测试', `通道 ${record?.channelKey || 'DEV|2'}`);
    if (text === '保存测试人员') return entry(testerMode === 'edit' ? '修改测试人员' : '新增测试人员', `测试人员 ${testerName}`);
    if (text === '保存设备') return entry(deviceMode === 'edit' ? '修改设备' : '新增设备', `设备 ${deviceName || inputValue}`);
    if (text === '保存通道') return entry(channelMode === 'edit' ? '修改通道' : '新增通道', `通道 ${selectedOption || 'DEV'}|${channelName || inputValue}`);
    if (text === '删除设备' || text.includes('delete-device')) return entry('删除设备', '设备 DEV');
    if (text.includes('delete-channel')) return entry('删除通道', `通道 ${decodeURIComponent(String(text).match(/data-channel-key="([^"]+)"/)?.[1] || '')}`);
    if (text === '删除') return entry('批量删除申请单');
    if (matches('导出申请汇总')) return entry('导出申请汇总', '测试申请数据');
    if (matches('导出 Excel')) return entry('导出日志与使用数据', '日志数据');
    if (text === '备份数据') return entry('手动备份数据', '本机 SQLite 看板数据');
    if (text === '恢复数据包') return entry('恢复数据备份', '本机 SQLite 看板数据');
    return [];
  };
  const scheduleActionAudits = target => {
    const audits = [...actionAuditsFor(target), ...structuredClone(extraActionAudits)];
    if (audits.length === 0) return;
    if (actionAuditDelay === 'deferred') pendingActionAuditBatches.push(audits);
    else if (Number.isFinite(actionAuditDelay) && actionAuditDelay > 0) setTimeout(() => publishAudits(audits), actionAuditDelay);
    else publishAudits(audits);
  };
  const waitForAuditChange = timeoutMs => new Promise(resolve => {
    let timer;
    const done = changed => {
      clearTimeout(timer);
      auditWaiters.delete(onAudit);
      resolve(changed);
    };
    const onAudit = () => done(true);
    auditWaiters.add(onAudit);
    timer = setTimeout(() => done(false), timeoutMs);
  });
  const preparedNames = new Set([
    '提交预约', '立即开始', '开始测试', '取消预约', '保存测试管理', '保存本次修改', '保存执行字段', '保存测试人员', '保存设备', '保存通道',
    '备份数据', '恢复数据包', '编辑', '删除', '删除设备', '新增测试人员', '＋ 新建设备', '新增通道',
    '备注', '开始时间', '预约开始时间', '预计结束时间（可选）', '预计结束时间', '特殊状况', '特殊状况说明', '姓名 *', '部门', '联系方式',
    '设备名称 *', '设备厂家', '温度范围', '所属设备 *', '通道号 *', '搜索设备、通道或量程'
    , '用户名', '进入看板'
  ]);
  const isPrepared = (target, scoped = false) => {
    const value = String(target);
    if (requestVisibleAfterSearch && value.includes('[data-legacy-action="select-request"]')) {
      const requestNo = value.match(/\[data-request-no="([^"]+)"\]/)?.[1] || '';
      return inputValue === requestNo;
    }
    if (manageRunningVisibleAfterRecordSearch && value.includes('[data-bounded-action="manage-running"]')) {
      const sampleId = decodeURIComponent(value.match(/\[data-sample-id="([^"]+)"\]/)?.[1] || '');
      return inputValue === sampleId;
    }
    if (recordTransitionVisibleAfterRecordSearch && value.includes('[data-bounded-action="record-transition"]')) {
      return inputValue === 'REQ-RUN.001' && recordsDomReady;
    }
    if (value.includes('[data-bounded-action="add-channel"]')) return channelEntryAvailable;
    if (deviceDeleteEntryMissingUntilDevicesReentered && value.includes('[data-bounded-action="delete-device"]')) return channelEntryAvailable;
    if (value.includes('[data-dashboard-action="todo-detail"]')) {
      return todoDetailVisibleOnPages ? todoDetailVisibleOnPages.includes(viewPages.todo) : viewPages.todo >= todoDetailVisibleAfterPage;
    }
    if (reservationDetailsMountAfterRequestSelection && value.includes('[data-testid="legacy-reservation-details"]')) return reservationDetailsMounted;
    if (reservationDetailsRequireRequestIdentity && value.includes('[data-testid="legacy-reservation-details"]')) {
      const requestNo = decodeURIComponent(value.match(/\[data-request-no="([^"]+)"\]/)?.[1] || '');
      return requestNo === reservationDetailsRequestNo && reservationDetailsMounted;
    }
    if (reservationDetailsGenerationReplacement && value.includes('[data-testid="legacy-reservation-details"]')) {
      const requestNo = decodeURIComponent(value.match(/\[data-request-no="([^"]+)"\]/)?.[1] || '');
      return requestNo === reservationDetailsRequestNo && reservationDetailsMounted;
    }
    if (reservationFieldsRequireDetailsScope && ['开始时间', '预约开始时间', '预计结束时间（可选）', '备注'].includes(value)) {
      return scoped && reservationDetailsMounted && reservationModeFieldsMounted;
    }
    if (/^\.nav\[data-page="[a-z]+"\]$/.test(value)) return true;
    if (/^\[data-(?:bounded-action|legacy-action|dashboard-action|sample-action|channel-key|res-start|res-cancel|testid)/.test(value)) return true;
    if (value === '#channelEditor' || value === '#deviceEditor') return true;
    if (value === '[role="status"], .toast.show, .legacy-inline-message') return true;
    if (preparedNames.has(value)) return true;
    if (/Excel|导入文件夹|导出申请汇总|\\u[0-9a-f]{4}/i.test(value)) return true;
    return visibleTargets.some(item => item instanceof RegExp ? item.test(value) : String(item) === value);
  };
  const isWriteTarget = target => /开始测试|提交预约|立即开始|保存|删除|导出|备份|恢复|导入|Excel|汇总|record-transition|locked|delete-channel|delete-device/.test(String(target)) || String(target).includes('[data-res-start=');
  const advanceRevision = () => {
    revision += 1;
    persistedState.revision = revision;
  };
  const applyWrite = target => {
    if (doubleMode === 'single-success' && successfulWrites > 0) return false;
    successfulWrites += 1;
    advanceRevision();
    const status = String(target) === '立即开始' ? 'running' : String(target) === '提交预约' ? 'reserved' : '';
    if (status) {
      for (const [sampleId, channelKey] of assignedChannels) {
        const recordId = `REC-FAKE-${successfulWrites}-${sampleId}`;
        const sample = persistedState.samples.find(item => item.id === sampleId);
        const channel = persistedState.channels.find(item => item.key === channelKey);
        if (sample) sample.status = status;
        persistedState.records.push({ id: recordId, sampleId, channelKey, status });
        if (channel) {
          channel.state = status === 'running' ? 'busy' : 'booked';
          channel[status === 'running' ? 'currentRecordId' : 'nextRecordId'] = recordId;
        }
      }
    }
    return true;
  };
  const makeLocator = (target, scoped = false) => ({
    async count() {
      if (pageLevelChannelFieldsAmbiguous && !scoped && ['通道号 *', '温度范围', '备注'].includes(String(target))) return 2;
      if (pageLevelDeviceFieldsAmbiguous && !scoped && ['设备名称 *', '设备厂家', '温度范围', '备注'].includes(String(target))) return 2;
      return isPrepared(target, scoped) ? 1 : 0;
    },
    async click(options) {
      if (!isPrepared(target, scoped)) throw new Error(`fake locator is not prepared: ${String(target)}`);
      calls.push(['click', target, options]);
      if (throwOnClickPattern?.test(String(target))) throw new Error(`injected click failure: ${String(target)}`);
      if (executionDelayMs) await new Promise(resolve => setTimeout(resolve, executionDelayMs));
      const navigation = String(target).match(/^\.nav\[data-page="([^"]+)"\]$/);
      if (navigation) {
        const pageChanged = currentPage !== navigation[1];
        currentPage = navigation[1];
        if (currentPage === 'devices') channelEntryAvailable = true;
        if (currentPage === 'records') recordsDomReady = true;
        if (pageChanged || samePageNavigationWrites) {
          advanceRevision();
          if (samePageNavigationWrites) publishAudits([{
            id: `AUDIT-PAGE-${revision}`,
            action: '查看页面',
            user: 'workflow-user',
            target: `页面 ${currentPage}`
          }]);
        }
        return;
      }
      const legacyPager = String(target).match(/data-legacy-action="(request|sample|channel)-(next|previous)"/);
      const boundedPager = String(target).match(/data-view="(records|audits|channels)"\]\[data-direction="(next|previous)"/);
      const todoPager = String(target).match(/data-dashboard-action="todo-(next|previous)"/);
      const pager = legacyPager || boundedPager || (todoPager ? ['', 'todo', todoPager[1]] : null);
      if (pager) viewPages[pager[1]] = Math.max(1, viewPages[pager[1]] + (pager[2] === 'next' ? 1 : -1));
      if (String(target) === '进入看板') {
        publishAudits([{ id: `AUDIT-FAKE-LOGIN-${inputValue || 'anonymous'}`, action: '登录看板', user: inputValue || 'anonymous' }]);
        return;
      }
      if (String(target).includes('[data-dashboard-action="todo-detail"]')) { currentPage = 'reserved'; advanceRevision(); return; }
      if (String(target).includes('[data-bounded-action="manage-running"]')) { currentPage = 'devices'; advanceRevision(); return; }
      if ((reservationDetailsMountAfterRequestSelection || reservationDetailsRequireRequestIdentity) && String(target).includes('[data-legacy-action="select-request"]')) {
        reservationDetailsRequestNo = decodeURIComponent(String(target).match(/\[data-request-no="([^"]+)"\]/)?.[1] || '');
        reservationDetailsMounted = false;
      }
      if (String(target).includes('[data-legacy-action="select-request"]')) {
        reservationDetailsRequestNo = decodeURIComponent(String(target).match(/\[data-request-no="([^"]+)"\]/)?.[1] || '');
        reservationDetailsGeneration += 1;
        if (reservationDetailsGenerationReplacement) reservationDetailsMounted = false;
      }
      if (String(target) === '新增测试人员') testerMode = 'create';
      if (String(target) === '编辑') testerMode = 'edit';
      if (String(target) === '＋ 新建设备') deviceMode = 'create';
      if (String(target).includes('edit-device')) deviceMode = 'edit';
      if (String(target) === '新增通道' || String(target).includes('[data-bounded-action="add-channel"]')) channelMode = 'create';
      if (String(target).includes('edit-channel')) channelMode = 'edit';
      const sampleSelection = String(target).match(/data-sample-id="([^"]+)"/);
      if (String(target).includes('open-channel-picker') && sampleSelection) selectedSample = sampleSelection[1];
      const channelSelection = String(target).match(/data-channel-key="([^"]+)"/);
      if ((String(target).includes('choose-channel') || String(target).startsWith('[data-channel-key=')) && channelSelection && selectedSample) assignedChannels.set(selectedSample, channelSelection[1]);
      while (pendingDialogs > 0 && page['handler:dialog'] && (!dialogOnlyOnCancel || String(target).includes('[data-res-cancel='))) {
        pendingDialogs -= 1;
        await page['handler:dialog']({
          accept: async () => calls.push(['dialog', 'accept']),
          dismiss: async () => calls.push(['dialog', 'dismiss'])
        });
      }
      if (options?.trial !== true && isWriteTarget(target)) writeAttempts += 1;
      if (!blockWrites && !['rejected', 'failure', 'cancelled'].includes(outcome) && options?.trial !== true && isWriteTarget(target)) {
        if (applyWrite(target)) scheduleActionAudits(target);
      }
    },
    async dblclick(options) {
      if (!isPrepared(target)) throw new Error(`fake locator is not prepared: ${String(target)}`);
      calls.push(['dblclick', target, options]);
      if (isWriteTarget(target) && applyWrite(target)) scheduleActionAudits(target);
      if (isWriteTarget(target) && doubleMode === 'two-successes' && applyWrite(target)) scheduleActionAudits(target);
      else calls.push(['second-submit', 'rejected']);
    },
    async fill(value) {
      inputValue = inputSanitizer(value);
      if (reservationDetailsReplacementAfterSearchClear && String(target) === '搜索申请单、项目、样品或人员' && inputValue === '' && reservationDetailsRequestNo) {
        reservationDetailsGeneration += 1;
        reservationDetailsMounted = false;
      }
      if (String(target) === '姓名 *') testerName = String(value);
      if (String(target) === '设备名称 *') deviceName = String(value);
      if (String(target) === '通道号 *') channelName = String(value);
      calls.push(['fill', value]);
    },
    async check() {
      calls.push(['check', target]);
      if (reservationDetailsMountAfterRequestSelection && ['立即开始', '提交预约'].includes(String(target))) reservationModeFieldsMounted = false;
      if (['立即开始', '提交预约'].includes(String(target))) {
        reservationDetailsGeneration += 1;
        if (reservationDetailsGenerationReplacement) reservationDetailsMounted = false;
      }
      if (clearAssignmentsOnStartMode && String(target) === '立即开始') assignedChannels.clear();
    },
    async uncheck() { calls.push(['uncheck']); },
    async selectOption(value) { selectedOption = String(value); calls.push(['selectOption', value]); },
    async textContent() {
      if (String(target).includes('legacy-channel-picker')) return pickerTitle;
      if (String(target).includes('toggle-device')) return toggleText;
      return outcome;
    },
    async isVisible() { return String(target) === '[role="status"], .toast.show, .legacy-inline-message' && outcome === 'rejected' ? writeAttempts > 0 : true; },
    async isDisabled() {
      if (String(target).includes('[data-dashboard-action="todo-previous"]')) return viewPages.todo <= 1;
      if (String(target).includes('[data-dashboard-action="todo-next"]')) return viewPages.todo >= 4;
      return disabledPattern ? disabledPattern.test(String(target)) : false;
    },
    async isChecked() { return reservationModeAlreadyChecked && ['立即开始', '提交预约'].includes(String(target)); },
    async inputValue() { return String(target) === '#cDevice' ? preselectedChannelDevice : inputValue; },
    async press(key) { calls.push(['press', key]); },
    async focus() { calls.push(['focus']); },
    async blur() { calls.push(['blur']); },
    async waitFor(options) {
      calls.push(['wait-for', target, options]);
      if (reservationDetailsMountAfterRequestSelection && String(target).includes('[data-testid="legacy-reservation-details"]') && options?.state === 'visible') {
        reservationDetailsMounted = true;
        reservationModeFieldsMounted = true;
      }
      if (reservationDetailsRequireRequestIdentity && String(target).includes('[data-testid="legacy-reservation-details"]') && options?.state === 'visible') {
        reservationDetailsMounted = true;
      }
      if ((reservationDetailsGenerationReplacement || reservationDetailsReplacementAfterSearchClear) && String(target).includes('[data-testid="legacy-reservation-details"]') && options?.state === 'visible') {
        if (reservationDetailsReplacementAfterSearchClear && !reservationDetailsMounted) return;
        reservationDetailsMounted = true;
      }
      if (reservationDetailsMountAfterRequestSelection && ['开始时间', '预约开始时间'].includes(String(target)) && options?.state === 'visible') {
        reservationDetailsMounted = true;
        reservationModeFieldsMounted = true;
      }
    },
    async getAttribute(name) {
      if (name !== 'data-details-generation' || !String(target).includes('[data-testid="legacy-reservation-details"]')) return null;
      return reservationDetailsGenerationMissing ? null : String(reservationDetailsGeneration);
    },
    async elementHandle() { return isPrepared(target, scoped) ? { target: String(target), click: async () => calls.push(['old-click', target]) } : null; },
    filter(options) { calls.push(['filter-locator', options]); return makeLocator(target, scoped); },
    getByRole(role, options) { calls.push(['nested-role', role, options]); return makeLocator(options?.name, scoped); },
    getByLabel(label, options) { calls.push(['nested-label', label, options]); return makeLocator(label, scoped); },
    locator(selector) { calls.push(['nested-locator', selector]); return makeLocator(selector, scoped || String(target).includes('legacy-reservation-details')); }
  });
  const page = {
    getByRole(role, options) { calls.push(['role', role, options]); return makeLocator(options?.name); },
    getByLabel(label, options) { calls.push(['label', label, options]); return makeLocator(label); },
    getByText(text, options) { calls.push(['text', text, options]); return makeLocator(text); },
    locator(selector) { calls.push(['locator', selector]); return makeLocator(selector, String(selector).includes('legacy-reservation-details') || ['#channelEditor', '#deviceEditor'].includes(String(selector))); },
    async evaluate(_callback, argument) { calls.push(['evaluate', argument]); return 0; },
    async reload() { calls.push(['reload']); },
    async waitForLoadState(state) { calls.push(['load-state', state]); },
    async waitForFunction(_callback, argument) { calls.push(['wait-for-function', argument]); if (reservationDetailsGenerationReplacement || reservationDetailsReplacementAfterSearchClear) reservationDetailsMounted = true; }
    ,on(event, handler) { calls.push(['on', event]); this[`handler:${event}`] = handler; }
    ,off(event) { calls.push(['off', event]); delete this[`handler:${event}`]; }
  };
  return {
    page: () => page,
    uiProjection: async () => ({ projection: { currentPage, summary: { revision }, visible: {} }, marker: 'ui' }),
    viewEvidence: async view => {
      const bounds = { request: 50, sample: 25, channel: 40, records: 50, audits: 50, channels: 50, todo: 10 };
      const pageNumber = viewPages[view] || 1;
      return Object.freeze({
        view,
        page: pageNumber,
        pageCount: 4,
        rowCount: bounds[view],
        first: `${view}-${pageNumber}-first`,
        last: `${view}-${pageNumber}-last`,
        maxRows: bounds[view],
        domWithinLimit: true,
        token: `${view}:${pageNumber}:${view}-${pageNumber}-first:${view}-${pageNumber}-last`
      });
    },
    restart: async () => calls.push(['restart']),
    capturePersistenceBoundary: async options => {
      boundaryCaptures += 1;
      if (boundaryCaptures === 2) {
        if (finalBoundaryAudits.length > 0) publishAudits(finalBoundaryAudits);
        if (typeof finalBoundaryMutation === 'function') finalBoundaryMutation(persistedState);
        if (finalBoundaryRevisionDelta !== 0) {
          revision += finalBoundaryRevisionDelta;
          persistedState.revision = revision;
        }
      }
      calls.push(['boundary', revision, options]);
      return Object.freeze({
        revision,
        auditIds: Object.freeze(auditLogs.map(item => item.id)),
        state: Object.freeze(structuredClone(persistedState))
      });
    },
    waitForPersistenceBarrier: async options => {
      barriers.push({ ...options, afterAuditIds: [...(options.afterAuditIds || [])] });
      calls.push(['persistence-barrier', options]);
      if (persistenceBarrierNeverSettles) return new Promise(() => {});
      const deadline = Date.now() + options.timeoutMs;
      const afterIds = new Set(options.afterAuditIds || []);
      while (Date.now() < deadline) {
        const rendererAudit = rendererAudits.find(item => !afterIds.has(String(item.id || ''))
          && item.action === options.auditAction
          && (options.actor === undefined || String(item.user ?? item.actor ?? '') === options.actor)
          && (options.auditTarget === undefined || String(item.target || '') === options.auditTarget));
        if (rendererAudit) {
          const audit = auditLogs.find(item => String(item.id || '') === String(rendererAudit.id || ''));
          if (!audit || audit.action !== options.auditAction
            || (options.actor !== undefined && String(audit.user ?? audit.actor ?? '') !== options.actor)
            || (options.auditTarget !== undefined && String(audit.target || '') !== options.auditTarget)) {
            throw new Error(`exact persisted audit missing for ${rendererAudit.id}`);
          }
          return Object.freeze({
            revision,
            audit: Object.freeze(structuredClone(audit)),
            state: Object.freeze(structuredClone(persistedState))
          });
        }
        const changed = await waitForAuditChange(Math.max(1, deadline - Date.now()));
        if (!changed) break;
      }
      throw new Error(`persistence barrier timed out for ${options.auditAction}`);
    },
    configureDialogs: async routes => calls.push(['dialogs', routes]),
    start: async () => calls.push(['start']),
    close: async () => calls.push(['close']),
    calls,
    barriers,
    releaseActionAudits() {
      for (const audits of pendingActionAuditBatches.splice(0)) publishAudits(audits);
    },
    advanceRevision: (delta = 1) => { revision += delta; persistedState.revision = revision; },
    stats: () => ({ revision, successfulWrites })
  };
}

test('startImmediately 必须在切换模式后分配通道，以免 MAIN 清空分配', async () => {
  const driver = fakeDriver({ initialPage: 'apply', clearAssignmentsOnStartMode: true });
  const result = await executeWorkflowAction({
    driver,
    action: {
      type: 'startImmediately', expect: 'success', revisionDelta: 1, maxMs: 500,
      params: { requestNo: 'REQ-001', sampleIds: ['REQ-001.001'], channelKeys: ['DEV|3'], confirm: true }
    },
    context: conservativeContext('apply')
  });

  assert.equal(result.outcome, 'success');
  assert.ok(
    driver.calls.findIndex(call => call[0] === 'check' && call[1] === '立即开始')
      < driver.calls.findIndex(call => call[0] === 'click' && String(call[1]).includes('choose-channel'))
  );
});

test('动作库完整冻结且每个 definition 都有完整合同', () => {
  const expected = [...READ_ACTIONS, ...WRITE_ACTIONS, ...CONTROL_ACTIONS].sort();
  assert.deepEqual(Object.keys(ACTION_LIBRARY).sort(), expected);
  assert.ok(Object.isFrozen(ACTION_LIBRARY));
  for (const [type, definition] of Object.entries(ACTION_LIBRARY)) {
    assert.equal(definition.type, type);
    assert.equal(typeof definition.write, 'boolean');
    assert.equal(typeof definition.available, 'function');
    assert.equal(typeof definition.execute, 'function');
    assert.ok(definition.maxMs > 0 && definition.maxMs <= 30_000, type);
    assert.ok(Array.isArray(definition.allowedOutcomes) && definition.allowedOutcomes.length > 0, type);
    assert.ok(Number.isInteger(definition.revisionDelta) || Array.isArray(definition.revisionDelta), type);
    assert.ok(Object.isFrozen(definition));
    assert.ok(Object.isFrozen(definition.allowedOutcomes));
  }
});

test('S05 指针预期进入 settled terminal，错误 record ID 必须 fail-close', async () => {
  const context = conservativeContext('records');
  await assert.rejects(
    executeWorkflowAction({
      driver: fakeDriver({ initialPage: 'records' }),
      action: { type: 'finishRunning', expect: 'success', revisionDelta: 1, maxMs: 500, params: {
        sampleId: 'REQ-RUN.001', expectedPointers: { channelKey: 'DEV|2', currentRecordId: 'WRONG', nextRecordId: null }
      } },
      context
    }),
    /finishRunning.*terminal-state/i
  );
});

test('S05 样品关系缺失、重复或状态错误时 pointer terminal fail-close', async () => {
  for (const mutate of [
    state => { state.channels.find(item => item.key === 'DEV|2').currentRecordId = ''; },
    state => { state.channels.find(item => item.key === 'DEV|2').currentRecordId = ''; state.records.push({ id: 'REC-DUP', sampleId: 'REQ-MISSING.001', status: 'reserved', channelKey: 'DEV|2' }); },
    state => { state.channels.find(item => item.key === 'DEV|2').currentRecordId = ''; state.records.push({ id: 'REC-BAD', sampleId: 'REQ-MISSING.001', status: 'completed', channelKey: 'DEV|2' }); }
  ]) {
    await assert.rejects(() => executeWorkflowAction({
      driver: fakeDriver({ initialPage: 'records', finalBoundaryMutation: mutate }),
      action: { type: 'finishRunning', expect: 'success', revisionDelta: 1, maxMs: 500, params: { sampleId: 'REQ-RUN.001', expectedPointers: { channelKey: 'DEV|2', currentRecordId: null, nextSampleId: 'REQ-MISSING.001' } } },
      context: conservativeContext('records')
    }), /finishRunning.*terminal-state/i);
  }
});

test('删除通道使用精确 key 的 bounded locator，并以完整 key 对齐审计', async () => {
  const context = conservativeContext('devices');
  context.snapshot.state.channels.push({ key: 'S06 临时设备|S06-01', name: 'S06-01', device: 'S06 临时设备', state: 'free' });
  await assert.doesNotReject(() => executeWorkflowAction({
    driver: fakeDriver({ initialPage: 'devices' }),
    action: { type: 'deleteResource', expect: 'success', revisionDelta: 1, maxMs: 500, params: { kind: 'channel', name: 'S06 临时设备|S06-01', confirm: true } },
    context
  }));
});

test('S06 从 testers 返回 devices 后，筛选会挂载第 530 条通道的精确删除入口', async () => {
  const targetKey = 'S06 临时设备|S06-01';
  const context = conservativeContext('testers');
  context.snapshot.state.channels = Array.from({ length: 530 }, (_, index) => ({
    key: index === 529 ? targetKey : `设备-${index + 1}|通道-${index + 1}`,
    state: 'free'
  }));
  const driver = fakeDriver({ initialPage: 'testers' });
  const page = driver.page();
  const originalLocator = page.locator.bind(page);
  const originalGetByLabel = page.getByLabel.bind(page);
  let channelFilter = '';
  page.getByLabel = (label, options) => {
    const locator = originalGetByLabel(label, options);
    if (label !== '搜索设备、通道或量程') return locator;
    return {
      ...locator,
      async fill(value) {
        channelFilter = String(value);
        return locator.fill(value);
      }
    };
  };
  page.locator = selector => {
    const locator = originalLocator(selector);
    const exactTarget = `[data-bounded-action="delete-channel"][data-channel-key="${encodeURIComponent(targetKey)}"]`;
    if (selector !== exactTarget) return locator;
    return {
      ...locator,
      async count() { return channelFilter === targetKey ? 1 : 0; },
      async click(options) {
        if (channelFilter !== targetKey) throw new Error('off-page channel was not mounted by the filter');
        return locator.click(options);
      }
    };
  };

  const result = await executeWorkflowAction({
    driver,
    action: { type: 'deleteResource', expect: 'success', revisionDelta: 1, maxMs: 500, params: { kind: 'channel', name: targetKey, confirm: true } },
    context
  });

  assert.equal(result.outcome, 'success');
  assert.equal(channelFilter, targetKey);
  assert.ok(driver.calls.some(call => call[0] === 'click' && call[1] === '.nav[data-page="devices"]'));
  assert.ok(driver.calls.some(call => call[0] === 'locator'
    && call[1] === `[data-bounded-action="delete-channel"][data-channel-key="${encodeURIComponent(targetKey)}"]`));
});

test('step-022 删除设备按快照唯一 ID 使用 bounded locator', async () => {
  const name = '新威2#(16通道）';
  const id = 'WF-DEVICE-22004';
  const context = conservativeContext('devices');
  context.snapshot.state.deviceProfiles = [{ id, name }];
  const driver = fakeDriver({ initialPage: 'devices' });
  const result = await ACTION_LIBRARY.deleteResource.execute(driver, { kind: 'device', name, confirm: true }, context);

  assert.equal(result.awaitEvidence, true);
  assert.ok(driver.calls.some(call => call[0] === 'locator'
    && call[1] === `[data-bounded-action="delete-device"][data-device-id="${encodeURIComponent(id)}"]`));
});

test('step-022 设备删除入口缺失时在 before-boundary 同页重进设备页', async () => {
  const context = conservativeContext('devices');
  const driver = fakeDriver({ initialPage: 'devices', deviceDeleteEntryMissingUntilDevicesReentered: true });
  await executeWorkflowAction({
    driver,
    action: { type: 'deleteResource', expect: 'success', revisionDelta: 1, evidenceRevisionDelta: 1, maxMs: 500, params: { kind: 'device', name: 'DEV', confirm: true } },
    context
  });

  assert.ok(driver.calls.some(call => call[0] === 'click' && call[1] === '.nav[data-page="devices"]'));
  assert.ok(driver.calls.some(call => call[0] === 'locator'
    && call[1] === `[data-bounded-action="delete-device"][data-device-id="DEV"]`));
});

test('删除设备在快照中不存在或重名时 fail-close', async () => {
  for (const deviceProfiles of [
    [],
    [{ id: 'WF-DEVICE-1', name: '重名设备' }, { id: 'WF-DEVICE-2', name: '重名设备' }]
  ]) {
    const context = conservativeContext('devices');
    context.snapshot.state.deviceProfiles = deviceProfiles;
    await assert.rejects(
      ACTION_LIBRARY.deleteResource.execute(fakeDriver({ initialPage: 'devices' }), { kind: 'device', name: deviceProfiles.length ? '重名设备' : '不存在设备', confirm: true }, context),
      /delete device .*exactly once.*actual [02]/
    );
  }
});

test('删除设备在快照中缺少 ID 时 fail-close', async () => {
  const context = conservativeContext('devices');
  context.snapshot.state.deviceProfiles = [{ name: '缺 ID 设备' }];
  await assert.rejects(
    ACTION_LIBRARY.deleteResource.execute(fakeDriver({ initialPage: 'devices' }), { kind: 'device', name: '缺 ID 设备', confirm: true }, context),
    /delete device .*non-empty device id/
  );
});

test('每个 write definition 必须声明冻结的 settlement 合同', () => {
  for (const [type, definition] of Object.entries(ACTION_LIBRARY)) {
    if (!definition.write) continue;
    assert.ok(definition.settlement, type);
    assert.ok(['boundary', 'audit-chain'].includes(definition.settlement.mode), type);
    assert.equal(typeof definition.settlement.audits, 'function', type);
    assert.ok(Object.isFrozen(definition.settlement), type);
  }
});

test('27 个 write definition 的 success 审计政策来自产品动作而非 capture-all', async () => {
  const cases = [
    ['importRequest', { kind: 'file', expectedValidCount: 1 }, ['导入申请单']],
    ['editExecution', { requestNo: 'REQ-001' }, ['修改申请执行字段']],
    ['reserve', { requestNo: 'REQ-001', sampleIds: ['REQ-001.001'], channelKeys: ['DEV|3'] }, ['提交预约']],
    ['startImmediately', { requestNo: 'REQ-001', sampleIds: ['REQ-001.001'], channelKeys: ['DEV|3'] }, ['开始测试']],
    ['startTodo', { sampleId: 'REQ-RES.001' }, ['开始预约测试']],
    ['cancelTodo', { sampleId: 'REQ-RES.001' }, ['取消预约']],
    ['manageRunning', { sampleId: 'REQ-RUN.001' }, ['修改通道']],
    ['finishRunning', { sampleId: 'REQ-RUN.001' }, ['结束测试']],
    ['delayRunning', { sampleId: 'REQ-RUN.001' }, ['修改通道']],
    ['startStorage', { storageId: 'STO-1' }, ['storage_started']],
    ['updateStorage', { storageId: 'STO-1' }, ['storage_updated']],
    ['finishStorage', { storageId: 'STO-1' }, ['storage_finished']],
    ['returnStorage', { storageId: 'STO-1' }, ['storage_returned_to_application']],
    ['returnRunning', { sampleId: 'REQ-RUN.001' }, ['running_returned_to_application']],
    ['deleteRequest', { requestNo: 'REQ-001' }, ['批量删除申请单']],
    ['createTester', { name: '新测试员' }, ['新增测试人员']],
    ['renameTester', { name: '旧测试员', nextName: '新测试员' }, ['修改测试人员']],
    ['deleteTester', { name: '旧测试员' }, ['删除测试人员']],
    ['createDevice', { name: '新设备' }, ['新增设备']],
    ['createChannel', { device: 'DEV', name: '4' }, ['新增通道']],
    ['deleteResource', { kind: 'device', name: 'DEV' }, ['删除设备']],
    ['exportLog', {}, ['导出日志与使用数据']],
    ['exportRequest', {}, ['导出申请汇总']],
    ['backup', {}, ['手动备份数据']],
    ['restore', {}, ['恢复数据备份']],
    ['staleSubmit', {}, []],
    ['lockedWrite', {}, []]
  ];
  const scope = conservativeContext('dashboard').snapshot;
  for (const [type, params, expected] of cases) {
    const descriptors = await ACTION_LIBRARY[type].settlement.audits({
      type, params, outcome: 'success', scope, context: {}, result: {}
    });
    assert.deepEqual(descriptors.map(item => item.action), expected, type);
    assert.ok(descriptors.every(item => item.captureAll !== true), type);
    assert.ok(descriptors.every(item => item.actor === 'workflow-user'), type);
    if (type === 'importRequest') assert.equal(descriptors[0].target, '申请单批次（1 条有效）');
  }
});

test('importRequest 非取消动作要求独立的正安全整数 expectedValidCount', async () => {
  for (const expectedValidCount of [undefined, 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    await assert.rejects(
      executeWorkflowAction({
        driver: fakeDriver(),
        action: {
          type: 'importRequest',
          params: {
            path: 'valid.xlsx', kind: 'file',
            ...(expectedValidCount === undefined ? {} : { expectedValidCount })
          }
        },
        context: conservativeContext('requests')
      }),
      /importRequest.*validate.*expectedValidCount.*positive safe integer/i
    );
  }
});

test('importRequest success N>0 只接受独立 expectedValidCount 对应的产品 exact target', async () => {
  const params = {
    paths: ['valid.xlsx', 'blank.xlsx', 'corrupt.xlsx'],
    kind: 'file', duplicatePolicy: 'skip', expectedValidCount: 1
  };
  const correct = await executeWorkflowAction({
    driver: fakeDriver({ importAuditTarget: '申请单批次（1 条有效）' }),
    action: { type: 'importRequest', params },
    context: conservativeContext('requests')
  });
  assert.equal(correct.settlement.auditEvidence[0].target, '申请单批次（1 条有效）');

  await assert.rejects(
    executeWorkflowAction({
      driver: fakeDriver({ importAuditTarget: '申请单批次（3 条有效）' }),
      action: { type: 'importRequest', params },
      context: conservativeContext('requests')
    }),
    /importRequest.*audit-delta.*missing=导入申请单#1.*extra=AUDIT-FAKE-1-/i
  );
});

test('importRequest zero-valid 在输入边界 fail-close 且不调用 command 或发布审计', async () => {
  const driver = fakeDriver({ importAuditTarget: '申请单批次（0 条有效）' });
  const observed = await executeWorkflowAction({
    driver,
    action: { type: 'importRequest', params: { path: 'errors-only.xlsx', kind: 'file', expectedValidCount: 0 } },
    context: conservativeContext('requests')
  }).then(result => ({ result }), error => ({ error }));

  assert.ok(
    observed.error,
    `expected zero-valid fail-close; actual outcome=${observed.result?.outcome}; audits=${JSON.stringify(observed.result?.settlement?.auditEvidence || [])}`
  );
  assert.match(observed.error.message, /importRequest.*validate.*expectedValidCount.*positive safe integer/i);
  assert.deepEqual(driver.calls, []);
  assert.deepEqual(driver.barriers, []);
  assert.deepEqual(driver.stats(), { revision: 0, successfulWrites: 0 });
});

test('write definition 缺 settlement 时 define 拒绝', () => {
  assert.equal(typeof actionModule.normalizeSettlement, 'function');
  assert.throws(() => actionModule.normalizeSettlement(true, undefined), /write action settlement is required/);
});

test('业务 before boundary 在 ensure page 尾写排空后建立', async () => {
  const driver = fakeDriver({ initialPage: 'dashboard' });
  const action = {
    type: 'reserve',
    params: {
      requestNo: 'REQ-001', sampleIds: ['REQ-001.001'], channelKeys: ['DEV|3'],
      start: '2026-08-22T09:00', end: '2026-08-22T10:00'
    }
  };
  const result = await executeWorkflowAction({ driver, action, context: conservativeContext('dashboard') });

  assert.deepEqual(driver.calls.filter(call => ['click', 'boundary'].includes(call[0]) && (call[0] === 'boundary' || String(call[1]).includes('.nav') || call[1] === '提交预约')).slice(0, 4).map(call => {
    if (call[0] === 'click' && String(call[1]).includes('.nav')) return ['navigate', 'apply'];
    return call.slice(0, 2);
  }), [
    ['navigate', 'apply'], ['boundary', 1], ['click', '提交预约'], ['boundary', 2]
  ]);
  assert.equal(result.settlement.beforeRevision, 1);
  assert.equal(result.settlement.persistedRevision, 2);
  assert.equal(result.settlement.persistedRevision - result.settlement.beforeRevision, 1);
});

test('audit-chain 在业务结果后等待精确审计并返回不可变 settlement', async () => {
  const driver = fakeDriver({ initialPage: 'apply' });
  const action = { type: 'reserve', params: {
    requestNo: 'REQ-001', sampleIds: ['REQ-001.001'], channelKeys: ['DEV|3'],
    start: '2026-08-22T09:00', end: '2026-08-22T10:00'
  } };
  const result = await executeWorkflowAction({ driver, action, context: conservativeContext('apply') });
  assert.deepEqual(driver.barriers.map(item => item.auditAction), ['提交预约']);
  assert.equal(driver.barriers[0].auditTarget, '申请单 REQ-001 / 子样品 REQ-001.001 / 通道 DEV|3');
  assert.deepEqual(result.settlement.auditIds, ['AUDIT-RESERVE']);
  assert.equal(result.settlement.finalPage, 'apply');
  assert.equal(result.settlement.outcome, 'success');
  assert.deepEqual(result.settlement.auditEvidence.map(item => item.id), ['AUDIT-RESERVE']);
  assert.equal(result.settlement.uiEvidence.marker, 'ui');
  assert.equal(result.uiEvidence, result.settlement.uiEvidence);
  assert.ok(Object.isFrozen(result.settlement));
});

test('audit-chain final boundary 含 expected 与 undeclared page/business audit 时以 audit-delta 拒绝', async () => {
  const driver = fakeDriver({
    initialPage: 'apply',
    extraActionAudits: [
      { id: 'AUDIT-PAGE-TAIL', action: '查看页面', user: 'workflow-user', target: '页面 dashboard' },
      { id: 'AUDIT-BUSINESS-TAIL', action: '删除申请单', user: 'workflow-user', target: '申请单 OTHER' }
    ]
  });
  await assert.rejects(
    executeWorkflowAction({
      driver,
      action: { type: 'reserve', params: {
        requestNo: 'REQ-001', sampleIds: ['REQ-001.001'], channelKeys: ['DEV|3'],
        start: '2026-08-22T09:00', end: '2026-08-22T10:00'
      } },
      context: conservativeContext('apply')
    }),
    /\[reserve\] audit-delta:.*expected=.*AUDIT-RESERVE.*extra=.*AUDIT-(?:BUSINESS|PAGE)-TAIL/i
  );
});

test('boundary no-audit policy 遇到 formal before 后新增审计时拒绝', async () => {
  const driver = fakeDriver({
    outcome: '',
    blockWrites: true,
    finalBoundaryAudits: [{ id: 'AUDIT-UNDECLARED', action: '查看页面', user: 'workflow-user', target: '页面 dashboard' }]
  });
  await assert.rejects(
    executeWorkflowAction({
      driver,
      action: { type: 'backup', params: { cancel: true } },
      context: { ...conservativeContext('dashboard'), outcomeReader: async () => 'cancelled' }
    }),
    /\[backup\] audit-delta:.*expected=.*<none>.*extra=.*AUDIT-UNDECLARED/i
  );
});

test('final UI revision 必须与 final SQLite boundary 相同，[0,1] 不能掩盖额外尾写', async () => {
  const driver = fakeDriver({ outcome: '', blockWrites: true });
  const projection = driver.uiProjection;
  driver.uiProjection = async () => {
    const ui = await projection();
    const finalBoundarySeen = driver.calls.filter(call => call[0] === 'boundary').length >= 2;
    return finalBoundarySeen
      ? { ...ui, projection: { ...ui.projection, summary: { revision: ui.projection.summary.revision + 1 } } }
      : ui;
  };
  await assert.rejects(
    executeWorkflowAction({
      driver,
      action: { type: 'backup', params: { cancel: true } },
      context: { ...conservativeContext('dashboard'), outcomeReader: async () => 'cancelled' }
    }),
    /backup.*boundary consistency.*SQLite 0.*UI 1/i
  );
});

test('final page 使用明确 active-page 条件和剩余 deadline，不做固定间隔轮询', async () => {
  const driver = fakeDriver({ initialPage: 'apply' });
  await executeWorkflowAction({
    driver,
    action: { type: 'reserve', params: {
      requestNo: 'REQ-001', sampleIds: ['REQ-001.001'], channelKeys: ['DEV|3'],
      start: '2026-08-22T09:00', end: '2026-08-22T10:00'
    } },
    context: conservativeContext('apply')
  });
  const pageWait = driver.calls.find(call => call[0] === 'wait-for' && call[1] === '#apply.page.active');
  assert.equal(pageWait?.[1], '#apply.page.active');
  assert.equal(pageWait?.[2]?.state, 'visible');
  assert.ok(pageWait?.[2]?.timeout > 0 && pageWait[2].timeout <= ACTION_LIBRARY.reserve.maxMs);
});

test('ActionSettlement 的 UI、audit 与 before/final state 都是递归冻结的不可变快照', async () => {
  const driver = fakeDriver({ initialPage: 'apply' });
  const result = await executeWorkflowAction({
    driver,
    action: { type: 'reserve', params: {
      requestNo: 'REQ-001', sampleIds: ['REQ-001.001'], channelKeys: ['DEV|3'],
      start: '2026-08-22T09:00', end: '2026-08-22T10:00'
    } },
    context: conservativeContext('apply')
  });
  const { settlement } = result;
  for (const value of [
    settlement,
    settlement.auditEvidence,
    settlement.auditEvidence[0],
    settlement.uiEvidence,
    settlement.uiEvidence.projection,
    settlement.uiEvidence.projection.summary,
    settlement.beforeState,
    settlement.beforeState.samples,
    settlement.beforeState.samples[0],
    settlement.state,
    settlement.state.records,
    settlement.state.records[0]
  ]) assert.ok(Object.isFrozen(value));
  const originalStatus = settlement.state.samples[0].status;
  assert.throws(() => { settlement.state.samples[0].status = 'tampered'; }, TypeError);
  assert.throws(() => { settlement.auditEvidence.push({ id: 'AUDIT-TAMPERED' }); }, TypeError);
  assert.equal(settlement.state.samples[0].status, originalStatus);
  assert.deepEqual(settlement.auditIds, ['AUDIT-RESERVE']);
});

test('fake persistence barrier 只观察已产生审计，不按调用参数凭空造证据', async () => {
  const driver = fakeDriver({ initialPage: 'apply' });
  await assert.rejects(
    driver.waitForPersistenceBarrier({ auditAction: '不存在的审计', actor: 'worker-A', timeoutMs: 20 }),
    /timed out/i
  );
  assert.deepEqual(driver.barriers.map(item => item.auditAction), ['不存在的审计']);
});

test('audit-chain 等待动作异步产生的审计，不在 barrier 入参时自证', async () => {
  const driver = fakeDriver({ initialPage: 'apply', actionAuditDelay: 'deferred' });
  const action = { type: 'reserve', params: {
    requestNo: 'REQ-001', sampleIds: ['REQ-001.001'], channelKeys: ['DEV|3'],
    start: '2026-08-22T09:00', end: '2026-08-22T10:00'
  } };
  let settled = false;
  const pending = executeWorkflowAction({ driver, action, context: conservativeContext('apply') }).then(value => {
    settled = true;
    return value;
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, false);
  driver.releaseActionAudits();
  assert.deepEqual((await pending).settlement.auditIds, ['AUDIT-RESERVE']);
});

test('audit-chain 跳过同 actor/action 的其他会话并按 count 递增 afterAuditIds', async () => {
  const otherSessionAudit = { id: 'AUDIT-SESSION-B', action: '提交预约', user: 'worker-A', target: '会话 B' };
  const driver = fakeDriver({
    initialPage: 'apply',
    fixtureAudits: [
      otherSessionAudit,
      { id: 'AUDIT-SAMPLE-1', action: '提交预约', user: 'worker-A', target: '会话 A' },
      { id: 'AUDIT-SAMPLE-2', action: '提交预约', user: 'worker-A', target: '会话 A' }
    ]
  });
  const scope = Object.freeze({
    revision: 0,
    auditIds: Object.freeze([otherSessionAudit.id]),
    state: Object.freeze({ revision: 0, auditLogs: Object.freeze([Object.freeze({ ...otherSessionAudit })]) })
  });
  const definition = Object.freeze({
    type: 'fixtureAuditChain',
    settlement: Object.freeze({
      mode: 'audit-chain', finalPage: 'apply',
      audits: () => [{ action: '提交预约', actor: 'worker-A', target: '会话 A', count: 2 }]
    })
  });
  const settlement = await actionModule.settleWorkflowAction({
    driver, definition, params: {}, outcome: 'success', scope, result: {},
    deadline: Date.now() + 500, context: {}
  });
  assert.deepEqual(settlement.auditIds, ['AUDIT-SAMPLE-1', 'AUDIT-SAMPLE-2']);
  assert.deepEqual(driver.barriers.map(item => item.afterAuditIds), [
    ['AUDIT-SESSION-B'], ['AUDIT-SESSION-B', 'AUDIT-SAMPLE-1']
  ]);
});

test('多 descriptor 的 barrier 顺序/count 与完整 final audit ID 集合全等', async () => {
  const fixtureAudits = [
    { id: 'AUDIT-A-1', action: '动作 A', user: 'worker-A', target: '目标 A' },
    { id: 'AUDIT-A-2', action: '动作 A', user: 'worker-A', target: '目标 A' },
    { id: 'AUDIT-B-1', action: '动作 B', user: 'worker-A', target: '目标 B' }
  ];
  const driver = fakeDriver({ initialPage: 'apply', fixtureAudits });
  const definition = Object.freeze({
    type: 'fixtureAuditChain',
    settlement: Object.freeze({
      mode: 'audit-chain', finalPage: 'apply',
      audits: () => [
        { action: '动作 A', actor: 'worker-A', target: '目标 A', count: 2 },
        { action: '动作 B', actor: 'worker-A', target: '目标 B', count: 1 }
      ]
    })
  });
  const settlement = await actionModule.settleWorkflowAction({
    driver, definition, params: {}, outcome: 'success',
    scope: Object.freeze({ revision: 0, auditIds: Object.freeze([]), state: Object.freeze({ revision: 0, auditLogs: Object.freeze([]) }) }),
    result: {}, deadline: Date.now() + 500, context: {}
  });
  assert.deepEqual(driver.barriers.map(item => item.auditAction), ['动作 A', '动作 A', '动作 B']);
  assert.deepEqual(driver.barriers.map(item => item.afterAuditIds), [[], ['AUDIT-A-1'], ['AUDIT-A-1', 'AUDIT-A-2']]);
  assert.deepEqual(settlement.auditIds, ['AUDIT-A-1', 'AUDIT-A-2', 'AUDIT-B-1']);
  assert.deepEqual(settlement.auditEvidence.map(item => item.id), settlement.auditIds);
});

for (const invalid of [
  [{ id: '', action: '查看页面' }],
  [{ id: 'AUDIT-DUP', action: '查看页面' }, { id: 'AUDIT-DUP', action: '删除申请单' }]
]) {
  test(`final audit delta 拒绝${invalid[0].id ? '重复' : '空'} ID`, async () => {
    const driver = fakeDriver({ outcome: '', blockWrites: true, finalBoundaryAudits: invalid });
    await assert.rejects(
      executeWorkflowAction({
        driver,
        action: { type: 'backup', params: { cancel: true } },
        context: { ...conservativeContext('dashboard'), outcomeReader: async () => 'cancelled' }
      }),
      /\[backup\] audit-delta:.*audit IDs invalid/i
    );
  });
}

test('cancelled settlement 不消费 formal before 旧审计，也拒绝新增业务审计', async () => {
  const driver = fakeDriver({
    outcome: '', blockWrites: true,
    fixtureAudits: [{ id: 'AUDIT-OLD', action: '旧业务', user: 'workflow-user' }],
    finalBoundaryAudits: [{ id: 'AUDIT-NEW-BUSINESS', action: '删除申请单', user: 'workflow-user' }]
  });
  await assert.rejects(
    executeWorkflowAction({
      driver,
      action: { type: 'backup', params: { cancel: true } },
      context: { ...conservativeContext('dashboard'), outcomeReader: async () => 'cancelled' }
    }),
    error => {
      assert.match(error.message, /\[backup\] audit-delta:.*extra=.*AUDIT-NEW-BUSINESS/i);
      assert.doesNotMatch(error.message, /AUDIT-OLD/);
      return true;
    }
  );
});

for (const [name, mutate] of [
  ['篡改', state => { state.auditLogs[0].target = 'TAMPERED'; }],
  ['删除', state => { state.auditLogs.splice(0, 1); }]
]) {
  test(`cancelled/rejected settlement 拒绝${name} formal before 的同 ID 审计`, async () => {
    const fixtureAudits = [{ id: 'AUDIT-BASELINE', action: '登录看板', user: 'workflow-user', target: '看板' }];
    for (const outcome of ['cancelled', 'rejected']) {
      await assert.rejects(
        executeWorkflowAction({
          driver: fakeDriver({
            outcome: '', blockWrites: true, fixtureAudits,
            finalBoundaryMutation: mutate
          }),
          action: {
            type: 'backup',
            params: outcome === 'cancelled' ? { cancel: true } : { path: 'backup.batterydata' },
            revisionDelta: 0
          },
          context: { ...conservativeContext('dashboard'), outcomeReader: async () => outcome }
        }),
        new RegExp(`\\[backup\\] (?:audit-delta|entity-delta):.*${outcome}`, 'i')
      );
    }
  });
}

test('cancelled/rejected write 拒绝无审计且不增 revision 的任一业务实体集合篡改', async () => {
  const mutations = {
    requests: state => { state.requests[0].trace = { nested: { value: 'mutated' } }; },
    samples: state => state.samples.push({ id: 'REQ-MUTATED.001', status: 'pending' }),
    channels: state => state.channels.push({ key: 'DEV-MUTATED|1', state: 'free' }),
    deviceProfiles: state => state.deviceProfiles.push({ id: 'DEV-MUTATED', name: 'DEV-MUTATED' }),
    records: state => state.records.push({ id: 'REC-MUTATED', status: 'completed' }),
    requestSourceRows: state => state.requestSourceRows.push({ requestNo: 'REQ-MUTATED' }),
    testers: state => state.testers.push({ id: 'T-MUTATED', name: '测试员变更' }),
    formChangeJournal: state => state.formChangeJournal.push({ id: 'JOURNAL-MUTATED' })
  };
  for (const outcome of ['cancelled', 'rejected']) {
    for (const [collection, mutate] of Object.entries(mutations)) {
      await assert.rejects(
        executeWorkflowAction({
          driver: fakeDriver({ outcome: '', blockWrites: true, finalBoundaryMutation: mutate }),
          action: {
            type: 'backup',
            params: outcome === 'cancelled' ? { cancel: true } : { path: 'backup.batterydata' },
            revisionDelta: 0
          },
          context: { ...conservativeContext('dashboard'), outcomeReader: async () => outcome }
        }),
        new RegExp(`\\[backup\\] entity-delta: ${outcome} requires unchanged business entities; changed=${collection}`)
      );
    }
  }
});

test('cancelled/rejected write 的 definition revisionDelta=1 不能放行无审计 revision-only save', async () => {
  for (const outcome of ['cancelled', 'rejected']) {
    const driver = fakeDriver({ outcome: '', blockWrites: true, finalBoundaryRevisionDelta: 1 });
    await assert.rejects(
      executeWorkflowAction({
        driver,
        action: { type: 'startTodo', expect: outcome, params: { sampleId: 'REQ-RES.001' } },
        context: { ...conservativeContext('dashboard'), outcomeReader: async () => outcome }
      }),
      new RegExp(`\\[startTodo\\] revision: ${outcome} requires 0, actual 1`, 'i')
    );
    assert.equal(ACTION_LIBRARY.startTodo.revisionDelta, 1);
    assert.deepEqual(driver.stats(), { revision: 2, successfulWrites: 0 });
  }
});

test('完整 settlement.auditIds 供 runner 按 ID 过滤时不会隐藏新增审计', async () => {
  const driver = fakeDriver({ initialPage: 'apply' });
  const result = await executeWorkflowAction({
    driver,
    action: { type: 'reserve', params: {
      requestNo: 'REQ-001', sampleIds: ['REQ-001.001'], channelKeys: ['DEV|3'],
      start: '2026-08-22T09:00', end: '2026-08-22T10:00'
    } },
    context: conservativeContext('apply')
  });
  const runnerIds = new Set(result.settlement.auditIds);
  const runnerVisible = result.settlement.state.auditLogs.filter(item => runnerIds.has(item.id));
  assert.deepEqual(runnerVisible.map(item => item.id), ['AUDIT-RESERVE']);
  assert.deepEqual(result.settlement.auditEvidence.map(item => item.id), ['AUDIT-RESERVE']);
});

test('fake barrier 拒绝 renderer 候选在持久化中缺少同一 exact ID', async () => {
  const driver = fakeDriver({
    initialPage: 'apply',
    fixtureAudits: [{ id: 'AUDIT-RENDERER', action: '提交预约', user: 'worker-A', target: '会话 A' }],
    persistedFixtureAudits: [{ id: 'AUDIT-OTHER', action: '提交预约', user: 'worker-A', target: '会话 A' }]
  });
  await assert.rejects(
    driver.waitForPersistenceBarrier({
      auditAction: '提交预约', actor: 'worker-A', auditTarget: '会话 A', timeoutMs: 50
    }),
    /exact.*AUDIT-RENDERER/i
  );
});

test('rejected 动作只排空 boundary，不接受旧 toast 或业务审计', async () => {
  const driver = fakeDriver({ outcome: 'rejected', initialPage: 'apply' });
  const params = {
    session: 'B', operation: 'reserve', requestNo: 'REQ-001',
    sampleIds: ['REQ-001.001'], channelKeys: ['DEV|3'],
    start: '2026-08-22T09:00', end: '2026-08-22T10:00'
  };
  const page = driver.page();
  const locator = page.getByRole('button', { name: '提交预约', exact: true });
  const runtime = { staleDrafts: new Map([['B:reserve', {
    operation: 'reserve', params, driver, activeDriver: driver, page, locator,
    evidenceBaseUi: await driver.uiProjection()
  }]]) };
  const action = { type: 'staleSubmit', expect: 'rejected', params };
  const result = await executeWorkflowAction({ driver, action, context: { ...conservativeContext('apply'), runtime } });
  assert.equal(result.outcome, 'rejected');
  assert.deepEqual(result.settlement.auditIds, []);
  assert.equal(result.settlement.persistedRevision - result.settlement.beforeRevision, 0);
});

test('settlement 超时 poison runtime 并关闭 active driver', async () => {
  const runtime = {};
  const driver = fakeDriver({ initialPage: 'apply', persistenceBarrierNeverSettles: true });
  const action = { type: 'reserve', maxMs: 20, params: {
    requestNo: 'REQ-001', sampleIds: ['REQ-001.001'], channelKeys: ['DEV|3'],
    start: '2026-08-22T09:00', end: '2026-08-22T10:00'
  } };
  const context = { ...conservativeContext('apply'), runtime };
  await assert.rejects(executeWorkflowAction({ driver, action, context }), /\[reserve\] persisted-audit: timed out/);
  assert.equal(context.runtime.poisoned, true);
  assert.equal(driver.calls.filter(call => call[0] === 'close').length, 1);
});

for (const stage of ['final-page', 'audit-resolver', 'persisted-audit', 'final-boundary', 'audit-delta', 'final-projection', 'terminal-state']) {
  test(`settlement ${stage} 超时毒化 runtime、只关闭一次且消费迟到拒绝`, { timeout: 5_000 }, async () => {
    const gate = controlledPromise();
    const driver = fakeDriver({ initialPage: 'apply' });
    const runtime = {};
    const context = {
      ...conservativeContext('apply'),
      runtime,
      settlementStage: (name, value) => name === stage ? gate.promise : value
    };
    if (stage === 'final-page') {
      const originalPage = driver.page;
      driver.page = () => {
        const page = originalPage();
        return {
          ...page,
          locator(selector) {
            const locator = page.locator(selector);
            return selector === '#apply.page.active' ? { ...locator, waitFor: () => gate.promise } : locator;
          }
        };
      };
    }
    if (stage === 'persisted-audit') {
      driver.waitForPersistenceBarrier = options => {
        driver.barriers.push({ ...options, afterAuditIds: [...(options.afterAuditIds || [])] });
        return gate.promise;
      };
    }
    if (stage === 'final-boundary') {
      const capture = driver.capturePersistenceBoundary;
      let captures = 0;
      driver.capturePersistenceBoundary = options => ++captures === 2 ? gate.promise : capture(options);
    }
    let settlementProjectionCalls = 0;
    if (stage === 'final-projection') {
      const project = driver.uiProjection;
      driver.uiProjection = () => {
        const finalPageReady = driver.calls.some(call => call[0] === 'wait-for' && call[1] === '#apply.page.active');
        if (finalPageReady && ++settlementProjectionCalls === 2) return gate.promise;
        return project();
      };
    }
    const lateRejections = [];
    const onUnhandled = reason => lateRejections.push(reason);
    process.on('unhandledRejection', onUnhandled);
    let gateWasConsumed = false;
    try {
      await assert.rejects(
        executeWorkflowAction({
          driver,
          action: { type: 'reserve', maxMs: 40, params: {
            requestNo: 'REQ-001', sampleIds: ['REQ-001.001'], channelKeys: ['DEV|3'],
            start: '2026-08-22T09:00', end: '2026-08-22T10:00'
          } },
          context
        }),
        new RegExp(`\\[reserve\\] ${stage}: timed out`)
      );
      gateWasConsumed = true;
      assert.equal(runtime.poisoned, true);
      assert.equal(driver.calls.filter(call => call[0] === 'close').length, 1);
      if (stage === 'final-projection') assert.equal(settlementProjectionCalls, 2);
      gate.reject(new Error(`late-${stage}`));
      await new Promise(resolve => setImmediate(resolve));
      assert.deepEqual(lateRejections, []);
    } finally {
      if (!gateWasConsumed) gate.resolve();
      process.off('unhandledRejection', onUnhandled);
    }
  });
}

test('revisionDelta 和 write 分类遵守动作合同', () => {
  assert.deepEqual(ACTION_LIBRARY.navigate.revisionDelta, [0, 1]);
  assert.deepEqual(ACTION_LIBRARY.openSecondSession.revisionDelta, [0, 1, 2, 3]);
  assert.deepEqual(ACTION_LIBRARY.openSecondSession.evidenceRevisionDelta, [0, 1, 2, 3]);
  assert.deepEqual(ACTION_LIBRARY.closeSecondSession.revisionDelta, [0, 1]);
  for (const type of ['restart', 'reloadCurrent']) assert.deepEqual(ACTION_LIBRARY[type].revisionDelta, [2, 3], type);
  for (const type of [...READ_ACTIONS.filter(item => item !== 'navigate'), ...CONTROL_ACTIONS.filter(item => !['openSecondSession', 'closeSecondSession', 'restart', 'reloadCurrent'].includes(item))]) {
    assert.equal(ACTION_LIBRARY[type].write, false, type);
    assert.equal(ACTION_LIBRARY[type].revisionDelta, 0, type);
  }
  for (const type of WRITE_ACTIONS) {
    assert.equal(ACTION_LIBRARY[type].write, true, type);
    if (['exportLog', 'exportRequest', 'backup', 'restore'].includes(type)) {
      assert.deepEqual(ACTION_LIBRARY[type].revisionDelta, [0, 1], type);
    } else {
      assert.equal(ACTION_LIBRARY[type].revisionDelta, ['staleSubmit', 'lockedWrite'].includes(type) ? 0 : 1, type);
    }
  }
});

test('navigate 使用可访问角色定位且动作结果包含 UI 证据', async () => {
  const driver = fakeDriver();
  const result = await executeWorkflowAction({
    driver,
    action: { type: 'navigate', params: { label: '日志' } },
    context: conservativeContext('dashboard')
  });
  assert.equal(result.outcome, 'success');
  assert.equal(result.uiEvidence.marker, 'ui');
  assert.deepEqual(result.navigationEvidence, { from: 'dashboard', to: 'records', changed: true });
  assert.deepEqual(driver.calls[0], ['locator', '.nav[data-page="records"]']);
});

test('未知动作、缺参数、available=false和未声明 outcome 都带 type/stage 拒绝', async () => {
  const driver = fakeDriver({ outcome: 'not-declared' });
  await assert.rejects(
    executeWorkflowAction({ driver, action: { type: 'nope', params: {} }, context: {} }),
    /nope.*resolve/i
  );
  await assert.rejects(
    executeWorkflowAction({ driver, action: { type: 'navigate', params: {} }, context: {} }),
    /navigate.*validate.*label/i
  );
  await assert.rejects(
    executeWorkflowAction({ driver, action: { type: 'reserve', params: { requestNo: 'R', sampleIds: ['S'], channelKeys: ['C'] } }, context: { ...conservativeContext('apply'), availability: { reserve: false } } }),
    /reserve.*available/i
  );
  await assert.rejects(
    executeWorkflowAction({ driver, action: { type: 'backup', params: { path: 'backup.batterydata' } }, context: { ...conservativeContext('dashboard'), outcomeReader: async () => 'not-declared' } }),
    /backup.*outcome.*not-declared/i
  );
});

test('动作超时有 type/stage 且不吞掉迟到 promise', async () => {
  const driver = fakeDriver({ executionDelayMs: 30 });
  const original = ACTION_LIBRARY.navigate.maxMs;
  await assert.rejects(
    executeWorkflowAction({
      driver,
      action: { type: 'navigate', params: { label: '日志' }, maxMs: 5 },
      context: conservativeContext('dashboard')
    }),
    /navigate.*execute.*timed out/i
  );
  assert.ok(original > 5);
  await new Promise(resolve => setTimeout(resolve, 40));
});

test('双击结果声称 rejected 时不得隐藏已成功写入的完整审计增量', async () => {
  const driver = fakeDriver({ doubleMode: 'single-success' });
  await assert.rejects(
    executeWorkflowAction({
      driver,
      action: {
        type: 'startTodo',
        params: { sampleId: 'REQ-RES.001', double: true }
      },
      context: { ...conservativeContext('dashboard'), outcomeReader: async () => 'rejected' }
    }),
    /startTodo.*audit-delta.*extra=AUDIT-FAKE-1-/i
  );
  assert.deepEqual(driver.stats(), { revision: 2, successfulWrites: 1 });
  assert.ok(driver.calls.some(call => call[0] === 'locator' && call[1] === '[data-dashboard-action="todo-detail"][data-record-index="1"]'));
  assert.ok(driver.calls.some(call => call[0] === 'locator' && call[1] === '[data-res-start="1"]'));
  assert.ok(driver.calls.some(call => call[0] === 'second-submit' && call[1] === 'rejected'));
});

test('双击若真的造成两次成功写入，完整审计增量在 revision 前拦截第二次写入', async () => {
  const driver = fakeDriver({ doubleMode: 'two-successes' });
  await assert.rejects(
    executeWorkflowAction({
      driver,
      action: { type: 'startTodo', params: { sampleId: 'REQ-RES.001', double: true } },
      context: { ...conservativeContext('dashboard'), outcomeReader: async () => 'success' }
    }),
    /startTodo.*audit-delta.*extra=AUDIT-FAKE-2-/i
  );
  assert.deepEqual(driver.stats(), { revision: 3, successfulWrites: 2 });
});

test('控制动作仅管理 DOM/会话，不直接写 revision', async () => {
  const driver = fakeDriver({ initialPage: 'records' });
  const second = fakeDriver();
  const context = { ...conservativeContext('records'), runtime: {}, createDriver: async () => second };
  await executeWorkflowAction({ driver, action: { type: 'editDraft', params: { label: '备注', value: '草稿' } }, context });
  await executeWorkflowAction({ driver, action: { type: 'retainOldDom', params: { targets: [{ type: 'manageRunning', sampleId: 'REQ-RUN.001', channelKey: 'DEV|2' }] } }, context });
  await executeWorkflowAction({ driver, action: { type: 'reloadCurrent', params: {}, revisionDelta: 0 }, context });
  await executeWorkflowAction({ driver, action: { type: 'openSecondSession', params: {} }, context });
  await executeWorkflowAction({ driver, action: { type: 'closeSecondSession', params: {} }, context });
  assert.equal(driver.stats().revision, 0);
  assert.ok(context.runtime.retainedDom instanceof Map);
  assert.ok(driver.calls.some(call => call[0] === 'reload'));
  assert.ok(second.calls.some(call => call[0] === 'start'));
  assert.ok(second.calls.some(call => call[0] === 'close'));
});

test('openSecondSession 的 B 生命周期先用主会话完成预检再创建第二会话', async () => {
  const primary = fakeDriver({ initialPage: 'records' });
  const second = fakeDriver();
  const runtime = {};
  let primaryProjectionCalls = 0;
  const primaryUiProjection = primary.uiProjection;
  primary.uiProjection = async () => {
    primaryProjectionCalls += 1;
    return primaryUiProjection();
  };

  const result = await executeWorkflowAction({
    driver: primary,
    action: { type: 'openSecondSession', params: { session: 'B' } },
    context: { ...conservativeContext('records'), runtime, createDriver: async () => second }
  });

  assert.equal(result.outcome, 'success');
  assert.ok(primaryProjectionCalls >= 1, 'the unopened B session must not be selected for the initial projection');
  assert.equal(runtime.secondDriver, second);
  assert.ok(second.calls.some(call => call[0] === 'start'));
});

test('closeSecondSession 关闭 B 后用主会话读取最终投影', async () => {
  const primary = fakeDriver({ initialPage: 'records' });
  const second = fakeDriver();
  let secondClosed = false;
  const secondUiProjection = second.uiProjection;
  const secondClose = second.close;
  second.close = async () => {
    secondClosed = true;
    return secondClose();
  };
  second.uiProjection = async () => {
    if (secondClosed) throw new Error('closed B cannot provide a final projection');
    return secondUiProjection();
  };

  const result = await executeWorkflowAction({
    driver: primary,
    action: { type: 'closeSecondSession', params: { session: 'B' } },
    context: { ...conservativeContext('records'), runtime: { secondDriver: second } }
  });

  assert.equal(result.outcome, 'success');
  assert.ok(second.calls.some(call => call[0] === 'close'));
});

test('搜索、筛选与稳定 data attribute 定位器传递中文参数', async () => {
  const driver = fakeDriver({ initialPage: 'apply' });
  const context = conservativeContext('apply');
  context.snapshot.state.channels.push({ key: '新威 1#|1-1', state: 'free' });
  await executeWorkflowAction({ driver, action: { type: 'search', params: { label: '搜索设备、通道或量程', value: '新威 三号' } }, context });
  await executeWorkflowAction({ driver, action: { type: 'filter', params: { selector: '[data-bounded-filter="record-state"]', value: '测试中', control: 'select' } }, context });
  await executeWorkflowAction({ driver, action: { type: 'selectChannel', params: { channelKey: '新威 1#|1-1' } }, context });
  assert.ok(driver.calls.some(call => call[0] === 'label' && call[1] === '搜索设备、通道或量程'));
  assert.ok(driver.calls.some(call => call[0] === 'locator' && call[1] === '[data-bounded-filter="record-state"]'));
  assert.ok(driver.calls.some(call => call[0] === 'locator' && call[1].includes('data-channel-key')));
});

function conservativeContext(page = 'dashboard') {
  const root = path.join(os.tmpdir(), 'battery-workflow-actions-test');
  const state = {
    revision: 0,
    username: 'workflow-user',
    requests: [{ id: 'REQ-001' }],
    samples: [
      { id: 'REQ-001.001', status: 'pending' },
      { id: 'REQ-RES.001', status: 'reserved', channelKey: 'DEV|1' },
      { id: 'REQ-RUN.001', status: 'running', channelKey: 'DEV|2' }
    ],
    channels: [
      { key: 'DEV|1', state: 'booked', nextRecordId: 'REC-RES' },
      { key: 'DEV|2', state: 'busy', currentRecordId: 'REC-RUN' },
      { key: 'DEV|3', state: 'free' }
    ],
    deviceProfiles: [{ id: 'DEV', name: 'DEV' }],
    records: [
      { id: 'REC-OLD', sampleId: 'REQ-RES.001', status: 'completed', channelKey: 'DEV|3' },
      { id: 'REC-RES', sampleId: 'REQ-RES.001', status: 'reserved', channelKey: 'DEV|1' },
      { id: 'REC-RUN', sampleId: 'REQ-RUN.001', status: 'running', channelKey: 'DEV|2' }
    ],
    storageRecords: [],
    testers: [{ id: 'T-1', name: '测试员' }],
    auditLogs: [], formChangeJournal: [], requestSourceRows: []
  };
  const ui = {
    projection: {
      currentPage: page,
      summary: { revision: 0 },
      visible: {
        records: state.records.map(item => ({ id: item.id, status: item.status })),
        samples: state.samples.map(item => ({ id: item.id, status: item.status })),
        channels: state.channels.map(item => ({ key: item.key, state: item.state })),
        todos: [{ id: 'REC-RES', status: 'reserved' }],
        storageRecords: []
      }
    }
  };
  return {
    snapshot: { state }, ui, runtime: {},
    runContext: {
      dataRoot: path.join(root, 'data'), exportsRoot: path.join(root, 'exports'),
      assertWritable(candidate) {
        const relative = path.relative(path.join(root, 'exports'), candidate);
        if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('outside test exports root');
      },
      async prepareInput(target, kind) {
        if (kind === 'folder' || kind === 'directory') await mkdir(target, { recursive: true });
        else { await mkdir(path.dirname(target), { recursive: true }); await writeFile(target, 'workflow test input'); }
      }
    }
  };
}

async function snapshotAtPersistenceBoundary(base, driver) {
  const boundary = await driver.capturePersistenceBoundary({ timeoutMs: 500 });
  const snapshot = structuredClone(base.snapshot);
  snapshot.state = structuredClone(boundary.state);
  return snapshot;
}

test('导航、展开和分页仅使用唯一稳定 data 属性', async () => {
  const navigation = fakeDriver();
  const dashboard = fakeDriver();
  const records = fakeDriver({ initialPage: 'records' });
  await executeWorkflowAction({ driver: navigation, action: { type: 'navigate', params: { label: '日志' } }, context: conservativeContext('dashboard') });
  await executeWorkflowAction({ driver: dashboard, action: { type: 'expand', params: { device: 'DEV' } }, context: conservativeContext('dashboard') });
  await executeWorkflowAction({ driver: records, action: { type: 'nextPage', params: { view: 'records' } }, context: conservativeContext('records') });
  assert.ok(navigation.calls.some(call => call[0] === 'locator' && call[1] === '.nav[data-page="records"]'));
  assert.ok(dashboard.calls.some(call => call[0] === 'locator' && call[1] === '[data-bounded-action="toggle-device"][data-device="DEV"]'));
  assert.ok(records.calls.some(call => call[0] === 'locator' && call[1] === '[data-bounded-action="page"][data-view="records"][data-direction="next"]'));
  await assert.rejects(
    executeWorkflowAction({ driver: records, action: { type: 'nextPage', params: {} }, context: conservativeContext('records') }),
    /nextPage.*validate.*view/i
  );
});

test('startStorage 通过真实长期存储控件选择样品、填写表单并点击提交', async () => {
  const driver = fakeDriver({ initialPage: 'apply' });
  const context = conservativeContext('apply');
  context.snapshot.state.requests.push({ id: 'REQ-STORAGE-UI' });
  context.snapshot.state.samples.push({
    id: 'REQ-STORAGE-UI.001',
    requestNo: 'REQ-STORAGE-UI',
    status: 'pending'
  });
  const params = {
    storageId: 'STO-WORKFLOW-UI',
    requestNo: 'REQ-STORAGE-UI',
    sampleIds: ['REQ-STORAGE-UI.001'],
    tester: 'workflow-user',
    expectedEndAt: '2026-09-30T12:00:00.000Z',
    note: '真实 UI 长期存储'
  };

  const result = await ACTION_LIBRARY.startStorage.execute(driver, params, context);
  const calls = driver.calls;

  assert.equal(result.awaitEvidence, true);
  assert.ok(calls.some(call => call[0] === 'click' && String(call[1]).includes('data-legacy-action="select-request"')));
  assert.ok(calls.some(call => call[0] === 'check' && String(call[1]).includes('data-sample-action="storage-mode-toggle"')));
  assert.ok(calls.some(call => call[0] === 'click' && String(call[1]).includes('data-sample-action="storage-sample-toggle"')));
  assert.ok(calls.some(call => call[0] === 'fill' && call[1] === actionModule.datetimeLocalInstant(params.expectedEndAt)));
  assert.ok(calls.some(call => call[0] === 'fill' && call[1] === params.note));
  assert.ok(calls.some(call => call[0] === 'click' && String(call[1]).includes('data-sample-action="storage-start"')));
  assert.equal(calls.filter(call => call[0] === 'evaluate' && call[1]?.phase === 'arm-storage-id').length, 1);
  assert.equal(calls.filter(call => call[0] === 'evaluate' && call[1]?.phase === 'restore-storage-id').length, 1, 'one-shot UUID override must always be restored');
});

test('startStorage 提交控件失败时仍恢复一次性 UUID 覆盖', async () => {
  const driver = fakeDriver({ initialPage: 'apply', throwOnClickPattern: /storage-start/ });
  const context = conservativeContext('apply');
  context.snapshot.state.requests.push({ id: 'REQ-STORAGE-FAIL' });
  context.snapshot.state.samples.push({ id: 'REQ-STORAGE-FAIL.001', requestNo: 'REQ-STORAGE-FAIL', status: 'pending' });

  await assert.rejects(
    ACTION_LIBRARY.startStorage.execute(driver, {
      storageId: 'STO-WORKFLOW-FAIL',
      requestNo: 'REQ-STORAGE-FAIL',
      sampleIds: ['REQ-STORAGE-FAIL.001'],
      tester: 'workflow-user',
      expectedEndAt: '2026-09-30T12:00:00.000Z'
    }, context),
    /injected click failure/
  );
  assert.equal(driver.calls.filter(call => call[0] === 'evaluate' && call[1]?.phase === 'arm-storage-id').length, 1);
  assert.equal(driver.calls.filter(call => call[0] === 'evaluate' && call[1]?.phase === 'restore-storage-id').length, 1, 'restore must run from finally after click failure');
});

test('不存在的取消通道能力不进入 planner，仅显式 expect=rejected 时执行误用证据', async () => {
  const driver = fakeDriver({ initialPage: 'apply' });
  const context = conservativeContext('apply');
  assert.equal(await ACTION_LIBRARY.unselectChannel.available(context.snapshot, context.ui, { channelKey: 'DEV|1' }, context), false);
  await assert.rejects(
    executeWorkflowAction({ driver, action: { type: 'unselectChannel', params: { channelKey: 'DEV|1' } }, context }),
    /unselectChannel.*available/i
  );
  const channel = await executeWorkflowAction({
    driver,
    action: { type: 'unselectChannel', params: { channelKey: 'DEV|1' }, expect: 'rejected' },
    context
  });
  assert.equal(channel.outcome, 'rejected');
  assert.match(channel.message, /capability|unavailable|不支持/i);
  assert.equal(driver.stats().revision, 0);
});

test('unselectSample 仅关闭指定 picker', async () => {
  const driver = fakeDriver({ initialPage: 'apply' });
  const sample = await executeWorkflowAction({
    driver,
    action: { type: 'unselectSample', params: { sampleId: 'REQ-001.001' } },
    context: conservativeContext('apply')
  });
  assert.equal(sample.outcome, 'success');
  assert.ok(driver.calls.some(call => call[0] === 'locator' && call[1] === '[data-testid="legacy-channel-picker"] > header strong'));
  assert.equal(driver.calls.some(call => call[0] === 'locator' && call[1] === '[data-testid="legacy-channel-picker"] strong'), false);
  assert.ok(driver.calls.some(call => call[0] === 'locator' && call[1] === '[data-legacy-action="close-channel-picker"]'));
});

test('unselectSample 不得关闭属于另一个 sample 的可见 picker', async () => {
  const driver = fakeDriver({ pickerTitle: '为 REQ-OTHER.001 选择通道', initialPage: 'apply' });
  const result = await executeWorkflowAction({
    driver,
    action: { type: 'unselectSample', params: { sampleId: 'REQ-001.001' } },
    context: conservativeContext('apply')
  });
  assert.equal(result.outcome, 'rejected');
  assert.match(result.message, /picker.*REQ-OTHER\.001.*REQ-001\.001/i);
  assert.equal(driver.calls.some(call => call[0] === 'click' && call[1] === '[data-legacy-action="close-channel-picker"]'), false);
});

test('unselectSample 在没有 picker 时返回明确 rejected，不把合法拒绝当作 locator 异常', async () => {
  const driver = fakeDriver({ initialPage: 'apply' });
  const page = driver.page();
  const originalLocator = page.locator.bind(page);
  page.locator = selector => {
    const locator = originalLocator(selector);
    if (selector !== '[data-testid="legacy-channel-picker"] > header strong') return locator;
    return { ...locator, async count() { return 0; } };
  };

  const result = await executeWorkflowAction({
    driver,
    action: { type: 'unselectSample', expect: 'rejected', params: { sampleId: 'REQ-001.001' } },
    context: conservativeContext('apply')
  });

  assert.equal(result.outcome, 'rejected');
  assert.match(result.message, /picker.*REQ-001\.001.*not visible/i);
  assert.equal(driver.calls.some(call => call[0] === 'click' && call[1] === '[data-legacy-action="close-channel-picker"]'), false);
});

function reservationCancellationProbe() {
  return {
    type: 'reserve',
    params: { requestNo: 'REQ-001', sampleIds: ['REQ-001.001'], channelKeys: ['DEV|3'], confirm: false },
    revisionDelta: 0,
    maxMs: 100
  };
}

test('写动作缺少 revision、消息或目标状态证据时不得默认 success，原生取消按配置路由显式收口', async () => {
  const driver = fakeDriver({ outcome: '' });
  await assert.rejects(
    executeWorkflowAction({
      driver,
      action: { type: 'backup', params: { path: 'out.batterydata' }, revisionDelta: 0, maxMs: 100 },
      context: conservativeContext('dashboard')
    }),
    /backup.*evidence/i
  );
  const cancelDriver = fakeDriver({ outcome: '', blockWrites: true });
  const cancelled = await executeWorkflowAction({
    driver: cancelDriver,
    action: { type: 'backup', params: { cancel: true }, revisionDelta: 0, maxMs: 100 },
    context: conservativeContext('dashboard')
  });
  assert.equal(cancelled.outcome, 'cancelled');
  assert.deepEqual(cancelDriver.stats(), { revision: 0, successfulWrites: 0 });
  assert.ok(cancelDriver.calls.some(call => call[0] === 'dialogs'));
});

test('cancel 不得复用动作前已经可见且未变化的旧取消 toast', async () => {
  const driver = fakeDriver({ outcome: '已取消预约', blockWrites: true });
  await assert.rejects(
    executeWorkflowAction({
      driver,
      action: reservationCancellationProbe(),
      context: conservativeContext('apply')
    }),
    /reserve.*evidence.*no fresh/i
  );
});

test('同一可见消息实例即使 mutation version 增加也不是 fresh evidence', async () => {
  let reads = 0;
  const driver = fakeDriver({ blockWrites: true });
  await assert.rejects(
    executeWorkflowAction({
      driver,
      action: reservationCancellationProbe(),
      context: {
        ...conservativeContext('apply'),
        messageStateReader: () => ({ version: reads++, text: '已取消预约', visible: true, instance: 'toast-1' })
      }
    }),
    /reserve.*evidence.*no fresh/i
  );
});

test('同一消息实例在本次动作改变文本后即使 toast 已过期仍是 fresh evidence', async () => {
  let reads = 0;
  const driver = fakeDriver({ blockWrites: true });
  const result = await executeWorkflowAction({
    driver,
    action: reservationCancellationProbe(),
    context: {
      ...conservativeContext('apply'),
      messageStateReader: () => reads++ === 0
        ? { version: 0, text: '', visible: false, instance: 'toast-1' }
        : { version: 2, text: '所选申请包含活动记录，整批删除已阻断', visible: false, instance: 'toast-1' }
    }
  });
  assert.equal(result.outcome, 'rejected');
});

test('执行字段未发生变化是明确 rejected 证据', async () => {
  let reads = 0;
  const driver = fakeDriver({ blockWrites: true });
  const result = await executeWorkflowAction({
    driver,
    action: reservationCancellationProbe(),
    context: {
      ...conservativeContext('apply'),
      messageStateReader: () => reads++ === 0
        ? { version: 0, text: '', visible: false, instance: 'message-1' }
        : { version: 1, text: '执行字段未发生变化', visible: false, instance: 'message-1' }
    }
  });
  assert.equal(result.outcome, 'rejected');
});

test('SQLite 英文写锁错误是明确 rejected 证据', async () => {
  let reads = 0;
  const driver = fakeDriver({ blockWrites: true });
  const result = await executeWorkflowAction({
    driver,
    action: reservationCancellationProbe(),
    context: {
      ...conservativeContext('apply'),
      messageStateReader: () => reads++ === 0
        ? { version: 0, text: '', visible: false, instance: 'message-1' }
        : { version: 1, text: 'database is locked', visible: true, instance: 'message-2' }
    }
  });
  assert.equal(result.outcome, 'rejected');
});

test('同一文本由隐藏变为可见可作为本次 fresh evidence', async () => {
  let reads = 0;
  const driver = fakeDriver({ blockWrites: true });
  const result = await executeWorkflowAction({
    driver,
    action: reservationCancellationProbe(),
    context: {
      ...conservativeContext('apply'),
      messageStateReader: () => reads++ === 0
        ? { version: 0, text: '已取消预约', visible: false, instance: 'toast-1' }
        : { version: 1, text: '已取消预约', visible: true, instance: 'toast-1' }
    }
  });
  assert.equal(result.outcome, 'cancelled');
});

test('新消息实例即使文本相同也可作为本次 fresh evidence', async () => {
  let reads = 0;
  const driver = fakeDriver({ blockWrites: true });
  const result = await executeWorkflowAction({
    driver,
    action: reservationCancellationProbe(),
    context: {
      ...conservativeContext('apply'),
      messageStateReader: () => ({ version: reads, text: '已取消预约', visible: true, instance: `toast-${reads++ + 1}` })
    }
  });
  assert.equal(result.outcome, 'cancelled');
});

test('timeout poison 关闭对应 driver，等待迟到动作收口并阻止后续动作', async () => {
  let revision = 0;
  let closed = false;
  let closeCalls = 0;
  const delayedLocator = {
    async count() { return 1; },
    async click() {
      await new Promise(resolve => setTimeout(resolve, 30));
      if (!closed) revision += 1;
    }
  };
  const driver = {
    page: () => ({ locator: () => delayedLocator }),
    uiProjection: async () => ({ projection: { currentPage: 'dashboard', summary: { revision }, visible: { records: [], samples: [], channels: [], todos: [] } } }),
    async close() { closeCalls += 1; closed = true; }
  };
  const context = Object.freeze({ ...conservativeContext('dashboard'), runtime: {} });
  await assert.rejects(
    executeWorkflowAction({ driver, action: { type: 'navigate', params: { label: '日志' }, maxMs: 5 }, context }),
    /navigate.*execute.*timed out/i
  );
  const after = revision;
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal(revision, after);
  assert.equal(closeCalls, 1);
  assert.equal(context.runtime.poisoned, true);
  await assert.rejects(
    executeWorkflowAction({ driver, action: { type: 'navigate', params: { label: '看板' } }, context }),
    /poisoned/i
  );
});

async function testDeadline(promise, timeoutMs = 250) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('test watchdog exceeded')), timeoutMs); })
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function stagedHangDriver(hangProjectionCall = 0) {
  let projections = 0;
  let closeCalls = 0;
  const locator = {
    async count() { return 1; },
    async click() {},
    async isVisible() { return true; },
    async textContent() { return ''; }
  };
  const page = { locator: () => locator, evaluate: async () => ({ version: 0, text: '' }) };
  return {
    page: () => page,
    async uiProjection() {
      projections += 1;
      if (projections === hangProjectionCall) return new Promise(() => {});
      return { projection: { currentPage: 'dashboard', summary: { revision: 0 }, visible: {} } };
    },
    async close() { closeCalls += 1; },
    stats: () => ({ projections, closeCalls })
  };
}

for (const scenario of [
  { name: 'initial projection', hangProjectionCall: 1, context: () => ({ snapshot: conservativeContext().snapshot, runtime: {} }) },
  { name: 'available', hangProjectionCall: 0, context: () => ({ ...conservativeContext(), availability: { navigate: () => new Promise(() => {}) }, runtime: {} }) },
  { name: 'final projection', hangProjectionCall: 2, context: () => ({ snapshot: conservativeContext().snapshot, runtime: {} }) }
]) {
  test(`maxMs 覆盖 ${scenario.name} 挂起并 poison/close`, async () => {
    const driver = stagedHangDriver(scenario.hangProjectionCall);
    const context = scenario.context();
    const started = Date.now();
    await assert.rejects(
      testDeadline(executeWorkflowAction({ driver, action: { type: 'navigate', params: { label: '看板' }, maxMs: 20 }, context })),
      new RegExp(`navigate.*${scenario.name}.*timed out`, 'i')
    );
    assert.equal(context.runtime.poisoned, true);
    assert.equal(driver.stats().closeCalls, 1);
    assert.ok(Date.now() - started < 200, scenario.name);
  });
}

test('available 对未知快照保守 false，并按 active pointer/status 选择 reserved/running', () => {
  const context = conservativeContext('dashboard');
  assert.equal(ACTION_LIBRARY.startTodo.available({}, context.ui, { sampleId: 'REQ-RES.001' }, context), false);
  assert.equal(ACTION_LIBRARY.startTodo.available(context.snapshot, context.ui, { sampleId: 'REQ-RES.001' }, context), true);
  assert.equal(ACTION_LIBRARY.startTodo.available(context.snapshot, context.ui, { sampleId: 'REQ-RUN.001' }, context), false);
  assert.equal(ACTION_LIBRARY.delayRunning.available(context.snapshot, { ...context.ui, projection: { ...context.ui.projection, currentPage: 'records' } }, { sampleId: 'REQ-RUN.001' }, context), true);
  assert.equal(ACTION_LIBRARY.delayRunning.available(context.snapshot, context.ui, { sampleId: 'REQ-RES.001' }, context), false);
});

test('严格参数验证拒绝错误 array/boolean/session/kind/policy/operation/resource kind', async () => {
  const driver = fakeDriver();
  const cases = [
    { type: 'reserve', params: { requestNo: 'R', sampleIds: 'S', channelKeys: ['C'], confirm: true } },
    { type: 'reserve', params: { requestNo: 'R', sampleIds: ['S'], channelKeys: ['C'], confirm: 'yes' } },
    { type: 'importRequest', params: { path: 'x', kind: 'zip', duplicatePolicy: 'merge' } },
    { type: 'lockedWrite', params: { operation: 'drop-table' } },
    { type: 'deleteResource', params: { kind: 'database', name: 'x' } },
    { type: 'navigate', params: { label: '日志', session: 'C' } }
  ];
  for (const action of cases) {
    await assert.rejects(executeWorkflowAction({ driver, action, context: conservativeContext('dashboard') }), new RegExp(`${action.type}.*validate`, 'i'));
  }
});

test('必填标识符与数组元素必须是非空字符串', async () => {
  const driver = fakeDriver();
  const cases = [
    { type: 'navigate', params: { label: 7 } },
    { type: 'startTodo', params: { sampleId: 7 } },
    { type: 'reserve', params: { requestNo: 7, sampleIds: ['REQ-001.001'], channelKeys: ['DEV|3'] } },
    { type: 'reserve', params: { requestNo: 'REQ-001', sampleIds: [' '], channelKeys: ['DEV|3'] } },
    { type: 'retainOldDom', params: { targets: [{ type: 'startTodo', sampleId: ' ' }] } }
  ];
  for (const action of cases) {
    await assert.rejects(
      executeWorkflowAction({ driver, action, context: conservativeContext('dashboard') }),
      new RegExp(`${action.type}.*validate.*non-empty string`, 'i')
    );
  }
});

test('D01 的预约结束时间允许显式留空，并将空值写入受控表单', async () => {
  const driver = fakeDriver({ initialPage: 'apply' });
  const result = await executeWorkflowAction({
    driver,
    action: {
      type: 'reserve', expect: 'success', revisionDelta: 1, maxMs: 500,
      params: { requestNo: 'REQ-001', sampleIds: ['REQ-001.001'], channelKeys: ['DEV|3'], end: '', confirm: true }
    },
    context: conservativeContext('apply')
  });
  assert.equal(result.outcome, 'success');
  assert.ok(driver.calls.some(call => call[0] === 'locator' && call[1] === '[data-testid="legacy-reservation-details"][data-request-no="REQ-001"]'));
  assert.ok(driver.calls.some(call => call[0] === 'nested-label' && call[1] === '预计结束时间（可选）'));
  assert.ok(driver.calls.some(call => call[0] === 'fill' && call[1] === ''));
});

test('filter selector 仅接受稳定 data 属性且 fields 必须是可填 plain object', async () => {
  const driver = fakeDriver();
  const cases = [
    { type: 'filter', params: { selector: 'div:nth-child(2)', value: 'x' } },
    { type: 'filter', params: { selector: '[data-bounded-filter="x"], body', value: 'x' } },
    { type: 'filter', params: { selector: null, value: 'x' } },
    { type: 'editExecution', params: { requestNo: 'REQ-001', fields: [] } },
    { type: 'editExecution', params: { requestNo: 'REQ-001', fields: { 备注: null } } },
    { type: 'editExecution', params: { requestNo: 'REQ-001', fields: { 备注: { nested: true } } } }
  ];
  for (const action of cases) {
    await assert.rejects(
      executeWorkflowAction({ driver, action, context: conservativeContext('requests') }),
      new RegExp(`${action.type}.*validate`, 'i')
    );
  }
});

test('checkbox filter 只接受 boolean，false 必须执行 uncheck', async () => {
  const driver = fakeDriver();
  const action = { type: 'filter', params: { selector: '[data-bounded-filter="pending-only"]', control: 'checkbox', value: false } };
  const result = await executeWorkflowAction({ driver, action, context: conservativeContext('dashboard') });
  assert.equal(result.outcome, 'success');
  assert.ok(driver.calls.some(call => call[0] === 'uncheck'));
  assert.equal(driver.calls.some(call => call[0] === 'check'), false);
  await assert.rejects(
    executeWorkflowAction({
      driver,
      action: { ...action, params: { ...action.params, value: 'false' } },
      context: conservativeContext('dashboard')
    }),
    /filter.*validate.*boolean/i
  );
});

test('D03/D07/M05/M09/M11/M12 参数实际进入 dialog、locator 与 runtime 分支', async () => {
  for (const confirm of [false, true]) {
    let messageVersion = 0;
    const driver = fakeDriver({ dialogCount: 1, blockWrites: !confirm });
    const result = await executeWorkflowAction({
      driver,
      action: { type: 'reserve', params: { requestNo: 'REQ-001', sampleIds: ['REQ-001.001'], channelKeys: ['DEV|3'], confirm }, revisionDelta: confirm ? 1 : 0 },
      context: { ...conservativeContext('dashboard'), messageStateReader: () => confirm ? { version: 0, text: '' } : (++messageVersion === 1 ? { version: 0, text: '' } : { version: 1, text: '用户未确认 WARNING，整批预约未保存' }) }
    });
    assert.equal(result.outcome, confirm ? 'success' : 'warning');
    assert.ok(driver.calls.some(call => call[0] === 'dialog' && call[1] === (confirm ? 'accept' : 'dismiss')));
  }

  for (const duplicatePolicy of ['skip', 'cover']) {
    const driver = fakeDriver({ dialogCount: 1 });
    const result = await executeWorkflowAction({
      driver,
      action: { type: 'importRequest', params: { path: 'duplicate.xlsx', kind: 'file', duplicatePolicy, expectedValidCount: 1 } },
      context: conservativeContext('dashboard')
    });
    assert.equal(result.outcome, 'success');
    assert.equal(result.settlement.auditEvidence[0].target, '申请单批次（1 条有效）');
    assert.ok(driver.calls.some(call => call[0] === 'dialog' && call[1] === (duplicatePolicy === 'cover' ? 'accept' : 'dismiss')));
    assert.ok(driver.calls.some(call => call[0] === 'dialogs'));
  }

  let cancelProbe = 0;
  const cancelDriver = fakeDriver({ blockWrites: true });
  const cancelResult = await executeWorkflowAction({
    driver: cancelDriver,
    action: { type: 'importRequest', params: { cancel: true, kind: 'file' }, revisionDelta: 0 },
    context: { ...conservativeContext('dashboard'), messageStateReader: () => (++cancelProbe === 1 ? { version: 0, text: '' } : { version: 1, text: '已取消导入' }) }
  });
  assert.equal(cancelResult.outcome, 'cancelled');
  assert.ok(cancelDriver.calls.some(call => call[0] === 'dialogs'));

  const runtime = { retainedDom: new Map([['manageRunning:REQ-RUN.001', { async evaluate() { return false; }, async click() { throw new Error('detached'); } }]]) };
  const context = { ...conservativeContext('dashboard'), runtime, createDriver: async () => fakeDriver({ blockWrites: true }), outcomeReader: () => 'rejected' };
  const staleParams = { operation: 'reserve', requestNo: 'REQ-001', sampleIds: ['REQ-001.001'], channelKeys: ['DEV|3'] };
  await executeWorkflowAction({ driver: fakeDriver(), action: { type: 'openSecondSession', params: { prepareStale: staleParams } }, context });
  assert.ok(runtime.secondDriver);
  const staleSnapshot = await snapshotAtPersistenceBoundary(context, runtime.secondDriver);
  const stale = await executeWorkflowAction({ driver: fakeDriver(), action: { type: 'staleSubmit', params: { session: 'B', ...staleParams } }, context: { ...context, snapshot: staleSnapshot } });
  assert.equal(stale.outcome, 'rejected');
  const old = await executeWorkflowAction({ driver: fakeDriver(), action: { type: 'manageRunning', params: { sampleId: 'REQ-RUN.001', old: true }, revisionDelta: 0 }, context });
  assert.equal(old.outcome, 'rejected');
  const locked = await executeWorkflowAction({ driver: fakeDriver({ blockWrites: true }), action: { type: 'lockedWrite', params: { operation: 'reserve', requestNo: 'REQ-001', sampleIds: ['REQ-001.001'], channelKeys: ['DEV|3'] } }, context: { ...context, armWriteLock: () => () => {} } });
  assert.equal(locked.outcome, 'rejected');
  assert.ok(runtime.secondDriver.calls.some(call => call[0] === 'role' && call[2]?.name === '提交预约'));
});

test('M12 与 stale B 从 dashboard 导航到各自真实业务页后才定位写入口', async () => {
  for (const scenario of [
    {
      operation: 'reserve', page: 'apply', label: '提交预约',
      params: { requestNo: 'REQ-001', sampleIds: ['REQ-001.001'], channelKeys: ['DEV|3'], start: '2026-08-22T09:00', end: '2026-08-22T10:00' },
      prepSelector: '[data-legacy-action="select-request"][data-request-no="REQ-001"]'
    },
    {
      operation: 'manageRunning', page: 'records', label: '保存测试管理',
      params: { sampleId: 'REQ-RUN.001', channelKey: 'DEV|2', end: '2026-08-22T10:00', condition: '锁冲突探针' },
      prepSelector: '[data-bounded-action="manage-running"][data-sample-id="REQ-RUN.001"][data-channel-key="DEV%7C2"]'
    }
  ]) {
    const driver = fakeDriver({ blockWrites: true });
    const result = await executeWorkflowAction({
      driver,
      action: { type: 'lockedWrite', params: { operation: scenario.operation, ...scenario.params } },
      context: { ...conservativeContext('dashboard'), outcomeReader: () => 'rejected', armWriteLock: () => () => {} }
    });
    assert.equal(result.outcome, 'rejected');
    assert.ok(driver.calls.some(call => call[0] === 'locator' && call[1] === `.nav[data-page="${scenario.page}"]`));
    assert.ok(driver.calls.some(call => call[0] === 'locator' && call[1] === scenario.prepSelector));
    assert.ok(driver.calls.some(call => call[0] === 'role' && call[2]?.name === scenario.label));
  }

  const second = fakeDriver({ blockWrites: true });
  const runtime = {};
  const staleParams = { operation: 'reserve', requestNo: 'REQ-001', sampleIds: ['REQ-001.001'], channelKeys: ['DEV|3'] };
  const primary = fakeDriver();
  const context = { ...conservativeContext('dashboard'), runtime, createDriver: async () => second, outcomeReader: () => 'rejected' };
  await executeWorkflowAction({ driver: primary, action: { type: 'openSecondSession', params: { prepareStale: staleParams } }, context });
  const staleSnapshot = await snapshotAtPersistenceBoundary(context, second);
  const beforeStale = second.calls.length;
  const stale = await executeWorkflowAction({
    driver: primary,
    action: { type: 'staleSubmit', params: { session: 'B', ...staleParams } },
    context: { ...context, snapshot: staleSnapshot }
  });
  assert.equal(stale.outcome, 'rejected');
  assert.ok(second.calls.some(call => call[0] === 'locator' && call[1] === '.nav[data-page="apply"]'));
  assert.ok(second.calls.some(call => call[0] === 'locator' && call[1] === '[data-legacy-action="select-request"][data-request-no="REQ-001"]'));
  assert.ok(second.calls.some(call => call[0] === 'role' && call[2]?.name === '提交预约'));
  assert.equal(second.calls.slice(beforeStale).some(call => call[0] === 'locator' && String(call[1]).startsWith('.nav[data-page=')), false);
  assert.equal(await second.page().getByRole('button', { name: '不存在入口', exact: true }).count(), 0);
});

test('openSecondSession 在 A 写入前准备 B 草稿，staleSubmit 只消费缓存提交入口', async () => {
  const main = fakeDriver();
  const second = fakeDriver({ blockWrites: true });
  const runtime = {};
  const prepareStale = {
    operation: 'reserve', requestNo: 'REQ-001', sampleIds: ['REQ-001.001'], channelKeys: ['DEV|3'],
    start: '2026-08-22T09:00', end: '2026-08-22T10:00', username: 'fake-second'
  };
  const base = conservativeContext('dashboard');
  await executeWorkflowAction({
    driver: main,
    action: { type: 'openSecondSession', params: { prepareStale } },
    context: { ...base, runtime, createDriver: async () => second }
  });
  assert.ok(runtime.staleDrafts instanceof Map);
  assert.ok(runtime.staleDrafts.has('B:reserve'));
  assert.deepEqual(second.calls.find(call => call[0] === 'persistence-barrier'), [
    'persistence-barrier', { auditAction: '登录看板', actor: 'fake-second', timeoutMs: 5_000 }
  ]);
  const preparedCalls = second.calls.length;

  await executeWorkflowAction({
    driver: main,
    action: { type: 'reserve', params: prepareStale },
    context: { ...base, runtime: {} }
  });
  second.advanceRevision(1);
  const freshSnapshot = await snapshotAtPersistenceBoundary(base, second);
  const beforeStale = second.calls.length;
  const result = await executeWorkflowAction({
    driver: main,
    action: { type: 'staleSubmit', params: { session: 'B', ...prepareStale }, expect: 'rejected' },
    context: { ...base, snapshot: freshSnapshot, runtime, outcomeReader: () => 'rejected' }
  });
  assert.equal(result.outcome, 'rejected');
  assert.ok(preparedCalls > 0);
  const staleCalls = second.calls.slice(beforeStale);
  assert.equal(staleCalls.some(call => call[0] === 'locator' && String(call[1]).startsWith('.nav[data-page=')), false);
  assert.equal(staleCalls.some(call => ['reload', 'load-state'].includes(call[0])), false);
  assert.equal(staleCalls.filter(call => call[0] === 'click' && call[1] === '提交预约').length, 1);
  assert.ok(staleCalls.findIndex(call => call[0] === 'click' && call[1] === '提交预约')
    < staleCalls.findIndex(call => call[0] === 'boundary'));
});

test('M09 mixed-invalid 同时执行 invalid confirm、duplicate policy 和导入定位分支', async () => {
  const driver = fakeDriver({ dialogCount: 2, blockWrites: true });
  const result = await executeWorkflowAction({
    driver,
    action: {
      type: 'importRequest',
      params: {
        paths: ['blank.xlsx', 'corrupt.xlsx', 'locked.xlsx', 'same-id.xlsx'],
        kind: 'file',
        invalidConfirm: false,
        duplicatePolicy: 'cover',
        expectedValidCount: 1
      },
      revisionDelta: 0
    },
    context: { ...conservativeContext('dashboard'), outcomeReader: () => 'rejected' }
  });
  assert.equal(result.outcome, 'rejected');
  assert.ok(driver.calls.some(call => call[0] === 'dialogs'));
  assert.deepEqual(driver.calls.filter(call => call[0] === 'dialog').map(call => call[1]), ['dismiss', 'accept']);
  assert.ok(driver.calls.some(call => call[0] === 'role' && call[2]?.name instanceof RegExp && call[2].name.test('导入单个 Excel')));
});

test('分页禁用和设备展开状态不匹配时有证据拒绝且不点击', async () => {
  const disabled = fakeDriver({ initialPage: 'records', disabledPattern: /data-direction="next"/ });
  const pageResult = await executeWorkflowAction({
    driver: disabled,
    action: { type: 'nextPage', params: { view: 'records' } },
    context: conservativeContext('records')
  });
  assert.equal(pageResult.outcome, 'rejected');
  assert.equal(disabled.calls.some(call => call[0] === 'click'), false);

  const alreadyExpanded = fakeDriver({ toggleText: '收起 −' });
  const expandResult = await executeWorkflowAction({
    driver: alreadyExpanded,
    action: { type: 'expand', params: { device: 'DEV' } },
    context: conservativeContext('dashboard')
  });
  assert.equal(expandResult.outcome, 'rejected');
  assert.equal(alreadyExpanded.calls.some(call => call[0] === 'click'), false);
});

test('dashboard 上的固定目录首动作按业务 target page 自动导航后执行', async () => {
  const scenarios = [
    { page: 'requests', action: { type: 'importRequest', params: { path: 'valid.xlsx', kind: 'file', expectedValidCount: 1 } } },
    { page: 'apply', action: { type: 'reserve', params: { requestNo: 'REQ-001', sampleIds: ['REQ-001.001'], channelKeys: ['DEV|3'], confirm: false } } },
    { page: 'apply', action: { type: 'startImmediately', params: { requestNo: 'REQ-001', sampleIds: ['REQ-001.001'], channelKeys: ['DEV|3'], confirm: true } } },
    { page: 'testers', action: { type: 'createTester', params: { name: '新测试员' } } },
    { page: 'devices', action: { type: 'createDevice', params: { name: '新设备' } } },
    { page: 'records', action: { type: 'finishRunning', params: { sampleId: 'REQ-RUN.001' } } },
    { page: 'requests', action: { type: 'editExecution', params: { requestNo: 'REQ-001', fields: { 备注: '已核对' } } } },
    { page: 'records', action: { type: 'exportLog', params: { path: 'log.xlsx' } } },
    { page: 'requests', action: { type: 'exportRequest', params: { path: 'requests.xlsx' } } }
  ];
  for (const scenario of scenarios) {
    const driver = fakeDriver({ outcome: '' });
    const context = conservativeContext('dashboard');
    assert.equal(await ACTION_LIBRARY[scenario.action.type].available(context.snapshot, context.ui, scenario.action.params, context), true, scenario.action.type);
    const result = await executeWorkflowAction({ driver, action: { ...scenario.action, maxMs: 500 }, context });
    assert.equal(result.outcome, 'success', scenario.action.type);
    assert.ok(driver.calls.some(call => call[0] === 'locator' && call[1] === `.nav[data-page="${scenario.page}"]`), scenario.action.type);
    assert.ok(driver.calls.some(call => call[0] === 'click' && call[1] === `.nav[data-page="${scenario.page}"]`), scenario.action.type);
    if (scenario.action.type === 'editExecution') {
      assert.ok(
        driver.calls.some(call => call[0] === 'nested-role' && call[1] === 'button' && call[2]?.name === '保存执行字段'),
        'editExecution 必须定位当前 MAIN 的保存执行字段按钮'
      );
    }
  }
});

test('createChannel 使用指定设备的唯一新增通道入口，避开同名设备行按钮', async () => {
  const driver = fakeDriver({ initialPage: 'devices', preselectedChannelDevice: 'DEV' });
  const page = driver.page();
  const getByRole = page.getByRole.bind(page);
  page.getByRole = (role, options) => {
    if (role === 'button' && options?.name instanceof RegExp && options.name.test('新增通道')) {
      return {
        async count() { return 27; },
        async click() { throw new Error('strict mode violation: 27 matching add-channel buttons'); }
      };
    }
    return getByRole(role, options);
  };

  const result = await executeWorkflowAction({
    driver,
    action: {
      type: 'createChannel', expect: 'success', revisionDelta: 1, maxMs: 500,
      params: { device: 'DEV', name: 'C04-unique' }
    },
    context: conservativeContext('devices')
  });

  assert.equal(result.outcome, 'success');
  assert.ok(driver.calls.some(call => call[0] === 'locator'
    && call[1] === '[data-bounded-action="add-channel"][data-device="DEV"]'));
});

test('createChannel 验证指定设备入口已预选的所属设备，不重新按标签选择', async () => {
  const driver = fakeDriver({ initialPage: 'devices', preselectedChannelDevice: 'DEV' });
  const result = await executeWorkflowAction({
    driver,
    action: {
      type: 'createChannel', expect: 'success', revisionDelta: 1, maxMs: 500,
      params: { device: 'DEV', name: 'C04-preselected' }
    },
    context: conservativeContext('devices')
  });

  assert.equal(result.outcome, 'success');
  assert.ok(driver.calls.some(call => call[0] === 'locator' && call[1] === '#channelEditor'));
  assert.ok(driver.calls.some(call => call[0] === 'nested-locator' && call[1] === '#cDevice'));
  assert.equal(driver.calls.some(call => call[0] === 'selectOption'), false);
});

test('createChannel 仅在 channelEditor 内填写重复字段并保存', async () => {
  const driver = fakeDriver({
    initialPage: 'devices', preselectedChannelDevice: 'DEV', pageLevelChannelFieldsAmbiguous: true
  });
  const result = await executeWorkflowAction({
    driver,
    action: {
      type: 'createChannel', expect: 'success', revisionDelta: 1, maxMs: 500,
      params: { device: 'DEV', name: 'C04-scoped-fields', temperature: '常温', note: 'scoped editor' }
    },
    context: conservativeContext('devices')
  });

  assert.equal(result.outcome, 'success');
  assert.deepEqual(
    driver.calls.filter(call => call[0] === 'nested-label').map(call => call[1]),
    ['通道号 *', '温度范围', '备注']
  );
  assert.ok(driver.calls.some(call => call[0] === 'nested-role' && call[1] === 'button' && call[2]?.name === '保存通道'));
});

test('createChannel 在 devices 页保存后入口缺失时真实重进设备页再定位指定入口', async () => {
  const driver = fakeDriver({
    initialPage: 'devices', preselectedChannelDevice: 'DEV', channelEntryMissingUntilDevicesReentered: true,
    samePageNavigationWrites: true
  });
  const result = await executeWorkflowAction({
    driver,
    action: {
      type: 'createChannel', expect: 'success', revisionDelta: 1, maxMs: 500,
      params: { device: 'DEV', name: 'C04-reenter-devices' }
    },
    context: conservativeContext('devices')
  });

  assert.equal(result.outcome, 'success');
  assert.ok(driver.calls.some(call => call[0] === 'click' && call[1] === '.nav[data-page="devices"]'));
  assert.ok(driver.calls.some(call => call[0] === 'click'
    && call[1] === '[data-bounded-action="add-channel"][data-device="DEV"]'));
});

test('createDevice 仅在 deviceEditor 内填写重复字段并保存', async () => {
  const driver = fakeDriver({
    initialPage: 'devices', pageLevelDeviceFieldsAmbiguous: true
  });
  const result = await executeWorkflowAction({
    driver,
    action: {
      type: 'createDevice', expect: 'success', revisionDelta: 1, maxMs: 500,
      params: {
        name: 'C04 scoped device', manufacturer: 'WF', temperature: '常温', note: 'scoped editor'
      }
    },
    context: conservativeContext('devices')
  });

  assert.equal(result.outcome, 'success');
  assert.deepEqual(
    driver.calls.filter(call => call[0] === 'nested-label').map(call => call[1]),
    ['设备名称 *', '设备厂家', '温度范围', '备注']
  );
  assert.ok(driver.calls.some(call => call[0] === 'nested-role'
    && call[1] === 'button' && call[2]?.name === '保存设备'));
});

test('createTester 只在 testerEditor 内定位人员字段', async () => {
  const driver = fakeDriver({ initialPage: 'testers' });
  const result = await executeWorkflowAction({
    driver,
    action: {
      type: 'createTester',
      maxMs: 500,
      params: { name: '作用域测试员', dept: '测试部', phone: '00000000', note: '独立备注' }
    },
    context: conservativeContext('testers')
  });

  assert.equal(result.outcome, 'success');
  assert.ok(driver.calls.some(call => call[0] === 'locator' && call[1] === '#testerEditor'));
  assert.deepEqual(
    driver.calls.filter(call => call[0] === 'nested-label').map(call => call[1]),
    ['姓名 *', '部门', '联系方式', '备注']
  );
  assert.equal(driver.calls.some(call => call[0] === 'label' && call[1] === '备注'), false);
});

test('startImmediately 等待重新挂载的预约详情后才在其中填写字段', async () => {
  const driver = fakeDriver({
    initialPage: 'apply',
    reservationFieldsRequireDetailsScope: true,
    reservationDetailsMountAfterRequestSelection: true
  });
  const result = await executeWorkflowAction({
    driver,
    action: {
      type: 'startImmediately', expect: 'success', revisionDelta: 1, maxMs: 500,
      params: {
        requestNo: 'REQ-001', sampleIds: ['REQ-001.001'], channelKeys: ['DEV|3'],
        start: '2026-08-28T08:00:00.000Z', end: '2026-08-28T09:00:00.000Z', note: '页内预约说明'
      }
    },
    context: conservativeContext('apply')
  });

  assert.equal(result.outcome, 'success');
  assert.ok(driver.calls.some(call => call[0] === 'locator' && call[1] === '[data-testid="legacy-reservation-details"][data-request-no="REQ-001"]'));
  assert.ok(driver.calls.some(call => call[0] === 'wait-for' && String(call[1]).includes('[data-testid="legacy-reservation-details"]') && call[2]?.state === 'visible'));
  assert.deepEqual(
    driver.calls.filter(call => call[0] === 'nested-label').map(call => call[1]),
    ['开始时间', '预计结束时间（可选）', '备注']
  );
  assert.equal(driver.calls.some(call => call[0] === 'label' && ['开始时间', '预约开始时间', '预计结束时间（可选）', '备注'].includes(call[1])), false);
});

test('startImmediately 只接受与目标申请号一致的重新挂载详情', async () => {
  const driver = fakeDriver({ initialPage: 'apply', reservationDetailsRequireRequestIdentity: true });
  const result = await executeWorkflowAction({
    driver,
    action: {
      type: 'startImmediately', expect: 'success', revisionDelta: 1, maxMs: 500,
      params: { requestNo: 'REQ-001', sampleIds: ['REQ-001.001'], channelKeys: ['DEV|3'], note: 'identity readiness' }
    },
    context: conservativeContext('apply')
  });

  assert.equal(result.outcome, 'success');
  assert.ok(driver.calls.some(call => call[0] === 'locator' && call[1] === '[data-testid="legacy-reservation-details"][data-request-no="REQ-001"]'));
  assert.ok(driver.calls.some(call => call[0] === 'wait-for' && call[1] === '[data-testid="legacy-reservation-details"][data-request-no="REQ-001"]' && call[2]?.state === 'visible'));
});

test('startImmediately 等待同申请详情 generation 变化后才填写新节点', async () => {
  const driver = fakeDriver({ initialPage: 'apply', reservationDetailsGenerationReplacement: true });
  const result = await executeWorkflowAction({
    driver,
    action: { type: 'startImmediately', expect: 'success', revisionDelta: 1, maxMs: 500, params: { requestNo: 'REQ-001', sampleIds: ['REQ-001.001'], channelKeys: ['DEV|3'], note: 'generation readiness' } },
    context: conservativeContext('apply')
  });
  assert.equal(result.outcome, 'success');
  assert.equal(driver.calls.filter(call => call[0] === 'check' && call[1] === '立即开始').length, 1);
  assert.ok(driver.calls.some(call => call[0] === 'wait-for-function' && call[1]?.previousGeneration === '1'));
});

test('startImmediately 目标模式已选中时复用当前详情而不等待重绘', async () => {
  const driver = fakeDriver({
    initialPage: 'apply',
    reservationDetailsGenerationReplacement: true,
    reservationModeAlreadyChecked: true
  });
  const result = await executeWorkflowAction({
    driver,
    action: { type: 'startImmediately', expect: 'success', revisionDelta: 1, maxMs: 500, params: { requestNo: 'REQ-001', sampleIds: ['REQ-001.001'], channelKeys: ['DEV|3'], note: 'already selected' } },
    context: conservativeContext('apply')
  });

  assert.equal(result.outcome, 'success');
  assert.equal(driver.calls.filter(call => call[0] === 'check' && call[1] === '立即开始').length, 0);
  assert.equal(driver.calls.filter(call => call[0] === 'wait-for-function').length, 0);
  assert.ok(driver.calls.filter(call => call[0] === 'nested-label').some(call => call[1] === '备注'));
});

test('startImmediately 搜索后清空筛选重绘时等待同申请详情稳定', async () => {
  const driver = fakeDriver({
    initialPage: 'apply',
    requestVisibleAfterSearch: true,
    reservationDetailsReplacementAfterSearchClear: true,
    reservationModeAlreadyChecked: true
  });
  const result = await executeWorkflowAction({
    driver,
    action: { type: 'startImmediately', expect: 'success', revisionDelta: 1, maxMs: 500, params: { requestNo: 'REQ-001', sampleIds: ['REQ-001.001'], channelKeys: ['DEV|3'], note: 'search-clear rerender' } },
    context: conservativeContext('apply')
  });

  assert.equal(result.outcome, 'success');
  assert.equal(driver.calls.filter(call => call[0] === 'check' && call[1] === '立即开始').length, 0);
  assert.ok(driver.calls.some(call => call[0] === 'wait-for-function' && call[1]?.previousGeneration === '1'));
  assert.ok(driver.calls.filter(call => call[0] === 'nested-label').some(call => call[1] === '备注'));
});

test('startImmediately 在详情 generation 缺失时 fail-close', async () => {
  await assert.rejects(
    executeWorkflowAction({
      driver: fakeDriver({ initialPage: 'apply', reservationDetailsGenerationReplacement: true, reservationDetailsGenerationMissing: true }),
      action: { type: 'startImmediately', expect: 'success', revisionDelta: 1, maxMs: 500, params: { requestNo: 'REQ-001', sampleIds: ['REQ-001.001'], channelKeys: ['DEV|3'] }, },
      context: conservativeContext('apply')
    }),
    /startImmediately.*generation/i
  );
});

test('manageRunning 只在 channelEditor 内填写真实管理字段并规范化时间', async () => {
  const driver = fakeDriver({ initialPage: 'devices' });
  const result = await executeWorkflowAction({
    driver,
    action: {
      type: 'manageRunning',
      maxMs: 500,
      params: {
        sampleId: 'REQ-RUN.001',
        channelKey: 'DEV|2',
        end: '2026-08-27T12:00:00.000Z',
        condition: 'D01 运行说明'
      }
    },
    context: conservativeContext('devices')
  });

  assert.equal(result.outcome, 'success');
  assert.ok(driver.calls.some(call => call[0] === 'locator' && call[1] === '#channelEditor'));
  assert.deepEqual(
    driver.calls.filter(call => call[0] === 'nested-label').map(call => call[1]),
    ['预计结束时间（可选）', '特殊状况说明']
  );
  assert.ok(driver.calls.some(call => call[0] === 'fill' && call[1] === '2026-08-27T12:00'));
  assert.ok(driver.calls.some(call => call[0] === 'fill' && call[1] === 'D01 运行说明'));
});

test('manageRunning 在日志第 2 页的运行记录先按样品编号精确搜索再打开管理', async () => {
  const context = conservativeContext('dashboard');
  const running = context.snapshot.state.records.find(record => record.id === 'REC-RUN');
  const earlier = Array.from({ length: 50 }, (_, index) => ({
    id: `REC-OLDER-${index + 1}`,
    sampleId: `REQ-OLDER-${String(index + 1).padStart(3, '0')}.001`,
    status: 'completed',
    channelKey: 'DEV|3'
  }));
  context.snapshot.state.records = [...earlier, ...context.snapshot.state.records.filter(record => record.id !== running.id), running];
  assert.equal(context.snapshot.state.records.findIndex(record => record.id === running.id) >= 50, true);
  const driver = fakeDriver({ initialPage: 'dashboard', manageRunningVisibleAfterRecordSearch: true });

  const result = await executeWorkflowAction({
    driver,
    action: { type: 'manageRunning', expect: 'success', revisionDelta: 1, maxMs: 500, params: { sampleId: running.sampleId, channelKey: running.channelKey } },
    context
  });

  assert.equal(result.outcome, 'success');
  const search = driver.calls.findIndex(call => call[0] === 'label' && call[1] === '搜索申请、样品、项目、通道或人员');
  const fill = driver.calls.findIndex(call => call[0] === 'fill' && call[1] === running.sampleId);
  const open = driver.calls.findIndex(call => call[0] === 'click' && String(call[1]).includes('[data-bounded-action="manage-running"]'));
  assert.ok(search >= 0, 'must resolve the records search field');
  assert.ok(fill > search, 'must fill the exact running sample ID');
  assert.ok(open > fill, 'must reveal the page-two record before clicking management');
});

test('manageRunning 在状态写入后仍停留日志页时重新进入日志页以重建被清空的记录表', async () => {
  const driver = fakeDriver({ initialPage: 'records', manageRunningVisibleAfterRecordSearch: true });
  const result = await executeWorkflowAction({
    driver,
    action: {
      type: 'manageRunning', expect: 'success', revisionDelta: 1, maxMs: 500,
      params: { sampleId: 'REQ-RUN.001', channelKey: 'DEV|2' }
    },
    context: conservativeContext('records')
  });

  assert.equal(result.outcome, 'success');
  assert.equal(
    driver.calls.filter(call => call[0] === 'click' && call[1] === '.nav[data-page="records"]').length,
    1,
    'a current records page is not proof that its bounded table survived the preceding write'
  );
});

test('cancelTodo 在目标预约不在当前待办页时翻页后使用精确详情入口', async () => {
  const driver = fakeDriver({ initialPage: 'apply', todoDetailVisibleAfterPage: 2, dialogCount: 1, dialogOnlyOnCancel: true });
  const result = await executeWorkflowAction({
    driver,
    action: {
      type: 'cancelTodo', expect: 'cancelled', revisionDelta: 0, maxMs: 500,
      params: { sampleId: 'REQ-RES.001', confirm: false }
    },
    context: conservativeContext('apply')
  });

  assert.equal(result.outcome, 'cancelled');
  assert.ok(
    driver.calls.some(call => call[0] === 'click' && call[1] === '[data-dashboard-action="todo-next"]'),
    'must page the real dashboard todo list before resolving the exact detail control'
  );
  assert.ok(driver.calls.some(call => call[0] === 'click' && call[1] === '[data-dashboard-action="todo-detail"][data-record-index="1"]'));
});

test('cancelTodo 在目标预约位于当前待办页之前时先回到首页再使用精确详情入口', async () => {
  const driver = fakeDriver({
    initialPage: 'apply', initialTodoPage: 2, todoDetailVisibleOnPages: [1],
    dialogCount: 1, dialogOnlyOnCancel: true
  });
  const result = await executeWorkflowAction({
    driver,
    action: {
      type: 'cancelTodo', expect: 'cancelled', revisionDelta: 0, maxMs: 500,
      params: { sampleId: 'REQ-RES.001', confirm: false }
    },
    context: conservativeContext('apply')
  });

  assert.equal(result.outcome, 'cancelled');
  assert.ok(
    driver.calls.some(call => call[0] === 'click' && call[1] === '[data-dashboard-action="todo-previous"]'),
    'must reset the live dashboard todo view through its previous-page control'
  );
  assert.ok(driver.calls.some(call => call[0] === 'click' && call[1] === '[data-dashboard-action="todo-detail"][data-record-index="1"]'));
});

test('manageRunning 用活动记录实际开始时间和正整数分钟偏移派生结束时间', async () => {
  const driver = fakeDriver({ initialPage: 'devices' });
  const context = conservativeContext('devices');
  Object.assign(context.snapshot.state.records.find(item => item.id === 'REC-RUN'), {
    actualStart: '2026-08-27T10:15',
    start: '2026-08-27T08:00',
    time: '2026-08-27T07:00'
  });
  const params = { sampleId: 'REQ-RUN.001', channelKey: 'DEV|2', endOffsetMinutes: 60 };

  const result = await executeWorkflowAction({
    driver,
    action: { type: 'manageRunning', maxMs: 500, params },
    context
  });

  assert.equal(result.outcome, 'success');
  assert.equal(Object.hasOwn(params, 'end'), false);
  assert.ok(driver.calls.some(call => call[0] === 'fill' && call[1] === '2026-08-27T11:15'));
});

test('manageRunning 拒绝非正安全整数的结束时间分钟偏移', async () => {
  for (const endOffsetMinutes of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    await assert.rejects(
      executeWorkflowAction({
        driver: fakeDriver({ initialPage: 'devices' }),
        action: {
          type: 'manageRunning',
          maxMs: 500,
          params: { sampleId: 'REQ-RUN.001', channelKey: 'DEV|2', endOffsetMinutes }
        },
        context: conservativeContext('devices')
      }),
      /manageRunning.*validate.*endOffsetMinutes.*positive safe integer/i
    );
  }
});

test('finishRunning 从 dashboard 进入 records 后使用精确 active record selector', async () => {
  const driver = fakeDriver({ outcome: '', recordTransitionVisibleAfterRecordSearch: true });
  const result = await executeWorkflowAction({
    driver,
    action: { type: 'finishRunning', params: { sampleId: 'REQ-RUN.001' } },
    context: conservativeContext('dashboard')
  });
  assert.equal(result.outcome, 'success');
  assert.ok(driver.calls.some(call => call[0] === 'locator' && call[1] === '.nav[data-page="records"]'));
  assert.ok(driver.calls.some(call => call[0] === 'fill' && call[1] === 'REQ-RUN.001'));
  assert.equal(driver.calls.some(call => call[0] === 'click' && String(call[1]).includes('[data-bounded-action="manage-running"]')), false);
  assert.ok(driver.calls.some(call => call[0] === 'locator' && call[1] === '[data-bounded-action="record-transition"][data-transition="end"][data-record-index="2"]'));
});

test('finishRunning 在投影仍为日志页但记录表已清空时重新进入日志页', async () => {
  const driver = fakeDriver({
    initialPage: 'records',
    recordTransitionVisibleAfterRecordSearch: true,
    recordTransitionRequiresRecordsReentry: true
  });
  const result = await executeWorkflowAction({
    driver,
    action: { type: 'finishRunning', expect: 'success', revisionDelta: 1, maxMs: 500, params: { sampleId: 'REQ-RUN.001' } },
    context: conservativeContext('records')
  });

  assert.equal(result.outcome, 'success');
  assert.equal(
    driver.calls.filter(call => call[0] === 'click' && call[1] === '.nav[data-page="records"]').length,
    1,
    'a current records projection is not proof that its bounded table survived the preceding write'
  );
});

test('M11 状态已完成或取消后仍按 type+sampleId 找到旧 handle 并拒绝 detached', async () => {
  const detached = {
    async evaluate() { return false; },
    async click() { throw new Error('detached'); }
  };
  const cases = [
    { type: 'manageRunning', params: { sampleId: 'REQ-RUN.001', old: true } },
    { type: 'startTodo', params: { sampleId: 'REQ-RES.001', old: true } },
    { type: 'cancelTodo', params: { sampleId: 'REQ-RES.001', old: true } }
  ];
  for (const action of cases) {
    const page = action.type === 'manageRunning' ? 'records' : 'dashboard';
    const context = conservativeContext(page);
    const sample = context.snapshot.state.samples.find(item => item.id === action.params.sampleId);
    const record = context.snapshot.state.records.find(item => item.sampleId === action.params.sampleId && ['running', 'reserved'].includes(item.status));
    const channel = context.snapshot.state.channels.find(item => item.key === record.channelKey);
    sample.status = action.type === 'cancelTodo' ? 'cancelled' : 'completed';
    record.status = sample.status;
    channel.currentRecordId = '';
    channel.nextRecordId = '';
    context.runtime.retainedDom = new Map([[`${action.type}:${action.params.sampleId}`, detached]]);
    assert.equal(await ACTION_LIBRARY[action.type].available(context.snapshot, context.ui, action.params, context), true, action.type);
    assert.equal(await ACTION_LIBRARY[action.type].available(context.snapshot, context.ui, { ...action.params, sampleId: 'OTHER.001' }, context), false, `${action.type} identity mismatch`);
    const driver = fakeDriver({ initialPage: page });
    const result = await executeWorkflowAction({
      driver,
      action: { ...action, revisionDelta: 0 },
      context: Object.freeze(context)
    });
    assert.equal(result.outcome, 'rejected', action.type);
    assert.match(result.message, /detached/, action.type);
    assert.equal(driver.stats().revision, 0, action.type);
  }
});

test('M11 仍连接但已隐藏的旧 handle 直接拒绝，不等待或触发点击', async () => {
  let clicks = 0;
  const hidden = {
    async evaluate() { return true; },
    async isVisible() { return false; },
    async click() { clicks += 1; throw new Error('hidden handle must not be clicked'); }
  };
  const context = conservativeContext('dashboard');
  context.runtime.retainedDom = new Map([['startTodo:REQ-RES.001', hidden]]);
  const result = await executeWorkflowAction({
    driver: fakeDriver({ initialPage: 'dashboard' }),
    action: { type: 'startTodo', params: { sampleId: 'REQ-RES.001', old: true }, revisionDelta: 0 },
    context
  });
  assert.equal(result.outcome, 'rejected');
  assert.match(result.message, /hidden|不可见/);
  assert.equal(clicks, 0);
});

test('retainOldDom 用 sample-bound data selector 捕获多个同名按钮且 handle 不串样品', async () => {
  const driver = fakeDriver();
  const runtime = {};
  const context = { ...conservativeContext('dashboard'), runtime };
  context.snapshot.state.samples.push({ id: 'REQ-RES-2.001', status: 'reserved', channelKey: 'DEV|3' });
  context.snapshot.state.records.push({ id: 'REC-RES-2', sampleId: 'REQ-RES-2.001', status: 'reserved', channelKey: 'DEV|3' });
  context.snapshot.state.channels.find(item => item.key === 'DEV|3').nextRecordId = 'REC-RES-2';
  const targets = [
    { type: 'manageRunning', sampleId: 'REQ-RUN.001', channelKey: 'DEV|2' },
    { type: 'startTodo', sampleId: 'REQ-RES.001' },
    { type: 'startTodo', sampleId: 'REQ-RES-2.001' },
    { type: 'cancelTodo', sampleId: 'REQ-RES.001' }
  ];
  await executeWorkflowAction({ driver, action: { type: 'retainOldDom', params: { targets } }, context });
  assert.deepEqual([...runtime.retainedDom.keys()].sort(), targets.map(item => `${item.type}:${item.sampleId}`).sort());
  assert.notEqual(runtime.retainedDom.get('startTodo:REQ-RES.001'), runtime.retainedDom.get('startTodo:REQ-RES-2.001'));
  assert.ok(driver.calls.some(call => call[0] === 'locator' && call[1] === '[data-bounded-action="manage-running"][data-sample-id="REQ-RUN.001"][data-channel-key="DEV%7C2"]'));
  assert.ok(driver.calls.some(call => call[0] === 'locator' && call[1] === '[data-res-start="1"]'));
  assert.ok(driver.calls.some(call => call[0] === 'locator' && call[1] === '[data-res-start="3"]'));
  assert.ok(driver.calls.some(call => call[0] === 'locator' && call[1] === '[data-res-cancel="1"]'));
});

test('六个控制动作只修改 runtime，支持冻结顶层 context', async () => {
  const driver = fakeDriver();
  const second = fakeDriver();
  const runtime = {};
  const context = Object.freeze({ runtime, createDriver: async () => second, snapshot: conservativeContext().snapshot, ui: conservativeContext().ui });
  await executeWorkflowAction({ driver, action: { type: 'editDraft', params: { label: '备注', value: '草稿' } }, context });
  await executeWorkflowAction({ driver, action: { type: 'retainOldDom', params: { targets: [{ type: 'startTodo', sampleId: 'REQ-RES.001' }] } }, context });
  await executeWorkflowAction({ driver, action: { type: 'reloadCurrent', params: {}, revisionDelta: 0 }, context });
  await executeWorkflowAction({ driver, action: { type: 'openSecondSession', params: {} }, context });
  await executeWorkflowAction({ driver, action: { type: 'closeSecondSession', params: {} }, context });
  assert.equal(runtime.draft.value, '草稿');
  assert.ok(runtime.retainedDom instanceof Map);
  assert.equal(runtime.secondDriver, null);
});

test('export/backup/restore definition 允许 cancel→0 与 success→1', () => {
  for (const type of ['exportLog', 'exportRequest', 'backup', 'restore']) assert.deepEqual(ACTION_LIBRARY[type].revisionDelta, [0, 1], type);
});

test('文件动作的虚假 outcome 不得隐藏完整审计增量', async () => {
  for (const scenario of [
    { outcome: 'success', blockWrites: true, params: { path: 'backup.batterydata' }, expected: /backup.*audit-delta.*missing=手动备份数据#1/i },
    { outcome: 'cancelled', blockWrites: false, params: { cancel: true }, expected: /backup.*audit-delta.*extra=AUDIT-FAKE-1-/i }
  ]) {
    const driver = fakeDriver({ outcome: '', blockWrites: scenario.blockWrites });
    await assert.rejects(
      executeWorkflowAction({
        driver,
        action: { type: 'backup', params: scenario.params },
        context: { ...conservativeContext('dashboard'), outcomeReader: async () => scenario.outcome }
      }),
      scenario.expected
    );
  }
});

async function realActionContext() {
  const value = actionRunSequence++;
  return createWorkflowRunContext({
    projectRoot,
    mode: 'quick',
    now: () => new Date('2026-08-22T08:00:00.000Z'),
    randomBytes: () => Buffer.from([(process.pid >>> 16) & 0xff, (process.pid >>> 8) & 0xff, process.pid & 0xff, value])
  });
}

async function waitForSnapshot(dataRoot, predicate, timeoutMs = 8_000) {
  const deadline = Date.now() + timeoutMs;
  let snapshot;
  do {
    snapshot = readWorkflowSnapshot({ dataRoot });
    if (predicate(snapshot)) return snapshot;
    await new Promise(resolve => setTimeout(resolve, 50));
  } while (Date.now() < deadline);
  throw new Error(`snapshot condition timed out at revision ${snapshot?.summary?.revision}`);
}

async function loginWorkflowDriver(driver, username) {
  const page = driver.page();
  await page.locator('#username').fill(username);
  await page.locator('#login .btn.wide').click();
  await page.waitForFunction(() => window.__batteryAppReady === true);
  if (typeof driver.waitForPersistenceBarrier !== 'function') throw new Error('login persistence barrier capability is required');
  return driver.waitForPersistenceBarrier({ auditAction: '登录看板', actor: username, timeoutMs: 5_000 });
}

async function runM05StaleReservationProbe(t) {
  const productionRun = await realActionContext();
  await seedWorkflowFixture({ dataRoot: productionRun.dataRoot, kind: 'production-529', clock: () => new Date('2026-08-22T08:00:00.000Z') });
  const mainDriver = createWorkflowElectronDriver({ projectRoot, dataRoot: productionRun.dataRoot, profileRoot: path.join(productionRun.profileRoot, 'round4-main'), viewport: '1366x768', timeoutMs: 25_000 });
  const secondDriver = createWorkflowElectronDriver({ projectRoot, dataRoot: productionRun.dataRoot, profileRoot: path.join(productionRun.profileRoot, 'round4-second'), viewport: '1366x768', timeoutMs: 25_000 });
  t.after(async () => {
    await Promise.allSettled([mainDriver.close(), secondDriver.close()]);
    await rm(productionRun.runRoot, { recursive: true, force: true });
  });

  await mainDriver.start();
  const mainLoginEvidence = await loginWorkflowDriver(mainDriver, 'round4-main');
  assert.equal(mainLoginEvidence.audit.action, '登录看板');
  assert.equal(mainLoginEvidence.audit.user, 'round4-main');
  assert.ok(String(mainLoginEvidence.audit.id || '').length > 0);
  let snapshot = readWorkflowSnapshot({ dataRoot: productionRun.dataRoot });
  assert.equal(snapshot.summary.revision, mainLoginEvidence.revision);
  assert.ok(snapshot.state.auditLogs.some(item => item.id === mainLoginEvidence.audit.id && item.user === 'round4-main'));
  let ui = await mainDriver.uiProjection();
  const pending = snapshot.state.samples.filter(item => item.status === 'pending').slice(0, 2);
  const freeChannels = snapshot.state.channels
    .filter(item => item.state === 'free')
    .sort((left, right) => String(left.device ?? left.deviceName ?? '').localeCompare(String(right.device ?? right.deviceName ?? ''), 'zh-CN')
      || String(left.name ?? '').localeCompare(String(right.name ?? ''), 'zh-CN', { numeric: true }))
    .slice(0, 2);
  assert.equal(pending.length, 2);
  assert.equal(freeChannels.length, 2);
  const runtime = {};
  const preparedParams = {
    operation: 'reserve', requestNo: pending[0].requestNo || pending[0].id.split('.')[0],
    sampleIds: [pending[0].id], channelKeys: [freeChannels[0].key],
    start: '2026-08-22T09:00', end: '2026-08-22T10:00', username: 'round4-second'
  };
  const beforeOpen = structuredClone(snapshot.state);
  const openContext = { snapshot, ui, runtime, createDriver: async () => secondDriver };
  await executeWorkflowAction({ driver: mainDriver, action: { type: 'openSecondSession', params: { prepareStale: preparedParams }, revisionDelta: 3 }, context: openContext });
  assert.ok(runtime.staleDrafts instanceof Map);
  const staleDraft = runtime.staleDrafts.get('B:reserve');
  const cachedLocator = staleDraft.locator;
  assert.equal(staleDraft.loginEvidence.audit.action, '登录看板');
  assert.equal(staleDraft.loginEvidence.audit.user, 'round4-second');
  assert.ok(String(staleDraft.loginEvidence.audit.id || '').length > 0);
  const afterOpen = readWorkflowSnapshot({ dataRoot: productionRun.dataRoot }).state;
  assert.equal(afterOpen.revision - beforeOpen.revision, 3);
  assert.equal(afterOpen.auditLogs.length - beforeOpen.auditLogs.length, 2);
  assert.deepEqual(afterOpen.auditLogs.slice(0, 2).map(item => item.action).sort(), ['查看页面', '登录看板'].sort());
  for (const key of ['requests', 'samples', 'channels', 'deviceProfiles', 'records', 'requestSourceRows', 'testers']) {
    assert.deepEqual(afterOpen[key], beforeOpen[key], `prepareStale must not mutate ${key}`);
  }
  const staleUi = await secondDriver.uiProjection();

  const freshUi = await mainDriver.uiProjection();
  const freshSnapshot = readWorkflowSnapshot({ dataRoot: productionRun.dataRoot });
  const reserveParams = {
    requestNo: pending[1].requestNo || pending[1].id.split('.')[0],
    sampleIds: [pending[1].id],
    channelKeys: [freeChannels[1].key],
    start: '2026-08-22T09:00',
    end: '2026-08-22T10:00',
    actor: 'round4-main'
  };
  const reserveResult = await executeWorkflowAction({
    driver: mainDriver,
    action: { type: 'reserve', params: reserveParams },
    context: { snapshot: freshSnapshot, ui: freshUi, runtime: {} }
  });
  assert.equal(reserveResult.outcome, 'success');
  const beforeStale = readWorkflowSnapshot({ dataRoot: productionRun.dataRoot });
  assert.equal(reserveResult.settlement.persistedRevision, beforeStale.state.revision);
  const runtimeLocator = runtime.staleDrafts.get('B:reserve')?.locator;
  assert.equal(runtimeLocator, cachedLocator);
  const staleResult = await executeWorkflowAction({
    driver: mainDriver,
    action: { type: 'staleSubmit', params: { session: 'B', ...preparedParams }, expect: 'rejected', maxMs: 8_000 },
    context: { snapshot: beforeStale, ui: staleUi, runtime }
  });
  assert.equal(staleResult.outcome, 'rejected');
  assert.match(staleResult.message, /REVISION_CONFLICT|更新|变化|冲突|重新加载/i);
  const afterStale = readWorkflowSnapshot({ dataRoot: productionRun.dataRoot });
  assert.equal(afterStale.state.revision, beforeStale.state.revision);
  const immutableCollections = ['requests', 'samples', 'channels', 'deviceProfiles', 'records', 'requestSourceRows', 'testers', 'auditLogs', 'formChangeJournal'];
  for (const key of immutableCollections) {
    assert.deepEqual(afterStale.state[key], beforeStale.state[key], `stale rejection must not partially mutate ${key}`);
  }

  return Object.freeze({
    reserve: reserveResult,
    beforeStale,
    stale: staleResult,
    afterStale,
    reserveParams: Object.freeze(structuredClone(reserveParams)),
    collectionDeltas: Object.freeze(Object.fromEntries(immutableCollections.map(key => [key, afterStale.state[key].length - beforeStale.state[key].length]))),
    cachedLocator,
    runtimeLocator
  });
}

test('M05 双会话陈旧预约被拒绝且无部分写入', { timeout: 40_000 }, async t => {
  const evidence = await runM05StaleReservationProbe(t);
  assert.equal(evidence.reserve.outcome, 'success');
  assert.equal(evidence.reserve.settlement.persistedRevision, evidence.beforeStale.state.revision);
  assert.equal(evidence.reserve.settlement.finalPage, 'apply');
  assert.equal(evidence.reserve.settlement.auditEvidence.length, 1);
  const audit = evidence.reserve.settlement.auditEvidence[0];
  assert.equal(audit.action, '提交预约');
  assert.equal(audit.user ?? audit.actor, 'round4-main');
  assert.equal(audit.target, `申请单 ${evidence.reserveParams.requestNo} / 子样品 ${evidence.reserveParams.sampleIds[0]} / 通道 ${evidence.reserveParams.channelKeys[0]}`);
  assert.ok(String(audit.id || '').length > 0);
  const terminalState = evidence.reserve.settlement.state;
  const terminalSample = terminalState.samples.find(item => item.id === evidence.reserveParams.sampleIds[0]);
  const terminalRecords = terminalState.records.filter(item => item.sampleId === evidence.reserveParams.sampleIds[0]
    && item.channelKey === evidence.reserveParams.channelKeys[0] && item.status === 'reserved');
  const terminalChannel = terminalState.channels.find(item => item.key === evidence.reserveParams.channelKeys[0]);
  assert.equal(terminalSample.status, 'reserved');
  assert.equal(terminalRecords.length, 1);
  assert.equal(terminalChannel.nextRecordId, terminalRecords[0].id);
  assert.equal(evidence.cachedLocator, evidence.runtimeLocator);
  assert.equal(evidence.stale.outcome, 'rejected');
  assert.equal(evidence.stale.settlement.persistedRevision, evidence.beforeStale.state.revision);
  assert.equal(evidence.afterStale.state.revision - evidence.beforeStale.state.revision, 0);
  assert.deepEqual(evidence.collectionDeltas, {
    requests: 0, samples: 0, channels: 0, deviceProfiles: 0, records: 0,
    requestSourceRows: 0, testers: 0, auditLogs: 0, formChangeJournal: 0
  });
});

test('真实 Electron zero-valid 文件夹导入显示新鲜失败证据且零审计零持久化', { timeout: 40_000 }, async t => {
  const run = await realActionContext();
  const invalidDirectory = path.join(run.runRoot, 'zero-valid-import');
  await mkdir(invalidDirectory, { recursive: true });
  await copyFile(
    path.join(projectRoot, 'tmp-clean-sim', 'parser-fixtures', 'bad.xlsx'),
    path.join(invalidDirectory, 'bad.xlsx')
  );
  await seedWorkflowFixture({ dataRoot: run.dataRoot, kind: 'production-529', clock: () => new Date('2026-08-22T08:00:00.000Z') });
  const driver = createWorkflowElectronDriver({
    projectRoot,
    dataRoot: run.dataRoot,
    profileRoot: path.join(run.profileRoot, 'round5-zero-valid'),
    viewport: '1366x768',
    timeoutMs: 25_000
  });
  t.after(async () => {
    await driver.close().catch(() => undefined);
    await rm(run.runRoot, { recursive: true, force: true });
  });

  await driver.start();
  await loginWorkflowDriver(driver, 'round5-zero-valid');
  const page = driver.page();
  await page.locator('.nav[data-page="requests"]').click();
  const before = await driver.capturePersistenceBoundary({ timeoutMs: 5_000 });
  const beforeSnapshot = readWorkflowSnapshot({ dataRoot: run.dataRoot });
  assert.equal(before.revision, beforeSnapshot.state.revision);

  const toast = page.locator('.toast');
  const beforeMessage = String(await toast.textContent().catch(() => '') || '').trim();
  const beforeVisible = await toast.isVisible().catch(() => false);
  await driver.configureDialogs({ openFiles: [], openDirectories: [[invalidDirectory]], saveFiles: [] });
  await page.getByRole('button', { name: /导入文件夹/ }).click();
  const freshToast = page.locator('.toast.show');
  await freshToast.waitFor({ state: 'visible', timeout: 5_000 });
  const message = String(await freshToast.textContent() || '').trim();
  assert.match(message, /没有有效申请单|未识别到有效申请单/);
  assert.ok(!beforeVisible || beforeMessage !== message, `zero-valid message must be fresh; before=${beforeMessage}; after=${message}`);

  const after = await driver.capturePersistenceBoundary({ timeoutMs: 5_000 });
  assert.equal(after.revision - before.revision, 0);
  for (const key of [
    'requests', 'samples', 'channels', 'deviceProfiles', 'records',
    'requestSourceRows', 'testers', 'auditLogs', 'formChangeJournal'
  ]) {
    assert.deepEqual(after.state[key], before.state[key], `zero-valid import must not mutate ${key}`);
  }
  assert.equal(after.state.auditLogs.some(item => item.action === '导入申请单'), before.state.auditLogs.some(item => item.action === '导入申请单'));
});

test('真实 Electron 双击仅迁移一次且无新消息的导入取消拒绝假证据', { timeout: 40_000 }, async t => {
  const run = await realActionContext();
  await seedWorkflowFixture({ dataRoot: run.dataRoot, kind: 'queue', clock: () => new Date('2026-08-22T08:00:00.000Z') });
  const driver = createWorkflowElectronDriver({
    projectRoot,
    dataRoot: run.dataRoot,
    profileRoot: path.join(run.profileRoot, 'actions-double'),
    viewport: '1366x768',
    timeoutMs: 25_000
  });
  t.after(async () => {
    await driver.close().catch(() => undefined);
    await rm(run.runRoot, { recursive: true, force: true });
  });

  await driver.start();
  const page = driver.page();
  await page.locator('#username').fill('workflow-actions');
  await page.locator('#login .btn.wide').click();
  await page.waitForFunction(() => window.__batteryAppReady === true);

  let snapshot = readWorkflowSnapshot({ dataRoot: run.dataRoot });
  const running = snapshot.state.records.find(record => record.status === 'running');
  const reserved = snapshot.state.records.find(record => record.status === 'reserved');
  assert.ok(running && reserved);
  const runningIndex = snapshot.state.records.findIndex(record => record.id === running.id);

  await page.locator('.nav[data-page="records"]').click();
  await page.locator(`[data-bounded-action="record-transition"][data-transition="end"][data-record-index="${runningIndex}"]`).click();
  snapshot = await waitForSnapshot(run.dataRoot, value => value.state.records.find(record => record.id === running.id)?.status === 'completed');
  await page.locator('.nav[data-page="dashboard"]').click();
  const beforeDetailUi = await driver.uiProjection();
  const beforeDetail = readWorkflowSnapshot({ dataRoot: run.dataRoot });
  assert.equal(beforeDetail.summary.revision, beforeDetailUi.projection.summary.revision);
  const detail = page.locator(`[data-dashboard-action="todo-detail"][data-record-index="${snapshot.state.records.findIndex(record => record.id === reserved.id)}"]`);
  await detail.click();
  const beforeUi = await driver.uiProjection();
  const before = readWorkflowSnapshot({ dataRoot: run.dataRoot });
  assert.equal(beforeUi.projection.currentPage, 'reserved');
  assert.equal(before.summary.revision, beforeUi.projection.summary.revision);
  const result = await executeWorkflowAction({
    driver,
    action: { type: 'startTodo', params: { sampleId: reserved.sampleId, double: true }, revisionDelta: 1, maxMs: 8_000 },
    context: Object.freeze({ snapshot: before, ui: beforeUi, runtime: {} })
  });
  const after = await waitForSnapshot(run.dataRoot, value => value.summary.revision >= before.summary.revision + 1);
  assert.ok(['success', 'rejected'].includes(result.outcome));
  assert.equal(before.summary.revision, beforeDetail.summary.revision + 1);
  assert.equal(after.summary.revision, before.summary.revision + 1);
  assert.equal(after.summary.revision, beforeDetail.summary.revision + 2);
  const addedAudits = after.state.auditLogs.slice(0, after.state.auditLogs.length - beforeDetail.state.auditLogs.length);
  assert.equal(addedAudits.filter(item => item.action === '查看页面' && item.target === '页面 reserved').length, 1);
  assert.equal(addedAudits.filter(item => item.action === '开始预约测试').length, 1);
  assert.equal(after.state.records.find(record => record.id === reserved.id)?.status, 'running');
  assert.equal(after.state.samples.find(sample => sample.id === reserved.sampleId)?.status, 'running');
  assert.equal(after.state.records.filter(record => record.sampleId === reserved.sampleId && ['running', 'reserved'].includes(record.status)).length, 1);
  const channel = after.state.channels.find(item => item.key === reserved.channelKey);
  assert.equal(channel.currentRecordId, reserved.id);
  assert.equal(channel.nextRecordId || null, null);

  await page.locator('.nav[data-page="requests"]').click();
  const beforeCancelUi = await driver.uiProjection();
  const beforeCancel = readWorkflowSnapshot({ dataRoot: run.dataRoot });
  assert.equal(beforeCancel.summary.revision, beforeCancelUi.projection.summary.revision);
  const cancelled = await executeWorkflowAction({
    driver,
    action: { type: 'importRequest', params: { cancel: true, kind: 'file' }, expect: 'cancelled', revisionDelta: 0, maxMs: 800 },
    context: Object.freeze({ snapshot: beforeCancel, ui: beforeCancelUi, runtime: {} })
  });
  assert.equal(cancelled.outcome, 'cancelled');
  const afterCancel = readWorkflowSnapshot({ dataRoot: run.dataRoot });
  assert.equal(afterCancel.summary.revision, beforeCancel.summary.revision);
});

test('M04 翻页动作按参数准备样品和通道子视图，已预约使用稳定导航入口', async () => {
  const reserved = fakeDriver();
  await executeWorkflowAction({
    driver: reserved,
    action: { type: 'navigate', params: { label: '已预约' } },
    context: conservativeContext('dashboard')
  });
  assert.ok(reserved.calls.some(call => call[0] === 'locator' && call[1] === '.nav[data-page="reserved"]'));

  const sample = fakeDriver({ initialPage: 'apply' });
  const sampleResult = await executeWorkflowAction({
    driver: sample,
    action: { type: 'nextPage', params: { view: 'sample', requestNo: 'REQ-001' } },
    context: conservativeContext('apply')
  });
  assert.equal(sampleResult.pageEvidence.view, 'sample');
  assert.equal(sampleResult.pageEvidence.before.page, 1);
  assert.equal(sampleResult.pageEvidence.after.page, 2);
  assert.notEqual(sampleResult.pageEvidence.before.first, sampleResult.pageEvidence.after.first);
  assert.equal(sampleResult.pageEvidence.after.domWithinLimit, true);
  assert.ok(sample.calls.some(call => call[0] === 'locator' && call[1] === '[data-legacy-action="select-request"][data-request-no="REQ-001"]'));
  assert.ok(sample.calls.some(call => call[0] === 'locator' && call[1] === '[data-legacy-action="sample-next"]'));

  const channel = fakeDriver({ initialPage: 'apply' });
  const channelResult = await executeWorkflowAction({
    driver: channel,
    action: { type: 'nextPage', params: { view: 'channel', sampleId: 'REQ-001.001' } },
    context: conservativeContext('apply')
  });
  assert.equal(channelResult.pageEvidence.view, 'channel');
  assert.equal(channelResult.pageEvidence.before.page, 1);
  assert.equal(channelResult.pageEvidence.after.page, 2);
  assert.equal(channelResult.pageEvidence.after.rowCount, 40);
  assert.ok(channel.calls.some(call => call[0] === 'locator' && call[1] === '[data-legacy-action="open-channel-picker"][data-sample-id="REQ-001.001"]'));
  assert.ok(channel.calls.some(call => call[0] === 'locator' && call[1] === '[data-legacy-action="channel-next"]'));
});

test('M04 指定申请不在当前页时先按申请号过滤再打开样品子视图', async () => {
  const sample = fakeDriver({ initialPage: 'apply', requestVisibleAfterSearch: true, reservationDetailsReplacementAfterSearchClear: true });
  const result = await executeWorkflowAction({
    driver: sample,
    action: { type: 'nextPage', params: { view: 'sample', requestNo: 'REQ-001' } },
    context: conservativeContext('apply')
  });
  assert.equal(result.outcome, 'success');
  assert.deepEqual(sample.calls.filter(call => call[0] === 'fill').map(call => call[1]), ['REQ-001', '']);
  assert.ok(sample.calls.some(call => call[0] === 'click' && call[1] === '[data-legacy-action="select-request"][data-request-no="REQ-001"]'));
});

test('M08 首个 selectSample 可真实打开申请，空搜索可清除 hostile 文本', async () => {
  const driver = fakeDriver({ initialPage: 'dashboard' });
  const context = conservativeContext('dashboard');
  await executeWorkflowAction({
    driver,
    action: { type: 'selectSample', params: { requestNo: 'REQ-001', sampleId: 'REQ-001.001' } },
    context
  });
  assert.ok(driver.calls.some(call => call[0] === 'click' && call[1] === '.nav[data-page="apply"]'));
  assert.ok(driver.calls.some(call => call[0] === 'locator' && call[1] === '[data-legacy-action="select-request"][data-request-no="REQ-001"]'));
  assert.ok(driver.calls.some(call => call[0] === 'locator' && call[1] === '[data-legacy-action="open-channel-picker"][data-sample-id="REQ-001.001"]'));

  const cleared = await executeWorkflowAction({
    driver,
    action: { type: 'search', params: { label: '搜索设备、通道或量程', value: '' } },
    context
  });
  assert.equal(cleared.outcome, 'success');
  assert.ok(driver.calls.some(call => call[0] === 'fill' && call[1] === ''));
});

test('selectChannel 在 529 通道且目标不在首屏时按精确通道 key 搜索 picker', async () => {
  const targetKey = '新威1#（16通道)|1-1';
  const driver = fakeDriver({ initialPage: 'apply' });
  const context = conservativeContext('apply');
  context.snapshot.state.channels = Array.from({ length: 529 }, (_, index) => ({
    key: index === 528 ? targetKey : `DEV|${index + 1}`,
    state: 'free'
  }));
  const page = driver.page();
  const originalLocator = page.locator.bind(page);
  const originalGetByLabel = page.getByLabel.bind(page);
  let channelSearch = '';
  page.getByLabel = (label, options) => {
    const locator = originalGetByLabel(label, options);
    if (label !== '搜索设备、通道或量程') return locator;
    return {
      ...locator,
      async fill(value) {
        channelSearch = String(value);
        return locator.fill(value);
      }
    };
  };
  page.locator = selector => {
    const locator = originalLocator(selector);
    if (!String(selector).includes(`[data-channel-key="${targetKey}"]`)) return locator;
    return {
      ...locator,
      async count() { return channelSearch === targetKey ? 1 : 0; },
      async click(options) {
        if (channelSearch !== targetKey) return new Promise(resolve => setTimeout(resolve, 40));
        return locator.click(options);
      }
    };
  };

  await executeWorkflowAction({
    driver,
    action: { type: 'selectSample', params: { sampleId: 'REQ-001.001' } },
    context
  });
  const result = await executeWorkflowAction({
    driver,
    action: { type: 'selectChannel', params: { channelKey: targetKey }, maxMs: 20 },
    context
  });

  assert.equal(result.outcome, 'success');
  assert.equal(channelSearch, targetKey);
  assert.ok(driver.calls.some(call => call[0] === 'locator'
    && call[1] === `[data-legacy-action="choose-channel"][data-channel-key="${targetKey}"]`));
});

test('search evidence 同时保留真实 LF 请求值和浏览器规范化后的 appliedValue', async () => {
  const requestedValue = `${'超长中文'.repeat(4)}\n\"'_*%`;
  const appliedValue = requestedValue.replace(/[\r\n]/g, ' ');
  const driver = fakeDriver({
    initialPage: 'records',
    inputSanitizer: value => String(value).replace(/[\r\n]/g, ' ')
  });

  const result = await executeWorkflowAction({
    driver,
    action: { type: 'search', params: { label: '搜索申请、样品、项目、通道或人员', value: requestedValue } },
    context: conservativeContext('records')
  });

  assert.deepEqual(result.searchEvidence, { requestedValue, appliedValue });
  assert.equal(result.searchEvidence.requestedValue.includes('\n'), true);
  assert.equal(result.searchEvidence.appliedValue.includes('\n'), false);
  assert.equal(result.searchEvidence.appliedValue.includes(` \"'_*%`), true);
  assert.equal(Object.isFrozen(result.searchEvidence), true);
});

test('M08 usePrepared 预约只提交当前跨页选择，不重新打开申请或重建分配', async () => {
  const driver = fakeDriver({ initialPage: 'apply' });
  const context = conservativeContext('apply');
  await executeWorkflowAction({ driver, action: { type: 'selectSample', params: { sampleId: 'REQ-001.001' } }, context });
  await executeWorkflowAction({ driver, action: { type: 'selectChannel', params: { channelKey: 'DEV|3' } }, context });
  const before = driver.calls.length;
  const result = await executeWorkflowAction({
    driver,
    action: {
      type: 'reserve', expect: 'success', revisionDelta: 1,
      params: { requestNo: 'REQ-001', sampleIds: ['REQ-001.001'], channelKeys: ['DEV|3'], usePrepared: true, confirm: true }
    },
    context
  });
  assert.equal(result.outcome, 'success');
  const calls = driver.calls.slice(before);
  assert.equal(calls.some(call => call[0] === 'locator' && String(call[1]).includes('select-request')), false);
  assert.equal(calls.some(call => call[0] === 'locator' && String(call[1]).includes('open-channel-picker')), false);
  assert.equal(calls.filter(call => call[0] === 'click' && call[1] === '提交预约').length, 1);
});
