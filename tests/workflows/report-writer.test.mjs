import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const reportModule = await import('./report-writer.mjs').catch(() => ({}));

const FIXTURE_SHA256 = 'a'.repeat(64);
const STARTED_AT = '2026-08-22T08:00:00.000Z';
const FINISHED_AT = '2026-08-22T08:01:00.000Z';

function action(index) {
  return {
    id: `step-${index}`,
    type: 'navigate',
    params: { label: '看板' },
    expect: 'success',
    revisionDelta: 0,
    evidenceRevisionDelta: 0,
    maxMs: 1_000
  };
}

function failedResult(overrides = {}) {
  const plannedActions = Array.from({ length: 120 }, (_, index) => action(index + 1));
  return {
    schemaVersion: 1,
    plannerVersion: 1,
    mode: 'quick',
    startedAt: STARTED_AT,
    finishedAt: FINISHED_AT,
    status: 'failed',
    fixtureSha256: FIXTURE_SHA256,
    protectedVerification: { ok: true, changed: [] },
    seed: 22_002,
    plannedActions,
    workflows: [{
      workflowId: 'C02',
      fixture: 'baseline',
      fixtureSha256: FIXTURE_SHA256,
      seed: 22_002,
      status: 'failed',
      steps: [{
        actionId: 'step-18',
        outcome: 'success',
        revisionBefore: 17,
        revisionAfter: 19,
        settlement: null,
        stateSummaryBefore: { records: 17 },
        stateSummaryAfter: { records: 18 },
        uiEvidence: { consoleErrors: ['console boom'], pageErrors: ['page boom'] },
        auditEvidence: { auditLogs: [], formJournal: [] },
        violations: [{ code: 'REVISION_DELTA', severity: 'P0', message: 'revision changed twice', entityIds: ['step-18'] }]
      }],
      lastSuccessfulActionId: 'step-17',
      plannedActions,
      failure: {
        actionId: 'step-18',
        violation: { code: 'REVISION_DELTA', severity: 'P0', message: 'revision changed twice', entityIds: ['step-18'] }
      },
      evidence: { lastScreenshot: 'artifacts/screenshots/C02-step-18.png', beforeClose: { revision: 19 }, afterRestart: { revision: 19 } }
    }],
    failure: {
      workflowId: 'C02',
      actionId: 'step-18',
      violation: { code: 'REVISION_DELTA', severity: 'P0', message: 'revision changed twice', entityIds: ['step-18'] }
    },
    lastSuccessfulActionId: 'step-17',
    ...overrides
  };
}

function reportValue(result = failedResult()) {
  return { runId: '20260822T080000000Z-01020304', ...structuredClone(result) };
}

function reserveAction(id, requestNo) {
  return {
    id,
    type: 'reserve',
    params: { requestNo, sampleIds: [`${requestNo}.001`], channelKeys: ['DEV-1::CH-1'], note: 'replay' },
    expect: 'success',
    revisionDelta: 1,
    evidenceRevisionDelta: 1,
    maxMs: 1_000
  };
}

function repeatedChaosFailureResult() {
  const firstAction = reserveAction('C02-22002-step-000', 'REQ-FIRST');
  const failedAction = reserveAction('C02-23002-step-000', 'REQ-FAILED');
  const lastAction = reserveAction('C02-24002-step-000', 'REQ-LAST');
  const firstFixtureSha256 = 'b'.repeat(64);
  const lastFixtureSha256 = 'c'.repeat(64);
  return failedResult({
    mode: 'full',
    fixtureSha256: FIXTURE_SHA256,
    seed: 23_002,
    plannedActions: [failedAction],
    workflows: [{
      workflowId: 'C02', fixture: 'baseline', fixtureSha256: firstFixtureSha256, seed: 22_002,
      status: 'passed', steps: [], plannedActions: [firstAction], lastSuccessfulActionId: firstAction.id
    }, {
      workflowId: 'C02', fixture: 'baseline', fixtureSha256: FIXTURE_SHA256, seed: 23_002,
      status: 'failed', steps: [], plannedActions: [failedAction], lastSuccessfulActionId: null,
      failure: { actionId: failedAction.id, error: { code: 'ACTION_FAILED', message: 'failed second seed' } }
    }, {
      workflowId: 'C02', fixture: 'baseline', fixtureSha256: lastFixtureSha256, seed: 24_002,
      status: 'passed', steps: [], plannedActions: [lastAction], lastSuccessfulActionId: lastAction.id
    }],
    failure: {
      workflowId: 'C02', actionId: failedAction.id,
      error: { code: 'ACTION_FAILED', message: 'failed second seed' }
    },
    lastSuccessfulActionId: null
  });
}

