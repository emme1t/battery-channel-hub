import { createHash } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { mkdir, readFile, realpath, stat } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { CHAOS_ACTIVITIES, createRecordedActionSource, runChaosActivity } from './chaos-planner.mjs';
import { WORKFLOW_CATALOG, selectWorkflows } from './catalog.mjs';
import { createWorkflowElectronDriver } from './electron-driver.mjs';
import { seedWorkflowFixture } from './fixtures.mjs';
import { readReplayReport, writeWorkflowReport } from './report-writer.mjs';
import { createWorkflowRunContext } from './run-context.mjs';
import { runWorkflow } from './runner.mjs';

const PROJECT_ROOT = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const WORKFLOW_BY_ID = new Map(WORKFLOW_CATALOG.map(workflow => [workflow.id, workflow]));
const CHAOS_IDS = Object.freeze(Object.keys(CHAOS_ACTIVITIES));
const DEFAULT_EDGE_TIMEOUT_MS = 35 * 60 * 1_000;
const DEFAULT_EDGE_OUTPUT_BYTES = 1_048_576;
const WINDOWS_TASKKILL = 'C:\\Windows\\System32\\taskkill.exe';
const WINDOWS_POWERSHELL = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
const EDGE_RUNNER_SCRIPT = path.join(PROJECT_ROOT, 'scripts', 'edge-regression', 'run.mjs');
const EDGE_NODE_EXECUTABLE = path.resolve(process.execPath);
const CAPTURE_WINDOWS_TREE_SCRIPT = [
  "$ErrorActionPreference='Stop'",
  '$rootPid=[int]$args[0]',
  '$expectedExecutable=[IO.Path]::GetFullPath([string]$args[1])',
  '$all=@(Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,ExecutablePath)',
  '$root=@($all | Where-Object { [int]$_.ProcessId -eq $rootPid })[0]',
  "if($null -eq $root){throw 'workflow child root missing during pre-capture'}",
  "if($null -eq $root.ExecutablePath -or -not ([IO.Path]::GetFullPath([string]$root.ExecutablePath) -ieq $expectedExecutable)){throw 'workflow child root executable mismatch'}",
  '$ids=@($rootPid)',
  '$front=@($rootPid)',
  'while($front.Count -gt 0){$next=@($all | Where-Object { $front -contains [int]$_.ParentProcessId } | ForEach-Object { [int]$_.ProcessId } | Where-Object { $ids -notcontains $_ });$ids+=@($next);$front=@($next)}',
  '[Console]::Out.Write((ConvertTo-Json -InputObject @($ids) -Compress))'
].join(';');
const VERIFY_WINDOWS_TREE_SCRIPT = [
  "$ErrorActionPreference='Stop'",
  '$timeoutMs=[int]$args[0]',
  '$ids=@($args[1..($args.Count-1)] | ForEach-Object { [int]$_ })',
  '$deadline=(Get-Date).AddMilliseconds($timeoutMs)',
  'do{$alive=@(Get-Process -Id $ids -ErrorAction SilentlyContinue | ForEach-Object { [int]$_.Id });if($alive.Count -eq 0){exit 0};Start-Sleep -Milliseconds 25}while((Get-Date) -lt $deadline)',
  '[Console]::Error.Write((ConvertTo-Json -InputObject @($alive) -Compress))',
  'exit 4'
].join(';');

function cliError(message, code = 'WORKFLOW_CLI_INVALID') {
  const error = new Error(message);
  error.code = code;
  error.exitCode = 2;
  return error;
}

function isFixedEdgeNodeExecutable(executable) {
  const normalize = value => process.platform === 'win32'
    ? path.win32.normalize(path.win32.resolve(String(value))).toLowerCase()
    : path.resolve(String(value));
  return normalize(executable) === normalize(EDGE_NODE_EXECUTABLE);
}

function takeValue(argv, index, option) {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith('--')) throw cliError(`${option} requires a value`);
  return value;
}

function execFileBounded(executable, argv, timeoutMs) {
  return new Promise((resolve, reject) => {
    execFile(executable, argv, {
      windowsHide: true,
      timeout: Math.max(1_000, timeoutMs + 500),
      maxBuffer: 65_536,
      shell: false
    }, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
      } else resolve({ stdout, stderr });
    });
  });
}

