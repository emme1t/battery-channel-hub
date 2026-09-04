import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import test from 'node:test';

import XLSX from 'xlsx';

import {
  createExcelDialogService,
  parseFolder,
  parseWorkbook,
  writeWorkbook
} from '../src/main/excel-service.mjs';

async function makeVerticalWorkbook(root, name = '纵向申请单.xlsx') {
  const filePath = join(root, name);
  const workbook = XLSX.utils.book_new();
  const rows = [
    ['电芯测试申请单', ''],
    ['字段', '填写内容'],
    ['基本信息', ''],
    ['委托单号', 'REQ-V-001'],
    ['归属项目名称', '飞行器电芯验证'],
    ['样品型号', '35Ah'],
    ['样品数量', 3],
    ['测试类型', '循环测试'],
    ['测试类型', '内部'],
    ['申请人', '原始申请人'],
    ['期望开始日期', 46254],
    ['备注', '保留原始备注']
  ];
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(rows), '申请单模板');
  XLSX.writeFile(workbook, filePath);
  return filePath;
}

async function makeFlatWorkbook(root, name = 'flat-summary.xlsx') {
  const filePath = join(root, name);
  const workbook = XLSX.utils.book_new();
  const rows = [{
    申请单号: 'FLAT-001',
    项目名称: '汇总导入项目',
    样品名称: '示例电池',
    样品数量: 2,
    测试项目: '循环测试'
  }];
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(rows), '测试申请表格');
  XLSX.writeFile(workbook, filePath);
  return filePath;
}

test('parseWorkbook recognizes a vertical application and preserves source evidence', async () => {
  const root = await mkdtemp(join(tmpdir(), 'battery-excel-vertical-'));
  const filePath = await makeVerticalWorkbook(root);
  const parsed = parseWorkbook(filePath);

  assert.equal(parsed.format, '申请单字段表');
  assert.equal(parsed.records.length, 1);
  assert.equal(parsed.records[0].id, 'REQ-V-001');
  assert.equal(parsed.records[0].sourceFile, basename(filePath));
  assert.equal(parsed.records[0].sourcePath, resolve(filePath));
  assert.equal(parsed.records[0].rawFields['委托单号'], 'REQ-V-001');
  assert.equal(parsed.records[0].fields['测试类型（内部/委外）'], '内部');
  assert.equal(parsed.records[0].normalized.qty, 3);
  assert.equal(parsed.records[0].normalized.client, '原始申请人');
});

test('parseWorkbook recognizes a generated flat summary fixture', async () => {
  const root = await mkdtemp(join(tmpdir(), 'battery-excel-flat-'));
  const filePath = await makeFlatWorkbook(root);
  const parsed = parseWorkbook(filePath);

  assert.equal(parsed.format, '申请单汇总表');
  assert.equal(parsed.sheetName, '测试申请表格');
  assert.equal(parsed.records[0].id, 'FLAT-001');
  assert.equal(parsed.records[0].normalized.project, '汇总导入项目');
  assert.equal(parsed.records[0].sourcePath, resolve(filePath));
  assert.equal(parsed.records[0].rawFields['申请单号'], 'FLAT-001');
});

test('blank and damaged workbooks return a stable file-level parser error', async () => {
  const root = await mkdtemp(join(tmpdir(), 'battery-excel-invalid-'));
  const blank = join(root, 'blank.xlsx');
  const damaged = join(root, 'damaged.xlsx');
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([['字段', '填写内容']]), '申请单模板');
  XLSX.writeFile(workbook, blank);
  await writeFile(damaged, 'not an xlsx workbook', 'utf8');

  for (const filePath of [blank, damaged]) {
    assert.throws(
      () => parseWorkbook(filePath),
      error => error.code === 'UNRECOGNIZED_APPLICATION_WORKBOOK' && error.file === resolve(filePath)
    );
  }
});

test('parseFolder collects nested workbooks, skips lock files and reports all file errors', async () => {
  const root = await mkdtemp(join(tmpdir(), 'battery-excel-folder-'));
  const nested = join(root, 'nested');
  await mkdir(nested);
  const valid = await makeVerticalWorkbook(nested, 'valid.xlsx');
  await writeFile(join(root, 'bad.xlsx'), 'not an xlsx workbook', 'utf8');
  await writeFile(join(root, '~$locked.xlsx'), 'must be skipped', 'utf8');

  const parsed = parseFolder(root);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.files, 2);
  assert.equal(parsed.records.length, 1);
  assert.equal(parsed.records[0].sourcePath, resolve(valid));
  assert.equal(parsed.errors.length, 1);
  assert.equal(parsed.errors[0].file, 'bad.xlsx');
  assert.equal(parsed.errors[0].code, 'UNRECOGNIZED_APPLICATION_WORKBOOK');
});

test('writeWorkbook writes five expected sheets and re-reads the final file before success', async () => {
  const root = await mkdtemp(join(tmpdir(), 'battery-excel-export-'));
  const filePath = join(root, '导出.xlsx');
  const sheetNames = ['测试申请表格', '测试项目明细', '日志', '测试设备使用表2', '通道当前状态'];
  const result = writeWorkbook(filePath, sheetNames.map((name, index) => ({
    name,
    rows: [{ 序号: index + 1, 文本: index === 0 ? '=1+1' : `数据-${index + 1}` }]
  })));

  assert.equal(result.ok, true);
  assert.equal(result.verified, true);
  assert.equal(result.file, resolve(filePath));
  assert.deepEqual(result.sheetNames, sheetNames);
  assert.deepEqual(result.rowCounts, Object.fromEntries(sheetNames.map(name => [name, 1])));
  assert.equal(result.formulaErrors, 0);

  const reopened = XLSX.readFile(filePath, { cellFormula: true });
  assert.deepEqual(reopened.SheetNames, sheetNames);
  assert.equal(reopened.Sheets['测试申请表格'].B2.t, 's');
});

test('write failure is structured, leaves no target, and dialog cancellation invokes no writer', async () => {
  const root = await mkdtemp(join(tmpdir(), 'battery-excel-failure-'));
  const blocker = join(root, 'not-a-directory');
  await writeFile(blocker, 'file', 'utf8');
  const target = join(blocker, 'export.xlsx');
  const failed = writeWorkbook(target, [{ name: '数据', rows: [{ value: 1 }] }]);
  assert.equal(failed.ok, false);
  assert.equal(failed.code, 'EXCEL_WRITE_FAILED');

  let writes = 0;
  const dialogs = createExcelDialogService({
    dialog: {
      showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
      showSaveDialog: async () => ({ canceled: true })
    },
    documentsPath: root,
    writeWorkbookImpl: () => { writes += 1; }
  });
  assert.deepEqual(await dialogs.importFile(), { canceled: true });
  assert.deepEqual(await dialogs.importFolder(), { canceled: true });
  assert.deepEqual(await dialogs.exportWorkbook({ sheets: [{ name: '数据', rows: [] }] }), { canceled: true });
  assert.equal(writes, 0);
});