async function createRunContext(t) {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'workflow-report-test-'));
  const runRoot = path.join(projectRoot, '自动测试报告', 'workflows', '20260822T080000000Z-01020304');
  const artifactsRoot = path.join(runRoot, 'artifacts');
  await fs.mkdir(artifactsRoot, { recursive: true });
  t.after(() => fs.rm(projectRoot, { recursive: true, force: true }));
  return {
    projectRoot,
    runId: '20260822T080000000Z-01020304',
    runRoot,
    artifactsRoot,
    mode: 'quick',
    async assertWritable(candidate) {
      const absolute = path.resolve(candidate);
      const relative = path.relative(runRoot, absolute);
      if (relative === '' || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
        const error = new Error('run root escape');
        error.code = 'RUN_ROOT_ESCAPE';
        throw error;
      }
      return absolute;
    }
  };
}

function instrumentedFileSystem(events, overrides = {}) {
  return {
    ...fs,
    async open(target, flags) {
      events.push(`open:${flags}`);
      const handle = await fs.open(target, flags);
      return {
        async writeFile(...args) { events.push('write'); return handle.writeFile(...args); },
        async sync() { events.push('fsync'); return handle.sync(); },
        async close() { events.push('close'); return handle.close(); }
      };
    },
    async readFile(target, ...args) { events.push(`read:${path.basename(target)}`); return fs.readFile(target, ...args); },
    async rename(from, to) { events.push(`rename:${path.basename(to)}`); return fs.rename(from, to); },
    async unlink(target) { events.push(`unlink:${path.basename(target)}`); return fs.unlink(target); },
    ...overrides
  };
}

test('失败报告原子保存固定 schema、完整动作、首错和最后成功动作', async t => {
  assert.equal(typeof reportModule.writeWorkflowReport, 'function');
  const runContext = await createRunContext(t);
  const events = [];
  const paths = await reportModule.writeWorkflowReport({
    runContext,
    result: failedResult(),
    fileSystem: instrumentedFileSystem(events),
    tempToken: () => 'atomic-order'
  });

  const json = JSON.parse(await fs.readFile(paths.jsonPath, 'utf8'));
  assert.deepEqual(Object.keys(json), [
    'schemaVersion', 'plannerVersion', 'runId', 'mode', 'startedAt', 'finishedAt', 'status',
    'fixtureSha256', 'protectedVerification', 'seed', 'plannedActions', 'workflows', 'failure',
    'lastSuccessfulActionId'
  ]);
  assert.equal(json.seed, 22_002);
  assert.equal(json.plannerVersion, 1);
  assert.equal(json.lastSuccessfulActionId, 'step-17');
  assert.equal(json.failure.violation.code, 'REVISION_DELTA');
  assert.equal(json.plannedActions.length, 120);
  assert.ok(events.indexOf('open:wx') < events.indexOf('write'));
  assert.ok(events.indexOf('write') < events.indexOf('fsync'));
  assert.ok(events.indexOf('fsync') < events.indexOf('close'));
  const jsonRename = events.findIndex(item => item === 'rename:result.json');
  const jsonReads = events.map((item, index) => item.startsWith('read:') && item.includes('result.json') ? index : -1).filter(index => index >= 0);
  assert.ok(jsonReads.length >= 2);
  assert.ok(jsonReads[0] < jsonRename && jsonRename < jsonReads.at(-1));
});

test('报告 schema 拒绝错误类型、语义和额外顶层字段且不留下临时文件', async t => {
  assert.equal(typeof reportModule.writeWorkflowReport, 'function');
  const invalidResults = [
    failedResult({ seed: -1 }),
    failedResult({ fixtureSha256: 'not-a-sha' }),
    failedResult({ finishedAt: '2026-08-22T07:00:00.000Z' }),
    failedResult({ status: 'passed' }),
    failedResult({ status: 'passed', failure: null, protectedVerification: { ok: false, changed: [{ path: 'fixture.sqlite' }] } }),
    failedResult({ fixtureSha256: null }),
    failedResult({ seed: null }),
    failedResult({
      status: 'passed',
      failure: null,
      edgeFull: {
        command: 'npm run test:edge:full', stdout: '', stderr: 'failed', exitCode: 1,
        signal: null, timedOut: false, reportPath: null
      }
    }),
    failedResult({ unexpected: true })
  ];
  for (const [index, result] of invalidResults.entries()) {
    const runContext = await createRunContext(t);
    await assert.rejects(reportModule.writeWorkflowReport({ runContext, result }), /schema|seed|sha|finished|failure|field/i, `case ${index}`);
    assert.deepEqual(await fs.readdir(runContext.artifactsRoot), []);
  }
});

