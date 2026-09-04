import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import XLSX from 'xlsx';

import { createLegacySqliteStore, SQLITE_FILE } from '../../src/main/legacy-sqlite-store.mjs';
import { summarizeLegacyState } from '../../src/main/legacy-state-schema.mjs';
import { makeProductionScaleState } from '../fixtures/production-scale.mjs';

const require = createRequire(import.meta.url);
const preset = require('../../lib/device-preset.js');
const FIXTURE_KINDS = new Set([
  'baseline', 'production-529', 'production-999', 'history-2000', 'queue', 'history', 'import-mixed'
]);

function fixedTime(clock) {
  const value = new Date(clock());
  if (Number.isNaN(value.getTime())) throw new TypeError('clock must return a valid date');
  return value.toISOString();
}

function request(id, quantity, at, overrides = {}) {
  return {
    id,
    qty: quantity,
    test: '循环寿命测试',
    project: `WF fixture ${id}`,
    sample: 'WF-CELL',
    client: 'WF fixture',
    dept: '测试部',
    tester: 'WF tester',
    fee: 0,
    device: '',
    startDate: at,
    end: at,
    note: '',
    status: '待安排',
    rawFields: { 委托单号: id, 样品数量: quantity },
    sourceFile: `${id}.xlsx`,
    sourcePath: `${id}.xlsx`,
    execution: { tester: 'WF tester', fee: 0, device: '', plannedStart: at, plannedEnd: at, note: '' },
    ...structuredClone(overrides)
  };
}

function samplesFor(requestId, quantity, status = 'pending', overrides = {}) {
  return Array.from({ length: quantity }, (_, index) => ({
    id: `${requestId}.${String(index + 1).padStart(3, '0')}`,
    requestNo: requestId,
    ordinal: index + 1,
    status,
    channelKey: '',
    start: '',
    end: '',
    hasHistory: status === 'completed',
    ...structuredClone(overrides)
  }));
}

function baseState({ quantity = 0, channelCount = 529, clock }) {
  const generated = makeProductionScaleState({ requestCount: 1, channelCount, auditCount: 0 });
  const at = fixedTime(clock);
  const requestId = `REQ-WF-${String(quantity).padStart(3, '0')}`;
  const channels = preset.channels().slice(0, generated.channels.length).map(channel => structuredClone(channel));
  const deviceProfiles = preset.devices().map(device => ({ ...structuredClone(device), id: `WF-${device.id}` }));
  return {
    revision: 0,
    requests: quantity === 0 ? [] : [request(requestId, quantity, at)],
    channels,
    deviceProfiles,
    records: [],
    storageRecords: [],
    samples: quantity === 0 ? [] : samplesFor(requestId, quantity),
    requestSourceRows: quantity === 0 ? [] : [{ id: requestId, requestNo: requestId, sourceFile: `${requestId}.xlsx`, sourcePath: `${requestId}.xlsx` }],
    auditLogs: [],
    formChangeJournal: [],
    testers: [{ id: 'WF-tester-001', name: 'WF tester', dept: '测试部', status: '启用' }],
    username: 'WF fixture',
    savedAt: ''
  };
}

function completedHistory(state, { count, at }) {
  state.records = Array.from({ length: count }, (_, index) => {
    const sample = state.samples[index % state.samples.length];
    const channel = state.channels[index % state.channels.length];
    return {
      id: `WF-record-${String(index + 1).padStart(4, '0')}`,
      no: sample.requestNo,
      requestNo: sample.requestNo,
      sampleId: sample.id,
      keys: [channel.key],
      channelKey: channel.key,
      channels: `${channel.device} 路 ${channel.name}`,
      state: '已结束',
      status: 'completed',
      time: at,
      start: at,
      end: at,
      actualEnd: at,
      user: 'WF tester',
      project: 'WF fixture history',
      test: '循环寿命测试',
      source: 'WF fixture'
    };
  });
  state.auditLogs = Array.from({ length: count }, (_, index) => ({
    id: `WF-audit-${String(index + 1).padStart(4, '0')}`,
    time: at,
    at,
    user: 'WF tester',
    actor: 'WF tester',
    action: 'fixture-history',
    target: `WF record ${index + 1}`,
    outcome: 'success',
    result: 'success',
    verified: true,
    level: 'normal'
  }));
}

