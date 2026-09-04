import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';

import { createWorkflowElectronDriver } from '../workflows/electron-driver.mjs';
import { seedWorkflowFixture } from '../workflows/fixtures.mjs';
import { createWorkflowRunContext } from '../workflows/run-context.mjs';

const projectRoot = path.resolve(import.meta.dirname, '..', '..');

export function createVisualProtectedPaths({ projectRoot: root, appDataRoot = process.env.APPDATA } = {}) {
  if (typeof root !== 'string' || root.trim() === '') throw new TypeError('projectRoot is required');
  if (typeof appDataRoot !== 'string' || appDataRoot.trim() === '') throw new TypeError('APPDATA is required');
  const resolvedProjectRoot = path.resolve(root);
  return Object.freeze([
    path.resolve(appDataRoot, 'battery-channel-hub', 'data', 'battery-channel-hub.sqlite'),
    path.join(resolvedProjectRoot, '人工回归数据包', 'v0.4.2', 'SQLite', '01-26设备529通道空基线.sqlite'),
    path.join(resolvedProjectRoot, '人工回归数据包', 'v0.4.2', 'SQLite', '02-事务与状态迁移.sqlite'),
    path.join(resolvedProjectRoot, '人工回归数据包', 'v0.4.2', 'SQLite', '03-100申请999子样品2000日志审计.sqlite'),
    path.join(resolvedProjectRoot, '人工回归数据包', 'v0.4.3', 'SQLite', '04-及时率筛选与预约待办.sqlite'),
    path.join(resolvedProjectRoot, 'tests', 'fixtures', 'v0.4.6-scenario-contract.md')
  ]);
}

export const REQUIRED_EDITOR_IDS = Object.freeze(['channelEditor', 'requestEditor', 'testerEditor', 'deviceEditor']);
export const VISUAL_ENTRY_REQUIRED_FIELDS = Object.freeze([
  'kind', 'pageId', 'viewport', 'pngPath', 'status', 'activePage', 'scrollTop',
  'scrollState', 'nonZeroScrollContainers',
  'storageRowCount', 'editorVisible', 'editorFieldCount', 'editorButtonCount',
  'editorActionButtonsFullyVisible', 'editorActionButtonBounds',
  'horizontalOverflow', 'horizontalOverflowPixels', 'whiteScreen', 'consoleErrors',
  'pageErrors', 'interactiveControlCount'
]);

export const VISUAL_PAGE_MANIFEST = Object.freeze([
  ...['dashboard', 'timeliness', 'apply', 'runningSamples', 'storageSamples', 'reserved', 'requests', 'records', 'testers', 'devices']
    .map(pageId => Object.freeze({ kind: 'main', pageId, viewport: '1366x768' })),
  ...['apply', 'devices', 'records', 'timeliness', 'runningSamples', 'storageSamples']
    .map(pageId => Object.freeze({ kind: 'main', pageId, viewport: '1440x900' }))
]);

function screenshotName(entry) {
  return `${entry.viewport}-${entry.pageId}`;
}

async function resetScroll(page, activeRootId) {
  await page.evaluate(async pageId => {
    const root = document.getElementById(pageId) || document.body;
    const targets = new Set([document.scrollingElement, document.documentElement, document.body]);
    for (let element = root; element; element = element.parentElement) targets.add(element);
    for (let pass = 0; pass < 3; pass += 1) {
      window.scrollTo(0, 0);
      for (const element of targets) {
        if (!element) continue;
        element.scrollTop = 0;
        element.scrollLeft = 0;
      }
      await new Promise(resolve => requestAnimationFrame(resolve));
    }
  }, activeRootId);
  await page.waitForFunction(pageId => {
    const root = document.getElementById(pageId) || document.body;
    const targets = new Set([document.scrollingElement, document.documentElement, document.body]);
    for (let element = root; element; element = element.parentElement) targets.add(element);
    return [...targets].every(element => !element || (Math.abs(element.scrollTop) < 1 && Math.abs(element.scrollLeft) < 1))
      && Math.abs(window.scrollX) < 1 && Math.abs(window.scrollY) < 1;
  }, activeRootId);
}

