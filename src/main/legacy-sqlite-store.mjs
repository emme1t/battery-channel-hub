import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { normalizeLegacyState } from './legacy-state-schema.mjs';

const SQLITE_FILE = 'battery-channel-hub.sqlite';

function emptyLegacyState() {
  return {
    revision: 0,
    requests: [],
    channels: [],
    deviceProfiles: [],
    records: [],
    samples: [],
    requestSourceRows: [],
    auditLogs: [],
    formChangeJournal: [],
    testers: [],
    username: 'user001',
    savedAt: ''
  };
}

function failure(code, message, details = undefined) {
  const result = { ok: false, code, message };
  if (details !== undefined) result.details = details;
  return result;
}

function parseJson(value, fallback = null) {
  if (value === null || value === undefined || value === '') return fallback;
  return JSON.parse(value);
}

function journalFromRow(row) {
  return {
    id: row.id,
    requestId: row.request_id || '',
    action: row.action || '',
    time: row.time || '',
    user: row.user || '',
    before: parseJson(row.before_json),
    after: parseJson(row.after_json),
    source: parseJson(row.source_json),
    level: row.level || 'warning',
    note: row.note || ''
  };
}

function mergeJournal(...collections) {
  const byId = new Map();
  for (const collection of collections) {
    for (const item of collection || []) {
      if (item?.id) byId.set(String(item.id), structuredClone(item));
    }
  }
  return [...byId.values()].sort((left, right) =>
    String(left.time || '').localeCompare(String(right.time || '')) ||
    String(left.id).localeCompare(String(right.id))
  );
}

function ensureSchema(db) {
  db.exec(`
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS app_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      revision INTEGER NOT NULL DEFAULT 0,
      payload TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS form_change_journal (
      id TEXT PRIMARY KEY,
      request_id TEXT,
      action TEXT,
      time TEXT NOT NULL,
      user TEXT,
      before_json TEXT,
      after_json TEXT,
      source_json TEXT,
      level TEXT,
      note TEXT
    );
  `);

  const columns = db.prepare('PRAGMA table_info(app_state)').all();
  if (!columns.some(column => column.name === 'revision')) {
    db.exec('ALTER TABLE app_state ADD COLUMN revision INTEGER NOT NULL DEFAULT 0');
  }
}

function readLogicalState(db) {
  const row = db.prepare('SELECT revision, payload FROM app_state WHERE id = 1').get();
  const state = row ? normalizeLegacyState(parseJson(row.payload)) : normalizeLegacyState(emptyLegacyState());
  if (row) state.revision = Number(row.revision);
  const journalRows = db.prepare(`
    SELECT id, request_id, action, time, user, before_json, after_json, source_json, level, note
    FROM form_change_journal
    ORDER BY time ASC, id ASC
  `).all();
  state.formChangeJournal = mergeJournal(
    state.formChangeJournal,
    journalRows.map(journalFromRow)
  );
  return normalizeLegacyState(state);
}

