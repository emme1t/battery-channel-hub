import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, readFile, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { parseArgs } from 'node:util';

import { createLegacySqliteStore, SQLITE_FILE } from '../src/main/legacy-sqlite-store.mjs';
import { normalizeLegacyState } from '../src/main/legacy-state-schema.mjs';

const require = createRequire(import.meta.url);
const preset = require('../lib/device-preset.js');
const PRESET_SHA256 = 'a964640116eece6c5995f01b5f92e41ce3fc1ca08aae0b8b0bc45152c36f6bbf';

const usage = `Usage:
  node scripts/create-production-sqlite.mjs --target-dir <candidate-dir> [--apply] [--replace]

Dry-run is the default. It validates the approved 26-device/529-channel preset and inspects an
existing candidate SQLite read-only, but does not create or modify the target directory.
--apply     Explicitly create the candidate SQLite after all validation gates pass.
--replace   Permit replacement of an existing valid candidate only after retaining and verifying
            an exact SQLite backup. This flag has no write effect without --apply.
`;

function summaryOf(state) {
  return {
    devices: state.deviceProfiles.length,
    channels: state.channels.length,
    requests: state.requests.length,
    records: state.records.length,
    samples: state.samples.length,
    auditLogs: state.auditLogs.length
  };
}

function sha256Value(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

async function sha256File(filePath) {
  return createHash('sha256').update(await readFile(filePath)).digest('hex');
}

async function exists(filePath) {
  try {
    await stat(filePath);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

function coded(code, message, details = undefined) {
  const error = new Error(message);
  error.code = code;
  if (details !== undefined) error.details = details;
  return error;
}

function candidateState(now) {
  return normalizeLegacyState({
    revision: 0,
    requests: [],
    samples: [],
    records: [],
    requestSourceRows: [],
    auditLogs: [{
      id: `AUDIT-CHANNEL-PRESET-${now.replace(/[^0-9]/g, '')}`,
      time: now,
      user: '系统',
      action: '初始化设备与通道预设',
      target: '26 台设备 / 529 个通道',
      before: null,
      after: { devices: 26, channels: 529 },
      level: 'normal',
      note: `权威预设 SHA-256 ${PRESET_SHA256}`
    }],
    formChangeJournal: [],
    testers: [],
    deviceProfiles: preset.devices(),
    channels: preset.channels(),
    username: '系统',
    savedAt: now
  });
}

function inspectSqlite(filePath) {
  let db;
  try {
    db = new DatabaseSync(filePath, { readOnly: true });
    const integrityRow = db.prepare('PRAGMA integrity_check').get();
    const integrity = String(integrityRow?.integrity_check || '');
    if (integrity !== 'ok') {
      throw coded('TARGET_INTEGRITY_FAILED', `SQLite integrity_check 未通过：${integrity || '无结果'}`);
    }
    const row = db.prepare('SELECT revision, payload FROM app_state WHERE id = 1').get();
    if (!row) throw coded('TARGET_STATE_MISSING', '候选 SQLite 缺少 app_state 状态行');
    const state = normalizeLegacyState(JSON.parse(row.payload));
    state.revision = Number(row.revision);
    return { integrity, revision: state.revision, summary: summaryOf(state) };
  } catch (error) {
    if (error.code) throw error;
    throw coded('TARGET_INVALID', `候选 SQLite 只读检查失败：${error.message}`);
  } finally {
    db?.close();
  }
}

async function assertNoSidecars(databasePath) {
  const sidecars = [`${databasePath}-journal`, `${databasePath}-wal`, `${databasePath}-shm`];
  const present = [];
  for (const sidecar of sidecars) {
    if (await exists(sidecar)) present.push(sidecar);
  }
  if (present.length) {
    throw coded(
      'TARGET_ACTIVE_OR_UNCLEAN',
      '候选 SQLite 存在事务旁文件，拒绝替换；请先正常关闭使用该库的程序',
      { sidecars: present }
    );
  }
}

function safeStamp(now) {
  return now.replace(/[:.]/g, '-');
}

async function createAndVerifyStaging(targetDir, state, now) {
  const stagingDir = await mkdtemp(path.join(targetDir, '.candidate-staging-'));
  const store = await createLegacySqliteStore({ dataRoot: stagingDir, clock: () => now });
  try {
    const saved = await store.save({ expectedRevision: 0, state, journalEntries: [] });
    if (!saved.ok) throw coded(saved.code || 'CANDIDATE_WRITE_FAILED', saved.message);
  } finally {
    store.close();
  }
  const filePath = path.join(stagingDir, SQLITE_FILE);
  const inspection = inspectSqlite(filePath);
  if (JSON.stringify(inspection.summary) !== JSON.stringify(summaryOf(state))) {
    await rm(stagingDir, { recursive: true, force: true });
    throw coded('CANDIDATE_VERIFY_FAILED', '候选 SQLite 写后数量核验不一致');
  }
  return { stagingDir, filePath, inspection };
}

async function applyCandidate({ targetDir, databasePath, targetExists, replace, state, now }) {
  if (targetExists && !replace) {
    throw coded('TARGET_EXISTS', '目标已存在；必须显式提供 --replace 才能替换');
  }
  if (targetExists) await assertNoSidecars(databasePath);

  await mkdir(targetDir, { recursive: true });
  const staging = await createAndVerifyStaging(targetDir, state, now);
  let backup = null;
  try {
    if (targetExists) {
      const sourceHash = await sha256File(databasePath);
      const backupPath = path.join(targetDir, `${SQLITE_FILE}.backup-${safeStamp(now)}.sqlite`);
      if (await exists(backupPath)) {
        throw coded('BACKUP_EXISTS', `备份路径已存在，拒绝覆盖：${backupPath}`);
      }
      await rename(databasePath, backupPath);
      try {
        const backupInspection = inspectSqlite(backupPath);
        const backupHash = await sha256File(backupPath);
        if (backupHash !== sourceHash) {
          throw coded('BACKUP_HASH_MISMATCH', '替换前备份 SHA-256 与原目标不一致');
        }
        backup = {
          path: backupPath,
          sha256: backupHash,
          integrity: backupInspection.integrity,
          revision: backupInspection.revision,
          summary: backupInspection.summary
        };
      } catch (error) {
        await rename(backupPath, databasePath);
        throw error;
      }
    }

    try {
      await rename(staging.filePath, databasePath);
    } catch (error) {
      if (backup?.path && !(await exists(databasePath))) {
        await rename(backup.path, databasePath);
      }
      throw coded('TARGET_REPLACE_FAILED', `候选 SQLite 切换失败：${error.message}`);
    }
  } finally {
    await rm(staging.stagingDir, { recursive: true, force: true });
  }

  const finalInspection = inspectSqlite(databasePath);
  return {
    finalInspection,
    backup
  };
}

async function main() {
  let parsed;
  try {
    parsed = parseArgs({
      options: {
        'target-dir': { type: 'string' },
        apply: { type: 'boolean', default: false },
        replace: { type: 'boolean', default: false },
        help: { type: 'boolean', short: 'h', default: false }
      },
      strict: true,
      allowPositionals: false
    });
  } catch (error) {
    throw coded('INVALID_ARGUMENTS', error.message);
  }

  if (parsed.values.help) {
    process.stdout.write(usage);
    return;
  }
  if (!parsed.values['target-dir']) {
    throw coded('INVALID_ARGUMENTS', '--target-dir is required');
  }

  const now = new Date().toISOString();
  const targetDir = path.resolve(parsed.values['target-dir']);
  const databasePath = path.join(targetDir, SQLITE_FILE);
  const state = candidateState(now);
  const actualPresetHash = sha256Value({ devices: preset.devices(), channels: preset.channels() });
  if (actualPresetHash !== PRESET_SHA256) {
    throw coded('PRESET_HASH_MISMATCH', '设备通道预设 SHA-256 与批准值不一致');
  }

  const targetExists = await exists(databasePath);
  const existing = targetExists ? inspectSqlite(databasePath) : null;
  const baseReport = {
    ok: true,
    mode: parsed.values.apply ? 'apply' : 'dry-run',
    applied: false,
    replaced: false,
    targetDir,
    databasePath,
    presetSha256: actualPresetHash,
    summary: summaryOf(state),
    existing
  };

  if (!parsed.values.apply) {
    process.stdout.write(`${JSON.stringify(baseReport, null, 2)}\n`);
    return;
  }

  const result = await applyCandidate({
    targetDir,
    databasePath,
    targetExists,
    replace: parsed.values.replace,
    state,
    now
  });
  process.stdout.write(`${JSON.stringify({
    ...baseReport,
    applied: true,
    replaced: targetExists,
    backup: result.backup,
    result: result.finalInspection
  }, null, 2)}\n`);
}

try {
  await main();
} catch (error) {
  process.stdout.write(`${JSON.stringify({
    ok: false,
    code: error.code || 'CANDIDATE_CREATE_FAILED',
    message: error.message,
    details: error.details
  }, null, 2)}\n`);
  process.exitCode = error.code === 'INVALID_ARGUMENTS' ? 3 : 4;
}
