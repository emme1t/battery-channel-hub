import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createApplicationCommandService } from '../src/main/application-command-service.mjs';
import { createLegacySqliteStore, SQLITE_FILE } from '../src/main/legacy-sqlite-store.mjs';

const now = '2026-08-20T14:00:00-07:00';

function stateFixture(overrides = {}) {
  return {
    revision: 0,
    requests: [{
      id: 'REQ-001', qty: 1, test: '循环测试', project: '项目 A', sample: '35Ah',
      tester: '旧平铺姓名', rawFields: { 委托单号: 'REQ-001', 申请人: '原始申请人' },
      sourceFile: 'REQ-001.xlsx', sourcePath: 'C:\\imports\\REQ-001.xlsx',
      execution: { tester: '测试员 A', fee: 10, device: '', plannedStart: '', plannedEnd: '', note: '' }
    }],
    samples: [{
      id: 'REQ-001.001', requestNo: 'REQ-001', ordinal: 1, status: 'pending',
      channelKey: '', start: '', end: '', hasHistory: false
    }],
    deviceProfiles: [{ id: 'D-001', name: '设备 A', status: '启用' }],
    channels: [{
      key: '设备 A|001', device: '设备 A', name: '001', state: 'free',
      project: '', user: '', start: '', end: null, currentRecordId: '', nextRecordId: ''
    }],
    records: [],
    requestSourceRows: [{ id: 'REQ-001', sourceFile: 'REQ-001.xlsx' }],
    auditLogs: [],
    formChangeJournal: [],
    testers: [{ id: 'T-001', name: '测试员 A', dept: '测试部', status: '启用' }],
    username: 'admin',
    savedAt: '',
    ...overrides
  };
}

function meta(id) {
  return { actor: 'admin', auditId: `AUDIT-${id}`, journalId: `JOURNAL-${id}`, now };
}

