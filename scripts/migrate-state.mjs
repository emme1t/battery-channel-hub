import { parseArgs } from 'node:util';

import { runMigration } from '../src/migration/migration-runner.mjs';

const usage = `Usage:
  node scripts/migrate-state.mjs --source <legacy-file> --target-dir <isolated-dir> [--apply] [--replace] [--report-dir <dir>]

Dry-run is the default mode. It reads and analyzes the source but does not create the target directory.
--apply       Explicitly create or update the isolated vNext target after all gates pass.
--replace     Permit replacement only after a verified backup of an existing vNext target.
--report-dir  Optional directory for JSON and Markdown reports.
`;

function invalidArguments(message) {
  process.stderr.write(`${message}\n\n${usage}`);
  process.exitCode = 3;
}

let parsed;
try {
  parsed = parseArgs({
    options: {
      source: { type: 'string' },
      'target-dir': { type: 'string' },
      apply: { type: 'boolean', default: false },
      replace: { type: 'boolean', default: false },
      'report-dir': { type: 'string' },
      help: { type: 'boolean', short: 'h', default: false }
    },
    strict: true,
    allowPositionals: false
  });
} catch (error) {
  invalidArguments(error.message);
}

if (parsed?.values.help) {
  process.stdout.write(usage);
} else if (parsed) {
  const { values } = parsed;
  if (!values.source || !values['target-dir']) {
    invalidArguments('--source and --target-dir are required');
  } else {
    try {
      const result = await runMigration({
        source: values.source,
        targetDir: values['target-dir'],
        apply: values.apply,
        replace: values.replace,
        reportDir: values['report-dir']
      });
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      process.exitCode = result.ok ? 0 : result.code === 'MIGRATION_BLOCKED' ? 2 : 4;
    } catch (error) {
      process.stderr.write(`${JSON.stringify({
        ok: false,
        code: error.code || 'MIGRATION_IO_FAILED',
        message: error.message
      }, null, 2)}\n`);
      process.exitCode = 4;
    }
  }
}
