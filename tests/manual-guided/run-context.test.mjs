import assert from 'node:assert/strict';
import { readFile, rm, stat, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { REQUIRED_STYLE_FILES } from './manual-contract.mjs';
import { createManualGuidedRunContext } from './run-context.mjs';

const projectRoot = path.resolve(import.meta.dirname, '..', '..');

async function inputFixture(name) {
  const root = path.join(projectRoot, '自动测试报告', 'manual-input-' + process.pid + '-' + name);
  const stylesRoot = path.join(root, '文件样式');
  const manualPath = path.join(root, '01-软件使用说明.md');
  const executablePath = path.join(root, '电池测试通道预约与使用看板.exe');
  await mkdir(stylesRoot, { recursive: true });
  await writeFile(manualPath, '# 使用说明\n', 'utf8');
  await writeFile(executablePath, 'packaged executable fixture\n', 'utf8');
  for (const styleName of REQUIRED_STYLE_FILES) {
    await writeFile(path.join(stylesRoot, styleName), 'style:' + styleName + '\n', 'utf8');
  }
  return { root, stylesRoot, manualPath, executablePath };
}

test('manual-guided context owns exact report paths and detects protected changes', async (t) => {
  const fixture = await inputFixture('paths');
  const context = await createManualGuidedRunContext({
    projectRoot,
    mode: 'quick',
    executablePath: fixture.executablePath,
    manualPath: fixture.manualPath,
    stylesRoot: fixture.stylesRoot,
    now: () => new Date('2026-09-01T10:00:00.000Z'),
    randomBytes: () => Buffer.from('01020304', 'hex')
  });
  t.after(async () => {
    await rm(context.runRoot, { recursive: true, force: true });
    await rm(fixture.root, { recursive: true, force: true });
  });

  assert.match(context.runRoot, /自动测试报告[\\/]manual-guided[\\/]20260901T100000000Z-01020304$/);
  assert.equal(context.dataRoot, path.join(context.profileRoot, 'data'));
  assert.equal(
    await context.assertWritable(path.join(context.generatedDataRoot, 'valid.xlsx')),
    path.join(context.generatedDataRoot, 'valid.xlsx')
  );
  await assert.rejects(
    context.assertWritable(path.join(projectRoot, 'escape.xlsx')),
    error => error.code === 'RUN_ROOT_ESCAPE'
  );
  assert.match(context.executable.sha256, /^[a-f0-9]{64}$/);
  assert.equal(context.manualContract.styleFiles.length, 10);

  await writeFile(path.join(fixture.stylesRoot, REQUIRED_STYLE_FILES[0]), 'changed\n', 'utf8');
  const verification = await context.verifyProtected();
  assert.equal(verification.ok, false);
  assert.equal(verification.changed.some(item => item.path.endsWith(REQUIRED_STYLE_FILES[0])), true);
});

test('successful cleanup removes only work/profile and preserves artifacts', async (t) => {
  const fixture = await inputFixture('cleanup');
  const context = await createManualGuidedRunContext({
    projectRoot,
    mode: 'full',
    executablePath: fixture.executablePath,
    manualPath: fixture.manualPath,
    stylesRoot: fixture.stylesRoot,
    now: () => new Date('2026-09-01T10:00:00.000Z'),
    randomBytes: () => Buffer.from('05060708', 'hex')
  });
  t.after(async () => {
    await rm(context.runRoot, { recursive: true, force: true });
    await rm(fixture.root, { recursive: true, force: true });
  });

  const generated = path.join(context.generatedDataRoot, 'input.csv');
  const evidence = path.join(context.artifactsRoot, 'result.json');
  await writeFile(generated, 'data\n', 'utf8');
  await writeFile(evidence, '{}\n', 'utf8');

  await context.cleanup({ success: true });

  await assert.rejects(stat(context.profileRoot), error => error.code === 'ENOENT');
  await assert.rejects(stat(context.workRoot), error => error.code === 'ENOENT');
  assert.equal(await readFile(evidence, 'utf8'), '{}\n');
});

test('manual-guided context rejects an existing non-EXE entry point', async (t) => {
  const fixture = await inputFixture('non-exe');
  const nonExecutable = path.join(fixture.root, 'candidate.bin');
  await writeFile(nonExecutable, 'not an executable\n', 'utf8');
  t.after(() => rm(fixture.root, { recursive: true, force: true }));

  await assert.rejects(
    createManualGuidedRunContext({
      projectRoot,
      mode: 'quick',
      executablePath: nonExecutable,
      manualPath: fixture.manualPath,
      stylesRoot: fixture.stylesRoot
    }),
    /executablePath must be an \.exe/i
  );
});