function insertJournal(db, entry) {
  if (!entry?.id) {
    const error = new Error('表单日志缺少 id');
    error.code = 'JOURNAL_ID_MISSING';
    throw error;
  }
  db.prepare(`
    INSERT OR IGNORE INTO form_change_journal(
      id, request_id, action, time, user, before_json, after_json, source_json, level, note
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    String(entry.id),
    String(entry.requestId ?? entry.request_id ?? ''),
    String(entry.action ?? ''),
    String(entry.time ?? ''),
    String(entry.user ?? ''),
    entry.before === undefined || entry.before === null ? null : JSON.stringify(entry.before),
    entry.after === undefined || entry.after === null ? null : JSON.stringify(entry.after),
    entry.source === undefined || entry.source === null ? null : JSON.stringify(entry.source),
    String(entry.level ?? 'warning'),
    String(entry.note ?? '')
  );
}

export async function createLegacySqliteStore({
  dataRoot,
  clock = () => new Date().toISOString()
}) {
  if (!dataRoot) throw new Error('dataRoot is required');
  const resolvedRoot = path.resolve(dataRoot);
  await mkdir(resolvedRoot, { recursive: true });
  const filePath = path.join(resolvedRoot, SQLITE_FILE);
  const db = new DatabaseSync(filePath);
  ensureSchema(db);
  let closed = false;

  function assertOpen() {
    if (closed) throw new Error('legacy sqlite store is closed');
  }

  return {
    filePath,

    async load() {
      assertOpen();
      try {
        return { ok: true, state: readLogicalState(db) };
      } catch (error) {
        return failure(error.code || 'STATE_READ_FAILED', error.message);
      }
    },

    async save({ expectedRevision, state, journalEntries = [] }) {
      assertOpen();
      let normalized;
      try {
        normalized = normalizeLegacyState(state);
      } catch (error) {
        return failure(error.code || 'STATE_INVALID', error.message, error.details);
      }

      try {
        db.exec('BEGIN IMMEDIATE');
        const row = db.prepare('SELECT revision FROM app_state WHERE id = 1').get();
        const currentRevision = row ? Number(row.revision) : 0;
        if (!Number.isInteger(expectedRevision) || expectedRevision !== currentRevision) {
          db.exec('ROLLBACK');
          return failure(
            'REVISION_CONFLICT',
            `状态修订冲突：当前 ${currentRevision}，提交 ${String(expectedRevision)}`,
            { currentRevision, expectedRevision }
          );
        }

        const nextState = normalizeLegacyState({
          ...normalized,
          revision: currentRevision + 1,
          savedAt: String(clock())
        });
        for (const entry of mergeJournal(nextState.formChangeJournal, journalEntries)) {
          insertJournal(db, entry);
        }
        db.prepare(`
          INSERT INTO app_state(id, revision, payload, updated_at)
          VALUES (1, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            revision = excluded.revision,
            payload = excluded.payload,
            updated_at = excluded.updated_at
        `).run(nextState.revision, JSON.stringify(nextState), nextState.savedAt);
        db.exec('COMMIT');
        return { ok: true, state: readLogicalState(db) };
      } catch (error) {
        try {
          db.exec('ROLLBACK');
        } catch {
          // The original error remains the actionable failure.
        }
        return failure('PERSISTENCE_FAILED', error.message);
      }
    },

    async replaceExact({ expectedRevision, state }) {
      assertOpen();
      let normalized;
      try {
        normalized = normalizeLegacyState(state);
        const journalIds = normalized.formChangeJournal.map(entry => String(entry?.id || ''));
        if (journalIds.some(id => !id) || new Set(journalIds).size !== journalIds.length) {
          return failure('JOURNAL_SET_INVALID', '精确替换的表单日志标识缺失或重复');
        }
      } catch (error) {
        return failure(error.code || 'STATE_INVALID', error.message, error.details);
      }

      try {
        db.exec('BEGIN IMMEDIATE');
        const row = db.prepare('SELECT revision FROM app_state WHERE id = 1').get();
        const currentRevision = row ? Number(row.revision) : 0;
        if (!Number.isInteger(expectedRevision) || expectedRevision !== currentRevision) {
          db.exec('ROLLBACK');
          return failure(
            'REVISION_CONFLICT',
            `状态修订冲突：当前 ${currentRevision}，提交 ${String(expectedRevision)}`,
            { currentRevision, expectedRevision }
          );
        }

        db.prepare('DELETE FROM form_change_journal').run();
        for (const entry of normalized.formChangeJournal) insertJournal(db, entry);
        db.prepare(`
          INSERT INTO app_state(id, revision, payload, updated_at)
          VALUES (1, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            revision = excluded.revision,
            payload = excluded.payload,
            updated_at = excluded.updated_at
        `).run(normalized.revision, JSON.stringify(normalized), normalized.savedAt);
        db.exec('COMMIT');
        return { ok: true, state: readLogicalState(db) };
      } catch (error) {
        try {
          db.exec('ROLLBACK');
        } catch {
          // The original error remains the actionable failure.
        }
        return failure('PERSISTENCE_FAILED', error.message);
      }
    },

    close() {
      if (closed) return;
      closed = true;
      db.close();
    }
  };
}

export { SQLITE_FILE };
