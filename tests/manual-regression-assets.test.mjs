import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import { parseFolder, parseWorkbook } from '../src/main/excel-service.mjs';
import { verifyLegacyBackup } from '../src/main/legacy-backup-service.mjs';

const projectRoot = path.resolve(import.meta.dirname, '..');
const assetRoot = path.join(projectRoot, '人工回归数据包', 'v0.4.2');

const expectedFiles = [
  '数据包索引.md',
  'SHA256SUMS.json',
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

async function sha256(filePath) {
  return createHash('sha256').update(await readFile(filePath)).digest('hex');
}

function inspectSqlite(relativePath) {
  const filePath = path.join(assetRoot, relativePath);
  const db = new DatabaseSync(filePath, { readOnly: true });
  try {
    const integrity = db.prepare('PRAGMA integrity_check').get().integrity_check;
    const row = db.prepare('SELECT revision, payload FROM app_state WHERE id = 1').get();
    assert.ok(row, `${relativePath} 缺少 app_state`);
    return { integrity, revision: Number(row.revision), state: JSON.parse(row.payload) };
  } finally {
    db.close();
  }
}

test('manual regression package contains every declared artifact with verified hashes', async () => {
  const attributes = await readFile(path.join(projectRoot, '.gitattributes'), 'utf8');
  assert.match(attributes, /^\/人工回归数据包\/v0\.4\.2\/\*\* -text$/m, '数据包必须禁用 Git 文本换行转换');
  await assert.doesNotReject(() => stat(assetRoot), `人工回归数据包不存在：${assetRoot}`);
  for (const relativePath of expectedFiles) {
    const info = await stat(path.join(assetRoot, relativePath));
    assert.equal(info.isFile(), true, `缺少文件：${relativePath}`);
    assert.ok(info.size > 0, `空文件：${relativePath}`);
  }

  const manifest = JSON.parse(await readFile(path.join(assetRoot, 'SHA256SUMS.json'), 'utf8'));
  assert.equal(manifest.version, 'v0.4.2');
  assert.equal(Object.keys(manifest.scenarioPackages).length, 44);
  for (const [scenario, packages] of Object.entries(manifest.scenarioPackages)) {
    assert.match(scenario, /^(?:P[012]|ST)-\d{2}$/);
    assert.ok(Array.isArray(packages) && packages.length > 0, `${scenario} 缺少数据包声明`);
  }
  for (const relativePath of expectedFiles.filter(item => !['数据包索引.md', 'SHA256SUMS.json'].includes(item))) {
    assert.equal(manifest.files[relativePath], await sha256(path.join(assetRoot, relativePath)), `哈希不一致：${relativePath}`);
  }
});

test('SQLite fixtures expose exact baseline, workflow and production-scale summaries', () => {
  const baseline = inspectSqlite('SQLite/01-26设备529通道空基线.sqlite');
  assert.equal(baseline.integrity, 'ok');
  assert.deepEqual(
    [baseline.state.deviceProfiles.length, baseline.state.channels.length, baseline.state.requests.length,
      baseline.state.samples.length, baseline.state.records.length],
    [26, 529, 0, 0, 0]
  );
  assert.equal(new Set(baseline.state.channels.map(item => item.key)).size, 529);
  assert.equal(baseline.state.channels.filter(item => item.state === 'free').length, 529);

  const workflow = inspectSqlite('SQLite/02-事务与状态迁移.sqlite');
  assert.equal(workflow.integrity, 'ok');
  assert.deepEqual(
    [workflow.state.deviceProfiles.length, workflow.state.channels.length],
    [26, 529]
  );
  assert.ok(workflow.state.requests.some(item => item.id === 'REQ-ACTIVE-001'));
  assert.ok(workflow.state.records.some(item => item.no === 'REQ-ACTIVE-001' && item.state === '测试中'));
  assert.ok(workflow.state.records.some(item => item.no === 'REQ-HISTORY-001' && item.state === '已结束'));

  const scale = inspectSqlite('SQLite/03-100申请999子样品2000日志审计.sqlite');
  assert.equal(scale.integrity, 'ok');
  assert.deepEqual(
    [scale.state.deviceProfiles.length, scale.state.channels.length, scale.state.requests.length,
      scale.state.samples.filter(item => item.requestNo === 'REQ-SCALE-001').length,
      scale.state.records.length, scale.state.auditLogs.length],
    [26, 529, 100, 999, 2000, 2000]
  );
});

test('Excel fixtures are recognized by the application parser and invalid fixtures fail for the intended reason', () => {
  const valid = [
    ['Excel/01-纵向申请单-原始字段.xlsx', 1],
    ['Excel/02-扁平申请汇总-有效.xlsx', 3],
    ['Excel/03-数量边界-1.xlsx', 1],
    ['Excel/04-数量边界-999.xlsx', 1],
    ['Excel/09-多样品原子预约.xlsx', 1],
    ['Excel/10-覆盖导入-原版.xlsx', 1],
    ['Excel/11-覆盖导入-新版.xlsx', 1],
    ['Excel/12-长文本与中文.xlsx', 1]
  ];
  for (const [relativePath, count] of valid) {
    assert.equal(parseWorkbook(path.join(assetRoot, relativePath)).records.length, count, relativePath);
  }

  const quantities = new Map([
    ['Excel/03-数量边界-1.xlsx', 1],
    ['Excel/04-数量边界-999.xlsx', 999],
    ['Excel/05-数量非法-0.xlsx', 0],
    ['Excel/06-数量非法-1000.xlsx', 1000],
    ['Excel/07-数量非法-小数.xlsx', 1.5],
    ['Excel/08-数量非法-非数字.xlsx', 0]
  ]);
  for (const [relativePath, quantity] of quantities) {
    assert.equal(parseWorkbook(path.join(assetRoot, relativePath)).records[0].normalized.qty, quantity, relativePath);
  }

  const folder = parseFolder(path.join(assetRoot, 'Excel', '13-文件夹混合导入'));
  assert.equal(folder.records.length, 2);
  assert.equal(folder.errors.length, 2);
  assert.equal(folder.files, 4);
  assert.deepEqual(new Set(folder.errors.map(item => item.file)), new Set(['空白.xlsx', '损坏.xlsx']));
});

test('backup fixtures distinguish verified and checksum-tampered packages', async () => {
  const valid = JSON.parse(await readFile(path.join(assetRoot, '备份', '01-正常恢复包.batterydata'), 'utf8'));
  const restored = verifyLegacyBackup(valid);
  assert.deepEqual([restored.deviceProfiles.length, restored.channels.length], [26, 529]);

  const tampered = JSON.parse(await readFile(path.join(assetRoot, '备份', '02-篡改校验失败.batterydata'), 'utf8'));
  assert.throws(() => verifyLegacyBackup(tampered), error => error.code === 'BACKUP_CHECKSUM_INVALID');
});

test('switch drill masters and working copies retain distinct program/data generations', async () => {
  for (const base of ['切换演练/母版', '切换演练/运行副本']) {
    const oldProgram = await readFile(path.join(assetRoot, base, '活动旧版', '程序标记.bin'), 'utf8');
    const newProgram = await readFile(path.join(assetRoot, base, '候选新版', '程序标记.bin'), 'utf8');
    assert.equal(oldProgram, 'BATTERY-CHANNEL-HUB-OLD-PROGRAM\n');
    assert.equal(newProgram, 'BATTERY-CHANNEL-HUB-CANDIDATE-PROGRAM\n');
    assert.notEqual(
      await sha256(path.join(assetRoot, base, '活动旧版', 'battery-channel-hub.sqlite')),
      await sha256(path.join(assetRoot, base, '候选新版', 'battery-channel-hub.sqlite'))
    );
  }
});
