import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createLegacySqliteStore, SQLITE_FILE } from '../src/main/legacy-sqlite-store.mjs';
import { createReservationCommandService } from '../src/main/reservation-command-service.mjs';

const at = hour => `2026-08-20T${String(hour).padStart(2, '0')}:00:00-07:00`;

function initialState() {
  return {
    revision: 0,
    requests: [{ id: 'REQ-001', qty: 1, project: '项目 A', test: '循环测试', sample: '35Ah' }],
    samples: [{
      id: 'REQ-001.001', requestNo: 'REQ-001', ordinal: 1, status: 'pending',
      channelKey: '', start: '', end: '', hasHistory: false
    }],
    channels: [{
      key: '设备 A|001', device: '设备 A', name: '001', state: 'free',
      project: '', user: '', start: '', end: null, currentRecordId: '', nextRecordId: ''
    }],
    deviceProfiles: [{ id: 'D001', name: '设备 A' }],
    records: [],
    requestSourceRows: [],
    auditLogs: [],
    formChangeJournal: [],
    testers: [],
    username: '测试员 A',
    savedAt: ''
  };
}

function assignment(overrides = {}) {
  return {
    requestNo: 'REQ-001',
    sampleId: 'REQ-001.001',
    channelKey: '设备 A|001',
    start: at(10),
    end: at(12),
    actor: '测试员 A',
    recordId: 'REC-001',
    auditId: 'AUDIT-001',
    now: at(9),
    ...overrides
  };
}

async function withSeededStore(run) {
  const dataRoot = await mkdtemp(path.join(tmpdir(), 'battery-command-service-'));
  const store = await createLegacySqliteStore({
    dataRoot,
    clock: () => '2026-08-20T09:00:00.000-07:00'
  });
  try {
    const seeded = await store.save({ expectedRevision: 0, state: initialState(), journalEntries: [] });
    assert.equal(seeded.ok, true);
    await run({ dataRoot, store, seeded: seeded.state });
  } finally {
    store.close();
    await rm(dataRoot, { recursive: true, force: true });
  }
}

async function sqliteBytes(dataRoot) {
  return readFile(path.join(dataRoot, SQLITE_FILE));
}

test('command reads current state, commits once, and stale revision changes nothing', async () => {
  await withSeededStore(async ({ dataRoot, store, seeded }) => {
    let saveCalls = 0;
    const countingStore = {
      load: (...args) => store.load(...args),
      save: (...args) => {
        saveCalls += 1;
        return store.save(...args);
      }
    };
    const service = createReservationCommandService({ store: countingStore });
    const first = await service.execute({
      type: 'reserve', expectedRevision: seeded.revision, payload: assignment()
    });
    assert.equal(first.ok, true);
    assert.equal(first.state.revision, seeded.revision + 1);
    assert.equal(first.state.records.length, 1);
    assert.equal(saveCalls, 1);

    const before = await sqliteBytes(dataRoot);
    const stale = await service.execute({
      type: 'start', expectedRevision: seeded.revision, payload: assignment({
        recordId: 'REC-STALE', auditId: 'AUDIT-STALE'
      })
    });
    assert.equal(stale.ok, false);
    assert.equal(stale.code, 'REVISION_CONFLICT');
    assert.equal(saveCalls, 1);
    assert.deepEqual(await sqliteBytes(dataRoot), before);
  });
});

test('domain rejection and unsupported commands perform zero SQLite writes', async () => {
  await withSeededStore(async ({ dataRoot, store, seeded }) => {
    const service = createReservationCommandService({ store });
    const before = await sqliteBytes(dataRoot);

    const rejected = await service.execute({
      type: 'reserve', expectedRevision: seeded.revision,
      payload: assignment({ channelKey: '不存在|001' })
    });
    assert.equal(rejected.ok, false);
    assert.equal(rejected.code, 'CHANNEL_NOT_FOUND');
    assert.deepEqual(await sqliteBytes(dataRoot), before);

    for (const type of ['start', 'reserve']) {
      const invalidInterval = await service.execute({
        type,
        expectedRevision: seeded.revision,
        payload: assignment({ start: at(12), end: at(12) })
      });
      assert.equal(invalidInterval.ok, false);
      assert.equal(invalidInterval.code, 'TIME_INTERVAL_INVALID');
      assert.match(invalidInterval.message, /结束时间必须晚于开始时间/);
      assert.deepEqual(await sqliteBytes(dataRoot), before);
    }

    const unsupported = await service.execute({
      type: 'deleteEverything', expectedRevision: seeded.revision, payload: {}
    });
    assert.equal(unsupported.ok, false);
    assert.equal(unsupported.code, 'COMMAND_UNSUPPORTED');
    assert.deepEqual(await sqliteBytes(dataRoot), before);
  });
});

