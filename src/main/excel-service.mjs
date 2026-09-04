import {
  copyFileSync,
  existsSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync
} from 'node:fs';
import { basename, dirname, extname, join, parse, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

import XLSX from 'xlsx';

const MAX_WORKBOOK_BYTES = 25 * 1024 * 1024;
const MAX_WORKBOOK_ROWS = 50_000;
const SUPPORTED_EXTENSIONS = new Set(['.xlsx', '.xls', '.csv']);
const REQUEST_STATUS = new Map([
  ['pending', 'pending'], ['待安排', 'pending'],
  ['partially_assigned', 'partially_assigned'], ['部分安排', 'partially_assigned'],
  ['assigned', 'assigned'], ['已安排', 'assigned'],
  ['reserved', 'reserved'], ['已预约', 'reserved'],
  ['running', 'running'], ['测试中', 'running'],
  ['completed', 'completed'], ['已完成', 'completed'], ['已结束', 'completed'],
  ['cancelled', 'cancelled'], ['已取消', 'cancelled']
]);

function requestStatus(value) {
  return REQUEST_STATUS.get(String(value || 'pending').trim()) || 'pending';
}

function serviceError(code, message, details = undefined) {
  const error = new Error(message);
  error.code = code;
  if (details !== undefined) error.details = details;
  return error;
}

function cleanFormValue(value) {
  if (value === null || value === undefined) return '';
  if (value === 9 || String(value).trim() === '9') return '';
  return typeof value === 'string' ? value.trim() : value;
}

function excelDateText(value) {
  const cleaned = cleanFormValue(value);
  if (!cleaned) return '';
  if (typeof cleaned === 'number') {
    const date = new Date(Date.UTC(1899, 11, 30) + cleaned * 86_400_000);
    return date.toISOString().slice(0, cleaned % 1 ? 16 : 10).replace('T', ' ');
  }
  return String(cleaned)
    .replace(/[年/]/g, '-')
    .replace(/月/g, '-')
    .replace(/日/g, '')
    .trim();
}

function ensureWorkbookPath(filePath) {
  if (typeof filePath !== 'string' || filePath.trim() === '') {
    throw serviceError('WORKBOOK_PATH_REQUIRED', 'Excel 文件路径不能为空');
  }
  const absolute = resolve(filePath);
  if (!SUPPORTED_EXTENSIONS.has(extname(absolute).toLowerCase())) {
    throw serviceError('WORKBOOK_EXTENSION_UNSUPPORTED', `不支持的 Excel 文件类型：${extname(absolute) || '(无扩展名)'}`);
  }
  const stats = statSync(absolute);
  if (!stats.isFile()) throw serviceError('WORKBOOK_NOT_FILE', 'Excel 路径不是文件');
  if (stats.size > MAX_WORKBOOK_BYTES) {
    throw serviceError('WORKBOOK_TOO_LARGE', `Excel 文件超过 ${MAX_WORKBOOK_BYTES / 1024 / 1024} MB 安全上限`);
  }
  return absolute;
}

function rowsWithinLimit(rows, sheetName) {
  if (rows.length > MAX_WORKBOOK_ROWS) {
    throw serviceError('WORKBOOK_ROW_LIMIT', `工作表 ${sheetName} 超过 ${MAX_WORKBOOK_ROWS} 行安全上限`);
  }
  return rows;
}

function rowValue(row, names) {
  const entries = Object.entries(row || {});
  for (const name of names) {
    const exact = entries.find(([key]) => String(key).trim() === name);
    if (exact && String(exact[1] ?? '').trim() !== '') return exact[1];
  }
  const compact = value => String(value ?? '').replace(/[\s_]/g, '');
  for (const name of names) {
    const match = entries.find(([key, value]) =>
      compact(key) === compact(name) && String(value ?? '').trim() !== ''
    );
    if (match) return match[1];
  }
  return '';
}

function normalizedFromFields(id, fields) {
  return {
    id,
    test: String(fields['测试类型'] || '未分类'),
    project: String(fields['归属项目名称'] || ''),
    projectNo: String(fields['归属项目号'] || ''),
    client: String(fields['申请人'] || fields['委托人'] || ''),
    dept: String(fields['所属部门'] || fields['委托部门'] || ''),
    phone: String(fields['联系方式'] || ''),
    sample: String(fields['样品型号'] || fields['样品名称'] || ''),
    sampleName: String(fields['样品名称'] || ''),
    qty: Number(fields['样品数量']) || 0,
    capacity: Number(fields['额定容量(Ah)']) || 0,
    startDate: excelDateText(
      fields['期望开始时间'] || fields['期望开始日期'] || fields['计划开始日期'] || fields['计划开始时间']
    ),
    end: excelDateText(
      fields['期望完成时间'] || fields['期望完成日期'] || fields['计划完成日期'] ||
      fields['计划完成时间'] || fields['需求完成时间']
    ),
    tester: String(fields['接收人'] || fields['测试人员'] || ''),
    fee: Number(fields['测试费用'] || fields['测试费用（如需要）']) || 0,
    device: String(fields['测试通道/设备'] || ''),
    note: String(fields['备注'] || fields['测试需求说明'] || ''),
    status: 'pending'
  };
}

function parseVerticalWorkbook(workbook, filePath) {
  const sheetName = workbook.SheetNames.find(name => name === '申请单模板') || workbook.SheetNames[0];
  if (!sheetName || !workbook.Sheets[sheetName]) throw new Error('工作簿没有可读取的工作表');
  const rows = rowsWithinLimit(
    XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { header: 1, defval: '' }),
    sheetName
  );
  const fields = {};
  const fieldCounts = {};
  const headerIndex = rows.findIndex(row =>
    String(row[0] ?? '').trim() === '字段' && String(row[1] ?? '').trim() === '填写内容'
  );
  for (const row of rows.slice(headerIndex >= 0 ? headerIndex + 1 : 0)) {
    const field = String(row[0] ?? '').trim();
    if (!field || field === '字段' || field.endsWith('信息') || field === '签字确认') continue;
    const value = cleanFormValue(row[1]);
    fieldCounts[field] = (fieldCounts[field] || 0) + 1;
    const target = field === '测试类型' && fieldCounts[field] > 1 ? '测试类型（内部/委外）' : field;
    if (value !== '' || fields[target] === undefined) fields[target] = value;
  }
  const meaningfulKeys = [
    '委托单号', '归属项目名称', '归属项目号', '样品名称',
    '样品型号', '样品数量', '测试类型', '申请人', '委托人'
  ];
  if (!meaningfulKeys.some(key => String(fields[key] ?? '').trim() !== '')) {
    throw new Error('申请单未填写有效内容');
  }
  const id = String(fields['委托单号'] || '').replace(/\.0$/, '').trim();
  if (!id) throw new Error('申请单缺少委托单号');
  const record = {
    id,
    sourceFile: basename(filePath),
    sourcePath: filePath,
    fields: structuredClone(fields),
    rawFields: structuredClone(fields),
    normalized: normalizedFromFields(id, fields)
  };
  return { records: [record], rows: [structuredClone(fields)], format: '申请单字段表', sheetName };
}

