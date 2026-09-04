import { createHash } from 'node:crypto';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { SQLITE_FILE } from '../../src/main/legacy-sqlite-store.mjs';
import { COLLECTIONS, normalizeLegacyState } from '../../src/main/legacy-state-schema.mjs';

const PAGE_AUDIT_PATTERN = /查看页面|页面访问|访问页面|\b(?:page[\s._-]?(?:view|visit|navigate)|navigate|navigation)\b/i;
const PAGE_AUDIT_TIME_KEYS = new Set(['time', 'at', 'timestamp', 'visitedAt']);
const KEYED_COLLECTIONS = Object.freeze({
  requests: 'id',
  samples: 'id',
  deviceProfiles: 'id',
  records: 'id',
  storageRecords: 'id',
  auditLogs: 'id',
  formChangeJournal: 'id',
  channels: 'key'
});
const SOURCE_ROW_IDENTITY_KEYS = Object.freeze([
  'id', 'requestNo', '申请单号', '委托单号', 'sourceFile', 'sourcePath', '来源'
]);

function collection(value, key) {
  return Array.isArray(value?.[key]) ? value[key] : [];
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.keys(value).sort().map(key => [key, stableValue(value[key])])
  );
}

function isEntity(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function nonEmptyField(entity, key) {
  const value = entity?.[key];
  return (typeof value === 'string' || typeof value === 'number') && String(value).trim() !== '';
}

function validateKeyedCollection(state, collectionName, key) {
  const seen = new Set();
  for (const [index, entity] of state[collectionName].entries()) {
    if (!isEntity(entity) || !nonEmptyField(entity, key)) {
      throw new TypeError(`${collectionName}[${index}] must be an object with non-empty ${key}`);
    }
    const id = String(entity[key]).trim();
    if (seen.has(id)) throw new TypeError(`${collectionName} contains duplicate ${key}: ${id}`);
    seen.add(id);
  }
}

function validateOptionalIdCollection(state, collectionName, identityKeys) {
  const seenIds = new Set();
  for (const [index, entity] of state[collectionName].entries()) {
    if (!isEntity(entity) || !identityKeys.some(key => nonEmptyField(entity, key))) {
      throw new TypeError(`${collectionName}[${index}] has no supported identity field`);
    }
    if (!Object.hasOwn(entity, 'id')) continue;
    if (!nonEmptyField(entity, 'id')) throw new TypeError(`${collectionName}[${index}] has an empty id`);
    const id = String(entity.id).trim();
    if (seenIds.has(id)) throw new TypeError(`${collectionName} contains duplicate id: ${id}`);
    seenIds.add(id);
  }
}

function validatePersistedEntities(state) {
  for (const [collectionName, key] of Object.entries(KEYED_COLLECTIONS)) {
    validateKeyedCollection(state, collectionName, key);
  }
  validateOptionalIdCollection(state, 'requestSourceRows', SOURCE_ROW_IDENTITY_KEYS);
  validateOptionalIdCollection(state, 'testers', ['id', 'name']);
}

function normalizedHashState(state) {
  const normalized = structuredClone(state ?? {});
  delete normalized.savedAt;
  if (Array.isArray(normalized.auditLogs)) {
    normalized.auditLogs = normalized.auditLogs.map(audit => {
      if (!PAGE_AUDIT_PATTERN.test(String(audit?.action || ''))) return audit;
      return Object.fromEntries(
        Object.entries(audit).filter(([key]) => !PAGE_AUDIT_TIME_KEYS.has(key))
      );
    });
  }
  return stableValue(normalized);
}

export function summarizeState(state) {
  const records = collection(state, 'records');
  const runningRecords = records.filter(record => record?.status === 'running').length;
  const reservedRecords = records.filter(record => record?.status === 'reserved').length;
  return {
    revision: Number(state?.revision || 0),
    devices: collection(state, 'deviceProfiles').length,
    channels: collection(state, 'channels').length,
    requests: collection(state, 'requests').length,
    samples: collection(state, 'samples').length,
    records: records.length,
    storageRecords: collection(state, 'storageRecords').length,
    audits: collection(state, 'auditLogs').length,
    journalEntries: collection(state, 'formChangeJournal').length,
    runningRecords,
    reservedRecords,
    activeRecords: runningRecords + reservedRecords
  };
}

export function canonicalStateHash(state) {
  return createHash('sha256')
    .update(JSON.stringify(normalizedHashState(state)))
    .digest('hex');
}

export function readWorkflowSnapshot({ dataRoot }) {
  if (typeof dataRoot !== 'string' || dataRoot.trim() === '') {
    throw new TypeError('dataRoot is required');
  }
  const sqlitePath = path.join(path.resolve(dataRoot), SQLITE_FILE);
  const db = new DatabaseSync(sqlitePath, { readOnly: true });
  try {
    const integrity = db.prepare('PRAGMA integrity_check').all().map(row => Object.values(row)[0]);
    const row = db.prepare('SELECT revision, payload FROM app_state WHERE id = 1').get();
    if (!row) throw new Error('app_state row id=1 is missing');
    const formJournal = db.prepare('SELECT * FROM form_change_journal ORDER BY time, id').all();
    const payload = JSON.parse(row.payload);
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      throw new TypeError('app_state payload must be an object');
    }
    for (const name of COLLECTIONS) {
      if (!Object.hasOwn(payload, name)) {
        throw new TypeError(`app_state payload is missing collection: ${name}`);
      }
    }
    validatePersistedEntities(payload);
    const state = normalizeLegacyState(payload);
    state.revision = Number(row.revision);
    return {
      sqlitePath,
      integrity,
      state,
      auditLogs: structuredClone(state.auditLogs || []),
      formJournal,
      summary: summarizeState(state),
      hash: canonicalStateHash(state)
    };
  } finally {
    db.close();
  }
}