test('嵌套 workflow、step、failure、violation 与 evidence 使用精确字段和状态语义', () => {
  assert.equal(typeof reportModule.validateWorkflowReport, 'function');
  const cases = [];
  const workflowExtra = reportValue();
  workflowExtra.workflows[0].unexpected = true;
  cases.push(workflowExtra);
  const missingActions = reportValue();
  delete missingActions.workflows[0].plannedActions;
  cases.push(missingActions);
  const badLastSuccess = reportValue();
  badLastSuccess.workflows[0].lastSuccessfulActionId = 17;
  cases.push(badLastSuccess);
  const passedWithFailure = reportValue();
  passedWithFailure.workflows[0].status = 'passed';
  cases.push(passedWithFailure);
  const stepExtra = reportValue();
  stepExtra.workflows[0].steps[0].unexpected = true;
  cases.push(stepExtra);
  const failureExtra = reportValue();
  failureExtra.workflows[0].failure.unexpected = true;
  cases.push(failureExtra);
  const violationExtra = reportValue();
  violationExtra.failure.violation.unexpected = true;
  cases.push(violationExtra);
  const evidenceExtra = reportValue();
  evidenceExtra.workflows[0].evidence.unexpected = true;
  cases.push(evidenceExtra);
  for (const [index, value] of cases.entries()) {
    assert.throws(() => reportModule.validateWorkflowReport(value), /workflow|step|failure|violation|evidence|field|status/i, `case ${index}`);
  }
});

test('嵌套 schema 接受合法 chaos、deterministic 与 CLI orchestration 报告形状', () => {
  assert.equal(typeof reportModule.validateWorkflowReport, 'function');
  const chaos = reportValue();
  assert.doesNotThrow(() => reportModule.validateWorkflowReport(chaos));

  const deterministic = reportValue({
    ...failedResult(),
    fixtureSha256: null,
    seed: null,
    status: 'passed',
    plannedActions: [],
    workflows: [{
      workflowId: 'S01', fixture: 'baseline', fixtureSha256: FIXTURE_SHA256, seed: null,
      status: 'passed', startedAt: STARTED_AT, finishedAt: FINISHED_AT, steps: [], plannedActions: [],
      lastSuccessfulActionId: null,
      cleanup: { status: 'closed', drivers: [{ name: 'primary', status: 'closed' }] },
      protection: { status: 'passed', verification: { ok: true, changed: [] } },
      restart: { profileRoot: 'profiles/restart', violations: [], cleanup: { status: 'closed', drivers: [] } }
    }],
    failure: null,
    lastSuccessfulActionId: null
  });
  assert.doesNotThrow(() => reportModule.validateWorkflowReport(deterministic));

  const orchestration = reportValue({
    ...failedResult(),
    fixtureSha256: null,
    seed: null,
    plannedActions: [],
    workflows: [{
      workflowId: 'WORKFLOW_ENVIRONMENT_INVALID', status: 'failed', steps: [], plannedActions: [],
      lastSuccessfulActionId: null,
      failure: { workflowId: null, stage: 'orchestration', error: { code: 'WORKFLOW_ENVIRONMENT_INVALID', message: 'clock failed' } }
    }],
    failure: { workflowId: null, stage: 'orchestration', error: { code: 'WORKFLOW_ENVIRONMENT_INVALID', message: 'clock failed' } },
    lastSuccessfulActionId: null
  });
  assert.doesNotThrow(() => reportModule.validateWorkflowReport(orchestration));
});

test('full report 以 workflowId 和 seed 绑定同一 chaos activity 的精确失败 execution', async t => {
  const runContext = await createRunContext(t);
  const result = repeatedChaosFailureResult();

  const paths = await reportModule.writeWorkflowReport({ runContext, result });
  const persisted = JSON.parse(await fs.readFile(paths.jsonPath, 'utf8'));
  const replay = await reportModule.readReplayReport(paths.jsonPath);

  assert.equal(persisted.workflows.length, 3);
  assert.deepEqual(persisted.workflows.map(workflow => [workflow.workflowId, workflow.seed]), [
    ['C02', 22_002],
    ['C02', 23_002],
    ['C02', 24_002]
  ]);
  assert.equal(replay.activityId, 'C02');
  assert.equal(replay.seed, 23_002);
  assert.equal(replay.fixtureSha256, FIXTURE_SHA256);
  assert.deepEqual(replay.plannedActions, [reserveAction('C02-23002-step-000', 'REQ-FAILED')]);
});

test('full report 对缺失或重复的 workflowId 和 seed 复合失败身份保持 fail-close', async t => {
  const mismatched = repeatedChaosFailureResult();
  mismatched.seed = 25_002;
  const duplicate = repeatedChaosFailureResult();
  duplicate.workflows.push(structuredClone(duplicate.workflows[1]));

  for (const [label, result] of [['mismatched', mismatched], ['duplicate', duplicate]]) {
    const runContext = await createRunContext(t);
    await assert.rejects(
      reportModule.writeWorkflowReport({ runContext, result }),
      error => error?.code === 'WORKFLOW_REPORT_SCHEMA_INVALID' && /workflow|seed|identity|exact/i.test(error.message),
      label
    );
  }
});

