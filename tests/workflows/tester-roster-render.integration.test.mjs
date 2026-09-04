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

test('应用接管人员改名状态后立即刷新当前测试人员表', { timeout: 60_000 }, async t => {
  const runContext = await createWorkflowRunContext({
    projectRoot,
    mode: 'tester-roster-render',
    now: fixedClock,
    randomBytes: () => Buffer.from([0x54, 0x45, 0x53, 0x54])
  });
  await seedWorkflowFixture({
    dataRoot: runContext.dataRoot,
    kind: 'history',
    workflowId: 'D08',
    clock: fixedClock
  });
  const driver = createWorkflowElectronDriver({
    projectRoot,
    dataRoot: runContext.dataRoot,
    profileRoot: path.join(runContext.profileRoot, 'tester-roster-render'),
    viewport: '1366x768',
    timeoutMs: 25_000
  });
  t.after(async () => {
    await driver.close().catch(() => undefined);
    await rm(runContext.runRoot, { recursive: true, force: true });
  });

  await driver.start();
  const page = driver.page();
  await page.locator('#username').fill('WF tester');
  await page.locator('#login .btn.wide').click();
  await page.waitForFunction(() => window.__batteryAppReady === true);
  await driver.waitForPersistenceBarrier({ auditAction: '登录看板', actor: 'WF tester', timeoutMs: 5_000 });
  await page.locator('.nav[data-page="testers"]').click();
  await page.locator('#testers.active').waitFor({ state: 'visible' });

  await page.getByRole('row', { name: /WF tester/ }).getByRole('button', { name: '编辑', exact: true }).click();
  await page.locator('#testerEditor').getByLabel('姓名 *', { exact: true }).fill('D08 渲染回归测试员');
  await page.getByRole('button', { name: '保存测试人员', exact: true }).click();
  await driver.waitForPersistenceBarrier({
    auditAction: '修改测试人员',
    actor: 'WF tester',
    auditTarget: '测试人员 D08 渲染回归测试员',
    timeoutMs: 5_000
  });

  const persisted = readWorkflowSnapshot({ dataRoot: runContext.dataRoot });
  assert.equal(persisted.state.testers.some(item => item.name === 'D08 渲染回归测试员'), true);
  const renamedRow = page.getByRole('row', { name: /D08 渲染回归测试员/ });
  await renamedRow.waitFor({ state: 'visible', timeout: 5_000 });
  assert.match(await renamedRow.innerText(), /D08 渲染回归测试员/);
});
