import { createHash, randomBytes as systemRandomBytes } from 'node:crypto';
import { mkdir, readFile, rm, stat } from 'node:fs/promises';
import path from 'node:path';

import { createPathGuard } from '../../scripts/edge-regression/path-guard.mjs';

function runIdFrom(now, randomBytes) {
  const date = new Date(now());
  if (Number.isNaN(date.getTime())) throw new TypeError('now must return a valid date');
  const entropy = Buffer.from(randomBytes(4));
  if (entropy.length === 0) throw new TypeError('randomBytes must return bytes');
  return `${date.toISOString().replace(/[-:.]/g, '').replace('Z', 'Z')}-${entropy.toString('hex')}`;
}

async function fingerprint(filePath) {
  try {
    const details = await stat(filePath);
    const contents = details.isFile() ? await readFile(filePath) : Buffer.alloc(0);
    return Object.freeze({
      exists: true,
      size: details.size,
      mtimeMs: details.mtimeMs,
      sha256: createHash('sha256').update(contents).digest('hex')
    });
  } catch (error) {
    if (error.code === 'ENOENT') return Object.freeze({ exists: false });
    throw error;
  }
}

async function verifyFingerprints(snapshot) {
  const changed = [];
  for (const item of snapshot) {
    const current = await fingerprint(item.path);
    if (JSON.stringify(current) !== JSON.stringify(item.fingerprint)) changed.push({ path: item.path });
  }
  return Object.freeze({ ok: changed.length === 0, changed: Object.freeze(changed) });
}

export async function createWorkflowRunContext({
  projectRoot,
  mode,
  protectedPaths = [],
  now = () => new Date(),
  randomBytes = systemRandomBytes
}) {
  if (typeof projectRoot !== 'string' || projectRoot.trim() === '') throw new TypeError('projectRoot is required');
  if (typeof mode !== 'string' || mode.trim() === '') throw new TypeError('mode is required');
  if (!Array.isArray(protectedPaths)) throw new TypeError('protectedPaths must be an array');

  const resolvedProjectRoot = path.resolve(projectRoot);
  const runId = runIdFrom(now, randomBytes);
  const runRoot = path.join(resolvedProjectRoot, '自动测试报告', 'workflows', runId);
  const dataRoot = path.join(runRoot, 'work', 'data');
  const profileRoot = path.join(runRoot, 'profiles');
  const exportsRoot = path.join(runRoot, 'work', 'exports');
  const artifactsRoot = path.join(runRoot, 'artifacts');
  const screenshotsRoot = path.join(artifactsRoot, 'screenshots');
  const tracesRoot = path.join(artifactsRoot, 'traces');
  await Promise.all([dataRoot, profileRoot, exportsRoot, screenshotsRoot, tracesRoot].map(directory => mkdir(directory, { recursive: true })));

  const protectedSnapshot = await Promise.all(protectedPaths.map(async item => {
    const protectedPath = path.resolve(item);
    return Object.freeze({ path: protectedPath, fingerprint: await fingerprint(protectedPath) });
  }));
  const guard = createPathGuard({ projectRoot: resolvedProjectRoot, runRoot, protectedPaths });

  return Object.freeze({
    mode,
    runId,
    runRoot,
    dataRoot,
    profileRoot,
    exportsRoot,
    screenshotsRoot,
    tracesRoot,
    artifactsRoot,
    assertWritable(candidate) {
      return guard.assertWritable(candidate);
    },
    verifyProtected() {
      return verifyFingerprints(protectedSnapshot);
    },
    async cleanup({ success } = {}) {
      if (success !== true) return;
      await Promise.all([
        rm(path.join(runRoot, 'work'), { recursive: true, force: true }),
        rm(profileRoot, { recursive: true, force: true })
      ]);
    }
  });
}