async function pageEvidence(driver, { pageId, viewport, pngPath, kind = 'main', activeRootId = pageId, status = 'captured', editorId = null, editorScrolledIntoView = null }) {
  const evidence = await driver.uiProjection();
  const details = await driver.page().evaluate(({ expectedPageId, expectedEditorId }) => {
    const root = expectedPageId ? document.getElementById(expectedPageId) : document.body;
    const visible = element => Boolean(element && element.getClientRects().length > 0 && getComputedStyle(element).display !== 'none');
    const inViewport = element => {
      if (!visible(element)) return false;
      const bounds = element.getBoundingClientRect();
      return bounds.top < window.innerHeight && bounds.bottom > 0 && bounds.left < window.innerWidth && bounds.right > 0;
    };
    const editor = expectedEditorId ? document.getElementById(expectedEditorId) : null;
    const targets = new Set([document.scrollingElement, document.documentElement, document.body]);
    for (let element = root; element; element = element.parentElement) targets.add(element);
    const describe = element => ({
      element: `${element.tagName.toLowerCase()}${element.id ? `#${element.id}` : ''}${[...element.classList].slice(0, 3).map(name => `.${name}`).join('')}`,
      scrollTop: element.scrollTop,
      scrollLeft: element.scrollLeft,
      scrollHeight: element.scrollHeight,
      clientHeight: element.clientHeight,
      scrollWidth: element.scrollWidth,
      clientWidth: element.clientWidth
    });
    const actionButtons = expectedEditorId
      ? [...editor.querySelectorAll('button, [role="button"]')].filter(visible).map(element => {
        const bounds = element.getBoundingClientRect();
        return { text: element.textContent.trim(), top: bounds.top, bottom: bounds.bottom, left: bounds.left, right: bounds.right,
          fullyVisible: bounds.top >= 0 && bounds.left >= 0 && bounds.bottom <= window.innerHeight && bounds.right <= window.innerWidth };
      })
      : [];
    return {
      interactiveControlCount: [...(root?.querySelectorAll('button, input, select, textarea, [role="button"]') || [])].filter(visible).length,
      scrollTop: Math.max(window.scrollY, document.scrollingElement?.scrollTop || 0, root?.scrollTop || 0),
      nonZeroScrollContainers: [...targets].filter(element => element && (Math.abs(element.scrollTop) >= 1 || Math.abs(element.scrollLeft) >= 1)).map(describe),
      storageRowCount: [...document.querySelectorAll('[data-testid="storage-sample-row"]')].filter(visible).length,
      editorVisible: expectedEditorId ? inViewport(editor) : null,
      editorFieldCount: expectedEditorId ? [...editor.querySelectorAll('input, select, textarea')].filter(visible).length : 0,
      editorButtonCount: actionButtons.length,
      editorActionButtonsFullyVisible: expectedEditorId ? actionButtons.length > 0 && actionButtons.every(button => button.fullyVisible) : null,
      editorActionButtonBounds: actionButtons
    };
  }, { expectedPageId: activeRootId, expectedEditorId: editorId });
  return Object.freeze({
    kind,
    pageId,
    viewport,
    pngPath,
    status,
    activePage: evidence.projection.currentPage,
    scrollTop: details.scrollTop,
    scrollState: status === 'captured-lower-state' ? 'lower-editor-actions' : 'top',
    nonZeroScrollContainers: details.nonZeroScrollContainers,
    storageRowCount: details.storageRowCount,
    editorVisible: details.editorVisible,
    editorFieldCount: details.editorFieldCount,
    editorButtonCount: details.editorButtonCount,
    editorActionButtonsFullyVisible: details.editorActionButtonsFullyVisible,
    editorActionButtonBounds: details.editorActionButtonBounds,
    editorScrolledIntoView,
    horizontalOverflow: evidence.horizontalOverflow,
    horizontalOverflowPixels: evidence.horizontalOverflowPixels,
    whiteScreen: evidence.whiteScreen,
    consoleErrors: evidence.consoleErrors,
    pageErrors: evidence.pageErrors,
    interactiveControlCount: details.interactiveControlCount
  });
}

async function navigate(page, pageId) {
  await page.evaluate(id => {
    const nav = document.querySelector(`.nav[data-page="${id}"]`);
    if (nav) nav.click();
    else if (typeof window.go === 'function') window.go(id);
  }, pageId);
  await page.waitForFunction(id => document.getElementById(id)?.classList.contains('active'), pageId);
  await resetScroll(page, pageId);
}

