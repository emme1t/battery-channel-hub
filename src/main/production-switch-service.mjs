import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import * as defaultFs from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { promisify } from 'node:util';

import { summarizeLegacyState, normalizeLegacyState } from './legacy-state-schema.mjs';
import { SQLITE_FILE } from './legacy-sqlite-store.mjs';

const SWITCH_PHASES = Object.freeze([
  'inspect',
  'verify-candidate',
  'backup-active',
  'verify-backup',
  'stage-candidate',
  'verify-staged',
  'swap',
  'verify-active'
]);
const ROLLBACK_PHASES = Object.freeze([
  'inspect-report',
  'verify-generation',
  'preflight-1',
  'stage-archive',
  'verify-staged',
  'preflight-2',
  'swap',
  'verify-active'
]);
const SWITCH_REPORT_SCHEMA = 'battery-channel-hub-production-switch-v2';
const GENERATION_LINEAGE_SCHEMA = 'battery-channel-hub-generation-lineage-v1';
const GENERATION_LINEAGE_TABLE = 'production_generation_lineage';
const execFileAsync = promisify(execFile);

function switchError(code, message, details = undefined) {
  const error = new Error(message);
  error.code = code;
  if (details !== undefined) error.details = details;
  return error;
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonicalize(value[key])]));
  }
  return value;
}

function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

