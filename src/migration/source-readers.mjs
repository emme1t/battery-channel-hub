import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { extname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

function sourceError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}
function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

async function snapshot(filePath) {
  const [bytes, metadata] = await Promise.all([readFile(filePath), stat(filePath)]);
  if (!metadata.isFile()) {
    throw sourceError('SOURCE_NOT_FILE', 'migration source must be a regular file');
  }
  return {
    bytes,
    descriptor: {
      path: resolve(filePath),
      size: metadata.size,
      mtimeMs: metadata.mtimeMs,
      sha256: sha256(bytes)
    }
  };
}

function descriptorsEqual(left, right) {
  return left.path === right.path &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.sha256 === right.sha256;
}

function parseLegacyJson(bytes) {
  let parsed;
  try {
    parsed = JSON.parse(bytes.toString('utf8'));
  } catch (error) {
    throw sourceError('SOURCE_JSON_INVALID', `legacy JSON cannot be parsed: ${error.message}`);
  }

  if (parsed?.format === 'battery-channel-hub-backup' && parsed.state) {
    if (parsed.version !== undefined && parsed.version !== 1) {
      throw sourceError('SOURCE_BACKUP_VERSION_UNSUPPORTED', `legacy backup version ${parsed.version} is not supported`);
    }
    return { kind: 'legacy-backup-v1', value: parsed.state };
  }
  if (parsed?.schemaVersion === 2) {
    throw sourceError('SOURCE_ALREADY_VNEXT', 'source is already a vNext state file');
  }
  if (parsed && typeof parsed === 'object' && (
    Array.isArray(parsed.requests) ||
    Array.isArray(parsed.channels) ||
    Array.isArray(parsed.records) ||
    Array.isArray(parsed.deviceProfiles)
  )) {
    return { kind: 'legacy-json', value: parsed };
  }
  throw sourceError('SOURCE_FORMAT_UNRECOGNIZED', 'file is not a recognized legacy state or backup');
}

function readLegacySqlite(filePath) {
  let database;
  try {
    database = new DatabaseSync(filePath, { readOnly: true });
    const row = database.prepare('SELECT payload FROM app_state WHERE id = 1').get();
    if (!row || typeof row.payload !== 'string') {
      throw sourceError('SOURCE_SQLITE_STATE_MISSING', 'legacy SQLite does not contain app_state id 1');
    }
    return JSON.parse(row.payload);
  } catch (error) {
    if (error.code?.startsWith?.('SOURCE_')) throw error;
    if (error instanceof SyntaxError) {
      throw sourceError('SOURCE_SQLITE_PAYLOAD_INVALID', `legacy SQLite payload is invalid JSON: ${error.message}`);
    }
    throw sourceError('SOURCE_SQLITE_INVALID', `legacy SQLite cannot be read safely: ${error.message}`);
  } finally {
    database?.close();
  }
}

export async function snapshotMigrationSource(filePath) {
  if (typeof filePath !== 'string' || filePath.trim() === '') {
    throw sourceError('SOURCE_REQUIRED', 'migration source file is required');
  }
  return (await snapshot(filePath)).descriptor;
}

export async function readMigrationSource(filePath) {
  if (typeof filePath !== 'string' || filePath.trim() === '') {
    throw sourceError('SOURCE_REQUIRED', 'migration source file is required');
  }

  const before = await snapshot(filePath);
  const extension = extname(before.descriptor.path).toLowerCase();
  const parsed = extension === '.sqlite' || extension === '.db'
    ? { kind: 'legacy-sqlite', value: readLegacySqlite(before.descriptor.path) }
    : parseLegacyJson(before.bytes);
  const after = await snapshot(filePath);

  if (!descriptorsEqual(before.descriptor, after.descriptor)) {
    throw sourceError('SOURCE_CHANGED_DURING_READ', 'migration source changed while it was being read');
  }
  return {
    ...parsed,
    source: before.descriptor
  };
}
