import { createHash, randomBytes as defaultRandomBytes } from 'node:crypto';
import { copyFile, mkdir, readFile, rm, stat } from 'node:fs/promises';
import path from 'node:path';

import { createPathGuard } from './path-guard.mjs';

async function fingerprint(filePath) {
  const absolute = path.resolve(filePath);
  const [bytes, info] = await Promise.all([readFile(absolute), stat(absolute)]);
  return {
    path: absolute,
    size: info.size,
    mtimeMs: info.mtimeMs,
    sha256: createHash('sha256').update(bytes).digest('hex')
  };
}

function sameFingerprint(left, right) {
  return left.path === right.path &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.sha256 === right.sha256;
}

function runIdFor(date, bytes) {
  const timestamp = date.toISOString().replace(/[-:.]/g, '');
  return `${timestamp}-${Buffer.from(bytes).toString('hex').slice(0, 8)}`;
}

export async function createRunContext({
  projectRoot,
  mode,
  protectedPaths = [],
  reportRootOverride = null,
  now = () => new Date(),
  randomBytes = defaultRandomBytes
}) {
  if (!projectRoot) throw new TypeError('projectRoot is required');
  if (!['quick', 'full'].includes(mode)) throw new TypeError('mode must be quick or full');
  const resolvedProjectRoot = path.resolve(projectRoot);
  const legacyReportsRoot = path.join(resolvedProjectRoot, '自动测试报告');
  let reportsRoot = legacyReportsRoot;
  if (reportRootOverride !== null && reportRootOverride !== undefined) {
    const invalid = message => {
      const error = new Error(`invalid Edge report-root override: ${message}`);
      error.code = 'EDGE_REPORT_ROOT_INVALID';
      error.path = reportRootOverride;
      return error;
    };
    if (typeof reportRootOverride !== 'string' || reportRootOverride.trim() === '' || !path.isAbsolute(reportRootOverride)) {
      throw invalid('an absolute path is required');
    }
    const workflowReportsRoot = path.join(legacyReportsRoot, 'workflows');
    const resolvedOverride = path.resolve(reportRootOverride);
    const relative = path.relative(workflowReportsRoot, resolvedOverride);
    const segments = relative.split(path.sep);
    const workflowRunIdPattern = /^\d{8}T\d{9}Z-[a-f0-9]{8}$/;
    if (
      segments.length !== 2 ||
      !workflowRunIdPattern.test(segments[0]) ||
      segments[1] !== 'edge-full' ||
      relative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relative)
    ) throw invalid('expected <project>/自动测试报告/workflows/<workflow-run>/edge-full');
    const workflowRunRoot = path.join(workflowReportsRoot, segments[0]);
    try {
      const workflowGuard = createPathGuard({ projectRoot: resolvedProjectRoot, runRoot: workflowRunRoot });
      await workflowGuard.assertWritable(path.join(resolvedOverride, '.edge-report-root'));
    } catch (error) {
      throw invalid(error.message);
    }
    reportsRoot = resolvedOverride;
  }
  const runId = runIdFor(now(), randomBytes(4));
  const runRoot = path.join(reportsRoot, runId);
  const workRoot = path.join(runRoot, 'work');
  const screenshotsRoot = path.join(runRoot, 'screenshots');
  const tracesRoot = path.join(runRoot, 'traces');
  const artifactsRoot = path.join(runRoot, 'artifacts');
  await Promise.all([
    mkdir(workRoot, { recursive: true }),
    mkdir(screenshotsRoot, { recursive: true }),
    mkdir(tracesRoot, { recursive: true }),
    mkdir(artifactsRoot, { recursive: true })
  ]);
  const protectedSnapshot = await Promise.all(protectedPaths.map(fingerprint));
  const guard = createPathGuard({
    projectRoot: resolvedProjectRoot,
    runRoot,
    protectedPaths
  });

  const context = {
    projectRoot: resolvedProjectRoot,
    reportsRoot,
    runId,
    runRoot,
    workRoot,
    screenshotsRoot,
    tracesRoot,
    artifactsRoot,
    mode,
    guard,
    protectedSnapshot,

    async copyFixture(source, relativeTarget) {
      const readable = await guard.assertReadable(source, [resolvedProjectRoot]);
      const target = await guard.assertWritable(path.join(workRoot, relativeTarget));
      await mkdir(path.dirname(target), { recursive: true });
      await copyFile(readable, target);
      return target;
    },

    async verifyProtected() {
      const current = [];
      const changed = [];
      for (const original of protectedSnapshot) {
        try {
          const observed = await fingerprint(original.path);
          current.push(observed);
          if (!sameFingerprint(original, observed)) changed.push({ path: original.path, before: original, after: observed });
        } catch (error) {
          const observed = { path: original.path, missing: error.code === 'ENOENT', error: error.message };
          current.push(observed);
          changed.push({ path: original.path, before: original, after: observed });
        }
      }
      return changed.length === 0
        ? { ok: true, files: protectedSnapshot }
        : { ok: false, files: current, changed };
    },

    async cleanup({ success = false, keepWorkdir = false } = {}) {
      if (!success || keepWorkdir) return;
      const verifiedWorkRoot = await guard.assertWritable(path.join(workRoot, '.cleanup-scope'));
      if (path.dirname(verifiedWorkRoot) !== path.resolve(workRoot)) {
        const error = new Error('cleanup scope verification failed');
        error.code = 'CLEANUP_SCOPE_INVALID';
        throw error;
      }
      await rm(workRoot, { recursive: true, force: true });
    }
  };
  return Object.freeze(context);
}
