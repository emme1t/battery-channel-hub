import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { makeLegacyBackup, verifyLegacyBackup, writeLegacyBackupFile } from '../src/main/legacy-backup-service.mjs';
import { createLegacySqliteStore, SQLITE_FILE } from '../src/main/legacy-sqlite-store.mjs';
import { normalizeLegacyState } from '../src/main/legacy-state-schema.mjs';

const require = createRequire(import.meta.url);
const preset = require('../lib/device-preset.js');
const projectRoot = path.resolve(import.meta.dirname, '..');
const assetRoot = path.join(projectRoot, '人工回归数据包', 'v0.4.2');
const fixedNow = '2026-08-21T10:00:00.000Z';

function baselineState({ auditId = 'AUDIT-MANUAL-BASELINE', action = '初始化人工回归 26/529 基线' } = {}) {
  return normalizeLegacyState({
    revision: 0,
    requests: [],
    samples: [],
    records: [],
    requestSourceRows: [],
    auditLogs: [{
      id: auditId, time: fixedNow, at: fixedNow, user: '系统', actor: '系统',
      action, target: '26 台设备 / 529 个通道', outcome: 'success', result: 'success',
      verified: true, level: 'normal', before: null, after: { devices: 26, channels: 529 },
      note: '人工回归只读母版'
    }],
    formChangeJournal: [],
    testers: [],
    deviceProfiles: preset.devices(),
    channels: preset.channels(),
    username: 'manual-regression',
    savedAt: ''
  });
}

function request(id, quantity, overrides = {}) {
  return {
    id, qty: quantity, test: '循环寿命', project: `人工回归项目 ${id}`,
    sample: 'CELL-35AH', client: '回归委托人', dept: '研发部', tester: '历史测试员',
    fee: 0, device: '', startDate: '', end: '', note: '', status: 'pending',
    rawFields: { 委托单号: id, 申请人: '回归委托人', 样品数量: quantity },
    sourceFile: `${id}.xlsx`,
    sourcePath: `C:\\manual-regression\\imports\\${id}.xlsx`,
    execution: { tester: '当前测试员', fee: 10, device: '', plannedStart: '', plannedEnd: '', note: '执行字段' },
    ...structuredClone(overrides)
  };
}

function samplesFor(id, quantity, status = 'pending', overrides = {}) {
  return Array.from({ length: quantity }, (_, index) => ({
    id: `${id}.${String(index + 1).padStart(3, '0')}`,
    requestNo: id,
    ordinal: index + 1,
    status,
    channelKey: '',
    start: '',
    end: '',
    hasHistory: status === 'completed',
    ...structuredClone(overrides)
  }));
}