test('chaos failure identity 在顶层 actions 为空时仍要求数值 seed', async t => {
  for (const [label, workflowSeed] of [['omitted', undefined], ['explicit-null', null]]) {
    const workflow = {
      workflowId: 'C02', fixture: 'baseline', fixtureSha256: FIXTURE_SHA256,
      status: 'failed', steps: [], plannedActions: [], lastSuccessfulActionId: null,
      failure: { actionId: null, error: { code: 'SETUP_FAILED', message: label } }
    };
    if (workflowSeed !== undefined) workflow.seed = workflowSeed;
    const result = failedResult({
      mode: 'full', fixtureSha256: null, seed: null, plannedActions: [], workflows: [workflow],
      failure: { workflowId: 'C02', actionId: null, error: { code: 'SETUP_FAILED', message: label } },
      lastSuccessfulActionId: null
    });
    const runContext = await createRunContext(t);

    await assert.rejects(
      reportModule.writeWorkflowReport({ runContext, result }),
      error => error?.code === 'WORKFLOW_REPORT_SCHEMA_INVALID' && /workflow|seed|identity|exact/i.test(error.message),
      label
    );
  }
});

test('deterministic failure identity 将省略的 workflow seed 规范化为顶层 null', async t => {
  const runContext = await createRunContext(t);
  const deterministicAction = action(1);
  const result = failedResult({
    fixtureSha256: null,
    seed: null,
    plannedActions: [],
    workflows: [{
      workflowId: 'S01', fixture: 'baseline', fixtureSha256: FIXTURE_SHA256,
      status: 'failed', steps: [], plannedActions: [deterministicAction], lastSuccessfulActionId: null,
      failure: { actionId: deterministicAction.id, error: { code: 'ACTION_FAILED', message: 'failed' } }
    }],
    failure: { workflowId: 'S01', actionId: deterministicAction.id, error: { code: 'ACTION_FAILED', message: 'failed' } },
    lastSuccessfulActionId: null
  });

  const paths = await reportModule.writeWorkflowReport({ runContext, result });
  const persisted = JSON.parse(await fs.readFile(paths.jsonPath, 'utf8'));
  assert.equal(Object.hasOwn(persisted.workflows[0], 'seed'), false);
  assert.equal(persisted.seed, null);
});

test('exclusive temp 碰撞不删除其他写入者已存在的临时文件', async t => {
  assert.equal(typeof reportModule.writeWorkflowReport, 'function');
  const runContext = await createRunContext(t);
  const existing = path.join(runContext.artifactsRoot, 'result.json.collision.tmp');
  await fs.writeFile(existing, 'other-writer', 'utf8');
  await assert.rejects(
    reportModule.writeWorkflowReport({ runContext, result: failedResult(), tempToken: () => 'collision' }),
    error => error?.code === 'EEXIST'
  );
  assert.equal(await fs.readFile(existing, 'utf8'), 'other-writer');
});

test('临时 JSON 重读 schema 失败时清理 exclusive temp 且不发布 final', async t => {
  assert.equal(typeof reportModule.writeWorkflowReport, 'function');
  const runContext = await createRunContext(t);
  let corrupted = false;
  const fileSystem = instrumentedFileSystem([], {
    async readFile(target, encoding) {
      if (!corrupted && String(target).endsWith('.tmp') && String(target).includes('result.json')) {
        corrupted = true;
        return '{"schemaVersion":"corrupt"}\n';
      }
      return fs.readFile(target, encoding);
    }
  });
  await assert.rejects(
    reportModule.writeWorkflowReport({ runContext, result: failedResult(), fileSystem, tempToken: () => 'temp-schema' }),
    error => error?.code === 'WORKFLOW_REPORT_SCHEMA_INVALID'
  );
  assert.deepEqual(await fs.readdir(runContext.artifactsRoot), []);
});

test('rename 失败清理已关闭临时文件并保留失败证据目录', async t => {
  assert.equal(typeof reportModule.writeWorkflowReport, 'function');
  const runContext = await createRunContext(t);
  const screenshot = path.join(runContext.artifactsRoot, 'screenshots', 'failure.png');
  await fs.mkdir(path.dirname(screenshot), { recursive: true });
  await fs.writeFile(screenshot, 'failure-evidence');
  const fileSystem = instrumentedFileSystem([], {
    async rename() {
      const error = new Error('simulated rename failure');
      error.code = 'EACCES';
      throw error;
    }
  });
  await assert.rejects(
    reportModule.writeWorkflowReport({ runContext, result: failedResult(), fileSystem, tempToken: () => 'rename-failure' }),
    /rename failure/
  );
  assert.equal(await fs.readFile(screenshot, 'utf8'), 'failure-evidence');
  assert.deepEqual((await fs.readdir(runContext.artifactsRoot)).filter(name => name.endsWith('.tmp')), []);
});

