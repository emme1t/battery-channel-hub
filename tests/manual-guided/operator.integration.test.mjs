import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import { createWorkflowElectronDriver } from '../workflows/electron-driver.mjs';
import { createManualOperator } from './operator.mjs';
import { createManualGuidedRunContext } from './run-context.mjs';

const projectRoot = path.resolve(import.meta.dirname, '..', '..');
const executablePath = path.join(projectRoot, 'dist', 'win-unpacked', '电池测试通道预约与使用看板.exe');
const manualPath = 'C:\\Users\\ASUS\\Desktop\\使用说明\\01-软件使用说明.md';
const stylesRoot = 'C:\\Users\\ASUS\\Desktop\\使用说明\\文件样式';
const actor = '虚构测试工程师-Task4';

test('packaged Electron rejects blank login and recovers through visible navigation and restart', { timeout: 120_000 }, async (t) => {
  const runContext = await createManualGuidedRunContext({
    projectRoot,
    mode: 'quick',
    executablePath,
    manualPath,
    stylesRoot
  });
  const driver = createWorkflowElectronDriver({
    projectRoot,
    dataRoot: runContext.dataRoot,
    profileRoot: runContext.profileRoot,
    reportNamespace: 'manual-guided',
    viewport: '1366x768',
    timeoutMs: 30_000,
    packaged: true,
    executablePath
  });
  const operator = createManualOperator({ driver, actor, timeoutMs: 15_000 });
  let passed = false;
  t.after(async () => {
    await driver.close().catch(() => undefined);
    await runContext.cleanup({ success: passed });
  });

  await driver.start();
  assert.match(await driver.page().title(), /电池测试通道预约与使用看板/);

  const empty = await operator.login({ id: 'A01-empty', username: '' });
  assert.equal(empty.outcome, 'rejected');
  assert.match(empty.visibleMessage, /请输入实际操作用户名/);

  const spaces = await operator.login({ id: 'A01-spaces', username: '   ' });
  assert.equal(spaces.outcome, 'rejected');
  assert.match(spaces.visibleMessage, /请输入实际操作用户名/);

  const login = await operator.login({ id: 'A01-valid', username: actor });
  assert.equal(login.outcome, 'success');
  assert.equal(login.visiblePage, '通道看板');
  assert.match(login.visibleMessage, new RegExp(actor));
  assert.equal(
    await driver.page().getByText('请输入实际操作用户名', { exact: true }).isVisible(),
    false,
    'successful recovery must not return while the previous rejection toast is still visible'
  );

  const devices = await operator.navigate({ id: 'A01-devices', label: '设备与通道' });
  assert.equal(devices.outcome, 'success');
  assert.equal(devices.visiblePage, '设备与通道');

  const restarted = await operator.restart({ id: 'A01-restart' });
  assert.equal(restarted.outcome, 'success');
  assert.equal(restarted.visiblePage, '登录');
  assert.match(await driver.page().title(), /电池测试通道预约与使用看板/);

  const relogin = await operator.login({ id: 'A01-relogin', username: actor });
  assert.equal(relogin.outcome, 'success');
  assert.equal(relogin.visiblePage, '通道看板');
  assert.equal((await runContext.verifyProtected()).ok, true);
  passed = true;
});