test('quantity reconciliation and channel transition are persisted through the same whitelist', async () => {
  await withSeededStore(async ({ store, seeded }) => {
    const service = createReservationCommandService({ store });
    const quantity = await service.execute({
      type: 'reconcileQuantity',
      expectedRevision: seeded.revision,
      payload: { requestNo: 'REQ-001', quantity: 3 }
    });
    assert.equal(quantity.ok, true);
    assert.equal(quantity.state.samples.length, 3);
    assert.equal(quantity.state.samples.at(-1).id, 'REQ-001.003');

    const faulted = await service.execute({
      type: 'transition',
      expectedRevision: quantity.state.revision,
      payload: {
        action: 'fault', channelKey: '设备 A|001', actor: '测试员 A',
        auditId: 'AUDIT-FAULT', now: at(10)
      }
    });
    assert.equal(faulted.ok, true);
    assert.equal(faulted.state.channels[0].state, 'fault');
    assert.equal(faulted.state.auditLogs[0].id, 'AUDIT-FAULT');
  });
});

test('store read and save failures remain structured and never claim success', async () => {
  const readFailure = createReservationCommandService({
    store: {
      load: async () => ({ ok: false, code: 'READ_FAILED', message: 'read failed' }),
      save: async () => { throw new Error('must not save'); }
    }
  });
  assert.deepEqual(await readFailure.execute({ type: 'reserve', expectedRevision: 1, payload: {} }), {
    ok: false, code: 'READ_FAILED', message: 'read failed'
  });

  const validState = { ...initialState(), revision: 1 };
  const saveFailure = createReservationCommandService({
    store: {
      load: async () => ({ ok: true, state: validState }),
      save: async () => ({ ok: false, code: 'PERSISTENCE_FAILED', message: 'write failed' })
    }
  });
  const failed = await saveFailure.execute({
    type: 'start', expectedRevision: 1, payload: assignment()
  });
  assert.equal(failed.ok, false);
  assert.equal(failed.code, 'PERSISTENCE_FAILED');
});

test('multi-sample assignment validates the whole batch and persists exactly once', async () => {
  await withSeededStore(async ({ dataRoot, store, seeded }) => {
    const expanded = structuredClone(seeded);
    expanded.requests[0].qty = 2;
    expanded.samples.push({
      id: 'REQ-001.002', requestNo: 'REQ-001', ordinal: 2, status: 'pending',
      channelKey: '', start: '', end: '', hasHistory: false
    });
    expanded.channels.push({
      key: '设备 A|002', device: '设备 A', name: '002', state: 'free',
      project: '', user: '', start: '', end: null, currentRecordId: '', nextRecordId: ''
    });
    const expandedSave = await store.save({
      expectedRevision: seeded.revision, state: expanded, journalEntries: []
    });
    assert.equal(expandedSave.ok, true);

    let saveCalls = 0;
    const service = createReservationCommandService({
      store: {
        load: (...args) => store.load(...args),
        save: (...args) => {
          saveCalls += 1;
          return store.save(...args);
        }
      }
    });
    const common = {
      requestNo: 'REQ-001', start: at(10), end: at(12), actor: '测试员 A', now: at(9)
    };
    const beforeFailure = await sqliteBytes(dataRoot);
    const rejected = await service.execute({
      type: 'reserve',
      expectedRevision: expandedSave.state.revision,
      payload: {
        ...common,
        items: [
          { sampleId: 'REQ-001.001', channelKey: '设备 A|001', recordId: 'REC-X1', auditId: 'AUDIT-X1' },
          { sampleId: 'REQ-001.002', channelKey: '不存在|999', recordId: 'REC-X2', auditId: 'AUDIT-X2' }
        ]
      }
    });
    assert.equal(rejected.ok, false);
    assert.equal(rejected.code, 'CHANNEL_NOT_FOUND');
    assert.equal(saveCalls, 0);
    assert.deepEqual(await sqliteBytes(dataRoot), beforeFailure);

    const success = await service.execute({
      type: 'reserve',
      expectedRevision: expandedSave.state.revision,
      payload: {
        ...common,
        items: [
          { sampleId: 'REQ-001.001', channelKey: '设备 A|001', recordId: 'REC-B1', auditId: 'AUDIT-B1' },
          { sampleId: 'REQ-001.002', channelKey: '设备 A|002', recordId: 'REC-B2', auditId: 'AUDIT-B2' }
        ]
      }
    });
    assert.equal(success.ok, true);
    assert.equal(saveCalls, 1);
    assert.equal(success.state.records.length, 2);
    assert.equal(success.state.auditLogs.length, 2);
  });
});