function normalizedFromRow(id, row) {
  return {
    id,
    test: String(rowValue(row, ['测试项目', '测试类型（申请）', '测试类型', '项目类型', 'test']) || '未分类'),
    project: String(rowValue(row, ['项目名称', '归属项目', '归属项目名称', '项目', 'project']) || ''),
    projectNo: String(rowValue(row, ['项目号', '归属项目号', '项目编号', 'projectNo']) || ''),
    client: String(rowValue(row, ['委托人', '申请人', '客户', 'client']) || ''),
    dept: String(rowValue(row, ['委托部门', '所属部门', '部门', 'dept']) || ''),
    phone: String(rowValue(row, ['联系方式', '联系电话', 'phone']) || ''),
    sample: String(rowValue(row, ['样品型号', '电芯型号', '型号', 'sample']) || ''),
    sampleName: String(rowValue(row, ['样品名称', 'sampleName']) || ''),
    qty: Number(rowValue(row, ['样品数量', '送测样品数量', '送测数量', 'qty']) || 0) || 0,
    capacity: Number(rowValue(row, ['额定容量(Ah)', '额定容量', '容量', 'capacity']) || 0) || 0,
    startDate: excelDateText(rowValue(
      row,
      ['期望开始时间', '期望开始日期', '计划开始日期', '计划开始时间', '预约开始时间', 'startDate']
    )),
    end: excelDateText(rowValue(
      row,
      ['期望完成时间', '期望完成日期', '计划完成日期', '计划完成时间', '需求完成时间', '预计完成时间', 'end']
    )),
    tester: String(rowValue(row, ['测试人员', '测试人', '接收人', 'tester']) || ''),
    fee: Number(rowValue(row, ['测试费用', '测试费用（如需要）', 'fee']) || 0) || 0,
    device: String(rowValue(row, ['测试通道/设备', '测试设备', '设备', 'device']) || ''),
    note: String(rowValue(row, ['备注', '测试需求说明', 'note']) || ''),
    status: requestStatus(rowValue(row, ['导入状态', '测试状态', '状态', 'status']))
  };
}