async function startActiveStorage(page) {
  const result = await page.evaluate(async () => {
    const state = await window.batteryDesktop.loadState();
    const sample = state.samples.find(item => item.status === 'pending');
    if (!sample) throw new Error('C02 fixture has no pending sample for active storage');
    const response = await window.batteryDesktop.executeStorage({
      type: 'startStorage',
      payload: {
        storageId: 'STO-VISUAL-C02-001',
        requestNo: sample.requestNo,
        sampleIds: [sample.id],
        tester: 'visual-pages-smoke',
        expectedEndAt: '2026-09-30T10:00:00.000Z',
        note: 'visual acceptance fixture',
        actor: 'visual-pages-smoke',
        auditId: 'AUDIT-VISUAL-C02-STORAGE-001',
        now: '2026-08-28T10:00:00.000Z'
      }
    });
    if (response?.ok && response.state) window.adoptLegacyApplicationState?.(response.state);
    return { ok: Boolean(response?.ok), code: response?.code || '', message: response?.message || '' };
  });
  assert.equal(result.ok, true, `create active storage fixture failed: ${result.code} ${result.message}`);
}

async function capture(driver, options) {
  await resetScroll(driver.page(), options.activeRootId || options.pageId);
  await options.beforeScreenshot?.(driver.page());
  const pngPath = await driver.screenshot(options.name || screenshotName(options));
  // The workflow driver reserves and guards the artifact path. Replace its full-page image
  // with a viewport image so a tall form cannot conceal clipped controls outside the viewport.
  await driver.page().screenshot({ path: pngPath, fullPage: false });
  const entry = await pageEvidence(driver, { ...options, pngPath });
  if (options.status !== 'captured-lower-state') {
    assert.equal(entry.scrollTop, 0, `mid-page screenshot blocked: ${options.pageId}`);
    assert.deepEqual(entry.nonZeroScrollContainers, [], `non-zero scroll container blocked: ${options.pageId} ${JSON.stringify(entry.nonZeroScrollContainers)}`);
  }
  return entry;
}

async function login(page) {
  await page.locator('#username').fill('visual-pages-smoke');
  await page.locator('#login .btn.wide').click();
  await page.waitForFunction(() => window.__batteryAppReady === true && document.getElementById('app')?.style.display !== 'none');
}

async function assertDashboardTodoUsesBrowserLocalTimes(page) {
  await navigate(page, 'dashboard');
  const inspectCurrentPage = () => page.evaluate(async () => {
    const state = await window.batteryDesktop.loadState();
    const pad = value => String(value).padStart(2, '0');
    const expectedTime = value => {
      const text = String(value ?? '').trim();
      if (!text) return '未填写预约时间';
      const date = new Date(text);
      if (Number.isNaN(date.getTime())) return text;
      return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
    };
    const items = [...document.querySelectorAll('#reservationTodoList .dashboard-todo')].map(item => {
      const index = Number(item.querySelector('[data-dashboard-action="todo-detail"]')?.dataset.recordIndex);
      const record = state.records[index];
      return {
        index,
        recordExists: Boolean(record),
        expected: expectedTime(record?.start || record?.time),
        actual: item.querySelector('small')?.textContent?.trim() || ''
      };
    });
    return { total: Number(document.getElementById('reservationTodoSummary')?.textContent?.match(/\d+/)?.[0] || 0), items };
  });
  const expectedIndexes = new Set();
  let total = 0;
  do {
    const observed = await inspectCurrentPage();
    total = observed.total;
    assert.ok(observed.items.length > 0, 'dashboard must render visible reservation todo items');
    for (const item of observed.items) {
      assert.equal(item.recordExists, true, `dashboard todo record is missing from loadState at index ${item.index}`);
      assert.equal(item.actual, item.expected, `dashboard todo must use browser-local time at record index ${item.index}`);
      assert.equal(/[T]/.test(item.actual), false, `dashboard todo must not render ISO T at record index ${item.index}`);
      assert.equal(/Z$/.test(item.actual), false, `dashboard todo must not render trailing ISO Z at record index ${item.index}`);
      expectedIndexes.add(item.index);
    }
    const next = page.locator('[data-dashboard-action="todo-next"]');
    if (await next.isDisabled()) break;
    const previousIndexes = [...expectedIndexes].join(',');
    await next.click();
    await page.waitForFunction(previous => [...document.querySelectorAll('#reservationTodoList [data-dashboard-action="todo-detail"]')]
      .map(item => item.dataset.recordIndex).join(',') !== previous, previousIndexes);
  } while (true);
  assert.ok(total > 0, 'dashboard fixture must expose reservation todos');
  assert.equal(expectedIndexes.size, total, 'dashboard todo pagination must verify every todo record');
  const previous = page.locator('[data-dashboard-action="todo-previous"]');
  while (!await previous.isDisabled()) {
    await previous.click();
  }
}

