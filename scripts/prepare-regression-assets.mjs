import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { gunzipSync } from 'node:zlib';

const projectRoot = path.resolve(import.meta.dirname, '..');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const archiveRoot = path.join(projectRoot, 'tests', 'fixtures', 'regression-assets');

function fixturePath(root, relative) {
  const target = path.resolve(root, relative);
  const within = path.relative(root, target);
  if (!within || within === '..' || within.startsWith(`..${path.sep}`) || path.isAbsolute(within)) {
    throw new Error(`FIXTURE_PATH_INVALID: ${relative}`);
  }
  return target;
}

async function verify(file, expected, { allowMissing = false } = {}) {
  let bytes;
  try { bytes = await readFile(file); }
  catch (error) {
    if (allowMissing && error.code === 'ENOENT') return false;
    throw error;
  }
  if (digest(bytes) !== expected) throw new Error(`FIXTURE_HASH_MISMATCH: ${file}`);
  return true;
}

// Restore versioned synthetic fixtures omitted by the runtime-data ignore rules.
// Existing masters and tracked manifests are never rewritten.
export async function prepareRegressionAssets({ assetRoot = path.join(projectRoot, '人工回归数据包') } = {}) {
  const created = [];
  const candidates = [];
  for (const version of ['v0.4.2', 'v0.4.3']) {
    const root = path.resolve(assetRoot, version);
    const manifest = JSON.parse(await readFile(path.join(root, 'SHA256SUMS.json'), 'utf8'));
    const entries = Array.isArray(manifest.files)
      ? manifest.files.map(item => [item.path, item.sha256])
      : Object.entries(manifest.files);
    for (const [relative, hash] of entries) {
      const target = fixturePath(root, relative);
      if (await verify(target, hash, { allowMissing: true })) continue;
      const packed = await readFile(fixturePath(path.join(archiveRoot, version), `${relative}.gz`));
      const bytes = gunzipSync(packed, { maxOutputLength: 32 * 1024 * 1024 });
      if (digest(bytes) !== hash) throw new Error(`FIXTURE_ARCHIVE_HASH_MISMATCH: ${version}/${relative}`);
      candidates.push({ target, relative: `${version}/${relative}`, bytes, hash });
    }
  }
  // Validate all existing masters and candidate bytes before creating any file.
  for (const { target, relative, bytes, hash } of candidates) {
    await mkdir(path.dirname(target), { recursive: true });
    try {
      await writeFile(target, bytes, { flag: 'wx' });
      created.push(relative);
    } catch (error) { if (error.code !== 'EEXIST') throw error; }
    await verify(target, hash);
  }
  return { ok: true, created };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { values } = parseArgs({ options: { 'asset-root': { type: 'string' } } });
    console.log(JSON.stringify(await prepareRegressionAssets({ assetRoot: values['asset-root'] })));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
