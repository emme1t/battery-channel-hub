import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const OPTIONAL_BUILD_SKIP = 'fresh dist:dir is intentionally deferred until the real full workflow gate passes';

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function fileEvidence(filePath) {
  const stat = statSync(filePath);
  return {
    path: path.resolve(filePath),
    sha256: sha256(readFileSync(filePath)),
    sizeBytes: stat.size,
    mtimeUtc: stat.mtime.toISOString()
  };
}

export function packageGateSkipReason({ gateRequired, asarExists }) {
  return !gateRequired && !asarExists ? OPTIONAL_BUILD_SKIP : false;
}

export function parseMinimumMtime(value) {
  if (value === undefined || value === null || value === '') return null;
  const parsed = Number(value);
  assert.equal(
    Number.isFinite(parsed) && parsed >= 0,
    true,
    'BATTERY_PACKAGE_MIN_MTIME_MS 必须是非负毫秒时间戳'
  );
  return parsed;
}

export function assertFreshMtime(actualMtimeMs, minimumMtimeMs, label = 'app.asar') {
  const minimum = parseMinimumMtime(minimumMtimeMs);
  if (minimum === null) return;
  assert.equal(
    actualMtimeMs >= minimum,
    true,
    `stale ${label}: mtime ${actualMtimeMs} is older than BATTERY_PACKAGE_MIN_MTIME_MS ${minimum}`
  );
}

export function inspectAuthenticodeSignature(artifactPath) {
  if (process.platform !== 'win32') {
    return {
      path: path.resolve(artifactPath),
      status: 'UnsupportedPlatform',
      statusMessage: 'Authenticode inspection requires Windows.',
      signerSubject: null,
      thumbprint: null
    };
  }

  const command = [
    "$ErrorActionPreference = 'Stop'",
    "$ProgressPreference = 'SilentlyContinue'",
    '[Console]::OutputEncoding = [Text.UTF8Encoding]::new()',
    '$signature = Get-AuthenticodeSignature -LiteralPath $env:BATTERY_SIGNATURE_TARGET',
    '[pscustomobject]@{',
    '  path = $signature.Path',
    '  status = [string]$signature.Status',
    '  statusMessage = $signature.StatusMessage',
    '  signerSubject = $(if ($signature.SignerCertificate) { $signature.SignerCertificate.Subject } else { $null })',
    '  thumbprint = $(if ($signature.SignerCertificate) { $signature.SignerCertificate.Thumbprint } else { $null })',
    '} | ConvertTo-Json -Compress'
  ].join('\n');
  const encodedCommand = Buffer.from(command, 'utf16le').toString('base64');
  const windowsModulePath = [
    path.join(process.env.SystemRoot ?? 'C:\\Windows', 'system32', 'WindowsPowerShell', 'v1.0', 'Modules'),
    path.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'WindowsPowerShell', 'Modules')
  ].join(';');
  const output = execFileSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-EncodedCommand', encodedCommand],
    {
      encoding: 'utf8',
      windowsHide: true,
      env: {
        ...process.env,
        BATTERY_SIGNATURE_TARGET: path.resolve(artifactPath),
        PSModulePath: windowsModulePath
      }
    }
  );
  return JSON.parse(output);
}

export function collectPackageEvidence({
  asarPath,
  files,
  requiredCount,
  excludedCount,
  minimumMtimeMs,
  artifactPaths = [],
  requireArtifacts = false,
  inspectSignature = inspectAuthenticodeSignature
}) {
  const stat = statSync(asarPath);
  assertFreshMtime(stat.mtimeMs, minimumMtimeMs);
  const sortedFiles = [...files].sort();
  const asar = fileEvidence(asarPath);
  if (requireArtifacts) {
    for (const artifactPath of artifactPaths) {
      assert.equal(existsSync(artifactPath), true, `缺少候选产物 ${artifactPath}`);
    }
  }
  const artifacts = artifactPaths
    .filter(artifactPath => existsSync(artifactPath))
    .map(artifactPath => {
      assertFreshMtime(statSync(artifactPath).mtimeMs, minimumMtimeMs, artifactPath);
      return {
        ...fileEvidence(artifactPath),
        signature: inspectSignature(artifactPath)
      };
    });

  return {
    asarPath: asar.path,
    asarSha256: asar.sha256,
    sizeBytes: asar.sizeBytes,
    mtimeUtc: asar.mtimeUtc,
    totalFiles: sortedFiles.length,
    required: requiredCount,
    excluded: excludedCount,
    fileListSha256: sha256(sortedFiles.join('\n')),
    files: sortedFiles,
    artifacts
  };
}