function queueState(clock, workflowId) {
  if (workflowId === 'S05') {
    const state = baseState({ quantity: 0, channelCount: 529, clock });
    const at = fixedTime(clock);
    const expectedEnd = new Date(Date.parse(at) + 60 * 60 * 1_000).toISOString();
    const runningRequest = request('REQ-WF-RUNNING-001', 1, at, { status: '测试中' });
    const nextRequest = request('REQ-WF-QUEUE-NEXT-001', 1, at);
    const runningChannel = state.channels[0];
    const runningRecord = {
      id: 'WF-record-running-001', no: runningRequest.id, requestNo: runningRequest.id,
      sampleId: `${runningRequest.id}.001`, keys: [runningChannel.key], channelKey: runningChannel.key,
      channels: `${runningChannel.device} 路 ${runningChannel.name}`, state: '测试中', status: 'running',
      time: at, start: at, end: expectedEnd, user: 'WF tester', project: runningRequest.project, test: runningRequest.test, source: 'WF fixture'
    };
    Object.assign(runningChannel, { state: 'busy', requestNo: runningRequest.id, currentRecordId: runningRecord.id, nextRecordId: '', end: expectedEnd });
    state.requests = [runningRequest, nextRequest];
    state.samples = [
      ...samplesFor(runningRequest.id, 1, 'running', { channelKey: runningChannel.key, start: at }),
      ...samplesFor(nextRequest.id, 1)
    ];
    state.records = [runningRecord];
    state.requestSourceRows = state.requests.map(item => ({ id: item.id, requestNo: item.id, sourceFile: item.sourceFile, sourcePath: item.sourcePath }));
    state.auditLogs = [{ id: 'WF-audit-queue-001', time: at, at, user: 'WF tester', actor: 'WF tester', action: 'fixture-queue', target: runningRequest.id, outcome: 'success', result: 'success', verified: true, level: 'normal' }];
    return state;
  }
  const state = baseState({ quantity: 0, channelCount: 529, clock });
  const at = fixedTime(clock);
  const runningRequest = request('REQ-WF-RUNNING-001', 1, at, { status: '测试中' });
  const reservedRequest = request('REQ-WF-QUEUE-001', 1, at, { status: '已预约' });
  const runningChannel = state.channels[0];
  const runningRecord = {
    id: 'WF-record-running-001', no: runningRequest.id, requestNo: runningRequest.id,
    sampleId: `${runningRequest.id}.001`, keys: [runningChannel.key], channelKey: runningChannel.key,
    channels: `${runningChannel.device} 路 ${runningChannel.name}`, state: '测试中', status: 'running',
    time: at, start: at, end: at, user: 'WF tester', project: runningRequest.project, test: runningRequest.test, source: 'WF fixture'
  };
  const reservedRecord = {
    id: 'WF-record-reserved-001', no: reservedRequest.id, requestNo: reservedRequest.id,
    sampleId: `${reservedRequest.id}.001`, keys: [runningChannel.key], channelKey: runningChannel.key,
    channels: `${runningChannel.device} 路 ${runningChannel.name}`, state: '已预约', status: 'reserved',
    time: at, start: at, end: at, user: 'WF tester', project: reservedRequest.project, test: reservedRequest.test, source: 'WF fixture'
  };
  Object.assign(runningChannel, {
    state: 'busy', requestNo: runningRequest.id,
    currentRecordId: runningRecord.id, nextRecordId: reservedRecord.id, end: at
  });
  state.requests = [runningRequest, reservedRequest];
  state.samples = [
    ...samplesFor(runningRequest.id, 1, 'running', { channelKey: runningChannel.key, start: at }),
    ...samplesFor(reservedRequest.id, 1, 'reserved', { channelKey: runningChannel.key, start: at })
  ];
  state.records = [runningRecord, reservedRecord];
  state.requestSourceRows = state.requests.map(item => ({ id: item.id, requestNo: item.id, sourceFile: item.sourceFile, sourcePath: item.sourcePath }));
  state.auditLogs = [{ id: 'WF-audit-queue-001', time: at, at, user: 'WF tester', actor: 'WF tester', action: 'fixture-queue', target: runningRequest.id, outcome: 'success', result: 'success', verified: true, level: 'normal' }];
  return state;
}