async function withStore(run, initial = stateFixture()) {
  const dataRoot = await mkdtemp(path.join(tmpdir(), 'battery-application-command-'));
  const store = await createLegacySqliteStore({ dataRoot, clock: () => now });
  try {
    const seeded = await store.save({ expectedRevision: 0, state: initial, journalEntries: [] });
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

test('unknown and stale application commands are structured zero-write failures', async () => {
  await withStore(async ({ dataRoot, store, seeded }) => {
    let saves = 0;
    const service = createApplicationCommandService({
      store: {
        load: (...args) => store.load(...args),
        save: (...args) => { saves += 1; return store.save(...args); }
      }
    });
    const before = await sqliteBytes(dataRoot);
    const unknown = await service.execute({ type: 'eraseDatabase', expectedRevision: seeded.revision, payload: {} });
    assert.equal(unknown.ok, false);
    assert.equal(unknown.code, 'COMMAND_UNSUPPORTED');

    const stale = await service.execute({
      type: 'editRequest', expectedRevision: seeded.revision - 1,
      payload: { requestNo: 'REQ-001', fields: { note: '不会写入' }, ...meta('STALE') }
    });
    assert.equal(stale.ok, false);
    assert.equal(stale.code, 'REVISION_CONFLICT');
    assert.equal(saves, 0);
    assert.deepEqual(await sqliteBytes(dataRoot), before);
  });
});

test('request execution edit commits once and keeps imported evidence unchanged', async () => {
  await withStore(async ({ store, seeded }) => {
    let saves = 0;
    const service = createApplicationCommandService({
      store: {
        load: (...args) => store.load(...args),
        save: (...args) => { saves += 1; return store.save(...args); }
      }
    });
    const result = await service.execute({
      type: 'editRequest', expectedRevision: seeded.revision,
      payload: {
        requestNo: 'REQ-001',
        fields: { tester: '测试员 B', fee: 25, note: '复核后执行' },
        ...meta('EDIT')
      }
    });
    assert.equal(result.ok, true);
    assert.equal(saves, 1);
    assert.equal(result.state.revision, seeded.revision + 1);
    assert.equal(result.state.requests[0].execution.tester, '测试员 B');
    assert.equal(result.state.requests[0].tester, '旧平铺姓名');
    assert.deepEqual(result.state.requests[0].rawFields, seeded.requests[0].rawFields);
    assert.equal(result.state.requests[0].sourcePath, seeded.requests[0].sourcePath);
    assert.equal(result.state.formChangeJournal.length, 1);
  });
});

test('import and delete requests are atomic SQLite commands', async () => {
  await withStore(async ({ dataRoot, store, seeded }) => {
    const service = createApplicationCommandService({ store });
    const imported = await service.execute({
      type: 'importRequests', expectedRevision: seeded.revision,
      payload: {
        records: [{
          id: 'REQ-002', qty: 2, test: '倍率测试', project: '项目 B', sample: '50Ah',
          rawFields: { 委托单号: 'REQ-002' }, sourceFile: 'REQ-002.xlsx', sourcePath: 'C:\\imports\\REQ-002.xlsx'
        }],
        errors: [], strategy: 'abort-on-error', duplicateMode: 'skip', ...meta('IMPORT')
      }
    });
    assert.equal(imported.ok, true);
    assert.equal(imported.state.requests.length, 2);
    assert.equal(imported.state.samples.filter(item => item.requestNo === 'REQ-002').length, 2);

    const active = structuredClone(imported.state);
    active.records.push({
      id: 'REC-ACTIVE', no: 'REQ-002', requestNo: 'REQ-002', status: 'reserved', state: '已预约',
      keys: ['设备 A|001'], channelKey: '设备 A|001'
    });
    active.samples.find(item => item.requestNo === 'REQ-002').status = 'reserved';
    const activeSave = await store.save({
      expectedRevision: imported.state.revision, state: active, journalEntries: []
    });
    assert.equal(activeSave.ok, true);
    const before = await sqliteBytes(dataRoot);
    const blocked = await service.execute({
      type: 'deleteRequests', expectedRevision: activeSave.state.revision,
      payload: { requestNos: ['REQ-001', 'REQ-002'], ...meta('DELETE') }
    });
    assert.equal(blocked.ok, false);
    assert.equal(blocked.code, 'REQUEST_ACTIVE_REFERENCE_BLOCK');
    assert.deepEqual(await sqliteBytes(dataRoot), before);
  });
});

test('tester duplicate rejection and deletion preserve request names', async () => {
  await withStore(async ({ dataRoot, store, seeded }) => {
    const service = createApplicationCommandService({ store });
    const before = await sqliteBytes(dataRoot);
    const duplicate = await service.execute({
      type: 'upsertTester', expectedRevision: seeded.revision,
      payload: { tester: { id: 'T-002', name: '测试员 A' }, ...meta('DUPLICATE') }
    });
    assert.equal(duplicate.ok, false);
    assert.equal(duplicate.code, 'TESTER_NAME_DUPLICATE');
    assert.deepEqual(await sqliteBytes(dataRoot), before);

    const deleted = await service.execute({
      type: 'deleteTester', expectedRevision: seeded.revision,
      payload: { testerId: 'T-001', ...meta('TESTER-DELETE') }
    });
    assert.equal(deleted.ok, true);
    assert.equal(deleted.state.testers.length, 0);
    assert.equal(deleted.state.requests[0].execution.tester, '测试员 A');
    assert.equal(deleted.state.requests[0].tester, '旧平铺姓名');
  });
});

test('active devices and channels block deletion while historical records are retained', async () => {
  const activeState = stateFixture({
    channels: [{
      key: '设备 A|001', device: '设备 A', name: '001', state: 'booked',
      project: '项目 A', user: 'admin', start: now, end: null, currentRecordId: '', nextRecordId: 'REC-ACTIVE'
    }],
    records: [{
      id: 'REC-ACTIVE', no: 'REQ-001', requestNo: 'REQ-001', status: 'reserved', state: '已预约',
      keys: ['设备 A|001'], channelKey: '设备 A|001'
    }]
  });
  await withStore(async ({ dataRoot, store, seeded }) => {
    const service = createApplicationCommandService({ store });
    for (const command of [
      { type: 'deleteChannel', payload: { channelKey: '设备 A|001', ...meta('CHANNEL-BLOCK') } },
      { type: 'deleteDevice', payload: { deviceId: 'D-001', ...meta('DEVICE-BLOCK') } }
    ]) {
      const before = await sqliteBytes(dataRoot);
      const result = await service.execute({ ...command, expectedRevision: seeded.revision });
      assert.equal(result.ok, false);
      assert.match(result.code, /ACTIVE_.*_DELETE_BLOCK/);
      assert.deepEqual(await sqliteBytes(dataRoot), before);
    }
  }, activeState);

  const historicalState = stateFixture({
    records: [{
      id: 'REC-HISTORY', no: 'REQ-001', requestNo: 'REQ-001', status: 'completed', state: '已结束',
      keys: ['设备 A|001'], channelKey: '设备 A|001', channels: '设备 A · 001'
    }]
  });
  await withStore(async ({ store, seeded }) => {
    const service = createApplicationCommandService({ store });
    const deleted = await service.execute({
      type: 'deleteChannel', expectedRevision: seeded.revision,
      payload: { channelKey: '设备 A|001', ...meta('CHANNEL-DELETE') }
    });
    assert.equal(deleted.ok, true);
    assert.equal(deleted.state.channels.length, 0);
    assert.equal(deleted.state.records.length, 1);
    assert.equal(deleted.state.records[0].keys[0], '设备 A|001');
  }, historicalState);
});

test('device and channel upserts enforce unique identities and commit audited state', async () => {
  await withStore(async ({ store, seeded }) => {
    const service = createApplicationCommandService({ store });
    const device = await service.execute({
      type: 'upsertDevice', expectedRevision: seeded.revision,
      payload: {
        device: { id: 'D-002', name: '设备 B', manufacturer: '厂家 B', status: 'enabled' },
        ...meta('DEVICE-ADD')
      }
    });
    assert.equal(device.ok, true);
    assert.equal(device.state.deviceProfiles.length, 2);

    const channel = await service.execute({
      type: 'upsertChannel', expectedRevision: device.state.revision,
      payload: {
        channel: { device: '设备 B', name: '001', state: 'free', voltage: 5, current: 100 },
        ...meta('CHANNEL-ADD')
      }
    });
    assert.equal(channel.ok, true);
    assert.equal(channel.state.channels.at(-1).key, '设备 B|001');
    assert.equal(channel.state.auditLogs[0].action, '新增通道');

    const duplicate = await service.execute({
      type: 'upsertDevice', expectedRevision: channel.state.revision,
      payload: { device: { id: 'D-003', name: '设备 B' }, ...meta('DEVICE-DUPLICATE') }
    });
    assert.equal(duplicate.ok, false);
    assert.equal(duplicate.code, 'DEVICE_NAME_DUPLICATE');
  });
});

test('active channel end rejects invalid or non-forward values without save, revision, or SQLite changes', async () => {
  const cases = [
    {
      name: 'busy actualStart', state: 'busy', pointer: 'currentRecordId', status: 'running',
      record: { actualStart: '2026-08-20T10:00:00-07:00', start: '2026-08-20T09:00:00-07:00', time: '2026-08-20T08:00:00-07:00' },
      ends: ['not-a-date', '2026-08-20T10:00:00-07:00', '2026-08-20T09:59:59-07:00']
    },
    {
      name: 'booked start', state: 'booked', pointer: 'nextRecordId', status: 'reserved',
      record: { start: '2026-08-20T12:00:00-07:00', time: '2026-08-20T11:00:00-07:00' },
      ends: ['not-a-date', '2026-08-20T12:00:00-07:00', '2026-08-20T11:59:59-07:00']
    },
    {
      name: 'busy time fallback', state: 'busy', pointer: 'currentRecordId', status: 'running',
      record: { time: '2026-08-20T13:00:00-07:00' },
      ends: ['not-a-date', '2026-08-20T13:00:00-07:00']
    }
  ];

  for (const scenario of cases) {
    const recordId = `REC-${scenario.name.replace(/\W+/g, '-').toUpperCase()}`;
    const initial = stateFixture({
      channels: [{
        key: '设备 A|001', device: '设备 A', name: '001', state: scenario.state,
        project: '项目 A', user: 'admin', start: scenario.record.start ?? scenario.record.time,
        end: '2026-08-21T10:00:00-07:00', currentRecordId: '', nextRecordId: '',
        [scenario.pointer]: recordId
      }],
      records: [{
        id: recordId, requestNo: 'REQ-001', sampleId: 'REQ-001.001', channelKey: '设备 A|001',
        keys: ['设备 A|001'], status: scenario.status, ...scenario.record,
        end: '2026-08-21T10:00:00-07:00'
      }]
    });
    await withStore(async ({ dataRoot, store, seeded }) => {
      let saves = 0;
      const service = createApplicationCommandService({
        store: {
          load: (...args) => store.load(...args),
          save: (...args) => { saves += 1; return store.save(...args); }
        }
      });
      const bytes = await sqliteBytes(dataRoot);
      for (let index = 0; index < scenario.ends.length; index += 1) {
        const result = await service.execute({
          type: 'upsertChannel', expectedRevision: seeded.revision,
          payload: {
            channelKey: '设备 A|001',
            channel: { ...seeded.channels[0], end: scenario.ends[index] },
            ...meta(`ACTIVE-END-${scenario.name}-${index}`)
          }
        });
        assert.equal(result.ok, false, `${scenario.name}/${scenario.ends[index]}`);
        assert.equal(result.code, 'ACTIVE_CHANNEL_END_BEFORE_START');
        assert.match(result.message, /不能/);
        assert.equal(saves, 0);
        assert.equal(result.state, undefined);
        assert.equal((await store.load()).state.revision, seeded.revision);
        assert.deepEqual(await sqliteBytes(dataRoot), bytes);
      }
    }, initial);
  }
});

test('active channel end rejects more than 100 calendar years but keeps empty open-end semantics', async () => {
  const recordId = 'REC-ACTIVE-RANGE';
  const initial = stateFixture({
    channels: [{
      key: '设备 A|001', device: '设备 A', name: '001', state: 'busy', project: '项目 A', user: 'admin',
      start: '2026-08-20T10:00:00-07:00', end: '2026-08-21T10:00:00-07:00', currentRecordId: recordId, nextRecordId: ''
    }],
    records: [{
      id: recordId, requestNo: 'REQ-001', sampleId: 'REQ-001.001', channelKey: '设备 A|001', keys: ['设备 A|001'],
      status: 'running', actualStart: '2026-08-20T10:00:00-07:00', start: '2026-08-20T09:00:00-07:00', end: '2026-08-21T10:00:00-07:00'
    }]
  });
  await withStore(async ({ dataRoot, store, seeded }) => {
    let saves = 0;
    const service = createApplicationCommandService({
      store: {
        load: (...args) => store.load(...args),
        save: (...args) => { saves += 1; return store.save(...args); }
      }
    });
    const bytes = await sqliteBytes(dataRoot);
    const extreme = await service.execute({
      type: 'upsertChannel', expectedRevision: seeded.revision,
      payload: {
        channelKey: '设备 A|001', channel: { ...seeded.channels[0], end: '2126-08-21T14:00:00-07:00' },
        ...meta('ACTIVE-END-RANGE')
      }
    });
    assert.equal(extreme.ok, false);
    assert.equal(extreme.code, 'ACTIVE_CHANNEL_END_OUT_OF_RANGE');
    assert.match(extreme.message, /不能/);
    assert.equal(saves, 0);
    assert.equal((await store.load()).state.revision, seeded.revision);
    assert.deepEqual(await sqliteBytes(dataRoot), bytes);

    const openEnded = await service.execute({
      type: 'upsertChannel', expectedRevision: seeded.revision,
      payload: {
        channelKey: '设备 A|001', channel: { ...seeded.channels[0], end: '' },
        ...meta('ACTIVE-END-OPEN')
      }
    });
    assert.equal(openEnded.ok, true);
    assert.equal(openEnded.state.channels[0].end, '');
    assert.equal(saves, 1);
    assert.equal(openEnded.state.revision, seeded.revision + 1);
  }, initial);
});
