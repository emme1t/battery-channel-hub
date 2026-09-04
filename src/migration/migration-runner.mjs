import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { dirname, extname, join, resolve } from 'node:path';

import { summarizeState } from '../domain/state-schema.mjs';
import { verifyBackupPackage, writeBackupFile } from '../main/backup-service.mjs';
import { createStateStore } from '../main/state-store.mjs';
import { analyzeLegacyState } from './legacy-state.mjs';
import { readMigrationSource, snapshotMigrationSource } from './source-readers.mjs';

const SUMMARY_KEYS = ['requests', 'samples', 'devices', 'channels', 'records', 'audits', 'requestSourceRows'];

function failed(mode, code, message, context = {}) {
  return {
    ...context,
    mode,
    ok: false,
    code,
    message
  };
}

function sameSource(left, right) {
  return left.path === right.path &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.sha256 === right.sha256;
}

function safeId(value) {
  return String(value).replace(/[^A-Za-z0-9._-]/g, '_');
}

async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

async function writeExactSourceBackup(sourcePath, backupPath, expectedSource) {
  const bytes = await fs.readFile(sourcePath);
  await fs.mkdir(dirname(backupPath), { recursive: true });
  const handle = await fs.open(backupPath, 'wx');
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  const backup = await snapshotMigrationSource(backupPath);
  if (backup.size !== expectedSource.size || backup.sha256 !== expectedSource.sha256) {
    throw Object.assign(new Error('source backup verification failed'), { code: 'SOURCE_BACKUP_INVALID' });
  }
  return backupPath;
}

function summariesEqual(expected, actual) {
  return SUMMARY_KEYS.every((key) => expected[key] === actual[key]);
}

function reportView(result) {
  const dryRun = result.dryRun
    ? { ...result.dryRun, state: undefined }
    : undefined;
  return { ...result, dryRun };
}

function markdownReport(result) {
  const lines = [
    '# vNext 旧数据迁移报告',
    '',
    `- 模式：${result.mode}`,
    `- 结果：${result.ok ? '通过' : '阻断'}`,
    `- 源文件：${result.source?.path || ''}`,
    `- 源 SHA-256：${result.source?.sha256 || ''}`,
    `- 代码：${result.code || 'OK'}`,
    ''
  ];
  if (result.dryRun?.sourceSummary) {
    lines.push('## 输入计数', '', '```json', JSON.stringify(result.dryRun.sourceSummary, null, 2), '```', '');
  }
  if (result.dryRun?.targetSummary) {
    lines.push('## 输出计数', '', '```json', JSON.stringify(result.dryRun.targetSummary, null, 2), '```', '');
  }
  if (result.blockers?.length) {
    lines.push('## 阻断项', '', ...result.blockers.map((item) => `- ${item}`), '');
  }
  if (result.dryRun?.warnings?.length) {
    lines.push('## 警告', '', ...result.dryRun.warnings.map((item) => `- ${item}`), '');
  }
  return `${lines.join('\n')}\n`;
}

async function writeReports(reportDir, runId, result) {
  if (!reportDir) return undefined;
  const resolvedReportDir = resolve(reportDir);
  await fs.mkdir(resolvedReportDir, { recursive: true });
  const jsonPath = join(resolvedReportDir, `migration-${runId}.json`);
  const markdownPath = join(resolvedReportDir, `migration-${runId}.md`);
  await fs.writeFile(jsonPath, `${JSON.stringify(reportView(result), null, 2)}\n`, 'utf8');
  await fs.writeFile(markdownPath, markdownReport(result), 'utf8');
  return { json: jsonPath, markdown: markdownPath };
}