async function defaultCaptureWindowsProcessTree({ pid, executable, timeoutMs }) {
  if (!Number.isInteger(pid) || pid <= 0) throw cliError('workflow child PID must be a positive integer', 'EDGE_PROCESS_TREE_INVALID');
  if (!isFixedEdgeNodeExecutable(executable)) throw cliError('workflow child executable is not the fixed Node runner', 'EDGE_PROCESS_TREE_INVALID');
  const capture = await execFileBounded(WINDOWS_POWERSHELL, [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-Command', `& {${CAPTURE_WINDOWS_TREE_SCRIPT}}`, String(pid), EDGE_NODE_EXECUTABLE
  ], timeoutMs);
  let ownedPids;
  try { ownedPids = JSON.parse(String(capture.stdout || '[]')); } catch (error) {
    throw cliError(`failed to parse workflow process tree: ${error.message}`, 'EDGE_PROCESS_TREE_INVALID');
  }
  if (!Array.isArray(ownedPids) || ownedPids.some(item => !Number.isInteger(item) || item <= 0)) {
    throw cliError('workflow process tree must contain only positive integer PIDs', 'EDGE_PROCESS_TREE_INVALID');
  }
  const unique = [...new Set(ownedPids)];
  if (unique.length === 0 || !unique.includes(pid)) throw cliError('workflow process tree capture must contain its root PID', 'EDGE_PROCESS_TREE_INVALID');
  return Object.freeze(unique);
}

async function defaultTerminateWindowsProcessTree({ pid, executable, ownedPids, timeoutMs }) {
  if (!Number.isInteger(pid) || pid <= 0) throw cliError('workflow child PID must be a positive integer', 'EDGE_PROCESS_TREE_INVALID');
  if (!isFixedEdgeNodeExecutable(executable)) throw cliError('workflow child executable is not the fixed Node runner', 'EDGE_PROCESS_TREE_INVALID');
  if (!Array.isArray(ownedPids) || ownedPids.length === 0 || !ownedPids.includes(pid)
    || ownedPids.some(item => !Number.isInteger(item) || item <= 0)) {
    throw cliError('workflow process tree termination requires a complete rooted PID set', 'EDGE_PROCESS_TREE_INVALID');
  }
  await execFileBounded(WINDOWS_TASKKILL, ['/PID', String(pid), '/T', '/F'], timeoutMs);
}

async function defaultVerifyWindowsProcessTreeGone({ ownedPids, timeoutMs }) {
  if (!Array.isArray(ownedPids) || ownedPids.some(item => !Number.isInteger(item) || item <= 0)) return false;
  if (ownedPids.length === 0) return false;
  try {
    await execFileBounded(WINDOWS_POWERSHELL, [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-Command', `& {${VERIFY_WINDOWS_TREE_SCRIPT}}`,
      String(timeoutMs), ...ownedPids.map(String)
    ], timeoutMs);
    return true;
  } catch {
    return false;
  }
}

export function parseWorkflowArgs(argv) {
  if (!Array.isArray(argv)) throw cliError('argv must be an array');
  const options = { mode: null, ids: [], seed: null, replayReport: null, keepWorkdir: false };
  const seen = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!['--mode', '--ids', '--seed', '--report', '--keep-workdir'].includes(argument)) {
      throw cliError(`unknown argument: ${String(argument)}`);
    }
    if (seen.has(argument)) throw cliError(`duplicate argument: ${argument}`);
    seen.add(argument);
    if (argument === '--keep-workdir') {
      options.keepWorkdir = true;
      continue;
    }
    const value = takeValue(argv, index, argument);
    index += 1;
    if (argument === '--mode') options.mode = value;
    if (argument === '--ids') {
      const ids = value.split(',');
      if (ids.some(id => id === '' || id.trim() !== id)) throw cliError('--ids must be a comma-separated non-empty list');
      if (new Set(ids).size !== ids.length) throw cliError('--ids must not contain duplicates');
      for (const id of ids) {
        if (!WORKFLOW_BY_ID.has(id) && !CHAOS_ACTIVITIES[id]) throw cliError(`unknown workflow id: ${id}`);
      }
      options.ids = ids;
    }
    if (argument === '--seed') {
      if (!/^(0|[1-9]\d*)$/.test(value)) throw cliError('--seed must be a decimal uint32 integer');
      const seed = Number(value);
      if (!Number.isSafeInteger(seed) || seed > 0xffff_ffff) throw cliError('--seed must be a decimal uint32 integer');
      options.seed = seed;
    }
    if (argument === '--report') options.replayReport = path.resolve(value);
  }
  if (!['quick', 'full', 'replay'].includes(options.mode)) throw cliError('--mode must be quick, full, or replay');
  if (options.mode === 'replay') {
    if (!options.replayReport) throw cliError('replay mode requires --report');
    if (options.ids.length > 0 || options.seed !== null) throw cliError('replay mode does not allow --ids or --seed');
  } else {
    if (options.replayReport) throw cliError('--report is only valid in replay mode');
    if (options.mode === 'full' && options.seed !== null) throw cliError('full mode uses the fixed five-seed matrix');
    if (options.seed !== null && (options.ids.length !== 1 || !CHAOS_ACTIVITIES[options.ids[0]])) {
      throw cliError('--seed requires exactly one C01-C06 --ids value in quick mode');
    }
  }
  return Object.freeze({ ...options, ids: Object.freeze([...options.ids]) });
}

