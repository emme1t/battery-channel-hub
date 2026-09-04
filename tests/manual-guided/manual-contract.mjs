import { createHash } from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';

export const MANUAL_LIMITS = Object.freeze({
  maxFileBytes: 25 * 1024 * 1024,
  maxWorksheetRows: 50_000,
  minQuantity: 1,
  maxQuantity: 999
});

export const MANUAL_IMPORT_FORMATS = Object.freeze([
  'xlsx-vertical',
  'xlsx-horizontal',
  'xls-horizontal',
  'csv-horizontal'
]);

export const REQUIRED_STYLE_FILES = Object.freeze([
  '01-导入样式-纵向申请单.xlsx',
  '02-导入样式-横向申请汇总.xlsx',
  '03-导入样式-旧版Excel汇总.xls',
  '03-GUI导出样式-申请汇总.xlsx',
  '04-GUI导出样式-选中申请.xlsx',
  '05-GUI导出样式-日志与使用数据.xlsx',
  '06-导入样式-横向申请汇总.csv',
  '07-GUI备份样式-可恢复数据包.batterydata',
  '08-GUI备份样式-可恢复数据包.json',
  '09-GUI导出样式-测试及时率.png'
]);

function isWithin(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

async function fingerprint(filePath) {
  const details = await stat(filePath);
  if (!details.isFile()) throw new TypeError(`required file is not a file: ${filePath}`);
  const contents = await readFile(filePath);
  return Object.freeze({
    path: filePath,
    size: details.size,
    sha256: createHash('sha256').update(contents).digest('hex')
  });
}

export async function loadManualContract({ manualPath, stylesRoot } = {}) {
  if (typeof manualPath !== 'string' || !path.isAbsolute(manualPath)) {
    throw new TypeError('manualPath must be absolute');
  }
  if (typeof stylesRoot !== 'string' || !path.isAbsolute(stylesRoot)) {
    throw new TypeError('stylesRoot must be absolute');
  }
  const resolvedManualPath = path.resolve(manualPath);
  if (path.basename(resolvedManualPath) !== '01-软件使用说明.md') {
    throw new TypeError('manual filename must be 01-软件使用说明.md');
  }
  const resolvedStylesRoot = path.resolve(stylesRoot);
  let canonicalStylesRoot;
  try {
    const manualStats = await stat(resolvedManualPath);
    const stylesStats = await stat(resolvedStylesRoot);
    if (!manualStats.isFile()) throw new TypeError('manualPath must be an existing file');
    if (!stylesStats.isDirectory()) throw new TypeError('stylesRoot must be an existing directory');
    canonicalStylesRoot = await realpath(resolvedStylesRoot);
  } catch (error) {
    if (error?.code === 'ENOENT') throw new TypeError('manualPath and stylesRoot must exist');
    throw error;
  }

  const styleFiles = [];
  for (const filename of REQUIRED_STYLE_FILES) {
    const stylePath = path.join(resolvedStylesRoot, filename);
    let canonicalStylePath;
    try {
      canonicalStylePath = await realpath(stylePath);
    } catch (error) {
      if (error?.code === 'ENOENT') throw new TypeError(`required style file is missing: ${filename}`);
      throw error;
    }
    if (!isWithin(canonicalStylesRoot, canonicalStylePath)) {
      throw new TypeError(`required style file escapes stylesRoot: ${filename}`);
    }
    styleFiles.push(await fingerprint(canonicalStylePath));
  }

  return Object.freeze({
    manual: await fingerprint(await realpath(resolvedManualPath)),
    stylesRoot: canonicalStylesRoot,
    styleFiles: Object.freeze(styleFiles)
  });
}
