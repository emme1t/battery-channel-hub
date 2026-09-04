import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { DATA_CATALOG } from './data-catalog.mjs';

const EXPECTED_IDS = Object.freeze([
  'normal-vertical-1', 'normal-horizontal-3', 'normal-xls-2', 'normal-csv-4', 'normal-quantity-3',
  'quantity-blank', 'quantity-0', 'quantity-1000', 'quantity-decimal',
  'quantity-text', 'quantity-spaces', 'request-number-missing',
  'request-number-duplicate', 'request-number-conflict', 'long-chinese',
  'damaged-xlsx', 'fake-extension', 'blank-workbook', 'lock-file',
  'folder-vertical-300', 'file-under-25mb', 'file-over-25mb',
  'sheet-50000', 'sheet-50001'
]);

test('manual data catalog contains exactly the approved 24 independent fixtures', async () => {
  assert.deepEqual(DATA_CATALOG.map(item => item.id), EXPECTED_IDS);
  assert.equal(Object.isFrozen(DATA_CATALOG), true);
  for (const item of DATA_CATALOG) {
    assert.equal(Object.isFrozen(item), true, item.id);
    assert.equal(Object.isFrozen(item.expected), true, item.id);
    assert.match(item.kind, /^(workbook|csv|file|folder)$/);
    assert.equal(typeof item.format, 'string');
  }
  assert.deepEqual(
    DATA_CATALOG.find(item => item.id === 'folder-vertical-300')?.expected,
    { validRecords: 300, errors: 0 }
  );

  const source = await readFile(new URL('./data-catalog.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /workflows\/(?:catalog|fixtures)|S0\d|D0\d|M0\d|C0\d/);
});
