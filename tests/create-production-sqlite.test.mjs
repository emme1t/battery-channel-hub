import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import { createLegacySqliteStore, SQLITE_FILE } from '../src/main/legacy-sqlite-store.mjs';

const execFileAsync = promisify(execFile);
const projectRoot = path.resolve(import.meta.dirname, '..');
const scriptPath = path.join(projectRoot, 'scripts', 'create-production-sqlite.mjs');

async function exists(target) {
  try {
    await stat(target);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

async function sha256(filePath) {
  return createHash('sha256').update(await readFile(filePath)).digest('hex');
}

async function runCli(args) {
  try {
    const result = await execFileAsync(process.execPath, [scriptPath, ...args], {
      cwd: projectRoot,
      windowsHide: true
    });
    return { code: 0, report: JSON.parse(result.stdout), stderr: result.stderr };
  } catch (error) {
    return {
      code: error.code,
      report: error.stdout ? JSON.parse(error.stdout) : null,
      stderr: error.stderr
    };
  }
}

test('default dry-run writes no target and apply creates only the approved 26/529 state', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'battery-candidate-test-'));
  const targetDir = path.join(root, 'candidate');
  try {
    const dry = await runCli(['--target-dir', targetDir]);
    assert.equal(dry.code, 0, dry.stderr);
    assert.equal(dry.report.mode, 'dry-run');
    assert.equal(dry.report.applied, false);
    assert.equal(dry.report.presetSha256, 'a964640116eece6c5995f01b5f92e41ce3fc1ca08aae0b8b0bc45152c36f6bbf');
    assert.deepEqual(dry.report.summary, {
      devices: 26,
      channels: 529,
      requests: 0,
      records: 0,
      samples: 0,
      auditLogs: 1
    });
    assert.equal(await exists(targetDir), false);

    const applied = await runCli(['--target-dir', targetDir, '--apply']);
    assert.equal(applied.code, 0, applied.stderr);
    assert.equal(applied.report.mode, 'apply');
    assert.equal(applied.report.applied, true);
    assert.equal(applied.report.backup, null);

    const store = await createLegacySqliteStore({ dataRoot: targetDir });
    try {
      const loaded = await store.load();
      assert.equal(loaded.ok, true);
      assert.equal(loaded.state.revision, 1);
      assert.equal(loaded.state.deviceProfiles.length, 26);
      assert.equal(loaded.state.channels.length, 529);
      assert.equal(loaded.state.requests.length, 0);
      assert.equal(loaded.state.records.length, 0);
      assert.equal(loaded.state.samples.length, 0);
      assert.equal(loaded.state.auditLogs.length, 1);
      assert.ok(loaded.state.channels.every(channel => channel.state === 'free'));
    } finally {
      store.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('existing target blocks apply without replace and replace retains a verified backup', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'battery-candidate-replace-'));
  const targetDir = path.join(root, 'candidate');
  const databasePath = path.join(targetDir, SQLITE_FILE);
  try {
    const first = await runCli(['--target-dir', targetDir, '--apply']);
    assert.equal(first.code, 0, first.stderr);
    const beforeHash = await sha256(databasePath);

    const blocked = await runCli(['--target-dir', targetDir, '--apply']);
    assert.equal(blocked.code, 4);
    assert.equal(blocked.report.code, 'TARGET_EXISTS');
    assert.equal(await sha256(databasePath), beforeHash);

    const replaced = await runCli(['--target-dir', targetDir, '--apply', '--replace']);
    assert.equal(replaced.code, 0, replaced.stderr);
    assert.equal(replaced.report.applied, true);
    assert.equal(replaced.report.replaced, true);
    assert.ok(replaced.report.backup?.path);
    assert.equal(replaced.report.backup.sha256, beforeHash);
    assert.equal(await sha256(replaced.report.backup.path), beforeHash);
    assert.equal(replaced.report.backup.integrity, 'ok');
    assert.equal(await exists(databasePath), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