async function captureSupplementary(driver, entries) {
  const page = driver.page();
  entries.push(await capture(driver, { kind: 'supplementary', status: 'captured', pageId: 'login', activeRootId: 'login', viewport: '1366x768', name: '1366x768-login' }));
  await login(page);
  await startActiveStorage(page);

  await navigate(page, 'runningSamples');
  const returnAction = page.locator('[data-sample-action="running-return"]').first();
  if (await returnAction.count()) {
    await returnAction.click();
    const dialog = page.locator('#sampleWorkbenchDialog[open]');
    await dialog.waitFor({ state: 'visible' });
    entries.push(await capture(driver, { kind: 'supplementary', status: 'captured', pageId: 'sampleWorkbenchDialog', activeRootId: 'runningSamples', viewport: '1366x768', name: '1366x768-sample-workbench-dialog' }));
    await page.keyboard.press('Escape');
  }

  const editors = [
    { pageId: 'channelEditor', activeRootId: 'devices', open: 'openChannelEditor', close: 'closeChannelEditor' },
    { pageId: 'requestEditor', activeRootId: 'requests', open: 'editRequest', close: 'closeRequestEditor', argument: true },
    { pageId: 'testerEditor', activeRootId: 'testers', open: 'openTesterEditor', close: 'closeTesterEditor' },
    { pageId: 'deviceEditor', activeRootId: 'devices', open: 'openDeviceEditor', close: 'closeDeviceEditor' }
  ];
  for (const editor of editors) {
    await driver.resizeViewport('1366x768');
    await navigate(page, editor.activeRootId);
    await page.evaluate(async ({ open, requiresRequestId }) => {
      const state = requiresRequestId ? await window.batteryDesktop.loadState() : null;
      const argument = requiresRequestId ? encodeURIComponent(state?.requests?.[0]?.id || '') : undefined;
      window[open]?.(argument);
    }, { open: editor.open, requiresRequestId: editor.argument === true });
    await page.locator(`#${editor.pageId}`).waitFor({ state: 'visible' });
    const entry = await capture(driver, {
      kind: 'supplementary', status: 'captured-lower-state', pageId: editor.pageId, activeRootId: editor.activeRootId,
      viewport: '1366x768', name: `1366x768-${editor.pageId}-lower-actions`, editorId: editor.pageId, editorScrolledIntoView: true,
      beforeScreenshot: async targetPage => {
        await targetPage.evaluate(editorId => document.getElementById(editorId)?.scrollIntoView({ block: 'end' }), editor.pageId);
        await targetPage.waitForFunction(editorId => {
          const editorElement = document.getElementById(editorId);
          return [...(editorElement?.querySelectorAll('button, [role="button"]') || [])].some(button => {
            const bounds = button.getBoundingClientRect();
            return bounds.top >= 0 && bounds.left >= 0 && bounds.bottom <= window.innerHeight && bounds.right <= window.innerWidth;
          });
        }, editor.pageId);
      }
    });
    assert.equal(entry.editorVisible, true, `${editor.pageId} is not visibly open`);
    assert.ok(entry.editorFieldCount > 0 && entry.editorButtonCount > 0, `${editor.pageId} lacks fields or buttons`);
    assert.equal(entry.editorScrolledIntoView, true, `${editor.pageId} did not scroll into view`);
    assert.equal(entry.editorActionButtonsFullyVisible, true, `${editor.pageId} action buttons are clipped by the viewport`);
    if (editor.pageId === 'requestEditor') {
      const requestEditor = page.locator('#requestEditor');
      assert.equal(await requestEditor.count(), 1, 'requestEditor must resolve exactly once');
      assert.equal(await requestEditor.isVisible(), true, 'requestEditor must be visible');
      const explicitNote = requestEditor.locator('#eNote[aria-label="备注"]');
      assert.equal(await explicitNote.count(), 1, 'requestEditor 备注 must expose an explicit accessible name');
      const note = requestEditor.getByLabel('备注', { exact: true });
      assert.equal(await note.count(), 1, 'requestEditor 备注 must resolve exactly once');
      await note.fill('visual request editor note');
      assert.equal(await note.inputValue(), 'visual request editor note', 'requestEditor 备注 must remain fillable');
    }
    entries.push(entry);
    await page.evaluate(close => window[close]?.(), editor.close);
  }
}