function workflowState() {
  const base = baselineState({ auditId: 'AUDIT-WORKFLOW-INIT', action: '初始化事务与状态人工回归' });
  const channels = structuredClone(base.channels);
  const running = channels[0];
  const booked = channels[1];
  const historical = channels[2];
  const fault = channels[3];
  Object.assign(running, {
    state: 'busy', project: '活动引用项目', user: '历史测试员',
    end: '2026-08-21T18:00:00.000Z', requestNo: 'REQ-ACTIVE-001', test: '循环寿命'
  });
  Object.assign(booked, {
    state: 'booked', project: '预约引用项目', user: '历史测试员',
    end: '2026-08-22T18:00:00.000Z', requestNo: 'REQ-BOOKED-001', test: '循环寿命'
  });
  Object.assign(fault, { state: 'fault', note: '人工回归故障通道' });

  const requests = [
    request('REQ-PENDING-003', 3),
    request('REQ-ACTIVE-001', 1, { status: 'running' }),
    request('REQ-BOOKED-001', 1, { status: 'reserved' }),
    request('REQ-HISTORY-001', 1, { status: 'completed', tester: '历史测试员' }),
    request('REQ-DELETE-001', 2),
    request('REQ-RAW-001', 2, {
      rawFields: { 委托单号: 'REQ-RAW-001', 申请人: '原始委托人', 嵌套: { 值: 1 } },
      sourceFile: '01-纵向申请单-原始字段.xlsx',
      sourcePath: 'C:\\manual-regression\\imports\\01-纵向申请单-原始字段.xlsx'
    })
  ];
  const samples = [
    ...samplesFor('REQ-PENDING-003', 3),
    ...samplesFor('REQ-ACTIVE-001', 1, 'running', { channelKey: running.key, start: '2026-08-21T09:00:00.000Z' }),
    ...samplesFor('REQ-BOOKED-001', 1, 'reserved', { channelKey: booked.key, start: '2026-08-22T09:00:00.000Z' }),
    ...samplesFor('REQ-HISTORY-001', 1, 'completed', { channelKey: historical.key, start: '2026-08-20T09:00:00.000Z', end: '2026-08-20T12:00:00.000Z' }),
    ...samplesFor('REQ-DELETE-001', 2),
    ...samplesFor('REQ-RAW-001', 2)
  ];
  const records = [
    {
      id: 'RECORD-ACTIVE-001', no: 'REQ-ACTIVE-001', requestNo: 'REQ-ACTIVE-001',
      sampleId: 'REQ-ACTIVE-001.001', keys: [running.key], channelKey: running.key,
      channels: `${running.device} · ${running.name}`, status: 'running',
      time: '2026-08-21 09:00', start: '2026-08-21T09:00:00.000Z', end: '2026-08-21T18:00:00.000Z',
      user: '历史测试员', project: '活动引用项目', test: '循环寿命', source: '人工回归夹具'
    },
    {
      id: 'RECORD-BOOKED-001', no: 'REQ-BOOKED-001', requestNo: 'REQ-BOOKED-001',
      sampleId: 'REQ-BOOKED-001.001', keys: [booked.key], channelKey: booked.key,
      channels: `${booked.device} · ${booked.name}`, status: 'reserved',
      time: '2026-08-22 09:00', start: '2026-08-22T09:00:00.000Z', end: '2026-08-22T18:00:00.000Z',
      user: '历史测试员', project: '预约引用项目', test: '循环寿命', source: '人工回归夹具'
    },
    {
      id: 'RECORD-HISTORY-001', no: 'REQ-HISTORY-001', requestNo: 'REQ-HISTORY-001',
      sampleId: 'REQ-HISTORY-001.001', keys: [historical.key], channelKey: historical.key,
      channels: `${historical.device} · ${historical.name}`, status: 'completed',
      time: '2026-08-20 09:00', start: '2026-08-20T09:00:00.000Z', end: '2026-08-20T12:00:00.000Z',
      actualEnd: '2026-08-20T12:00:00.000Z', user: '历史测试员', project: '历史保留项目',
      test: '循环寿命', source: '人工回归夹具'
    }
  ];
  return normalizeLegacyState({
    ...base,
    requests,
    samples,
    channels,
    records,
    requestSourceRows: requests.map(item => ({
      id: item.id, requestNo: item.id, sourceFile: item.sourceFile, sourcePath: item.sourcePath
    })),
    auditLogs: [
      ...base.auditLogs,
      { id: 'AUDIT-HISTORY-001', time: '2026-08-20T12:00:00.000Z', user: '历史测试员', action: '结束测试', target: '申请单 REQ-HISTORY-001', outcome: 'success', result: 'success', verified: true, level: 'normal' }
    ],
    testers: [
      { id: 'TESTER-CURRENT', name: '当前测试员', dept: '测试部', status: 'enabled' },
      { id: 'TESTER-HISTORY', name: '历史测试员', dept: '历史部门', status: 'enabled' }
    ]
  });
}

