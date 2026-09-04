import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';

const cliModule = await import('./cli.mjs').catch(() => ({}));
const reportModule = await import('./report-writer.mjs').catch(() => ({}));

const HASH = 'b'.repeat(64);
const STARTED_AT = '2026-08-22T08:00:00.000Z';
const FINISHED_AT = '2026-08-22T08:01:00.000Z';

test('CLI 模块在 process.argv[1] 缺失时仍可安全导入且不误执行 main', () => {
  const moduleUrl = new URL('./cli.mjs', import.meta.url).href;
  const child = spawnSync(process.execPath, [
    '--input-type=module',
    '--eval',
    `await import(${JSON.stringify(moduleUrl)});`
  ], { encoding: 'utf8', windowsHide: true });

  assert.equal(child.status, 0, child.stderr || child.stdout);
  assert.equal(child.stdout, '');
  assert.equal(child.stderr, '');
});

test('普通 workflow 的 run-local SQLite 锁能力可重复使用且不接受外部目标', async t => {
  assert.equal(typeof cliModule.createRunLocalWriteLock, 'function');
  const root = await mkdtemp(path.join(os.tmpdir(), 'workflow-run-local-lock-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sqlitePath = path.join(root, 'fixture.sqlite');
  const externalPath = path.join(root, 'external.sqlite');
  const seed = new DatabaseSync(sqlitePath);
  seed.exec('CREATE TABLE test_lock (id INTEGER PRIMARY KEY);');
  seed.close();
  const armWriteLock = cliModule.createRunLocalWriteLock(sqlitePath);

  const releaseFirst = await armWriteLock(externalPath);
  assert.equal(typeof releaseFirst, 'function');
  assert.throws(() => {
    const rival = new DatabaseSync(sqlitePath);
    try { rival.exec('PRAGMA busy_timeout=0; BEGIN IMMEDIATE;'); } finally { rival.close(); }
  }, /locked|busy/i);
  releaseFirst();
  releaseFirst();
  const releaseSecond = await armWriteLock();
  assert.equal(typeof releaseSecond, 'function');
  releaseSecond();
  await assert.rejects(import('node:fs/promises').then(({ stat }) => stat(externalPath)), /ENOENT/);
});

test('受保护 CLI main 复用 runWorkflowCli 并将非零结果返回给 smoke/直接入口', async () => {
  assert.equal(typeof cliModule.main, 'function');
  const stdout = [];
  const stderr = [];
  let receivedArgv;
  const exitCode = await cliModule.main(['--mode', 'quick'], {
    async runWorkflowCliImpl(argv) {
      receivedArgv = argv;
      return {
        exitCode: 1,
        result: { runId: 'run-task12', mode: 'quick', status: 'failed' },
        reports: { markdownPath: 'C:/isolated/report.md' }
      };
    },
    stdout: { write(value) { stdout.push(value); } },
    stderr: { write(value) { stderr.push(value); } }
  });

  assert.deepEqual(receivedArgv, ['--mode', 'quick']);
  assert.equal(exitCode, 1);
  assert.deepEqual(JSON.parse(stdout.join('').trim()), {
    runId: 'run-task12', mode: 'quick', status: 'failed', report: 'C:/isolated/report.md'
  });
  assert.deepEqual(stderr, []);
});

function recordedAction(id = 'C02-22002-step-000') {
  return {
    id,
    type: 'reserve',
    params: { requestNo: 'REQ-1', sampleIds: ['REQ-1.001'], channelKeys: ['DEV-1::CH-1'], note: 'replay' },
    expect: 'success',
    revisionDelta: 1,
    evidenceRevisionDelta: 1,
    maxMs: 1_000
  };
}

function replayReport(overrides = {}) {
  const action = recordedAction();
  return {
    schemaVersion: 1,
    plannerVersion: 1,
    runId: '20260822T080000000Z-01020304',
    mode: 'quick',
    startedAt: STARTED_AT,
    finishedAt: FINISHED_AT,
    status: 'failed',
    fixtureSha256: HASH,
    protectedVerification: { ok: true, changed: [] },
    seed: 22_002,
    plannedActions: [action],
    workflows: [{
      workflowId: 'C02', fixture: 'baseline', fixtureSha256: HASH, seed: 22_002,
      status: 'failed', plannedActions: [action], lastSuccessfulActionId: null,
      steps: [], failure: { actionId: action.id, violation: { code: 'REVISION_DELTA', severity: 'P0', message: 'bad revision', entityIds: [] } }
    }],
    failure: { workflowId: 'C02', actionId: action.id, violation: { code: 'REVISION_DELTA', severity: 'P0', message: 'bad revision', entityIds: [] } },
    lastSuccessfulActionId: null,
    ...overrides
  };
}

async function reportFile(t, value = replayReport()) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'workflow-replay-report-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const target = path.join(root, 'result.json');
  await writeFile(target, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  return target;
}

test('parseWorkflowArgs 严格解析 quick/full/replay、ids、seed 和 keep-workdir', () => {
  assert.equal(typeof cliModule.parseWorkflowArgs, 'function');
  assert.deepEqual(
    cliModule.parseWorkflowArgs(['--mode', 'quick', '--ids', 'C02', '--seed', '123', '--keep-workdir']),
    { mode: 'quick', ids: ['C02'], seed: 123, replayReport: null, keepWorkdir: true }
  );
  assert.deepEqual(
    cliModule.parseWorkflowArgs(['--mode', 'replay', '--report', 'run/result.json']),
    { mode: 'replay', ids: [], seed: null, replayReport: path.resolve('run/result.json'), keepWorkdir: false }
  );
});

test('parseWorkflowArgs 拒绝缺值、重复项、未知项和 mode/ids/seed/report 互斥冲突', () => {
  assert.equal(typeof cliModule.parseWorkflowArgs, 'function');
  const invalid = [
    [],
    ['--mode'],
    ['--mode', 'other'],
    ['--mode', 'quick', '--report', 'x.json'],
    ['--mode', 'replay'],
    ['--mode', 'replay', '--report', 'x.json', '--ids', 'C02'],
    ['--mode', 'replay', '--report', 'x.json', '--seed', '1'],
    ['--mode', 'full', '--seed', '1'],
    ['--mode', 'quick', '--seed', '1'],
    ['--mode', 'quick', '--ids', 'C01,C02', '--seed', '1'],
    ['--mode', 'quick', '--ids', 'S01', '--seed', '1'],
    ['--mode', 'quick', '--ids', 'C07'],
    ['--mode', 'quick', '--ids', 'S01,S01'],
    ['--mode', 'quick', '--keep-workdir', '--keep-workdir'],
    ['--mode', 'quick', '--unknown']
  ];
  for (const argv of invalid) assert.throws(() => cliModule.parseWorkflowArgs(argv), error => error?.exitCode === 2, argv.join(' '));
});

test('quick/full suite 选择固定 deterministic workflows 与 C01-C06 精确种子矩阵', () => {
  assert.equal(typeof cliModule.createSuitePlan, 'function');
  const quick = cliModule.createSuitePlan({ mode: 'quick', ids: [], seed: null });
  const full = cliModule.createSuitePlan({ mode: 'full', ids: [], seed: null });
  assert.equal(new Set(full.deterministic.map(item => item.id)).size, 28);
  assert.deepEqual(full.deterministic.map(item => item.id), [
    'S01', 'S02', 'S03', 'S04', 'S05', 'S06', 'S07', 'S08',
    'D01', 'D02', 'D03', 'D04', 'D05', 'D06', 'D07', 'D08',
    'M01', 'M02', 'M03', 'M04', 'M05', 'M06', 'M07', 'M08', 'M09', 'M10', 'M11', 'M12'
  ]);
  assert.deepEqual(quick.chaos, [
    { activityId: 'C01', seed: 22001 }, { activityId: 'C02', seed: 22002 },
    { activityId: 'C03', seed: 22003 }, { activityId: 'C04', seed: 22004 },
    { activityId: 'C05', seed: 22005 }, { activityId: 'C06', seed: 22006 }
  ]);
  assert.equal(full.chaos.length, 30);
  for (const [index, activityId] of ['C01', 'C02', 'C03', 'C04', 'C05', 'C06'].entries()) {
    assert.deepEqual(full.chaos.filter(item => item.activityId === activityId).map(item => item.seed),
      [22001 + index, 23001 + index, 24001 + index, 25001 + index, 26001 + index]);
  }
});

test('readReplayReport 严格读取有效 schema 与原 fixture/activity/action contract', async t => {
  assert.equal(typeof reportModule.readReplayReport, 'function');
  const target = await reportFile(t);
  const replay = await reportModule.readReplayReport(target);
  assert.equal(replay.activityId, 'C02');
  assert.equal(replay.fixture, 'baseline');
  assert.equal(replay.fixtureSha256, HASH);
  assert.equal(replay.seed, 22_002);
  assert.deepEqual(replay.plannedActions, [recordedAction()]);
});

test('readReplayReport 拒绝坏 schema、空动作、无效 SHA、失败 SHA 标记和不安全动作路径', async t => {
  assert.equal(typeof reportModule.readReplayReport, 'function');
  const cases = [
    replayReport({ schemaVersion: 2 }),
    replayReport({ plannedActions: [] }),
    replayReport({ plannedActions: undefined }),
    replayReport({ fixtureSha256: 'invalid' }),
    replayReport({ fixtureSha256: null }),
    replayReport({ plannedActions: [{ ...recordedAction(), params: { path: '../../escape.xlsx' } }] }),
    replayReport({ plannedActions: [{ ...recordedAction(), params: { path: 'C:\\escape.xlsx' } }] })
  ];
  for (const [index, value] of cases.entries()) {
    const target = await reportFile(t, value);
    await assert.rejects(reportModule.readReplayReport(target), /schema|action|sha|path|safe/i, `case ${index}`);
  }
});

test('readReplayReport 在 driver 前拒绝未知或缺参动作，并禁止无效 activity 的 seed/hash 回退', async t => {
  assert.equal(typeof reportModule.readReplayReport, 'function');
  const invalidAction = recordedAction();
  invalidAction.type = 'unknown-action';
  const missingParams = recordedAction();
  delete missingParams.params.requestNo;
  const wrongActivityAction = {
    ...recordedAction(), type: 'navigate', params: { label: '看板' },
    revisionDelta: 0, evidenceRevisionDelta: 0
  };
  const duplicate = replayReport();
  duplicate.workflows.push(structuredClone(duplicate.workflows[0]));
  const cases = [
    replayReport({ plannedActions: [invalidAction], workflows: [{ ...replayReport().workflows[0], plannedActions: [invalidAction] }] }),
    replayReport({ plannedActions: [missingParams], workflows: [{ ...replayReport().workflows[0], plannedActions: [missingParams] }] }),
    replayReport({ plannedActions: [wrongActivityAction], workflows: [{ ...replayReport().workflows[0], plannedActions: [wrongActivityAction] }] }),
    replayReport({ failure: { ...replayReport().failure, workflowId: 'S01' } }),
    replayReport({ failure: { ...replayReport().failure, workflowId: 'C07' } }),
    duplicate
  ];
  for (const [index, value] of cases.entries()) {
    const target = await reportFile(t, value);
    await assert.rejects(
      reportModule.readReplayReport(target),
      error => error?.exitCode === 2 && /action|activity|parameter|unique|exact/i.test(error.message),
      `case ${index}`
    );
  }
});

test('runReplay 以 Task 10 recorded source 原样执行且完全不调用 planner/PRNG/new seed', async () => {
  assert.equal(typeof cliModule.runReplay, 'function');
  const calls = [];
  const action = recordedAction('C02-22002-step-verbatim');
  const result = await cliModule.runReplay({
    replay: { activityId: 'C02', fixture: 'baseline', fixtureSha256: HASH, seed: 22_002, plannedActions: [action], startedAt: STARTED_AT },
    runContext: { runRoot: 'run-root' },
    dependencies: {
      async prepareExecution(input) { calls.push(['prepare', input.activityId, input.fixture]); return { runContext: { workflowId: 'C02' }, fixtureSha256: HASH }; },
      createChaosPlanner() { throw new Error('planner must never be called'); },
      createSeededRandom() { throw new Error('PRNG must never be called'); },
      createRecordedActionSource(actions) {
        calls.push(['recorded', structuredClone(actions)]);
        let index = 0;
        return { kind: 'replay', needsUi: false, maxSteps: actions.length, next: () => actions[index++] ?? null };
      },
      async runWorkflow({ actionSource }) {
        calls.push(['executed', await actionSource.next(), await actionSource.next()]);
        return { status: 'failed', plannedActions: [action], failure: { violation: { code: 'REVISION_DELTA', severity: 'P0' } } };
      }
    }
  });
  assert.equal(result.status, 'failed');
  assert.deepEqual(calls, [
    ['prepare', 'C02', 'baseline'],
    ['recorded', [action]],
    ['executed', action, null]
  ]);
});

test('runReplay 在 fixture SHA 不同场景于 driver/runner 启动前 exit 2', async () => {
  assert.equal(typeof cliModule.runReplay, 'function');
  let runnerStarted = false;
  await assert.rejects(
    cliModule.runReplay({
      replay: { activityId: 'C02', fixture: 'baseline', fixtureSha256: HASH, seed: 22_002, plannedActions: [recordedAction()], startedAt: STARTED_AT },
      runContext: { runRoot: 'run-root' },
      dependencies: {
        async prepareExecution() { return { runContext: {}, fixtureSha256: 'c'.repeat(64) }; },
        async runWorkflow() { runnerStarted = true; }
      }
    }),
    error => error?.exitCode === 2 && error?.code === 'FIXTURE_SHA256_MISMATCH'
  );
  assert.equal(runnerStarted, false);
});

test('退出码优先级固定为 protected 3 > args/schema/fixture 2 > workflow/Edge 1 > success 0', () => {
  assert.equal(typeof cliModule.exitCodeForWorkflow, 'function');
  assert.equal(cliModule.exitCodeForWorkflow({ result: { status: 'passed', protectedVerification: { ok: true } } }), 0);
  assert.equal(cliModule.exitCodeForWorkflow({ result: { status: 'failed', protectedVerification: { ok: true } } }), 1);
  assert.equal(cliModule.exitCodeForWorkflow({ error: Object.assign(new Error('bad args'), { exitCode: 2 }) }), 2);
  assert.equal(cliModule.exitCodeForWorkflow({ result: { status: 'failed', protectedVerification: { ok: true } }, error: Object.assign(new Error('bad schema'), { exitCode: 2 }) }), 2);
  assert.equal(cliModule.exitCodeForWorkflow({ result: { status: 'failed', protectedVerification: { ok: false, changed: [] } }, error: Object.assign(new Error('verification failed'), { exitCode: 2 }) }), 2);
  assert.equal(cliModule.exitCodeForWorkflow({ result: { status: 'failed', protectedVerification: { ok: false, changed: [{ path: 'fixture.sqlite' }] } }, error: Object.assign(new Error('bad schema'), { exitCode: 2 }) }), 3);
  const verificationError = Object.assign(new Error('nested verification failed'), { exitCode: 2 });
  const nestedEmptyChange = {
    status: 'failed', protectedVerification: { ok: true, changed: [] },
    workflows: [{
      protection: {
        status: 'failed',
        verification: { ok: false, changed: [], error: verificationError },
        violation: { code: 'PROTECTED_PATH_CHANGED', severity: 'P0', message: 'unknown', entityIds: [] }
      },
      failure: { protection: { verification: { ok: false, changed: [] }, error: verificationError } }
    }]
  };
  assert.equal(cliModule.exitCodeForWorkflow({ result: nestedEmptyChange, error: verificationError }), 2);
  nestedEmptyChange.workflows[0].protection.verification.changed = [{ path: 'fixture.sqlite' }];
  assert.equal(cliModule.exitCodeForWorkflow({ result: nestedEmptyChange, error: verificationError }), 3);
});

function fakeRunContext(events, protection = { ok: true, changed: [] }) {
  const runRoot = path.join(os.tmpdir(), 'workflow-cli-run', '自动测试报告', 'workflows', '20260822T080000000Z-01020304');
  return {
    runId: '20260822T080000000Z-01020304', mode: 'full', runRoot, artifactsRoot: path.join(runRoot, 'artifacts'),
    async assertWritable(value) { return path.resolve(value); },
    async verifyProtected() {
      events.push('verify');
      const value = Array.isArray(protection) ? protection.shift() : protection;
      if (value instanceof Error) throw value;
      return value;
    },
    async cleanup() { events.push('cleanup'); }
  };
}

function suiteResult(status = 'passed') {
  const action = recordedAction();
  const workflow = {
    workflowId: 'C02', fixture: 'baseline', fixtureSha256: HASH, seed: 22_002,
    status, plannedActions: [action], steps: [], lastSuccessfulActionId: status === 'passed' ? action.id : null,
    ...(status === 'failed' ? { failure: { actionId: action.id, violation: { code: 'REVISION_DELTA', severity: 'P0', message: 'bad', entityIds: [] } } } : {})
  };
  return {
    status, startedAt: STARTED_AT, finishedAt: FINISHED_AT, workflows: [workflow],
    replayTarget: workflow,
    ...(status === 'failed' ? { failure: { workflowId: 'C02', ...workflow.failure } } : {})
  };
}

test('full 在 workflow/chaos 失败时短路，不启动 Edge full，并在报告验证前不 cleanup', async () => {
  assert.equal(typeof cliModule.runWorkflowCli, 'function');
  const events = [];
  const runContext = fakeRunContext(events);
  const output = await cliModule.runWorkflowCli(['--mode', 'full'], {
    async createRunContext() { events.push('context'); return runContext; },
    async runSelectedSuites() { events.push('suites'); return suiteResult('failed'); },
    async runEdgeFull() { events.push('edge'); throw new Error('must not run'); },
    async writeReport() { events.push('report'); return { jsonPath: 'result.json', markdownPath: 'report.md' }; }
  });
  assert.equal(output.exitCode, 1);
  assert.deepEqual(events, ['context', 'suites', 'verify', 'report', 'cleanup']);
});

test('full 只在 suites 通过后调用 Edge，非零/信号/超时证据写入报告并 exit 1', async () => {
  assert.equal(typeof cliModule.runWorkflowCli, 'function');
  for (const edgeFull of [
    { command: 'npm run test:edge:full', stdout: 'out', stderr: 'err', exitCode: 1, signal: null, timedOut: false, reportPath: 'edge-full/run/artifacts/report.json' },
    { command: 'npm run test:edge:full', stdout: '', stderr: '', exitCode: null, signal: 'SIGTERM', timedOut: false, reportPath: null },
    { command: 'npm run test:edge:full', stdout: '', stderr: 'timeout', exitCode: null, signal: 'SIGTERM', timedOut: true, reportPath: null }
  ]) {
    const events = [];
    let persisted;
    const output = await cliModule.runWorkflowCli(['--mode', 'full'], {
      async createRunContext() { return fakeRunContext(events); },
      async runSelectedSuites() { events.push('suites'); return suiteResult('passed'); },
      async runEdgeFull() { events.push('edge'); return edgeFull; },
      async writeReport({ result }) { events.push('report'); persisted = result; return { jsonPath: 'result.json', markdownPath: 'report.md' }; }
    });
    assert.equal(output.exitCode, 1);
    assert.deepEqual(persisted.edgeFull, edgeFull);
    assert.deepEqual(events, ['suites', 'verify', 'edge', 'verify', 'report', 'cleanup']);
  }
});

test('full 顶层 finishedAt 在 Edge 和最终保护检查后采样，成功失败均使用最终时钟', async () => {
  for (const expected of [
    { edgeExitCode: 0, status: 'passed', exitCode: 0, reportPath: 'edge-full/run/自动测试报告.md' },
    { edgeExitCode: 1, status: 'failed', exitCode: 1, reportPath: 'edge-full/run/自动测试报告.md' }
  ]) {
    const events = [];
    const instants = [
      new Date('2026-08-29T11:00:00.000Z'),
      new Date('2026-08-29T11:30:48.000Z')
    ];
    let persisted;
    const output = await cliModule.runWorkflowCli(['--mode', 'full'], {
      clock() {
        const instant = instants.shift();
        assert.ok(instant, 'clock sampled more than twice');
        events.push(`clock:${instant.toISOString()}`);
        return instant;
      },
      async createRunContext() { events.push('context'); return fakeRunContext(events); },
      async runSelectedSuites() { events.push('suites'); return suiteResult('passed'); },
      async runEdgeFull() {
        events.push('edge');
        return {
          command: 'npm run test:edge:full', stdout: '', stderr: '',
          exitCode: expected.edgeExitCode, signal: null, timedOut: false, reportPath: expected.reportPath
        };
      },
      async writeReport({ result }) {
        events.push('report');
        persisted = result;
        return { jsonPath: 'result.json', markdownPath: 'report.md' };
      }
    });

    assert.deepEqual(instants, []);
    assert.equal(output.exitCode, expected.exitCode);
    assert.equal(output.result.status, expected.status);
    assert.equal(output.result.finishedAt, '2026-08-29T11:30:48.000Z');
    assert.equal(persisted.finishedAt, '2026-08-29T11:30:48.000Z');
    assert.deepEqual(events, [
      'context',
      'clock:2026-08-29T11:00:00.000Z',
      'suites',
      'verify',
      'edge',
      'verify',
      'clock:2026-08-29T11:30:48.000Z',
      'report',
      'cleanup'
    ]);
  }
});

test('full 在 Edge 前后验证保护路径，confirmed change exit 3，verification error exit 2', async () => {
  assert.equal(typeof cliModule.runWorkflowCli, 'function');
  const changed = { ok: false, changed: [{ path: 'fixture.sqlite' }] };
  for (const item of [
    { checks: [changed], expected: 3, edge: false },
    { checks: [new Error('pre verification unavailable')], expected: 2, edge: false },
    { checks: [{ ok: true, changed: [] }, changed], expected: 3, edge: true },
    { checks: [{ ok: true, changed: [] }, new Error('post verification unavailable')], expected: 2, edge: true }
  ]) {
    const events = [];
    let persisted;
    const output = await cliModule.runWorkflowCli(['--mode', 'full'], {
      async createRunContext() { return fakeRunContext(events, [...item.checks]); },
      async runSelectedSuites() { events.push('suites'); return suiteResult('passed'); },
      async runEdgeFull() {
        events.push('edge');
        return { command: 'npm run test:edge:full', stdout: '', stderr: '', exitCode: 0, signal: null, timedOut: false, reportPath: 'edge-full/run/artifacts/report.json' };
      },
      async writeReport({ result }) { events.push('report'); persisted = result; return { jsonPath: 'result.json', markdownPath: 'report.md' }; }
    });
    assert.equal(output.exitCode, item.expected);
    assert.equal(events.includes('edge'), item.edge);
    assert.equal(persisted.status, 'failed');
    if (item.expected === 3) assert.deepEqual(persisted.protectedVerification.changed, changed.changed);
  }
});

test('已确认 protection exit 3 在后续报告写失败时保持最高优先级且不 cleanup', async () => {
  const events = [];
  await assert.rejects(
    cliModule.runWorkflowCli(['--mode', 'quick'], {
      async createRunContext() { return fakeRunContext(events, { ok: false, changed: [{ path: 'fixture.sqlite' }] }); },
      async runSelectedSuites() { events.push('suites'); return suiteResult('failed'); },
      async writeReport() { events.push('report'); throw new Error('report final reread failed'); }
    }),
    error => error?.exitCode === 3 && /report final reread failed/.test(error.message)
  );
  assert.deepEqual(events, ['suites', 'verify', 'report']);
});

test('报告 final 重读失败时绝不 cleanup，失败与保护证据仍保留', async () => {
  assert.equal(typeof cliModule.runWorkflowCli, 'function');
  const events = [];
  await assert.rejects(
    cliModule.runWorkflowCli(['--mode', 'quick'], {
      async createRunContext() { return fakeRunContext(events); },
      async runSelectedSuites() { events.push('suites'); return suiteResult('failed'); },
      async writeReport() { events.push('report'); throw Object.assign(new Error('final reread invalid'), { exitCode: 2 }); }
    }),
    error => error?.exitCode === 2 && /final reread invalid/.test(error.message)
  );
  assert.deepEqual(events, ['suites', 'verify', 'report']);
});

function fakeChild({ stdout = '', stderr = '', exitCode = 0, signal = null, hang = false, pid = 42_424 } = {}) {
  const child = new EventEmitter();
  child.pid = pid;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => {
    queueMicrotask(() => child.emit('close', null, 'SIGTERM'));
    return true;
  };
  queueMicrotask(() => {
    if (stdout) child.stdout.write(stdout);
    if (stderr) child.stderr.write(stderr);
    child.stdout.end();
    child.stderr.end();
    if (!hang) child.emit('close', exitCode, signal);
  });
  return child;
}

test('Windows Edge full 使用固定白名单命令/argv、windowsHide、受限输出并捕获 child report', async () => {
  assert.equal(typeof cliModule.runEdgeFull, 'function');
  const root = await mkdtemp(path.join(os.tmpdir(), 'workflow-edge-child-'));
  const workflowRunRoot = path.join(root, '自动测试报告', 'workflows', '20260822T080000000Z-01020304');
  await mkdir(workflowRunRoot, { recursive: true });
  const report = path.join(workflowRunRoot, 'edge-full', 'edge-run', '自动测试报告.md');
  await mkdir(path.dirname(report), { recursive: true });
  await writeFile(report, '# edge report\n', 'utf8');
  let launch;
  const result = await cliModule.runEdgeFull({
    runContext: {
      projectRoot: root,
      runRoot: workflowRunRoot,
      async assertWritable(value) { return path.resolve(value); }
    },
    timeoutMs: 1_000,
    maxOutputBytes: 32,
    spawnProcess(executable, argv, options) {
      launch = { executable, argv, options };
      return fakeChild({ stdout: `${'x'.repeat(64)}\n${JSON.stringify({ report })}\n`, stderr: 'edge stderr', exitCode: 0 });
    }
  });
  await rm(root, { recursive: true, force: true });
  assert.equal(result.command, 'npm run test:edge:full');
  assert.equal(result.exitCode, 0);
  assert.equal(result.timedOut, false);
  assert.equal(result.reportPath, 'edge-full/edge-run/自动测试报告.md');
  assert.ok(Buffer.byteLength(result.stdout) <= 32);
  assert.equal(launch.options.windowsHide, true);
  assert.equal(launch.options.shell, false);
  assert.equal(launch.options.env.BATTERY_EDGE_REPORT_ROOT, path.join(workflowRunRoot, 'edge-full'));
  assert.equal(launch.executable, process.execPath);
  assert.deepEqual(launch.argv, [
    path.resolve(import.meta.dirname, '..', '..', 'scripts', 'edge-regression', 'run.mjs'),
    '--mode', 'full', '--report-root', path.join(workflowRunRoot, 'edge-full')
  ]);
});

test('Edge full 将含空格的 report root 作为独立 Node argv 传给固定 runner', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'workflow-edge-space-root-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const projectRoot = path.join(root, 'Battery Channel Hub');
  const workflowRunRoot = path.join(projectRoot, '自动测试报告', 'workflows', '20260822T080000000Z-01020304');
  const reportRoot = path.join(workflowRunRoot, 'edge-full');
  const report = path.join(reportRoot, 'edge-run', '自动测试报告.md');
  await mkdir(path.dirname(report), { recursive: true });
  await writeFile(report, '# edge report\n', 'utf8');
  let launch;

  const result = await cliModule.runEdgeFull({
    runContext: {
      projectRoot,
      runRoot: workflowRunRoot,
      async assertWritable(value) { return path.resolve(value); }
    },
    timeoutMs: 1_000,
    spawnProcess(executable, argv, options) {
      launch = { executable, argv, options };
      return fakeChild({ stdout: `${JSON.stringify({ report })}\n`, exitCode: 0 });
    }
  });

  assert.equal(result.exitCode, 0);
  assert.equal(launch.executable, process.execPath);
  assert.deepEqual(launch.argv, [
    path.resolve(import.meta.dirname, '..', '..', 'scripts', 'edge-regression', 'run.mjs'),
    '--mode', 'full', '--report-root', reportRoot
  ]);
  assert.equal(launch.argv[4], reportRoot);
  assert.equal(launch.options.shell, false);
});

test('Edge child exit 0 的报告缺失、未声明或 canonical 逃逸均按 Edge failure exit 1', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'workflow-edge-report-evidence-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workflowRunRoot = path.join(root, '自动测试报告', 'workflows', '20260822T080000000Z-01020304');
  const edgeRoot = path.join(workflowRunRoot, 'edge-full');
  await mkdir(edgeRoot, { recursive: true });
  const outsideDirectory = path.join(root, 'outside');
  const outside = path.join(outsideDirectory, '自动测试报告.md');
  await mkdir(outsideDirectory, { recursive: true });
  await writeFile(outside, '# outside\n', 'utf8');
  const escapedDirectory = path.join(edgeRoot, 'escaped');
  await symlink(outsideDirectory, escapedDirectory, 'junction');
  const escapedLink = path.join(escapedDirectory, '自动测试报告.md');
  for (const stdout of [
    '',
    `${JSON.stringify({ report: path.join(edgeRoot, 'missing-report.md') })}\n`,
    `${JSON.stringify({ report: outside })}\n`,
    `${JSON.stringify({ report: escapedLink })}\n`
  ]) {
    const edgeFull = await cliModule.runEdgeFull({
      runContext: { projectRoot: root, runRoot: workflowRunRoot, async assertWritable(value) { return path.resolve(value); } },
      timeoutMs: 1_000,
      spawnProcess() { return fakeChild({ stdout, exitCode: 0 }); }
    });
    assert.equal(edgeFull.exitCode, 0);
    assert.equal(edgeFull.reportPath, null);
    assert.equal(cliModule.exitCodeForWorkflow({ result: { status: 'passed', protectedVerification: { ok: true, changed: [] }, edgeFull } }), 1);
  }
});

