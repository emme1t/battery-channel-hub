import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

import XLSX from 'xlsx';

import { MANUAL_LIMITS } from './manual-contract.mjs';
import { DATA_CATALOG } from './data-catalog.mjs';

const VERTICAL_STYLE = '01-导入样式-纵向申请单.xlsx';
const HORIZONTAL_STYLE = '02-导入样式-横向申请汇总.xlsx';
const XLS_STYLE = '03-导入样式-旧版Excel汇总.xls';
const CSV_STYLE = '06-导入样式-横向申请汇总.csv';

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value)) deepFreeze(nested);
  return Object.freeze(value);
}

function sha256(contents) {
  return createHash('sha256').update(contents).digest('hex');
}

async function fingerprint(filePath) {
  const details = await stat(filePath);
  return Object.freeze({
    path: filePath,
    size: details.size,
    mtimeMs: details.mtimeMs,
    sha256: sha256(await readFile(filePath))
  });
}

async function directoryHash(root) {
  const rows = [];
  const walk = async current => {
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name, 'zh-CN'))) {
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(absolute);
      else rows.push(`${path.relative(root, absolute).replaceAll('\\', '/')}\0${sha256(await readFile(absolute))}`);
    }
  };
  await walk(root);
  return sha256(rows.join('\n'));
}

function styleMap(manualContract) {
  return new Map(manualContract.styleFiles.map(item => [path.basename(item.path), item.path]));
}

function horizontalHeaders(workbook) {
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  return XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' })[0].map(value => String(value));
}

function baseRow(requestNumber, quantity, ordinal, overrides = {}) {
  return {
    申请单号: requestNumber,
    测试项目: '循环寿命测试',
    项目名称: `BBX 虚构电池验证项目 ${String(ordinal).padStart(3, '0')}`,
    项目号: `BBX-PRJ-${String(ordinal).padStart(3, '0')}`,
    委托人: '测试工程师甲',
    委托部门: '虚构电池测试部',
    联系方式: '13000000000',
    样品名称: '虚构磷酸铁锂电芯',
    样品型号: 'BBX-LFP-100Ah',
    样品数量: quantity,
    '额定容量(Ah)': 100,
    期望开始时间: '2026-09-02 09:00',
    期望完成时间: '2026-09-02 10:00',
    依据标准: 'BBX-STD-001（虚构）',
    判定要求: 'BBX 虚构判定：自动化流程完成',
    测试人员: '虚构测试员',
    测试费用: 0,
    '测试通道/设备': '',
    备注: '纯虚构自动化黑盒测试数据，不代表真实电池测试',
    ...overrides
  };
}

function rowValues(headers, row) {
  return headers.map(header => row[header] ?? '');
}

function csvCell(value) {
  const text = String(value ?? '');
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function csvBytes(headers, rows) {
  const text = [headers, ...rows.map(row => rowValues(headers, row))]
    .map(row => row.map(csvCell).join(','))
    .join('\r\n');
  return Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(`${text}\r\n`, 'utf8')]);
}

function xmlText(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function xmlCell(address, styleId, value) {
  const style = styleId === '' ? '' : ` s="${styleId}"`;
  if (typeof value === 'number' && Number.isFinite(value)) {
    return `<x:c r="${address}"${style} t="n"><x:v>${value}</x:v></x:c>`;
  }
  const text = String(value ?? '');
  const preserve = /^\s|\s$|[\r\n]/.test(text) ? ' xml:space="preserve"' : '';
  return `<x:c r="${address}"${style} t="inlineStr"><x:is><x:t${preserve}>${xmlText(text)}</x:t></x:is></x:c>`;
}

function worksheetEntry(cfb) {
  const index = cfb.FullPaths.findIndex(item => /\/xl\/worksheets\/sheet1\.xml$/i.test(item));
  if (index < 0) throw new Error('template worksheet XML is unavailable');
  return cfb.FileIndex[index];
}

function sourceRowXml(xml, rowNumber) {
  const match = new RegExp(`<x:row\\b[^>]*\\br="${rowNumber}"[^>]*>[\\s\\S]*?<\\/x:row>`).exec(xml);
  if (!match) throw new Error(`template row ${rowNumber} is unavailable`);
  return match[0];
}

function sourceCellStyle(rowXml, address) {
  const cell = new RegExp(`<x:c\\b([^>]*\\br="${address}"[^>]*)>`).exec(rowXml)?.[1] ?? '';
  return /\bs="([^"]+)"/.exec(cell)?.[1] ?? '';
}