function productionScaleState() {
  const base = baselineState({ auditId: 'AUDIT-SCALE-INIT', action: '初始化生产规模人工回归' });
  const requests = Array.from({ length: 100 }, (_, index) => {
    const ordinal = index + 1;
    return request(`REQ-SCALE-${String(ordinal).padStart(3, '0')}`, ordinal === 1 ? 999 : 1, {
      project: `生产规模项目 ${ordinal}`,
      sample: ordinal === 1 ? 'CELL-999-SAMPLES' : `CELL-${String(ordinal).padStart(3, '0')}`
    });
  });
  const samples = requests.flatMap(item => samplesFor(item.id, item.qty));
  const records = Array.from({ length: 2000 }, (_, index) => {
    const ordinal = index + 1;
    const requestItem = requests[index % requests.length];
    const channel = base.channels[index % base.channels.length];
    return {
      id: `RECORD-SCALE-${String(ordinal).padStart(4, '0')}`,
      no: requestItem.id,
      requestNo: requestItem.id,
      sampleId: `${requestItem.id}.001`,
      keys: [channel.key],
      channelKey: channel.key,
      channels: `${channel.device} · ${channel.name}`,
      status: 'completed',
      time: '2026-08-01 09:00',
      start: '2026-08-01T09:00:00.000Z',
      end: '2026-08-01T10:00:00.000Z',
      actualEnd: '2026-08-01T10:00:00.000Z',
      user: '规模测试员',
      project: requestItem.project,
      test: '循环寿命',
      source: '生产规模人工回归夹具'
    };
  });
  const auditLogs = Array.from({ length: 2000 }, (_, index) => ({
    id: `AUDIT-SCALE-${String(index + 1).padStart(4, '0')}`,
    time: '2026-08-01T10:00:00.000Z', at: '2026-08-01T10:00:00.000Z',
    user: '规模测试员', actor: '规模测试员', action: index % 10 === 0 ? '状态警告' : '历史操作',
    target: `规模记录 ${index + 1}`, outcome: index % 10 === 0 ? 'warning' : 'success',
    result: index % 10 === 0 ? 'warning' : 'success', verified: true,
    level: index % 10 === 0 ? 'warning' : 'normal', before: null, after: { ordinal: index + 1 },
    note: '生产规模人工回归夹具'
  }));
  return normalizeLegacyState({
    ...base,
    requests,
    samples,
    records,
    auditLogs,
    requestSourceRows: requests.map(item => ({
      id: item.id, requestNo: item.id, sourceFile: item.sourceFile, sourcePath: item.sourcePath
    })),
    testers: [{ id: 'TESTER-SCALE', name: '规模测试员', dept: '测试部', status: 'enabled' }]
  });
}

async function createSqlite(relativePath, state) {
  const tempRoot = await mkdtemp(path.join(tmpdir(), 'battery-manual-assets-'));
  const store = await createLegacySqliteStore({ dataRoot: tempRoot, clock: () => fixedNow });
  let savedState;
  try {
    const saved = await store.save({ expectedRevision: 0, state, journalEntries: state.formChangeJournal });
    if (!saved.ok) throw new Error(`${saved.code}: ${saved.message}`);
    savedState = saved.state;
  } finally {
    store.close();
  }
  const target = path.join(assetRoot, relativePath);
  await mkdir(path.dirname(target), { recursive: true });
  await copyFile(path.join(tempRoot, SQLITE_FILE), target);
  await rm(tempRoot, { recursive: true, force: true });
  return { file: target, state: savedState };
}

async function sha256(filePath) {
  return createHash('sha256').update(await readFile(filePath)).digest('hex');
}

async function ensureWorkbookAssets() {
  const required = [
    '01-纵向申请单-原始字段.xlsx', '02-扁平申请汇总-有效.xlsx',
    '03-数量边界-1.xlsx', '04-数量边界-999.xlsx', '05-数量非法-0.xlsx',
    '06-数量非法-1000.xlsx', '07-数量非法-小数.xlsx', '08-数量非法-非数字.xlsx',
    '09-多样品原子预约.xlsx', '10-覆盖导入-原版.xlsx', '11-覆盖导入-新版.xlsx',
    '12-长文本与中文.xlsx', '13-文件夹混合导入/有效-根目录.xlsx',
    '13-文件夹混合导入/子目录/有效-子目录.xlsx', '13-文件夹混合导入/空白.xlsx'
  ];
  for (const relativePath of required) {
    const info = await stat(path.join(assetRoot, 'Excel', relativePath));
    if (!info.isFile() || info.size === 0) throw new Error(`Excel 资产缺失：${relativePath}`);
  }
}

