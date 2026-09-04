import assert from 'node:assert/strict';
import test from 'node:test';

import {
  deleteRequests,
  deleteTester,
  editExecutionFields,
  executionView,
  importRequests,
  upsertTester
} from '../src/domain/legacy-request-transactions.mjs';

function request(overrides = {}) {
  return {
    id: 'REQ-001',
    qty: 2,
    test: '循环测试',
    project: '无人机项目',
    sample: '35Ah',
    client: '原始委托人',
    tester: '旧版平铺测试员',
    rawFields: { 申请单号: 'REQ-001', 委托人: '原始委托人', 嵌套: { 值: 1 } },
    sourceFile: 'REQ-001.xlsx',
    sourcePath: 'C:\\imports\\REQ-001.xlsx',
    execution: {
      tester: '测试员 A', fee: 10, device: '设备 A',
      plannedStart: '2026-08-20', plannedEnd: '2026-08-21', note: '原备注'
    },
    ...overrides
  };
}

function sample(id, overrides = {}) {
  return {
    id,
    requestNo: 'REQ-001',
    ordinal: Number(id.split('.').at(-1)),
    status: 'pending', channelKey: '', start: '', end: '', hasHistory: false,
    ...overrides
  };
}

function state(overrides = {}) {
  return {
    revision: 1,
    requests: [request()],
    samples: [sample('REQ-001.001'), sample('REQ-001.002')],
    channels: [],
    deviceProfiles: [],
    records: [],
    storageRecords: [],
    requestSourceRows: [{ id: 'REQ-001', sourceFile: 'REQ-001.xlsx' }],
    auditLogs: [],
    formChangeJournal: [],
    testers: [{ id: 'T-001', name: '测试员 A', dept: '研发部', status: '启用' }],
    username: 'admin',
    savedAt: '',
    ...overrides
  };
}

function metadata(overrides = {}) {
  return {
    actor: 'admin',
    auditId: 'AUDIT-001',
    journalId: 'JOURNAL-001',
    now: '2026-08-20T10:00:00-07:00',
    ...overrides
  };
}

function imported(id, quantity = 1, overrides = {}) {
  return {
    id,
    qty: quantity,
    test: '倍率测试',
    project: `导入项目 ${id}`,
    sample: '50Ah',
    client: '新委托人',
    rawFields: { 申请单号: id, 委托人: '新委托人', 原始值: `raw-${id}` },
    sourceFile: `${id}.xlsx`,
    sourcePath: `C:\\imports\\${id}.xlsx`,
    ...overrides
  };
}

test('editing execution fields never changes imported raw fields or source trace', () => {
  const before = state();
  const snapshot = structuredClone(before);
  const rawBefore = JSON.stringify(before.requests[0].rawFields);
  const next = editExecutionFields(before, {
    requestNo: 'REQ-001',
    fields: {
      tester: '李雷', fee: 20, device: '设备 B',
      plannedStart: '2026-08-22', plannedEnd: '2026-08-23', note: '复核'
    },
    ...metadata()
  });

  assert.equal(JSON.stringify(next.requests[0].rawFields), rawBefore);
  assert.equal(next.requests[0].sourceFile, before.requests[0].sourceFile);
  assert.equal(next.requests[0].sourcePath, before.requests[0].sourcePath);
  assert.equal(next.requests[0].tester, '旧版平铺测试员');
  assert.equal(next.requests[0].execution.tester, '李雷');
  assert.equal(next.requests[0].execution.fee, 20);
  assert.deepEqual(next.formChangeJournal.at(-1).before, snapshot.requests[0].execution);
  assert.deepEqual(next.formChangeJournal.at(-1).after, next.requests[0].execution);
  assert.equal(next.auditLogs[0].id, 'AUDIT-001');
  assert.deepEqual(before, snapshot);

  const view = executionView(next.requests[0]);
  assert.equal(view.tester, '李雷');
  assert.equal(view.startDate, '2026-08-22');
  assert.equal(view.end, '2026-08-23');
  assert.equal(view.rawFields.委托人, '原始委托人');
});

