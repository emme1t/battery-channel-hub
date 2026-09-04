import assert from 'node:assert/strict';
import { readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { createWorkflowRunContext } from './run-context.mjs';

const projectRoot = path.resolve(import.meta.dirname, '..', '..');

test('运行上下文只允许在 workflow run root 写入，并能发现受保护文件变更', async (t) => {
  const runId = '20260822T080000000Z-01020304';
  const plannedRunRoot = path.join(projectRoot, '自动测试报告', 'workflows', runId);
  const protectedSqlite = path.join(plannedRunRoot, 'work', 'data', 'protected.sqlite');
  const context = await createWorkflowRunContext({
    projectRoot,
    mode: 'quick',
    protectedPaths: [protectedSqlite],
    now: () => new Date('2026-08-22T08:00:00.000Z'),
    randomBytes: () => Buffer.from('01020304', 'hex')
  });
  t.after(() => rm(context.runRoot, { recursive: true, force: true }));

  assert.match(context.runRoot, /自动测试报告[\\/]workflows[\\/]20260822T080000000Z-01020304$/);
  assert.equal(await context.assertWritable(path.join(context.dataRoot, 'fixture.json')), path.join(context.dataRoot, 'fixture.json'));
  await assert.rejects(
    context.assertWritable(path.join(projectRoot, 'escape.txt')),
    error => error.code === 'RUN_ROOT_ESCAPE'
  );
  await writeFile(protectedSqlite, 'changed', 'utf8');
  const verification = await context.verifyProtected();
  assert.equal(verification.ok, false);
  assert.equal(verification.changed[0].path, path.resolve(protectedSqlite));
});

test('成功清理只删除当前 run 的 work 和 profiles，保留报告与失败证据目录', async (t) => {
  const context = await createWorkflowRunContext({
    projectRoot,
    mode: 'quick',
    now: () => new Date('2026-08-22T08:00:00.000Z'),
    randomBytes: () => Buffer.from('05060708', 'hex')
  });
  t.after(() => rm(context.runRoot, { recursive: true, force: true }));
  await writeFile(path.join(context.exportsRoot, 'result.txt'), 'temporary', 'utf8');
  await writeFile(path.join(context.screenshotsRoot, 'failure.png'), 'evidence', 'utf8');
  await writeFile(path.join(context.tracesRoot, 'failure.zip'), 'trace', 'utf8');
  await writeFile(path.join(context.artifactsRoot, 'report.json'), 'report', 'utf8');

  await context.cleanup({ success: true });

  await assert.rejects(stat(context.dataRoot), error => error.code === 'ENOENT');
  await assert.rejects(stat(context.profileRoot), error => error.code === 'ENOENT');
  assert.equal(await readFile(path.join(context.screenshotsRoot, 'failure.png'), 'utf8'), 'evidence');
  assert.equal(await readFile(path.join(context.tracesRoot, 'failure.zip'), 'utf8'), 'trace');
  assert.equal(await readFile(path.join(context.artifactsRoot, 'report.json'), 'utf8'), 'report');
});