function sourceRowAttributes(rowXml) {
  const attributes = /^<x:row\b([^>]*)>/.exec(rowXml)?.[1] ?? '';
  return attributes.replace(/\s+r="[^"]*"/, '');
}

async function writeTemplateXlsx(templatePath, outputPath, mutateXml) {
  const cfb = XLSX.CFB.read(await readFile(templatePath), { type: 'buffer' });
  const entry = worksheetEntry(cfb);
  const source = Buffer.from(entry.content).toString('utf8');
  const updated = mutateXml(source);
  if (updated === source) throw new Error('template worksheet XML was not changed');
  entry.content = Buffer.from(updated, 'utf8');
  entry.size = entry.content.length;
  await writeFile(outputPath, XLSX.CFB.write(cfb, { type: 'buffer', fileType: 'zip', compression: true }));
}

async function writeHorizontalTemplateXlsx(templatePath, outputPath, rows) {
  const workbook = XLSX.readFile(templatePath, { cellFormula: true, cellStyles: true });
  const headers = horizontalHeaders(workbook);
  await writeTemplateXlsx(templatePath, outputPath, source => {
    const header = sourceRowXml(source, 1);
    const templateRow = sourceRowXml(source, 2);
    const attributes = sourceRowAttributes(templateRow);
    const styles = headers.map((_, column) => sourceCellStyle(templateRow, `${XLSX.utils.encode_col(column)}2`));
    const generatedRows = rows.map((row, index) => {
      const rowNumber = index + 2;
      const cells = rowValues(headers, row).map((value, column) =>
        xmlCell(`${XLSX.utils.encode_col(column)}${rowNumber}`, styles[column], value)
      ).join('');
      return `<x:row r="${rowNumber}"${attributes}>${cells}</x:row>`;
    }).join('');
    return source.replace(
      /<x:sheetData>[\s\S]*?<\/x:sheetData>/,
      `<x:sheetData>${header}${generatedRows}</x:sheetData>`
    );
  });
}

async function writeVerticalTemplateXlsx(templatePath, outputPath, row) {
  const workbook = XLSX.readFile(templatePath, { cellFormula: true, cellStyles: true });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });
  const values = {
    委托单号: row.申请单号,
    归属项目名称: row.项目名称,
    归属项目号: row.项目号,
    申请人: row.委托人,
    所属部门: row.委托部门,
    联系方式: row.联系方式,
    样品名称: row.样品名称,
    样品型号: row.样品型号,
    样品数量: row.样品数量,
    '额定容量(Ah)': row['额定容量(Ah)'],
    测试类型: row.测试项目,
    期望开始时间: row.期望开始时间,
    期望完成时间: row.期望完成时间,
    依据标准: row.依据标准,
    测试需求说明: row.备注,
    判定要求: row.判定要求,
    接收人: row.测试人员,
    测试费用: row.测试费用,
    '测试通道/设备': row['测试通道/设备'],
    备注: row.备注
  };
  const replacements = rows.flatMap((sourceRow, index) => {
    const label = String(sourceRow[0] ?? '').trim();
    return Object.hasOwn(values, label) ? [{ rowNumber: index + 1, value: values[label] }] : [];
  });
  await writeTemplateXlsx(templatePath, outputPath, source => {
    let updated = source;
    for (const replacement of replacements) {
      const address = `B${replacement.rowNumber}`;
      const rowXml = sourceRowXml(updated, replacement.rowNumber);
      const style = sourceCellStyle(rowXml, address);
      const cellPattern = new RegExp(`<x:c\\b[^>]*\\br="${address}"[^>]*>(?:[\\s\\S]*?)<\\/x:c>`);
      updated = updated.replace(cellPattern, xmlCell(address, style, replacement.value));
    }
    return updated;
  });
}

function clearHorizontalData(sheet) {
  const range = XLSX.utils.decode_range(sheet['!ref']);
  for (let row = 1; row <= range.e.r; row += 1) {
    for (let column = range.s.c; column <= range.e.c; column += 1) {
      delete sheet[XLSX.utils.encode_cell({ r: row, c: column })];
    }
  }
}

function fillHorizontalWorkbook(workbook, rows) {
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const headers = horizontalHeaders(workbook);
  const dataStyles = headers.map((_, column) => {
    const source = sheet[XLSX.utils.encode_cell({ r: 1, c: column })];
    return source?.s === undefined ? undefined : structuredClone(source.s);
  });
  clearHorizontalData(sheet);
  XLSX.utils.sheet_add_aoa(sheet, rows.map(row => rowValues(headers, row)), { origin: 'A2' });
  for (let row = 0; row < rows.length; row += 1) {
    for (let column = 0; column < headers.length; column += 1) {
      const cell = sheet[XLSX.utils.encode_cell({ r: row + 1, c: column })];
      if (cell && dataStyles[column] !== undefined) cell.s = structuredClone(dataStyles[column]);
    }
  }
  const lastColumn = Math.max(0, headers.length - 1);
  sheet['!ref'] = XLSX.utils.encode_range({ r: 0, c: 0 }, { r: Math.max(0, rows.length), c: lastColumn });
  return workbook;
}

