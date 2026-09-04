import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { _electron as electron } from 'playwright-core';

const exec = promisify(execFile);
const root = path.resolve(import.meta.dirname, '../..');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

test('fresh synthetic fixtures prepare without overwriting masters and load through real Electron IPC', { timeout: 120_000 }, async () => {
  const output = path.join(root, 'outputs', 'fixture-preparation-tests');
  await mkdir(output, { recursive: true });
  const run = await mkdtemp(path.join(output, 'run-'));
  const assets = path.join(run, 'assets');
  // Only tracked inputs, as on a clean clone. Existing generated DBs must not mask preparation.
  const tracked = await exec('git', ['ls-files', '-z', '人工回归数据包/v0.4.2', '人工回归数据包/v0.4.3'], { cwd: root, encoding: 'utf8' });
  for (const relative of tracked.stdout.split('\0').filter(Boolean)) {
    const target = path.join(assets, path.relative('人工回归数据包', relative));
    await mkdir(path.dirname(target), { recursive: true });
    await copyFile(path.join(root, relative), target, constants.COPYFILE_EXCL);
  }
  const manifests = ['v0.4.2', 'v0.4.3'].map(version => path.join(assets, version, 'SHA256SUMS.json'));
  const before = await Promise.all(manifests.map(file => readFile(file)));
  const prepared = await exec(process.execPath, ['scripts/prepare-regression-assets.mjs', '--asset-root', assets], { cwd: root }).catch(error => error);
  assert.equal(prepared.code ?? 0, 0, prepared.stderr || 'fixture preparation must succeed');
  for (const [index, file] of manifests.entries()) assert.deepEqual(await readFile(file), before[index]);
  const baseline = path.join(assets, 'v0.4.2', 'SQLite', '01-26设备529通道空基线.sqlite');
  const preserved = await readFile(baseline);
  const second = await exec(process.execPath, ['scripts/prepare-regression-assets.mjs', '--asset-root', assets], { cwd: root });
  assert.equal(JSON.parse(second.stdout).created.length, 0);
  assert.equal(hash(await readFile(baseline)), hash(preserved));

  // All three source databases must open via the actual application, not a browser adapter.
  for (const [index, relative] of [
    'v0.4.2/SQLite/01-26设备529通道空基线.sqlite',
    'v0.4.2/SQLite/02-事务与状态迁移.sqlite',
    'v0.4.3/SQLite/04-及时率筛选与预约待办.sqlite'
  ].entries()) {
    const dataRoot = path.join(run, `electron-data-${index}`);
    await mkdir(dataRoot);
    await copyFile(path.join(assets, relative), path.join(dataRoot, 'battery-channel-hub.sqlite'));
    const env = { ...process.env, BATTERY_CHANNEL_DATA_DIR: dataRoot };
    delete env.ELECTRON_RUN_AS_NODE;
    const app = await electron.launch({ args: [root, `--user-data-dir=${path.join(run, `profile-${index}`)}`], env, timeout: 30_000 });
    try {
      const page = await app.firstWindow();
      const loaded = await page.evaluate(() => window.batteryDesktop.loadState());
      assert.equal(loaded.deviceProfiles.length, 26);
      assert.equal(loaded.channels.length, 529);
      if (index === 2) assert.equal(loaded.samples.length, 15);
    } finally { await app.close(); }
  }

  // An existing modified master must be rejected and kept byte-for-byte unchanged.
  const { writeFile } = await import('node:fs/promises');
  await writeFile(baseline, 'protected modified master');
  const refused = await exec(process.execPath, ['scripts/prepare-regression-assets.mjs', '--asset-root', assets], { cwd: root }).catch(error => error);
  assert.notEqual(refused.code ?? 0, 0);
  assert.match(refused.stderr, /FIXTURE_HASH_MISMATCH/);
  assert.equal(await readFile(baseline, 'utf8'), 'protected modified master');
});
