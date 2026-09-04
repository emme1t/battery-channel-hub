import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { runChaosActivity } from './chaos-planner.mjs';
import { createWorkflowElectronDriver } from './electron-driver.mjs';
import { seedWorkflowFixture } from './fixtures.mjs';
import { createWorkflowRunContext } from './run-context.mjs';
import { readWorkflowSnapshot } from './state-probe.mjs';

const projectRoot = path.resolve(import.meta.dirname, '..', '..');
const fixedClock = () => new Date('2026-08-27T00:00:00.000Z');

function authenticatedDriver({ runContext, role, profileRoot }) {
  const actor = 'Task 10 C01';
  const raw = createWorkflowElectronDriver({
    projectRoot,
    dataRoot: runContext.dataRoot,
    profileRoot,
    viewport: '1366x768',
    timeoutMs: 25_000
  });
  return {
    name: `C01-${role}`,
    async start() {
      await raw.start();
      const page = raw.page();
      await page.locator('#username').fill(actor);
      await page.locator('#login .btn.wide').click();
      await page.waitForFunction(() => window.__batteryAppReady === true);
      await raw.waitForPersistenceBarrier({ auditAction: '登录看板', actor, timeoutMs: 5_000 });
    },
    restart: () => raw.restart(),
    close: () => raw.close(),
    page: () => raw.page(),
    uiProjection: () => raw.uiProjection(),
    viewEvidence: view => raw.viewEvidence(view),
    capturePersistenceBoundary: options => raw.capturePersistenceBoundary(options),
    waitForPersistenceBarrier: options => raw.waitForPersistenceBarrier(options),
    screenshot: name => raw.screenshot(name)
  };
}

test('C01 quick seed 在隔离 run root 完成 200 个真实 Electron 只读混沌动作', { timeout: 360_000 }, async t => {
  const base = await createWorkflowRunContext({
    projectRoot,
    mode: 'task10-c01-quick-electron',
    now: fixedClock
  });
  if (process.env.CHAOS_KEEP_RUN_ROOT !== '1') {
    t.after(() => rm(base.runRoot, { recursive: true, force: true }));
  }
  const fixtureManifest = await seedWorkflowFixture({
    dataRoot: base.dataRoot,
    kind: 'production-529',
    workflowId: 'C01',
    clock: fixedClock
  });
  const seeded = readWorkflowSnapshot({ dataRoot: base.dataRoot });
  const runContext = Object.freeze({
    ...base,
    workflowId: 'C01',
    fixture: 'production-529',
    fixtureSha256: seeded.hash,
    fixtureManifest
  });
  const result = await runChaosActivity({
    activityId: 'C01',
    seed: 22001,
    runContext,
    driverFactory: input => authenticatedDriver(input),
    clock: fixedClock
  });

  assert.equal(result.status, 'passed', result.failure?.error?.stack || JSON.stringify(result.failure));
  assert.equal(result.plannedActions.length, 200);
  assert.equal(result.steps.length, 200);
  assert.equal(result.protection.status, 'passed');
  assert.equal(result.cleanup.status, 'closed');
  assert.equal(result.restart.cleanup.status, 'closed');
  assert.ok(result.plannedActions.every(action => action.id.startsWith('C01-22001-step-')));
  console.log(`TASK10_C01_RUN_ROOT=${runContext.runRoot}`);
});