async function writeWorkbook(outputPath, templatePath, rows, { vertical = false, bookType = 'xlsx' } = {}) {
  if (bookType === 'xlsx') {
    if (vertical) await writeVerticalTemplateXlsx(templatePath, outputPath, rows[0]);
    else await writeHorizontalTemplateXlsx(templatePath, outputPath, rows);
    return;
  }
  const workbook = XLSX.readFile(templatePath, { cellFormula: true, cellStyles: true });
  fillHorizontalWorkbook(workbook, rows);
  XLSX.writeFile(workbook, outputPath, { bookType, compression: bookType === 'xlsx', cellStyles: true });
}

async function writeExactSizedCsv(outputPath, headers, requestNumber, targetBytes) {
  const prefix = csvBytes(headers, [baseRow(requestNumber, 1, 1, { 备注: '' })]);
  const trailingNewline = Buffer.from('\r\n');
  const withoutTrailing = prefix.subarray(0, prefix.length - trailingNewline.length);
  const paddingBytes = targetBytes - withoutTrailing.length - trailingNewline.length;
  if (paddingBytes <= 0) throw new RangeError('target CSV size is too small');
  const payload = Buffer.concat([
    withoutTrailing,
    Buffer.alloc(paddingBytes, 0x58),
    trailingNewline
  ]);
  if (payload.length !== targetBytes) throw new Error(`CSV size mismatch: ${payload.length} != ${targetBytes}`);
  await writeFile(outputPath, payload);
}

async function writeRowLimitTemplateXlsx(templatePath, outputPath, count, requestNumber) {
  const workbook = XLSX.readFile(templatePath, { cellFormula: true, cellStyles: true });
  const headers = horizontalHeaders(workbook);
  const requestColumn = headers.indexOf('申请单号');
  const quantityColumn = headers.indexOf('样品数量');
  if (requestColumn < 0 || quantityColumn < 0) throw new Error('row-limit template headers are unavailable');
  await writeTemplateXlsx(templatePath, outputPath, source => {
    const header = sourceRowXml(source, 1);
    const templateRow = sourceRowXml(source, 2);
    const attributes = sourceRowAttributes(templateRow);
    const requestStyle = sourceCellStyle(templateRow, `${XLSX.utils.encode_col(requestColumn)}2`);
    const quantityStyle = sourceCellStyle(templateRow, `${XLSX.utils.encode_col(quantityColumn)}2`);
    const generated = Array.from({ length: count }, (_, index) => {
      const rowNumber = index + 2;
      return `<x:row r="${rowNumber}"${attributes}>${
        xmlCell(`${XLSX.utils.encode_col(requestColumn)}${rowNumber}`, requestStyle, requestNumber)
      }${
        xmlCell(`${XLSX.utils.encode_col(quantityColumn)}${rowNumber}`, quantityStyle, 1)
      }</x:row>`;
    }).join('');
    return source.replace(
      /<x:sheetData>[\s\S]*?<\/x:sheetData>/,
      `<x:sheetData>${header}${generated}</x:sheetData>`
    );
  });
}

async function verifyTemplateSnapshot(before) {
  const changed = [];
  for (const expected of before) {
    const current = await fingerprint(expected.path);
    if (current.size !== expected.size || current.mtimeMs !== expected.mtimeMs || current.sha256 !== expected.sha256) {
      changed.push(expected.path);
    }
  }
  if (changed.length > 0) throw new Error(`style masters changed during generation: ${changed.join(', ')}`);
}

