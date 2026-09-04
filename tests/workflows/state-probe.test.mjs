import assert from 'node:assert/strict';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import { seedWorkflowFixture } from './fixtures.mjs';
import {
  canonicalStateHash,
  readWorkflowSnapshot,
  summarizeState
} from './state-probe.mjs';

const fixedClock = () => new Date('2026-08-22T08:00:00.000Z');

async function temporaryRoot(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'workflow-state-probe-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test('只读探针读取真实 SQLite 且不改变数据库文件', async (t) => {
  const dataRoot = await temporaryRoot(t);
  const manifest = await seedWorkflowFixture({ dataRoot, kind: 'queue', clock: fixedClock });
  const before = await stat(manifest.sqlitePath);

  const snapshot = readWorkflowSnapshot({ dataRoot });
  const after = await stat(manifest.sqlitePath);

  assert.equal(snapshot.sqlitePath, manifest.sqlitePath);
  assert.deepEqual(snapshot.integrity, ['ok']);
  assert.equal(snapshot.state.revision, manifest.revision);
  assert.deepEqual(snapshot.summary, {
    revision: 1,
    devices: 26,
    channels: 529,
    requests: 2,
    samples: 2,
    records: 2,
    storageRecords: 0,
    audits: 1,
    journalEntries: 0,
    runningRecords: 1,
    reservedRecords: 1,
    activeRecords: 2
  });
  assert.deepEqual(snapshot.auditLogs, snapshot.state.auditLogs);
  assert.notEqual(snapshot.auditLogs, snapshot.state.auditLogs);
  assert.deepEqual(snapshot.formJournal, []);
  assert.match(snapshot.hash, /^[a-f0-9]{64}$/);
  assert.equal(after.size, before.size);
  assert.equal(after.mtimeMs, before.mtimeMs);
});

test('只读探针面对缺失数据库时失败且不创建 schema 或文件', async (t) => {
  const dataRoot = await temporaryRoot(t);
  const sqlitePath = path.join(dataRoot, 'battery-channel-hub.sqlite');

  assert.throws(() => readWorkflowSnapshot({ dataRoot }));
  await assert.rejects(stat(sqlitePath), error => error.code === 'ENOENT');
});

test('只读探针拒绝缺集合或集合类型错误的 SQLite payload', async (t) => {
  const root = await temporaryRoot(t);
  const payloads = [{}, { requests: {} }];

  for (const [index, payload] of payloads.entries()) {
    const dataRoot = path.join(root, String(index));
    const manifest = await seedWorkflowFixture({ dataRoot, kind: 'baseline', clock: fixedClock });
    const db = new DatabaseSync(manifest.sqlitePath);
    try {
      db.prepare('UPDATE app_state SET payload = ? WHERE id = 1').run(JSON.stringify(payload));
    } finally {
      db.close();
    }

    assert.throws(() => readWorkflowSnapshot({ dataRoot }));
  }
});

test('只读探针拒绝实体垃圾、空主键和重复主键', async (t) => {
  const dataRoot = await temporaryRoot(t);
  const manifest = await seedWorkflowFixture({ dataRoot, kind: 'baseline', clock: fixedClock });
  const db = new DatabaseSync(manifest.sqlitePath);
  let original;
  try {
    original = JSON.parse(db.prepare('SELECT payload FROM app_state WHERE id = 1').get().payload);
  } finally {
    db.close();
  }
  const keyedCollections = [
    ['requests', 'id'],
    ['samples', 'id'],
    ['deviceProfiles', 'id'],
    ['records', 'id'],
    ['auditLogs', 'id'],
    ['formChangeJournal', 'id'],
    ['storageRecords', 'id'],
    ['channels', 'key']
  ];
  const corruptions = keyedCollections.flatMap(([collection, key]) => [
    [`${collection} null`, state => { state[collection] = [null]; }],
    [`${collection} empty key`, state => { state[collection] = [{}]; }],
    [`${collection} duplicate key`, state => { state[collection] = [{ [key]: 'DUP' }, { [key]: 'DUP' }]; }]
  ]);
  corruptions.push(
    ['requestSourceRows garbage', state => { state.requestSourceRows = [null, [], 42, {}, { foo: 'bar' }]; }],
    ['requestSourceRows duplicate optional id', state => { state.requestSourceRows = [{ id: 'SRC-DUP' }, { id: 'SRC-DUP' }]; }],
    ['testers garbage', state => { state.testers = [null, [], 42, {}, { dept: '测试部' }]; }],
    ['testers duplicate optional id', state => { state.testers = [{ id: 'T-DUP' }, { id: 'T-DUP' }]; }]
  );

  for (const [name, corrupt] of corruptions) {
    const payload = structuredClone(original);
    corrupt(payload);
    const writer = new DatabaseSync(manifest.sqlitePath);
    try {
      writer.prepare('UPDATE app_state SET payload = ? WHERE id = 1').run(JSON.stringify(payload));
    } finally {
      writer.close();
    }
    assert.throws(() => readWorkflowSnapshot({ dataRoot }), undefined, name);
  }
});

