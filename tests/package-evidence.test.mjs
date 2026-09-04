import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  assertFreshMtime,
  collectPackageEvidence,
  inspectAuthenticodeSignature,
  packageGateSkipReason
} from '../scripts/package-evidence.mjs';

const projectRoot = path.resolve(import.meta.dirname, '..');
const packageJson = JSON.parse(readFileSync(path.join(projectRoot, 'package.json'), 'utf8'));

test('core test gate serializes test files to avoid concurrent driver sessions', () => {
  assert.equal(packageJson.scripts['test:core'], 'node --test --test-concurrency=1 tests/*.test.mjs');
});

test('package config keeps the restored runtime closure and excludes deployment tooling', () => {
  const files = new Set(packageJson.build.files);
  for (const required of [
    'src/domain/legacy-storage-transactions.mjs',
    'src/domain/legacy-return-to-application-transactions.mjs',
    'src/main/storage-command-service.mjs',
    'src/renderer/legacy-storage-workbench.mjs'
  ]) {
    assert.equal(files.has(required), true, `build.files 缺少 ${required}`);
  }
  assert.equal(files.has('src/main/production-switch-service.mjs'), false);
});

test('package config exposes distinct portable and NSIS targets', () => {
  assert.equal(packageJson.scripts['dist:installer'], 'electron-builder --win nsis');
  assert.deepEqual(new Set(packageJson.build.win.target), new Set(['portable', 'nsis']));
  assert.equal(packageJson.build.portable.artifactName, 'Battery-Channel-Hub-${version}-portable.${ext}');
  assert.equal(packageJson.build.nsis.artifactName, 'Battery-Channel-Hub-${version}-setup.${ext}');
  assert.notEqual(packageJson.build.portable.artifactName, packageJson.build.nsis.artifactName);
});

test('NSIS uninstall keeps Electron AppData', () => {
  assert.equal(packageJson.build.nsis.deleteAppDataOnUninstall, false);
});

test('package config installs the complete user guide and creates Windows entry points', () => {
  assert.deepEqual(packageJson.build.extraResources, [{
    from: 'resources/使用说明',
    to: '使用说明',
    filter: ['**/*']
  }]);
  assert.equal(packageJson.build.nsis.createDesktopShortcut, true);
  assert.equal(packageJson.build.nsis.createStartMenuShortcut, true);
});

test('package gate skips only a missing optional build', () => {
  assert.match(packageGateSkipReason({ gateRequired: false, asarExists: false }), /fresh dist:dir/i);
  assert.equal(packageGateSkipReason({ gateRequired: false, asarExists: true }), false);
  assert.equal(packageGateSkipReason({ gateRequired: true, asarExists: false }), false);
  assert.equal(packageGateSkipReason({ gateRequired: true, asarExists: true }), false);
});

test('freshness lower bound accepts equality and rejects a stale ASAR', () => {
  assert.doesNotThrow(() => assertFreshMtime(1_000, 1_000));
  assert.throws(() => assertFreshMtime(999, 1_000), /stale/i);
  assert.throws(() => assertFreshMtime(1_000, 'not-a-timestamp'), /BATTERY_PACKAGE_MIN_MTIME_MS/);
});

test('package evidence records stable hashes, sorted file list, mtime and signature status', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'battery-package-evidence-'));
  try {
    const asarPath = path.join(root, 'app.asar');
    const exePath = path.join(root, 'Battery-Channel-Hub.exe');
    writeFileSync(asarPath, 'asar-bytes');
    writeFileSync(exePath, 'exe-bytes');

    const report = collectPackageEvidence({
      asarPath,
      files: ['/z.mjs', '/a.mjs'],
      requiredCount: 2,
      excludedCount: 3,
      minimumMtimeMs: 0,
      artifactPaths: [exePath],
      inspectSignature: artifactPath => ({
        path: artifactPath,
        status: 'NotSigned',
        statusMessage: 'No signature was present.',
        signerSubject: null,
        thumbprint: null
      })
    });

    assert.match(report.asarSha256, /^[a-f0-9]{64}$/);
    assert.match(report.fileListSha256, /^[a-f0-9]{64}$/);
    assert.equal(report.sizeBytes, 10);
    assert.match(report.mtimeUtc, /^\d{4}-\d{2}-\d{2}T/);
    assert.deepEqual(report.files, ['/a.mjs', '/z.mjs']);
    assert.equal(report.required, 2);
    assert.equal(report.excluded, 3);
    assert.equal(report.artifacts[0].signature.status, 'NotSigned');

    assert.throws(() => collectPackageEvidence({
      asarPath,
      files: [],
      requiredCount: 0,
      excludedCount: 0,
      artifactPaths: [path.join(root, 'missing.exe')],
      requireArtifacts: true,
      inspectSignature: () => assert.fail('missing artifact must fail before signature inspection')
    }), /缺少候选产物/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Windows signature inspector returns concrete Authenticode fields', {
  skip: process.platform === 'win32' ? false : 'Authenticode inspection requires Windows'
}, () => {
  const signature = inspectAuthenticodeSignature(process.execPath);
  assert.equal(path.resolve(signature.path), path.resolve(process.execPath));
  assert.match(signature.status, /^(?:Valid|NotSigned|UnknownError|HashMismatch|NotTrusted|NotSupportedFileFormat)$/);
  assert.equal(typeof signature.statusMessage, 'string');
  assert.equal(signature.signerSubject === null || typeof signature.signerSubject === 'string', true);
  assert.equal(signature.thumbprint === null || typeof signature.thumbprint === 'string', true);
});