export async function buildManualGuidedData({ runContext, clock = () => new Date() } = {}) {
  if (!runContext || typeof runContext !== 'object') throw new TypeError('runContext is required');
  if (typeof runContext.generatedDataRoot !== 'string' || !path.isAbsolute(runContext.generatedDataRoot)) {
    throw new TypeError('runContext.generatedDataRoot must be absolute');
  }
  if (typeof runContext.assertWritable !== 'function') throw new TypeError('runContext.assertWritable is required');
  if (!runContext.manualContract || !Array.isArray(runContext.manualContract.styleFiles)) {
    throw new TypeError('runContext.manualContract.styleFiles is required');
  }
  const now = new Date(clock());
  if (Number.isNaN(now.getTime())) throw new TypeError('clock must return a valid date');
  const runSuffix = String(runContext.runId || '').split('-').at(-1);
  if (!/^[a-f0-9]{8}$/i.test(runSuffix)) throw new TypeError('runContext.runId must end with eight hex characters');
  const styles = styleMap(runContext.manualContract);
  for (const required of [VERTICAL_STYLE, HORIZONTAL_STYLE, XLS_STYLE, CSV_STYLE]) {
    if (!styles.has(required)) throw new TypeError(`manual style is unavailable: ${required}`);
  }
  const templateSnapshot = await Promise.all(runContext.manualContract.styleFiles.map(item => fingerprint(item.path)));
  await mkdir(await runContext.assertWritable(runContext.generatedDataRoot), { recursive: true });

  let ordinal = 0;
  const requestNumber = () => {
    ordinal += 1;
    return `BBX-${now.toISOString().slice(0, 10).replaceAll('-', '')}-${runSuffix.toLowerCase()}-${String(ordinal).padStart(3, '0')}`;
  };
  const entries = [];
  const addFile = async (descriptor, outputPath, expected) => {
    entries.push(deepFreeze({
      id: descriptor.id,
      kind: descriptor.kind,
      format: descriptor.format,
      path: outputPath,
      sha256: sha256(await readFile(outputPath)),
      expected
    }));
  };
  const output = async filename => runContext.assertWritable(path.join(runContext.generatedDataRoot, filename));
  const normalRows = count => Array.from({ length: count }, () => {
    const id = requestNumber();
    return baseRow(id, 1, ordinal);
  });

  for (const descriptor of DATA_CATALOG) {
    if (descriptor.id === 'normal-vertical-1') {
      const rows = normalRows(1);
      const target = await output('01-正常-纵向-1.xlsx');
      await writeWorkbook(target, styles.get(VERTICAL_STYLE), rows, { vertical: true });
      await addFile(descriptor, target, { ...descriptor.expected, requestNumbers: rows.map(row => row.申请单号) });
    } else if (descriptor.id === 'normal-horizontal-3') {
      const rows = normalRows(3);
      const target = await output('02-正常-横向-3.xlsx');
      await writeWorkbook(target, styles.get(HORIZONTAL_STYLE), rows);
      await addFile(descriptor, target, { ...descriptor.expected, requestNumbers: rows.map(row => row.申请单号) });
    } else if (descriptor.id === 'normal-xls-2') {
      const rows = normalRows(2);
      const target = await output('03-正常-旧版-2.xls');
      await writeWorkbook(target, styles.get(XLS_STYLE), rows, { bookType: 'biff8' });
      await addFile(descriptor, target, { ...descriptor.expected, requestNumbers: rows.map(row => row.申请单号) });
    } else if (descriptor.id === 'normal-csv-4') {
      const rows = normalRows(4);
      const template = XLSX.readFile(styles.get(CSV_STYLE));
      const headers = horizontalHeaders(template);
      const target = await output('04-正常-横向-4.csv');
      await writeFile(target, csvBytes(headers, rows));
      await addFile(descriptor, target, { ...descriptor.expected, requestNumbers: rows.map(row => row.申请单号) });
    } else if (descriptor.id === 'normal-quantity-3') {
      const id = requestNumber();
      const target = await output('05-正常-单申请-3子样品.xlsx');
      await writeWorkbook(target, styles.get(HORIZONTAL_STYLE), [baseRow(id, 3, ordinal)]);
      await addFile(descriptor, target, { ...descriptor.expected, requestNumbers: [id] });
    } else if (descriptor.id.startsWith('quantity-')) {
      const id = requestNumber();
      const row = baseRow(id, descriptor.expected.quantityRaw, ordinal);
      const target = await output(`${descriptor.id}.xlsx`);
      await writeWorkbook(target, styles.get(HORIZONTAL_STYLE), [row]);
      await addFile(descriptor, target, { ...descriptor.expected, requestNumbers: [id] });
    } else if (descriptor.id === 'request-number-missing') {
      const target = await output('request-number-missing.xlsx');
      await writeWorkbook(target, styles.get(HORIZONTAL_STYLE), [baseRow('', 1, ordinal + 1)]);
      await addFile(descriptor, target, { ...descriptor.expected, requestNumbers: [] });
    } else if (descriptor.id === 'request-number-duplicate' || descriptor.id === 'request-number-conflict') {
      const id = requestNumber();
      const first = baseRow(id, 1, ordinal);
      const second = descriptor.id.endsWith('conflict')
        ? baseRow(id, 1, ordinal, { 项目名称: 'BBX 冲突项目', 样品型号: 'BBX-CONFLICT-200Ah' })
        : structuredClone(first);
      const target = await output(`${descriptor.id}.xlsx`);
      await writeWorkbook(target, styles.get(HORIZONTAL_STYLE), [first, second]);
      await addFile(descriptor, target, { ...descriptor.expected, requestNumbers: [id] });
    } else if (descriptor.id === 'long-chinese') {
      const id = requestNumber();
      const note = '这是纯虚构的电池测试长文本，包含中文、引号“测试”、通配符 * ?、换行\n与恢复验证。'.repeat(40);
      const target = await output('long-chinese.xlsx');
      await writeWorkbook(target, styles.get(HORIZONTAL_STYLE), [baseRow(id, 1, ordinal, { 备注: note })]);
      await addFile(descriptor, target, { ...descriptor.expected, requestNumbers: [id] });
    } else if (descriptor.id === 'damaged-xlsx') {
      const target = await output('damaged.xlsx');
      await writeFile(target, 'THIS IS AN INTENTIONALLY DAMAGED XLSX FIXTURE\n', 'utf8');
      await addFile(descriptor, target, { ...descriptor.expected, requestNumbers: [] });
    } else if (descriptor.id === 'fake-extension') {
      const id = requestNumber();
      const template = XLSX.readFile(styles.get(CSV_STYLE));
      const target = await output('fake-extension.xlsx');
      await writeFile(target, csvBytes(horizontalHeaders(template), [baseRow(id, 1, ordinal)]));
      await addFile(descriptor, target, { ...descriptor.expected, requestNumbers: [id] });
    } else if (descriptor.id === 'blank-workbook') {
      const target = await output('blank-workbook.xlsx');
      await writeWorkbook(target, styles.get(HORIZONTAL_STYLE), []);
      await addFile(descriptor, target, { ...descriptor.expected, requestNumbers: [] });
    } else if (descriptor.id === 'lock-file') {
      const id = requestNumber();
      const target = await output('~$lock-file.xlsx');
      await writeWorkbook(target, styles.get(HORIZONTAL_STYLE), [baseRow(id, 1, ordinal)]);
      await addFile(descriptor, target, { ...descriptor.expected, requestNumbers: [id] });
    } else if (descriptor.id === 'folder-vertical-300') {
      const folder = await output('folder-vertical-300');
      const requestNumbers = [];
      for (let batch = 1; batch <= 10; batch += 1) {
        const batchRoot = await runContext.assertWritable(path.join(folder, `批次-${String(batch).padStart(2, '0')}`));
        await mkdir(batchRoot, { recursive: true });
        for (let item = 1; item <= 30; item += 1) {
          const index = (batch - 1) * 30 + item;
          const id = requestNumber();
          requestNumbers.push(id);
          await writeWorkbook(
            path.join(batchRoot, `纵向单份申请-${String(index).padStart(3, '0')}.xlsx`),
            styles.get(VERTICAL_STYLE),
            [baseRow(id, 1, ordinal)],
            { vertical: true }
          );
        }
      }
      entries.push(deepFreeze({
        id: descriptor.id,
        kind: descriptor.kind,
        format: descriptor.format,
        path: folder,
        sha256: await directoryHash(folder),
        expected: { ...descriptor.expected, requestNumbers }
      }));
    } else if (descriptor.id === 'file-under-25mb' || descriptor.id === 'file-over-25mb') {
      const id = requestNumber();
      const target = await output(`${descriptor.id}.csv`);
      const csvTemplate = XLSX.readFile(styles.get(CSV_STYLE));
      await writeExactSizedCsv(target, horizontalHeaders(csvTemplate), id, descriptor.expected.bytes);
      await addFile(descriptor, target, { ...descriptor.expected, requestNumbers: [id] });
    } else if (descriptor.id === 'sheet-50000' || descriptor.id === 'sheet-50001') {
      const id = requestNumber();
      const target = await output(`${descriptor.id}.xlsx`);
      await writeRowLimitTemplateXlsx(styles.get(HORIZONTAL_STYLE), target, descriptor.expected.rows, id);
      await addFile(descriptor, target, { ...descriptor.expected, requestNumbers: [id] });
    }
  }

  if (entries.length !== DATA_CATALOG.length) throw new Error('manual data generator did not produce every catalog entry');
  await verifyTemplateSnapshot(templateSnapshot);
  return Object.freeze(entries);
}
