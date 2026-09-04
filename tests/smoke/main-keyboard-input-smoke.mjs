import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { createLegacySqliteStore } from '../../src/main/legacy-sqlite-store.mjs';
import { createWorkflowElectronDriver } from '../workflows/electron-driver.mjs';
import { seedWorkflowFixture } from '../workflows/fixtures.mjs';
import { createWorkflowRunContext } from '../workflows/run-context.mjs';
import { createVisualProtectedPaths } from './main-visual-pages-smoke.mjs';

const require = createRequire(import.meta.url);
const preset = require('../../lib/device-preset.js');
const projectRoot = path.resolve(import.meta.dirname, '..', '..');
const packagedExecutable = path.join(projectRoot, 'dist', 'win-unpacked', '电池测试通道预约与使用看板.exe');
const pages = ['dashboard', 'timeliness', 'apply', 'runningSamples', 'storageSamples', 'reserved', 'requests', 'records', 'testers', 'devices'];
const excludedInputTypes = new Set(['button', 'checkbox', 'color', 'file', 'hidden', 'radio', 'range', 'reset', 'submit']);

function sha256(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function request(id, project) {
  return {
    id, qty: 1, test: '循环测试', project, sample: '35Ah', client: '委托人', dept: '研发部',
    tester: 'keyboard-smoke', status: 'assigned'
  };
}

function sample(id, requestNo, status, channelKey = '') {
  return {
    id, requestNo, ordinal: 1, status, channelKey,
    start: status === 'running' ? '2026-08-29T08:00:00.000Z' : '', end: '', hasHistory: status !== 'pending'
  };
}

function runningReturnFixture() {
  const deviceProfiles = preset.devices();
  const channels = preset.channels();
  const channel = channels[0];
  Object.assign(channel, {
    state: 'busy', project: '键盘退回流程', user: 'keyboard-smoke', start: '2026-08-29T08:00:00.000Z',
    end: '2026-08-30T08:00:00.000Z', requestNo: 'REQ-KB-RUNNING', test: '循环测试',
    currentRecordId: 'REC-KB-RUNNING', nextRecordId: 'REC-KB-NEXT'
  });
  return {
    revision: 0,
    requests: [request('REQ-KB-RUNNING', '键盘退回流程'), request('REQ-KB-NEXT', '下一预约保留')],
    samples: [
      sample('REQ-KB-RUNNING.001', 'REQ-KB-RUNNING', 'running', channel.key),
      sample('REQ-KB-NEXT.001', 'REQ-KB-NEXT', 'reserved', channel.key)
    ],
    records: [
      {
        id: 'REC-KB-RUNNING', no: 'REQ-KB-RUNNING', requestNo: 'REQ-KB-RUNNING',
        sampleId: 'REQ-KB-RUNNING.001', project: '键盘退回流程', test: '循环测试', status: 'running',
        channelKey: channel.key, keys: [channel.key], start: '2026-08-29T08:00:00.000Z',
        end: '2026-08-30T08:00:00.000Z', user: 'keyboard-smoke'
      },
      {
        id: 'REC-KB-NEXT', no: 'REQ-KB-NEXT', requestNo: 'REQ-KB-NEXT', sampleId: 'REQ-KB-NEXT.001',
        project: '下一预约保留', test: '循环测试', status: 'reserved', channelKey: channel.key, keys: [channel.key],
        start: '2026-08-30T09:00:00.000Z', end: '2026-08-30T12:00:00.000Z', user: 'next-user'
      }
    ],
    storageRecords: [], requestSourceRows: [], auditLogs: [], formChangeJournal: [], testers: [],
    deviceProfiles, channels, username: 'keyboard-smoke', savedAt: ''
  };
}

async function seedState(dataRoot, state) {
  const store = await createLegacySqliteStore({ dataRoot, clock: () => '2026-08-29T07:00:00.000Z' });
  try {
    const saved = await store.save({ expectedRevision: 0, state, journalEntries: [] });
    assert.equal(saved.ok, true, `${saved.code || ''}: ${saved.message || ''}`);
    return saved.state;
  } finally {
    store.close();
  }
}

async function reopenState(dataRoot) {
  const store = await createLegacySqliteStore({ dataRoot });
  try {
    const loaded = await store.load();
    assert.equal(loaded.ok, true, `${loaded.code || ''}: ${loaded.message || ''}`);
    return loaded.state;
  } finally {
    store.close();
  }
}

async function navigate(page, pageId) {
  await page.locator(`.nav[data-page="${pageId}"]`).click();
  await page.waitForFunction(id => document.getElementById(id)?.classList.contains('active'), pageId);
}

async function installKeyboardTrace(page) {
  await page.evaluate(() => {
    window.__keyboardSmokeEvents = [];
    if (window.__keyboardSmokeInstalled) return;
    window.__keyboardSmokeInstalled = true;
    for (const type of ['keydown', 'keypress', 'beforeinput', 'input', 'keyup']) {
      document.addEventListener(type, event => {
        const target = event.target;
        window.__keyboardSmokeEvents.push({
          type,
          key: event.key || '',
          inputType: event.inputType || '',
          defaultPrevented: event.defaultPrevented,
          tag: target?.tagName?.toLowerCase?.() || '',
          id: target?.id || '',
          value: typeof target?.value === 'string' ? target.value : '',
          composing: Boolean(event.isComposing)
        });
      }, true);
    }
  });
}

async function visibleEditableFields(page, rootSelector) {
  return page.locator(rootSelector).evaluate((root, excluded) => {
    const visible = element => Boolean(element.getClientRects().length && getComputedStyle(element).visibility !== 'hidden');
    const quote = value => String(value).replaceAll('\\', '\\\\').replaceAll('"', '\\"');
    const stableDataKeys = [
      'workbenchField', 'fullField', 'legacyAction', 'sampleFilter', 'dashboardFilter',
      'timelinessFilter', 'boundedFilter'
    ];
    const elements = [...root.querySelectorAll('input, textarea, [contenteditable="true"]')]
      .filter(element => visible(element) && !element.disabled && !element.readOnly)
      .filter(element => element.tagName !== 'INPUT' || !excluded.includes((element.type || 'text').toLowerCase()));
    return elements.map((element, index) => {
      let selector = '';
      if (element.id) selector = `#${CSS.escape(element.id)}`;
      if (!selector) {
        const key = stableDataKeys.find(name => element.dataset[name] !== undefined);
        if (key) {
          const attr = key.replace(/[A-Z]/g, match => `-${match.toLowerCase()}`);
          selector = `${element.tagName.toLowerCase()}[data-${attr}="${quote(element.dataset[key])}"]`;
        }
      }
      if (!selector && element.name) selector = `${element.tagName.toLowerCase()}[name="${quote(element.name)}"]`;
      if (!selector) {
        const marker = `keyboard-smoke-${index}`;
        element.dataset.keyboardSmoke = marker;
        selector = `[data-keyboard-smoke="${marker}"]`;
      }
      const label = element.closest('label')?.textContent?.replace(/\s+/g, ' ')?.trim()
        || element.getAttribute('aria-label') || element.placeholder || selector;
      return {
        selector,
        label,
        tag: element.tagName.toLowerCase(),
        type: element.tagName === 'INPUT' ? (element.type || 'text').toLowerCase() : 'textarea',
        originalValue: element.value || ''
      };
    });
  }, [...excludedInputTypes]);
}

function keySequence(field) {
  if (field.type === 'number') return { keys: '42.5', steps: [...'42.5'], exact: true };
  // Chromium's native date editor consumes low-level keys by visible segments
  // (month, day, year, then time), not by the serialized ISO value.
  if (field.type === 'date') return {
    keys: '↑→↑→↑', steps: ['ArrowUp', 'ArrowRight', 'ArrowUp', 'ArrowRight', 'ArrowUp'], exact: false
  };
  if (field.type === 'datetime-local') return {
    keys: '↑→↑→↑→↑→↑→↑',
    steps: [
      'ArrowUp', 'ArrowRight', 'ArrowUp', 'ArrowRight', 'ArrowUp', 'ArrowRight',
      'ArrowUp', 'ArrowRight', 'ArrowUp', 'ArrowRight', 'ArrowUp'
    ],
    exact: false
  };
  if (field.type === 'time') return {
    keys: '↑→↑→↑', steps: ['ArrowUp', 'ArrowRight', 'ArrowUp', 'ArrowRight', 'ArrowUp'], exact: false
  };
  if (field.type === 'tel') return { keys: '13800138000', steps: [...'13800138000'], exact: true };
  return { keys: 'Kb42x', steps: [...'Kb42x'], exact: true };
}

async function lowLevelType(page, rootSelector, field, caseName) {
  const scope = page.locator(rootSelector);
  const target = scope.locator(field.selector);
  assert.equal(await target.count(), 1, `${caseName}: selector must resolve exactly once: ${field.selector}`);
  await target.scrollIntoViewIfNeeded();
  await target.click();
  await page.evaluate(() => { window.__keyboardSmokeEvents = []; });
  await page.keyboard.press('Control+A');
  await page.keyboard.press('Backspace');
  const { keys, steps, exact } = keySequence(field);
  const focusTrace = [];
  for (const key of steps) {
    if (key.length === 1) await page.keyboard.type(key, { delay: 2 });
    else await page.keyboard.press(key);
    const focus = await page.evaluate(() => {
      const active = document.activeElement;
      return {
        tag: active?.tagName?.toLowerCase?.() || '',
        id: active?.id || '',
        editable: Boolean(active && (active.matches('input, textarea') || active.isContentEditable)),
        value: typeof active?.value === 'string' ? active.value : ''
      };
    });
    focusTrace.push(focus);
    assert.equal(focus.editable, true, `${caseName}: focus was lost after key ${key}`);
  }
  const final = await page.evaluate(() => {
    const active = document.activeElement;
    const events = window.__keyboardSmokeEvents || [];
    const counts = Object.fromEntries(['keydown', 'keypress', 'beforeinput', 'input', 'keyup']
      .map(type => [type, events.filter(event => event.type === type).length]));
    return {
      value: typeof active?.value === 'string' ? active.value : '',
      counts,
      defaultPrevented: events.filter(event => event.defaultPrevented).map(event => ({ type: event.type, key: event.key }))
    };
  });
  if (exact) assert.equal(final.value, keys, `${caseName}: final value mismatch`);
  assert.ok(final.counts.keydown >= steps.length, `${caseName}: missing keydown events`);
  assert.ok(final.counts.keyup >= steps.length, `${caseName}: missing keyup events`);
  assert.deepEqual(final.defaultPrevented, [], `${caseName}: keyboard event was prevented`);
  return Object.freeze({
    caseName,
    selector: field.selector,
    label: field.label,
    type: field.type,
    keys,
    value: final.value,
    valueAssertion: exact ? 'exact' : 'native-segment-events-only',
    nativeValueChanged: exact ? null : final.value !== field.originalValue,
    counts: final.counts,
    focusRetainedAfterEveryKey: focusTrace.every(item => item.editable),
    defaultPrevented: final.defaultPrevented
  });
}

async function testScope(page, results, scopeName, rootSelector) {
  const fields = await visibleEditableFields(page, rootSelector);
  for (const field of fields) {
    results.push(await lowLevelType(page, rootSelector, field, `${scopeName} / ${field.label}`));
  }
  return fields.length;
}

async function login(page, results) {
  await testScope(page, results, '登录', '#login');
  await page.locator('#login .btn.wide').click();
  await page.waitForFunction(() => window.__batteryAppReady === true && document.getElementById('app')?.style.display !== 'none');
}

async function openApplyDetails(page) {
  await navigate(page, 'apply');
  await page.locator('[data-legacy-action="select-request"]').first().click();
  await page.locator('#legacyReservationRoot[data-details-open="true"], #legacyReservationRoot .legacy-reservation-details').first().waitFor({ state: 'visible' });
  const channelPicker = page.locator('[data-legacy-action="open-channel-picker"]:not([disabled])').first();
  if (await channelPicker.count()) await channelPicker.click();
}

async function testEditorsAndDialogs(page, results) {
  await navigate(page, 'runningSamples');
  const manage = page.locator('[data-sample-action="running-manage"]').first();
  if (await manage.count()) {
    await manage.click();
    await page.locator('#channelEditor').waitFor({ state: 'visible' });
    await testScope(page, results, '正在测试 / 管理测试 / 通道编辑', '#channelEditor');
    await page.evaluate(() => window.closeChannelEditor?.());
  }

  await navigate(page, 'storageSamples');
  const storageEdit = page.locator('[data-sample-action="storage-edit"]').first();
  if (await storageEdit.count()) {
    await storageEdit.click();
    await page.locator('#sampleWorkbenchDialog[open]').waitFor({ state: 'visible' });
    await testScope(page, results, '长期存储 / 编辑存储', '#sampleWorkbenchDialog');
    await page.locator('[data-workbench-cancel]').click();
  }
  const storageReturn = page.locator('[data-sample-action="storage-return"]').first();
  if (await storageReturn.count()) {
    await storageReturn.click();
    await page.locator('#sampleWorkbenchDialog[open]').waitFor({ state: 'visible' });
    await testScope(page, results, '长期存储 / 退回申请', '#sampleWorkbenchDialog');
    await page.locator('[data-workbench-cancel]').click();
  }

  await navigate(page, 'testers');
  await page.evaluate(() => window.openTesterEditor?.());
  await page.locator('#testerEditor.open').waitFor({ state: 'visible' });
  await testScope(page, results, '测试人员编辑器', '#testerEditor');
  await page.evaluate(() => window.closeTesterEditor?.());

  await navigate(page, 'devices');
  await page.evaluate(() => window.openDeviceEditor?.());
  await page.locator('#deviceEditor').waitFor({ state: 'visible' });
  await testScope(page, results, '设备编辑器', '#deviceEditor');
  await page.evaluate(() => window.closeDeviceEditor?.());

  await page.evaluate(() => window.openChannelEditor?.());
  await page.locator('#channelEditor').waitFor({ state: 'visible' });
  await testScope(page, results, '通道编辑器', '#channelEditor');
  await page.evaluate(() => window.closeChannelEditor?.());

  await navigate(page, 'requests');
  await page.evaluate(async () => {
    const state = await window.batteryDesktop.loadState();
    window.editRequest?.(encodeURIComponent(state.requests[0].id));
  });
  await page.locator('#requestEditor').waitFor({ state: 'visible' });
  await testScope(page, results, '申请编辑器', '#requestEditor');
  await page.evaluate(() => window.closeRequestEditor?.());
}

async function runInputMatrix({ packaged }) {
  const mode = packaged ? 'keyboard-input-packaged' : 'keyboard-input-source';
  const context = await createWorkflowRunContext({
    projectRoot,
    mode,
    protectedPaths: createVisualProtectedPaths({ projectRoot })
  });
  const profileRoot = path.join(context.profileRoot, mode);
  const dataRoot = packaged ? path.join(profileRoot, 'data') : context.dataRoot;
  await seedWorkflowFixture({ dataRoot, kind: 'history', workflowId: 'M07' });
  const driver = createWorkflowElectronDriver({
    projectRoot,
    dataRoot,
    profileRoot,
    viewport: '1366x768',
    timeoutMs: 30_000,
    ...(packaged ? { packaged: true, executablePath: packagedExecutable } : {})
  });
  const results = [];
  let protectedVerification;
  try {
    await driver.start();
    const page = driver.page();
    await installKeyboardTrace(page);
    await login(page, results);
    await openApplyDetails(page);
    await testScope(page, results, '预约申请详情与通道选择', '#apply');
    await testEditorsAndDialogs(page, results);
    for (const pageId of pages) {
      await navigate(page, pageId);
      await testScope(page, results, `页面 ${pageId}`, `#${pageId}`);
    }
    const projection = await driver.uiProjection();
    assert.deepEqual(projection.consoleErrors, [], `${mode}: console errors`);
    assert.deepEqual(projection.pageErrors, [], `${mode}: page errors`);
    protectedVerification = await context.verifyProtected();
    assert.equal(protectedVerification.ok, true, `${mode}: protected paths changed`);
  } finally {
    await driver.close();
  }
  return Object.freeze({ mode, runRoot: context.runRoot, dataRoot, results, protectedVerification });
}

async function runReturnFlow({ packaged }) {
  const mode = packaged ? 'keyboard-return-packaged' : 'keyboard-return-source';
  const context = await createWorkflowRunContext({
    projectRoot,
    mode,
    protectedPaths: createVisualProtectedPaths({ projectRoot })
  });
  const profileRoot = path.join(context.profileRoot, mode);
  const dataRoot = packaged ? path.join(profileRoot, 'data') : context.dataRoot;
  const seeded = await seedState(dataRoot, runningReturnFixture());
  const beforeChannel = seeded.channels.find(item => item.currentRecordId === 'REC-KB-RUNNING');
  assert.ok(beforeChannel, `${mode}: seeded running channel missing`);
  const beforeChannelsHash = sha256(seeded.channels);
  const driver = createWorkflowElectronDriver({
    projectRoot,
    dataRoot,
    profileRoot,
    viewport: '1366x768',
    timeoutMs: 30_000,
    ...(packaged ? { packaged: true, executablePath: packagedExecutable } : {})
  });
  const reason = 'keyboard return regression 20260829';
  let uiState;
  let searchEvidence;
  let revisionBeforeReturn;
  try {
    await driver.start();
    const page = driver.page();
    await installKeyboardTrace(page);
    await page.locator('#username').click();
    await page.keyboard.type('keyboard-smoke', { delay: 2 });
    await page.locator('#login .btn.wide').click();
    await page.waitForFunction(() => window.__batteryAppReady === true && document.getElementById('app')?.style.display !== 'none');
    await navigate(page, 'runningSamples');
    const searchField = (await visibleEditableFields(page, '#runningSamples'))
      .find(field => field.selector.includes('sample-filter'));
    assert.ok(searchField, `${mode}: running search input missing`);
    searchEvidence = await lowLevelType(page, '#runningSamples', searchField, `${mode} / 正在测试精确搜索`);
    await page.keyboard.press('Control+A');
    await page.keyboard.press('Backspace');
    for (const key of 'REQ-KB-RUNNING.001') await page.keyboard.type(key, { delay: 2 });
    const rows = page.locator('[data-testid="running-sample-row"]');
    await assert.doesNotReject(() => rows.first().waitFor({ state: 'visible' }));
    assert.equal(await rows.count(), 1, `${mode}: exact running sample search must show one row`);
    assert.equal(await rows.first().locator('[data-sample-id="REQ-KB-RUNNING.001"]').count(), 1);
    await rows.first().locator('[data-sample-action="running-return"]').click();
    const dialog = page.locator('#sampleWorkbenchDialog[open]');
    await dialog.waitFor({ state: 'visible' });
    const reasonField = dialog.locator('[data-workbench-field="reason"]');
    await reasonField.click();
    await page.evaluate(() => { window.__keyboardSmokeEvents = []; });
    for (const key of reason) {
      await page.keyboard.type(key, { delay: 2 });
      assert.equal(await page.evaluate(() => document.activeElement?.matches('[data-workbench-field="reason"]')), true,
        `${mode}: return reason focus lost after ${key}`);
    }
    assert.equal(await reasonField.inputValue(), reason, `${mode}: return reason mismatch`);
    revisionBeforeReturn = await page.evaluate(async () => (await window.batteryDesktop.loadState()).revision);
    await dialog.locator('[data-workbench-submit]').click();
    await page.waitForFunction(async () => {
      const state = await window.batteryDesktop.loadState();
      return state.records.find(item => item.id === 'REC-KB-RUNNING')?.status === 'returned';
    });
    uiState = await page.evaluate(async () => window.batteryDesktop.loadState());
  } finally {
    await driver.close();
  }
  const persisted = await reopenState(dataRoot);
  const record = persisted.records.find(item => item.id === 'REC-KB-RUNNING');
  const returnedSample = persisted.samples.find(item => item.id === 'REQ-KB-RUNNING.001');
  const channel = persisted.channels.find(item => item.key === beforeChannel.key);
  const returnAudits = persisted.auditLogs.filter(item => item.action === 'running_returned_to_application');
  const audit = returnAudits[0];
  assert.equal(record?.status, 'returned');
  assert.equal(record?.returnReason, reason);
  assert.equal(returnedSample?.status, 'pending');
  assert.equal(channel?.currentRecordId, '');
  assert.equal(channel?.nextRecordId, 'REC-KB-NEXT');
  assert.notEqual(sha256(persisted.channels), beforeChannelsHash, 'return must release the current channel pointer');
  assert.ok(persisted.revision > revisionBeforeReturn, 'return must advance the persisted revision');
  assert.ok(persisted.revision >= uiState.revision, 'shutdown persistence must not roll the revision back');
  assert.equal(returnAudits.length, 1, 'return must persist exactly one return audit');
  assert.equal(audit?.target, 'record:REC-KB-RUNNING');
  assert.equal(audit?.after?.reason || record?.returnReason, reason);
  const protectedVerification = await context.verifyProtected();
  assert.equal(protectedVerification.ok, true, `${mode}: protected paths changed`);
  return Object.freeze({
    mode,
    runRoot: context.runRoot,
    dataRoot,
    searchEvidence,
    seededRevision: seeded.revision,
    revisionBeforeReturn,
    revisionAfterReturnInWindow: uiState.revision,
    revisionAfter: persisted.revision,
    recordStatus: record.status,
    sampleStatus: returnedSample.status,
    returnReason: record.returnReason,
    channel: { key: channel.key, state: channel.state, currentRecordId: channel.currentRecordId, nextRecordId: channel.nextRecordId },
    audit: { id: audit.id, action: audit.action, target: audit.target },
    protectedVerification
  });
}

export async function runKeyboardInputSmoke() {
  const sourceInputs = await runInputMatrix({ packaged: false });
  const packagedInputs = await runInputMatrix({ packaged: true });
  const sourceReturn = await runReturnFlow({ packaged: false });
  const packagedReturn = await runReturnFlow({ packaged: true });
  const allInputResults = [...sourceInputs.results, ...packagedInputs.results];
  const report = Object.freeze({
    generatedAt: new Date().toISOString(),
    level: 'real Electron window via Playwright CDP keyboard events',
    imeScope: 'ASCII and native date/number keyboard events only; no Chinese IME claim',
    totals: {
      sourceInputCases: sourceInputs.results.length,
      packagedInputCases: packagedInputs.results.length,
      totalInputCases: allInputResults.length,
      exactValueCases: allInputResults.filter(item => item.valueAssertion === 'exact').length,
      nativeSegmentCases: allInputResults.filter(item => item.valueAssertion === 'native-segment-events-only').length,
      nativeSegmentValueChanged: allInputResults.filter(item => item.valueAssertion === 'native-segment-events-only' && item.nativeValueChanged).length,
      focusRetained: allInputResults.filter(item => item.focusRetainedAfterEveryKey).length,
      preventedCases: allInputResults.filter(item => item.defaultPrevented.length > 0).length
    },
    sourceInputs,
    packagedInputs,
    sourceReturn,
    packagedReturn
  });
  const reportPath = path.join(sourceInputs.runRoot, 'artifacts', 'keyboard-input-report.json');
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  return Object.freeze({ reportPath, report });
}

if (path.resolve(process.argv[1] || '') === fileURLToPath(import.meta.url)) {
  const result = await runKeyboardInputSmoke();
  process.stdout.write(`KEYBOARD_INPUT_SMOKE_RESULT=${JSON.stringify({ reportPath: result.reportPath, totals: result.report.totals })}\n`);
}