export function createVisualPagesSmokePlan({ context, packaged = false, executablePath } = {}) {
  if (!context || typeof context !== 'object') throw new TypeError('context is required');
  if (typeof context.dataRoot !== 'string' || context.dataRoot.trim() === '') throw new TypeError('context.dataRoot is required');
  if (typeof context.profileRoot !== 'string' || context.profileRoot.trim() === '') throw new TypeError('context.profileRoot is required');
  if (typeof packaged !== 'boolean') throw new TypeError('packaged must be a boolean');
  const profileRoot = path.join(context.profileRoot, 'visual-pages');
  return Object.freeze({
    dataRoot: packaged ? path.join(profileRoot, 'data') : context.dataRoot,
    profileRoot,
    packaged,
    executablePath
  });
}

export async function runVisualPagesSmoke({ executablePath, packaged = false } = {}) {
  const context = await createWorkflowRunContext({
    projectRoot,
    mode: 'visual-pages',
    protectedPaths: createVisualProtectedPaths({ projectRoot })
  });
  const plan = createVisualPagesSmokePlan({ context, executablePath, packaged });
  await seedWorkflowFixture({ dataRoot: plan.dataRoot, kind: 'baseline', workflowId: 'C02' });
  const driverOptions = {
    projectRoot,
    dataRoot: plan.dataRoot,
    profileRoot: plan.profileRoot,
    viewport: '1366x768',
    timeoutMs: 30_000
  };
  if (plan.packaged) {
    driverOptions.packaged = true;
    driverOptions.executablePath = plan.executablePath;
  }
  const driver = createWorkflowElectronDriver(driverOptions);
  const entries = [];
  let protectedVerification;
  let completed = false;
  try {
    await driver.start();
    await captureSupplementary(driver, entries);
    const page = driver.page();
    await assertDashboardTodoUsesBrowserLocalTimes(page);
    for (const item of VISUAL_PAGE_MANIFEST) {
      await driver.resizeViewport(item.viewport);
      await navigate(page, item.pageId);
      const entry = await capture(driver, item);
      assert.equal(entry.activePage, item.pageId, `wrong active page for ${item.pageId}`);
      assert.equal(entry.whiteScreen, false, `white screen on ${item.pageId}`);
      if (item.pageId === 'storageSamples') assert.ok(entry.storageRowCount >= 1, 'storage samples screenshot must include an active storage row');
      entries.push(entry);
    }
    protectedVerification = await context.verifyProtected();
    assert.equal(protectedVerification.ok, true, `protected paths changed: ${JSON.stringify(protectedVerification.changed)}`);
    completed = true;
  } finally {
    await driver.close();
    if (completed) await context.cleanup({ success: true });
  }
  const manifestPath = path.join(context.artifactsRoot, 'visual-pages-manifest.json');
  const cleanup = Object.freeze({ state: 'closed' });
  await writeFile(manifestPath, `${JSON.stringify({ runRoot: context.runRoot, fixture: 'C02', protectedVerification, cleanup, entries }, null, 2)}\n`, 'utf8');
  return Object.freeze({ runRoot: context.runRoot, manifestPath, protectedVerification, cleanup, entries: Object.freeze(entries) });
}

if (path.resolve(process.argv[1] || '') === fileURLToPath(import.meta.url)) {
  const result = await runVisualPagesSmoke();
  process.stdout.write(`VISUAL_PAGES_SMOKE_RESULT=${JSON.stringify(result)}\n`);
}