function sha256Value(value) {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

async function exists(fsApi, target) {
  try {
    await fsApi.access(target);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

async function sha256File(fsApi, filePath) {
  return createHash('sha256').update(await fsApi.readFile(filePath)).digest('hex');
}

async function inspectFile(fsApi, filePath) {
  const info = await fsApi.stat(filePath);
  if (!info.isFile()) throw switchError('PATH_NOT_FILE', `路径不是文件：${filePath}`);
  return {
    path: path.resolve(filePath),
    size: info.size,
    mtimeMs: info.mtimeMs,
    sha256: await sha256File(fsApi, filePath)
  };
}

function inspectSqliteSync(filePath, label = 'SQLite') {
  let database;
  try {
    database = new DatabaseSync(filePath, { readOnly: true });
    const integrity = String(database.prepare('PRAGMA integrity_check').get()?.integrity_check || '');
    if (integrity !== 'ok') {
      throw switchError('SQLITE_INTEGRITY_FAILED', `${label} integrity_check 未通过：${integrity || '无结果'}`);
    }
    const row = database.prepare('SELECT revision, payload FROM app_state WHERE id = 1').get();
    if (!row) throw switchError('SQLITE_STATE_MISSING', `${label} 缺少 app_state 状态行`);
    const state = normalizeLegacyState(JSON.parse(row.payload));
    state.revision = Number(row.revision);
    return { integrity, summary: summarizeLegacyState(state) };
  } catch (error) {
    if (error.code) throw error;
    throw switchError('SQLITE_INVALID', `${label} 只读检查失败：${error.message}`);
  } finally {
    database?.close();
  }
}

async function inspectSqlite(fsApi, filePath, label) {
  const file = await inspectFile(fsApi, filePath);
  return { ...file, ...inspectSqliteSync(file.path, label) };
}

function assertApprovedCandidate(candidate) {
  const summary = candidate.summary;
  const approved =
    summary.devices === 26 &&
    summary.channels === 529 &&
    summary.requests === 0 &&
    summary.records === 0 &&
    summary.samples === 0 &&
    summary.storageRecords === 0;
  if (!approved) {
    throw switchError(
      'CANDIDATE_SUMMARY_INVALID',
      '候选 SQLite 必须是 26 台设备、529 通道、0 申请、0 记录、0 子样品和 0 长期存储记录',
      { summary }
    );
  }
}

function validateRunId(runId) {
  if (typeof runId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{2,80}$/.test(runId)) {
    throw switchError('RUN_ID_INVALID', 'run ID 只能包含 3–81 位字母、数字、点、下划线或连字符');
  }
  return runId;
}

function isInside(parent, child) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

async function resolvePhysicalPath(fsApi, target) {
  const unresolvedParts = [];
  let existingPath = path.resolve(target);
  while (!(await exists(fsApi, existingPath))) {
    const parent = path.dirname(existingPath);
    if (parent === existingPath) {
      throw switchError('PATH_RESOLUTION_FAILED', `无法解析路径的现存父目录：${target}`);
    }
    unresolvedParts.unshift(path.basename(existingPath));
    existingPath = parent;
  }
  const physicalParent = await fsApi.realpath(existingPath);
  return path.resolve(physicalParent, ...unresolvedParts);
}

async function assertPhysicalBackupBoundary(fsApi, dataRoot, backupTarget) {
  const [physicalDataRoot, physicalBackupTarget] = await Promise.all([
    resolvePhysicalPath(fsApi, dataRoot),
    resolvePhysicalPath(fsApi, backupTarget)
  ]);
  if (isInside(physicalDataRoot, physicalBackupTarget)) {
    throw switchError(
      'EXTERNAL_BACKUP_ROOT_INVALID',
      '外部备份目录的物理路径必须位于正式数据目录之外',
      {
        dataRoot: path.resolve(dataRoot),
        physicalDataRoot,
        backupTarget: path.resolve(backupTarget),
        physicalBackupTarget
      }
    );
  }
}

async function defaultActivePathProbe({ activeDatabase, activeProgram }) {
  if (process.platform !== 'win32') return [];
  const targets = [activeDatabase, activeProgram].filter(Boolean);
  if (targets.length === 0) return [];
  const probeScript = [
    '$targets = ConvertFrom-Json $env:BATTERY_SWITCH_PROBE_PATHS',
    '$blockers = @()',
    'foreach ($target in $targets) {',
    '  try {',
    '    $handle = [System.IO.File]::Open($target, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::None)',
    '    $handle.Dispose()',
    '  } catch [System.IO.IOException] {',
    "    $blockers += [pscustomobject]@{ kind = 'file-handle'; path = [System.IO.Path]::GetFullPath($target) }",
    '  } catch {',
    '    Write-Error $_.Exception.Message',
    '    exit 2',
    '  }',
    '}',
    'if ($blockers.Count -gt 0) { $blockers | ConvertTo-Json -Compress }'
  ].join('; ');
  let stdout;
  try {
    ({ stdout } = await execFileAsync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', probeScript],
      {
        encoding: 'utf8',
        windowsHide: true,
        timeout: 5000,
        env: { ...process.env, BATTERY_SWITCH_PROBE_PATHS: JSON.stringify(targets) }
      }
    ));
  } catch (error) {
    throw switchError('ACTIVE_PROBE_FAILED', `无法完成正式程序/数据句柄预检：${error.message}`);
  }
  const serialized = String(stdout).trim();
  if (!serialized) return [];
  try {
    const parsed = JSON.parse(serialized);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch (error) {
    throw switchError('ACTIVE_PROBE_FAILED', `正式程序/数据句柄预检输出无效：${error.message}`);
  }
}

async function activityPreflight({ fsApi, activePathProbe, dataRoot, activeDatabase, activeProgram }) {
  const sidecars = [];
  for (const sidecar of [`${activeDatabase}-journal`, `${activeDatabase}-wal`, `${activeDatabase}-shm`]) {
    if (await exists(fsApi, sidecar)) sidecars.push({ kind: 'sqlite-sidecar', path: path.resolve(sidecar) });
  }
  const processOrHandleBlockers = await activePathProbe({
    fsApi, dataRoot, activeDatabase, activeProgram
  });
  const blockers = [...sidecars, ...(Array.isArray(processOrHandleBlockers) ? processOrHandleBlockers : [])];
  if (blockers.length > 0) {
    throw switchError(
      'ACTIVE_PATH_BLOCKED',
      '检测到活动进程、句柄或 SQLite 事务旁文件，拒绝切换',
      { blockers }
    );
  }
  return blockers;
}

async function assertPathsAbsent(fsApi, targets, code, message) {
  for (const target of targets.filter(Boolean)) {
    if (await exists(fsApi, target)) throw switchError(code, message, { path: path.resolve(target) });
  }
}

async function removeCreatedFiles(fsApi, targets) {
  for (const target of targets.filter(Boolean)) {
    try {
      await fsApi.rm(target, { force: true });
    } catch {
      // Best effort only for files created by this invocation.
    }
  }
}

async function writeVerifiedJsonAtomic({ fsApi, finalPath, value, validate }) {
  const temporaryPath = `${finalPath}.tmp`;
  await assertPathsAbsent(
    fsApi,
    [finalPath, temporaryPath],
    'REPORT_TARGET_EXISTS',
    '报告或报告暂存文件已存在，拒绝覆盖'
  );
  let handle;
  let temporaryCreated = false;
  let finalCreated = false;
  try {
    handle = await fsApi.open(temporaryPath, 'wx');
    temporaryCreated = true;
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    await fsApi.rename(temporaryPath, finalPath);
    finalCreated = true;
    const persisted = JSON.parse(await fsApi.readFile(finalPath, 'utf8'));
    validate?.(persisted);
    return persisted;
  } catch (error) {
    try { await handle?.close(); } catch {}
    await removeCreatedFiles(fsApi, [temporaryCreated ? temporaryPath : '', finalCreated ? finalPath : '']);
    if (error?.code === 'REPORT_TARGET_EXISTS') throw error;
    throw switchError('REPORT_WRITE_FAILED', `原子报告写入或重读校验失败：${error.message}`);
  }
}

async function archiveRuns(fsApi, dataRoot) {
  const archiveRoot = path.join(dataRoot, 'legacy-archive');
  if (!(await exists(fsApi, archiveRoot))) return [];
  return (await fsApi.readdir(archiveRoot, { withFileTypes: true }))
    .filter(entry => entry.isDirectory())
    .map(entry => entry.name)
    .sort();
}

export async function inspectProductionRoot({
  dataRoot,
  activeProgram = '',
  fsApi = defaultFs
}) {
  if (!dataRoot) throw switchError('DATA_ROOT_REQUIRED', '正式数据目录不能为空');
  const resolvedRoot = path.resolve(dataRoot);
  const activeDatabase = path.join(resolvedRoot, SQLITE_FILE);
  const database = await exists(fsApi, activeDatabase)
    ? await inspectSqlite(fsApi, activeDatabase, '当前正式 SQLite')
    : null;
  const program = activeProgram && await exists(fsApi, activeProgram)
    ? await inspectFile(fsApi, activeProgram)
    : null;
  const sidecars = [];
  for (const sidecar of [`${activeDatabase}-journal`, `${activeDatabase}-wal`, `${activeDatabase}-shm`]) {
    if (await exists(fsApi, sidecar)) sidecars.push(path.resolve(sidecar));
  }
  return {
    dataRoot: resolvedRoot,
    activeDatabase,
    database,
    activeProgram: activeProgram ? path.resolve(activeProgram) : '',
    program,
    sidecars,
    archiveRuns: await archiveRuns(fsApi, resolvedRoot)
  };
}

async function verifyExactCopy(fsApi, source, destination, label) {
  const [sourceInfo, destinationInfo] = await Promise.all([
    inspectFile(fsApi, source),
    inspectFile(fsApi, destination)
  ]);
  if (sourceInfo.size !== destinationInfo.size || sourceInfo.sha256 !== destinationInfo.sha256) {
    throw switchError('COPY_VERIFY_FAILED', `${label}大小或 SHA-256 不一致`);
  }
  return destinationInfo;
}

function samePath(left, right) {
  return typeof left === 'string' && typeof right === 'string' && path.resolve(left) === path.resolve(right);
}

function assertHashInspection(inspection, expectedPath) {
  return inspection && samePath(inspection.path, expectedPath) &&
    Number.isSafeInteger(inspection.size) && inspection.size >= 0 &&
    typeof inspection.sha256 === 'string' && /^[a-f0-9]{64}$/.test(inspection.sha256);
}

function matchesHashInspection(inspection, expectedPath, expectedInspection) {
  return assertHashInspection(inspection, expectedPath) &&
    inspection.size === expectedInspection?.size &&
    inspection.sha256 === expectedInspection?.sha256;
}

function boundInspection(inspection, expectedPath = inspection?.path) {
  if (!inspection) return null;
  return {
    path: path.resolve(expectedPath),
    size: inspection.size,
    sha256: inspection.sha256
  };
}

function buildGenerationLineagePayload({
  runId,
  dataRoot,
  switchReportFile,
  activeDatabase,
  candidateDatabaseInspection,
  activeProgram,
  activeProgramInspection,
  archiveDirectory,
  archiveDatabase,
  archiveDatabaseInspection,
  archiveProgram,
  archiveProgramInspection
}) {
  return {
    schema: GENERATION_LINEAGE_SCHEMA,
    runId,
    dataRoot: path.resolve(dataRoot),
    switchReport: path.resolve(switchReportFile),
    activeDatabase: path.resolve(activeDatabase),
    candidateDatabase: boundInspection(candidateDatabaseInspection),
    activeProgram: activeProgram ? boundInspection(activeProgramInspection, activeProgram) : null,
    archive: {
      directory: path.resolve(archiveDirectory),
      database: boundInspection(archiveDatabaseInspection, archiveDatabase),
      program: archiveProgram ? boundInspection(archiveProgramInspection, archiveProgram) : null
    }
  };
}

function makeGenerationLineageDocument(payload) {
  return { ...payload, lineageId: sha256Value(payload) };
}

function validateGenerationLineageDocument(document, expectedPayload) {
  if (!document || typeof document !== 'object' || Array.isArray(document)) {
    throw switchError('GENERATION_LINEAGE_INVALID', '代际 lineage 标记不是对象');
  }
  const { lineageId, ...payload } = document;
  if (
    typeof lineageId !== 'string' || !/^[a-f0-9]{64}$/.test(lineageId) ||
    lineageId !== sha256Value(payload) ||
    canonicalJson(payload) !== canonicalJson(expectedPayload)
  ) {
    throw switchError('GENERATION_LINEAGE_INVALID', '代际 lineage 标记身份或绑定内容无效');
  }
  return document;
}

function persistGenerationLineageSync(filePath, document) {
  let database;
  let transactionOpen = false;
  try {
    database = new DatabaseSync(filePath);
    database.exec('BEGIN IMMEDIATE');
    transactionOpen = true;
    database.exec(`
      CREATE TABLE IF NOT EXISTS ${GENERATION_LINEAGE_TABLE} (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        schema TEXT NOT NULL,
        lineage_id TEXT NOT NULL UNIQUE,
        payload TEXT NOT NULL
      );
    `);
    const existing = database.prepare(`SELECT id FROM ${GENERATION_LINEAGE_TABLE}`).all();
    if (existing.length !== 0) {
      throw switchError('GENERATION_LINEAGE_EXISTS', '候选 SQLite 已包含其他代际 lineage 标记');
    }
    database.prepare(`
      INSERT INTO ${GENERATION_LINEAGE_TABLE}(id, schema, lineage_id, payload)
      VALUES (1, ?, ?, ?)
    `).run(GENERATION_LINEAGE_SCHEMA, document.lineageId, canonicalJson(document));
    database.exec(`
      CREATE TRIGGER IF NOT EXISTS production_generation_lineage_no_update
      BEFORE UPDATE ON ${GENERATION_LINEAGE_TABLE}
      BEGIN SELECT RAISE(ABORT, 'production generation lineage is immutable'); END;
      CREATE TRIGGER IF NOT EXISTS production_generation_lineage_no_delete
      BEFORE DELETE ON ${GENERATION_LINEAGE_TABLE}
      BEGIN SELECT RAISE(ABORT, 'production generation lineage is immutable'); END;
    `);
    database.exec('COMMIT');
    transactionOpen = false;
  } catch (error) {
    if (transactionOpen) {
      try { database?.exec('ROLLBACK'); } catch {}
    }
    if (error?.code) throw error;
    throw switchError('GENERATION_LINEAGE_WRITE_FAILED', `候选 SQLite 代际 lineage 写入失败：${error.message}`);
  } finally {
    database?.close();
  }
}

function readGenerationLineageSync(filePath) {
  let database;
  try {
    database = new DatabaseSync(filePath, { readOnly: true });
    const table = database.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?"
    ).get(GENERATION_LINEAGE_TABLE);
    if (!table) return null;
    const rows = database.prepare(`
      SELECT id, schema, lineage_id, payload
      FROM ${GENERATION_LINEAGE_TABLE}
    `).all();
    if (rows.length !== 1 || Number(rows[0].id) !== 1) {
      throw switchError('GENERATION_LINEAGE_INVALID', 'SQLite 代际 lineage 必须且只能有一条记录');
    }
    const document = JSON.parse(rows[0].payload);
    if (
      rows[0].schema !== GENERATION_LINEAGE_SCHEMA ||
      rows[0].lineage_id !== document?.lineageId
    ) {
      throw switchError('GENERATION_LINEAGE_INVALID', 'SQLite 代际 lineage 行与 payload 不一致');
    }
    return document;
  } catch (error) {
    if (error?.code) throw error;
    throw switchError('GENERATION_LINEAGE_INVALID', `SQLite 代际 lineage 读取失败：${error.message}`);
  } finally {
    database?.close();
  }
}

function assertActiveGenerationLineage(activeDatabase, expectedDocument) {
  try {
    const actual = readGenerationLineageSync(activeDatabase);
    validateGenerationLineageDocument(actual, (({ lineageId, ...payload }) => payload)(expectedDocument));
    if (canonicalJson(actual) !== canonicalJson(expectedDocument)) {
      throw switchError('GENERATION_LINEAGE_INVALID', 'SQLite 代际 lineage 与切换报告不一致');
    }
  } catch (error) {
    throw switchError('ACTIVE_GENERATION_MISMATCH', '当前活动 SQLite 已不是该切换报告绑定的代际', {
      causeCode: error?.code || 'GENERATION_LINEAGE_INVALID'
    });
  }
}

function switchReportLineage(report, context, { required = false } = {}) {
  const marker = report?.generationLineage;
  const hasV2Schema = report?.reportSchema === SWITCH_REPORT_SCHEMA;
  if (!marker) {
    if (required || hasV2Schema) {
      throw switchError('SWITCH_REPORT_INVALID', '切换报告缺少受保护的代际 lineage 标记');
    }
    return null;
  }
  if (!hasV2Schema) throw switchError('SWITCH_REPORT_INVALID', '切换报告 lineage 版本无效');
  const lineageFile = path.join(context.archiveDirectory, 'generation-lineage.json');
  const expectedPayload = buildGenerationLineagePayload({
    runId: context.runId,
    dataRoot: context.dataRoot,
    switchReportFile: context.reportFile,
    activeDatabase: context.activeDatabase,
    candidateDatabaseInspection: report.candidate,
    activeProgram: context.activeProgram,
    activeProgramInspection: report.active?.program,
    archiveDirectory: context.archiveDirectory,
    archiveDatabase: context.archiveDatabase,
    archiveDatabaseInspection: report.archive?.databaseInspection,
    archiveProgram: context.archiveProgram,
    archiveProgramInspection: report.archive?.programInspection
  });
  const expectedDocument = makeGenerationLineageDocument(expectedPayload);
  const valid = marker.schema === GENERATION_LINEAGE_SCHEMA &&
    marker.sqliteTable === GENERATION_LINEAGE_TABLE && marker.sqliteId === 1 &&
    marker.lineageId === expectedDocument.lineageId &&
    samePath(marker.path, lineageFile) && isInside(context.archiveDirectory, marker.path) &&
    assertHashInspection(marker.inspection, lineageFile);
  if (!valid) throw switchError('SWITCH_REPORT_INVALID', '切换报告的代际 lineage 路径、hash 或绑定无效');
  return { lineageFile, expectedDocument };
}

function assertSwitchReportIdentity(report, {
  runId, dataRoot, archiveDirectory, activeDatabase, activeProgram,
  externalBackupRoot = '', externalDirectory = '', reportFile = '', requireLineage = false
}) {
  const archiveDatabase = path.join(archiveDirectory, SQLITE_FILE);
  const archiveProgram = activeProgram ? path.join(archiveDirectory, path.basename(activeProgram)) : '';
  const externalDatabase = externalDirectory ? path.join(externalDirectory, SQLITE_FILE) : '';
  const externalProgram = activeProgram && externalDirectory
    ? path.join(externalDirectory, path.basename(activeProgram))
    : '';
  const valid = report && typeof report === 'object' &&
    report.ok === true && report.mode === 'apply' && report.applied === true &&
    (report.reportSchema === undefined || report.reportSchema === SWITCH_REPORT_SCHEMA) &&
    report.runId === runId && samePath(report.dataRoot, dataRoot) &&
    Array.isArray(report.completedPhases) && SWITCH_PHASES.every(phase => report.completedPhases.includes(phase)) &&
    report.archive && samePath(report.archive.directory, archiveDirectory) &&
    samePath(report.archive.database, archiveDatabase) &&
    isInside(archiveDirectory, report.archive.database) &&
    assertHashInspection(report.archive.databaseInspection, archiveDatabase) &&
    report.active && assertHashInspection(report.active.database, activeDatabase) &&
    samePath(report.production?.activeDatabase, activeDatabase) &&
    samePath(report.production?.activeProgram || '', activeProgram || '');
  const programValid = activeProgram
    ? samePath(report.archive.program, archiveProgram) &&
      isInside(archiveDirectory, report.archive.program) &&
      assertHashInspection(report.archive.programInspection, archiveProgram) &&
      assertHashInspection(report.active.program, activeProgram)
    : !report.archive?.program && !report.archive?.programInspection && !report.active?.program;
  const externalValid = !externalBackupRoot || (
    samePath(report.externalBackupRoot, externalBackupRoot) &&
    report.externalBackup && samePath(report.externalBackup.directory, externalDirectory) &&
    isInside(externalBackupRoot, report.externalBackup.directory) &&
    samePath(report.externalBackup.database, externalDatabase) &&
    isInside(externalDirectory, report.externalBackup.database) &&
    assertHashInspection(report.externalBackup.databaseInspection, externalDatabase) &&
    report.externalBackup.databaseInspection.size === report.archive.databaseInspection.size &&
    report.externalBackup.databaseInspection.sha256 === report.archive.databaseInspection.sha256
  );
  const externalProgramValid = !externalBackupRoot || (activeProgram
    ? samePath(report.externalBackup.program, externalProgram) &&
      isInside(externalDirectory, report.externalBackup.program) &&
      assertHashInspection(report.externalBackup.programInspection, externalProgram) &&
      report.externalBackup.programInspection.size === report.archive.programInspection.size &&
      report.externalBackup.programInspection.sha256 === report.archive.programInspection.sha256
    : !report.externalBackup?.program && !report.externalBackup?.programInspection);
  if (!valid || !programValid || !externalValid || !externalProgramValid) {
    throw switchError('SWITCH_REPORT_INVALID', '切换报告身份、完成阶段或程序/数据路径绑定无效');
  }
  const lineage = switchReportLineage(report, {
    runId, dataRoot, archiveDirectory, activeDatabase, activeProgram,
    archiveDatabase, archiveProgram,
    reportFile: reportFile || path.join(archiveDirectory, 'switch-report.json')
  }, { required: requireLineage });
  return { archiveDatabase, archiveProgram, externalDatabase, externalProgram, lineage };
}

function validateRollbackReport(report, {
  runId,
  dataRoot,
  activeDatabase,
  activeProgram,
  replacedDatabase,
  replacedProgram,
  switchReportHash,
  activeDatabaseInspection,
  activeProgramInspection,
  replacedDatabaseInspection,
  replacedProgramInspection
}) {
  const phasesValid = Array.isArray(report?.completedPhases) &&
    report.completedPhases.length === ROLLBACK_PHASES.length &&
    ROLLBACK_PHASES.every(phase => report.completedPhases.includes(phase));
  const valid = report && report.ok === true && report.mode === 'apply' &&
    report.applied === true && report.rolledBack === true && report.runId === runId &&
    samePath(report.dataRoot, dataRoot) && report.switchReportHash === switchReportHash && phasesValid &&
    matchesHashInspection(report.active?.database, activeDatabase, activeDatabaseInspection) &&
    matchesHashInspection(report.replaced?.database, replacedDatabase, replacedDatabaseInspection) &&
    (activeProgram
      ? matchesHashInspection(report.active?.program, activeProgram, activeProgramInspection) &&
        matchesHashInspection(report.replaced?.program, replacedProgram, replacedProgramInspection)
      : !report.active?.program && !report.replaced?.program);
  if (!valid) throw switchError('ROLLBACK_REPORT_INVALID', '回滚报告身份或活动代际绑定无效');
}

async function removeCreatedDirectory(fsApi, directory) {
  if (!directory) return;
  try {
    await fsApi.rmdir(directory);
  } catch (error) {
    if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error?.code)) throw error;
  }
}