test('unchanged execution fields are rejected without state, journal, or audit writes', () => {
  const before = state({
    requests: [request({
      execution: {
        tester: '测试员 A', fee: 10, device: '设备 A',
        plannedStart: '2026-08-20', plannedEnd: '2026-08-21', note: ''
      }
    })]
  });
  const snapshot = structuredClone(before);

  assert.throws(
    () => editExecutionFields(before, {
      requestNo: 'REQ-001', fields: { note: '' }, ...metadata()
    }),
    error => error.code === 'EXECUTION_FIELDS_UNCHANGED'
  );
  assert.deepEqual(before, snapshot);
  assert.equal(before.revision, snapshot.revision);
  assert.deepEqual(before.auditLogs, snapshot.auditLogs);
  assert.deepEqual(before.formChangeJournal, snapshot.formChangeJournal);
});

test('unknown execution fields and duplicate journal identifiers are atomic blockers', () => {
  const before = state({ formChangeJournal: [{ id: 'JOURNAL-001' }] });
  const snapshot = structuredClone(before);
  assert.throws(
    () => editExecutionFields(before, {
      requestNo: 'REQ-001', fields: { rawFields: { 委托人: '篡改' } }, ...metadata()
    }),
    error => error.code === 'EXECUTION_FIELD_UNSUPPORTED'
  );
  assert.throws(
    () => editExecutionFields(before, {
      requestNo: 'REQ-001', fields: { tester: '李雷' }, ...metadata()
    }),
    error => error.code === 'IDENTIFIER_ALREADY_EXISTS'
  );
  assert.deepEqual(before, snapshot);
});

test('abort-on-error blocks the whole import while commit-valid records one WARNING audit', () => {
  const before = state();
  const snapshot = structuredClone(before);
  const command = {
    records: [imported('REQ-002', 3)],
    errors: [{ file: 'bad.xlsx', code: 'WORKBOOK_INVALID', message: '损坏文件' }],
    strategy: 'abort-on-error',
    duplicateMode: 'skip',
    ...metadata()
  };
  assert.throws(() => importRequests(before, command), error => error.code === 'IMPORT_ERRORS_BLOCK');
  assert.deepEqual(before, snapshot);

  const committed = importRequests(before, { ...command, strategy: 'commit-valid' });
  assert.equal(committed.requests.some(item => item.id === 'REQ-002'), true);
  assert.equal(committed.samples.filter(item => item.requestNo === 'REQ-002').length, 3);
  assert.equal(committed.auditLogs[0].level, 'warning');
  assert.equal(committed.auditLogs[0].after.committed, 1);
  assert.equal(committed.auditLogs[0].after.errors.length, 1);
});

test('duplicate skip preserves the existing request and cover preserves execution with raw history', () => {
  const before = state();
  const rawBefore = structuredClone(before.requests[0].rawFields);
  const skipped = importRequests(before, {
    records: [imported('REQ-001', 2)], errors: [], strategy: 'abort-on-error',
    duplicateMode: 'skip', ...metadata()
  });
  assert.deepEqual(skipped.requests[0].rawFields, rawBefore);
  assert.equal(skipped.auditLogs[0].after.skipped, 1);

  const covered = importRequests(before, {
    records: [imported('REQ-001', 3)], errors: [], strategy: 'abort-on-error',
    duplicateMode: 'cover', ...metadata({ auditId: 'AUDIT-COVER', journalId: 'JOURNAL-COVER' })
  });
  assert.equal(covered.requests[0].qty, 3);
  assert.equal(covered.requests[0].rawFields.原始值, 'raw-REQ-001');
  assert.deepEqual(covered.requests[0].execution, before.requests[0].execution);
  assert.deepEqual(covered.requests[0].rawHistory[0].rawFields, rawBefore);
  assert.equal(covered.samples.filter(item => item.requestNo === 'REQ-001').length, 3);
});

test('cover import touching active records or historical quantity is an all-or-nothing blocker', () => {
  const active = state({
    records: [{ id: 'REC-1', no: 'REQ-001', requestNo: 'REQ-001', state: '测试中', status: 'running' }]
  });
  const activeSnapshot = structuredClone(active);
  assert.throws(
    () => importRequests(active, {
      records: [imported('REQ-001', 2), imported('REQ-002', 1)], errors: [],
      strategy: 'abort-on-error', duplicateMode: 'cover', ...metadata()
    }),
    error => error.code === 'REQUEST_ACTIVE_REFERENCE_BLOCK'
  );
  assert.deepEqual(active, activeSnapshot);

  const historical = state({
    samples: [sample('REQ-001.001'), sample('REQ-001.002', { hasHistory: true })]
  });
  assert.throws(
    () => importRequests(historical, {
      records: [imported('REQ-001', 1)], errors: [], strategy: 'abort-on-error',
      duplicateMode: 'cover', ...metadata()
    }),
    error => error.code === 'SAMPLE_HISTORY_BLOCK'
  );
});