function pendingRequestState(clock, requestId, quantity) {
  const state = baseState({ quantity: 0, channelCount: 529, clock });
  const at = fixedTime(clock);
  const pending = request(requestId, quantity, at);
  state.requests = [pending];
  state.samples = samplesFor(pending.id, quantity);
  state.requestSourceRows = [{ id: pending.id, requestNo: pending.id, sourceFile: pending.sourceFile, sourcePath: pending.sourcePath }];
  return state;
}

function addActiveRecord(state, { clock, requestId, sampleId = `${requestId}.001`, status, channelIndex, recordId }) {
  const at = fixedTime(clock);
  const end = new Date(new Date(at).getTime() + 4 * 60 * 60 * 1_000).toISOString();
  let targetRequest = state.requests.find(item => item.id === requestId);
  if (!targetRequest) {
    targetRequest = request(requestId, 1, at, { status: status === 'running' ? '测试中' : '已预约' });
    state.requests.push(targetRequest);
    state.requestSourceRows.push({ id: targetRequest.id, requestNo: targetRequest.id, sourceFile: targetRequest.sourceFile, sourcePath: targetRequest.sourcePath });
  }
  let sample = state.samples.find(item => item.id === sampleId);
  if (!sample) {
    sample = samplesFor(requestId, 1, status)[0];
    sample.id = sampleId;
    state.samples.push(sample);
  }
  const channel = state.channels[channelIndex];
  if (!channel) throw new Error(`fixture channel index unavailable: ${channelIndex}`);
  Object.assign(sample, { status, channelKey: channel.key, start: at, end });
  const record = {
    id: recordId, no: requestId, requestNo: requestId, sampleId,
    keys: [channel.key], channelKey: channel.key, channels: `${channel.device} 路 ${channel.name}`,
    state: status === 'running' ? '测试中' : '已预约', status,
    time: at, start: at, end, user: 'WF tester', project: targetRequest.project,
    test: targetRequest.test, source: 'WF fixture'
  };
  state.records.push(record);
  Object.assign(channel, {
    state: status === 'running' ? 'busy' : 'booked', requestNo: requestId,
    currentRecordId: status === 'running' ? record.id : '',
    nextRecordId: status === 'reserved' ? record.id : '', end
  });
  return record;
}

function addChaosPendingRequests(state, clock, activityId, count) {
  const at = fixedTime(clock);
  for (let index = 0; index < count; index += 1) {
    const requestId = `REQ-WF-${activityId}-PENDING-${String(index + 1).padStart(3, '0')}`;
    const pending = request(requestId, 1, at);
    state.requests.push(pending);
    state.samples.push(...samplesFor(requestId, 1));
    state.requestSourceRows.push({
      id: pending.id,
      requestNo: pending.id,
      sourceFile: pending.sourceFile,
      sourcePath: pending.sourcePath
    });
  }
}

function chaosBaselineState(clock, activityId) {
  const state = baseState({ quantity: 0, channelCount: 529, clock });
  if (activityId === 'C03') {
    addChaosPendingRequests(state, clock, activityId, 40);
    return state;
  }
  const sizes = activityId === 'C02'
    ? { pending: 160, reserved: 60, running: 60 }
    : { pending: 120, reserved: 40, running: 40 };
  addChaosPendingRequests(state, clock, activityId, sizes.pending);
  for (let index = 0; index < sizes.reserved; index += 1) {
    const requestId = `REQ-WF-${activityId}-RESERVED-${String(index + 1).padStart(3, '0')}`;
    addActiveRecord(state, {
      clock,
      requestId,
      status: 'reserved',
      channelIndex: index,
      recordId: `WF-record-${activityId.toLowerCase()}-reserved-${String(index + 1).padStart(3, '0')}`
    });
  }
  for (let index = 0; index < sizes.running; index += 1) {
    const requestId = `REQ-WF-${activityId}-RUNNING-${String(index + 1).padStart(3, '0')}`;
    addActiveRecord(state, {
      clock,
      requestId,
      status: 'running',
      channelIndex: sizes.reserved + index,
      recordId: `WF-record-${activityId.toLowerCase()}-running-${String(index + 1).padStart(3, '0')}`
    });
  }
  return state;
}

function runningState(clock, requestId, recordId) {
  const state = baseState({ quantity: 0, channelCount: 529, clock });
  addActiveRecord(state, { clock, requestId, status: 'running', channelIndex: 0, recordId });
  return state;
}