const noPackage = '无需外部数据包（使用当前隔离测试状态或人工操作）';
const files = relativePaths => relativePaths.map(relativePath => path.join(assetRoot, relativePath));
const scenarioPackages = {
  'P0-01': [...files(['SQLite/01-26设备529通道空基线.sqlite']), path.join(process.env.APPDATA || '', 'battery-channel-hub', 'data', 'battery-channel-hub.sqlite')],
  'P0-02': files(['SQLite/01-26设备529通道空基线.sqlite']),
  'P0-03': files(['Excel/03-数量边界-1.xlsx', 'Excel/04-数量边界-999.xlsx']),
  'P0-04': files(['Excel/05-数量非法-0.xlsx', 'Excel/06-数量非法-1000.xlsx', 'Excel/07-数量非法-小数.xlsx', 'Excel/08-数量非法-非数字.xlsx']),
  'P0-05': files(['Excel/09-多样品原子预约.xlsx', 'SQLite/02-事务与状态迁移.sqlite']),
  'P0-06': files(['SQLite/02-事务与状态迁移.sqlite']),
  'P0-07': files(['SQLite/02-事务与状态迁移.sqlite']),
  'P0-08': files(['Excel/01-纵向申请单-原始字段.xlsx']),
  'P0-09': files(['Excel/10-覆盖导入-原版.xlsx', 'Excel/11-覆盖导入-新版.xlsx']),
  'P0-10': files(['Excel/13-文件夹混合导入']),
  'P0-11': files(['SQLite/02-事务与状态迁移.sqlite']),
  'P0-12': files(['SQLite/02-事务与状态迁移.sqlite']),
  'P0-13': files(['SQLite/02-事务与状态迁移.sqlite']),
  'P0-14': files(['SQLite/02-事务与状态迁移.sqlite']),
  'P0-15': files(['失败路径/只读目录', '失败路径/not-a-directory.blocker']),
  'P0-16': files(['运行输出/备份']),
  'P0-17': files(['备份/02-篡改校验失败.batterydata']),
  'P0-18': files(['备份/01-正常恢复包.batterydata', '运行输出/恢复前备份']),
  'P0-19': files(['切换演练/运行副本/活动旧版', '切换演练/运行副本/候选新版/battery-channel-hub.sqlite']),
  'P0-20': files(['切换演练/运行副本']),
  'P1-01': files(['SQLite/01-26设备529通道空基线.sqlite']),
  'P1-02': files(['SQLite/03-100申请999子样品2000日志审计.sqlite']),
  'P1-03': files(['SQLite/03-100申请999子样品2000日志审计.sqlite']),
  'P1-04': files(['SQLite/03-100申请999子样品2000日志审计.sqlite']),
  'P1-05': files(['SQLite/03-100申请999子样品2000日志审计.sqlite']),
  'P1-06': files(['SQLite/01-26设备529通道空基线.sqlite']),
  'P1-07': files(['SQLite/01-26设备529通道空基线.sqlite']),
  'P1-08': files(['SQLite/03-100申请999子样品2000日志审计.sqlite']),
  'P1-09': files(['SQLite/03-100申请999子样品2000日志审计.sqlite']),
  'P1-10': files(['Excel/01-纵向申请单-原始字段.xlsx', 'Excel/02-扁平申请汇总-有效.xlsx']),
  'P1-11': files(['Excel/13-文件夹混合导入']),
  'P1-12': files(['Excel/02-扁平申请汇总-有效.xlsx', '运行输出/导出']),
  'P1-13': files(['SQLite/03-100申请999子样品2000日志审计.sqlite', '运行输出/导出']),
  'P1-14': files(['SQLite/02-事务与状态迁移.sqlite']),
  'P1-15': files(['SQLite/02-事务与状态迁移.sqlite']),
  'ST-01': files(['SQLite/03-100申请999子样品2000日志审计.sqlite']),
  'ST-02': files(['SQLite/03-100申请999子样品2000日志审计.sqlite']),
  'ST-03': files(['SQLite/03-100申请999子样品2000日志审计.sqlite']),
  'ST-04': files(['SQLite/03-100申请999子样品2000日志审计.sqlite']),
  'ST-05': files(['SQLite/03-100申请999子样品2000日志审计.sqlite']),
  'P2-01': files(['Excel/12-长文本与中文.xlsx']),
  'P2-02': files(['SQLite/01-26设备529通道空基线.sqlite', 'Excel/13-文件夹混合导入/损坏.xlsx', 'SQLite/02-事务与状态迁移.sqlite']),
  'P2-03': [noPackage],
  'P2-04': [noPackage]
};

await ensureWorkbookAssets();
await mkdir(assetRoot, { recursive: true });

const baseline = await createSqlite('SQLite/01-26设备529通道空基线.sqlite', baselineState());
const workflow = await createSqlite('SQLite/02-事务与状态迁移.sqlite', workflowState());
await createSqlite('SQLite/03-100申请999子样品2000日志审计.sqlite', productionScaleState());

const folderRoot = path.join(assetRoot, 'Excel', '13-文件夹混合导入');
await writeFile(path.join(folderRoot, '损坏.xlsx'), 'THIS IS AN INTENTIONALLY DAMAGED XLSX FIXTURE\n', 'utf8');
await writeFile(path.join(folderRoot, '~$锁文件.xlsx'), 'THIS LOCK FILE MUST BE SKIPPED\n', 'utf8');