test('Edge full timeout 有界 kill 并记录 timedOut/signal/exitCode', async () => {
  assert.equal(typeof cliModule.runEdgeFull, 'function');
  const root = await mkdtemp(path.join(os.tmpdir(), 'workflow-edge-timeout-'));
  const workflowRunRoot = path.join(root, '自动测试报告', 'workflows', '20260822T080000000Z-01020304');
  await mkdir(workflowRunRoot, { recursive: true });
  const result = await cliModule.runEdgeFull({
    runContext: { projectRoot: root, runRoot: workflowRunRoot, async assertWritable(value) { return path.resolve(value); } },
    timeoutMs: 10,
    spawnProcess() { return fakeChild({ hang: true }); },
    async captureProcessTree({ pid }) { return [pid]; },
    async terminateProcessTree() {},
    async verifyProcessTreeGone({ ownedPids }) { return ownedPids.length === 1; }
  });
  await rm(root, { recursive: true, force: true });
  assert.equal(result.exitCode, null);
  assert.equal(result.signal, 'SIGTERM');
  assert.equal(result.timedOut, true);
});

test('Edge full child 忽略 SIGTERM 且不发 close 时仍在固定 grace 后有界返回', async () => {
  assert.equal(typeof cliModule.runEdgeFull, 'function');
  const root = await mkdtemp(path.join(os.tmpdir(), 'workflow-edge-timeout-stuck-'));
  const workflowRunRoot = path.join(root, '自动测试报告', 'workflows', '20260822T080000000Z-01020304');
  await mkdir(workflowRunRoot, { recursive: true });
  const stuck = new EventEmitter();
  stuck.stdout = new PassThrough();
  stuck.stderr = new PassThrough();
  stuck.pid = 51_234;
  let kills = 0;
  stuck.kill = () => { kills += 1; return true; };
  const treeCalls = [];
  const result = await Promise.race([
    cliModule.runEdgeFull({
      runContext: { projectRoot: root, runRoot: workflowRunRoot, async assertWritable(value) { return path.resolve(value); } },
      timeoutMs: 5,
      killGraceMs: 5,
      spawnProcess() { return stuck; },
      async captureProcessTree(input) {
        treeCalls.push(['capture', input]);
        return [input.pid, 51_235];
      },
      async terminateProcessTree(input) {
        treeCalls.push(['terminate', input]);
      },
      async verifyProcessTreeGone(input) {
        treeCalls.push(['verify', input]);
        return true;
      }
    }),
    new Promise((_, reject) => setTimeout(() => reject(new Error('runEdgeFull did not return after timeout grace')), 100))
  ]);
  await rm(root, { recursive: true, force: true });
  assert.equal(kills, 0);
  assert.equal(treeCalls[0][0], 'capture');
  assert.deepEqual(treeCalls[0][1], { pid: 51_234, executable: process.execPath, timeoutMs: 5 });
  assert.equal(treeCalls[1][0], 'terminate');
  assert.deepEqual(treeCalls[1][1].ownedPids, [51_234, 51_235]);
  assert.equal(treeCalls[2][0], 'verify');
  assert.deepEqual(treeCalls[2][1].ownedPids, [51_234, 51_235]);
  assert.equal(treeCalls[2][1].timeoutMs, 5);
  assert.equal(result.exitCode, null);
  assert.equal(result.signal, 'SIGTERM');
  assert.equal(result.timedOut, true);
});