test('Markdown 仅从 final JSON 确定生成并重读验证 P0/P1/P2、首错、最后成功、回放和相对 JSON 路径', async t => {
  assert.equal(typeof reportModule.writeWorkflowReport, 'function');
  const runContext = await createRunContext(t);
  const paths = await reportModule.writeWorkflowReport({ runContext, result: failedResult() });
  const markdown = await fs.readFile(paths.markdownPath, 'utf8');
  assert.match(markdown, /P0：1/);
  assert.match(markdown, /P1：0/);
  assert.match(markdown, /P2：0/);
  assert.match(markdown, /首个失败：REVISION_DELTA/);
  assert.match(markdown, /最后成功动作：step-17/);
  const projectRelativeJson = path.relative(runContext.projectRoot, paths.jsonPath).replaceAll('\\', '/');
  assert.ok(markdown.includes(`npm run test:workflow:replay -- --report "${projectRelativeJson}"`));
  assert.ok(!markdown.includes('test:workflow:replay -- --report "artifacts/result.json"'));
  assert.match(markdown, /JSON：artifacts\/result\.json/);
  assert.equal(path.dirname(paths.jsonPath), runContext.artifactsRoot);
  assert.equal(path.dirname(paths.markdownPath), runContext.artifactsRoot);
});

test('Markdown violations 按 workflow/action/violation 身份去重且 prior warning 不吞后续 failure', async t => {
  const runContext = await createRunContext(t);
  const result = failedResult();
  const warning = { code: 'WARNING_ONLY', severity: 'P2', message: 'warning first', entityIds: ['step-18'] };
  const p0 = { code: 'P0_LATER', severity: 'P0', message: 'p0 later', entityIds: ['step-19'] };
  const p1 = { code: 'P1_FAILURE', severity: 'P1', message: 'failure fallback', entityIds: ['step-18'] };
  result.workflows[0].steps[0].violations = [warning, structuredClone(warning)];
  result.workflows[0].steps.push({
    ...structuredClone(result.workflows[0].steps[0]),
    actionId: 'step-19',
    revisionBefore: 19,
    revisionAfter: 20,
    violations: [p0]
  });
  result.workflows[0].failure.violation = p1;
  result.failure.violation = structuredClone(p1);
  const paths = await reportModule.writeWorkflowReport({ runContext, result });
  const markdown = await fs.readFile(paths.markdownPath, 'utf8');
  assert.match(markdown, /P0：1/);
  assert.match(markdown, /P1：1/);
  assert.match(markdown, /P2：1/);
});

test('restart evidence 与 null-action failure 去重且跨 workflow/action/detail 的同 code 保持独立', async t => {
  const runContext = await createRunContext(t);
  const result = failedResult();
  const restartP0 = { code: 'RESTART_STATE', severity: 'P0', message: 'restart mismatch', entityIds: ['REQ-001'] };
  const warningP2 = { code: 'SHARED_CODE', severity: 'P2', message: 'warning detail', entityIds: ['REQ-001'] };
  result.workflows[0].steps[0].violations = [warningP2];
  result.workflows[0].restart = {
    profileRoot: 'profiles/restart-c02',
    violations: [restartP0],
    cleanup: { status: 'closed', drivers: [] }
  };
  result.workflows[0].failure = { stage: 'restart-verification', actionId: null, violation: structuredClone(restartP0) };
  result.failure = { workflowId: 'C02', stage: 'restart-verification', actionId: null, violation: structuredClone(restartP0) };

  const workflow2 = structuredClone(result.workflows[0]);
  workflow2.workflowId = 'C03';
  workflow2.restart.profileRoot = 'profiles/restart-c03';
  workflow2.restart.violations = [];
  workflow2.steps[0].actionId = 'step-19';
  workflow2.steps[0].violations = [{ code: 'RESTART_STATE', severity: 'P0', message: 'restart mismatch', entityIds: ['REQ-001'] }];
  workflow2.failure = {
    stage: 'action', actionId: 'step-19',
    violation: { code: 'SHARED_CODE', severity: 'P1', message: 'blocking detail', entityIds: ['REQ-002'] }
  };
  result.workflows.push(workflow2);

  const paths = await reportModule.writeWorkflowReport({ runContext, result });
  const markdown = await fs.readFile(paths.markdownPath, 'utf8');
  assert.match(markdown, /P0：2/);
  assert.match(markdown, /P1：1/);
  assert.match(markdown, /P2：1/);
});