function parseFlatWorkbook(workbook, filePath) {
  const preferred = ['测试申请表格', '测试申请汇总', '申请数据', 'Sheet1'];
  const sheetNames = [
    ...preferred.filter(name => workbook.SheetNames.includes(name)),
    ...workbook.SheetNames.filter(name => !preferred.includes(name))
  ];
  for (const sheetName of sheetNames) {
    const rows = rowsWithinLimit(
      XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { defval: '' }),
      sheetName
    );
    const records = rows.map(row => {
      const id = String(rowValue(row, ['系统申请单号', '申请单号', '委托单号', '申请单编号', '单号', 'id']) || '')
        .replace(/\.0$/, '')
        .trim();
      if (!id) return null;
      return {
        id,
        sourceFile: basename(filePath),
        sourcePath: filePath,
        fields: structuredClone(row),
        rawFields: structuredClone(row),
        normalized: normalizedFromRow(id, row)
      };
    }).filter(Boolean);
    if (records.length > 0) {
      return { records, rows: structuredClone(rows), sheetName, format: '申请单汇总表' };
    }
  }
  throw new Error('未识别到包含申请单号的汇总表格');
}

export function parseWorkbook(filePath) {
  let absolute = resolve(String(filePath || '.'));
  try {
    absolute = ensureWorkbookPath(filePath);
    const workbook = XLSX.readFile(absolute, { cellDates: false, cellFormula: true });
    try {
      return parseVerticalWorkbook(workbook, absolute);
    } catch (verticalError) {
      try {
        return parseFlatWorkbook(workbook, absolute);
      } catch (flatError) {
        throw new Error(`${verticalError.message}；${flatError.message}`);
      }
    }
  } catch (cause) {
    if (cause?.code === 'WORKBOOK_TOO_LARGE' || cause?.code === 'WORKBOOK_ROW_LIMIT') {
      cause.file = absolute;
      throw cause;
    }
    const error = serviceError(
      'UNRECOGNIZED_APPLICATION_WORKBOOK',
      `无法识别申请单工作簿：${cause.message}`,
      { causeCode: cause.code || '' }
    );
    error.file = absolute;
    throw error;
  }
}

function collectWorkbookFiles(folderPath) {
  const root = resolve(folderPath);
  const stats = statSync(root);
  if (!stats.isDirectory()) throw serviceError('FOLDER_NOT_DIRECTORY', '所选路径不是文件夹');
  const found = [];
  const walk = current => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (entry.name.startsWith('~$')) continue;
      const fullPath = join(current, entry.name);
      if (entry.isDirectory()) walk(fullPath);
      else if (SUPPORTED_EXTENSIONS.has(extname(entry.name).toLowerCase())) found.push(resolve(fullPath));
    }
  };
  walk(root);
  return found.sort((a, b) => a.localeCompare(b, 'zh-CN'));
}

export function parseFolder(folderPath) {
  const folder = resolve(folderPath);
  const files = collectWorkbookFiles(folder);
  const records = [];
  const errors = [];
  for (const file of files) {
    try {
      const parsed = parseWorkbook(file);
      records.push(...parsed.records.map(record => ({
        ...record,
        format: parsed.format,
        sheetName: parsed.sheetName || ''
      })));
    } catch (error) {
      errors.push({
        file: basename(file),
        sourcePath: resolve(file),
        code: error.code || 'WORKBOOK_READ_FAILED',
        message: error.message
      });
    }
  }
  return { ok: true, folder, files: files.length, records, errors };
}

function safeSheetName(value, used) {
  const base = String(value || '数据').replace(/[\\/?*[\]:]/g, '_').trim().slice(0, 31) || '数据';
  let candidate = base;
  let suffix = 1;
  while (used.has(candidate)) {
    suffix += 1;
    candidate = `${base.slice(0, Math.max(1, 31 - String(suffix).length - 1))}_${suffix}`;
  }
  used.add(candidate);
  return candidate;
}

function workbookInspection(filePath) {
  const workbook = XLSX.readFile(filePath, { cellFormula: true, cellDates: false });
  const rowCounts = {};
  let formulaErrors = 0;
  for (const sheetName of workbook.SheetNames) {
    const sheet = workbook.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json(sheet, { defval: '' });
    rowCounts[sheetName] = rows.length;
    for (const [key, cell] of Object.entries(sheet)) {
      if (!key.startsWith('!') && cell?.t === 'e') formulaErrors += 1;
    }
  }
  return { sheetNames: workbook.SheetNames, rowCounts, formulaErrors };
}

