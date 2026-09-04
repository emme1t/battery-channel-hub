import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const driverModule = await import('../scripts/edge-regression/node-driver.mjs').catch(() => ({}));

async function fixtureProject() {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), 'edge-node-driver-'));
  const runRoot = path.join(projectRoot, 'reports', 'run-1');
  await mkdir(runRoot, { recursive: true });
  const passing = path.join(projectRoot, 'passing.test.mjs');
  const failing = path.join(projectRoot, 'failing.test.mjs');
  await writeFile(passing, "import test from 'node:test'; import assert from 'node:assert/strict'; test('authority passes',()=>assert.equal(2+2,4));\n");
  await writeFile(failing, "import test from 'node:test'; import assert from 'node:assert/strict'; test('authority fails',()=>assert.equal(2+2,5));\n");
  return { projectRoot, runRoot, passing, failing };
}

test('node evidence driver exports the required API', () => {
  assert.equal(typeof driverModule.createNodeEvidenceDriver, 'function');
});

test('node evidence requires at least one passing test and stores TAP output', async () => {
  assert.equal(typeof driverModule.createNodeEvidenceDriver, 'function');
  const fixture = await fixtureProject();
  const driver = driverModule.createNodeEvidenceDriver(fixture);
  const result = await driver.runTestSuite({ key: 'passing-suite', files: [fixture.passing] });
  assert.equal(result.ok, true);
  assert.equal(result.summary.pass, 1);
  assert.equal(result.summary.fail, 0);
  assert.match(await readFile(result.evidencePath, 'utf8'), /authority passes/);

  const empty = await driver.runTestSuite({
    key: 'empty-suite',
    files: [fixture.passing],
    namePattern: 'does-not-exist'
  });
  assert.equal(empty.ok, false);
  assert.equal(empty.error.code, 'NODE_EVIDENCE_EMPTY');
});

test('failing node evidence remains a structured failure', async () => {
  assert.equal(typeof driverModule.createNodeEvidenceDriver, 'function');
  const fixture = await fixtureProject();
  const driver = driverModule.createNodeEvidenceDriver(fixture);
  const result = await driver.runTestSuite({ key: 'failing-suite', files: [fixture.failing] });
  assert.equal(result.ok, false);
  assert.equal(result.summary.fail, 1);
  assert.equal(result.error.code, 'NODE_TEST_FAILED');
});