test('restart stage 保留 concrete action identity 且只折叠 synthetic/null evidence copy', async t => {
  const runContext = await createRunContext(t);
  const result = failedResult();
  const restartP0 = { code: 'RESTART_STATE', severity: 'P0', message: 'same restart detail', entityIds: ['REQ-001'] };
  const warningP2 = { code: 'WARNING_DETAIL', severity: 'P2', message: 'warning detail', entityIds: ['REQ-001'] };
  result.workflows[0].steps[0].violations = [warningP2];
  result.workflows[0].restart = {
    profileRoot: 'profiles/restart-c02',
    violations: [restartP0],
    cleanup: { status: 'closed', drivers: [] }
  };
  result.workflows[0].failure = {
    stage: 'restart-verification', actionId: 'restart-durable', violation: structuredClone(restartP0)
  };
  result.failure = {
    workflowId: 'C02', stage: 'restart-verification', actionId: 'restart-fresh', violation: structuredClone(restartP0)
  };

  const workflow2 = structuredClone(result.workflows[0]);
  workflow2.workflowId = 'C03';
  workflow2.restart.profileRoot = 'profiles/restart-c03';
  workflow2.failure = {
    stage: 'action', actionId: 'step-18',
    violation: { code: 'BLOCKING_DETAIL', severity: 'P1', message: 'blocking detail', entityIds: ['REQ-002'] }
  };
  workflow2.steps[0].violations = [];
  result.workflows.push(workflow2);

  const paths = await reportModule.writeWorkflowReport({ runContext, result });
  const markdown = await fs.readFile(paths.markdownPath, 'utf8');
  assert.match(markdown, /P0：4/);
  assert.match(markdown, /P1：1/);
  assert.match(markdown, /P2：1/);
});

test('optional edgeFull 只能保存固定命令、受限输出、退出状态和 run-root 相对报告路径', async t => {
  assert.equal(typeof reportModule.writeWorkflowReport, 'function');
  const runContext = await createRunContext(t);
  const edgeFull = {
    command: 'npm run test:edge:full',
    stdout: 'edge stdout',
    stderr: 'edge stderr',
    exitCode: 1,
    signal: null,
    timedOut: false,
    reportPath: 'edge-full/run-1/artifacts/report.json'
  };
  const paths = await reportModule.writeWorkflowReport({ runContext, result: failedResult({ edgeFull }) });
  const json = JSON.parse(await fs.readFile(paths.jsonPath, 'utf8'));
  assert.deepEqual(Object.keys(json).at(-1), 'edgeFull');
  assert.deepEqual(json.edgeFull, edgeFull);

  await assert.rejects(
    reportModule.writeWorkflowReport({
      runContext: { ...runContext, runId: `${runContext.runId}-bad` },
      result: failedResult({ edgeFull: { ...edgeFull, reportPath: '../../escape.json' } })
    }),
    /edgeFull|path|safe/i
  );
});

test('large multi-step settlements persist bounded compact evidence while schema and replay remain valid', async t => {
  assert.equal(typeof reportModule.writeWorkflowReport, 'function');
  assert.equal(typeof reportModule.validateWorkflowReport, 'function');
  assert.equal(typeof reportModule.readReplayReport, 'function');
  const runContext = await createRunContext(t);
  const stepCount = 16;
  const largeStateBytes = 256 * 1024;
  const maxPersistedReportBytes = 75 * 1024;
  const largeValue = 'x'.repeat(largeStateBytes);
  const plannedActions = Array.from({ length: stepCount }, (_, index) => ({
    id: `C02-22002-step-${String(index).padStart(3, '0')}`,
    type: 'reserve',
    params: { requestNo: 'REQ-1', sampleIds: ['REQ-1.001'], channelKeys: ['DEV-1::CH-1'], note: 'replay' },
    expect: 'success',
    revisionDelta: 1,
    evidenceRevisionDelta: 1,
    maxMs: 1_000
  }));
  const stateAt = revision => ({
    revision,
    requests: [{ id: 'REQ-1', payload: largeValue }],
    samples: [{ id: 'REQ-1.001', payload: largeValue }],
    records: [{ id: `REC-${revision}`, payload: largeValue }]
  });
  const uiAt = revision => ({
    projection: {
      currentPage: 'dashboard',
      summary: { revision, records: revision },
      visible: { records: [{ id: `REC-${revision}`, payload: largeValue }] }
    },
    consoleErrors: [`console-${revision}-${largeValue}`],
    pageErrors: [`page-${revision}-${largeValue}`]
  });
  const steps = plannedActions.map((plannedAction, index) => {
    const beforeRevision = index + 10;
    const afterRevision = beforeRevision + 1;
    return {
      actionId: plannedAction.id,
      outcome: 'success',
      revisionBefore: beforeRevision,
      revisionAfter: afterRevision,
      settlement: {
        mode: 'audit-chain',
        outcome: 'success',
        message: largeValue,
        beforeRevision,
        beforeState: stateAt(beforeRevision),
        persistedRevision: afterRevision,
        state: stateAt(afterRevision),
        auditIds: [`AUDIT-${index}`],
        audits: [{ id: `AUDIT-${index}`, payload: largeValue }],
        auditEvidence: [{ id: `AUDIT-${index}`, payload: largeValue }],
        uiEvidence: uiAt(afterRevision),
        finalPage: 'dashboard'
      },
      stateSummaryBefore: { revision: beforeRevision, records: beforeRevision },
      stateSummaryAfter: { revision: afterRevision, records: afterRevision },
      uiEvidence: uiAt(afterRevision),
      auditEvidence: { auditLogs: [{ id: `AUDIT-${index}`, payload: largeValue }], formJournal: [] },
      violations: []
    };
  });
  const lastAction = plannedActions.at(-1);
  const result = {
    schemaVersion: 1,
    plannerVersion: 1,
    mode: 'quick',
    startedAt: STARTED_AT,
    finishedAt: FINISHED_AT,
    status: 'failed',
    fixtureSha256: FIXTURE_SHA256,
    protectedVerification: { ok: true, changed: [] },
    seed: 22_002,
    plannedActions,
    workflows: [{
      workflowId: 'C02',
      fixture: 'baseline',
      fixtureSha256: FIXTURE_SHA256,
      seed: 22_002,
      status: 'failed',
      steps,
      plannedActions,
      lastSuccessfulActionId: plannedActions.at(-2).id,
      failure: { actionId: lastAction.id, violation: { code: 'REPORT_VOLUME', severity: 'P0', message: 'report volume fixture', entityIds: [lastAction.id] } }
    }],
    failure: { workflowId: 'C02', actionId: lastAction.id, violation: { code: 'REPORT_VOLUME', severity: 'P0', message: 'report volume fixture', entityIds: [lastAction.id] } },
    lastSuccessfulActionId: plannedActions.at(-2).id
  };

  const paths = await reportModule.writeWorkflowReport({ runContext, result });
  const persisted = JSON.parse(await fs.readFile(paths.jsonPath, 'utf8'));
  const bytes = Buffer.byteLength(await fs.readFile(paths.jsonPath));

  reportModule.validateWorkflowReport(persisted);
  const replay = await reportModule.readReplayReport(paths.jsonPath);
  assert.deepEqual(replay.plannedActions, plannedActions);
  assert.ok(bytes <= maxPersistedReportBytes, `expected <= ${maxPersistedReportBytes} bytes, received ${bytes}`);
  for (const step of persisted.workflows[0].steps) {
    assert.equal(Object.hasOwn(step.settlement, 'beforeState'), false);
    assert.equal(Object.hasOwn(step.settlement, 'state'), false);
    assert.equal(Object.hasOwn(step.settlement, 'uiEvidence'), false);
    assert.equal(Object.hasOwn(step.uiEvidence, 'projection'), false);
  }
});

