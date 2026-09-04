import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createApplicationHarness } from '../scripts/edge-regression/application-harness.mjs';
import { createEdgeDriver } from '../scripts/edge-regression/edge-driver.mjs';
import { createPathGuard } from '../scripts/edge-regression/path-guard.mjs';
import { startTestHost } from '../scripts/edge-regression/test-host.mjs';

const projectRoot = path.resolve(import.meta.dirname, '..');
const baselineFixture = path.join(projectRoot, '人工回归数据包', 'v0.4.2', 'SQLite', '01-26设备529通道空基线.sqlite');

function populatedWorkbenchState(input) {
  const state = structuredClone(input);
  const at = index => `2026-08-${String(10 + index).padStart(2, '0')}T08:00:00.000Z`;
  for (let index = 0; index < 10; index += 1) {
    const ordinal = index + 1;
    const requestNo = `REQ-RUN-${String(ordinal).padStart(2, '0')}`;
    const sampleId = `${requestNo}.001`;
    const recordId = `REC-RUN-${String(ordinal).padStart(2, '0')}`;
    const channel = state.channels[index];
    state.requests.push({ id: requestNo, qty: 1, status: 'assigned', project: `普通项目 ${ordinal}`, test: '循环测试', sample: '35Ah' });
    state.samples.push({ id: sampleId, requestNo, ordinal: 1, status: 'running', channelKey: channel.key, start: at(index), end: '2026-09-30T08:00:00.000Z', hasHistory: true });
    state.records.push({
      id: recordId, requestNo, no: requestNo, sampleId, status: 'running', channelKey: channel.key,
      keys: [channel.key], project: `普通项目 ${ordinal}`, user: '测试员 A',
      start: at(index), end: '2026-09-30T08:00:00.000Z'
    });
    Object.assign(channel, {
      state: 'busy', project: `普通项目 ${ordinal}`, user: '测试员 A', requestNo,
      test: '循环测试', start: at(index), end: '2026-09-30T08:00:00.000Z',
      currentRecordId: recordId, nextRecordId: ''
    });
  }
  for (let index = 0; index < 10; index += 1) {
    const ordinal = index + 1;
    const requestNo = `REQ-STO-${String(ordinal).padStart(2, '0')}`;
    const sampleId = `${requestNo}.001`;
    state.requests.push({ id: requestNo, qty: 1, status: 'assigned', project: `存储项目 ${ordinal}`, test: '长期存储', sample: '35Ah' });
    state.samples.push({ id: sampleId, requestNo, ordinal: 1, status: 'storing', channelKey: '', start: at(index), end: '', hasHistory: true });
    state.storageRecords.push({
      id: `STO-ACTIVE-${String(ordinal).padStart(2, '0')}`, requestNo, sampleIds: [sampleId],
      tester: '测试员 B', status: 'storing', startedAt: at(index),
      expectedEndAt: '2026-09-30T08:00:00.000Z', endedAt: '', note: `存储备注 ${ordinal}`, returnReason: ''
    });
  }
  state.requests.push(
    { id: 'REQ-SELECT-A', qty: 2, status: 'partially_assigned', project: '选择项目 A', test: '循环测试', sample: '35Ah' },
    { id: 'REQ-SELECT-B', qty: 1, status: 'pending', project: '选择项目 B', test: '循环测试', sample: '35Ah' }
  );
  state.samples.push(
    { id: 'REQ-SELECT-A.001', requestNo: 'REQ-SELECT-A', ordinal: 1, status: 'pending', channelKey: '', start: '', end: '', hasHistory: false },
    { id: 'REQ-SELECT-A.002', requestNo: 'REQ-SELECT-A', ordinal: 2, status: 'completed', channelKey: '', start: '', end: '', hasHistory: true },
    { id: 'REQ-SELECT-B.001', requestNo: 'REQ-SELECT-B', ordinal: 1, status: 'pending', channelKey: '', start: '', end: '', hasHistory: false }
  );
  return state;
}

