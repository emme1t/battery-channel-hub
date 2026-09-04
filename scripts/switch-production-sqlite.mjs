import path from 'node:path';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';

import {
  rollbackProductionData,
  switchProductionData
} from '../src/main/production-switch-service.mjs';

const usage = `Usage:
  node scripts/switch-production-sqlite.mjs --candidate <sqlite> --data-root <dir> [options]
  node scripts/switch-production-sqlite.mjs --data-root <dir> --rollback <run-id> [options]

Safety:
  Dry-run is the default and performs read-only inspection only. It never creates a report,
  archive, backup, staging file, or target directory. Formal replacement requires an explicit
  --apply after the operator has completed the manual release gate and approved the exact paths.

Options:
  --candidate <file>          Verified 26-device/529-channel candidate SQLite.
  --data-root <dir>           Formal application data directory.
  --backup-root <dir>         External backup root outside --data-root.
  --active-program <file>     Current portable program (pair with --candidate-program).
  --candidate-program <file>  Candidate portable program (pair with --active-program).
  --run-id <id>               Unique run identifier; generated when omitted.
  --apply                     Perform the verified, reversible switch. Never implied.
  --rollback <run-id>         Restore the archived program/data pair for a completed run.
  -h, --help                  Show this help.
`;

function generatedRunId() {
  return `RUN-${new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 17)}`;
}

function coded(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

export async function main(argv = process.argv.slice(2), dependencies = {}) {
  const rollbackImpl = dependencies.rollbackProductionData || rollbackProductionData;
  const switchImpl = dependencies.switchProductionData || switchProductionData;
  const stdout = dependencies.stdout || process.stdout;
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      options: {
        candidate: { type: 'string' },
        'data-root': { type: 'string' },
        'backup-root': { type: 'string' },
        'active-program': { type: 'string' },
        'candidate-program': { type: 'string' },
        'run-id': { type: 'string' },
        apply: { type: 'boolean', default: false },
        rollback: { type: 'string' },
        help: { type: 'boolean', short: 'h', default: false }
      },
      strict: true,
      allowPositionals: false
    });
  } catch (error) {
    throw coded('INVALID_ARGUMENTS', error.message);
  }
  if (parsed.values.help) {
    stdout.write(usage);
    return { ok: true, help: true };
  }
  if (!parsed.values['data-root']) throw coded('INVALID_ARGUMENTS', '--data-root is required');
  const dataRoot = path.resolve(parsed.values['data-root']);
  const activeProgram = parsed.values['active-program'] ? path.resolve(parsed.values['active-program']) : '';

  if (parsed.values.rollback) {
    if (!parsed.values['backup-root']) {
      throw coded('INVALID_ARGUMENTS', '--backup-root is required for rollback');
    }
    const result = await rollbackImpl({
      mode: parsed.values.apply ? 'apply' : 'dry-run',
      dataRoot,
      runId: parsed.values.rollback,
      activeProgram,
      externalBackupRoot: path.resolve(parsed.values['backup-root'])
    });
    stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return result;
  }

  if (!parsed.values.candidate) throw coded('INVALID_ARGUMENTS', '--candidate is required');
  const result = await switchImpl({
    mode: parsed.values.apply ? 'apply' : 'dry-run',
    dataRoot,
    candidate: path.resolve(parsed.values.candidate),
    externalBackupRoot: parsed.values['backup-root'] ? path.resolve(parsed.values['backup-root']) : undefined,
    activeProgram,
    candidateProgram: parsed.values['candidate-program'] ? path.resolve(parsed.values['candidate-program']) : '',
    runId: parsed.values['run-id'] || generatedRunId()
  });
  stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  return result;
}

const isDirectExecution = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isDirectExecution) {
  try {
    await main();
  } catch (error) {
    process.stdout.write(`${JSON.stringify({
      ok: false,
      code: error.code || 'PRODUCTION_SWITCH_FAILED',
      message: error.message,
      details: error.details
    }, null, 2)}\n`);
    process.exitCode = error.code === 'INVALID_ARGUMENTS' ? 3 : 4;
  }
}
