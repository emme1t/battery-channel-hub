import test from 'node:test';
import assert from 'node:assert/strict';

import { analyzeLegacyState } from '../src/migration/legacy-state.mjs';
import {
  makeConflictingLegacyState,
  makeLegacyState
} from './fixtures/legacy-state-fixtures.mjs';

const options = {
  migratedAt: '2026-08-20T19:30:00.000Z',
  migrationAuditId: 'AUD-MIGRATION-001'
};

test('legacy request and multi-channel record convert deterministically without mutating input', () => {
  const legacy = makeLegacyState();
  const before = structuredClone(legacy);

  const result = analyzeLegacyState(legacy, options);

  assert.equal(result.ok, true);
  assert.deepEqual(legacy, before);
  assert.deepEqual(result.state.samples.map((item) => item.id), ['R-001.001', 'R-001.002']);
  assert.deepEqual(result.state.samples.map((item) => item.status), ['running', 'running']);
  assert.deepEqual(result.state.records.map((item) => item.id), ['USE-001.001', 'USE-001.002']);
  assert.deepEqual(result.state.records.map((item) => item.channelKey), ['设备 A|1', '设备 A|2']);
  assert.deepEqual(result.state.channels.map((item) => item.currentRecordId), ['USE-001.001', 'USE-001.002']);
  assert.equal(result.state.audits.at(-1).action, 'migrate-legacy-state');
  assert.equal(result.state.audits.at(-1).toolVersion, 'vnext-migration/0.1');
  assert.equal(result.state.audits.at(-1).warningCount, 0);
  assert.equal(result.targetSummary.requests, 1);
  assert.equal(result.targetSummary.samples, 2);
  assert.equal(result.targetSummary.records, 2);
});

test('raw application fields stay separate from editable execution fields', () => {
  const result = analyzeLegacyState(makeLegacyState(), options);
  const request = result.state.requests[0];

  assert.deepEqual(request.rawFields, { 委托单号: 'R-001', 测试人员: '原始值不得覆盖' });
  assert.deepEqual(request.execution, {
    tester: '测试员 A',
    fee: 120,
    device: '设备 A',
    plannedStart: '2026-08-20 09:00',
    plannedEnd: '2026-08-20 12:00',
    note: '执行备注'
  });
  assert.equal(request.sourceFileName, 'legacy.xlsx');
  assert.equal(request.sourceFilePath, 'C:\\legacy\\legacy.xlsx');
  assert.equal(request.legacySnapshot.extraLegacyField, '保留快照');
});

test('invalid quantity, duplicate channel and unknown channel block the whole conversion', () => {
  const result = analyzeLegacyState(makeConflictingLegacyState(), options);

  assert.equal(result.ok, false);
  assert.equal('state' in result, false);
  assert.match(result.blockers.join('\n'), /quantity.*1 to 999/i);
  assert.match(result.blockers.join('\n'), /duplicate channel key 设备 A\|1/i);
  assert.match(result.blockers.join('\n'), /unknown channel UNKNOWN\|9/i);
});

test('record expansion exceeding request quantity is blocked', () => {
  const legacy = makeLegacyState();
  legacy.requests[0].qty = 1;

  const result = analyzeLegacyState(legacy, options);

  assert.equal(result.ok, false);
  assert.match(result.blockers.join('\n'), /more channel records than quantity/i);
  assert.equal('state' in result, false);
});

test('two running records on one channel and channel-state conflict are blocked', () => {
  const duplicateRunning = makeLegacyState({
    records: [
      { id: 'USE-1', no: 'R-001', keys: ['设备 A|1'], state: '测试中', time: '2026-08-20 09:00' },
      { id: 'USE-2', no: 'R-001', keys: ['设备 A|1'], state: '测试中', time: '2026-08-20 10:00' }
    ]
  });
  const collision = analyzeLegacyState(duplicateRunning, options);
  assert.equal(collision.ok, false);
  assert.match(collision.blockers.join('\n'), /multiple running records/i);

  const stateConflict = makeLegacyState();
  stateConflict.channels[0].state = 'free';
  const conflict = analyzeLegacyState(stateConflict, options);
  assert.equal(conflict.ok, false);
  assert.match(conflict.blockers.join('\n'), /state free conflicts with derived busy/i);
});

test('unknown record state blocks and missing optional times stay empty', () => {
  const unknown = makeLegacyState();
  unknown.records[0].state = '神秘状态';
  const blocked = analyzeLegacyState(unknown, options);
  assert.equal(blocked.ok, false);
  assert.match(blocked.blockers.join('\n'), /unsupported legacy record status 神秘状态/i);

  const missingTimes = makeLegacyState();
  delete missingTimes.records[0].time;
  delete missingTimes.records[0].end;
  const converted = analyzeLegacyState(missingTimes, options);
  assert.equal(converted.ok, true);
  assert.deepEqual(converted.state.records.map((item) => [item.start, item.end]), [['', ''], ['', '']]);
});

test('legacy page-view audit is retained but reported as a warning', () => {
  const legacy = makeLegacyState({
    auditLogs: [{ id: 'VIEW-1', time: '2026-08-20 08:00', user: 'tester', action: '查看页面', target: '页面 board' }]
  });

  const result = analyzeLegacyState(legacy, options);

  assert.equal(result.ok, true);
  assert.equal(result.state.audits[0].source, 'legacy');
  assert.equal(result.state.audits[0].result, 'legacy');
  assert.match(result.warnings.join('\n'), /page-view audit VIEW-1/i);
});