test('running return executes through the service, saves once, and rejects invalid or stale commands without saving', async () => {
  await withSeededStore(async ({ store, seeded }) => {
    const active = structuredClone(seeded);
    active.samples[0] = {
      ...active.samples[0], status: 'running', channelKey: '设备 A|001',
      start: at(10), end: at(12), hasHistory: true
    };
    active.channels[0] = {
      ...active.channels[0], state: 'busy', project: '项目 A', user: '测试员 A',
      requestNo: 'REQ-001', test: '循环测试', start: at(10), end: at(12),
      currentRecordId: 'REC-RETURN', nextRecordId: ''
    };
    active.records = [{
      id: 'REC-RETURN', requestNo: 'REQ-001', no: 'REQ-001', sampleId: 'REQ-001.001',
      channelKey: '设备 A|001', keys: ['设备 A|001'], status: 'running', project: '项目 A',
      user: '测试员 A', start: at(10), end: at(12)
    }];
    const prepared = await store.save({ expectedRevision: seeded.revision, state: active, journalEntries: [] });
    assert.equal(prepared.ok, true);

    let saveCalls = 0;
    const service = createReservationCommandService({
      store: {
        load: (...args) => store.load(...args),
        save: (...args) => {
          saveCalls += 1;
          return store.save(...args);
        }
      }
    });
    const payload = {
      recordId: 'REC-RETURN', actor: '测试员 A', auditId: 'AUDIT-RETURN',
      now: at(13), reason: '申请资料需要补充'
    };

    const invalid = await service.execute({
      type: 'returnRunningToApplication', expectedRevision: prepared.state.revision,
      payload: { ...payload, reason: '   ' }
    });
    assert.equal(invalid.ok, false);
    assert.equal(invalid.code, 'COMMAND_FIELD_REQUIRED');
    assert.equal(saveCalls, 0);

    const stale = await service.execute({
      type: 'returnRunningToApplication', expectedRevision: prepared.state.revision - 1, payload
    });
    assert.equal(stale.ok, false);
    assert.equal(stale.code, 'REVISION_CONFLICT');
    assert.equal(saveCalls, 0);

    const success = await service.execute({
      type: 'returnRunningToApplication', expectedRevision: prepared.state.revision, payload
    });
    assert.equal(success.ok, true);
    assert.equal(saveCalls, 1);
    assert.equal(success.state.records[0].status, 'returned');
    assert.equal(success.state.samples[0].status, 'pending');
    assert.equal(success.state.auditLogs[0].action, 'running_returned_to_application');
    assert.equal(success.state.auditLogs[0].note, '申请资料需要补充');
  });
});

test('reserved return persists its reason and released ownership through a fresh SQLite reload', async () => {
  await withSeededStore(async ({ store, seeded }) => {
    const reserved = structuredClone(seeded);
    reserved.samples[0] = {
      ...reserved.samples[0], status: 'reserved', channelKey: '设备 A|001',
      start: at(10), end: at(12), hasHistory: true
    };
    reserved.channels[0] = {
      ...reserved.channels[0], state: 'booked', project: '项目 A', user: '测试员 A',
      requestNo: 'REQ-001', test: '循环测试', start: at(10), end: at(12),
      currentRecordId: '', nextRecordId: 'REC-RESERVED'
    };
    reserved.records = [{
      id: 'REC-RESERVED', requestNo: 'REQ-001', no: 'REQ-001', sampleId: 'REQ-001.001',
      channelKey: '设备 A|001', keys: ['设备 A|001'], status: 'reserved', project: '项目 A',
      user: '测试员 A', start: at(10), end: at(12)
    }];
    const prepared = await store.save({ expectedRevision: seeded.revision, state: reserved, journalEntries: [] });
    assert.equal(prepared.ok, true);

    let saveCalls = 0;
    const service = createReservationCommandService({
      store: {
        load: (...args) => store.load(...args),
        save: (...args) => {
          saveCalls += 1;
          return store.save(...args);
        }
      }
    });
    const baseCommand = {
      type: 'returnReservedToApplication',
      expectedRevision: prepared.state.revision,
      payload: {
        recordId: 'REC-RESERVED', actor: '测试员 A', auditId: 'AUDIT-RESERVED-RETURN',
        now: at(13), reason: '申请资料需要补充'
      }
    };

    const invalid = await service.execute({
      ...baseCommand,
      payload: { ...baseCommand.payload, reason: '   ' }
    });
    assert.equal(invalid.ok, false);
    assert.equal(invalid.code, 'COMMAND_FIELD_REQUIRED');
    assert.equal(saveCalls, 0);

    const success = await service.execute(baseCommand);
    assert.equal(success.ok, true);
    assert.equal(saveCalls, 1);

    const reloaded = await store.load();
    assert.equal(reloaded.ok, true);
    assert.equal(reloaded.state.records[0].status, 'returned');
    assert.equal(reloaded.state.records[0].returnReason, '申请资料需要补充');
    assert.equal(reloaded.state.samples[0].status, 'pending');
    assert.equal(reloaded.state.channels[0].state, 'free');
    assert.equal(reloaded.state.auditLogs[0].action, 'reserved_returned_to_application');
    assert.equal(reloaded.state.auditLogs[0].note, '申请资料需要补充');
  });
});
