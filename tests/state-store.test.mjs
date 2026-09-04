import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { join, relative } from 'node:path';
import { tmpdir } from 'node:os';

import { createEmptyState } from '../src/domain/state-schema.mjs';
import { createStateStore } from '../src/main/state-store.mjs';

async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

async function snapshotDirectory(root) {
  if (!(await exists(root))) return [];
  const output = [];
  async function walk(current) {
    const entries = await fs.readdir(current, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const fullPath = join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
        continue;
      }
      const [bytes, info] = await Promise.all([fs.readFile(fullPath), fs.stat(fullPath)]);
      output.push({
        path: relative(root, fullPath),
        size: info.size,
        mtimeMs: info.mtimeMs,
        sha256: createHash('sha256').update(bytes).digest('hex')
      });
    }
  }
  await walk(root);
  return output;
}

async function withTemporaryRoot(run) {
  const root = await fs.mkdtemp(join(tmpdir(), 'vnext-store-'));
  try {
    return await run(root);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

test('inspecting a missing data root is read only and returns an empty state', async () => {
  await withTemporaryRoot(async (parent) => {
    const root = join(parent, 'missing');
    const result = await createStateStore({ dataRoot: root }).inspect();

    assert.equal(result.kind, 'empty');
    assert.deepEqual(result.state, createEmptyState());
    assert.equal(await exists(root), false);
  });
});

test('inspecting a legacy-only directory preserves path, bytes, size and mtime', async () => {
  await withTemporaryRoot(async (root) => {
    const legacy = join(root, 'battery-channel-hub.json');
    await fs.writeFile(legacy, JSON.stringify({ requests: [] }), 'utf8');
    const before = await snapshotDirectory(root);

    const result = await createStateStore({ dataRoot: root }).inspect();

    assert.equal(result.kind, 'migration-required');
    assert.deepEqual(result.legacyFiles, ['battery-channel-hub.json']);
    assert.deepEqual(await snapshotDirectory(root), before);
  });
});

test('corrupt vNext state blocks without falling back to a valid-looking legacy file', async () => {
  await withTemporaryRoot(async (root) => {
    await fs.writeFile(join(root, 'battery-channel-vnext.json'), '{broken', 'utf8');
    await fs.writeFile(join(root, 'battery-channel-hub.json'), JSON.stringify({ requests: [] }), 'utf8');
    const before = await snapshotDirectory(root);

    const result = await createStateStore({ dataRoot: root }).inspect();

    assert.equal(result.kind, 'blocked');
    assert.match(result.message, /无法安全读取/);
    assert.deepEqual(result.legacyFiles, ['battery-channel-hub.json']);
    assert.deepEqual(await snapshotDirectory(root), before);
  });
});

test('first save advances revision and re-reads the validated state', async () => {
  await withTemporaryRoot(async (root) => {
    const store = createStateStore({ dataRoot: root, idFactory: () => 'first' });

    const result = await store.save(createEmptyState({ username: '测试员' }), 0);

    assert.equal(result.ok, true);
    assert.equal(result.state.dataRevision, 1);
    assert.equal(result.state.username, '测试员');
    assert.deepEqual((await store.inspect()).state, result.state);
    assert.deepEqual((await fs.readdir(root)).sort(), ['battery-channel-vnext.json']);
  });
});

test('revision conflict and invalid input perform zero writes', async () => {
  await withTemporaryRoot(async (root) => {
    const store = createStateStore({ dataRoot: root, idFactory: () => 'stable' });
    const first = await store.save(createEmptyState(), 0);
    const before = await snapshotDirectory(root);

    const conflict = await store.save(first.state, 0);
    const invalid = await store.save({ schemaVersion: 2, dataRevision: 1 }, 1);

    assert.deepEqual(conflict, {
      ok: false,
      code: 'REVISION_CONFLICT',
      message: '数据已被其它操作更新，请重新加载。'
    });
    assert.equal(invalid.ok, false);
    assert.equal(invalid.code, 'INVALID_VNEXT_STATE');
    assert.deepEqual(await snapshotDirectory(root), before);
  });
});

test('rename failure preserves the previous state and cleans temporary artifacts', async () => {
  await withTemporaryRoot(async (root) => {
    const stableStore = createStateStore({ dataRoot: root, idFactory: () => 'seed' });
    const first = await stableStore.save(createEmptyState({ username: 'before' }), 0);
    const before = await snapshotDirectory(root);
    const failingFs = {
      ...fs,
      rename: async (source, target) => {
        if (source.endsWith('.tmp') && target.endsWith('battery-channel-vnext.json')) {
          const error = new Error('injected rename failure');
          error.code = 'EACCES';
          throw error;
        }
        return fs.rename(source, target);
      }
    };
    const store = createStateStore({ dataRoot: root, fsApi: failingFs, idFactory: () => 'rename-failure' });

    const result = await store.save({ ...first.state, username: 'after' }, 1);

    assert.equal(result.ok, false);
    assert.equal(result.code, 'ATOMIC_WRITE_FAILED');
    assert.deepEqual((await stableStore.inspect()).state, first.state);
    assert.deepEqual(await snapshotDirectory(root), before);
  });
});

test('post-write validation failure restores the exact previous bytes', async () => {
  await withTemporaryRoot(async (root) => {
    const stableStore = createStateStore({ dataRoot: root, idFactory: () => 'seed' });
    const first = await stableStore.save(createEmptyState({ username: 'before' }), 0);
    const beforeBytes = await fs.readFile(stableStore.filePath);
    let targetReads = 0;
    const failingFs = {
      ...fs,
      readFile: async (filePath, encoding) => {
        if (filePath === stableStore.filePath) {
          targetReads += 1;
          if (targetReads === 2) return encoding ? '{invalid' : Buffer.from('{invalid');
        }
        return fs.readFile(filePath, encoding);
      }
    };
    const store = createStateStore({ dataRoot: root, fsApi: failingFs, idFactory: () => 'verify-failure' });

    const result = await store.save({ ...first.state, username: 'after' }, 1);

    assert.equal(result.ok, false);
    assert.equal(result.code, 'POST_WRITE_VALIDATION_FAILED');
    assert.deepEqual(await fs.readFile(stableStore.filePath), beforeBytes);
    assert.deepEqual((await fs.readdir(root)).sort(), ['battery-channel-vnext.json']);
  });
});
