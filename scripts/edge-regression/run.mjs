import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { SCENARIOS } from '../../tests/edge/scenario-manifest.mjs';
import { createScenarioResult } from '../../tests/edge/result-contract.mjs';
import { P0_RUNNERS } from '../../tests/edge/scenarios/p0.mjs';
import { P1_RUNNERS } from '../../tests/edge/scenarios/p1.mjs';
import { P2_RUNNERS } from '../../tests/edge/scenarios/p2.mjs';
import { ST_RUNNERS } from '../../tests/edge/scenarios/st.mjs';
import { runContinuousEdgeStability } from './continuous-stability.mjs';
import { createElectronEvidenceDriver } from './electron-driver.mjs';
import { createMainEdgeEvidenceDriver } from './main-edge-driver.mjs';
import { createNodeEvidenceDriver } from './node-driver.mjs';
import { writeRunReport } from './report-writer.mjs';
import { createRunContext } from './run-context.mjs';

const execFileAsync = promisify(execFile);
const RUNNERS = Object.freeze({ ...P0_RUNNERS, ...P1_RUNNERS, ...ST_RUNNERS, ...P2_RUNNERS });

function blocked(definition, code, message) {
  return createScenarioResult(definition, {
    status: 'BLOCKED',
    assertions: [{ key: code.toLowerCase(), ok: false, message }],
    error: { code, message }
  });
}