function m06State(clock) {
  const state = runningState(clock, 'REQ-WF-M06-RUNNING-001', 'WF-record-m06-running-001');
  const formDate = fixedTime(clock).slice(0, 10);
  state.requests[0].execution.plannedStart = formDate;
  state.requests[0].execution.plannedEnd = formDate;
  return state;
}

function m12State(clock) {
  const state = runningState(clock, 'REQ-WF-M12-RUNNING-001', 'WF-record-m12-running-001');
  const at = fixedTime(clock);
  const pending = request('REQ-WF-M12-PENDING-001', 1, at);
  state.requests.push(pending);
  state.samples.push(...samplesFor(pending.id, 1));
  state.requestSourceRows.push({ id: pending.id, requestNo: pending.id, sourceFile: pending.sourceFile, sourcePath: pending.sourcePath });
  return state;
}

function addM04PaginationData(state, clock) {
  const at = fixedTime(clock);
  const primary = request('REQ-WF-M04-001', 50, at, { status: '已预约' });
  state.requests.push(primary);
  state.samples.push(...samplesFor(primary.id, 50));
  state.requestSourceRows.push({ id: primary.id, requestNo: primary.id, sourceFile: primary.sourceFile, sourcePath: primary.sourcePath });
  for (let index = 2; index <= 100; index += 1) {
    const id = `REQ-WF-M04-${String(index).padStart(3, '0')}`;
    const extra = request(id, 1, at);
    state.requests.push(extra);
    state.samples.push(...samplesFor(id, 1));
    state.requestSourceRows.push({ id, requestNo: id, sourceFile: extra.sourceFile, sourcePath: extra.sourcePath });
  }
  for (let index = 0; index < 30; index += 1) {
    addActiveRecord(state, {
      clock, requestId: primary.id,
      sampleId: `${primary.id}.${String(index + 2).padStart(3, '0')}`,
      status: 'reserved', channelIndex: index,
      recordId: `WF-record-m04-reserved-${String(index + 1).padStart(3, '0')}`
    });
  }
}

function addM07ActiveData(state, clock) {
  addActiveRecord(state, { clock, requestId: 'REQ-WF-M07-ACTIVE-001', status: 'running', channelIndex: 0, recordId: 'WF-record-m07-running-001' });
  const at = fixedTime(clock);
  const requestId = 'REQ-WF-M07-STORAGE-001';
  const storageRequest = request(requestId, 1, at, { status: '测试中' });
  const [storageSample] = samplesFor(requestId, 1, 'storing', { hasHistory: true });
  state.requests.push(storageRequest);
  state.samples.push(storageSample);
  state.requestSourceRows.push({ id: requestId, requestNo: requestId, sourceFile: storageRequest.sourceFile, sourcePath: storageRequest.sourcePath });
  state.storageRecords.push({
    id: 'STO-WF-M07-001', requestNo: requestId, sampleIds: [storageSample.id], tester: 'WF tester',
    status: 'storing', startedAt: at, expectedEndAt: '2026-09-30T12:00:00.000Z', endedAt: '',
    note: 'M07 活动长期存储', returnReason: ''
  });
}

function addS08StoragePendingData(state, clock) {
  const at = fixedTime(clock);
  const requestId = 'REQ-WF-S08-STORAGE-001';
  const pending = request(requestId, 1, at);
  state.requests.push(pending);
  state.samples.push(...samplesFor(requestId, 1));
  state.requestSourceRows.push({ id: requestId, requestNo: requestId, sourceFile: pending.sourceFile, sourcePath: pending.sourcePath });
}

function addD04ExactSearchDecoy(state, clock) {
  const at = fixedTime(clock);
  const requestId = 'REQ-WF-D04-001-EXTRA';
  const decoy = request(requestId, 1, at, {
    project: '包含 REQ-WF-D04-001 的诱饵项目',
    client: 'REQ-WF-D04-001 包含式诱饵'
  });
  state.requests.push(decoy);
  state.samples.push(...samplesFor(requestId, 1));
  state.requestSourceRows.push({ id: requestId, requestNo: requestId, sourceFile: decoy.sourceFile, sourcePath: decoy.sourcePath });
}

function addM11ActiveData(state, clock) {
  addActiveRecord(state, { clock, requestId: 'REQ-WF-M11-RUNNING-001', status: 'running', channelIndex: 0, recordId: 'WF-record-m11-running-001' });
  addActiveRecord(state, { clock, requestId: 'REQ-WF-M11-RESERVED-001', status: 'reserved', channelIndex: 1, recordId: 'WF-record-m11-reserved-001' });
  const active = state.records.splice(-2);
  state.records.unshift(...active);
}

