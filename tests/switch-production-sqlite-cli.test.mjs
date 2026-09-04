import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import { main } from '../scripts/switch-production-sqlite.mjs';

test('rollback CLI defaults to dry-run and only --apply authorizes writes', async () => {
  const calls = [];
  const stdout = { write() {} };
  const rollbackProductionData = async options => {
    calls.push(options);
    return { ok: true, mode: options.mode, applied: options.mode === 'apply' };
  };

  await main([
    '--data-root', 'C:\\isolated-test-data', '--backup-root', 'C:\\isolated-backups',
    '--rollback', 'RUN-CLI-DRY'
  ], {
    rollbackProductionData, stdout
  });
  await main([
    '--data-root', 'C:\\isolated-test-data', '--backup-root', 'C:\\isolated-backups',
    '--rollback', 'RUN-CLI-APPLY', '--apply'
  ], {
    rollbackProductionData, stdout
  });

  assert.equal(calls.length, 2);
  assert.equal(calls[0].mode, 'dry-run');
  assert.equal(calls[1].mode, 'apply');
  assert.equal(calls[0].externalBackupRoot, path.resolve('C:\\isolated-backups'));
  assert.equal(calls[1].externalBackupRoot, path.resolve('C:\\isolated-backups'));
});

test('rollback CLI requires --backup-root before invoking the service', async () => {
  let calls = 0;
  await assert.rejects(
    () => main(['--data-root', 'C:\\isolated-test-data', '--rollback', 'RUN-CLI-NO-BACKUP'], {
      rollbackProductionData: async () => { calls += 1; },
      stdout: { write() {} }
    }),
    error => error.code === 'INVALID_ARGUMENTS' && /--backup-root/.test(error.message)
  );
  assert.equal(calls, 0);
});