const validBackupPath = path.join(assetRoot, '备份', '01-正常恢复包.batterydata');
await writeLegacyBackupFile(validBackupPath, workflow.state, {
  reason: '人工回归正常恢复包', createdAt: fixedNow, idFactory: () => 'manual-regression-valid-backup'
});
const validBackup = JSON.parse(await readFile(validBackupPath, 'utf8'));
verifyLegacyBackup(validBackup);
const tampered = structuredClone(validBackup);
tampered.state.username = '篡改后用户名-校验必须失败';
await writeFile(path.join(assetRoot, '备份', '02-篡改校验失败.batterydata'), `${JSON.stringify(tampered, null, 2)}\n`, 'utf8');

const switchMaster = path.join(assetRoot, '切换演练', '母版');
const switchRuntime = path.join(assetRoot, '切换演练', '运行副本');
const switchOld = await createSqlite('切换演练/母版/活动旧版/battery-channel-hub.sqlite', baselineState({
  auditId: 'AUDIT-SWITCH-OLD', action: '切换演练旧版数据'
}));
const switchCandidate = await createSqlite('切换演练/母版/候选新版/battery-channel-hub.sqlite', baselineState({
  auditId: 'AUDIT-SWITCH-CANDIDATE', action: '切换演练候选数据'
}));
await writeFile(path.join(switchMaster, '活动旧版', '程序标记.bin'), 'BATTERY-CHANNEL-HUB-OLD-PROGRAM\n', 'utf8');
await writeFile(path.join(switchMaster, '候选新版', '程序标记.bin'), 'BATTERY-CHANNEL-HUB-CANDIDATE-PROGRAM\n', 'utf8');
for (const generation of ['活动旧版', '候选新版']) {
  await mkdir(path.join(switchRuntime, generation), { recursive: true });
  await copyFile(path.join(switchMaster, generation, 'battery-channel-hub.sqlite'), path.join(switchRuntime, generation, 'battery-channel-hub.sqlite'));
  await copyFile(path.join(switchMaster, generation, '程序标记.bin'), path.join(switchRuntime, generation, '程序标记.bin'));
}
await mkdir(path.join(switchRuntime, '外部备份'), { recursive: true });

await mkdir(path.join(assetRoot, '失败路径', '只读目录'), { recursive: true });
await writeFile(path.join(assetRoot, '失败路径', '只读目录', '说明.txt'), '该目录将在生成后由本机 ACL 设置为只读，用于 P0-15。\n', 'utf8');
await writeFile(path.join(assetRoot, '失败路径', 'not-a-directory.blocker'), '这是文件，不是目录；用于稳定触发子路径写入失败。\n', 'utf8');

for (const relativePath of ['导出', '备份', '恢复前备份', '截图']) {
  await mkdir(path.join(assetRoot, '运行输出', relativePath), { recursive: true });
  await writeFile(path.join(assetRoot, '运行输出', relativePath, '.gitkeep'), '人工回归运行输出占位目录。\n', 'utf8');
}
await writeFile(path.join(assetRoot, '运行输出', '使用说明.md'), `# 运行输出目录

本目录仅用于 v0.4.2 隔离人工回归产生的文件。\n
- \`导出/\`：申请与日志导出文件。
- \`备份/\`：正常备份用例输出。
- \`恢复前备份/\`：恢复流程自动生成的前置备份。
- \`截图/\`：人工失败证据和界面截图。

不得把正式数据复制到本目录。\n`, 'utf8');