function d01State(clock) {
  const state = pendingRequestState(clock, 'REQ-WF-D01-001', 2);
  const at = fixedTime(clock);
  const runningRequest = request('REQ-WF-D01-RUNNING-001', 1, at, { status: '测试中' });
  const channel = state.channels[0];
  const runningRecord = {
    id: 'WF-record-d01-running-001', no: runningRequest.id, requestNo: runningRequest.id,
    sampleId: `${runningRequest.id}.001`, keys: [channel.key], channelKey: channel.key,
    channels: `${channel.device} 路 ${channel.name}`, state: '测试中', status: 'running',
    time: at, start: at, end: '', user: 'WF tester', project: runningRequest.project, test: runningRequest.test, source: 'WF fixture'
  };
  state.requests.push(runningRequest);
  state.samples.push(...samplesFor(runningRequest.id, 1, 'running', { channelKey: channel.key, start: at }));
  state.records = [runningRecord];
  state.requestSourceRows.push({ id: runningRequest.id, requestNo: runningRequest.id, sourceFile: runningRequest.sourceFile, sourcePath: runningRequest.sourcePath });
  Object.assign(channel, { state: 'busy', requestNo: runningRequest.id, currentRecordId: runningRecord.id, nextRecordId: '', end: '' });
  return state;
}

function d03QueueState(clock) {
  const state = baseState({ quantity: 0, channelCount: 529, clock });
  const at = fixedTime(clock);
  const runningRequest = request('REQ-WF-RUNNING-001', 1, at, { status: '测试中' });
  const urgentRequest = request('REQ-WF-D03-URGENT-001', 1, at);
  const channel = state.channels[0];
  const runningRecord = {
    id: 'WF-record-d03-running-001', no: runningRequest.id, requestNo: runningRequest.id,
    sampleId: `${runningRequest.id}.001`, keys: [channel.key], channelKey: channel.key,
    channels: `${channel.device} 路 ${channel.name}`, state: '测试中', status: 'running',
    time: at, start: '2026-08-27T08:00', end: '2026-08-27T12:00', user: 'WF tester', project: runningRequest.project, test: runningRequest.test, source: 'WF fixture'
  };
  state.requests = [runningRequest, urgentRequest];
  state.samples = [
    ...samplesFor(runningRequest.id, 1, 'running', { channelKey: channel.key, start: at }),
    ...samplesFor(urgentRequest.id, 1)
  ];
  state.records = [runningRecord];
  state.requestSourceRows = state.requests.map(item => ({ id: item.id, requestNo: item.id, sourceFile: item.sourceFile, sourcePath: item.sourcePath }));
  state.auditLogs = [{ id: 'WF-audit-d03-queue-001', time: at, at, user: 'WF tester', actor: 'WF tester', action: 'fixture-queue', target: runningRequest.id, outcome: 'success', result: 'success', verified: true, level: 'normal' }];
  Object.assign(channel, { state: 'busy', requestNo: runningRequest.id, currentRecordId: runningRecord.id, nextRecordId: '', end: '2026-08-27T12:00' });
  return state;
}

function d02State(clock) {
  const state = pendingRequestState(clock, 'REQ-WF-D02-001', 4);
  const intervals = [
    ['2026-08-27T07:00', '2026-08-27T08:00'],
    ['2026-08-27T08:00', '2026-08-27T10:00'],
    ['2026-08-27T21:00', '2026-08-27T23:00'],
    ['2026-08-28T00:00', '2026-08-28T01:00']
  ];
  const runningRequests = intervals.map(([,], index) => request(`REQ-WF-D02-RUNNING-00${index + 1}`, 1, fixedTime(clock), { status: '测试中' }));
  const records = runningRequests.map((item, index) => {
    const channel = state.channels[index];
    const [start, end] = intervals[index];
    const record = { id: `WF-record-d02-running-00${index + 1}`, no: item.id, requestNo: item.id, sampleId: `${item.id}.001`, keys: [channel.key], channelKey: channel.key, channels: `${channel.device} 路 ${channel.name}`, state: '测试中', status: 'running', time: start, start, end, user: 'WF tester', project: item.project, test: item.test, source: 'WF fixture' };
    Object.assign(channel, { state: 'busy', requestNo: item.id, currentRecordId: record.id, nextRecordId: '', end });
    return record;
  });
  state.requests.push(...runningRequests);
  state.samples.push(...runningRequests.flatMap((item, index) => samplesFor(item.id, 1, 'running', { channelKey: state.channels[index].key, start: intervals[index][0], end: intervals[index][1] })));
  state.records = records;
  state.requestSourceRows.push(...runningRequests.map(item => ({ id: item.id, requestNo: item.id, sourceFile: item.sourceFile, sourcePath: item.sourcePath })));
  return state;
}

