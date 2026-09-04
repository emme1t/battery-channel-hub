import { createHash } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

import { createLegacySqliteStore, SQLITE_FILE } from '../src/main/legacy-sqlite-store.mjs';
import { normalizeLegacyState } from '../src/main/legacy-state-schema.mjs';

const require = createRequire(import.meta.url);
const preset = require('../lib/device-preset.js');
const projectRoot = path.resolve(import.meta.dirname, '..');
const assetRoot = path.join(projectRoot, '人工回归数据包', 'v0.4.3');
const sqliteDirectory = path.join(assetRoot, 'SQLite');
const sqlitePath = path.join(sqliteDirectory, '04-及时率筛选与预约待办.sqlite');

function request(id, plannedStart) {
  return {
    id,
    qty: id === 'REQ-TODO' ? 12 : 1,
    test: '循环寿命',
    project: `及时率回归 ${id}`,
    sample: 'CELL-35AH',
    client: '回归委托人',
    dept: '研发部',
    status: id === 'REQ-TODO' ? 'reserved' : 'completed',
    rawFields: { 委托单号: id, 样品数量: id === 'REQ-TODO' ? 12 : 1 },
    sourceFile: `${id}.xlsx`,
    sourcePath: `C:\\manual-regression\\v0.4.3\\${id}.xlsx`,
    execution: { tester: '回归测试员', plannedStart, plannedEnd: '', note: 'v0.4.3 看板夹具' }
  };
}

function record({ id, requestNo, sampleId, status, start, channel, project }) {
  return {
    id,
    no: requestNo,
    requestNo,
    sampleId,
    channelKey: channel.key,
    keys: [channel.key],
    channels: `${channel.device} · ${channel.name}`,
    status,
    time: start,
    start,
    end: status === 'reserved' ? '' : start,
    actualEnd: status === 'reserved' ? '' : start,
    user: '回归测试员',
    actor: '回归测试员',
    project,
    test: '循环寿命',
    source: 'v0.4.3 人工回归夹具'
  };
}

function fixtureState() {
  const deviceProfiles = preset.devices();
  const channels = preset.channels();
  const requests = [
    request('REQ-TIMELY', '2026-08-18'),
    request('REQ-LATE', '2026-08-19T09:00:00-07:00'),
    request('REQ-MISSING', ''),
    request('REQ-TODO', '2026-08-22T09:00:00-07:00')
  ];
  const samples = [
    { id: 'REQ-TIMELY.001', requestNo: 'REQ-TIMELY', ordinal: 1, status: 'completed', channelKey: channels[20].key, start: '2026-08-18T18:00:00-07:00', end: '2026-08-18T20:00:00-07:00', hasHistory: true },
    { id: 'REQ-LATE.001', requestNo: 'REQ-LATE', ordinal: 1, status: 'completed', channelKey: channels[21].key, start: '2026-08-19T10:00:00-07:00', end: '2026-08-19T12:00:00-07:00', hasHistory: true },
    { id: 'REQ-MISSING.001', requestNo: 'REQ-MISSING', ordinal: 1, status: 'completed', channelKey: channels[22].key, start: '2026-08-20T10:00:00-07:00', end: '2026-08-20T12:00:00-07:00', hasHistory: true },
    ...Array.from({ length: 12 }, (_, index) => ({
      id: `REQ-TODO.${String(index + 1).padStart(3, '0')}`,
      requestNo: 'REQ-TODO',
      ordinal: index + 1,
      status: 'reserved',
      channelKey: channels[index].key,
      start: `2026-08-${String(22 + Math.floor(index / 4)).padStart(2, '0')}T${String(9 + index % 4).padStart(2, '0')}:00:00-07:00`,
      end: '',
      hasHistory: true
    }))
  ];
  for (let index = 0; index < 12; index += 1) {
    Object.assign(channels[index], {
      state: 'booked',
      project: requests[3].project,
      user: '回归测试员',
      requestNo: 'REQ-TODO',
      test: '循环寿命',
      start: samples[index + 3].start,
      end: ''
    });
  }
  const records = [
    record({ id: 'REC-TIMELY', requestNo: 'REQ-TIMELY', sampleId: 'REQ-TIMELY.001', status: 'completed', start: samples[0].start, channel: channels[20], project: requests[0].project }),
    record({ id: 'REC-LATE', requestNo: 'REQ-LATE', sampleId: 'REQ-LATE.001', status: 'completed', start: samples[1].start, channel: channels[21], project: requests[1].project }),
    record({ id: 'REC-MISSING', requestNo: 'REQ-MISSING', sampleId: 'REQ-MISSING.001', status: 'completed', start: samples[2].start, channel: channels[22], project: requests[2].project }),
    ...samples.slice(3).map((sample, index) => record({
      id: `REC-TODO-${String(index + 1).padStart(2, '0')}`,
      requestNo: 'REQ-TODO',
      sampleId: sample.id,
      status: 'reserved',
      start: sample.start,
      channel: channels[index],
      project: requests[3].project
    }))
  ];
  return normalizeLegacyState({
    revision: 0,
    requests,
    samples,
    records,
    requestSourceRows: requests.map(item => ({ requestNo: item.id, sourceFile: item.sourceFile, sourcePath: item.sourcePath })),
    auditLogs: [{
      id: 'AUDIT-V043-INIT', time: '2026-08-21T17:00:00.000Z', at: '2026-08-21T17:00:00.000Z',
      user: '系统', actor: '系统', action: '初始化 v0.4.3 看板回归夹具', target: '及时率与预约待办',
      outcome: 'success', result: 'success', verified: true, level: 'normal'
    }],
    formChangeJournal: [],
    testers: [{ id: 'TESTER-V043', name: '回归测试员', dept: '测试部', status: 'enabled' }],
    deviceProfiles,
    channels,
    username: 'manual-regression',
    savedAt: ''
  });
}

async function main() {
  await mkdir(sqliteDirectory, { recursive: true });
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'battery-v043-assets-'));
  try {
    const store = await createLegacySqliteStore({ dataRoot: temporaryRoot, clock: () => '2026-08-21T17:00:00.000Z' });
    try {
      const result = await store.save({ expectedRevision: 0, state: fixtureState(), journalEntries: [] });
      if (!result.ok) throw new Error(result.message || 'v0.4.3 SQLite 保存失败');
    } finally {
      store.close();
    }
    await copyFile(path.join(temporaryRoot, SQLITE_FILE), sqlitePath);
    const bytes = await readFile(sqlitePath);
    const manifest = {
      version: 'v0.4.3',
      generatedAt: '2026-08-21T17:00:00.000Z',
      files: [{
        path: 'SQLite/04-及时率筛选与预约待办.sqlite',
        bytes: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        expected: { devices: 26, channels: 529, requests: 4, samples: 15, records: 15, timely: 1, late: 1, missingPlan: 1, reservedTodo: 12 }
      }]
    };
    await writeFile(path.join(assetRoot, 'SHA256SUMS.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    await writeFile(path.join(assetRoot, '数据包索引.md'), `# v0.4.3 增量人工回归数据包\n\n- SQLite：\`SQLite/04-及时率筛选与预约待办.sqlite\`\n- 用途：及时率、日期筛选、PNG 导出、预约待办分页与详情跳转、设备/通道筛选。\n- 预期：26 台设备、529 通道、4 申请、15 子样品、15 记录；及时 1、延迟 1、缺计划 1、预约待办 12。\n- 旧版通用数据继续使用 \`人工回归数据包/v0.4.2\`，不得修改母版。\n`, 'utf8');
    process.stdout.write(`${JSON.stringify(manifest)}\n`);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

await main();
