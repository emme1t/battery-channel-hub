function frozenEntry(id, kind, format, expected = {}) {
  return Object.freeze({ id, kind, format, expected: Object.freeze(expected) });
}

export const DATA_CATALOG = Object.freeze([
  frozenEntry('normal-vertical-1', 'workbook', 'xlsx-vertical', { recordCount: 1 }),
  frozenEntry('normal-horizontal-3', 'workbook', 'xlsx-horizontal', { recordCount: 3 }),
  frozenEntry('normal-xls-2', 'workbook', 'xls-horizontal', { recordCount: 2 }),
  frozenEntry('normal-csv-4', 'csv', 'csv-horizontal', { recordCount: 4 }),
  frozenEntry('normal-quantity-3', 'workbook', 'xlsx-horizontal', { recordCount: 1, quantity: 3 }),
  frozenEntry('quantity-blank', 'workbook', 'xlsx-horizontal', { quantityRaw: '' }),
  frozenEntry('quantity-0', 'workbook', 'xlsx-horizontal', { quantityRaw: 0 }),
  frozenEntry('quantity-1000', 'workbook', 'xlsx-horizontal', { quantityRaw: 1000 }),
  frozenEntry('quantity-decimal', 'workbook', 'xlsx-horizontal', { quantityRaw: 1.5 }),
  frozenEntry('quantity-text', 'workbook', 'xlsx-horizontal', { quantityRaw: '三块' }),
  frozenEntry('quantity-spaces', 'workbook', 'xlsx-horizontal', { quantityRaw: '   ' }),
  frozenEntry('request-number-missing', 'workbook', 'xlsx-horizontal', { requestNumber: '' }),
  frozenEntry('request-number-duplicate', 'workbook', 'xlsx-horizontal', { duplicate: true }),
  frozenEntry('request-number-conflict', 'workbook', 'xlsx-horizontal', { conflict: true }),
  frozenEntry('long-chinese', 'workbook', 'xlsx-horizontal', { minimumNoteLength: 1000 }),
  frozenEntry('damaged-xlsx', 'file', 'xlsx-damaged', { parserOutcome: 'rejected' }),
  frozenEntry('fake-extension', 'file', 'xlsx-fake-extension', { actualFormat: 'csv' }),
  frozenEntry('blank-workbook', 'workbook', 'xlsx-horizontal', { recordCount: 0 }),
  frozenEntry('lock-file', 'workbook', 'xlsx-horizontal', { skippedByFolderImport: true }),
  frozenEntry('folder-vertical-300', 'folder', 'folder-vertical', { validRecords: 300, errors: 0 }),
  frozenEntry('file-under-25mb', 'csv', 'csv-horizontal', { bytes: 25 * 1024 * 1024 - 1024 }),
  frozenEntry('file-over-25mb', 'csv', 'csv-horizontal', { bytes: 25 * 1024 * 1024 + 1024 }),
  frozenEntry('sheet-50000', 'workbook', 'xlsx-horizontal', { rows: 50_000 }),
  frozenEntry('sheet-50001', 'workbook', 'xlsx-horizontal', { rows: 50_001 })
]);