function fixtureShape(kind) {
  switch (kind) {
    case 'baseline': return { quantity: 0, history: 0 };
    case 'production-529': return { quantity: 529, history: 0 };
    case 'production-999': return { quantity: 999, history: 0 };
    case 'history-2000': return { quantity: 999, history: 2_000 };
    case 'history': return { quantity: 100, history: 100 };
    case 'import-mixed': return { quantity: 7, history: 0 };
    default: throw new TypeError(`unsupported fixture kind: ${kind}`);
  }
}

function verticalRows(requestNo, quantity, variant) {
  return [
    ['电芯测试申请单', ''],
    ['字段', '填写内容'],
    ['委托单号', requestNo],
    ['归属项目名称', `WF ${variant}`],
    ['样品型号', `WF-${variant}`],
    ['样品数量', quantity],
    ['测试类型', '循环测试'],
    ['申请人', 'WF fixture']
  ];
}

export async function createImportWorkbook({ target, requestNo, quantity, variant = 'vertical' }) {
  if (typeof target !== 'string' || target.trim() === '') throw new TypeError('target is required');
  if (typeof requestNo !== 'string' || requestNo.trim() === '') throw new TypeError('requestNo is required');
  if (!Number.isInteger(quantity) || quantity < 1) throw new TypeError('quantity must be a positive integer');
  const absolute = path.resolve(target);
  await mkdir(path.dirname(absolute), { recursive: true });
  if (variant === 'corrupt') {
    await writeFile(absolute, 'WF corrupt workbook', 'utf8');
    return Object.freeze({ path: absolute, requestNo, quantity, variant });
  }
  const workbook = XLSX.utils.book_new();
  if (variant === 'flat') {
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet([{
      申请单号: requestNo, 项目名称: `WF ${variant}`, 样品数量: quantity, 样品型号: `WF-${variant}`
    }]), '测试申请表格');
  } else if (variant === 'blank') {
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([['字段', '填写内容']]), '申请单模板');
  } else {
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(verticalRows(requestNo, quantity, variant)), '申请单模板');
  }
  XLSX.writeFile(workbook, absolute);
  return Object.freeze({ path: absolute, requestNo, quantity, variant });
}

async function importMaterials(root) {
  const importsRoot = path.join(root, 'imports');
  const paths = {
    vertical: path.join(importsRoot, 'vertical.xlsx'),
    flat: path.join(importsRoot, 'flat.xlsx'),
    blank: path.join(importsRoot, 'blank.xlsx'),
    corrupt: path.join(importsRoot, 'corrupt.xlsx'),
    locked: path.join(importsRoot, '~$locked.xlsx'),
    sameIdDifferent: [path.join(importsRoot, 'same-id-left.xlsx'), path.join(importsRoot, 'same-id-right.xlsx')]
  };
  await createImportWorkbook({ target: paths.vertical, requestNo: 'REQ-WF-IMPORT-001', quantity: 2, variant: 'vertical' });
  await createImportWorkbook({ target: paths.flat, requestNo: 'REQ-WF-IMPORT-002', quantity: 2, variant: 'flat' });
  await createImportWorkbook({ target: paths.blank, requestNo: 'REQ-WF-IMPORT-003', quantity: 2, variant: 'blank' });
  await createImportWorkbook({ target: paths.corrupt, requestNo: 'REQ-WF-IMPORT-004', quantity: 2, variant: 'corrupt' });
  await createImportWorkbook({ target: paths.locked, requestNo: 'REQ-WF-IMPORT-005', quantity: 2, variant: 'locked' });
  await createImportWorkbook({ target: paths.sameIdDifferent[0], requestNo: 'REQ-WF-SAME-001', quantity: 1, variant: 'same-id-left' });
  await createImportWorkbook({ target: paths.sameIdDifferent[1], requestNo: 'REQ-WF-SAME-001', quantity: 1, variant: 'same-id-right' });
  return Object.freeze({ ...paths, sameIdDifferent: Object.freeze(paths.sameIdDifferent) });
}