export function createSuitePlan({ mode, ids = [], seed = null }) {
  if (!['quick', 'full'].includes(mode)) throw cliError('suite mode must be quick or full');
  if (!Array.isArray(ids)) throw cliError('suite ids must be an array');
  const deterministicIds = ids.filter(id => WORKFLOW_BY_ID.has(id));
  const chaosIds = ids.length === 0 ? CHAOS_IDS : ids.filter(id => CHAOS_ACTIVITIES[id]);
  const deterministic = ids.length === 0
    ? selectWorkflows({ mode })
    : Object.freeze(deterministicIds.map(id => WORKFLOW_BY_ID.get(id)));
  const chaos = [];
  for (const activityId of chaosIds) {
    const config = CHAOS_ACTIVITIES[activityId];
    const seeds = seed !== null ? [seed] : mode === 'quick' ? [config.quickSeed] : config.fullSeeds;
    for (const selectedSeed of seeds) chaos.push(Object.freeze({ activityId, seed: selectedSeed }));
  }
  return Object.freeze({ deterministic, chaos: Object.freeze(chaos) });
}

function canonicalIso(clock) {
  const date = clock();
  const parsed = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(parsed.getTime())) throw cliError('clock must return a valid date', 'WORKFLOW_ENVIRONMENT_INVALID');
  return parsed.toISOString();
}

async function hashFile(target) {
  return createHash('sha256').update(await readFile(target)).digest('hex');
}

function protectedPaths(projectRoot) {
  return [
    ['人工回归数据包', 'v0.4.2', 'SQLite', '01-26设备529通道空基线.sqlite'],
    ['人工回归数据包', 'v0.4.2', 'SQLite', '02-事务与状态迁移.sqlite'],
    ['人工回归数据包', 'v0.4.2', 'SQLite', '03-100申请999子样品2000日志审计.sqlite'],
    ['人工回归数据包', 'v0.4.3', 'SQLite', '04-及时率筛选与预约待办.sqlite'],
    ['tests', 'fixtures', 'v0.4.6-scenario-contract.md']
  ].map(parts => path.join(projectRoot, ...parts));
}

function safeExecutionKey(workflowId, sequence, seed) {
  return `${workflowId}-${String(sequence).padStart(3, '0')}${seed === null || seed === undefined ? '' : `-${seed}`}`;
}

export function createRunLocalWriteLock(sqlitePath) {
  const target = path.resolve(sqlitePath);
  return async () => {
    const database = new DatabaseSync(target);
    try {
      database.exec('PRAGMA busy_timeout=0; BEGIN IMMEDIATE;');
    } catch (error) {
      database.close();
      throw error;
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      try {
        database.exec('ROLLBACK;');
      } finally {
        database.close();
      }
    };
  };
}

