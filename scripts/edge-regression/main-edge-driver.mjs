import { createHash, randomBytes } from 'node:crypto';
import { copyFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

import { createApplicationHarness } from './application-harness.mjs';
import { createEdgeDriver } from './edge-driver.mjs';
import { createPathGuard } from './path-guard.mjs';
import { startTestHost } from './test-host.mjs';

const FIXTURES = Object.freeze({
  A01: ['人工回归数据包', 'v0.4.2', 'SQLite', '01-26设备529通道空基线.sqlite'],
  A02: ['人工回归数据包', 'v0.4.2', 'SQLite', '02-事务与状态迁移.sqlite'],
  A03: ['人工回归数据包', 'v0.4.2', 'SQLite', '03-100申请999子样品2000日志审计.sqlite'],
  A04: ['人工回归数据包', 'v0.4.3', 'SQLite', '04-及时率筛选与预约待办.sqlite']
});

const DEFAULT_FIXTURE = Object.freeze({
  'mounted-import-refresh': 'A03',
  'reservation-editable-fields': 'A02',
  'mounted-management-refresh': 'A02'
});

export const REQUIRED_NAVIGATION_PAGE_IDS = Object.freeze([
  'dashboard', 'timeliness', 'apply', 'runningSamples', 'storageSamples',
  'reserved', 'requests', 'records', 'testers', 'devices'
]);

function assertion(condition, message, details = undefined) {
  if (condition) return;
  const error = new Error(message);
  error.code = 'EDGE_ASSERTION_FAILED';
  error.details = details;
  throw error;
}

async function login(page, origin) {
  await page.goto(`${origin}/app/`);
  await page.locator('#username').fill('edge-runner');
  await page.locator('#login .btn.wide').click();
  await page.waitForFunction(() => globalThis.__batteryAppReady === true);
  assertion(await page.evaluate(() => window.batteryDesktop?.isTestEnvironment === true), '页面未使用隔离测试适配器');
}

async function navigate(page, id) {
  await page.locator(`button.nav[data-page="${id}"]`).click();
  await page.locator(`#${id}.page.active`).waitFor();
}

async function openReservation(page) {
  await navigate(page, 'apply');
  await page.locator('[data-testid="legacy-reservation-workspace"]').waitFor();
}

async function selectFirstRequest(page) {
  await openReservation(page);
  const button = page.locator('[data-legacy-action="select-request"]').first();
  assertion(await button.count() === 1, '测试数据没有可选择的申请');
  await button.click();
  await page.locator('[data-testid="legacy-reservation-details"]').waitFor();
}

async function noOverflow(page) {
  return page.evaluate(() => Math.max(0, document.documentElement.scrollWidth - document.documentElement.clientWidth));
}

async function mountedRefresh({ page }) {
  await selectFirstRequest(page);
  const before = await page.evaluate(() => window.__legacyReservationWorkspace.getState().revision);
  await page.evaluate(() => window.mountLegacyReservationWorkspaceApp());
  const after = await page.evaluate(() => window.__legacyReservationWorkspace.getState().revision);
  assertion(after === before, '重新挂载未采用主进程返回的同一 revision', { before, after });
  return { before, after };
}

async function editableFields({ page }) {
  await selectFirstRequest(page);
  await page.locator('[data-legacy-action="mode"][value="start"]').check();
  await page.locator('[data-legacy-action="end-time"]').fill('2026-08-23T12:30');
  await page.locator('[data-legacy-action="note"]').fill('中文备注-顺序正确');
  const values = await page.evaluate(() => ({
    mode: document.querySelector('[data-legacy-action="mode"]:checked')?.value,
    end: document.querySelector('[data-legacy-action="end-time"]')?.value,
    note: document.querySelector('[data-legacy-action="note"]')?.value
  }));
  assertion(values.mode === 'start' && values.end === '2026-08-23T12:30' && values.note === '中文备注-顺序正确', '执行方式、时间或备注没有保持输入', values);
  return values;
}

async function navigationProbe({ page }) {
  const ids = await page.locator('button.nav[data-page]').evaluateAll(nodes => nodes.map(node => node.dataset.page));
  assertion(
    ids.length === REQUIRED_NAVIGATION_PAGE_IDS.length
      && ids.every((id, index) => id === REQUIRED_NAVIGATION_PAGE_IDS[index]),
    `左侧入口必须精确为 ${REQUIRED_NAVIGATION_PAGE_IDS.join(', ')}，实际 ${ids.join(', ')}`,
    ids
  );
  const visited = [];
  for (const id of REQUIRED_NAVIGATION_PAGE_IDS) {
    await navigate(page, id);
    visited.push(id);
  }
  return { ids, visited };
}

async function defaultLayout({ page }) {
  await openReservation(page);
  const result = await page.evaluate(() => ({
    details: document.querySelectorAll('[data-testid="legacy-reservation-details"]').length,
    open: document.querySelector('[data-testid="legacy-reservation-workspace"]')?.dataset.detailsOpen,
    listWidth: document.querySelector('.legacy-reservation-list')?.getBoundingClientRect().width || 0
  }));
  result.overflow = await noOverflow(page);
  assertion(result.details === 0 && result.open === 'false' && result.listWidth > 700 && result.overflow === 0, '默认预约布局不符合全宽列表约束', result);
  return result;
}

async function expandedLayout({ page }) {
  await selectFirstRequest(page);
  const result = await page.evaluate(() => {
    const workspace = document.querySelector('[data-testid="legacy-reservation-workspace"]');
    const list = document.querySelector('.legacy-reservation-list');
    const details = document.querySelector('.legacy-reservation-details');
    const scroll = document.querySelector('.legacy-details-scroll');
    const listBox = list?.getBoundingClientRect();
    const detailsBox = details?.getBoundingClientRect();
    return {
      open: workspace?.dataset.detailsOpen,
      listWidth: listBox?.width || 0,
      detailsWidth: detailsBox?.width || 0,
      separateColumns: Boolean(listBox && detailsBox && detailsBox.left >= listBox.right),
      detailsOverflowY: scroll ? getComputedStyle(scroll).overflowY : '',
      detailsScrollable: Boolean(scroll && scroll.scrollHeight > scroll.clientHeight)
    };
  });
  result.overflow = await noOverflow(page);
  assertion(result.open === 'true' && result.separateColumns && result.detailsWidth < result.listWidth, '展开详情不是非等宽双栏', result);
  assertion(result.detailsOverflowY === 'auto' && result.detailsScrollable, '详情栏没有独立滚动区域', result);
  assertion(result.overflow === 0, '展开详情产生横向溢出', result);
  return result;
}

async function closeReopen({ page }) {
  await openReservation(page);
  const search = page.locator('[data-legacy-action="search-requests"]');
  await search.fill('REQ');
  const select = page.locator('[data-legacy-action="select-request"]').first();
  if (await select.count() === 0) await search.fill('');
  await page.locator('[data-legacy-action="select-request"]').first().click();
  await page.locator('[data-legacy-action="close-details"]').first().click();
  assertion(await page.locator('[data-testid="legacy-reservation-details"]').count() === 0, '关闭详情后右栏仍存在');
  const retained = await page.locator('[data-legacy-action="search-requests"]').inputValue();
  await page.locator('[data-legacy-action="select-request"]').first().click();
  assertion(await page.locator('[data-testid="legacy-reservation-details"]').count() === 1, '无法重新打开详情');
  return { retained };
}

async function laptopViewports({ page }) {
  await selectFirstRequest(page);
  const result = { viewport: page.viewportSize(), overflow: await noOverflow(page) };
  assertion(result.overflow === 0, '笔记本视口产生横向溢出', result);
  return result;
}

async function channelSearch({ page }) {
  await navigate(page, 'devices');
  const input = page.locator('[data-bounded-filter="channels"]');
  const total = await page.locator('[data-testid="bounded-channel-row"]').count();
  await input.fill('新威');
  const chinese = await page.locator('[data-testid="bounded-channel-row"]').count();
  await input.fill('3-1');
  const number = await page.locator('[data-testid="bounded-channel-row"]').count();
  assertion(total > 0 && chinese > 0 && number > 0 && chinese <= 50 && number <= 50, '529 通道搜索结果异常', { total, chinese, number });
  return { total, chinese, number };
}

async function boardExpansion({ page }) {
  const before = await page.locator('[data-testid="bounded-channel-card"]').count();
  await page.locator('[data-bounded-action="toggle-device"]').first().click();
  const after = await page.locator('[data-testid="bounded-channel-card"]').count();
  await page.locator('[data-bounded-action="toggle-device"]').first().click();
  const closed = await page.locator('[data-testid="bounded-channel-card"]').count();
  assertion(before === 0 && after > 0 && after < 529 && closed === 0, '看板展开边界异常', { before, after, closed });
  return { before, after, closed };
}

async function requestPagination({ page }) {
  await openReservation(page);
  const firstRows = await page.locator('[data-testid="legacy-request-row"]').count();
  const next = page.locator('[data-legacy-action="request-next"]');
  assertion(firstRows > 0 && firstRows <= 50 && await next.isEnabled(), '申请分页测试数据不足', { firstRows });
  await next.click();
  const secondRows = await page.locator('[data-testid="legacy-request-row"]').count();
  assertion(secondRows > 0 && secondRows <= 50, '申请第二页超出 50 条边界', { secondRows });
  return { firstRows, secondRows };
}

async function logPagination({ page }) {
  await navigate(page, 'records');
  const recordRows = await page.locator('[data-testid="bounded-record-row"]').count();
  const auditRows = await page.locator('[data-testid="bounded-audit-row"]').count();
  const next = page.locator('[data-bounded-action="page"][data-view="records"][data-direction="next"]');
  assertion(recordRows > 0 && recordRows <= 50 && auditRows > 0 && auditRows <= 50 && await next.isEnabled(), '日志分页测试数据不足或越界', { recordRows, auditRows });
  await next.click();
  const secondRows = await page.locator('[data-testid="bounded-record-row"]').count();
  assertion(secondRows > 0 && secondRows <= 50, '日志第二页越界', { secondRows });
  return { recordRows, auditRows, secondRows };
}

async function keyboardFocus({ page }) {
  await navigate(page, 'devices');
  const input = page.locator('[data-bounded-filter="channels"]');
  await input.focus();
  await input.pressSequentially('3-1');
  await page.keyboard.press('Tab');
  const value = await input.inputValue();
  const active = await page.evaluate(() => document.activeElement?.tagName);
  assertion(value === '3-1' && active !== 'BODY', '键盘输入或焦点顺序异常', { value, active });
  return { value, active };
}

async function timeliness({ page }) {
  await navigate(page, 'timeliness');
  const result = {
    rate: await page.locator('#timelyRateNum').textContent(),
    known: await page.locator('#timelyKnown').textContent(),
    missing: await page.locator('#missingPlanCount').textContent(),
    dateControls: await page.locator('[data-timeliness-filter]').count(),
    exportButton: await page.locator('[data-timeliness-action="export-png"]').count()
  };
  assertion(result.rate === '50%' && result.known === '2' && result.missing === '1', '及时率基线不符合 50% / 2 / 1', result);
  return result;
}

async function timelinessDatePng(context) {
  const result = await timeliness(context);
  const { page } = context;
  const from = page.locator('[data-timeliness-filter="from"]');
  const to = page.locator('[data-timeliness-filter="to"]');
  const initial = { from: await from.inputValue(), to: await to.inputValue() };
  assertion(/^\d{4}-\d{2}-\d{2}$/.test(initial.from) && /^\d{4}-\d{2}-\d{2}$/.test(initial.to) && result.exportButton === 1, '及时率日期或 PNG 入口缺失', initial);
  return { ...result, ...initial };
}

async function dashboardFilters({ page }) {
  const before = await page.locator('[data-testid="bounded-board-device"]').count();
  await page.locator('[data-dashboard-filter="text"]').fill('新威');
  await page.locator('[data-dashboard-filter="state"]').selectOption('free');
  await page.locator('[data-dashboard-filter="max-current"]').fill('100');
  const summary = await page.locator('#dashboardFilterCount').textContent();
  const cards = await page.locator('[data-testid="bounded-channel-card"]').count();
  assertion(before === 26 && /显示 \d+ \/ 529 通道/.test(summary || '') && cards === 0, '看板组合筛选或折叠边界异常', { before, summary, cards });
  return { before, summary, cards };
}

async function reservationTodo({ page }) {
  const items = await page.locator('.dashboard-todo').count();
  const detail = page.locator('[data-dashboard-action="todo-detail"]').first();
  assertion(items > 0 && await detail.count() === 1, '预约待办基线没有可跳转项', { items });
  await detail.click();
  await page.locator('#reserved.page.active').waitFor();
  const focused = await page.locator('.reserved-focus').count();
  assertion(focused === 1, '预约待办未跳转到日志详情', { focused });
  return { items, focused };
}

async function fullChannelPagination({ page }) {
  await navigate(page, 'devices');
  const seen = new Set();
  let pages = 0;
  for (;;) {
    const values = await page.locator('[data-testid="bounded-channel-row"]').evaluateAll(rows => rows.map(row => `${row.children[0]?.textContent}|${row.children[1]?.textContent}`));
    values.forEach(value => seen.add(value));
    pages += 1;
    const next = page.locator('[data-bounded-action="page"][data-view="channels"][data-direction="next"]');
    if (!await next.isEnabled()) break;
    const outerBefore = await page.evaluate(() => window.scrollY);
    await next.click();
    const outerAfter = await page.evaluate(() => window.scrollY);
    assertion(Math.abs(outerAfter - outerBefore) <= 2, '通道翻页推动外层滚动', { pages, outerBefore, outerAfter });
    assertion(pages < 20, '通道分页超过安全页数');
  }
  assertion(seen.size === 529, `通道分页只覆盖 ${seen.size}/529`, { pages });
  return { channels: seen.size, pages };
}

async function imeInput({ page }) {
  await navigate(page, 'devices');
  const input = page.locator('[data-bounded-filter="channels"]');
  await input.evaluate(element => {
    element.focus();
    element.dispatchEvent(new CompositionEvent('compositionstart', { data: '' }));
    element.value = 'zhong';
    element.setSelectionRange(5, 5);
    element.dispatchEvent(new InputEvent('input', { data: 'zhong', inputType: 'insertCompositionText', isComposing: true, bubbles: true }));
    element.value = '中文';
    element.setSelectionRange(2, 2);
    element.dispatchEvent(new CompositionEvent('compositionend', { data: '中文', bubbles: true }));
  });
  const result = await input.evaluate(element => ({ value: element.value, start: element.selectionStart, end: element.selectionEnd, dir: getComputedStyle(element).direction }));
  assertion(result.value === '中文' && result.start === 2 && result.end === 2 && result.dir !== 'rtl', '中文组合输入或输入方向异常', result);
  return result;
}

async function runningManagement({ page }) {
  const toggles = page.locator('[data-bounded-action="toggle-device"]');
  let manage = page.locator('[data-bounded-action="manage-running"]').first();
  for (let index = 0; index < await toggles.count() && await manage.count() === 0; index += 1) {
    await toggles.nth(index).click();
    manage = page.locator('[data-bounded-action="manage-running"]').first();
  }
  assertion(await manage.count() === 1, '看板没有进行中测试管理入口');
  const cardText = await manage.locator('xpath=ancestor::*[@data-testid="bounded-channel-card"]').textContent();
  await manage.click();
  await page.locator('#devices.page.active').waitFor();
  const title = await page.locator('#channelEditorTitle').textContent();
  const locked = await page.locator('#cName').isDisabled();
  assertion(/管理进行中测试/.test(title || '') && locked && /REQ-/.test(cardText || ''), '进行中样品显示或管理锁定异常', { title, locked, cardText });
  return { title, locked, cardText };
}

async function longChineseTruncation({ page }) {
  await openReservation(page);
  const result = await page.evaluate(() => {
    const project = document.querySelector('.legacy-request-project strong');
    const action = document.querySelector('[data-legacy-action="select-request"]');
    const actionBox = action?.getBoundingClientRect();
    return {
      rows: document.querySelectorAll('[data-testid="legacy-request-row"]').length,
      projectTextLength: project?.textContent?.length || 0,
      projectOverflow: Boolean(project && project.scrollWidth >= project.clientWidth),
      projectEllipsis: project ? getComputedStyle(project).textOverflow : '',
      actionVisible: Boolean(actionBox && actionBox.left >= 0 && actionBox.right <= innerWidth && actionBox.top >= 0 && actionBox.bottom <= innerHeight),
      bodyTextHasStack: /(?:Error:|\bat\s+\w+.*:\d+:\d+)/.test(document.body.innerText)
    };
  });
  result.overflow = await noOverflow(page);
  assertion(result.rows > 0 && result.projectTextLength > 0 && result.projectEllipsis === 'ellipsis' && result.actionVisible && !result.bodyTextHasStack && result.overflow === 0, '长中文布局、按钮可见性或错误文本异常', result);
  return result;
}

async function emptyErrorStates({ page }) {
  const todoText = await page.locator('#reservationTodoList').textContent();
  await navigate(page, 'devices');
  const input = page.locator('[data-bounded-filter="channels"]');
  await input.fill('__NO_SUCH_CHANNEL__');
  const emptyText = await page.locator('#channelTable').textContent();
  const result = await page.evaluate(() => ({
    bodyTextHasStack: /(?:Error:|\bat\s+\w+.*:\d+:\d+)/.test(document.body.innerText),
    successToastVisible: Boolean(document.querySelector('.toast.success.show'))
  }));
  assertion(/暂无已预约待办/.test(todoText || '') && /没有匹配通道/.test(emptyText || '') && !result.bodyTextHasStack && !result.successToastVisible, '空状态或搜索无结果状态被误呈现', { todoText, emptyText, ...result });
  return { todoText, emptyText, ...result };
}

export const MAIN_EDGE_PROBES = Object.freeze({
  'mounted-import-refresh': mountedRefresh,
  'reservation-editable-fields': editableFields,
  'mounted-management-refresh': mountedRefresh,
  'eight-navigation': navigationProbe,
  'default-reservation-layout': defaultLayout,
  'expanded-reservation-layout': expandedLayout,
  'close-reopen-context': closeReopen,
  'laptop-viewports': laptopViewports,
  'channel-search': channelSearch,
  'board-expansion': boardExpansion,
  'request-pagination': requestPagination,
  'log-pagination': logPagination,
  'keyboard-focus': keyboardFocus,
  'timeliness-panel': timeliness,
  'timeliness-date-png': timelinessDatePng,
  'dashboard-filters': dashboardFilters,
  'reservation-todo': reservationTodo,
  'full-channel-pagination': fullChannelPagination,
  'ime-input': imeInput,
  'running-test-management': runningManagement,
  'long-chinese-truncation': longChineseTruncation,
  'empty-error-states': emptyErrorStates
});

export function createMainEdgeEvidenceDriver({ projectRoot, runRoot, timeoutMs = 45_000 }) {
  if (!projectRoot || !runRoot) throw new TypeError('projectRoot and runRoot are required');
  const resolvedProjectRoot = path.resolve(projectRoot);
  const resolvedRunRoot = path.resolve(runRoot);
  const cache = new Map();

  return Object.freeze({
    async runProbe(check, definition = {}) {
      const probe = MAIN_EDGE_PROBES[check.probe];
      if (!probe) throw Object.assign(new Error(`未实现 Edge probe: ${check.probe}`), { code: 'EDGE_PROBE_MISSING' });
      const fixtureKey = check.fixture || definition.fixtureKeys?.find(key => FIXTURES[key]) || DEFAULT_FIXTURE[check.probe] || 'A01';
      const fixtureParts = FIXTURES[fixtureKey];
      if (!fixtureParts) {
        return { ok: false, error: { code: 'FIXTURE_MISSING', message: `Edge probe 没有 SQLite fixture: ${fixtureKey}` } };
      }
      const viewport = check.viewport || { width: 1366, height: 768 };
      const cacheKey = JSON.stringify({ probe: check.probe, fixtureKey, viewport });
      if (cache.has(cacheKey)) return structuredClone(await cache.get(cacheKey));
      const operation = (async () => {
        const fixture = path.join(resolvedProjectRoot, ...fixtureParts);
        const probeId = createHash('sha256').update(cacheKey).digest('hex').slice(0, 12);
        const probeRoot = path.join(resolvedRunRoot, 'work', 'edge', `p-${probeId}`);
        const dataRoot = path.join(probeRoot, 'data');
        const outputRoot = path.join(probeRoot, 'outputs');
        await Promise.all([mkdir(dataRoot, { recursive: true }), mkdir(outputRoot, { recursive: true })]);
        try {
          await copyFile(fixture, path.join(dataRoot, 'battery-channel-hub.sqlite'));
        } catch (error) {
          if (error.code === 'ENOENT') return { ok: false, error: { code: 'FIXTURE_MISSING', message: `缺少 fixture ${fixture}` } };
          throw error;
        }
        const pathGuard = createPathGuard({ projectRoot: resolvedProjectRoot, runRoot: resolvedRunRoot, protectedPaths: [fixture] });
        const harness = await createApplicationHarness({
          projectRoot: resolvedProjectRoot,
          runRoot: resolvedRunRoot,
          dataRoot,
          outputRoot,
          pathGuard,
          dialogQueue: { open: [], save: [] },
          clock: () => new Date('2026-08-22T09:00:00.000Z')
        });
        const token = randomBytes(18).toString('hex');
        const run = { snapshot: () => ({ runId: path.basename(resolvedRunRoot), scenarios: [] }), requestStop: () => ({ ok: true }) };
        let host;
        let edge;
        try {
          host = await startTestHost({ projectRoot: resolvedProjectRoot, run, harness, token });
          edge = await createEdgeDriver({ origin: host.origin, token, runRoot: resolvedRunRoot, viewport, timeoutMs });
          const result = await edge.run(`${check.key}-${fixtureKey}-${viewport.width}x${viewport.height}`, async ({ page }) => {
            await login(page, host.origin);
            return probe({ page, harness, host, fixtureKey, viewport });
          });
          const sqlite = await harness.inspectSqlite();
          return {
            ok: result.ok && sqlite.integrity === 'ok',
            key: check.key,
            probe: check.probe,
            fixtureKey,
            summary: { value: result.value, sqlite, edgeVersion: edge.version },
            evidencePath: result.screenshotPath,
            evidencePaths: [result.screenshotPath, result.tracePath],
            error: result.ok && sqlite.integrity === 'ok'
              ? null
              : result.error || { code: 'SQLITE_INTEGRITY_FAILED', message: `SQLite integrity=${sqlite.integrity}` }
          };
        } catch (error) {
          return { ok: false, key: check.key, probe: check.probe, fixtureKey, error: { code: error.code || 'EDGE_PROBE_FAILED', message: error.message, details: error.details } };
        } finally {
          await edge?.close().catch(() => undefined);
          await host?.close().catch(() => undefined);
          await harness.close().catch(() => undefined);
        }
      })();
      cache.set(cacheKey, operation);
      return structuredClone(await operation);
    }
  });
}