test('compact report retains bounded import-policy audit summaries and every failure error branch', async t => {
  const runContext = await createRunContext(t);
  const largeValue = 'x'.repeat(4_096);
  const result = failedResult();
  const step = result.workflows[0].steps[0];
  step.settlement = {
    mode: 'audit-chain', outcome: 'success', beforeRevision: 17, persistedRevision: 19,
    auditIds: ['AUDIT-IMPORT'], finalPage: 'requests'
  };
  step.auditEvidence.auditLogs = [{
    id: 'AUDIT-IMPORT', action: '导入申请单', target: '请求目录', result: 'success', verified: true,
    before: { committed: 0, skipped: 1, covered: 1, ignoredPayload: largeValue },
    after: {
      committed: 2,
      skipped: 3,
      covered: 5,
      errors: [{ file: 'bad.xlsx', requestNo: 'REQ-BAD', code: 'INVALID_ROW', message: largeValue, ignoredPayload: largeValue }],
      ignoredPayload: largeValue
    },
    note: largeValue
  }];
  const cleanup = {
    status: 'failed',
    error: Object.assign(new Error(largeValue), { code: 'CLEANUP_ERROR' }),
    drivers: [{ name: 'primary', status: 'failed', error: Object.assign(new Error(largeValue), { code: 'DRIVER_ERROR' }) }]
  };
  const protection = { status: 'failed', error: Object.assign(new Error(largeValue), { code: 'PROTECTION_ERROR' }) };
  const failure = {
    actionId: 'step-18',
    cleanup,
    protection,
    finishedAtError: Object.assign(new Error(largeValue), { code: 'FINISHED_AT_ERROR' })
  };
  result.workflows[0].failure = structuredClone(failure);
  result.failure = { workflowId: 'C02', ...structuredClone(failure) };

  const paths = await reportModule.writeWorkflowReport({ runContext, result });
  const persisted = JSON.parse(await fs.readFile(paths.jsonPath, 'utf8'));
  const audit = persisted.workflows[0].steps[0].auditEvidence.auditLogs[0];
  const persistedFailure = persisted.failure;

  assert.deepEqual(audit.before, { committed: 0, skipped: 1, covered: 1 });
  assert.deepEqual(audit.after, {
    committed: 2,
    skipped: 3,
    covered: 5,
    errors: [{ file: 'bad.xlsx', requestNo: 'REQ-BAD', code: 'INVALID_ROW', message: `${largeValue.slice(0, 256)}… [truncated 3840 chars]` }]
  });
  assert.equal(audit.note, `${largeValue.slice(0, 256)}… [truncated 3840 chars]`);
  for (const error of [
    persistedFailure.cleanup.error,
    persistedFailure.cleanup.drivers[0].error,
    persistedFailure.protection.error,
    persistedFailure.finishedAtError
  ]) {
    assert.equal(Object.hasOwn(error, 'stack'), false);
    assert.equal(error.message, `${largeValue.slice(0, 256)}… [truncated 3840 chars]`);
  }
  assert.equal(persisted.workflows[0].steps[0].settlement.actionType, 'navigate');
  reportModule.validateWorkflowReport(persisted);
});