async function defaultPrepareExecution({
  projectRoot,
  runContext,
  workflowId,
  fixture,
  sequence = 0,
  seed = null,
  fixtureClock
}) {
  const key = safeExecutionKey(workflowId, sequence, seed);
  const dataRoot = path.join(runContext.dataRoot, key);
  const profileRoot = path.join(runContext.profileRoot, key);
  const exportsRoot = path.join(runContext.exportsRoot, key);
  const screenshotsRoot = path.join(runContext.screenshotsRoot, key);
  await Promise.all([dataRoot, profileRoot, exportsRoot, screenshotsRoot].map(async directory => {
    await runContext.assertWritable(path.join(directory, '.guard'));
    await mkdir(directory, { recursive: true });
  }));
  const fixtureManifest = await seedWorkflowFixture({ dataRoot, kind: fixture, workflowId, clock: fixtureClock });
  const fixtureSha256 = await hashFile(fixtureManifest.sqlitePath);
  const armWriteLock = createRunLocalWriteLock(fixtureManifest.sqlitePath);
  const child = Object.freeze({
    mode: runContext.mode,
    runId: runContext.runId,
    runRoot: runContext.runRoot,
    workflowId,
    fixture,
    fixtureSha256,
    fixtureManifest,
    armWriteLock,
    dataRoot,
    profileRoot,
    exportsRoot,
    screenshotsRoot,
    assertWritable: candidate => runContext.assertWritable(candidate),
    verifyProtected: () => runContext.verifyProtected(),
    async cleanup() {}
  });
  const driverFactory = ({ runContext: liveContext, profileRoot: liveProfileRoot, role = 'primary' }) => {
    const raw = createWorkflowElectronDriver({
      projectRoot,
      dataRoot: liveContext.dataRoot,
      profileRoot: liveProfileRoot,
      viewport: '1366x768',
      timeoutMs: 25_000
    });
    if (role === 'secondary') return raw;
    const actor = `Workflow ${workflowId}`;
    async function ensureReadyAndAuthenticated() {
      const page = raw.page();
      const username = page.locator('#username');
      if (await username.count() === 1 && await username.isVisible()) {
        await username.fill(actor);
        await page.locator('#login .btn.wide').click();
      }
      await page.waitForFunction(() => window.__batteryAppReady === true);
      await raw.waitForPersistenceBarrier({ auditAction: '登录看板', actor, timeoutMs: 5_000 });
    }
    return {
      name: `${workflowId}-${role}`,
      async start() {
        await raw.start();
        await ensureReadyAndAuthenticated();
      },
      restart: () => raw.restart(),
      close: () => raw.close(),
      page: () => raw.page(),
      uiProjection: () => raw.uiProjection(),
      viewEvidence: view => raw.viewEvidence(view),
      capturePersistenceBoundary: options => raw.capturePersistenceBoundary(options),
      waitForPersistenceBarrier: options => raw.waitForPersistenceBarrier(options),
      configureDialogs: routes => raw.configureDialogs(routes),
      dataRoot: () => raw.dataRoot(),
      screenshot: name => raw.screenshot(name)
    };
  };
  return Object.freeze({ runContext: child, fixtureSha256, driverFactory });
}

function annotateResult(result, { fixture, fixtureSha256, seed = null }) {
  return {
    ...result,
    fixture,
    fixtureSha256,
    seed
  };
}

export async function runSelectedSuites({
  args,
  runContext,
  projectRoot = PROJECT_ROOT,
  clock = () => new Date(),
  dependencies = {}
}) {
  const prepareExecution = dependencies.prepareExecution || defaultPrepareExecution;
  const runWorkflowImpl = dependencies.runWorkflow || runWorkflow;
  const runChaosActivityImpl = dependencies.runChaosActivity || runChaosActivity;
  const plan = createSuitePlan(args);
  const startedAt = canonicalIso(clock);
  const fixtureClock = () => new Date(startedAt);
  const workflows = [];
  let replayTarget = null;
  let sequence = 0;

  for (const workflow of plan.deterministic) {
    sequence += 1;
    const prepared = await prepareExecution({
      projectRoot, runContext, workflowId: workflow.id, fixture: workflow.fixture, sequence, seed: null, fixtureClock
    });
    const result = annotateResult(await runWorkflowImpl({
      workflow,
      runContext: prepared.runContext,
      driverFactory: prepared.driverFactory,
      clock
    }), { fixture: workflow.fixture, fixtureSha256: prepared.fixtureSha256 });
    workflows.push(result);
    if (result.status === 'failed') break;
  }

  if (!workflows.some(result => result.status === 'failed')) {
    for (const item of plan.chaos) {
      sequence += 1;
      const config = CHAOS_ACTIVITIES[item.activityId];
      const prepared = await prepareExecution({
        projectRoot,
        runContext,
        workflowId: item.activityId,
        activityId: item.activityId,
        fixture: config.fixture,
        sequence,
        seed: item.seed,
        fixtureClock
      });
      const result = annotateResult(await runChaosActivityImpl({
        activityId: item.activityId,
        seed: item.seed,
        runContext: prepared.runContext,
        driverFactory: prepared.driverFactory,
        clock
      }), { fixture: config.fixture, fixtureSha256: prepared.fixtureSha256, seed: item.seed });
      workflows.push(result);
      replayTarget = result;
      if (result.status === 'failed') break;
    }
  }

  const failed = workflows.find(result => result.status === 'failed');
  return {
    status: failed ? 'failed' : 'passed',
    startedAt,
    finishedAt: canonicalIso(clock),
    workflows,
    replayTarget,
    ...(failed ? { failure: { workflowId: failed.workflowId, ...failed.failure } } : {})
  };
}

