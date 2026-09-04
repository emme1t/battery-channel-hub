import { randomBytes } from 'node:crypto';
import { copyFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { createApplicationHarness } from './application-harness.mjs';
import { createEdgeDriver } from './edge-driver.mjs';
import { createPathGuard } from './path-guard.mjs';
import { runStability } from './stability-runner.mjs';
import { startTestHost } from './test-host.mjs';

function fail(code, message, details) {
  const error = new Error(message);
  error.code = code;
  error.details = details;
  return error;
}

async function login(page, origin) {
  await page.goto(`${origin}/app/`);
  await page.locator('#username').fill('edge-stability');
  await page.locator('#login .btn.wide').click();
  await page.waitForFunction(() => globalThis.__batteryAppReady === true);
}

async function listCycle(page, index) {
  const started = performance.now();
  const targets = ['dashboard', 'apply', 'devices', 'records', 'timeliness'];
  const target = targets[index % targets.length];
  await page.locator(`button.nav[data-page="${target}"]`).click();
  await page.locator(`#${target}.page.active`).waitFor();
  if (target === 'apply') {
    await page.locator('[data-testid="legacy-reservation-workspace"]').waitFor();
    const input = page.locator('[data-legacy-action="search-requests"]');
    await input.fill(index % 2 ? 'REQ' : '');
  }
  if (target === 'devices') {
    const input = page.locator('[data-bounded-filter="channels"]');
    await input.fill(index % 2 ? '新威' : '');
  }
  if (target === 'records') {
    const input = page.locator('[data-bounded-filter="records"]');
    await input.fill(index % 2 ? 'REQ' : '');
  }
  if (target === 'dashboard') {
    const input = page.locator('[data-dashboard-filter="text"]');
    await input.fill(index % 2 ? '新威' : '');
  }
  const responsive = await page.evaluate(() => ({
    ready: globalThis.__batteryAppReady === true,
    active: document.querySelector('.page.active')?.id,
    overflow: Math.max(0, document.documentElement.scrollWidth - document.documentElement.clientWidth)
  }));
  return {
    ok: responsive.ready && responsive.active === target && responsive.overflow === 0,
    latencyMs: Math.round((performance.now() - started) * 100) / 100,
    target,
    responsive
  };
}

async function stateCycle(page, index) {
  const started = performance.now();
  const result = await page.evaluate(async cycle => {
    const before = await window.batteryDesktop.loadState();
    const saved = await window.batteryDesktop.saveState({
      ...before,
      savedAt: new Date(Date.UTC(2026, 7, 22, 10, cycle, 0)).toISOString()
    });
    return { beforeRevision: before.revision, afterRevision: saved.revision };
  }, index);
  return {
    ok: result.afterRevision === result.beforeRevision + 1,
    latencyMs: Math.round((performance.now() - started) * 100) / 100,
    ...result
  };
}

function sameReopen(left, right) {
  return left.integrity === 'ok' && right.integrity === 'ok' &&
    left.revision === right.revision &&
    JSON.stringify(left.counts) === JSON.stringify(right.counts) &&
    JSON.stringify(left.collectionSha256) === JSON.stringify(right.collectionSha256);
}

export async function runContinuousEdgeStability({ projectRoot, runRoot, mode, headed = false }) {
  if (!projectRoot || !runRoot || !['quick', 'full'].includes(mode)) throw new TypeError('projectRoot, runRoot and quick/full mode are required');
  const resolvedProjectRoot = path.resolve(projectRoot);
  const resolvedRunRoot = path.resolve(runRoot);
  const fixture = path.join(resolvedProjectRoot, '人工回归数据包', 'v0.4.2', 'SQLite', '03-100申请999子样品2000日志审计.sqlite');
  const root = path.join(resolvedRunRoot, 'work', 'continuous-stability');
  const dataRoot = path.join(root, 'data');
  const outputRoot = path.join(root, 'outputs');
  await Promise.all([mkdir(dataRoot, { recursive: true }), mkdir(outputRoot, { recursive: true })]);
  await copyFile(fixture, path.join(dataRoot, 'battery-channel-hub.sqlite'));
  const pathGuard = createPathGuard({ projectRoot: resolvedProjectRoot, runRoot: resolvedRunRoot, protectedPaths: [fixture] });
  const harnessOptions = {
    projectRoot: resolvedProjectRoot,
    runRoot: resolvedRunRoot,
    dataRoot,
    outputRoot,
    pathGuard,
    dialogQueue: { open: [], save: [] },
    clock: () => new Date('2026-08-22T09:00:00.000Z')
  };
  let harness = await createApplicationHarness(harnessOptions);
  const initial = await harness.inspectSqlite();
  const token = randomBytes(18).toString('hex');
  const run = { snapshot: () => ({ runId: path.basename(resolvedRunRoot), scenarios: [] }), requestStop: () => ({ ok: true }) };
  let host;
  let edge;
  let edgeResult;
  try {
    host = await startTestHost({ projectRoot: resolvedProjectRoot, run, harness, token });
    edge = await createEdgeDriver({
      origin: host.origin,
      token,
      runRoot: resolvedRunRoot,
      viewport: { width: 1366, height: 768 },
      headed,
      timeoutMs: mode === 'full' ? 32 * 60_000 : 60_000
    });
    edgeResult = await edge.run(`ST-continuous-${mode}`, async ({ page }) => {
      await login(page, host.origin);
      const stability = await runStability({
        mode,
        runListCycle: index => listCycle(page, index),
        runStateCycle: index => stateCycle(page, index),
        restartCheck: async () => {
          const inspection = await harness.inspectSqlite();
          return { ok: inspection.integrity === 'ok', pendingIndependentReopen: true, inspection };
        },
        sampleProcessMemory: () => edge.sampleMemory()
      });
      const finalBeforeClose = await harness.inspectSqlite();
      return { stability, finalBeforeClose };
    });
    if (!edgeResult.ok) throw fail(edgeResult.error?.code || 'CONTINUOUS_EDGE_FAILED', edgeResult.error?.message || '连续 Edge 稳定性失败', edgeResult);
  } finally {
    await edge?.close().catch(() => undefined);
    await host?.close().catch(() => undefined);
    await harness.close().catch(() => undefined);
  }

  harness = await createApplicationHarness(harnessOptions);
  let reopened;
  try {
    reopened = await harness.inspectSqlite();
  } finally {
    await harness.close();
  }
  const finalBeforeClose = edgeResult.value.finalBeforeClose;
  const restartOk = sameReopen(finalBeforeClose, reopened);
  const stability = edgeResult.value.stability;
  stability.scenarios['ST-05'] = restartOk
    ? {
        status: 'PASS',
        assertions: [{ key: 'final-restart', ok: true, message: '关闭 Edge/宿主后独立重开 SQLite 一致' }],
        metrics: { beforeClose: finalBeforeClose, reopened },
        error: null
      }
    : {
        status: 'FAIL',
        assertions: [{ key: 'final-restart', ok: false, message: '独立重开 SQLite 与关闭前不一致' }],
        metrics: { beforeClose: finalBeforeClose, reopened },
        error: { code: 'STABILITY_REOPEN_MISMATCH', message: '独立重开 SQLite 与关闭前不一致' }
      };
  stability.fullGateSatisfied = mode === 'full' && Object.values(stability.scenarios).every(item => item.status === 'PASS');
  stability.restart = {
    ok: restartOk,
    revisionDelta: reopened.revision - initial.revision,
    initial,
    beforeClose: finalBeforeClose,
    reopened
  };
  stability.edgeEvidence = {
    screenshotPath: edgeResult.screenshotPath,
    tracePath: edgeResult.tracePath,
    consoleErrors: edgeResult.consoleErrors,
    pageErrors: edgeResult.pageErrors,
    networkViolations: edgeResult.networkViolations
  };
  const evidencePath = path.join(resolvedRunRoot, 'artifacts', 'stability.json');
  await mkdir(path.dirname(evidencePath), { recursive: true });
  await writeFile(evidencePath, `${JSON.stringify(stability, null, 2)}\n`, 'utf8');
  return { ...stability, evidencePath, evidencePaths: [evidencePath, edgeResult.screenshotPath, edgeResult.tracePath] };
}