export function writeWorkbook(filePath, sheets) {
  const absolute = resolve(String(filePath || ''));
  let temporary = '';
  try {
    if (!Array.isArray(sheets) || sheets.length === 0) {
      throw serviceError('WORKBOOK_SHEETS_REQUIRED', '至少提供一个导出工作表');
    }
    if (extname(absolute).toLowerCase() !== '.xlsx') {
      throw serviceError('WORKBOOK_EXTENSION_UNSUPPORTED', '导出文件必须使用 .xlsx 扩展名');
    }
    const workbook = XLSX.utils.book_new();
    const used = new Set();
    for (const sheet of sheets) {
      const rows = Array.isArray(sheet?.rows) ? structuredClone(sheet.rows) : [];
      if (rows.length > MAX_WORKBOOK_ROWS) {
        throw serviceError('WORKBOOK_ROW_LIMIT', `导出工作表超过 ${MAX_WORKBOOK_ROWS} 行安全上限`);
      }
      const columns = [...new Set(rows.flatMap(row => Object.keys(row || {})))];
      const worksheet = XLSX.utils.json_to_sheet(rows, { header: columns });
      worksheet['!cols'] = columns.map(key => {
        const maxLength = Math.max(
          String(key).length,
          ...rows.slice(0, 100).map(row => String(row?.[key] ?? '').length)
        );
        return { wch: Math.min(Math.max(Math.ceil(maxLength * 1.1), 12), 32) };
      });
      XLSX.utils.book_append_sheet(workbook, worksheet, safeSheetName(sheet?.name, used));
    }

    temporary = join(dirname(absolute), `.${parse(absolute).name}.${randomUUID()}.tmp.xlsx`);
    XLSX.writeFile(workbook, temporary);
    const temporaryInspection = workbookInspection(temporary);
    if (temporaryInspection.formulaErrors > 0) {
      throw serviceError('WORKBOOK_FORMULA_ERROR', '导出工作簿包含公式错误');
    }
    if (existsSync(absolute)) copyFileSync(temporary, absolute);
    else renameSync(temporary, absolute);
    if (existsSync(temporary)) unlinkSync(temporary);
    const finalInspection = workbookInspection(absolute);
    if (
      finalInspection.formulaErrors > 0 ||
      JSON.stringify(finalInspection.sheetNames) !== JSON.stringify(temporaryInspection.sheetNames) ||
      JSON.stringify(finalInspection.rowCounts) !== JSON.stringify(temporaryInspection.rowCounts)
    ) {
      throw serviceError('WORKBOOK_VERIFY_FAILED', '导出文件写后重读校验失败');
    }
    return { ok: true, verified: true, file: absolute, ...finalInspection };
  } catch (error) {
    try {
      if (temporary && existsSync(temporary)) unlinkSync(temporary);
    } catch {}
    return {
      ok: false,
      code: String(error.code || '').startsWith('WORKBOOK_') ? error.code : 'EXCEL_WRITE_FAILED',
      message: `Excel 导出失败：${error.message}`,
      file: absolute
    };
  }
}

function safeExportName(value) {
  const fallback = `电池测试通道看板-${new Date().toISOString().slice(0, 10)}.xlsx`;
  const requested = String(value || fallback).trim() || fallback;
  return `${basename(requested).replace(/[<>:"/\\|?*\x00-\x1F]/g, '_').replace(/\.xlsx$/i, '')}.xlsx`;
}

export function createExcelDialogService({
  dialog,
  documentsPath,
  parseWorkbookImpl = parseWorkbook,
  parseFolderImpl = parseFolder,
  writeWorkbookImpl = writeWorkbook
}) {
  if (!dialog || typeof dialog.showOpenDialog !== 'function' || typeof dialog.showSaveDialog !== 'function') {
    throw new TypeError('Excel 对话框服务缺少 dialog');
  }
  const documents = resolve(documentsPath || '.');
  return {
    async importFile() {
      const result = await dialog.showOpenDialog({
        title: '导入测试申请单 Excel',
        properties: ['openFile'],
        filters: [{ name: 'Excel 文件', extensions: ['xlsx', 'xls', 'csv'] }]
      });
      if (result.canceled || !result.filePaths?.[0]) return { canceled: true };
      const file = resolve(result.filePaths[0]);
      try {
        return { ok: true, ...parseWorkbookImpl(file), file };
      } catch (error) {
        return { ok: false, code: error.code || 'EXCEL_READ_FAILED', message: error.message, file };
      }
    },

    async importFolder() {
      const result = await dialog.showOpenDialog({
        title: '选择测试申请单文件夹',
        properties: ['openDirectory']
      });
      if (result.canceled || !result.filePaths?.[0]) return { canceled: true };
      const folder = resolve(result.filePaths[0]);
      try {
        return parseFolderImpl(folder);
      } catch (error) {
        return { ok: false, code: error.code || 'FOLDER_READ_FAILED', message: error.message, folder };
      }
    },

    async exportWorkbook(payload = {}) {
      const defaultPath = join(documents, safeExportName(payload.defaultFileName));
      const result = await dialog.showSaveDialog({
        title: String(payload.title || '导出看板数据'),
        defaultPath,
        filters: [{ name: 'Excel 工作簿', extensions: ['xlsx'] }]
      });
      if (result.canceled || !result.filePath) return { canceled: true };
      return writeWorkbookImpl(resolve(result.filePath), structuredClone(payload.sheets || []));
    }
  };
}
