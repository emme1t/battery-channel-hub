import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';

import {
  collectPackageEvidence,
  packageGateSkipReason
} from '../scripts/package-evidence.mjs';

const require = createRequire(import.meta.url);
const asar = require('@electron/asar');
const projectRoot = path.resolve(import.meta.dirname, '..');

const USER_GUIDE_FILES = [
  '01-软件使用说明.md',
  '02-开发者说明.md',
  '文件样式/01-导入样式-纵向申请单.xlsx',
  '文件样式/02-导入样式-横向申请汇总.xlsx',
  '文件样式/03-GUI导出样式-申请汇总.xlsx',
  '文件样式/03-导入样式-旧版Excel汇总.xls',
  '文件样式/04-GUI导出样式-选中申请.xlsx',
  '文件样式/05-GUI导出样式-日志与使用数据.xlsx',
  '文件样式/06-导入样式-横向申请汇总.csv',
  '文件样式/07-GUI备份样式-可恢复数据包.batterydata',
  '文件样式/08-GUI备份样式-可恢复数据包.json',
  '文件样式/09-GUI导出样式-测试及时率.png'
];

function listRelativeFiles(root, current = root) {
  return readdirSync(current, { withFileTypes: true }).flatMap(entry => {
    const absolutePath = path.join(current, entry.name);
    return entry.isDirectory()
      ? listRelativeFiles(root, absolutePath)
      : [path.relative(root, absolutePath).replaceAll('\\', '/')];
  });
}

function assertCompleteUserGuide(root) {
  assert.deepEqual(listRelativeFiles(root).sort(), [...USER_GUIDE_FILES].sort());
  for (const relativePath of USER_GUIDE_FILES) {
    assert.ok(statSync(path.join(root, relativePath)).size > 0, `${relativePath} 必须非空`);
  }
}

test('source tree contains exactly the approved 12 user-guide files', () => {
  assertCompleteUserGuide(path.join(projectRoot, 'resources', '使用说明'));
});

const REQUIRED = [
  '/电池测试通道预约Demo.html',
  '/feedback_patch.js',
  '/lib/device-preset.js',
  '/main.js',
  '/preload.js',
  '/package.json',
  '/src/domain/audit-result.mjs',
  '/src/domain/legacy-return-to-application-transactions.mjs',
  '/src/domain/legacy-request-transactions.mjs',
  '/src/domain/legacy-reservation-transactions.mjs',
  '/src/domain/legacy-storage-transactions.mjs',
  '/src/domain/reservation-policy.mjs',
  '/src/domain/sample-quantity.mjs',
  '/src/main/application-command-service.mjs',
  '/src/main/dashboard-png-service.mjs',
  '/src/main/excel-service.mjs',
  '/src/main/legacy-backup-service.mjs',
  '/src/main/legacy-sqlite-store.mjs',
  '/src/main/legacy-state-schema.mjs',
  '/src/main/reservation-command-service.mjs',
  '/src/main/storage-command-service.mjs',
  '/src/renderer/legacy-bounded-views.mjs',
  '/src/renderer/legacy-dashboard-insights.mjs',
  '/src/renderer/legacy-list-selectors.mjs',
  '/src/renderer/legacy-reservation-entry.mjs',
  '/src/renderer/legacy-reservation-workspace.mjs',
  '/src/renderer/legacy-storage-workbench.mjs',
  '/node_modules/xlsx/package.json',
  '/node_modules/xlsx/xlsx.js',
  '/node_modules/xlsx/dist/cpexcel.js'
];

const EXCLUDED = [
  '/src/renderer/index.html',
  '/src/renderer/app.mjs',
  '/src/renderer/app.css',
  '/src/renderer/app-state.mjs',
  '/src/renderer/reservation-page.mjs',
  '/src/renderer/reservation-view-model.mjs',
  '/src/main/state-store.mjs',
  '/src/main/backup-service.mjs',
  '/src/main/electron-data-service.mjs',
  '/src/main/production-switch-service.mjs',
  '/src/domain/state-schema.mjs',
  '/src/domain/reservation-transactions.mjs'
];

function normalizedFiles(asarPath) {
  return asar.listPackage(asarPath).map(file => file.replaceAll('\\', '/'));
}

