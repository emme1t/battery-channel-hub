import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const cliModule = await import('./main-visual-pages-packaged-smoke.mjs').catch(() => ({}));

test('packaged visual CLI accepts exactly one existing absolute exe', async t => {
  assert.equal(typeof cliModule.parsePackagedVisualArgs, 'function');
  const root = await mkdtemp(path.join(os.tmpdir(), 'battery-packaged-visual-cli-'));
  const executablePath = path.join(root, 'candidate.exe');
  await writeFile(executablePath, 'test executable placeholder');
  t.after(() => rm(root, { recursive: true, force: true }));

  const parsed = await cliModule.parsePackagedVisualArgs(['--executable', executablePath]);
  assert.deepEqual(parsed, { executablePath: path.resolve(executablePath) });
  for (const argv of [
    [],
    ['--executable'],
    ['--executable', 'candidate.exe'],
    ['--executable', path.join(root, 'missing.exe')],
    ['--executable', path.join(root, 'candidate.txt')],
    ['--unknown', executablePath],
    ['--executable', executablePath, '--extra']
  ]) {
    await assert.rejects(cliModule.parsePackagedVisualArgs(argv), /executable|absolute|existing|usage/i, argv.join(' '));
  }
});