async function restoreAfterSwapFailure({
  fsApi,
  renameImpl,
  activeDatabase,
  archiveDatabase,
  stagedDatabase,
  activeProgram,
  archiveProgram,
  stagedProgram
}) {
  try {
    if (await exists(fsApi, archiveDatabase)) {
      if (await exists(fsApi, activeDatabase)) {
        const failedCandidate = `${stagedDatabase}.failed`;
        await renameImpl(activeDatabase, failedCandidate);
      }
      await renameImpl(archiveDatabase, activeDatabase);
    }
    if (activeProgram && archiveProgram && await exists(fsApi, archiveProgram)) {
      if (await exists(fsApi, activeProgram)) {
        const failedProgram = `${stagedProgram}.failed`;
        await renameImpl(activeProgram, failedProgram);
      }
      await renameImpl(archiveProgram, activeProgram);
    }
    return true;
  } catch {
    return false;
  }
}

export async function switchProductionData({
  mode = 'dry-run',
  dataRoot,
  candidate,
  activeProgram = '',
  candidateProgram = '',
  externalBackupRoot,
  runId,
  now = new Date().toISOString(),
  fsApi = defaultFs,
  activePathProbe = defaultActivePathProbe,
  copyFileImpl = (...args) => fsApi.copyFile(...args),
  renameImpl = (...args) => fsApi.rename(...args),
  writeReportAtomic = writeVerifiedJsonAtomic
}) {
  if (!['dry-run', 'apply'].includes(mode)) throw switchError('SWITCH_MODE_INVALID', '切换模式必须是 dry-run 或 apply');
  if (!dataRoot || !candidate) throw switchError('SWITCH_PATH_REQUIRED', '正式数据目录和候选 SQLite 均不能为空');
  const normalizedRunId = validateRunId(runId);
  const resolvedDataRoot = path.resolve(dataRoot);
  const candidatePath = path.resolve(candidate);
  const activeDatabase = path.join(resolvedDataRoot, SQLITE_FILE);
  const resolvedActiveProgram = activeProgram ? path.resolve(activeProgram) : '';
  const resolvedCandidateProgram = candidateProgram ? path.resolve(candidateProgram) : '';
  if (Boolean(resolvedActiveProgram) !== Boolean(resolvedCandidateProgram)) {
    throw switchError('PROGRAM_PAIR_REQUIRED', '程序切换必须同时提供当前程序和候选程序');
  }
  const resolvedBackupRoot = path.resolve(
    externalBackupRoot || path.join(path.dirname(resolvedDataRoot), `${path.basename(resolvedDataRoot)}-switch-backups`)
  );
  if (isInside(resolvedDataRoot, resolvedBackupRoot)) {
    throw switchError('EXTERNAL_BACKUP_ROOT_INVALID', '外部备份目录必须位于正式数据目录之外');
  }
  await assertPhysicalBackupBoundary(fsApi, resolvedDataRoot, resolvedBackupRoot);

  const archiveDirectory = path.join(resolvedDataRoot, 'legacy-archive', normalizedRunId);
  const externalDirectory = path.join(resolvedBackupRoot, normalizedRunId);
  if (await exists(fsApi, archiveDirectory) || await exists(fsApi, externalDirectory)) {
    throw switchError('RUN_ID_EXISTS', `run ID 已存在：${normalizedRunId}`);
  }
  const stagedDatabase = path.join(resolvedDataRoot, `.switch-${normalizedRunId}.sqlite`);
  const stagedProgram = resolvedCandidateProgram
    ? path.join(path.dirname(resolvedActiveProgram), `.switch-${normalizedRunId}-${path.basename(resolvedActiveProgram)}`)
    : '';
  const archiveDatabase = path.join(archiveDirectory, SQLITE_FILE);
  const archiveProgram = resolvedActiveProgram ? path.join(archiveDirectory, path.basename(resolvedActiveProgram)) : '';
  const reportFile = path.join(archiveDirectory, 'switch-report.json');
  const lineageFile = path.join(archiveDirectory, 'generation-lineage.json');
  const failedDatabase = `${stagedDatabase}.failed`;
  const failedProgram = stagedProgram ? `${stagedProgram}.failed` : '';
  if (mode === 'apply') {
    await assertPathsAbsent(
      fsApi,
      [stagedDatabase, stagedProgram, failedDatabase, failedProgram],
      'SWITCH_STAGING_EXISTS',
      '切换暂存或失败保留路径已存在，拒绝覆盖'
    );
  }

  await activityPreflight({
    fsApi, activePathProbe, dataRoot: resolvedDataRoot,
    activeDatabase, activeProgram: resolvedActiveProgram
  });

  const completedPhases = ['inspect'];
  const production = await inspectProductionRoot({
    dataRoot: resolvedDataRoot,
    activeProgram: resolvedActiveProgram,
    fsApi
  });
  if (!production.database) throw switchError('ACTIVE_DATABASE_MISSING', `正式 SQLite 不存在：${activeDatabase}`);
  if (resolvedActiveProgram && !production.program) {
    throw switchError('ACTIVE_PROGRAM_MISSING', `当前程序不存在：${resolvedActiveProgram}`);
  }
  const candidateInspection = await inspectSqlite(fsApi, candidatePath, '候选 SQLite');
  assertApprovedCandidate(candidateInspection);
  const candidateProgramInspection = resolvedCandidateProgram
    ? await inspectFile(fsApi, resolvedCandidateProgram)
    : null;
  completedPhases.push('verify-candidate');

  const baseReport = {
    ok: true,
    reportSchema: SWITCH_REPORT_SCHEMA,
    mode,
    applied: false,
    runId: normalizedRunId,
    now,
    dataRoot: resolvedDataRoot,
    candidate: candidateInspection,
    candidateProgram: candidateProgramInspection,
    production,
    externalBackupRoot: resolvedBackupRoot,
    completedPhases: [...completedPhases]
  };
  if (mode === 'dry-run') return baseReport;

  const externalDatabase = path.join(externalDirectory, SQLITE_FILE);
  const externalProgram = resolvedActiveProgram
    ? path.join(externalDirectory, path.basename(resolvedActiveProgram))
    : '';
  try {
    await fsApi.mkdir(externalDirectory, { recursive: true });
    await assertPhysicalBackupBoundary(fsApi, resolvedDataRoot, resolvedBackupRoot);
    await assertPhysicalBackupBoundary(fsApi, resolvedDataRoot, externalDirectory);
    await copyFileImpl(activeDatabase, externalDatabase, fsConstants.COPYFILE_EXCL);
    if (resolvedActiveProgram) {
      await copyFileImpl(resolvedActiveProgram, externalProgram, fsConstants.COPYFILE_EXCL);
    }
    completedPhases.push('backup-active');
    const externalDatabaseInspection = await verifyExactCopy(fsApi, activeDatabase, externalDatabase, '外部 SQLite 备份');
    inspectSqliteSync(externalDatabase, '外部 SQLite 备份');
    const externalProgramInspection = resolvedActiveProgram
      ? await verifyExactCopy(fsApi, resolvedActiveProgram, externalProgram, '外部程序备份')
      : null;
    completedPhases.push('verify-backup');

    const lineageDocument = makeGenerationLineageDocument(buildGenerationLineagePayload({
      runId: normalizedRunId,
      dataRoot: resolvedDataRoot,
      switchReportFile: reportFile,
      activeDatabase,
      candidateDatabaseInspection: candidateInspection,
      activeProgram: resolvedActiveProgram,
      activeProgramInspection: candidateProgramInspection,
      archiveDirectory,
      archiveDatabase,
      archiveDatabaseInspection: production.database,
      archiveProgram,
      archiveProgramInspection: production.program
    }));

    let stagedInspection;
    let stagedDatabaseCreated = false;
    let stagedProgramCreated = false;
    try {
      await copyFileImpl(candidatePath, stagedDatabase, fsConstants.COPYFILE_EXCL);
      stagedDatabaseCreated = true;
      if (resolvedCandidateProgram) {
        await copyFileImpl(resolvedCandidateProgram, stagedProgram, fsConstants.COPYFILE_EXCL);
        stagedProgramCreated = true;
      }
      completedPhases.push('stage-candidate');
      stagedInspection = await inspectSqlite(fsApi, stagedDatabase, '暂存候选 SQLite');
      assertApprovedCandidate(stagedInspection);
      if (stagedInspection.sha256 !== candidateInspection.sha256) {
        throw switchError('STAGED_DATABASE_MISMATCH', '暂存候选 SQLite 与来源 SHA-256 不一致');
      }
      if (resolvedCandidateProgram) {
        await verifyExactCopy(fsApi, resolvedCandidateProgram, stagedProgram, '暂存候选程序');
      }
      persistGenerationLineageSync(stagedDatabase, lineageDocument);
      stagedInspection = await inspectSqlite(fsApi, stagedDatabase, '带 lineage 的暂存候选 SQLite');
      const persistedLineage = readGenerationLineageSync(stagedDatabase);
      validateGenerationLineageDocument(
        persistedLineage,
        (({ lineageId, ...payload }) => payload)(lineageDocument)
      );
      if (canonicalJson(persistedLineage) !== canonicalJson(lineageDocument)) {
        throw switchError('GENERATION_LINEAGE_INVALID', '暂存候选 SQLite 的代际 lineage 重读不一致');
      }
      completedPhases.push('verify-staged');
    } catch (error) {
      await removeCreatedFiles(fsApi, [
        stagedDatabaseCreated ? stagedDatabase : '',
        stagedProgramCreated ? stagedProgram : ''
      ]);
      throw error;
    }

    try {
      await activityPreflight({
        fsApi, activePathProbe, dataRoot: resolvedDataRoot,
        activeDatabase, activeProgram: resolvedActiveProgram
      });
    } catch (error) {
      await removeCreatedFiles(fsApi, [stagedDatabase, stagedProgram]);
      await removeCreatedDirectory(fsApi, externalDirectory);
      throw error;
    }

    await fsApi.mkdir(archiveDirectory, { recursive: true });
    let swapError;
    try {
      await renameImpl(activeDatabase, archiveDatabase);
      await renameImpl(stagedDatabase, activeDatabase);
      if (resolvedActiveProgram) {
        await renameImpl(resolvedActiveProgram, archiveProgram);
        await renameImpl(stagedProgram, resolvedActiveProgram);
      }
      completedPhases.push('swap');
    } catch (error) {
      swapError = error;
    }
    if (swapError) {
      const restored = await restoreAfterSwapFailure({
        fsApi, renameImpl, activeDatabase, archiveDatabase, stagedDatabase,
        activeProgram: resolvedActiveProgram, archiveProgram, stagedProgram
      });
      if (!restored) {
        throw switchError('SWAP_ROLLBACK_FAILED', `交换失败且原程序/数据恢复失败：${swapError.message}`);
      }
      await removeCreatedDirectory(fsApi, archiveDirectory);
      throw switchError('SWAP_FAILED', `候选程序/数据交换失败，原字节已恢复：${swapError.message}`);
    }

    let activeInspection;
    let activeProgramInspection;
    try {
      activeInspection = await inspectSqlite(fsApi, activeDatabase, '切换后正式 SQLite');
      assertApprovedCandidate(activeInspection);
      if (activeInspection.sha256 !== stagedInspection.sha256) {
        throw switchError('ACTIVE_DATABASE_MISMATCH', '切换后 SQLite 与带 lineage 的暂存候选 SHA-256 不一致');
      }
      assertActiveGenerationLineage(activeDatabase, lineageDocument);
      activeProgramInspection = resolvedActiveProgram
        ? await inspectFile(fsApi, resolvedActiveProgram)
        : null;
      if (activeProgramInspection && activeProgramInspection.sha256 !== candidateProgramInspection.sha256) {
        throw switchError('ACTIVE_PROGRAM_MISMATCH', '切换后程序与候选 SHA-256 不一致');
      }
      completedPhases.push('verify-active');
    } catch (error) {
      const restored = await restoreAfterSwapFailure({
        fsApi, renameImpl, activeDatabase, archiveDatabase, stagedDatabase,
        activeProgram: resolvedActiveProgram, archiveProgram, stagedProgram
      });
      if (!restored) throw switchError('VERIFY_ROLLBACK_FAILED', `切换后校验失败且回滚失败：${error.message}`);
      throw switchError('ACTIVE_VERIFY_FAILED', `切换后校验失败，原字节已恢复：${error.message}`);
    }

    const archiveDatabaseInspection = await inspectFile(fsApi, archiveDatabase);
    const archiveProgramInspection = archiveProgram ? await inspectFile(fsApi, archiveProgram) : null;
    let lineageInspection;
    try {
      await writeVerifiedJsonAtomic({
        fsApi,
        finalPath: lineageFile,
        value: lineageDocument,
        validate: persisted => validateGenerationLineageDocument(
          persisted,
          (({ lineageId, ...payload }) => payload)(lineageDocument)
        )
      });
      lineageInspection = await inspectFile(fsApi, lineageFile);
    } catch (error) {
      const restored = await restoreAfterSwapFailure({
        fsApi, renameImpl, activeDatabase, archiveDatabase, stagedDatabase,
        activeProgram: resolvedActiveProgram, archiveProgram, stagedProgram
      });
      if (!restored) {
        throw switchError('REPORT_RECOVERY_FAILED', `lineage 报告失败且原程序/数据恢复失败：${error.message}`);
      }
      await removeCreatedFiles(fsApi, [lineageFile]);
      await removeCreatedDirectory(fsApi, archiveDirectory);
      throw switchError('REPORT_WRITE_FAILED', `原子 lineage 报告失败：${error.message}`);
    }
    const report = {
      ...baseReport,
      applied: true,
      completedPhases: [...completedPhases],
      active: { database: activeInspection, program: activeProgramInspection },
      archive: {
        directory: archiveDirectory,
        database: archiveDatabase,
        databaseInspection: archiveDatabaseInspection,
        program: archiveProgram,
        programInspection: archiveProgramInspection
      },
      externalBackup: {
        directory: externalDirectory,
        database: externalDatabase,
        databaseInspection: externalDatabaseInspection,
        program: externalProgram,
        programInspection: externalProgramInspection
      },
      generationLineage: {
        schema: GENERATION_LINEAGE_SCHEMA,
        lineageId: lineageDocument.lineageId,
        path: lineageFile,
        inspection: lineageInspection,
        sqliteTable: GENERATION_LINEAGE_TABLE,
        sqliteId: 1
      },
      rollback: {
        runId: normalizedRunId,
        dataRoot: resolvedDataRoot,
        activeProgram: resolvedActiveProgram
      }
    };
    let persistedReport;
    try {
      persistedReport = await writeReportAtomic({
        fsApi,
        finalPath: reportFile,
        value: report,
        validate: persisted => assertSwitchReportIdentity(persisted, {
          runId: normalizedRunId,
          dataRoot: resolvedDataRoot,
          archiveDirectory,
          activeDatabase,
          activeProgram: resolvedActiveProgram,
          externalBackupRoot: resolvedBackupRoot,
          externalDirectory,
          reportFile,
          requireLineage: true
        })
      });
    } catch (error) {
      const restored = await restoreAfterSwapFailure({
        fsApi, renameImpl, activeDatabase, archiveDatabase, stagedDatabase,
        activeProgram: resolvedActiveProgram, archiveProgram, stagedProgram
      });
      if (!restored) {
        throw switchError('REPORT_RECOVERY_FAILED', `报告失败且原程序/数据恢复失败：${error.message}`);
      }
      await removeCreatedFiles(fsApi, [lineageFile]);
      await removeCreatedDirectory(fsApi, archiveDirectory);
      throw error.code === 'REPORT_WRITE_FAILED'
        ? error
        : switchError('REPORT_WRITE_FAILED', `原子切换报告失败：${error.message}`);
    }
    return { ...persistedReport, reportFile };
  } catch (error) {
    if (![
      'SWAP_FAILED', 'SWAP_ROLLBACK_FAILED', 'VERIFY_ROLLBACK_FAILED', 'ACTIVE_VERIFY_FAILED',
      'REPORT_WRITE_FAILED', 'REPORT_RECOVERY_FAILED', 'ACTIVE_PATH_BLOCKED'
    ].includes(error.code)) {
      if (!completedPhases.includes('stage-candidate')) {
        await removeCreatedDirectory(fsApi, archiveDirectory);
      }
      if (completedPhases.length < 3) await removeCreatedDirectory(fsApi, externalDirectory);
      if (error.code === 'COPY_VERIFY_FAILED' || !error.code) {
        throw switchError('EXTERNAL_BACKUP_FAILED', `外部备份失败：${error.message}`);
      }
    }
    throw error;
  }
}

