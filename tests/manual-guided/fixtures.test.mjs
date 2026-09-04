import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import XLSX from 'xlsx';

import { parseFolder, parseWorkbook } from '../../src/main/excel-service.mjs';
import { createManualGuidedRunContext } from './run-context.mjs';
import { buildManualGuidedData } from './data-generator.mjs';

const projectRoot = path.resolve(import.meta.dirname, '..', '..');
const manualPath = 'C:/Users/ASUS/Desktop/使用说明/01-软件使用说明.md';
const stylesRoot = 'C:/Users/ASUS/Desktop/使用说明/文件样式';
const executablePath = path.join(projectRoot, 'dist', 'win-unpacked', '电池测试通道预约与使用看板.exe');

function sha256(contents) {
  return createHash('sha256').update(contents).digest('hex');
}

function workbookShape(filePath) {
  const workbook = XLSX.readFile(filePath, { cellFormula: true, cellStyles: true });
  return {
    workbook,
    sheets: workbook.SheetNames,
    rows: XLSX.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]], { header: 1, defval: '' })
  };
}

test('generator builds manual-shaped normal, abnormal, size and row-boundary fixtures', { timeout: 120_000 }, async (t) => {
  const context = await createManualGuidedRunContext({
    projectRoot,
    mode: 'full',
    executablePath,
    manualPath,
    stylesRoot,
    now: () => new Date('2026-09-02T08:30:00.000Z'),
    randomBytes: () => Buffer.from('01020304', 'hex')
  });
  t.after(() => rm(context.runRoot, { recursive: true, force: true }));

  const entries = await buildManualGuidedData({
    runContext: context,
    clock: () => new Date('2026-09-02T08:30:00.000Z')
  });
  assert.equal(entries.length, 24);
  assert.equal(Object.isFrozen(entries), true);
  const byId = new Map(entries.map(item => [item.id, item]));

  for (const entry of entries) {
    assert.equal(Object.isFrozen(entry), true, entry.id);
    assert.equal(Object.isFrozen(entry.expected), true, entry.id);
    assert.match(entry.sha256, /^[a-f0-9]{64}$/, entry.id);
    const relative = path.relative(context.generatedDataRoot, entry.path);
    assert.equal(relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative), false, entry.id);
    if (entry.kind !== 'folder') {
      assert.equal(sha256(await readFile(entry.path)), entry.sha256, entry.id);
    }
    for (const requestNumber of entry.expected.requestNumbers ?? []) {
      assert.match(requestNumber, /^BBX-20260902-01020304-\d{3}$/);
      assert.doesNotMatch(requestNumber, /\.\d{3}$/);
    }
  }

  const normalCases = [
    ['normal-vertical-1', 1, '01-导入样式-纵向申请单.xlsx'],
    ['normal-horizontal-3', 3, '02-导入样式-横向申请汇总.xlsx'],
    ['normal-xls-2', 2, '03-导入样式-旧版Excel汇总.xls'],
    ['normal-csv-4', 4, '06-导入样式-横向申请汇总.csv']
  ];
  for (const [id, count, styleName] of normalCases) {
    const entry = byId.get(id);
    const parsed = parseWorkbook(entry.path);
    assert.equal(parsed.records.length, count, id);
    assert.deepEqual(parsed.records.map(item => item.id), entry.expected.requestNumbers, id);
    const source = workbookShape(path.join(stylesRoot, styleName));
    const generated = workbookShape(entry.path);
    assert.deepEqual(generated.sheets, source.sheets, `${id} sheets`);
    const sourceHeaderRow = id === 'normal-vertical-1' ? source.rows[2] : source.rows[0];
    const generatedHeaderRow = id === 'normal-vertical-1' ? generated.rows[2] : generated.rows[0];
    assert.deepEqual(generatedHeaderRow, sourceHeaderRow, `${id} headers`);
    if (id === 'normal-vertical-1') {
      const generatedDataText = JSON.stringify(generated.rows.slice(3));
      assert.doesNotMatch(generatedDataText, /企业标准 Q\/TEST-001|容量保持率不低于 80%|样品到达后请核对外观/);
      assert.match(generatedDataText, /BBX-STD-001（虚构）/);
    }
    if (path.extname(entry.path).toLowerCase() !== '.csv') {
      const sourceSheet = source.workbook.Sheets[source.sheets[0]];
      const generatedSheet = generated.workbook.Sheets[generated.sheets[0]];
      const headerAddress = id === 'normal-vertical-1' ? 'A3' : 'A1';
      assert.deepEqual(generatedSheet[headerAddress]?.s, sourceSheet[headerAddress]?.s, `${id} header style`);
      assert.deepEqual(generatedSheet['!cols'], sourceSheet['!cols'], `${id} column layout`);
      assert.deepEqual(generatedSheet['!merges'], sourceSheet['!merges'], `${id} merged layout`);
    }
  }
  assert.deepEqual([...await readFile(byId.get('normal-csv-4').path)].slice(0, 3), [0xef, 0xbb, 0xbf]);
  assert.deepEqual([...await readFile(byId.get('normal-xls-2').path)].slice(0, 8), [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
  assert.equal(workbookShape(byId.get('normal-quantity-3').path).rows[1][9], 3);
  assert.equal(parseWorkbook(byId.get('normal-quantity-3').path).records.length, 1);

  const quantityExpectations = new Map([
    ['quantity-blank', ''], ['quantity-0', 0], ['quantity-1000', 1000],
    ['quantity-decimal', 1.5], ['quantity-text', '三块'], ['quantity-spaces', '   ']
  ]);
  for (const [id, expected] of quantityExpectations) {
    const rows = workbookShape(byId.get(id).path).rows;
    assert.equal(rows[1][9], expected, id);
  }

  assert.throws(() => parseWorkbook(byId.get('request-number-missing').path), /缺少|申请单号/i);
  assert.deepEqual(
    parseWorkbook(byId.get('request-number-duplicate').path).records.map(item => item.id),
    [byId.get('request-number-duplicate').expected.requestNumbers[0], byId.get('request-number-duplicate').expected.requestNumbers[0]]
  );
  const conflicting = parseWorkbook(byId.get('request-number-conflict').path).records;
  assert.equal(conflicting[0].id, conflicting[1].id);
  assert.notEqual(conflicting[0].normalized.project, conflicting[1].normalized.project);
  assert.ok(parseWorkbook(byId.get('long-chinese').path).records[0].normalized.note.length >= 1_000);
  assert.throws(() => parseWorkbook(byId.get('damaged-xlsx').path), /无法识别申请单工作簿/i);
  assert.throws(() => parseWorkbook(byId.get('blank-workbook').path), /无法识别申请单工作簿/i);
  assert.match(path.basename(byId.get('lock-file').path), /^~\$/);
  const multiSingleRoot = byId.get('folder-vertical-300').path;
  const multiSingleFiles = [
    path.join(multiSingleRoot, '批次-01', '纵向单份申请-001.xlsx'),
    path.join(multiSingleRoot, '批次-05', '纵向单份申请-150.xlsx'),
    path.join(multiSingleRoot, '批次-10', '纵向单份申请-300.xlsx')
  ];
  const verticalTemplate = workbookShape(path.join(stylesRoot, '01-导入样式-纵向申请单.xlsx'));
  for (const file of multiSingleFiles) {
    const generated = workbookShape(file);
    assert.equal(parseWorkbook(file).records.length, 1, file);
    assert.deepEqual(generated.sheets, verticalTemplate.sheets, `${file} sheets`);
    assert.deepEqual(generated.rows[2], verticalTemplate.rows[2], `${file} vertical headers`);
    assert.deepEqual(generated.workbook.Sheets[generated.sheets[0]]['!merges'], verticalTemplate.workbook.Sheets[verticalTemplate.sheets[0]]['!merges'], `${file} merged layout`);
  }
  const folder = parseFolder(multiSingleRoot);
  assert.equal(folder.files, 300);
  assert.equal(folder.records.length, 300);
  assert.equal(folder.records.every(item => item.format === '申请单字段表'), true);
  assert.deepEqual(new Set(folder.records.map(item => item.id)), new Set(byId.get('folder-vertical-300').expected.requestNumbers));
  assert.deepEqual(folder.errors, []);

  assert.equal(parseWorkbook(byId.get('file-under-25mb').path).records.length, 1);
  assert.equal((await stat(byId.get('file-under-25mb').path)).size, 25 * 1024 * 1024 - 1024);
  assert.equal((await stat(byId.get('file-over-25mb').path)).size, 25 * 1024 * 1024 + 1024);
  assert.throws(
    () => parseWorkbook(byId.get('file-over-25mb').path),
    error => error.code === 'WORKBOOK_TOO_LARGE'
  );

  assert.equal(parseWorkbook(byId.get('sheet-50000').path).records.length, 50_000);
  assert.throws(
    () => parseWorkbook(byId.get('sheet-50001').path),
    error => error.code === 'UNRECOGNIZED_APPLICATION_WORKBOOK' && /超过 50000 行/.test(error.message)
  );
  assert.equal((await context.verifyProtected()).ok, true);
});