test('batch delete blocks on any active request and otherwise preserves historical records', () => {
  const second = request({ id: 'REQ-002', qty: 1, rawFields: { 申请单号: 'REQ-002' } });
  const before = state({
    requests: [request(), second],
    samples: [sample('REQ-001.001'), sample('REQ-001.002'), sample('REQ-002.001', { requestNo: 'REQ-002' })],
    records: [{ id: 'REC-1', no: 'REQ-002', requestNo: 'REQ-002', state: '已预约', status: 'reserved' }]
  });
  const snapshot = structuredClone(before);
  assert.throws(
    () => deleteRequests(before, {
      requestNos: ['REQ-001', 'REQ-002'], ...metadata()
    }),
    error => error.code === 'REQUEST_ACTIVE_REFERENCE_BLOCK'
  );
  assert.deepEqual(before, snapshot);

  const historical = state({
    records: [{ id: 'REC-H', no: 'REQ-001', requestNo: 'REQ-001', state: '已结束', status: 'completed' }]
  });
  const deleted = deleteRequests(historical, { requestNos: ['REQ-001'], ...metadata() });
  assert.equal(deleted.requests.length, 0);
  assert.equal(deleted.samples.length, 0);
  assert.equal(deleted.requestSourceRows.length, 0);
  assert.equal(deleted.records.length, 1);
  assert.equal(deleted.records[0].id, 'REC-H');
});

test('request deletion blocks active storage but preserves completed and returned storage history', () => {
  for (const status of ['storing', 'exception']) {
    const before = state({
      storageRecords: [{
        id: `STO-${status}`, requestNo: 'REQ-001', sampleIds: ['REQ-001.001'],
        status, startedAt: '2026-08-20T08:00:00.000Z', endedAt: ''
      }]
    });
    const snapshot = structuredClone(before);
    assert.throws(
      () => deleteRequests(before, { requestNos: ['REQ-001'], ...metadata() }),
      error => error.code === 'REQUEST_ACTIVE_REFERENCE_BLOCK'
    );
    assert.deepEqual(before, snapshot);
  }

  for (const status of ['completed', 'returned']) {
    const historical = state({
      storageRecords: [{
        id: `STO-${status}`, requestNo: 'REQ-001', sampleIds: ['REQ-001.001'],
        status, startedAt: '2026-08-20T08:00:00.000Z', endedAt: '2026-08-21T08:00:00.000Z'
      }]
    });
    const deleted = deleteRequests(historical, { requestNos: ['REQ-001'], ...metadata() });
    assert.equal(deleted.requests.length, 0);
    assert.equal(deleted.storageRecords.length, 1);
    assert.equal(deleted.storageRecords[0].status, status);
  }
});

test('tester upsert rejects duplicate names and deletion never rewrites historical request names', () => {
  const before = state();
  const snapshot = structuredClone(before);
  assert.throws(
    () => upsertTester(before, {
      tester: { id: 'T-002', name: '测试员 A', dept: '其它部门' }, ...metadata()
    }),
    error => error.code === 'TESTER_NAME_DUPLICATE'
  );
  assert.deepEqual(before, snapshot);

  const added = upsertTester(before, {
    tester: { id: 'T-002', name: '测试员 B', dept: '测试部', status: '启用' },
    ...metadata({ auditId: 'AUDIT-ADD' })
  });
  assert.equal(added.testers.length, 2);

  const deleted = deleteTester(before, {
    testerId: 'T-001', ...metadata({ auditId: 'AUDIT-DELETE' })
  });
  assert.equal(deleted.testers.length, 0);
  assert.equal(deleted.requests[0].execution.tester, '测试员 A');
  assert.equal(deleted.requests[0].tester, '旧版平铺测试员');
});
