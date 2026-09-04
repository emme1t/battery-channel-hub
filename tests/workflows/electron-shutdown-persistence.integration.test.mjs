import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { createWorkflowElectronDriver } from './electron-driver.mjs';
import { seedWorkflowFixture } from './fixtures.mjs';
import { createWorkflowRunContext } from './run-context.mjs';
import { readWorkflowSnapshot } from './state-probe.mjs';

const projectRoot = path.resolve(import.meta.dirname, '..', '..');
const fixedClock = () => new Date('2026-08-27T00:00:00.000Z');

async function enterAndSettle(driver, actor) {
  const page = driver.page();
  await page.locator('#username').fill(actor);
  await page.locator('#login .btn.wide').click();
  await page.waitForFunction(() => window.__batteryAppReady === true);
  return driver.waitForPersistenceBarrier({ auditAction: '登录看板', actor, timeoutMs: 5_000 });
}

test('Electron 重启先完成 renderer 退出保存再关闭 SQLite store', { timeout: 60_000 }, async t => {
  const runContext = await createWorkflowRunContext({
    projectRoot,
    mode: 'electron-shutdown-persistence',
    now: fixedClock,
    randomBytes: () => Buffer.from([0x53, 0x54, 0x4f, 0x50])
  });
  await seedWorkflowFixture({ dataRoot: runContext.dataRoot, kind: 'baseline', clock: fixedClock });
  const driver = createWorkflowElectronDriver({
    projectRoot,
    dataRoot: runContext.dataRoot,
    profileRoot: path.join(runContext.profileRoot, 'restart-race'),
    viewport: '1366x768',
    timeoutMs: 25_000
  });
  t.after(async () => {
    await driver.close().catch(() => undefined);
    await rm(runContext.runRoot, { recursive: true, force: true });
  });

  await driver.start();
  await enterAndSettle(driver, 'WF tester');
  await driver.restart();
  await enterAndSettle(driver, 'WF tester');

  const diagnostics = await driver.uiProjection();
  const shutdownErrors = [
    ...diagnostics.consoleErrors,
    ...diagnostics.unhandledRejections,
    ...diagnostics.mainProcessErrors
  ].filter(message => /state:save|reading 'save'|store/i.test(message));
  assert.deepEqual(shutdownErrors, []);
  const persisted = readWorkflowSnapshot({ dataRoot: runContext.dataRoot });
  assert.equal(
    persisted.state.auditLogs.filter(item => item.action === '登录看板' && (item.user ?? item.actor) === 'WF tester').length,
    2
  );
});
