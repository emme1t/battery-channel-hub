import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const guardModule = await import('../scripts/edge-regression/path-guard.mjs').catch(() => ({}));
const contextModule = await import('../scripts/edge-regression/run-context.mjs').catch(() => ({}));
const runModule = await import('../scripts/edge-regression/run.mjs').catch(() => ({}));

test('path guard module exports the required API', () => {
  assert.equal(typeof guardModule.createPathGuard, 'function');
  assert.equal(typeof contextModule.createRunContext, 'function');
});

test('write guard permits only real descendants of the run root', async t => {
  assert.equal(typeof guardModule.createPathGuard, 'function');
  const root = await mkdtemp(path.join(os.tmpdir(), 'edge-guard-'));
  const runRoot = path.join(root, 'reports', 'run-1');
  const protectedFile = path.join(root, 'fixtures', 'master.sqlite');
  const outside = path.join(root, 'outside');
  await mkdir(runRoot, { recursive: true });
  await mkdir(path.dirname(protectedFile), { recursive: true });
  await mkdir(outside, { recursive: true });
  await writeFile(protectedFile, 'fixture');

  const guard = guardModule.createPathGuard({
    projectRoot: root,
    runRoot,
    protectedPaths: [protectedFile]
  });
  const allowed = path.join(runRoot, 'sqlite', 'case.sqlite');
  assert.equal(await guard.assertWritable(allowed), path.resolve(allowed));
  await assert.rejects(guard.assertWritable(protectedFile), { code: 'PROTECTED_PATH_WRITE' });
  await assert.rejects(guard.assertWritable(path.join(runRoot, '..', 'escape.txt')), { code: 'RUN_ROOT_ESCAPE' });

  const junction = path.join(runRoot, 'outside-link');
  try {
    await symlink(outside, junction, process.platform === 'win32' ? 'junction' : 'dir');
  } catch (error) {
    if (['EPERM', 'EACCES', 'UNKNOWN'].includes(error.code)) {
      t.skip(`当前环境不能创建链接：${error.code}`);
      return;
    }
    throw error;
  }
  await assert.rejects(guard.assertWritable(path.join(junction, 'escaped.txt')), { code: 'RUN_ROOT_ESCAPE' });
});

test('run context copies a fixture and detects later master mutation', async () => {
  assert.equal(typeof contextModule.createRunContext, 'function');
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), 'edge-context-'));
  const fixture = path.join(projectRoot, 'fixtures', 'master.sqlite');
  await mkdir(path.dirname(fixture), { recursive: true });
  await writeFile(fixture, 'protected-v1');

  const context = await contextModule.createRunContext({
    projectRoot,
    mode: 'quick',
    protectedPaths: [fixture],
    now: () => new Date('2026-08-22T01:02:03.000Z'),
    randomBytes: () => Buffer.from('a1b2c3d4', 'hex')
  });
  const copied = await context.copyFixture(fixture, 'sqlite/copy.sqlite');
  assert.equal(await readFile(copied, 'utf8'), 'protected-v1');
  assert.deepEqual(await context.verifyProtected(), { ok: true, files: context.protectedSnapshot });

  await writeFile(fixture, 'protected-v2');
  const report = await context.verifyProtected();
  assert.equal(report.ok, false);
  assert.equal(report.changed.length, 1);
  assert.equal(report.changed[0].path, path.resolve(fixture));
});

test('successful cleanup removes only current run work files', async () => {
  assert.equal(typeof contextModule.createRunContext, 'function');
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), 'edge-cleanup-'));
  const context = await contextModule.createRunContext({
    projectRoot,
    mode: 'quick',
    now: () => new Date('2026-08-22T01:02:03.000Z'),
    randomBytes: () => Buffer.from('01020304', 'hex')
  });
  const sibling = path.join(context.reportsRoot, 'sibling-run', 'keep.txt');
  await mkdir(path.dirname(sibling), { recursive: true });
  await writeFile(sibling, 'keep');
  await writeFile(path.join(context.workRoot, 'temporary.txt'), 'remove');
  await writeFile(path.join(context.artifactsRoot, 'result.txt'), 'keep');

  await context.cleanup({ success: true });

  await assert.rejects(readFile(path.join(context.workRoot, 'temporary.txt')), { code: 'ENOENT' });
  assert.equal(await readFile(path.join(context.artifactsRoot, 'result.txt'), 'utf8'), 'keep');
  assert.equal(await readFile(sibling, 'utf8'), 'keep');
});

test('Edge run context accepts only the fixed edge-full report root below a workflow run', async () => {
  assert.equal(typeof contextModule.createRunContext, 'function');
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), 'edge-workflow-root-'));
  const workflowRunRoot = path.join(projectRoot, '自动测试报告', 'workflows', '20260822T080000000Z-01020304');
  const reportRootOverride = path.join(workflowRunRoot, 'edge-full');
  const context = await contextModule.createRunContext({
    projectRoot,
    mode: 'full',
    reportRootOverride,
    now: () => new Date('2026-08-22T01:02:03.000Z'),
    randomBytes: () => Buffer.from('a1b2c3d4', 'hex')
  });
  assert.equal(context.reportsRoot, path.resolve(reportRootOverride));
  assert.equal(context.runRoot, path.join(path.resolve(reportRootOverride), '20260822T010203000Z-a1b2c3d4'));
});

test('Edge report-root override rejects external, workflow-root-equal and arbitrary nested roots', async () => {
  assert.equal(typeof contextModule.createRunContext, 'function');
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), 'edge-workflow-root-guard-'));
  const workflowRoot = path.join(projectRoot, '自动测试报告', 'workflows');
  const invalid = [
    path.join(projectRoot, 'outside'),
    workflowRoot,
    path.join(workflowRoot, 'workflow-run-1'),
    path.join(workflowRoot, 'workflow-run-1', 'arbitrary'),
    path.join(workflowRoot, 'workflow-run-1', 'edge-full'),
    path.join(workflowRoot, '..', 'escape', 'edge-full')
  ];
  for (const reportRootOverride of invalid) {
    await assert.rejects(
      contextModule.createRunContext({ projectRoot, mode: 'full', reportRootOverride }),
      error => error?.code === 'EDGE_REPORT_ROOT_INVALID'
    );
  }
});

test('Edge standalone no-override keeps the legacy reports root and run-root layout', async () => {
  assert.equal(typeof contextModule.createRunContext, 'function');
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), 'edge-standalone-root-'));
  const context = await contextModule.createRunContext({
    projectRoot,
    mode: 'quick',
    now: () => new Date('2026-08-22T01:02:03.000Z'),
    randomBytes: () => Buffer.from('01020304', 'hex')
  });
  assert.equal(context.reportsRoot, path.join(path.resolve(projectRoot), '自动测试报告'));
  assert.equal(context.runRoot, path.join(context.reportsRoot, '20260822T010203000Z-01020304'));
});

test('Edge CLI passes a validated --report-root override without accepting duplicate or missing values', () => {
  assert.equal(typeof runModule.parseEdgeArgs, 'function');
  const root = path.resolve('自动测试报告', 'workflows', '20260822T080000000Z-01020304', 'edge-full');
  assert.deepEqual(runModule.parseEdgeArgs(['--mode', 'full', '--report-root', root]), {
    mode: 'full', only: [], headed: false, keepWorkdir: false, reportRootOverride: root
  });
  assert.throws(() => runModule.parseEdgeArgs(['--mode', 'full', '--report-root']), /report-root/i);
  assert.throws(() => runModule.parseEdgeArgs(['--mode', 'full', '--report-root', root, '--report-root', root]), /report-root/i);
});
