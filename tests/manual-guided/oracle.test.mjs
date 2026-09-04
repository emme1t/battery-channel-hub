import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { seedWorkflowFixture } from '../workflows/fixtures.mjs';
import {
  assertManualSafety,
  assertZeroBusinessWrite,
  captureManualSnapshot,
  compareManualSnapshots
} from './oracle.mjs';

const fixedClock = () => new Date('2026-09-02T08:30:00.000Z');

async function temporaryDataRoot(t, kind = 'baseline') {
  const root = await mkdtemp(path.join(os.tmpdir(), 'manual-guided-oracle-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await seedWorkflowFixture({ dataRoot: root, kind, clock: fixedClock });
  return root;
}

test('oracle captures a real copied SQLite without changing its bytes or mtime', async (t) => {
  const dataRoot = await temporaryDataRoot(t);
  const sqlitePath = path.join(dataRoot, 'battery-channel-hub.sqlite');
  const before = await stat(sqlitePath);
  const snapshot = captureManualSnapshot({ dataRoot });
  const after = await stat(sqlitePath);

  assert.deepEqual(snapshot.integrity, ['ok']);
  assert.match(snapshot.hash, /^[a-f0-9]{64}$/);
  assert.deepEqual(Object.keys(snapshot.collectionHashes), [
    'requests', 'samples', 'deviceProfiles', 'channels', 'records', 'storageRecords',
    'testers', 'requestSourceRows', 'formChangeJournal', 'auditLogs'
  ]);
  assert.equal(snapshot.activeOwnership.ordinary.length, 0);
  assert.equal(after.size, before.size);
  assert.equal(after.mtimeMs, before.mtimeMs);
  assert.equal(assertManualSafety(snapshot), true);
});

test('oracle reports stable collection diffs and permits only an explicit visible cancel audit', async (t) => {
  const dataRoot = await temporaryDataRoot(t);
  const before = captureManualSnapshot({ dataRoot });
  const after = structuredClone(before);
  after.state.auditLogs.push({
    id: 'AUDIT-CANCEL-001', action: '取消导入', outcome: 'cancelled', target: '文件选择框'
  });
  after.collectionHashes.auditLogs = 'changed-audit-hash';
  after.hash = 'changed-state-hash';

  const diff = compareManualSnapshots(before, after);
  assert.deepEqual(diff.changedCollections, ['auditLogs']);
  assert.equal(diff.hashChanged, true);
  assert.equal(assertZeroBusinessWrite(before, after, { allowedAuditActions: ['取消导入'] }), true);
  assert.throws(
    () => assertZeroBusinessWrite(before, after),
    error => error.code === 'BUSINESS_WRITE_DETECTED'
  );

  const businessWrite = structuredClone(after);
  businessWrite.collectionHashes.requests = 'changed-request-hash';
  assert.throws(
    () => assertZeroBusinessWrite(before, businessWrite, { allowedAuditActions: ['取消导入'] }),
    error => error.code === 'BUSINESS_WRITE_DETECTED'
  );
});

test('manual safety rejects duplicate active records, channel ownership, storage overlap and missing sources', async (t) => {
  const dataRoot = await temporaryDataRoot(t);
  const baseline = structuredClone(captureManualSnapshot({ dataRoot }));
  baseline.state.requests = [{ id: 'REQ-SAFE-001' }, { id: 'REQ-SAFE-002' }];
  baseline.state.requestSourceRows = [
    { id: 'REQ-SAFE-001', requestNo: 'REQ-SAFE-001' },
    { id: 'REQ-SAFE-002', requestNo: 'REQ-SAFE-002' }
  ];
  baseline.state.records = [
    {
      id: 'RECORD-SAFE-001', requestNo: 'REQ-SAFE-001', sampleId: 'REQ-SAFE-001.001',
      status: 'running', channelKey: baseline.state.channels[0].key, keys: [baseline.state.channels[0].key]
    },
    {
      id: 'RECORD-SAFE-002', requestNo: 'REQ-SAFE-002', sampleId: 'REQ-SAFE-002.001',
      status: 'reserved', channelKey: baseline.state.channels[1].key, keys: [baseline.state.channels[1].key]
    }
  ];
  assert.equal(assertManualSafety(baseline), true);

  const duplicateRecord = structuredClone(baseline);
  duplicateRecord.state.records.push({ ...duplicateRecord.state.records[0], id: 'RECORD-DUPLICATE' });
  assert.throws(() => assertManualSafety(duplicateRecord), error =>
    error.code === 'MANUAL_SAFETY_VIOLATION' && error.violations.some(item => item.code === 'DUPLICATE_ACTIVE_SAMPLE')
  );

  const duplicateChannel = structuredClone(baseline);
  duplicateChannel.state.records[1].channelKey = duplicateChannel.state.records[0].channelKey;
  duplicateChannel.state.records[1].keys = [duplicateChannel.state.records[0].channelKey];
  assert.throws(() => assertManualSafety(duplicateChannel), error =>
    error.violations.some(item => item.code === 'DUPLICATE_CHANNEL_OWNERSHIP')
  );

  const overlap = structuredClone(baseline);
  overlap.state.storageRecords.push({
    id: 'STORAGE-OVERLAP', requestNo: overlap.state.records[0].requestNo,
    sampleIds: [overlap.state.records[0].sampleId], status: 'storing'
  });
  assert.throws(() => assertManualSafety(overlap), error =>
    error.violations.some(item => item.code === 'ORDINARY_STORAGE_OVERLAP')
  );

  const missingSource = structuredClone(baseline);
  missingSource.state.requestSourceRows = missingSource.state.requestSourceRows
    .filter(item => item.requestNo !== missingSource.state.requests[0].id && item.id !== missingSource.state.requests[0].id);
  assert.throws(() => assertManualSafety(missingSource), error =>
    error.violations.some(item => item.code === 'REQUEST_SOURCE_MISSING')
  );
});

test('manual safety rejects failed SQLite integrity and oracle refuses write-shaped options', async (t) => {
  const dataRoot = await temporaryDataRoot(t);
  const snapshot = captureManualSnapshot({ dataRoot });
  const broken = structuredClone(snapshot);
  broken.integrity = ['database disk image is malformed'];
  assert.throws(() => assertManualSafety(broken), error =>
    error.violations.some(item => item.code === 'SQLITE_INTEGRITY')
  );
  assert.throws(
    () => captureManualSnapshot({ dataRoot, write: true }),
    /read-only options/i
  );
});

test('oracle source contains no SQL writer or business write-service import and reuses read-only DatabaseSync', async () => {
  const oracleSource = await readFile(new URL('./oracle.mjs', import.meta.url), 'utf8');
  const probeSource = await readFile(new URL('../workflows/state-probe.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(oracleSource, /\b(?:INSERT|UPDATE|DELETE|REPLACE|CREATE|DROP|ALTER)\b|\.exec\s*\(/i);
  assert.doesNotMatch(oracleSource, /(?:command-service|legacy-sqlite-store|state-store|transactions)\.mjs/);
  assert.match(probeSource, /new DatabaseSync\(sqlitePath, \{ readOnly: true \}\)/);
});

test('missing SQLite remains missing after a refused capture', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'manual-guided-oracle-missing-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sqlitePath = path.join(root, 'battery-channel-hub.sqlite');
  assert.throws(() => captureManualSnapshot({ dataRoot: root }));
  await assert.rejects(stat(sqlitePath), error => error.code === 'ENOENT');
});