test('只读探针接受无 id 但符合现有形态的来源行和测试员', async (t) => {
  const dataRoot = await temporaryRoot(t);
  const manifest = await seedWorkflowFixture({ dataRoot, kind: 'baseline', clock: fixedClock });
  const db = new DatabaseSync(manifest.sqlitePath);
  try {
    const row = db.prepare('SELECT payload FROM app_state WHERE id = 1').get();
    const payload = JSON.parse(row.payload);
    payload.requestSourceRows = [{ 申请单号: 'REQ-LEGACY-001', 来源: 'legacy.xlsx' }];
    payload.testers = [{ name: '无 ID 测试员', dept: '测试部', status: '启用' }];
    db.prepare('UPDATE app_state SET payload = ? WHERE id = 1').run(JSON.stringify(payload));
  } finally {
    db.close();
  }

  const snapshot = readWorkflowSnapshot({ dataRoot });
  assert.deepEqual(snapshot.state.requestSourceRows, [{ 申请单号: 'REQ-LEGACY-001', 来源: 'legacy.xlsx' }]);
  assert.deepEqual(snapshot.state.testers, [{ name: '无 ID 测试员', dept: '测试部', status: 'enabled' }]);
});

test('状态摘要对缺失集合使用零并统计活动记录', () => {
  assert.deepEqual(summarizeState({ revision: 7, records: [{ status: 'running' }, { status: 'completed' }] }), {
    revision: 7,
    devices: 0,
    channels: 0,
    requests: 0,
    samples: 0,
    records: 2,
    storageRecords: 0,
    audits: 0,
    journalEntries: 0,
    runningRecords: 1,
    reservedRecords: 0,
    activeRecords: 1
  });
});

test('规范化哈希忽略保存时间和页面访问审计时间但保留业务事实', () => {
  const base = {
    revision: 9,
    savedAt: '2026-08-22T08:00:00.000Z',
    requests: [{
      id: 'REQ-001',
      rawFields: { 委托单号: 'REQ-001', 样品信息: { 型号: 'CELL-A' } },
      sourceFile: '申请.xlsx',
      sourcePath: 'C:/imports/申请.xlsx'
    }],
    channels: [{ key: '设备 A|001', state: 'free' }],
    samples: [{ id: 'REQ-001.001', status: 'pending' }],
    records: [],
    auditLogs: [
      { id: 'VIEW-1', action: '查看页面', target: 'board', time: '08:00', at: '2026-08-22T08:00:00Z' },
      { id: 'BUSINESS-1', action: '开始测试', target: 'REQ-001.001', time: '08:01', outcome: 'success' }
    ]
  };
  const noiseOnly = structuredClone(base);
  noiseOnly.savedAt = '2026-08-22T09:00:00.000Z';
  noiseOnly.auditLogs[0].time = '09:00';
  noiseOnly.auditLogs[0].at = '2026-08-22T09:00:00Z';
  const changedRaw = structuredClone(noiseOnly);
  changedRaw.requests[0].rawFields.样品信息.型号 = 'CELL-B';
  const changedSource = structuredClone(noiseOnly);
  changedSource.requests[0].sourcePath = 'D:/imports/申请.xlsx';
  const changedBusinessAudit = structuredClone(noiseOnly);
  changedBusinessAudit.auditLogs[1].time = '08:02';
  const reorderedKeys = {
    auditLogs: structuredClone(base.auditLogs),
    records: [],
    samples: structuredClone(base.samples),
    channels: structuredClone(base.channels),
    requests: structuredClone(base.requests),
    savedAt: base.savedAt,
    revision: base.revision
  };

  assert.equal(canonicalStateHash(base), canonicalStateHash(noiseOnly));
  assert.equal(canonicalStateHash(base), canonicalStateHash(reorderedKeys));
  assert.notEqual(canonicalStateHash(base), canonicalStateHash(changedRaw));
  assert.notEqual(canonicalStateHash(base), canonicalStateHash(changedSource));
  assert.notEqual(canonicalStateHash(base), canonicalStateHash(changedBusinessAudit));
});