test('settled step without a planned action type fails closed during report compaction', async t => {
  const runContext = await createRunContext(t);
  const result = failedResult();
  result.plannedActions = result.plannedActions.filter(item => item.id !== 'step-18');
  result.workflows[0].plannedActions = result.workflows[0].plannedActions.filter(item => item.id !== 'step-18');
  result.workflows[0].steps[0].settlement = { mode: 'audit-chain', outcome: 'success', beforeRevision: 17, persistedRevision: 19, auditIds: [] };

  await assert.rejects(
    reportModule.writeWorkflowReport({ runContext, result }),
    error => error?.code === 'WORKFLOW_REPORT_SCHEMA_INVALID' && /action type/.test(error.message)
  );
});

test('compact report bounds direct workflow cleanup, protection, and restart cleanup errors', async t => {
  const runContext = await createRunContext(t);
  const largeValue = 'x'.repeat(4_096);
  const result = failedResult();
  const directCleanup = {
    status: 'failed',
    timeoutMs: 1_000,
    error: Object.assign(new Error(largeValue), { code: 'WORKFLOW_CLEANUP_ERROR' }),
    drivers: [{ name: 'primary', status: 'failed', error: Object.assign(new Error(largeValue), { code: 'WORKFLOW_DRIVER_ERROR' }) }]
  };
  result.workflows[0].cleanup = directCleanup;
  result.workflows[0].protection = {
    status: 'failed', stage: 'verification', error: Object.assign(new Error(largeValue), { code: 'WORKFLOW_PROTECTION_ERROR' })
  };
  result.workflows[0].restart = {
    profileRoot: 'profiles/restart-c02',
    violations: [],
    cleanup: {
      status: 'failed',
      error: Object.assign(new Error(largeValue), { code: 'RESTART_CLEANUP_ERROR' }),
      drivers: [{ name: 'restart', status: 'failed', error: Object.assign(new Error(largeValue), { code: 'RESTART_DRIVER_ERROR' }) }]
    }
  };

  const paths = await reportModule.writeWorkflowReport({ runContext, result });
  const persisted = JSON.parse(await fs.readFile(paths.jsonPath, 'utf8'));
  const workflow = persisted.workflows[0];
  const errors = [
    workflow.cleanup.error,
    workflow.cleanup.drivers[0].error,
    workflow.protection.error,
    workflow.restart.cleanup.error,
    workflow.restart.cleanup.drivers[0].error
  ];

  assert.equal(workflow.cleanup.timeoutMs, 1_000);
  assert.equal(workflow.protection.stage, 'verification');
  assert.equal(workflow.restart.profileRoot, 'profiles/restart-c02');
  for (const error of errors) {
    assert.equal(Object.hasOwn(error, 'stack'), false);
    assert.equal(error.message, `${largeValue.slice(0, 256)}… [truncated 3840 chars]`);
  }
  reportModule.validateWorkflowReport(persisted);
});

test('deterministic workflow 嵌套动作保留目录原合同，顶层 replay 动作仍要求完整字段', async t => {
  assert.equal(typeof reportModule.writeWorkflowReport, 'function');
  const runContext = await createRunContext(t);
  const deterministicAction = action(1);
  delete deterministicAction.evidenceRevisionDelta;
  const result = failedResult({
    fixtureSha256: null,
    seed: null,
    plannedActions: [],
    workflows: [{
      workflowId: 'S01', fixture: 'baseline', fixtureSha256: FIXTURE_SHA256, seed: null,
      status: 'failed', plannedActions: [deterministicAction], steps: [], lastSuccessfulActionId: null,
      failure: { actionId: deterministicAction.id, error: { code: 'ACTION_FAILED', message: 'failed' } }
    }],
    failure: { workflowId: 'S01', actionId: deterministicAction.id, error: { code: 'ACTION_FAILED', message: 'failed' } },
    lastSuccessfulActionId: null
  });
  const paths = await reportModule.writeWorkflowReport({ runContext, result });
  const json = JSON.parse(await fs.readFile(paths.jsonPath, 'utf8'));
  assert.deepEqual(json.workflows[0].plannedActions, [deterministicAction]);

  const invalidReplayAction = action(1);
  delete invalidReplayAction.evidenceRevisionDelta;
  await assert.rejects(
    reportModule.writeWorkflowReport({
      runContext: { ...runContext, runId: `${runContext.runId}-replay` },
      result: failedResult({ plannedActions: [invalidReplayAction] })
    }),
    /evidenceRevisionDelta/
  );
});
