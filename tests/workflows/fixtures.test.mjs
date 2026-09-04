import assert from 'node:assert/strict';
import { access, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import { parseFolder, parseWorkbook } from '../../src/main/excel-service.mjs';
import { createLegacySqliteStore } from '../../src/main/legacy-sqlite-store.mjs';

import { createWorkflowRunContext } from './run-context.mjs';
import { checkWorkflowInvariants } from './invariants.mjs';
import { canonicalStateHash, summarizeState } from './state-probe.mjs';
import {
  createImportWorkbook,
  seedWorkflowFixture,
  withExclusiveDatabaseLock
} from './fixtures.mjs';

const projectRoot = path.resolve(import.meta.dirname, '..', '..');
const fixedClock = () => new Date('2026-08-22T08:00:00.000Z');
let runSequence = 10;

async function testContext(t) {
  const value = runSequence++;
  const context = await createWorkflowRunContext({
    projectRoot,
    mode: 'quick',
    now: fixedClock,
    randomBytes: () => Buffer.from([(process.pid >>> 16) & 0xff, (process.pid >>> 8) & 0xff, process.pid & 0xff, value])
  });
  t.after(() => rm(context.runRoot, { recursive: true, force: true }));
  return context;
}

async function loadFixture(manifest) {
  const store = await createLegacySqliteStore({ dataRoot: manifest.dataRoot, clock: fixedClock });
  try {
    const loaded = await store.load();
    assert.equal(loaded.ok, true);
    return loaded.state;
  } finally {
    store.close();
  }
}

async function assertRealSqlite(manifest) {
  assert.equal((await stat(manifest.sqlitePath)).isFile(), true);
  const db = new DatabaseSync(manifest.sqlitePath);
  try {
    assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    assert.equal(db.prepare('SELECT revision FROM app_state WHERE id = 1').get().revision, manifest.revision);
  } finally {
    db.close();
  }
}

test('baseline 夹具在 guarded run root 中生成可重开应用 SQLite', async (t) => {
  const context = await testContext(t);
  const manifest = await seedWorkflowFixture({ dataRoot: context.dataRoot, kind: 'baseline', clock: fixedClock });
  const state = await loadFixture(manifest);

  await assertRealSqlite(manifest);
  assert.equal(manifest.sqlitePath, path.join(context.dataRoot, 'battery-channel-hub.sqlite'));
  assert.equal(state.deviceProfiles.length, 26);
  assert.equal(state.channels.length, 529);
  assert.equal(state.revision, 1);
});

test('偏差工作流以 workflowId 创建所需场景，且默认 baseline 合同保持空申请', async (t) => {
  const context = await testContext(t);
  const baseline = await seedWorkflowFixture({ dataRoot: path.join(context.dataRoot, 'baseline'), kind: 'baseline', clock: fixedClock });
  const d01 = await seedWorkflowFixture({ dataRoot: path.join(context.dataRoot, 'd01'), kind: 'baseline', workflowId: 'D01', clock: fixedClock });
  const d02 = await seedWorkflowFixture({ dataRoot: path.join(context.dataRoot, 'd02'), kind: 'baseline', workflowId: 'D02', clock: fixedClock });
  const d03 = await seedWorkflowFixture({ dataRoot: path.join(context.dataRoot, 'd03'), kind: 'queue', workflowId: 'D03', clock: fixedClock });
  const d04 = await seedWorkflowFixture({ dataRoot: path.join(context.dataRoot, 'd04'), kind: 'baseline', workflowId: 'D04', clock: fixedClock });
  const d06 = await seedWorkflowFixture({ dataRoot: path.join(context.dataRoot, 'd06'), kind: 'baseline', workflowId: 'D06', clock: fixedClock });

  assert.equal((await loadFixture(baseline)).requests.length, 0);
  assert.ok((await loadFixture(d01)).samples.some(item => item.id === 'REQ-WF-D01-RUNNING-001.001' && item.status === 'running'));
  assert.equal((await loadFixture(d02)).samples.filter(item => item.requestNo === 'REQ-WF-D02-001').length, 4);
  assert.ok((await loadFixture(d03)).samples.some(item => item.id === 'REQ-WF-D03-URGENT-001.001' && item.status === 'pending'));
  assert.equal(parseWorkbook(d04.imports.vertical).records[0].id, 'REQ-WF-IMPORT-001');
  assert.equal(parseWorkbook(d06.imports.vertical).records[0].id, 'REQ-WF-IMPORT-001');
});

test('production-529 夹具从真实 SQLite 提供 26/529 与 529 个样品', async (t) => {
  const context = await testContext(t);
  const manifest = await seedWorkflowFixture({ dataRoot: context.dataRoot, kind: 'production-529', clock: fixedClock });
  const state = await loadFixture(manifest);

  await assertRealSqlite(manifest);
  assert.equal(manifest.devices, 26);
  assert.equal(manifest.channels, 529);
  assert.equal(new Set(manifest.channelKeys).size, 529);
  assert.equal(state.samples.length, 529);
});

test('production-999 夹具从真实 SQLite 提供 26/529 与连续 .001-.999 样品', async (t) => {
  const context = await testContext(t);
  const manifest = await seedWorkflowFixture({ dataRoot: context.dataRoot, kind: 'production-999', clock: fixedClock });
  const state = await loadFixture(manifest);

  await assertRealSqlite(manifest);
  assert.equal(manifest.devices, 26);
  assert.equal(manifest.channels, 529);
  assert.equal(new Set(manifest.channelKeys).size, 529);
  assert.equal(manifest.samples[0], 'REQ-WF-999.001');
  assert.equal(manifest.samples.at(-1), 'REQ-WF-999.999');
  assert.equal(state.samples.length, 999);
});

test('history-2000 从真实 SQLite 保留 26/529 与 2,000 条记录和审计', async (t) => {
  const context = await testContext(t);
  const manifest = await seedWorkflowFixture({ dataRoot: context.dataRoot, kind: 'history-2000', clock: fixedClock });
  const state = await loadFixture(manifest);

  await assertRealSqlite(manifest);
  assert.equal(manifest.records, 2_000);
  assert.equal(manifest.audits, 2_000);
  assert.equal(state.records.length, 2_000);
  assert.equal(state.auditLogs.length, 2_000);
  assert.ok(state.records.every(record => record.id.startsWith('WF-')));
  assert.ok(state.auditLogs.every(audit => audit.id.startsWith('WF-')));
});

test('queue 夹具具有真实 running/reserved 记录和通道指针', async (t) => {
  const context = await testContext(t);
  const manifest = await seedWorkflowFixture({ dataRoot: context.dataRoot, kind: 'queue', clock: fixedClock });
  const state = await loadFixture(manifest);
  const running = state.records.find(record => record.status === 'running');
  const reserved = state.records.find(record => record.status === 'reserved');

  await assertRealSqlite(manifest);
  assert.ok(running);
  assert.ok(reserved);
  assert.equal(state.samples.find(sample => sample.id === running.sampleId).channelKey, running.channelKey);
  assert.equal(state.channels.find(channel => channel.key === running.channelKey).currentRecordId, running.id);
  assert.equal(state.samples.find(sample => sample.id === reserved.sampleId).status, 'reserved');
});

test('S05 queue 夹具为运行记录和通道提供正的剩余时长', async (t) => {
  const context = await testContext(t);
  const manifest = await seedWorkflowFixture({
    dataRoot: context.dataRoot, kind: 'queue', workflowId: 'S05', clock: fixedClock
  });
  const state = await loadFixture(manifest);
  const running = state.records.find(record => record.id === 'WF-record-running-001');
  const channel = state.channels.find(item => item.currentRecordId === running?.id);

  assert.ok(running);
  assert.ok(channel);
  assert.ok(Date.parse(running.end) > Date.parse(running.start));
  assert.equal(channel.end, running.end);
});

test('queue 夹具通过 Task 3 核心指针与重复占用不变量', async (t) => {
  const context = await testContext(t);
  const manifest = await seedWorkflowFixture({ dataRoot: context.dataRoot, kind: 'queue', clock: fixedClock });
  const state = await loadFixture(manifest);
  const running = state.records.find(record => record.status === 'running');
  const reserved = state.records.find(record => record.status === 'reserved');
  const currentChannel = state.channels.find(channel => channel.currentRecordId === running.id);
  const nextChannel = state.channels.find(channel => channel.nextRecordId === reserved.id);
  const snapshot = value => ({
    integrity: ['ok'],
    state: value,
    auditLogs: structuredClone(value.auditLogs),
    formJournal: structuredClone(value.formChangeJournal),
    summary: summarizeState(value),
    hash: canonicalStateHash(value)
  });
  const before = snapshot(structuredClone(state));
  const after = snapshot(structuredClone(state));
  const violations = checkWorkflowInvariants({
    before,
    after,
    action: { id: 'inspect-queue', type: 'search', expect: 'success', outcome: 'success', revisionDelta: 0 },
    ui: null,
    restart: null
  });
  const coreCodes = new Set([
    'RUNNING_POINTER_SPLIT', 'RESERVED_POINTER_SPLIT', 'TERMINAL_CHANNEL_NOT_RELEASED',
    'SAMPLE_ACTIVE_DUPLICATE', 'CHANNEL_ACTIVE_DUPLICATE'
  ]);

  assert.ok(currentChannel, 'running record must be referenced by currentRecordId');
  assert.ok(nextChannel, 'reserved record must be referenced by nextRecordId');
  assert.equal(currentChannel.currentRecordId, running.id);
  assert.equal(nextChannel.nextRecordId, reserved.id);
  assert.equal(currentChannel.key, nextChannel.key);
  assert.deepEqual(violations.filter(item => coreCodes.has(item.code)), []);
});

test('history 夹具包含实际已完成记录与审计', async (t) => {
  const context = await testContext(t);
  const manifest = await seedWorkflowFixture({ dataRoot: context.dataRoot, kind: 'history', clock: fixedClock });
  const state = await loadFixture(manifest);

  await assertRealSqlite(manifest);
  assert.ok(state.records.some(record => record.status === 'completed'));
  assert.ok(state.auditLogs.some(audit => audit.action === 'fixture-history'));
});

test('S08 提供独立 pending storage 样品且 D04 提供包含式搜索诱饵', async t => {
  const context = await testContext(t);
  const s08 = await loadFixture(await seedWorkflowFixture({
    dataRoot: path.join(context.dataRoot, 'S08'), kind: 'history', workflowId: 'S08', clock: fixedClock
  }));
  assert.equal(s08.samples.find(item => item.id === 'REQ-WF-S08-STORAGE-001.001')?.status, 'pending');
  assert.ok(s08.requests.some(item => item.id === 'REQ-WF-S08-STORAGE-001'));
  assert.deepEqual(s08.storageRecords, []);

  const d04 = await loadFixture(await seedWorkflowFixture({
    dataRoot: path.join(context.dataRoot, 'D04'), kind: 'baseline', workflowId: 'D04', clock: fixedClock
  }));
  assert.deepEqual(d04.requests.map(item => item.id).sort(), ['REQ-WF-D04-001', 'REQ-WF-D04-001-EXTRA']);
  assert.match(d04.requests.find(item => item.id === 'REQ-WF-D04-001-EXTRA')?.project || '', /REQ-WF-D04-001/);
});

test('import-mixed 暴露真实 vertical、flat、blank、corrupt、locked 和同 ID 不同来源材料', async (t) => {
  const context = await testContext(t);
  const manifest = await seedWorkflowFixture({ dataRoot: context.dataRoot, kind: 'import-mixed', clock: fixedClock });

  await assertRealSqlite(manifest);
  assert.equal(parseWorkbook(manifest.imports.vertical).records[0].id, 'REQ-WF-IMPORT-001');
  assert.equal(parseWorkbook(manifest.imports.flat).records[0].id, 'REQ-WF-IMPORT-002');
  assert.throws(() => parseWorkbook(manifest.imports.blank), error => error.code === 'UNRECOGNIZED_APPLICATION_WORKBOOK');
  assert.throws(() => parseWorkbook(manifest.imports.corrupt), error => error.code === 'UNRECOGNIZED_APPLICATION_WORKBOOK');
  const parsed = parseFolder(path.dirname(manifest.imports.vertical));
  assert.equal(parsed.records.filter(record => record.id === 'REQ-WF-SAME-001').length, 2);
  assert.equal(parsed.files, 6);
  assert.ok(!parsed.records.some(record => record.sourceFile.startsWith('~$')));
});

test('createImportWorkbook 产生可解析的 vertical、flat、blank、corrupt 与锁定材料', async (t) => {
  const context = await testContext(t);
  const imports = path.join(context.dataRoot, 'direct-imports');
  const targets = Object.fromEntries(['vertical', 'flat', 'blank', 'corrupt', 'locked'].map(variant => [
    variant,
    path.join(imports, variant === 'locked' ? '~$locked.xlsx' : `${variant}.xlsx`)
  ]));

  await Promise.all(Object.entries(targets).map(([variant, target]) =>
    createImportWorkbook({ target, requestNo: 'REQ-WF-IMPORT-777', quantity: 7, variant })
  ));

  assert.equal(parseWorkbook(targets.vertical).records[0].normalized.qty, 7);
  assert.equal(parseWorkbook(targets.flat).records[0].normalized.qty, 7);
  assert.throws(() => parseWorkbook(targets.blank), error => error.code === 'UNRECOGNIZED_APPLICATION_WORKBOOK');
  assert.throws(() => parseWorkbook(targets.corrupt), error => error.code === 'UNRECOGNIZED_APPLICATION_WORKBOOK');
  assert.equal(parseFolder(imports).files, 4);
});

test('独占 SQLite 锁拒绝第二个写入者，并在 operation 抛错后释放', async (t) => {
  const context = await testContext(t);
  const sqlitePath = path.join(context.dataRoot, 'lock.sqlite');
  const first = new DatabaseSync(sqlitePath);
  first.exec('CREATE TABLE entries (value TEXT)');
  first.close();

  await withExclusiveDatabaseLock(sqlitePath, async () => {
    const second = new DatabaseSync(sqlitePath);
    try {
      assert.throws(() => second.exec("INSERT INTO entries VALUES ('blocked')"), /database is locked/);
    } finally {
      second.close();
    }
  });
  await assert.rejects(withExclusiveDatabaseLock(sqlitePath, async () => {
    throw new Error('operation failed');
  }), /operation failed/);

  const after = new DatabaseSync(sqlitePath);
  try {
    after.exec("INSERT INTO entries VALUES ('released')");
    assert.equal(after.prepare('SELECT COUNT(*) AS count FROM entries').get().count, 1);
  } finally {
    after.close();
  }
});

test('独占锁获取失败也关闭自身连接，不遗留锁或文件句柄', async (t) => {
  const context = await testContext(t);
  const sqlitePath = path.join(context.dataRoot, 'acquisition.sqlite');
  const holder = new DatabaseSync(sqlitePath);
  holder.exec('CREATE TABLE entries (value TEXT); PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE;');
  try {
    await assert.rejects(withExclusiveDatabaseLock(sqlitePath, async () => {}), /database is locked/);
  } finally {
    holder.exec('ROLLBACK');
    holder.close();
  }
  const after = new DatabaseSync(sqlitePath);
  after.close();
  await rm(sqlitePath);
  await assert.rejects(access(sqlitePath));
});

test('M01 M02 M03 M05 baseline 变体各提供一个精确待预约样品且不改变通用 baseline', async t => {
  const context = await testContext(t);
  const expected = ['M01', 'M02', 'M03', 'M05'];
  for (const id of expected) {
    const dataRoot = path.join(context.dataRoot, id);
    const manifest = await seedWorkflowFixture({ dataRoot, kind: 'baseline', workflowId: id, clock: fixedClock });
    const state = await loadFixture(manifest);
    const requestNo = `REQ-WF-${id}-001`;
    assert.deepEqual(state.requests.map(item => item.id), [requestNo], id);
    assert.deepEqual(state.samples.map(item => [item.id, item.status]), [[`${requestNo}.001`, 'pending']], id);
    assert.equal(state.records.length, 0, id);
  }
  const genericRoot = path.join(context.dataRoot, 'generic-baseline');
  const generic = await seedWorkflowFixture({ dataRoot: genericRoot, kind: 'baseline', clock: fixedClock });
  const genericState = await loadFixture(generic);
  assert.equal(genericState.requests.length, 0);
  assert.equal(genericState.samples.length, 0);
});

test('M06 与 M12 baseline 变体提供精确 running/pending 指针且通用 baseline 不受影响', async t => {
  const context = await testContext(t);
  const m06Manifest = await seedWorkflowFixture({ dataRoot: path.join(context.dataRoot, 'M06'), kind: 'baseline', workflowId: 'M06', clock: fixedClock });
  const m06 = await loadFixture(m06Manifest);
  const m06Record = m06.records.find(item => item.sampleId === 'REQ-WF-M06-RUNNING-001.001');
  const m06Channel = m06.channels.find(item => item.key === m06Record?.channelKey);
  const m06Request = m06.requests.find(item => item.id === 'REQ-WF-M06-RUNNING-001');
  assert.equal(m06Record?.status, 'running');
  assert.ok(new Date(m06Record?.start).getTime() < new Date(m06Record?.end).getTime());
  assert.equal(m06Channel?.currentRecordId, m06Record?.id);
  assert.equal(m06Request?.execution?.plannedStart, '2026-08-22');
  assert.equal(m06Request?.execution?.plannedEnd, '2026-08-22');
  assert.equal(m06Request?.execution?.note, '');

  const m12Manifest = await seedWorkflowFixture({ dataRoot: path.join(context.dataRoot, 'M12'), kind: 'baseline', workflowId: 'M12', clock: fixedClock });
  const m12 = await loadFixture(m12Manifest);
  const running = m12.records.find(item => item.sampleId === 'REQ-WF-M12-RUNNING-001.001');
  assert.equal(running?.status, 'running');
  assert.ok(new Date(running?.start).getTime() < new Date(running?.end).getTime());
  assert.equal(m12.channels.find(item => item.key === running?.channelKey)?.currentRecordId, running?.id);
  assert.deepEqual(
    m12.samples.filter(item => item.requestNo === 'REQ-WF-M12-PENDING-001').map(item => [item.id, item.status]),
    [['REQ-WF-M12-PENDING-001.001', 'pending']]
  );
});

test('M04 history-2000 变体为请求、样品、通道、日志、审计与 TODO 提供真实多页数据', async t => {
  const context = await testContext(t);
  const manifest = await seedWorkflowFixture({ dataRoot: context.dataRoot, kind: 'history-2000', workflowId: 'M04', clock: fixedClock });
  const state = await loadFixture(manifest);
  assert.ok(state.requests.length >= 101);
  assert.ok(state.samples.filter(item => item.requestNo === 'REQ-WF-M04-001').length >= 50);
  assert.equal(state.samples.find(item => item.id === 'REQ-WF-M04-001.001')?.status, 'pending');
  assert.ok(state.records.filter(item => item.status === 'completed').length >= 2_000);
  assert.ok(state.records.filter(item => item.status === 'reserved').length >= 30);
  assert.ok(state.auditLogs.length >= 2_000);
  assert.equal(state.channels.length, 529);
  const reserved = state.records.filter(item => item.status === 'reserved');
  assert.ok(reserved.every(record => state.channels.some(channel => channel.nextRecordId === record.id)));
});

test('M07 与 M11 history 变体保留历史身份并提供活动删除和旧 DOM 目标', async t => {
  const context = await testContext(t);
  const m07Manifest = await seedWorkflowFixture({ dataRoot: path.join(context.dataRoot, 'M07'), kind: 'history', workflowId: 'M07', clock: fixedClock });
  const m07 = await loadFixture(m07Manifest);
  const active = m07.records.find(item => item.sampleId === 'REQ-WF-M07-ACTIVE-001.001');
  assert.equal(active?.status, 'running');
  assert.ok(new Date(active?.start).getTime() < new Date(active?.end).getTime());
  assert.equal(m07.channels.find(item => item.key === active?.channelKey)?.currentRecordId, active?.id);
  assert.ok(m07.records.some(item => item.status === 'completed' && item.user === 'WF tester'));
  assert.ok(m07.auditLogs.some(item => (item.user ?? item.actor) === 'WF tester'));
  const storage = m07.storageRecords.find(item => item.id === 'STO-WF-M07-001');
  assert.equal(storage?.status, 'storing');
  assert.deepEqual(storage?.sampleIds, ['REQ-WF-M07-STORAGE-001.001']);
  assert.equal(m07.samples.find(item => item.id === 'REQ-WF-M07-STORAGE-001.001')?.status, 'storing');
  assert.equal(m07.channels.some(channel => channel.currentRecordId === storage?.id || channel.nextRecordId === storage?.id), false);

  const m11Manifest = await seedWorkflowFixture({ dataRoot: path.join(context.dataRoot, 'M11'), kind: 'history', workflowId: 'M11', clock: fixedClock });
  const m11 = await loadFixture(m11Manifest);
  const running = m11.records.find(item => item.sampleId === 'REQ-WF-M11-RUNNING-001.001');
  const reserved = m11.records.find(item => item.sampleId === 'REQ-WF-M11-RESERVED-001.001');
  assert.equal(running?.status, 'running');
  assert.equal(reserved?.status, 'reserved');
  assert.equal(m11.records.indexOf(running), 0);
  assert.equal(m11.records.indexOf(reserved), 1);
  assert.ok(new Date(running?.start).getTime() < new Date(running?.end).getTime());
  assert.ok(new Date(reserved?.start).getTime() < new Date(reserved?.end).getTime());
  assert.equal(m11.channels.find(item => item.key === running?.channelKey)?.currentRecordId, running?.id);
  assert.equal(m11.channels.find(item => item.key === reserved?.channelKey)?.nextRecordId, reserved?.id);
});
