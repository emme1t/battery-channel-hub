import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { MANUAL_SCENARIOS, selectManualScenarios } from './scenario-catalog.mjs';

const expectedIds = [
  'A01', 'A02',
  'B01', 'B02', 'B03', 'B04', 'B05',
  'C01', 'C02', 'C03', 'C04',
  'D01', 'D02', 'D03',
  'E01', 'E02', 'E03', 'E04',
  'F01', 'F02', 'F03', 'F04', 'F05', 'F06', 'F07',
  'G01', 'G02', 'G03'
];
const quickIds = ['A01', 'B01', 'C01', 'D01', 'E04', 'F01', 'G01'];

test('manual scenario catalog contains exactly A01-G03 and complete execution metadata', () => {
  assert.deepEqual(MANUAL_SCENARIOS.map(item => item.id), expectedIds);
  assert.equal(new Set(MANUAL_SCENARIOS.map(item => item.id)).size, 28);
  for (const scenario of MANUAL_SCENARIOS) {
    assert.match(scenario.manualSection, /^使用说明 §\d+/);
    assert.ok(Array.isArray(scenario.dataIds));
    assert.equal(typeof scenario.visiblePrecondition, 'string');
    assert.notEqual(scenario.visiblePrecondition.trim(), '');
    assert.ok(Array.isArray(scenario.actions) && scenario.actions.length > 0);
    assert.ok(Array.isArray(scenario.allowedVisibleOutcomes) && scenario.allowedVisibleOutcomes.length > 0);
    assert.equal(typeof scenario.oracleRule, 'string');
    assert.notEqual(scenario.oracleRule.trim(), '');
    assert.equal(typeof scenario.recovery, 'string');
    assert.notEqual(scenario.recovery.trim(), '');
    assert.equal(typeof scenario.compressed, 'boolean');
    assert.ok(Number.isInteger(scenario.maximumDurationMs) && scenario.maximumDurationMs > 0);
    for (const action of scenario.actions) {
      assert.match(action.id, new RegExp(`^${scenario.id}-`));
      assert.equal(typeof action.type, 'string');
      assert.equal(typeof action.expect, 'string');
    }
  }
});

test('quick selects the fixed high-value scenarios and full selects all 28', () => {
  assert.deepEqual(selectManualScenarios({ mode: 'quick' }).map(item => item.id), quickIds);
  assert.deepEqual(selectManualScenarios({ mode: 'full' }).map(item => item.id), expectedIds);
  assert.deepEqual(selectManualScenarios({ ids: ['E04', 'A01'] }).map(item => item.id), ['E04', 'A01']);
  assert.throws(() => selectManualScenarios({ mode: 'legacy' }), /mode must be quick or full/i);
  assert.throws(() => selectManualScenarios({ ids: ['S01'] }), /unknown manual scenario/i);
});

test('C04 uses one manual-derived application containing three child samples', () => {
  const scenario = MANUAL_SCENARIOS.find(item => item.id === 'C04');
  assert.deepEqual(scenario.dataIds, ['normal-quantity-3']);
});

test('B03 models the primary 300-form vertical import and generated summary flow', () => {
  const scenario = MANUAL_SCENARIOS.find(item => item.id === 'B03');
  assert.equal(scenario.risk, 'P0');
  assert.deepEqual(scenario.dataIds, ['folder-vertical-300']);
  assert.match(scenario.title, /300.*纵向单表/);
  assert.match(scenario.oracleRule, /300.*汇总.*重启/);
});

test('long-term storage occupies samples but never claims a test channel', () => {
  const d01 = MANUAL_SCENARIOS.find(item => item.id === 'D01');
  const d03 = MANUAL_SCENARIOS.find(item => item.id === 'D03');
  assert.match(d01.title, /不占通道/);
  assert.match(d01.oracleRule, /通道状态保持不变/);
  assert.match(d03.title, /样品重复占用/);
  assert.doesNotMatch(d03.title, /通道占用冲突/);
  assert.match(d03.oracleRule, /普通测试与长期存储/);
});

test('manual scenario catalog does not import old workflow scenarios or actions', async () => {
  const source = await readFile(path.join(import.meta.dirname, 'scenario-catalog.mjs'), 'utf8');
  assert.doesNotMatch(source, /from\s+['"][^'"]*workflows[\\/]catalog/);
  assert.doesNotMatch(source, /from\s+['"][^'"]*workflows[\\/]actions/);
});