test('Windows process-tree 验证失败时拒绝返回成功结果，CLI 不报告也不 cleanup', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'workflow-edge-tree-remains-'));
  const workflowRunRoot = path.join(root, '自动测试报告', 'workflows', '20260822T080000000Z-01020304');
  await mkdir(workflowRunRoot, { recursive: true });
  const child = fakeChild({ hang: true, pid: 61_234 });
  await assert.rejects(
    cliModule.runEdgeFull({
      runContext: { projectRoot: root, runRoot: workflowRunRoot, async assertWritable(value) { return path.resolve(value); } },
      timeoutMs: 5,
      killGraceMs: 5,
      spawnProcess() { return child; },
      async captureProcessTree({ pid }) { return [pid, 61_235]; },
      async terminateProcessTree() {},
      async verifyProcessTreeGone() { return false; }
    }),
    error => error?.code === 'EDGE_PROCESS_TREE_TERMINATION_UNVERIFIED' && error?.exitCode === 2
  );
  await rm(root, { recursive: true, force: true });

  const events = [];
  await assert.rejects(
    cliModule.runWorkflowCli(['--mode', 'full'], {
      async createRunContext() { return fakeRunContext(events, [{ ok: true, changed: [] }, { ok: true, changed: [] }]); },
      async runSelectedSuites() { events.push('suites'); return suiteResult('passed'); },
      async runEdgeFull() {
        events.push('edge');
        throw Object.assign(new Error('owned descendants remain'), { code: 'EDGE_PROCESS_TREE_TERMINATION_UNVERIFIED', exitCode: 2, unsafeProcessResidue: true });
      },
      async writeReport() { events.push('report'); return { jsonPath: 'result.json', markdownPath: 'report.md' }; }
    }),
    error => error?.code === 'EDGE_PROCESS_TREE_TERMINATION_UNVERIFIED'
  );
  assert.deepEqual(events, ['suites', 'verify', 'edge', 'verify']);
});

