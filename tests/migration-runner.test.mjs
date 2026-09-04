import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { access, mkdtemp, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import { verifyBackupPackage } from '../src/main/backup-service.mjs';
import { createStateStore } from '../src/main/state-store.mjs';
import { readMigrationSource } from '../src/migration/source-readers.mjs';
import { runMigration } from '../src/migration/migration-runner.mjs';
import { makeLegacyState, makeConflictingLegacyState } from './fixtures/legacy-state-fixtures.mjs';
import { makeState } from './fixtures/state-fixtures.mjs';

const execFileAsync = promisify(execFile);
const fixedNow = '2026-08-20T20:00:00.000Z';

async function temporaryRoot() {
  return mkdtemp(join(tmpdir(), 'battery-vnext-migration-'));
}

async function snapshotFile(filePath) {
  const [bytes, metadata] = await Promise.all([readFile(filePath), stat(filePath)]);
  return {
    size: metadata.size,
    mtimeMs: metadata.mtimeMs,
    sha256: createHash('sha256').update(bytes).digest('hex')
  };
}

async function writeJson(filePath, value) {
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function assertMissing(filePath) {
  await assert.rejects(() => access(filePath), { code: 'ENOENT' });
}

test('JSON, v1 backup and SQLite readers are read-only and preserve the legacy payload', async () => {
  const root = await temporaryRoot();
  const legacy = makeLegacyState();
  const jsonPath = join(root, 'legacy.json');
  const backupPath = join(root, 'legacy-backup.json');
  const sqlitePath = join(root, 'legacy.sqlite');
  await writeJson(jsonPath, legacy);
  await writeJson(backupPath, { format: 'battery-channel-hub-backup', version: 1, state: legacy });

  const database = new DatabaseSync(sqlitePath);
  database.exec('CREATE TABLE app_state (id INTEGER PRIMARY KEY, payload TEXT NOT NULL, updated_at TEXT NOT NULL)');
  database.prepare('INSERT INTO app_state(id, payload, updated_at) VALUES (1, ?, ?)')
    .run(JSON.stringify(legacy), fixedNow);
  database.close();

  for (const [filePath, expectedKind] of [
    [jsonPath, 'legacy-json'],
    [backupPath, 'legacy-backup-v1'],
    [sqlitePath, 'legacy-sqlite']
  ]) {
    const before = await snapshotFile(filePath);
    const result = await readMigrationSource(filePath);
    assert.equal(result.kind, expectedKind);
    assert.deepEqual(result.value, legacy);
    assert.deepEqual(await snapshotFile(filePath), before);
    assert.deepEqual(result.source, { path: resolve(filePath), ...before });
  }
});

test('default dry-run leaves source and missing target byte-for-byte unchanged', async () => {
  const root = await temporaryRoot();
  const sourceFile = join(root, 'legacy.json');
  const targetDir = join(root, 'missing-target');
  await writeJson(sourceFile, makeLegacyState());
  const sourceBefore = await snapshotFile(sourceFile);

  const result = await runMigration({ source: sourceFile, targetDir, now: fixedNow, idFactory: () => 'dry-1' });

  assert.equal(result.mode, 'dry-run');
  assert.equal(result.ok, true);
  assert.equal(result.dryRun.targetSummary.requests, 1);
  assert.deepEqual(await snapshotFile(sourceFile), sourceBefore);
  await assertMissing(targetDir);
});

test('conversion blockers create no target but may emit an explicit report', async () => {
  const root = await temporaryRoot();
  const sourceFile = join(root, 'legacy.json');
  const targetDir = join(root, 'target');
  const reportDir = join(root, 'reports');
  await writeJson(sourceFile, makeConflictingLegacyState());
  const before = await snapshotFile(sourceFile);

  const result = await runMigration({
    source: sourceFile,
    targetDir,
    reportDir,
    apply: true,
    now: fixedNow,
    idFactory: () => 'blocked-1'
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, 'MIGRATION_BLOCKED');
  assert.ok(result.blockers.length >= 3);
  assert.deepEqual(await snapshotFile(sourceFile), before);
  await assertMissing(targetDir);
  const report = JSON.parse(await readFile(result.reports.json, 'utf8'));
  assert.equal(report.code, 'MIGRATION_BLOCKED');
  assert.ok(report.blockers.length >= 3);
  assert.match(await readFile(result.reports.markdown, 'utf8'), /阻断项/);
});

test('apply backs up source, writes target, verifies counts and never changes source', async () => {
  const root = await temporaryRoot();
  const sourceFile = join(root, 'legacy.json');
  const targetDir = join(root, 'target');
  await writeJson(sourceFile, makeLegacyState());
  const before = await snapshotFile(sourceFile);

  const result = await runMigration({
    source: sourceFile,
    targetDir,
    apply: true,
    now: fixedNow,
    idFactory: () => 'apply-1'
  });

  assert.equal(result.ok, true);
  assert.equal(result.mode, 'apply');
  assert.deepEqual(await snapshotFile(sourceFile), before);
  const sourceBackup = await snapshotFile(result.backups.source);
  assert.equal(sourceBackup.size, before.size);
  assert.equal(sourceBackup.sha256, before.sha256);
  assert.equal(result.verification.targetSummary.requests, result.dryRun.targetSummary.requests);
  assert.equal(result.verification.targetSummary.records, result.dryRun.targetSummary.records);
  const inspection = await createStateStore({ dataRoot: targetDir }).inspect();
  assert.equal(inspection.kind, 'ready');
  assert.equal(inspection.state.dataRevision, 1);
  const migrationAudit = inspection.state.audits.at(-1);
  assert.equal(migrationAudit.toolVersion, 'vnext-migration/0.1');
  assert.equal(migrationAudit.sourceFile.sha256, before.sha256);
  assert.equal(migrationAudit.sourceFile.path, resolve(sourceFile));
});

test('source hash change between analysis and apply aborts before target creation', async () => {
  const root = await temporaryRoot();
  const sourceFile = join(root, 'legacy.json');
  const targetDir = join(root, 'target');
  await writeJson(sourceFile, makeLegacyState());
  let changed = false;

  const result = await runMigration({
    source: sourceFile,
    targetDir,
    apply: true,
    now: fixedNow,
    idFactory: () => {
      if (!changed) {
        changed = true;
        const databaseSafeMutation = `${JSON.stringify(makeLegacyState({ username: 'changed' }), null, 2)}\n`;
        writeFileSync(sourceFile, databaseSafeMutation, 'utf8');
      }
      return 'race-1';
    }
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, 'SOURCE_CHANGED');
  await assertMissing(targetDir);
});

test('existing target requires replace and remains unchanged when replace is absent', async () => {
  const root = await temporaryRoot();
  const sourceFile = join(root, 'legacy.json');
  const targetDir = join(root, 'target');
  await writeJson(sourceFile, makeLegacyState());
  const store = createStateStore({ dataRoot: targetDir, clock: () => new Date(fixedNow), idFactory: () => 'seed' });
  const saved = await store.save(makeState(), 0);
  assert.equal(saved.ok, true);
  const targetBefore = await snapshotFile(store.filePath);

  const result = await runMigration({
    source: sourceFile,
    targetDir,
    apply: true,
    now: fixedNow,
    idFactory: () => 'no-replace'
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, 'TARGET_EXISTS');
  assert.deepEqual(await snapshotFile(store.filePath), targetBefore);
  assert.deepEqual(await readdir(targetDir), ['battery-channel-vnext.json']);
});

test('replace creates and verifies a target backup before advancing target revision', async () => {
  const root = await temporaryRoot();
  const sourceFile = join(root, 'legacy.json');
  const targetDir = join(root, 'target');
  await writeJson(sourceFile, makeLegacyState());
  const store = createStateStore({ dataRoot: targetDir, clock: () => new Date(fixedNow), idFactory: () => 'seed' });
  const original = await store.save(makeState(), 0);
  assert.equal(original.ok, true);

  const result = await runMigration({
    source: sourceFile,
    targetDir,
    apply: true,
    replace: true,
    now: fixedNow,
    idFactory: () => 'replace-1'
  });

  assert.equal(result.ok, true);
  const targetBackup = JSON.parse(await readFile(result.backups.target, 'utf8'));
  const backedUpState = verifyBackupPackage(targetBackup);
  assert.deepEqual(backedUpState, original.state);
  const inspection = await store.inspect();
  assert.equal(inspection.kind, 'ready');
  assert.equal(inspection.state.dataRevision, 2);
  assert.equal(inspection.summary.requests, 1);
});

test('CLI help succeeds and CLI defaults to dry-run without creating the target', async () => {
  const root = await temporaryRoot();
  const sourceFile = join(root, 'legacy.json');
  const targetDir = join(root, 'target');
  const cliPath = resolve('scripts/migrate-state.mjs');
  await writeJson(sourceFile, makeLegacyState());

  const help = await execFileAsync(process.execPath, [cliPath, '--help'], { cwd: resolve('.') });
  assert.match(help.stdout, /dry-run.*default/i);

  const dryRun = await execFileAsync(process.execPath, [
    cliPath,
    '--source', sourceFile,
    '--target-dir', targetDir
  ], { cwd: resolve('.') });
  const result = JSON.parse(dryRun.stdout);
  assert.equal(result.mode, 'dry-run');
  assert.equal(result.ok, true);
  await assertMissing(targetDir);
});