export function assertPackageContents(asarPath) {
  const files = normalizedFiles(asarPath);
  const fileSet = new Set(files);
  for (const required of REQUIRED) assert.equal(fileSet.has(required), true, `ASAR 缺少 ${required}`);
  for (const excluded of EXCLUDED) assert.equal(fileSet.has(excluded), false, `ASAR 不应包含 ${excluded}`);
  assert.equal(files.some(file => file.startsWith('/src/migration/')), false, 'ASAR 不应包含 vNext migration');
  assert.equal(files.some(file => file.startsWith('/tests/')), false, 'ASAR 不应包含 tests');
  assert.equal(files.some(file => file.startsWith('/tests/workflows/')), false, 'ASAR 不应包含 workflow 测试');
  assert.equal(files.some(file => file.startsWith('/tests/manual-guided/')), false, 'ASAR 不应包含 manual-guided 测试');
  assert.equal(fileSet.has('/tests/smoke/main-workflow-smoke.mjs'), false, 'ASAR 不应包含 main workflow smoke');
  assert.equal(files.some(file => file.startsWith('/docs/')), false, 'ASAR 不应包含 docs');
  assert.equal(files.some(file => file.startsWith('/.superpowers/')), false, 'ASAR 不应包含 Superpowers 工作区');
  assert.equal(files.some(file => file.startsWith('/scripts/')), false, 'ASAR 不应包含 scripts');
  assert.equal(files.some(file => file.startsWith('/node_modules/playwright-core/')), false, 'ASAR 不应包含 playwright-core');
  assert.equal(files.some(file => file.startsWith('/自动测试报告/')), false, 'ASAR 不应包含测试报告目录');
  assert.equal(files.some(file => file.includes('/自动测试报告/')), false, 'ASAR 不应包含自动测试报告');
  assert.equal(files.some(file => /\.sqlite(?:-(?:wal|shm|journal))?$|-(?:wal|shm|journal)$/i.test(file)), false, 'ASAR 不应包含 SQLite 或 sidecar');
  assert.equal(files.some(file => /\.batterydata$/i.test(file)), false, 'ASAR 不应包含 batterydata');
  assert.equal(files.some(file => /(?:^|\/)\.env(?:\.|$)/i.test(file)), false, 'ASAR 不应包含 env');
  assert.equal(files.some(file => /(?:^|\/)(?:coverage|trace|traces)(?:\/|$)|\.(?:tap|dmp|dump)$/i.test(file)), false, 'ASAR 不应包含 coverage/trace/dump');

  const html = asar.extractFile(asarPath, '电池测试通道预约Demo.html').toString('utf8');
  const patch = asar.extractFile(asarPath, 'feedback_patch.js').toString('utf8');
  const packagedPackageJson = JSON.parse(asar.extractFile(asarPath, 'package.json').toString('utf8'));
  assert.equal(packagedPackageJson.main, 'main.js');
  assert.match(html, /src\/renderer\/legacy-reservation-entry\.mjs/);
  assert.match(html, /src\/renderer\/legacy-storage-workbench\.mjs/);
  const combined = `${html}\n${patch}`;
  for (const page of ['dashboard', 'apply', 'runningSamples', 'storageSamples', 'requests', 'records', 'testers', 'devices']) {
    assert.match(combined, new RegExp(`(?:id=["']${page}["']|data-page=["']${page}["'])`), `缺少页面 ${page}`);
  }
  assert.doesNotMatch(html, /src\/renderer\/index\.html|五页导航壳|功能建设中/);

  const sourcePackageJson = JSON.parse(readFileSync(path.join(projectRoot, 'package.json'), 'utf8'));
  const version = sourcePackageJson.version;
  const artifactPaths = [
    path.join(projectRoot, 'dist', 'win-unpacked', `${sourcePackageJson.build.productName}.exe`)
  ];
  const releaseEvidenceRequired = process.env.BATTERY_PACKAGE_RELEASE_EVIDENCE === '1';
  if (releaseEvidenceRequired) {
    artifactPaths.push(
      path.join(projectRoot, 'dist', `Battery-Channel-Hub-${version}-portable.exe`),
      path.join(projectRoot, 'dist', `Battery-Channel-Hub-${version}-setup.exe`)
    );
  }
  return collectPackageEvidence({
    asarPath,
    files,
    requiredCount: REQUIRED.length,
    excludedCount: EXCLUDED.length,
    minimumMtimeMs: packageGateRequired ? process.env.BATTERY_PACKAGE_MIN_MTIME_MS : null,
    artifactPaths,
    requireArtifacts: true
  });
}

const directoryBuildAsar = path.join(projectRoot, 'dist', 'win-unpacked', 'resources', 'app.asar');
const packageGateRequired = process.env.BATTERY_PACKAGE_GATE === '1';

test('directory build packages only the restored MAIN runtime', {
  skip: packageGateSkipReason({
    gateRequired: packageGateRequired,
    asarExists: existsSync(directoryBuildAsar)
  })
}, () => {
  const asarPath = directoryBuildAsar;
  const report = assertPackageContents(asarPath);
  assertCompleteUserGuide(path.join(projectRoot, 'dist', 'win-unpacked', 'resources', '使用说明'));
  assert.ok(report.totalFiles > report.required);
  console.log(`PACKAGE_EVIDENCE ${JSON.stringify(report)}`);
});
