import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createWorkflowRunContext } from './workflows/run-context.mjs';
import * as visualSmoke from './smoke/main-visual-pages-smoke.mjs';
import {
  createVisualPagesSmokePlan,
  REQUIRED_EDITOR_IDS,
  VISUAL_ENTRY_REQUIRED_FIELDS,
  VISUAL_PAGE_MANIFEST
} from './smoke/main-visual-pages-smoke.mjs';

test('visual smoke protects the exact formal database and regression master files', async t => {
  assert.equal(typeof visualSmoke.createVisualProtectedPaths, 'function');
  const root = await mkdtemp(path.join(os.tmpdir(), 'battery-visual-protection-'));
  const projectRoot = path.join(root, 'project');
  const appDataRoot = path.join(root, 'AppData', 'Roaming');
  const formalDatabase = path.join(appDataRoot, 'battery-channel-hub', 'data', 'battery-channel-hub.sqlite');
  const masterFiles = [
    path.join(projectRoot, '人工回归数据包', 'v0.4.2', 'SQLite', '01-26设备529通道空基线.sqlite'),
    path.join(projectRoot, '人工回归数据包', 'v0.4.2', 'SQLite', '02-事务与状态迁移.sqlite'),
    path.join(projectRoot, '人工回归数据包', 'v0.4.2', 'SQLite', '03-100申请999子样品2000日志审计.sqlite'),
    path.join(projectRoot, '人工回归数据包', 'v0.4.3', 'SQLite', '04-及时率筛选与预约待办.sqlite'),
    path.join(projectRoot, 'tests', 'fixtures', 'v0.4.6-scenario-contract.md')
  ];
  for (const filePath of [formalDatabase, ...masterFiles]) {
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, `protected:${path.basename(filePath)}`, 'utf8');
  }
  t.after(() => rm(root, { recursive: true, force: true }));

  const protectedPaths = visualSmoke.createVisualProtectedPaths({ projectRoot, appDataRoot });
  assert.deepEqual(protectedPaths, [formalDatabase, ...masterFiles].map(item => path.resolve(item)));
  assert.ok(protectedPaths.length > 0);
  assert.equal(protectedPaths.includes(path.resolve(projectRoot)), false);
  assert.equal(protectedPaths.includes(path.resolve(appDataRoot)), false);

  const context = await createWorkflowRunContext({ projectRoot, mode: 'visual-protection-test', protectedPaths });
  await writeFile(formalDatabase, 'tampered-formal-database', 'utf8');
  const verification = await context.verifyProtected();
  assert.equal(verification.ok, false);
  assert.deepEqual(verification.changed, [{ path: path.resolve(formalDatabase) }]);
});

test('packaged visual plan seeds the fixture at the exact isolated profile data root', () => {
  const context = {
    runRoot: 'C:\\repo\\自动测试报告\\workflows\\20260828T010203Z-abcd1234',
    dataRoot: 'C:\\repo\\自动测试报告\\workflows\\20260828T010203Z-abcd1234\\work\\data',
    profileRoot: 'C:\\repo\\自动测试报告\\workflows\\20260828T010203Z-abcd1234\\profiles'
  };
  const executablePath = 'C:\\build\\电池测试通道预约与使用看板.exe';
  const plan = createVisualPagesSmokePlan({ context, packaged: true, executablePath });
  assert.deepEqual(plan, {
    dataRoot: 'C:\\repo\\自动测试报告\\workflows\\20260828T010203Z-abcd1234\\profiles\\visual-pages\\data',
    profileRoot: 'C:\\repo\\自动测试报告\\workflows\\20260828T010203Z-abcd1234\\profiles\\visual-pages',
    packaged: true,
    executablePath
  });
});

test('visual page manifest covers the required page and viewport matrix exactly', () => {
  const requiredPages = [
    'dashboard', 'timeliness', 'apply', 'runningSamples', 'storageSamples',
    'reserved', 'requests', 'records', 'testers', 'devices'
  ];
  const primary = VISUAL_PAGE_MANIFEST.filter(item => item.viewport === '1366x768');
  const wide = VISUAL_PAGE_MANIFEST.filter(item => item.viewport === '1440x900');

  assert.deepEqual(primary.map(item => item.pageId), requiredPages);
  assert.deepEqual(wide.map(item => item.pageId), [
    'apply', 'devices', 'records', 'timeliness', 'runningSamples', 'storageSamples'
  ]);
  assert.equal(VISUAL_PAGE_MANIFEST.length, 16);
  assert.ok(VISUAL_PAGE_MANIFEST.every(item => item.kind === 'main'));
});

test('visual manifest contract blocks ancestor scroll and clipped editor actions', () => {
  assert.deepEqual(REQUIRED_EDITOR_IDS, ['channelEditor', 'requestEditor', 'testerEditor', 'deviceEditor']);
  for (const field of [
    'scrollTop', 'scrollState', 'nonZeroScrollContainers', 'storageRowCount', 'editorVisible', 'editorFieldCount',
    'editorButtonCount', 'editorActionButtonsFullyVisible', 'editorActionButtonBounds', 'status'
  ]) {
    assert.ok(VISUAL_ENTRY_REQUIRED_FIELDS.includes(field), `missing required evidence field: ${field}`);
  }
});