test('Windows 默认 process-tree helper 对已经退出的固定 Node 根 PID fail-close', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'workflow-edge-default-tree-'));
  const workflowRunRoot = path.join(root, '自动测试报告', 'workflows', '20260822T080000000Z-01020304');
  await mkdir(workflowRunRoot, { recursive: true });
  try {
    await assert.rejects(
      cliModule.runEdgeFull({
        runContext: { projectRoot: root, runRoot: workflowRunRoot, async assertWritable(value) { return path.resolve(value); } },
        timeoutMs: 5,
        killGraceMs: 2_000,
        spawnProcess() { return fakeChild({ hang: true, pid: 2_147_483_646 }); }
      }),
      error => error?.code === 'EDGE_PROCESS_TREE_TERMINATION_UNVERIFIED' && error?.exitCode === 2
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Windows timeout 对空/缺根/partial capture、kill error 与 verifier error 全部 termination-unverified', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'workflow-edge-tree-contract-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workflowRunRoot = path.join(root, '自动测试报告', 'workflows', '20260822T080000000Z-01020304');
  await mkdir(workflowRunRoot, { recursive: true });
  const pid = 71_234;
  const cases = [
    { name: 'empty capture', capture: [], calls: ['capture'] },
    { name: 'root missing', capture: [71_235], calls: ['capture'] },
    { name: 'capture error', captureError: new Error('capture failed after partial enumeration'), calls: ['capture'] },
    { name: 'kill error', capture: [pid, 71_235], killError: new Error('taskkill failed'), calls: ['capture', 'terminate'] },
    { name: 'survivor', capture: [pid, 71_235], verification: false, calls: ['capture', 'terminate', 'verify'] },
    { name: 'verifier error', capture: [pid], verifyError: new Error('verification unavailable'), calls: ['capture', 'terminate', 'verify'] }
  ];
  for (const item of cases) {
    const calls = [];
    await assert.rejects(
      cliModule.runEdgeFull({
        runContext: { projectRoot: root, runRoot: workflowRunRoot, async assertWritable(value) { return path.resolve(value); } },
        timeoutMs: 5,
        killGraceMs: 5,
        spawnProcess() { return fakeChild({ hang: true, pid }); },
        async captureProcessTree() {
          calls.push('capture');
          if (item.captureError) throw item.captureError;
          return item.capture;
        },
        async terminateProcessTree() {
          calls.push('terminate');
          if (item.killError) throw item.killError;
        },
        async verifyProcessTreeGone() {
          calls.push('verify');
          if (item.verifyError) throw item.verifyError;
          return item.verification ?? true;
        }
      }),
      error => error?.code === 'EDGE_PROCESS_TREE_TERMINATION_UNVERIFIED'
        && error?.exitCode === 2
        && error?.unsafeProcessResidue === true,
      item.name
    );
    assert.deepEqual(calls, item.calls, item.name);
  }
});