export async function seedWorkflowFixture({ dataRoot, kind, workflowId, clock = () => new Date() }) {
  if (typeof dataRoot !== 'string' || dataRoot.trim() === '') throw new TypeError('dataRoot is required');
  if (!FIXTURE_KINDS.has(kind)) throw new TypeError(`unsupported fixture kind: ${kind}`);
  const root = path.resolve(dataRoot);
  const at = fixedTime(clock);
  let state;
  if (kind === 'queue') state = workflowId === 'D03' ? d03QueueState(clock) : queueState(clock, workflowId);
  else {
    const shape = fixtureShape(kind);
    if (kind === 'baseline' && ['C02', 'C03', 'C06'].includes(workflowId)) state = chaosBaselineState(clock, workflowId);
    else if (kind === 'baseline' && ['M01', 'M02', 'M03', 'M05'].includes(workflowId)) state = pendingRequestState(clock, `REQ-WF-${workflowId}-001`, 1);
    else if (kind === 'baseline' && workflowId === 'M06') state = m06State(clock);
    else if (kind === 'baseline' && workflowId === 'M12') state = m12State(clock);
    else if (kind === 'baseline' && workflowId === 'D01') state = d01State(clock);
    else if (kind === 'baseline' && workflowId === 'D02') state = d02State(clock);
    else if (kind === 'baseline' && workflowId === 'D04') {
      state = pendingRequestState(clock, 'REQ-WF-D04-001', 1);
      addD04ExactSearchDecoy(state, clock);
    }
    else if (kind === 'baseline' && workflowId === 'D05') state = pendingRequestState(clock, 'REQ-WF-D05-001', 1);
    else {
      const quantity = kind === 'baseline' && ['S02', 'S03', 'S04'].includes(workflowId) ? 3 : shape.quantity;
      state = baseState({ quantity, channelCount: 529, clock });
    }
    if (shape.history > 0) completedHistory(state, { count: shape.history, at });
    if (kind === 'history-2000' && workflowId === 'M04') addM04PaginationData(state, clock);
    if (kind === 'history' && workflowId === 'S08') addS08StoragePendingData(state, clock);
    if (kind === 'history' && workflowId === 'M07') addM07ActiveData(state, clock);
    if (kind === 'history' && workflowId === 'M11') addM11ActiveData(state, clock);
  }
  const store = await createLegacySqliteStore({ dataRoot: root, clock: () => at });
  try {
    const saved = await store.save({ expectedRevision: 0, state, journalEntries: state.formChangeJournal });
    if (!saved.ok) throw new Error(`${saved.code}: ${saved.message}`);
  } finally {
    store.close();
  }
  const reopened = await createLegacySqliteStore({ dataRoot: root, clock: () => at });
  let actual;
  try {
    const loaded = await reopened.load();
    if (!loaded.ok) throw new Error(`${loaded.code}: ${loaded.message}`);
    actual = loaded.state;
  } finally {
    reopened.close();
  }
  const summary = summarizeLegacyState(actual);
  const imports = kind === 'import-mixed' || (kind === 'baseline' && ['D04', 'D06'].includes(workflowId))
    ? await importMaterials(root)
    : undefined;
  return Object.freeze({
    kind,
    dataRoot: root,
    sqlitePath: path.join(root, SQLITE_FILE),
    revision: summary.revision,
    devices: summary.devices,
    channels: summary.channels,
    channelKeys: Object.freeze(actual.channels.map(channel => channel.key)),
    samples: Object.freeze(actual.samples.map(sample => sample.id)),
    records: summary.records,
    audits: summary.audits,
    ...(imports ? { imports } : {})
  });
}

export async function withExclusiveDatabaseLock(sqlitePath, operation) {
  if (typeof sqlitePath !== 'string' || sqlitePath.trim() === '') throw new TypeError('sqlitePath is required');
  if (typeof operation !== 'function') throw new TypeError('operation must be a function');
  let db;
  try {
    db = new DatabaseSync(path.resolve(sqlitePath));
    db.exec('PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE;');
    return await operation();
  } finally {
    if (db) {
      try {
        db.exec('ROLLBACK;');
      } catch {}
      db.close();
    }
  }
}