test('installed Edge opens the real MAIN page through the SQLite test host', async () => {
  const runRoot = await mkdtemp(path.join(os.tmpdir(), 'edge-main-page-'));
  const dataRoot = path.join(runRoot, 'work', 'data');
  const outputRoot = path.join(runRoot, 'work', 'outputs');
  await Promise.all([mkdir(dataRoot, { recursive: true }), mkdir(outputRoot, { recursive: true })]);
  await copyFile(baselineFixture, path.join(dataRoot, 'battery-channel-hub.sqlite'));
  const pathGuard = createPathGuard({ projectRoot, runRoot, protectedPaths: [baselineFixture] });
  const harness = await createApplicationHarness({
    projectRoot,
    runRoot,
    dataRoot,
    outputRoot,
    pathGuard,
    dialogQueue: { open: [], save: [] },
    clock: () => new Date('2026-08-22T09:00:00.000Z')
  });
  await harness.saveState(populatedWorkbenchState(await harness.loadState()));
  const run = { snapshot: () => ({ runId: 'edge-main-page', scenarios: [] }), requestStop: () => ({ ok: true }) };
  const token = 'main-page-secret';
  const host = await startTestHost({ projectRoot, run, harness, token });
  const edge = await createEdgeDriver({
    origin: host.origin,
    token,
    runRoot,
    viewport: { width: 1366, height: 768 }
  });
  try {
    const result = await edge.run('real-main-baseline', async ({ page }) => {
      page.setDefaultTimeout(5_000);
      await page.goto(`${host.origin}/app/`);
      await page.locator('#username').fill('edge-runner');
      await page.locator('#login .btn.wide').click();
      await page.waitForFunction(() => globalThis.__batteryAppReady === true);
      const sampleViewports = [];
      for (const viewport of [
        { width: 1366, height: 768 },
        { width: 1440, height: 900 },
        { width: 1536, height: 864 }
      ]) {
        await page.setViewportSize(viewport);
        for (const pageId of ['runningSamples', 'storageSamples']) {
          await page.locator(`button.nav[data-page="${pageId}"]`).click();
          sampleViewports.push(await page.evaluate(({ viewport, pageId }) => {
            const root = document.getElementById(`${pageId}Table`);
            const container = root?.querySelector('.sample-workbench-table');
            const rowSelector = pageId === 'runningSamples' ? '[data-testid="running-sample-row"]' : '[data-testid="storage-sample-row"]';
            const actions = [...(root?.querySelectorAll('tbody [data-sample-action]') || [])]
              .filter(button => button.getClientRects().length > 0)
              .map(button => {
                const style = getComputedStyle(button);
                return {
                  disabled: button.disabled,
                  tabIndex: button.tabIndex,
                  pointerEvents: style.pointerEvents,
                  visible: style.visibility !== 'hidden' && style.display !== 'none'
                };
              });
            return {
              viewport,
              pageId,
              rows: root?.querySelectorAll(rowSelector).length || 0,
              documentOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
              containerOverflow: (container?.scrollWidth || 0) - (container?.clientWidth || 0),
              containerOverflowX: container ? getComputedStyle(container).overflowX : '',
              actionCount: actions.length,
              actionsUsable: actions.every(action => !action.disabled && action.tabIndex >= 0 && action.pointerEvents !== 'none' && action.visible)
            };
          }, { viewport, pageId }));
        }
      }
      await page.locator('button.nav[data-page="apply"]').click();
      const search = page.locator('[data-legacy-action="search-requests"]');
      await search.fill('REQ-SELECT-A');
      await page.locator('[data-legacy-action="select-request"]').click();
      await page.locator('[data-sample-action="storage-mode-toggle"]').check();
      const firstRequestSelectors = await page.locator('[data-sample-action="storage-sample-toggle"]').count();
      await page.locator('[data-sample-action="storage-sample-toggle"]').first().click();
      await search.fill('REQ-SELECT-B');
      await page.locator('[data-legacy-action="select-request"]').click();
      const secondRequestSelector = page.locator('[data-sample-action="storage-sample-toggle"]');
      const secondRequestSelectedBeforeClick = await secondRequestSelector.getAttribute('class');
      await secondRequestSelector.click();
      await page.locator('[data-legacy-action="end-time"]').fill('2026-09-30T10:00');
      await page.locator('[data-sample-action="storage-start"]').click();
      await page.waitForFunction(() => window.getLegacyBoundedState().storageRecords
        .some(record => record.requestNo === 'REQ-SELECT-B'));
      const storedSampleIds = await page.evaluate(() => window.getLegacyBoundedState().storageRecords
        .find(record => record.requestNo === 'REQ-SELECT-B')?.sampleIds || []);
      return {
        adapter: await page.evaluate(() => window.batteryDesktop?.isTestEnvironment === true),
        navigation: await page.locator('button.nav[data-page]').count(),
        devices: await page.locator('[data-testid="bounded-board-device"]').count(),
        channelCards: await page.locator('[data-testid="bounded-channel-card"]').count(),
        horizontalOverflow: await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth),
        sampleViewports,
        storageSelection: {
          firstRequestSelectors,
          secondRequestSelectedBeforeClick,
          sampleIds: storedSampleIds
        }
      };
    });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.deepEqual(result.value, {
      adapter: true,
      navigation: 10,
      devices: 26,
      channelCards: 0,
      horizontalOverflow: 0,
      sampleViewports: [
        { width: 1366, height: 768 },
        { width: 1440, height: 900 },
        { width: 1536, height: 864 }
      ].flatMap(viewport => ['runningSamples', 'storageSamples'].map(pageId => ({
        viewport, pageId, rows: 10, documentOverflow: 0, containerOverflow: 0,
        containerOverflowX: 'visible', actionCount: pageId === 'runningSamples' ? 20 : 30,
        actionsUsable: true
      }))),
      storageSelection: {
        firstRequestSelectors: 1,
        secondRequestSelectedBeforeClick: 'legacy-storage-select',
        sampleIds: ['REQ-SELECT-B.001']
      }
    });
    assert.deepEqual(result.consoleErrors, []);
    const sqlite = await harness.inspectSqlite();
    assert.equal(sqlite.integrity, 'ok');
    assert.equal(sqlite.counts.devices, 26);
    assert.equal(sqlite.counts.channels, 529);
  } finally {
    await edge.close();
    await host.close();
    await harness.close();
  }
});