export async function rollbackProductionData({
  mode = 'dry-run',
  dataRoot,
  runId,
  activeProgram = '',
  externalBackupRoot,
  now = new Date().toISOString(),
  fsApi = defaultFs,
  activePathProbe = defaultActivePathProbe,
  copyFileImpl = (...args) => fsApi.copyFile(...args),
  renameImpl = (...args) => fsApi.rename(...args),
  writeReportAtomic = writeVerifiedJsonAtomic
}) {
  if (!['dry-run', 'apply'].includes(mode)) {
    throw switchError('ROLLBACK_MODE_INVALID', '回滚模式必须是 dry-run 或 apply');
  }
  if (!dataRoot) throw switchError('DATA_ROOT_REQUIRED', '正式数据目录不能为空');
  if (!externalBackupRoot) {
    throw switchError('EXTERNAL_BACKUP_ROOT_REQUIRED', '回滚必须提供外部备份目录');
  }
  const normalizedRunId = validateRunId(runId);
  const resolvedRoot = path.resolve(dataRoot);
  const resolvedBackupRoot = path.resolve(externalBackupRoot);
  if (isInside(resolvedRoot, resolvedBackupRoot)) {
    throw switchError('EXTERNAL_BACKUP_ROOT_INVALID', '外部备份目录必须位于正式数据目录之外');
  }
  await assertPhysicalBackupBoundary(fsApi, resolvedRoot, resolvedBackupRoot);
  const activeDatabase = path.join(resolvedRoot, SQLITE_FILE);
  const archiveDirectory = path.join(resolvedRoot, 'legacy-archive', normalizedRunId);
  const externalDirectory = path.join(resolvedBackupRoot, normalizedRunId);
  await assertPhysicalBackupBoundary(fsApi, resolvedRoot, externalDirectory);
  const reportFile = path.join(archiveDirectory, 'switch-report.json');
  const rollbackReportFile = path.join(archiveDirectory, 'rollback-report.json');
  if (!(await exists(fsApi, reportFile))) throw switchError('SWITCH_REPORT_MISSING', '找不到对应切换报告');
  if (await exists(fsApi, rollbackReportFile)) throw switchError('ROLLBACK_ALREADY_APPLIED', '该 run ID 已执行过回滚');
  const switchReportBytes = await fsApi.readFile(reportFile);
  let switchReport;
  try {
    switchReport = JSON.parse(switchReportBytes.toString('utf8'));
  } catch (error) {
    throw switchError('SWITCH_REPORT_INVALID', `切换报告不是有效 JSON：${error.message}`);
  }
  const reportedActiveProgram = typeof switchReport.production?.activeProgram === 'string'
    ? switchReport.production.activeProgram
    : '';
  const resolvedActiveProgram = activeProgram ? path.resolve(activeProgram) : reportedActiveProgram;
  if (activeProgram && !samePath(resolvedActiveProgram, reportedActiveProgram)) {
    throw switchError('SWITCH_REPORT_INVALID', '指定的当前程序与切换报告不一致');
  }
  if (!samePath(switchReport.externalBackupRoot, resolvedBackupRoot)) {
    throw switchError('EXTERNAL_BACKUP_ROOT_MISMATCH', '指定的外部备份目录与切换报告不一致');
  }
  const { archiveDatabase, archiveProgram, externalDatabase, externalProgram, lineage } = assertSwitchReportIdentity(switchReport, {
    runId: normalizedRunId,
    dataRoot: resolvedRoot,
    archiveDirectory,
    activeDatabase,
    activeProgram: resolvedActiveProgram,
    externalBackupRoot: resolvedBackupRoot,
    externalDirectory,
    reportFile
  });
  if (!(await exists(fsApi, archiveDatabase))) {
    throw switchError('ARCHIVE_DATABASE_INVALID', '归档 SQLite 不存在');
  }
  if (archiveProgram && !(await exists(fsApi, archiveProgram))) {
    throw switchError('ARCHIVE_PROGRAM_INVALID', '归档程序不存在');
  }
  if (!(await exists(fsApi, externalDatabase))) {
    throw switchError('EXTERNAL_BACKUP_DATABASE_MISSING', '外部备份 SQLite 不存在');
  }
  if (externalProgram && !(await exists(fsApi, externalProgram))) {
    throw switchError('EXTERNAL_BACKUP_PROGRAM_MISSING', '外部备份程序不存在');
  }

  let externalDatabaseInspection;
  try {
    externalDatabaseInspection = await inspectSqlite(fsApi, externalDatabase, '外部备份 SQLite');
  } catch (error) {
    throw switchError('EXTERNAL_BACKUP_DATABASE_INVALID', `外部备份 SQLite 完整性检查失败：${error.message}`);
  }
  if (
    externalDatabaseInspection.size !== switchReport.externalBackup.databaseInspection.size ||
    externalDatabaseInspection.sha256 !== switchReport.externalBackup.databaseInspection.sha256
  ) {
    throw switchError('EXTERNAL_BACKUP_DATABASE_MISMATCH', '外部备份 SQLite 大小或 SHA-256 与切换报告不一致');
  }
  let externalProgramInspection = null;
  if (externalProgram) {
    externalProgramInspection = await inspectFile(fsApi, externalProgram);
    if (
      externalProgramInspection.size !== switchReport.externalBackup.programInspection.size ||
      externalProgramInspection.sha256 !== switchReport.externalBackup.programInspection.sha256
    ) {
      throw switchError('EXTERNAL_BACKUP_PROGRAM_MISMATCH', '外部备份程序大小或 SHA-256 与切换报告不一致');
    }
  }

  let lineageDocument = null;
  if (lineage) {
    if (!(await exists(fsApi, lineage.lineageFile))) {
      throw switchError('GENERATION_LINEAGE_INVALID', '切换报告绑定的代际 lineage 文件不存在');
    }
    const lineageInspection = await inspectFile(fsApi, lineage.lineageFile);
    if (
      lineageInspection.size !== switchReport.generationLineage.inspection.size ||
      lineageInspection.sha256 !== switchReport.generationLineage.inspection.sha256
    ) {
      throw switchError('GENERATION_LINEAGE_INVALID', '代际 lineage 文件大小或 SHA-256 与切换报告不一致');
    }
    try {
      lineageDocument = JSON.parse(await fsApi.readFile(lineage.lineageFile, 'utf8'));
      validateGenerationLineageDocument(
        lineageDocument,
        (({ lineageId, ...payload }) => payload)(lineage.expectedDocument)
      );
      if (canonicalJson(lineageDocument) !== canonicalJson(lineage.expectedDocument)) {
        throw switchError('GENERATION_LINEAGE_INVALID', '代际 lineage 文件与切换报告绑定不一致');
      }
    } catch (error) {
      if (error?.code === 'GENERATION_LINEAGE_INVALID') throw error;
      throw switchError('GENERATION_LINEAGE_INVALID', `代际 lineage 文件解析失败：${error.message}`);
    }
  }

  await activityPreflight({
    fsApi, activePathProbe, dataRoot: resolvedRoot,
    activeDatabase, activeProgram: resolvedActiveProgram
  });

  const [archiveDatabaseInspection, initialCurrentDatabaseInspection] = await Promise.all([
    inspectSqlite(fsApi, archiveDatabase, '归档 SQLite'),
    inspectSqlite(fsApi, activeDatabase, '当前活动 SQLite')
  ]);
  let currentDatabaseInspection = initialCurrentDatabaseInspection;
  if (archiveDatabaseInspection.sha256 !== switchReport.archive.databaseInspection.sha256) {
    throw switchError('ARCHIVE_DATABASE_HASH_MISMATCH', '归档 SQLite SHA-256 与切换报告不一致');
  }
  if (lineageDocument) {
    assertActiveGenerationLineage(activeDatabase, lineageDocument);
  } else if (currentDatabaseInspection.sha256 !== switchReport.active.database.sha256) {
    throw switchError('ACTIVE_GENERATION_MISMATCH', '当前活动 SQLite 已不是该切换报告绑定的代际');
  }
  let archiveProgramInspection = null;
  let currentProgramInspection = null;
  if (resolvedActiveProgram) {
    [archiveProgramInspection, currentProgramInspection] = await Promise.all([
      inspectFile(fsApi, archiveProgram),
      inspectFile(fsApi, resolvedActiveProgram)
    ]);
    if (archiveProgramInspection.sha256 !== switchReport.archive.programInspection.sha256) {
      throw switchError('ARCHIVE_PROGRAM_HASH_MISMATCH', '归档程序 SHA-256 与切换报告不一致');
    }
    if (currentProgramInspection.sha256 !== switchReport.active.program.sha256) {
      throw switchError('ACTIVE_GENERATION_MISMATCH', '当前活动程序已不是该切换报告绑定的代际');
    }
  }

  const switchReportHash = createHash('sha256').update(switchReportBytes).digest('hex');
  const completedPhases = ['inspect-report', 'verify-generation', 'preflight-1'];
  const baseReport = {
    ok: true,
    mode,
    applied: false,
    rolledBack: false,
    runId: normalizedRunId,
    now,
    dataRoot: resolvedRoot,
    production: { database: currentDatabaseInspection, program: currentProgramInspection },
    archive: {
      directory: archiveDirectory,
      database: archiveDatabaseInspection,
      program: archiveProgramInspection
    },
    externalBackup: {
      directory: externalDirectory,
      database: externalDatabaseInspection,
      program: externalProgramInspection
    },
    switchReportHash,
    blockers: [],
    completedPhases: [...completedPhases]
  };
  if (mode === 'dry-run') return baseReport;

  const rollbackStageDatabase = path.join(resolvedRoot, `.rollback-${normalizedRunId}.sqlite`);
  const rollbackStageProgram = resolvedActiveProgram
    ? path.join(path.dirname(resolvedActiveProgram), `.rollback-${normalizedRunId}-${path.basename(resolvedActiveProgram)}`)
    : '';
  const replacedDatabase = path.join(archiveDirectory, 'after-switch.sqlite');
  const replacedProgram = resolvedActiveProgram
    ? path.join(archiveDirectory, `after-switch-${path.basename(resolvedActiveProgram)}`)
    : '';
  const failedDatabase = `${rollbackStageDatabase}.failed`;
  const failedProgram = rollbackStageProgram ? `${rollbackStageProgram}.failed` : '';
  await assertPathsAbsent(
    fsApi,
    [rollbackStageDatabase, rollbackStageProgram, failedDatabase, failedProgram],
    'ROLLBACK_STAGING_EXISTS',
    '回滚暂存或失败保留路径已存在，拒绝覆盖'
  );
  await assertPathsAbsent(
    fsApi,
    [replacedDatabase, replacedProgram],
    'ROLLBACK_TARGET_EXISTS',
    '回滚保留路径已存在，拒绝覆盖'
  );

  let rollbackStageDatabaseCreated = false;
  let rollbackStageProgramCreated = false;
  try {
    await copyFileImpl(archiveDatabase, rollbackStageDatabase, fsConstants.COPYFILE_EXCL);
    rollbackStageDatabaseCreated = true;
    if (resolvedActiveProgram) {
      await copyFileImpl(archiveProgram, rollbackStageProgram, fsConstants.COPYFILE_EXCL);
      rollbackStageProgramCreated = true;
    }
    await verifyExactCopy(fsApi, archiveDatabase, rollbackStageDatabase, '回滚 SQLite 暂存');
    if (resolvedActiveProgram) {
      await verifyExactCopy(fsApi, archiveProgram, rollbackStageProgram, '回滚程序暂存');
    }
    completedPhases.push('stage-archive', 'verify-staged');
  } catch (error) {
    await removeCreatedFiles(fsApi, [
      rollbackStageDatabaseCreated ? rollbackStageDatabase : '',
      rollbackStageProgramCreated ? rollbackStageProgram : ''
    ]);
    throw error;
  }

  try {
    await activityPreflight({
      fsApi, activePathProbe, dataRoot: resolvedRoot,
      activeDatabase, activeProgram: resolvedActiveProgram
    });
  } catch (error) {
    await removeCreatedFiles(fsApi, [rollbackStageDatabase, rollbackStageProgram]);
    throw error;
  }
  completedPhases.push('preflight-2');

  currentDatabaseInspection = await inspectSqlite(fsApi, activeDatabase, '回滚交换前活动 SQLite');
  if (lineageDocument) {
    assertActiveGenerationLineage(activeDatabase, lineageDocument);
  } else if (currentDatabaseInspection.sha256 !== switchReport.active.database.sha256) {
    throw switchError('ACTIVE_GENERATION_MISMATCH', '回滚交换前活动 SQLite 已不是该切换报告绑定的代际');
  }
  if (resolvedActiveProgram) {
    currentProgramInspection = await inspectFile(fsApi, resolvedActiveProgram);
    if (currentProgramInspection.sha256 !== switchReport.active.program.sha256) {
      throw switchError('ACTIVE_GENERATION_MISMATCH', '回滚交换前活动程序已不是该切换报告绑定的代际');
    }
  }

  let databaseMoved = false;
  let programMoved = false;
  let replacedDatabaseInspection = null;
  let replacedProgramInspection = null;
  try {
    await renameImpl(activeDatabase, replacedDatabase);
    databaseMoved = true;
    replacedDatabaseInspection = await inspectSqlite(fsApi, replacedDatabase, '回滚前保留的切换后 SQLite');
    if (
      replacedDatabaseInspection.size !== currentDatabaseInspection.size ||
      replacedDatabaseInspection.sha256 !== currentDatabaseInspection.sha256
    ) {
      throw switchError('ROLLBACK_REPLACED_DATABASE_MISMATCH', '回滚前保留的切换后 SQLite 代际不一致');
    }
    await renameImpl(rollbackStageDatabase, activeDatabase);
    if (resolvedActiveProgram) {
      await renameImpl(resolvedActiveProgram, replacedProgram);
      programMoved = true;
      replacedProgramInspection = await inspectFile(fsApi, replacedProgram);
      if (
        replacedProgramInspection.size !== currentProgramInspection.size ||
        replacedProgramInspection.sha256 !== currentProgramInspection.sha256
      ) {
        throw switchError('ROLLBACK_REPLACED_PROGRAM_MISMATCH', '回滚前保留的切换后程序代际不一致');
      }
      await renameImpl(rollbackStageProgram, resolvedActiveProgram);
    }
    completedPhases.push('swap');
    const activeInspection = await inspectSqlite(fsApi, activeDatabase, '回滚后活动 SQLite');
    const archivedInspection = await inspectSqlite(fsApi, archiveDatabase, '回滚归档 SQLite');
    if (activeInspection.sha256 !== archivedInspection.sha256) {
      throw switchError('ROLLBACK_DATABASE_MISMATCH', '回滚后 SQLite 与归档 SHA-256 不一致');
    }
    let activeProgramInspection = null;
    if (resolvedActiveProgram) {
      activeProgramInspection = await inspectFile(fsApi, resolvedActiveProgram);
      const archivedProgramInspection = await inspectFile(fsApi, archiveProgram);
      if (activeProgramInspection.sha256 !== archivedProgramInspection.sha256) {
        throw switchError('ROLLBACK_PROGRAM_MISMATCH', '回滚后程序与归档 SHA-256 不一致');
      }
    }
    completedPhases.push('verify-active');
    const report = {
      ok: true,
      mode: 'apply',
      applied: true,
      rolledBack: true,
      runId: normalizedRunId,
      now,
      dataRoot: resolvedRoot,
      active: { database: activeInspection, program: activeProgramInspection },
      replaced: { database: replacedDatabaseInspection, program: replacedProgramInspection },
      switchReportHash,
      completedPhases: [...completedPhases]
    };
    const persistedReport = await writeReportAtomic({
      fsApi,
      finalPath: rollbackReportFile,
      value: report,
      validate: persisted => validateRollbackReport(persisted, {
        runId: normalizedRunId,
        dataRoot: resolvedRoot,
        activeDatabase,
        activeProgram: resolvedActiveProgram,
        replacedDatabase,
        replacedProgram,
        switchReportHash,
        activeDatabaseInspection: activeInspection,
        activeProgramInspection,
        replacedDatabaseInspection,
        replacedProgramInspection
      })
    });
    return { ...persistedReport, rollbackReportFile };
  } catch (error) {
    try {
      if (programMoved) {
        if (await exists(fsApi, resolvedActiveProgram)) await renameImpl(resolvedActiveProgram, failedProgram);
        await renameImpl(replacedProgram, resolvedActiveProgram);
      }
      if (databaseMoved) {
        if (await exists(fsApi, activeDatabase)) await renameImpl(activeDatabase, failedDatabase);
        await renameImpl(replacedDatabase, activeDatabase);
      }
    } catch (recoveryError) {
      throw switchError(
        'ROLLBACK_RECOVERY_FAILED',
        `回滚失败且无法恢复切换后版本：${error.message}; ${recoveryError.message}`,
        {
          activeDatabase,
          activeProgram: resolvedActiveProgram,
          replacedDatabase,
          replacedProgram,
          failedDatabase,
          failedProgram
        }
      );
    }
    throw switchError('ROLLBACK_FAILED', `回滚失败，切换后版本已恢复：${error.message}`);
  }
}

export { SWITCH_PHASES };
