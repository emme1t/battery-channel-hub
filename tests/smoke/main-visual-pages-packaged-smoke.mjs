import { stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { runVisualPagesSmoke } from './main-visual-pages-smoke.mjs';

function cliError(message) {
  const error = new Error(message);
  error.exitCode = 2;
  return error;
}

export async function parsePackagedVisualArgs(argv) {
  if (!Array.isArray(argv) || argv.length !== 2 || argv[0] !== '--executable') {
    throw cliError('usage: node tests/smoke/main-visual-pages-packaged-smoke.mjs --executable <absolute-existing.exe>');
  }
  const suppliedPath = argv[1];
  if (typeof suppliedPath !== 'string' || suppliedPath.trim() === '') throw cliError('--executable requires a value');
  if (!path.isAbsolute(suppliedPath)) throw cliError('--executable must be an absolute path');
  const executablePath = path.resolve(suppliedPath);
  if (path.extname(executablePath).toLowerCase() !== '.exe') throw cliError('--executable must reference an .exe file');
  let details;
  try { details = await stat(executablePath); } catch { throw cliError('--executable must reference an existing file'); }
  if (!details.isFile()) throw cliError('--executable must reference an existing file');
  return Object.freeze({ executablePath });
}

export async function main(argv = process.argv.slice(2), {
  runVisualPagesSmokeImpl = runVisualPagesSmoke,
  stdout = process.stdout,
  stderr = process.stderr
} = {}) {
  try {
    const { executablePath } = await parsePackagedVisualArgs(argv);
    const result = await runVisualPagesSmokeImpl({ executablePath, packaged: true });
    stdout.write(`PACKAGED_VISUAL_PAGES_SMOKE_RESULT=${JSON.stringify(result)}\n`);
    return 0;
  } catch (error) {
    stderr.write(`${error?.message || String(error)}\n`);
    return error?.exitCode || 1;
  }
}

if (path.resolve(process.argv[1] || '') === fileURLToPath(import.meta.url)) {
  process.exitCode = await main();
}