export async function runReplay({
  replay,
  runContext,
  projectRoot = PROJECT_ROOT,
  clock = () => new Date(),
  dependencies = {}
}) {
  if (!replay || typeof replay !== 'object') throw cliError('replay input is required', 'REPLAY_INPUT_INVALID');
  const prepareExecution = dependencies.prepareExecution || defaultPrepareExecution;
  const createRecordedActionSourceImpl = dependencies.createRecordedActionSource || createRecordedActionSource;
  const runWorkflowImpl = dependencies.runWorkflow || runWorkflow;
  const prepared = await prepareExecution({
    projectRoot,
    runContext,
    workflowId: replay.activityId,
    activityId: replay.activityId,
    fixture: replay.fixture,
    sequence: 1,
    seed: replay.seed,
    fixtureClock: () => new Date(replay.startedAt)
  });
  if (prepared.fixtureSha256 !== replay.fixtureSha256) {
    throw cliError(
      `fixture SHA-256 mismatch: expected ${replay.fixtureSha256}, got ${prepared.fixtureSha256}`,
      'FIXTURE_SHA256_MISMATCH'
    );
  }
  const config = CHAOS_ACTIVITIES[replay.activityId];
  if (!config || config.fixture !== replay.fixture) throw cliError('replay activity/fixture contract mismatch', 'REPLAY_FIXTURE_CONTRACT_INVALID');
  const workflow = Object.freeze({
    id: config.id,
    name: config.id,
    risk: 'P0',
    fixture: config.fixture,
    actions: Object.freeze([])
  });
  const actionSource = createRecordedActionSourceImpl(replay.plannedActions);
  const result = await runWorkflowImpl({
    workflow,
    runContext: prepared.runContext,
    driverFactory: prepared.driverFactory,
    clock,
    actionSource
  });
  return annotateResult(result, {
    fixture: replay.fixture,
    fixtureSha256: replay.fixtureSha256,
    seed: replay.seed
  });
}

function protectionFailed(result) {
  if (confirmedProtectionChange(result?.protectedVerification)) return true;
  for (const workflow of Array.isArray(result?.workflows) ? result.workflows : []) {
    if (confirmedProtectionChange(workflow?.protection?.verification)) return true;
    if (confirmedProtectionChange(workflow?.failure?.protection?.verification)) return true;
  }
  return false;
}

function confirmedProtectionChange(verification) {
  return Array.isArray(verification?.changed) && verification.changed.length > 0;
}

function edgeFailed(edgeFull) {
  return Boolean(edgeFull) && (
    edgeFull.timedOut || edgeFull.signal !== null || edgeFull.exitCode !== 0 ||
    typeof edgeFull.reportPath !== 'string' || edgeFull.reportPath.trim() === ''
  );
}

export function exitCodeForWorkflow({ result = null, error = null } = {}) {
  if (protectionFailed(result)) return 3;
  if (error?.exitCode === 2 || error?.code === 'FIXTURE_SHA256_MISMATCH') return 2;
  if (result?.failure?.error?.exitCode === 2) return 2;
  if (result?.status === 'failed' || edgeFailed(result?.edgeFull)) return 1;
  return 0;
}

function environmentError(error, code, message) {
  if (error?.exitCode === 2) return error;
  const wrapped = cliError(`${message}: ${error?.message || String(error)}`, code);
  wrapped.cause = error;
  return wrapped;
}

async function protectionCheck(runContext) {
  try {
    const verification = await runContext.verifyProtected();
    if (!verification || typeof verification !== 'object' || typeof verification.ok !== 'boolean') {
      throw new TypeError('verifyProtected must return an object with boolean ok');
    }
    const changed = Array.isArray(verification.changed) ? verification.changed : [];
    if (verification.ok === false && changed.length === 0) {
      throw new Error('verifyProtected returned ok=false without confirmed changed paths');
    }
    return { verification, error: null };
  } catch (error) {
    const normalized = environmentError(error, 'PROTECTED_VERIFICATION_FAILED', 'protected path verification failed');
    return { verification: { ok: false, changed: [], error }, error: normalized };
  }
}

function combineProtectionChecks(checks) {
  const changedByPath = new Map();
  let files;
  let error;
  for (const check of checks) {
    for (const item of Array.isArray(check.verification?.changed) ? check.verification.changed : []) {
      const key = String(item?.path || item);
      if (!changedByPath.has(key)) changedByPath.set(key, item);
    }
    if (Array.isArray(check.verification?.files)) files = check.verification.files;
    error ??= check.verification?.error;
  }
  const changed = [...changedByPath.values()];
  return {
    ok: changed.length === 0 && !error && checks.every(check => check.verification?.ok === true),
    changed,
    ...(files ? { files } : {}),
    ...(error ? { error } : {})
  };
}

