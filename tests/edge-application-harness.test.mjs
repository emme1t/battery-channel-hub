import assert from 'node:assert/strict';
import { access, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createRunContext } from '../scripts/edge-regression/run-context.mjs';
import { createLegacySqliteStore } from '../src/main/legacy-sqlite-store.mjs';

const harnessModule = await import('../scripts/edge-regression/application-harness.mjs').catch(() => ({}));

const at = hour => `2026-08-22T${String(hour).padStart(2, '0')}:00:00-07:00`;

function initialState() {
  return {
    revision: 0,
    requests: [{ id: 'REQ-HARNESS-001', qty: 1, project: '项目 A', test: '循环测试', sample: '35Ah' }],
    samples: [{
      id: 'REQ-HARNESS-001.001', requestNo: 'REQ-HARNESS-001', ordinal: 1,
      status: 'pending', channelKey: '', start: '', end: '', hasHistory: false
    }],
    channels: [{
      key: '设备 A|001', device: '设备 A', name: '001', state: 'free',
      project: '', user: '', start: '', end: null, currentRecordId: '', nextRecordId: ''
    }],
    deviceProfiles: [{ id: 'D001', name: '设备 A', status: '启用' }],
    records: [], requestSourceRows: [], auditLogs: [], formChangeJournal: [], testers: [],
    username: '测试员 A', savedAt: ''
  };
}

function reservation() {
  return {
    type: 'reserve',
    payload: {
      requestNo: 'REQ-HARNESS-001',
      sampleId: 'REQ-HARNESS-001.001',
      channelKey: '设备 A|001',
      start: at(10),
      end: at(12),
      actor: '测试员 A',
      recordId: 'REC-HARNESS-001',
      auditId: 'AUDIT-HARNESS-001',
      now: at(9)
    }
  };
}

async function setup() {
  const projectRoot = await import('node:fs/promises').then(({ mkdtemp }) =>
    mkdtemp(path.join(os.tmpdir(), 'edge-harness-'))
  );
  const context = await createRunContext({
    projectRoot,
    mode: 'quick',
    now: () => new Date('2026-08-22T01:02:03.000Z'),
    randomBytes: () => Buffer.from('11112222', 'hex')
  });
  const dataRoot = path.join(context.workRoot, 'data');
  const outputRoot = path.join(context.workRoot, 'outputs');
  await mkdir(dataRoot, { recursive: true });
  const seedStore = await createLegacySqliteStore({ dataRoot, clock: () => '2026-08-22T08:00:00.000Z' });
  const saved = await seedStore.save({ expectedRevision: 0, state: initialState(), journalEntries: [] });
  assert.equal(saved.ok, true);
  seedStore.close();
  return { projectRoot, context, runRoot: context.runRoot, dataRoot, outputRoot };
}

test('application harness exports the required API', () => {
  assert.equal(typeof harnessModule.createApplicationHarness, 'function');
});

test('reservation uses the real SQLite service and survives an independent reopen', async () => {
  assert.equal(typeof harnessModule.createApplicationHarness, 'function');
  const scope = await setup();
  const harness = await harnessModule.createApplicationHarness({
    ...scope,
    pathGuard: scope.context.guard,
    dialogQueue: { open: [], save: [] },
    clock: () => new Date('2026-08-22T09:00:00.000Z')
  });
  const before = await harness.loadState();
  const result = await harness.executeReservation(reservation());
  assert.equal(result.ok, true);
  assert.equal(result.state.revision, before.revision + 1);
  assert.equal(result.state.records.length, 1);
  const inspection = await harness.inspectSqlite({ reopen: true });
  assert.equal(inspection.integrity, 'ok');
  assert.equal(inspection.revision, before.revision + 1);
  assert.deepEqual(inspection.counts, {
    requests: 1, samples: 1, devices: 1, channels: 1, records: 1, audits: 1, journals: 0, testers: 0
  });
  await harness.close();

  const reopened = await harnessModule.createApplicationHarness({
    ...scope,
    pathGuard: scope.context.guard,
    dialogQueue: { open: [], save: [] },
    clock: () => new Date('2026-08-22T09:01:00.000Z')
  });
  assert.equal((await reopened.loadState()).records[0].id, 'REC-HARNESS-001');
  await reopened.close();
});

test('dialog paths outside the run root are rejected before export writes', async () => {
  assert.equal(typeof harnessModule.createApplicationHarness, 'function');
  const scope = await setup();
  const outside = path.join(os.tmpdir(), `edge-harness-escape-${Date.now()}.xlsx`);
  const harness = await harnessModule.createApplicationHarness({
    ...scope,
    pathGuard: scope.context.guard,
    dialogQueue: { open: [], save: [{ canceled: false, filePath: outside }] },
    clock: () => new Date('2026-08-22T09:00:00.000Z')
  });
  const result = await harness.exportExcel({
    defaultFileName: '申请导出.xlsx',
    sheets: [{ name: '申请', rows: [{ 申请单号: 'REQ-HARNESS-001' }] }]
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'RUN_ROOT_ESCAPE');
  await assert.rejects(access(outside), { code: 'ENOENT' });
  await harness.close();
});
