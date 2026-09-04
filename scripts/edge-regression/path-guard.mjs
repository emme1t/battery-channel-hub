import { realpath } from 'node:fs/promises';
import path from 'node:path';

function pathError(code, candidate) {
  const error = new Error(`${code}: ${candidate}`);
  error.code = code;
  error.path = candidate;
  return error;
}
function comparable(candidate) {
  const resolved = path.resolve(candidate);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function contains(parent, candidate, { allowEqual = false } = {}) {
  const relative = path.relative(parent, candidate);
  if (relative === '') return allowEqual;
  return !relative.startsWith('..') && !path.isAbsolute(relative);
}

async function canonicalCandidate(candidate) {
  const resolved = path.resolve(candidate);
  let cursor = resolved;
  const suffix = [];
  while (true) {
    try {
      const existing = await realpath(cursor);
      return path.resolve(existing, ...suffix);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const parent = path.dirname(cursor);
      if (parent === cursor) return resolved;
      suffix.unshift(path.basename(cursor));
      cursor = parent;
    }
  }
}

async function matchesProtected(candidate, protectedPaths) {
  const lexical = comparable(candidate);
  const canonical = comparable(await canonicalCandidate(candidate));
  for (const item of protectedPaths) {
    const protectedLexical = comparable(item);
    const protectedCanonical = comparable(await canonicalCandidate(item));
    if (
      contains(protectedLexical, lexical, { allowEqual: true }) ||
      contains(protectedCanonical, canonical, { allowEqual: true })
    ) return true;
  }
  return false;
}

export function createPathGuard({ projectRoot, runRoot, protectedPaths = [] }) {
  if (!projectRoot || !runRoot) throw new TypeError('projectRoot and runRoot are required');
  const resolvedProjectRoot = path.resolve(projectRoot);
  const resolvedRunRoot = path.resolve(runRoot);
  const protectedResolved = protectedPaths.map(item => path.resolve(item));

  return Object.freeze({
    projectRoot: resolvedProjectRoot,
    runRoot: resolvedRunRoot,

    async assertWritable(candidate) {
      if (typeof candidate !== 'string' || candidate.trim() === '') {
        throw pathError('WRITE_PATH_REQUIRED', String(candidate || ''));
      }
      const resolved = path.resolve(candidate);
      if (await matchesProtected(resolved, protectedResolved)) {
        throw pathError('PROTECTED_PATH_WRITE', resolved);
      }
      if (!contains(comparable(resolvedRunRoot), comparable(resolved))) {
        throw pathError('RUN_ROOT_ESCAPE', resolved);
      }
      const canonicalRunRoot = comparable(await canonicalCandidate(resolvedRunRoot));
      const canonical = comparable(await canonicalCandidate(resolved));
      if (!contains(canonicalRunRoot, canonical)) throw pathError('RUN_ROOT_ESCAPE', resolved);
      return resolved;
    },

    async assertReadable(candidate, allowedRoots = [resolvedProjectRoot, resolvedRunRoot]) {
      if (typeof candidate !== 'string' || candidate.trim() === '') {
        throw pathError('READ_PATH_REQUIRED', String(candidate || ''));
      }
      const resolved = path.resolve(candidate);
      const canonical = comparable(await canonicalCandidate(resolved));
      for (const root of allowedRoots) {
        const lexicalRoot = comparable(path.resolve(root));
        const canonicalRoot = comparable(await canonicalCandidate(root));
        if (
          contains(lexicalRoot, comparable(resolved), { allowEqual: true }) &&
          contains(canonicalRoot, canonical, { allowEqual: true })
        ) return resolved;
      }
      throw pathError('READ_ROOT_ESCAPE', resolved);
    }
  });
}