export async function runMigration({
  source,
  targetDir,
  apply = false,
  replace = false,
  reportDir,
  now = new Date().toISOString(),
  idFactory = randomUUID
} = {}) {
  const mode = apply ? 'apply' : 'dry-run';
  if (typeof source !== 'string' || source.trim() === '') {
    return failed(mode, 'SOURCE_REQUIRED', 'migration source is required');
  }
  if (typeof targetDir !== 'string' || targetDir.trim() === '') {
    return failed(mode, 'TARGET_REQUIRED', 'migration target directory is required');
  }

  const input = await readMigrationSource(source);
  const runId = safeId(idFactory());
  const dryRun = analyzeLegacyState(input.value, {
    migratedAt: now,
    migrationAuditId: `AUD-MIGRATE-${runId}`,
    sourceDescriptor: input.source
  });
  const base = {
    mode,
    ok: dryRun.ok,
    source: input.source,
    sourceKind: input.kind,
    dryRun,
    blockers: dryRun.blockers,
    warnings: dryRun.warnings
  };

  if (!dryRun.ok) {
    const result = failed(mode, 'MIGRATION_BLOCKED', 'legacy conversion has blockers', base);
    result.reports = await writeReports(reportDir, runId, result);
    return result;
  }
  if (!apply) {
    const result = { ...base, ok: true };
    result.reports = await writeReports(reportDir, runId, result);
    return result;
  }

  const resolvedTarget = resolve(targetDir);
  if (resolvedTarget === dirname(input.source.path)) {
    return failed(mode, 'TARGET_IS_SOURCE_DIRECTORY', 'target directory must be isolated from the source directory', base);
  }

  const beforeApply = await snapshotMigrationSource(input.source.path);
  if (!sameSource(input.source, beforeApply)) {
    return failed(mode, 'SOURCE_CHANGED', 'source changed after dry-run and before apply', base);
  }

  const store = createStateStore({
    dataRoot: resolvedTarget,
    clock: () => new Date(now),
    idFactory: () => `${runId}-state`
  });
  const current = await store.inspect();
  if (current.kind === 'ready' && !replace) {
    return failed(mode, 'TARGET_EXISTS', 'target already contains vNext state; explicit replace is required', base);
  }
  if (current.kind === 'migration-required' || current.kind === 'blocked') {
    return failed(mode, 'TARGET_NOT_SAFE', current.message || 'target is not safe to write', base);
  }

  const backupDir = join(resolvedTarget, 'migration-backups');
  const sourceExtension = extname(input.source.path) || '.bin';
  const sourceBackup = join(backupDir, `legacy-source-${runId}${sourceExtension}`);
  await writeExactSourceBackup(input.source.path, sourceBackup, input.source);

  const afterBackup = await snapshotMigrationSource(input.source.path);
  if (!sameSource(input.source, afterBackup)) {
    return failed(mode, 'SOURCE_CHANGED', 'source changed while its exact backup was being verified', {
      ...base,
      backups: { source: sourceBackup }
    });
  }

  let targetBackup;
  if (current.kind === 'ready') {
    targetBackup = join(backupDir, `target-before-${runId}.json`);
    await writeBackupFile(targetBackup, current.state, {
      reason: '迁移替换前自动备份',
      createdAt: now,
      idFactory: () => `${runId}-target-backup`
    });
    verifyBackupPackage(JSON.parse(await fs.readFile(targetBackup, 'utf8')));
  }

  const expectedRevision = current.kind === 'ready' ? current.state.dataRevision : 0;
  const nextState = {
    ...dryRun.state,
    dataRevision: expectedRevision
  };
  const saved = await store.save(nextState, expectedRevision);
  if (!saved.ok) {
    return failed(mode, saved.code || 'TARGET_WRITE_FAILED', saved.message || 'target write failed', {
      ...base,
      backups: { source: sourceBackup, ...(targetBackup ? { target: targetBackup } : {}) }
    });
  }

  const verified = await store.inspect();
  const targetSummary = verified.kind === 'ready' ? summarizeState(verified.state) : null;
  if (verified.kind !== 'ready' || !summariesEqual(dryRun.targetSummary, targetSummary)) {
    return failed(mode, 'TARGET_VERIFICATION_FAILED', 'target re-read or count verification failed', {
      ...base,
      backups: { source: sourceBackup, ...(targetBackup ? { target: targetBackup } : {}) }
    });
  }

  const sourceAfter = await snapshotMigrationSource(input.source.path);
  if (!sameSource(input.source, sourceAfter)) {
    return failed(mode, 'SOURCE_CHANGED_AFTER_APPLY', 'source changed during apply; target is based on the verified source backup', {
      ...base,
      backups: { source: sourceBackup, ...(targetBackup ? { target: targetBackup } : {}) },
      verification: { targetSummary, sourceUnchanged: false }
    });
  }

  const result = {
    ...base,
    ok: true,
    backups: { source: sourceBackup, ...(targetBackup ? { target: targetBackup } : {}) },
    verification: {
      targetSummary,
      sourceUnchanged: true,
      targetRevision: verified.state.dataRevision
    }
  };
  result.reports = await writeReports(reportDir, runId, result);
  return result;
}
