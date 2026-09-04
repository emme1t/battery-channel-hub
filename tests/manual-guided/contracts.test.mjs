import assert from 'node:assert/strict';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import {
  MANUAL_GUIDED_MODES,
  normalizeManualActionResult,
  normalizeManualScenario
} from './contracts.mjs';
import {
  MANUAL_IMPORT_FORMATS,
  MANUAL_LIMITS,
  REQUIRED_STYLE_FILES,
  loadManualContract
} from './manual-contract.mjs';

const projectRoot = path.resolve(import.meta.dirname, '..', '..');

async function manualFixture(name) {
  const root = path.join(projectRoot, '自动测试报告', 'manual-contract-' + process.pid + '-' + name);
  const stylesRoot = path.join(root, '文件样式');
  const manualPath = path.join(root, '01-软件使用说明.md');
  await mkdir(stylesRoot, { recursive: true });
  await writeFile(manualPath, '# Battery Channel Hub 使用说明\n', 'utf8');
  for (const styleName of REQUIRED_STYLE_FILES) {
    await writeFile(path.join(stylesRoot, styleName), 'fixture:' + styleName + '\n', 'utf8');
  }
  return { root, stylesRoot, manualPath };
}

test('manual-guided contract accepts only A01-G99 ids and explicit visible outcomes', () => {
  assert.deepEqual(MANUAL_GUIDED_MODES, ['quick', 'full', 'replay']);
  const scenario = normalizeManualScenario({
    id: 'C01',
    title: '立即开始并结束',
    risk: 'P0',
    manualSection: '5. 普通测试流程',
    actions: [{ id: 'login', type: 'login', expect: 'success' }]
  });
  assert.equal(scenario.id, 'C01');
  assert.throws(() => normalizeManualScenario({ ...scenario, id: 'S01' }), /manual scenario id/i);
  assert.throws(() => normalizeManualScenario({ ...scenario, id: 'C00' }), /manual scenario id/i);

  const result = normalizeManualActionResult({
    actionId: 'login',
    outcome: 'success',
    visiblePage: 'dashboard',
    visibleMessage: '进入看板'
  });
  assert.equal(result.outcome, 'success');
  assert.throws(() => normalizeManualActionResult({ ...result, outcome: 'pass' }), /visible outcome/i);
});

test('manual facts match the software manual limits, formats, and ten style attachments', async (t) => {
  const fixture = await manualFixture('complete');
  t.after(() => rm(fixture.root, { recursive: true, force: true }));

  assert.deepEqual(MANUAL_LIMITS, {
    maxFileBytes: 25 * 1024 * 1024,
    maxWorksheetRows: 50_000,
    minQuantity: 1,
    maxQuantity: 999
  });
  assert.deepEqual(MANUAL_IMPORT_FORMATS, [
    'xlsx-vertical',
    'xlsx-horizontal',
    'xls-horizontal',
    'csv-horizontal'
  ]);
  assert.equal(REQUIRED_STYLE_FILES.length, 10);

  const contract = await loadManualContract({
    manualPath: fixture.manualPath,
    stylesRoot: fixture.stylesRoot
  });
  assert.equal(contract.styleFiles.length, 10);
  assert.match(contract.manual.sha256, /^[a-f0-9]{64}$/);
  assert.equal(Object.isFrozen(contract), true);
  assert.equal(Object.isFrozen(contract.styleFiles), true);
});

test('manual contract rejects missing, renamed, relative, and escaped inputs', async (t) => {
  const fixture = await manualFixture('invalid');
  t.after(() => rm(fixture.root, { recursive: true, force: true }));

  await rm(path.join(fixture.stylesRoot, REQUIRED_STYLE_FILES[0]));
  await assert.rejects(
    loadManualContract({ manualPath: fixture.manualPath, stylesRoot: fixture.stylesRoot }),
    /required style file/i
  );
  await assert.rejects(
    loadManualContract({ manualPath: '01-软件使用说明.md', stylesRoot: fixture.stylesRoot }),
    /manualPath must be absolute/i
  );
  await assert.rejects(
    loadManualContract({ manualPath: fixture.manualPath, stylesRoot: '文件样式' }),
    /stylesRoot must be absolute/i
  );
});

test('manual contract rejects a renamed software manual even when its contents are readable', async (t) => {
  const fixture = await manualFixture('renamed-manual');
  const renamedManual = path.join(fixture.root, 'renamed-manual.md');
  await writeFile(renamedManual, '# Battery Channel Hub 使用说明\n', 'utf8');
  t.after(() => rm(fixture.root, { recursive: true, force: true }));

  await assert.rejects(
    loadManualContract({ manualPath: renamedManual, stylesRoot: fixture.stylesRoot }),
    /manual filename/i
  );
});
