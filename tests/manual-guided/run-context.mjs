import { createHash, randomBytes as systemRandomBytes } from 'node:crypto';
import { mkdir, readFile, rm, stat } from 'node:fs/promises';
import path from 'node:path';

import { createPathGuard } from '../../scripts/edge-regression/path-guard.mjs';
import { MANUAL_GUIDED_MODES } from './contracts.mjs';
import { loadManualContract } from './manual-contract.mjs';

function runIdFrom(now, randomBytes) {
  const date = new Date(now());
  if (Number.isNaN(date.getTime())) throw new TypeError('now must return a valid date');
  const entropy = Buffer.from(randomBytes(4));
  if (entropy.length === 0) throw new TypeError('randomBytes must return bytes');
  return `${date.toISOString().replace(/[-:.]/g, '')}-${entropy.toString('hex')}`;
}

async function fileFingerprint(filePath) {
  const details = await stat(filePath);
  if (!details.isFile()) throw new TypeError(`protected target must be a file: ${filePath}`);
  const contents = await readFile(filePath);
  return Object.freeze({
    path: filePath,
    size: details.size,
    sha256: createHash('sha256').update(contents).digest('hex')
  });
}

async function verifyFingerprints(snapshot) {
  const changed = [];
  for (const expected of snapshot) {
    try {
      const current = await fileFingerprint(expected.path);
      if (current.size !== expected.size || current.sha256 !== expected.sha256) {
        changed.push(Object.freeze({ path: expected.path }));
      }
    } catch {
      changed.push(Object.freeze({ path: expected.path }));
    }
  }
  return Object.freeze({ ok: changed.length === 0, changed: Object.freeze(changed) });
}

export async function createManualGuidedRunContext({
  projectRoot,
  mode,
  executablePath,
  manualPath,
  stylesRoot,
  now = () => new Date(),
  randomBytes = systemRandomBytes
} = {}) {
  if (typeof projectRoot !== 'string' || projectRoot.trim() === '') throw new TypeError('projectRoot is required');
  if (!MANUAL_GUIDED_MODES.includes(mode)) throw new TypeError('mode must be quick, full, or replay');
  if (typeof executablePath !== 'string' || !path.isAbsolute(executablePath)) {
    throw new TypeError('executablePath must be absolute');
  }
  const resolvedExecutablePath = path.resolve(executablePath);
  if (path.extname(resolvedExecutablePath).toLowerCase() !== '.exe') {
    throw new TypeError('executablePath must be an .exe file');
  }
  let executable;
  try {
    executable = await fileFingerprint(resolvedExecutablePath);
  } catch (error) {
    if (error?.code === 'ENOENT') throw new TypeError('executablePath must be an existing file');
    throw error;
  }
  const manualContract = await loadManualContract({ manualPath, stylesRoot });
  const resolvedProjectRoot = path.resolve(projectRoot);
  const runId = runIdFrom(now, randomBytes);
  const runRoot = path.join(resolvedProjectRoot, '自动测试报告', 'manual-guided', runId);
  const profileRoot = path.join(runRoot, 'profile');
  const dataRoot = path.join(profileRoot, 'data');
  const workRoot = path.join(runRoot, 'work');
  const generatedDataRoot = path.join(workRoot, 'generated-data');
  const exportsRoot = path.join(workRoot, 'exports');
  const artifactsRoot = path.join(runRoot, 'artifacts');
  await Promise.all([dataRoot, generatedDataRoot, exportsRoot, artifactsRoot]
    .map(directory => mkdir(directory, { recursive: true })));

  const protectedSnapshot = Object.freeze([
    executable,
    manualContract.manual,
    ...manualContract.styleFiles
  ]);
  const guard = createPathGuard({
    projectRoot: resolvedProjectRoot,
    runRoot,
    protectedPaths: [resolvedExecutablePath, path.resolve(manualPath), path.resolve(stylesRoot)]
  });

  return Object.freeze({
    mode,
    runId,
    runRoot,
    profileRoot,
    dataRoot,
    workRoot,
    generatedDataRoot,
    exportsRoot,
    artifactsRoot,
    executable,
    manualContract,
    assertWritable(candidate) {
      return guard.assertWritable(candidate);
    },
    verifyProtected() {
      return verifyFingerprints(protectedSnapshot);
    },
    async cleanup({ success } = {}) {
      if (success !== true) return;
      await Promise.all([
        rm(workRoot, { recursive: true, force: true }),
        rm(profileRoot, { recursive: true, force: true })
      ]);
    }
  });
}