const hashedFiles = [
  'SQLite/01-26设备529通道空基线.sqlite',
  'SQLite/02-事务与状态迁移.sqlite',
  'SQLite/03-100申请999子样品2000日志审计.sqlite',
  'Excel/01-纵向申请单-原始字段.xlsx',
  'Excel/02-扁平申请汇总-有效.xlsx',
  'Excel/03-数量边界-1.xlsx',
  'Excel/04-数量边界-999.xlsx',
  'Excel/05-数量非法-0.xlsx',
  'Excel/06-数量非法-1000.xlsx',
  'Excel/07-数量非法-小数.xlsx',
  'Excel/08-数量非法-非数字.xlsx',
  'Excel/09-多样品原子预约.xlsx',
  'Excel/10-覆盖导入-原版.xlsx',
  'Excel/11-覆盖导入-新版.xlsx',
  'Excel/12-长文本与中文.xlsx',
  'Excel/13-文件夹混合导入/有效-根目录.xlsx',
  'Excel/13-文件夹混合导入/子目录/有效-子目录.xlsx',
  'Excel/13-文件夹混合导入/空白.xlsx',
  'Excel/13-文件夹混合导入/损坏.xlsx',
  'Excel/13-文件夹混合导入/~$锁文件.xlsx',
  '备份/01-正常恢复包.batterydata',
  '备份/02-篡改校验失败.batterydata',
  '切换演练/母版/活动旧版/battery-channel-hub.sqlite',
  '切换演练/母版/活动旧版/程序标记.bin',
  '切换演练/母版/候选新版/battery-channel-hub.sqlite',
  '切换演练/母版/候选新版/程序标记.bin',
  '切换演练/运行副本/活动旧版/battery-channel-hub.sqlite',
  '切换演练/运行副本/活动旧版/程序标记.bin',
  '切换演练/运行副本/候选新版/battery-channel-hub.sqlite',
  '切换演练/运行副本/候选新版/程序标记.bin',
  '失败路径/not-a-directory.blocker',
  '失败路径/只读目录/说明.txt'
];
const fileHashes = {};
for (const relativePath of hashedFiles) fileHashes[relativePath] = await sha256(path.join(assetRoot, relativePath));

const manifest = {
  version: 'v0.4.2',
  generatedAt: fixedNow,
  root: assetRoot,
  activeCandidateDatabase: path.join(process.env.APPDATA || '', 'battery-channel-hub', 'data', 'battery-channel-hub.sqlite'),
  safety: {
    mastersAreReadOnlyInputs: true,
    applicationMustBeClosedBeforeSqliteReplacement: true,
    formalDataForbidden: true
  },
  summaries: {
    baseline: { revision: baseline.state.revision, devices: 26, channels: 529, requests: 0, samples: 0, records: 0 },
    workflow: { revision: workflow.state.revision, devices: 26, channels: 529, requests: workflow.state.requests.length, samples: workflow.state.samples.length, records: workflow.state.records.length },
    switchOldSha256: await sha256(switchOld.file),
    switchCandidateSha256: await sha256(switchCandidate.file)
  },
  scenarioPackages,
  files: fileHashes
};
await writeFile(path.join(assetRoot, 'SHA256SUMS.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

const index = `# 人工回归数据包 v0.4.2

根目录：\`${assetRoot}\`

## 安全规则

- 本目录中的 SQLite、XLSX 和备份包均为人工回归母版，不是正式数据。
- 不要让候选程序直接长期写入母版；需要替换 SQL 时先关闭程序、备份活动库并复制母版。
- 打包候选程序当前活动库：\`${path.join(process.env.APPDATA || '', 'battery-channel-hub', 'data', 'battery-channel-hub.sqlite')}\`。
- \`切换演练/母版\` 永不执行 apply；只对预建的 \`切换演练/运行副本\` 操作。
- \`02-篡改校验失败.batterydata\` 和 \`损坏.xlsx\` 是故意损坏的负向夹具。

## 主要资产

- \`SQLite/01-26设备529通道空基线.sqlite\`：26/529/0/0。
- \`SQLite/02-事务与状态迁移.sqlite\`：待安排、已预约、测试中、已结束、故障及历史人员状态。
- \`SQLite/03-100申请999子样品2000日志审计.sqlite\`：生产规模和30分钟稳定性。
- \`Excel/\`：纵向、扁平、数量边界、覆盖导入、长文本和混合文件夹。
- \`备份/\`：已校验正常恢复包和校验和篡改包。
- \`切换演练/运行副本\`：P0-19/P0-20 专用，可被测试修改。
- \`失败路径/只读目录\` 与 \`失败路径/not-a-directory.blocker\`：P0-15 失败路径。
- \`运行输出/\`：预建的导出、备份、恢复前备份和截图目录；测试产生的文件不得写回母版目录。

## 完整性

所有测试文件 SHA-256 和44条场景映射见同目录 \`SHA256SUMS.json\`。实际人工操作路径以 v0.4.2 模板中的绝对地址为准。
`;
await writeFile(path.join(assetRoot, '数据包索引.md'), index, 'utf8');

console.log(JSON.stringify({
  ok: true,
  assetRoot,
  files: hashedFiles.length,
  scenarios: Object.keys(scenarioPackages).length,
  baseline: manifest.summaries.baseline,
  workflow: manifest.summaries.workflow,
  scale: { requests: 100, primarySamples: 999, records: 2000, audits: 2000 }
}));