async function gitEnvironment(projectRoot) {
  const run = async args => (await execFileAsync('git', args, { cwd: projectRoot, windowsHide: true })).stdout.trim();
  const [branch, gitSha] = await Promise.all([
    run(['branch', '--show-current']).catch(() => ''),
    run(['rev-parse', 'HEAD']).catch(() => '')
  ]);
  return { branch, gitSha, projectRoot, node: process.version, platform: `${process.platform}-${process.arch}` };
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

async function defaultPrepare(projectRoot, mode, reportRootOverride) {
  return createRunContext({ projectRoot, mode, reportRootOverride, protectedPaths: protectedPaths(projectRoot) });
}

function createExecutionContext({ projectRoot, runContext, mode, headed }) {
  const node = createNodeEvidenceDriver({ projectRoot, runRoot: runContext.runRoot });
  const electron = createElectronEvidenceDriver({ projectRoot, runRoot: runContext.runRoot });
  const edge = createMainEdgeEvidenceDriver({ projectRoot, runRoot: runContext.runRoot });
  let stabilityPromise;

  const context = {
    relativeEvidence(value) {
      return path.relative(runContext.runRoot, path.resolve(value)).replaceAll('\\', '/');
    },

    async runEvidence(check, definition) {
      if (check.kind === 'node') {
        return node.runTestSuite({
          key: check.key,
          files: check.files.map(file => path.resolve(projectRoot, file)),
          namePattern: check.namePattern || ''
        });
      }
      if (check.kind === 'electron') return electron.runSmoke(check);
      if (check.kind === 'edge') return edge.runProbe({ ...check, headed }, definition);
      return { ok: false, error: { code: 'EVIDENCE_KIND_UNSUPPORTED', message: `不支持证据类型 ${check.kind}` } };
    },

    async getStabilityEvidence() {
      if (!stabilityPromise) {
        stabilityPromise = runContinuousEdgeStability({
          projectRoot,
          runRoot: runContext.runRoot,
          mode,
          headed
        });
      }
      return stabilityPromise;
    }
  };
  return Object.freeze(context);
}

export function exitCodeFor(result) {
  if (result?.protection?.ok === false) return 1;
  return (result?.scenarios || []).some(item => item.status !== 'PASS' && item.error?.code !== 'SCENARIO_FILTERED') ? 1 : 0;
}

export async function runRegression({
  mode = 'quick',
  only = [],
  headed = false,
  keepWorkdir = false,
  reportRootOverride = null,
  projectRoot = path.resolve(fileURLToPath(new URL('../..', import.meta.url))),
  dependencies = {}
} = {}) {
  if (!['quick', 'full'].includes(mode)) throw new TypeError('mode must be quick or full');
  const selected = new Set(Array.isArray(only) ? only : String(only).split(',').filter(Boolean));
  const now = dependencies.now || (() => new Date());
  const startedDate = now();
  const prepare = dependencies.prepare || ((...args) => defaultPrepare(...args));
  const runContext = await prepare(projectRoot, mode, reportRootOverride);
  const environment = await (dependencies.environment || gitEnvironment)(projectRoot);
  const executionContext = dependencies.executeScenario ? null : createExecutionContext({ projectRoot, runContext, mode, headed });
  const results = [];
  let fatal = null;

  for (const definition of SCENARIOS) {
    if (selected.size > 0 && !selected.has(definition.id)) {
      results.push(blocked(definition, 'SCENARIO_FILTERED', '当前 --only 运行未选择此场景'));
      continue;
    }
    if (fatal) {
      results.push(blocked(definition, 'RUN_ABORTED', `前置安全失败：${fatal.message}`));
      continue;
    }
    try {
      const result = dependencies.executeScenario
        ? await dependencies.executeScenario(definition, runContext)
        : await RUNNERS[definition.id](executionContext);
      results.push(result);
    } catch (error) {
      results.push(createScenarioResult(definition, {
        status: 'FAIL',
        assertions: [{ key: 'scenario-exception', ok: false, message: error.message }],
        error: { code: error.code || 'SCENARIO_EXCEPTION', message: error.message, details: error.details }
      }));
      if (['PATH_PROTECTED_WRITE', 'PATH_ESCAPE', 'FIXTURE_MASTER_CHANGED'].includes(error.code)) fatal = error;
    }
  }

  const protection = await runContext.verifyProtected();
  const finishedDate = now();
  const result = {
    schemaVersion: 1,
    runId: runContext.runId,
    mode,
    coverage: mode === 'quick' ? 'FAST_COVERAGE' : 'FULL',
    startedAt: startedDate.toISOString(),
    finishedAt: finishedDate.toISOString(),
    durationMs: Math.max(0, finishedDate.getTime() - startedDate.getTime()),
    scenarios: results,
    environment,
    protection
  };
  const reports = await (dependencies.writeReport || (payload => writeRunReport(payload)))({ runRoot: runContext.runRoot, result });
  await runContext.cleanup({ success: exitCodeFor(result) === 0, keepWorkdir });
  return { ...result, reports };
}

export function parseEdgeArgs(argv) {
  const options = { mode: 'quick', only: [], headed: false, keepWorkdir: false, reportRootOverride: null };
  const seen = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (seen.has(argument)) throw new Error(`重复参数：${argument}`);
    seen.add(argument);
    if (argument === '--mode') {
      if (!argv[index + 1] || argv[index + 1].startsWith('--')) throw new Error('--mode 缺少值');
      options.mode = argv[++index];
    } else if (argument === '--only') {
      if (!argv[index + 1] || argv[index + 1].startsWith('--')) throw new Error('--only 缺少值');
      options.only = String(argv[++index]).split(',').filter(Boolean);
    } else if (argument === '--report-root') {
      if (!argv[index + 1] || argv[index + 1].startsWith('--')) throw new Error('--report-root 缺少值');
      options.reportRootOverride = argv[++index];
    } else if (argument === '--headed') options.headed = true;
    else if (argument === '--keep-workdir') options.keepWorkdir = true;
    else throw new Error(`未知参数：${argument}`);
  }
  return options;
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : '';
if (invokedPath === import.meta.url) {
  try {
    const result = await runRegression(parseEdgeArgs(process.argv.slice(2)));
    const counts = Object.groupBy(result.scenarios, item => item.status);
    process.stdout.write(`${JSON.stringify({
      runId: result.runId,
      mode: result.mode,
      coverage: result.coverage,
      pass: counts.PASS?.length || 0,
      fail: counts.FAIL?.length || 0,
      blocked: counts.BLOCKED?.length || 0,
      report: result.reports.markdownPath
    })}\n`);
    process.exitCode = exitCodeFor(result);
  } catch (error) {
    process.stderr.write(`${error.code || 'EDGE_REGRESSION_FAILED'}: ${error.message}\n`);
    process.exitCode = 1;
  }
}