function within(parent, candidate) {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function appendTail(buffer, chunk, maximum) {
  const next = Buffer.concat([buffer, Buffer.from(chunk)]);
  return next.length <= maximum ? next : next.subarray(next.length - maximum);
}

async function reportPathFromOutput(output, runRoot, reportRoot) {
  let canonicalRunRoot;
  let canonicalReportRoot;
  try {
    [canonicalRunRoot, canonicalReportRoot] = await Promise.all([realpath(runRoot), realpath(reportRoot)]);
  } catch {
    return null;
  }
  for (const line of output.split(/\r?\n/).reverse()) {
    if (!line.trim().startsWith('{')) continue;
    try {
      const parsed = JSON.parse(line);
      if (typeof parsed.report !== 'string') continue;
      if (!path.isAbsolute(parsed.report) && !path.win32.isAbsolute(parsed.report)) continue;
      const absolute = path.resolve(parsed.report);
      if (!within(reportRoot, absolute)) continue;
      const [canonical, info] = await Promise.all([realpath(absolute), stat(absolute)]);
      if (!info.isFile() || !within(canonicalReportRoot, canonical)) continue;
      if (path.basename(canonical) !== '自动测试报告.md') continue;
      return path.relative(canonicalRunRoot, canonical).replaceAll('\\', '/');
    } catch {}
  }
  return null;
}

export async function runEdgeFull({
  runContext,
  timeoutMs = DEFAULT_EDGE_TIMEOUT_MS,
  killGraceMs = 2_000,
  maxOutputBytes = DEFAULT_EDGE_OUTPUT_BYTES,
  spawnProcess = spawn,
  captureProcessTree = defaultCaptureWindowsProcessTree,
  terminateProcessTree = defaultTerminateWindowsProcessTree,
  verifyProcessTreeGone = defaultVerifyWindowsProcessTreeGone
}) {
  if (!runContext || typeof runContext.projectRoot !== 'string' || typeof runContext.runRoot !== 'string') {
    throw cliError('Edge full runContext projectRoot/runRoot are required', 'EDGE_ENVIRONMENT_INVALID');
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw cliError('Edge full timeout must be positive');
  if (!Number.isFinite(killGraceMs) || killGraceMs <= 0) throw cliError('Edge full kill grace must be positive');
  if (!Number.isInteger(maxOutputBytes) || maxOutputBytes < 1) throw cliError('Edge full output bound must be positive');
  if (typeof captureProcessTree !== 'function' || typeof terminateProcessTree !== 'function' || typeof verifyProcessTreeGone !== 'function') {
    throw cliError('Edge process-tree controls are required');
  }
  const workflowsRoot = path.join(runContext.projectRoot, '自动测试报告', 'workflows');
  if (!within(workflowsRoot, runContext.runRoot)) throw cliError('workflow run root is outside the guarded workflows root', 'EDGE_REPORT_ROOT_INVALID');
  const reportRoot = path.join(runContext.runRoot, 'edge-full');
  await runContext.assertWritable(path.join(reportRoot, '.guard'));
  await mkdir(reportRoot, { recursive: true });
  const env = { ...process.env, BATTERY_EDGE_REPORT_ROOT: reportRoot };
  const windows = process.platform === 'win32';
  const executable = EDGE_NODE_EXECUTABLE;
  const argv = [EDGE_RUNNER_SCRIPT, '--mode', 'full', '--report-root', reportRoot];

  return new Promise((resolve, reject) => {
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let parseTail = Buffer.alloc(0);
    let timedOut = false;
    let settled = false;
    let child;
    let graceTimer;
    let terminationInProgress = false;
    const finish = async (exitCode, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(graceTimer);
      const stdoutText = stdout.toString('utf8');
      resolve(Object.freeze({
        command: 'npm run test:edge:full',
        stdout: stdoutText,
        stderr: stderr.toString('utf8'),
        exitCode: Number.isInteger(exitCode) ? exitCode : null,
        signal: typeof signal === 'string' && signal ? signal : null,
        timedOut,
        reportPath: await reportPathFromOutput(parseTail.toString('utf8'), runContext.runRoot, reportRoot)
      }));
    };
    const timer = setTimeout(() => { void (async () => {
      timedOut = true;
      if (windows) {
        terminationInProgress = true;
        const pid = child?.pid;
        let ownedPids = [];
        try {
          const captured = await captureProcessTree({ pid, executable, timeoutMs: killGraceMs });
          if (!Array.isArray(captured) || captured.length === 0
            || captured.some(item => !Number.isInteger(item) || item <= 0)
            || !captured.includes(pid)) {
            throw new Error('process-tree pre-capture must return a non-empty rooted numeric PID set');
          }
          ownedPids = [...new Set(captured)];
          await terminateProcessTree({ pid, executable, ownedPids, timeoutMs: killGraceMs });
          const gone = await verifyProcessTreeGone({ ownedPids, executable, timeoutMs: killGraceMs });
          if (gone !== true) throw new Error('one or more captured workflow PIDs remain');
        } catch (cause) {
          stderr = appendTail(stderr, `\n${cause.message}`, maxOutputBytes);
          settled = true;
          clearTimeout(timer);
          clearTimeout(graceTimer);
          const error = cliError('workflow-owned process tree termination could not be verified', 'EDGE_PROCESS_TREE_TERMINATION_UNVERIFIED');
          error.unsafeProcessResidue = true;
          error.ownedPids = ownedPids;
          error.cause = cause;
          terminationInProgress = false;
          reject(error);
          return;
        }
        terminationInProgress = false;
        await finish(null, 'SIGTERM');
        return;
      }
      try {
        child?.kill('SIGTERM');
        graceTimer = setTimeout(() => { void finish(null, 'SIGTERM'); }, killGraceMs);
      } catch (error) {
        stderr = appendTail(stderr, `\n${error.message}`, maxOutputBytes);
        void finish(null, null);
      }
    })(); }, timeoutMs);
    try {
      child = spawnProcess(executable, argv, {
        cwd: runContext.projectRoot,
        env,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: false
      });
      child.stdout?.on('data', chunk => {
        stdout = appendTail(stdout, chunk, maxOutputBytes);
        parseTail = appendTail(parseTail, chunk, Math.max(65_536, maxOutputBytes));
      });
      child.stderr?.on('data', chunk => { stderr = appendTail(stderr, chunk, maxOutputBytes); });
      child.once('error', error => {
        stderr = appendTail(stderr, error.stack || error.message, maxOutputBytes);
        void finish(null, null);
      });
      child.once('close', (exitCode, signal) => {
        if (!terminationInProgress) void finish(exitCode, signal);
      });
    } catch (error) {
      stderr = appendTail(stderr, error.stack || error.message, maxOutputBytes);
      void finish(null, null);
    }
  });
}

function replayTargetFor(suite) {
  if (suite.replayTarget) return suite.replayTarget;
  return [...(suite.workflows || [])].reverse().find(item => Array.isArray(item.plannedActions) && item.plannedActions.length > 0 && Number.isInteger(item.seed)) ?? null;
}

function reportPayload({ args, runContext, suite, finishedAt, protectedVerification, edgeFull = undefined, error = null }) {
  const target = replayTargetFor(suite);
  let status = suite.status === 'failed' ? 'failed' : 'passed';
  let failure = suite.failure ?? null;
  if (edgeFailed(edgeFull)) {
    status = 'failed';
    failure ??= { workflowId: null, stage: 'edge-full', error: { code: 'EDGE_FULL_FAILED', message: 'npm run test:edge:full failed' } };
  }
  if (error) {
    status = 'failed';
    failure ??= { workflowId: target?.workflowId ?? null, stage: 'orchestration', error };
  }
  if (confirmedProtectionChange(protectedVerification)) {
    status = 'failed';
    failure = {
      ...(failure || {}),
      protection: protectedVerification,
      violation: failure?.violation ?? {
        code: 'PROTECTED_PATH_CHANGED', severity: 'P0', message: 'protected paths changed',
        entityIds: (protectedVerification.changed || []).map(item => String(item?.path || item))
      }
    };
  }
  const workflows = Array.isArray(suite.workflows) && suite.workflows.length > 0
    ? suite.workflows
    : [{ workflowId: error?.code || 'environment', status: 'failed', steps: [], plannedActions: [], lastSuccessfulActionId: null, failure }];
  return {
    schemaVersion: 1,
    plannerVersion: 1,
    runId: runContext.runId,
    mode: args.mode,
    startedAt: suite.startedAt,
    finishedAt,
    status,
    fixtureSha256: target?.fixtureSha256 ?? null,
    protectedVerification,
    seed: target?.seed ?? null,
    plannedActions: target?.plannedActions ?? [],
    workflows,
    failure: status === 'failed' ? failure : null,
    lastSuccessfulActionId: target?.lastSuccessfulActionId ?? null,
    ...(edgeFull !== undefined ? { edgeFull } : {})
  };
}

async function defaultCreateRunContext({ args, projectRoot }) {
  const context = await createWorkflowRunContext({
    projectRoot,
    mode: args.mode,
    protectedPaths: protectedPaths(projectRoot)
  });
  return Object.freeze({ ...context, projectRoot });
}

export async function runWorkflowCli(argv, dependencies = {}) {
  const args = parseWorkflowArgs(argv);
  const projectRoot = path.resolve(dependencies.projectRoot || PROJECT_ROOT);
  const clock = dependencies.clock || (() => new Date());
  const createRunContextImpl = dependencies.createRunContext || defaultCreateRunContext;
  const runSelectedSuitesImpl = dependencies.runSelectedSuites || runSelectedSuites;
  const runReplayImpl = dependencies.runReplay || runReplay;
  const runEdgeFullImpl = dependencies.runEdgeFull || runEdgeFull;
  const writeReportImpl = dependencies.writeReport || writeWorkflowReport;
  const readReplayReportImpl = dependencies.readReplayReport || readReplayReport;
  const runContext = await createRunContextImpl({ args, projectRoot });
  let suite;
  let edgeFull;
  let orchestrationError = null;
  let unsafeProcessResidueError = null;
  const protectionChecks = [];
  const fallbackStartedAt = canonicalIso(clock);

  try {
    if (args.mode === 'replay') {
      const replay = await readReplayReportImpl(args.replayReport);
      const workflow = await runReplayImpl({ replay, runContext, projectRoot, clock });
      suite = {
        status: workflow.status,
        startedAt: workflow.startedAt || fallbackStartedAt,
        finishedAt: workflow.finishedAt || canonicalIso(clock),
        workflows: [workflow],
        replayTarget: workflow,
        ...(workflow.status === 'failed' ? { failure: { workflowId: workflow.workflowId, ...workflow.failure } } : {})
      };
    } else suite = await runSelectedSuitesImpl({ args, runContext, projectRoot, clock });
  } catch (error) {
    orchestrationError = error;
    suite = {
      status: 'failed',
      startedAt: fallbackStartedAt,
      finishedAt: canonicalIso(clock),
      workflows: [],
      failure: { workflowId: null, stage: 'orchestration', error }
    };
  }

  if (!orchestrationError && args.mode === 'full' && suite.status === 'passed') {
    const beforeEdge = await protectionCheck(runContext);
    protectionChecks.push(beforeEdge);
    if (beforeEdge.error) orchestrationError = beforeEdge.error;
    if (!beforeEdge.error && !confirmedProtectionChange(beforeEdge.verification)) {
      try {
        edgeFull = await runEdgeFullImpl({ runContext });
      } catch (error) {
        if (error?.unsafeProcessResidue === true || error?.code === 'EDGE_PROCESS_TREE_TERMINATION_UNVERIFIED') {
          unsafeProcessResidueError = error;
          orchestrationError = error;
        } else orchestrationError = environmentError(error, 'EDGE_ENVIRONMENT_INVALID', 'Edge full execution failed');
      }
      const afterEdge = await protectionCheck(runContext);
      protectionChecks.push(afterEdge);
      if (afterEdge.error) orchestrationError = afterEdge.error;
    }
  }
  if (protectionChecks.length === 0) {
    const finalCheck = await protectionCheck(runContext);
    protectionChecks.push(finalCheck);
    if (finalCheck.error) orchestrationError = finalCheck.error;
  }
  const protectedVerification = combineProtectionChecks(protectionChecks);
  if (unsafeProcessResidueError) {
    unsafeProcessResidueError.exitCode = confirmedProtectionChange(protectedVerification) ? 3 : 2;
    throw unsafeProcessResidueError;
  }
  const finishedAt = canonicalIso(clock);
  const result = reportPayload({ args, runContext, suite, finishedAt, protectedVerification, edgeFull, error: orchestrationError });
  const exitCode = exitCodeForWorkflow({ result, error: orchestrationError });
  let reports;
  try {
    reports = await writeReportImpl({ runContext, result });
  } catch (error) {
    try { error.exitCode = exitCode === 3 ? 3 : 2; } catch {}
    if (error?.exitCode !== (exitCode === 3 ? 3 : 2)) {
      const wrapped = environmentError(error, 'WORKFLOW_REPORT_WRITE_FAILED', 'workflow report write failed');
      wrapped.exitCode = exitCode === 3 ? 3 : 2;
      throw wrapped;
    }
    throw error;
  }
  if (!args.keepWorkdir) await runContext.cleanup({ success: exitCode === 0, keepWorkdir: false });
  return Object.freeze({ exitCode, result, reports });
}

export async function main(argv, {
  runWorkflowCliImpl = runWorkflowCli,
  dependencies = {},
  stdout = process.stdout,
  stderr = process.stderr
} = {}) {
  try {
    const output = await runWorkflowCliImpl(argv, dependencies);
    stdout.write(`${JSON.stringify({
      runId: output.result.runId,
      mode: output.result.mode,
      status: output.result.status,
      report: output.reports.markdownPath
    })}\n`);
    return output.exitCode;
  } catch (error) {
    stderr.write(`${error.code || 'WORKFLOW_CLI_FAILED'}: ${error.message}\n`);
    return [1, 2, 3].includes(error.exitCode) ? error.exitCode : 2;
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2));
}
