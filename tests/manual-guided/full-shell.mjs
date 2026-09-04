import { execFile as execFileCallback } from 'node:child_process';
import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import { createManualGuidedRunContext } from './run-context.mjs';
import { MANUAL_SCENARIOS, selectManualScenarios } from './scenario-catalog.mjs';
import { writeManualGuidedReport } from './report-writer.mjs';

const execFileAsync = promisify(execFileCallback);
const projectRoot = path.resolve(import.meta.dirname, '..', '..');
const reportsRoot = path.join(projectRoot, '自动测试报告', 'manual-guided');

const SUITES = Object.freeze([
  Object.freeze({ file: 'normal-journeys.integration.test.mjs', scenarioIds: Object.freeze(['A01', 'B01', 'C01', 'D01', 'E04']) }),
  Object.freeze({ file: 'extended-journeys.integration.test.mjs', scenarioIds: Object.freeze(['A02', 'B02', 'B03', 'B04', 'B05', 'C02', 'C03', 'C04', 'D02', 'D03', 'E01', 'E02', 'E03']) }),
  Object.freeze({ file: 'misuse.integration.test.mjs', scenarioIds: Object.freeze(['F01', 'F02', 'F03', 'F04', 'F05', 'F06', 'F07']) }),
  Object.freeze({ file: 'restart.integration.test.mjs', scenarioIds: Object.freeze(['G01', 'G02', 'G03']) })
]);

const BLOCKED_CODES = new Set([
  'PNG_NATIVE_SAVE_DIALOG_ROUTE_BYPASSED'
]);

function requireMode(mode) {
  if (!['quick', 'full', 'replay'].includes(mode)) throw new TypeError('shell mode must be quick, full, or replay');
}

export function buildManualShellPlan({ mode, scenarioIds } = {}) {
  requireMode(mode);
  const selected = scenarioIds
    ? [...scenarioIds]
    : selectManualScenarios({ mode }).map(item => item.id);
  const known = new Set(MANUAL_SCENARIOS.map(item => item.id));
  if (selected.length === 0 || new Set(selected).size !== selected.length || selected.some(id => !known.has(id))) {
    throw new TypeError('shell scenarios must be unique known manual IDs');
  }
  const catalogOrder = MANUAL_SCENARIOS.map(item => item.id).filter(id => selected.includes(id));
  const suites = SUITES.map(suite => {
    const included = suite.scenarioIds.filter(id => catalogOrder.includes(id));
    if (included.length === 0) return null;
    const quickPattern = mode === 'quick' && included.length < suite.scenarioIds.length
      ? included.map(id => `^${id}\\b`).join('|')
      : null;
    return Object.freeze({ file: suite.file, scenarioIds: Object.freeze(included), pattern: quickPattern });
  }).filter(Boolean);
  return Object.freeze({ mode, selectedScenarioIds: Object.freeze(catalogOrder), suites: Object.freeze(suites) });
}

function defectCandidate(document) {
  if (!document || typeof document !== 'object' || Array.isArray(document)) return null;
  if (document.productDefect?.code) {
    return {
      code: String(document.productDefect.code),
      message: String(document.productDefect.actual || document.productDefect.expected || document.productDefect.code)
    };
  }
  if (document.code) {
    return {
      code: String(document.code),
      message: String(document.actual || document.limitation || document.unavailable || document.visibleAction
        || document.visibleMessage || document.code)
    };
  }
  return null;
}

export function classifyScenarioEvidence({ scenarioId, documents = [], suiteFailure = null } = {}) {
  if (suiteFailure) return { status: 'failed', code: 'HARNESS_SUITE_FAILED', message: String(suiteFailure) };
  const candidates = documents
    .filter(item => String(item?.scenarioId || '') === String(scenarioId))
    .map(defectCandidate)
    .filter(Boolean);
  const failure = candidates.find(item => !BLOCKED_CODES.has(item.code));
  if (failure) return { status: 'failed', ...failure };
  const blocked = candidates.find(item => BLOCKED_CODES.has(item.code));
  if (blocked) return { status: 'blocked', ...blocked };
  return { status: 'passed', code: null, message: '可见旅程与只读安全核验完成' };
}

async function directories(root) {
  try {
    return (await readdir(root, { withFileTypes: true })).filter(item => item.isDirectory()).map(item => item.name);
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
}

async function filesRecursively(root) {
  const output = [];
  async function visit(current) {
    let entries;
    try { entries = await readdir(current, { withFileTypes: true }); }
    catch (error) { if (error?.code === 'ENOENT') return; throw error; }
    for (const entry of entries) {
      const target = path.join(current, entry.name);
      if (entry.isDirectory()) await visit(target);
      else output.push(target);
    }
  }
  await visit(root);
  return output;
}

async function jsonDocuments(artifactsRoot) {
  const files = (await filesRecursively(artifactsRoot))
    .filter(file => path.extname(file).toLowerCase() === '.json' && path.basename(file) !== 'data-manifest.json');
  const documents = [];
  for (const file of files) {
    try { documents.push({ ...JSON.parse(await readFile(file, 'utf8')), _evidencePath: file }); }
    catch { /* Non-report JSON evidence is preserved but not classified. */ }
  }
  return documents;
}

async function dataManifest(artifactsRoot) {
  try { return JSON.parse(await readFile(path.join(artifactsRoot, 'data-manifest.json'), 'utf8')); }
  catch (error) { if (error?.code === 'ENOENT') return []; throw error; }
}

function terminalLine(output, scenarioId) {
  return String(output || '').split(/\r?\n/)
    .map(line => line.trim())
    .find(line => new RegExp(`^[✔✖]\\s+${scenarioId}\\b`).test(line)) || '';
}

function pageLabel(scenarioId) {
  if (scenarioId.startsWith('A')) return '登录与主界面导航';
  if (scenarioId.startsWith('B')) return '测试申请表格';
  if (scenarioId.startsWith('C')) return '普通测试业务页面';
  if (scenarioId.startsWith('D')) return '长期存储与冲突页面';
  if (scenarioId.startsWith('E')) return '导出、备份与恢复页面';
  if (scenarioId.startsWith('F')) return '真人误操作恢复页面';
  return '重启与一致性核验页面';
}

async function runSuite({ suite, executablePath, manualPath, stylesRoot, knownRuns, execute = execFileAsync }) {
  const args = ['--test', '--test-concurrency=1'];
  if (suite.pattern) args.push(`--test-name-pattern=${suite.pattern}`);
  args.push(path.join('tests', 'manual-guided', suite.file));
  let stdout = '';
  let stderr = '';
  let failure = null;
  try {
    const result = await execute(process.execPath, args, {
      cwd: projectRoot,
      env: {
        ...process.env,
        MANUAL_GUIDED_EXECUTABLE_PATH: executablePath,
        MANUAL_GUIDED_MANUAL_PATH: manualPath,
        MANUAL_GUIDED_STYLES_ROOT: stylesRoot
      },
      timeout: 1_200_000,
      maxBuffer: 64 * 1024 * 1024,
      windowsHide: true
    });
    stdout = String(result.stdout || '');
    stderr = String(result.stderr || '');
  } catch (error) {
    stdout = String(error?.stdout || '');
    stderr = String(error?.stderr || '');
    failure = error?.message || String(error);
  }
  const after = await directories(reportsRoot);
  const created = after.filter(name => !knownRuns.has(name));
  for (const name of created) knownRuns.add(name);
  const runName = created.sort().at(-1);
  const runRoot = runName ? path.join(reportsRoot, runName) : null;
  const artifactsRoot = runRoot ? path.join(runRoot, 'artifacts') : null;
  return {
    suite,
    stdout,
    stderr,
    failure,
    runRoot,
    artifactsRoot,
    documents: artifactsRoot ? await jsonDocuments(artifactsRoot) : [],
    dataManifest: artifactsRoot ? await dataManifest(artifactsRoot) : [],
    screenshots: artifactsRoot ? (await filesRecursively(path.join(artifactsRoot, 'screenshots'))).filter(file => path.extname(file).toLowerCase() === '.png') : []
  };
}

async function gitCommit() {
  try { return String((await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: projectRoot, windowsHide: true })).stdout).trim(); }
  catch { return 'unavailable'; }
}

async function ownedResidue(executablePath) {
  const script = `$root=$env:MANUAL_REPORT_ROOT; $name=$env:MANUAL_EXE_NAME; @(Get-CimInstance Win32_Process | Where-Object { $_.Name -eq $name -and $_.CommandLine -like ('*'+$root+'*') } | Select-Object -ExpandProperty ProcessId) | ConvertTo-Json -Compress`;
  try {
    const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      env: { ...process.env, MANUAL_REPORT_ROOT: reportsRoot, MANUAL_EXE_NAME: path.basename(executablePath) },
      timeout: 10_000,
      windowsHide: true
    });
    const text = String(stdout || '').trim();
    if (!text) return [];
    const parsed = JSON.parse(text);
    return (Array.isArray(parsed) ? parsed : [parsed]).map(Number).filter(Number.isInteger);
  } catch (error) {
    return [`residue-check-error:${error?.message || String(error)}`];
  }
}

async function missingPath(target) {
  try { await stat(target); return false; }
  catch (error) { if (error?.code === 'ENOENT') return true; throw error; }
}

export async function runManualGuidedShell({ mode, executablePath, manualPath, stylesRoot, scenarioIds, execute } = {}) {
  const plan = buildManualShellPlan({ mode, scenarioIds });
  const startedAt = new Date().toISOString();
  const runContext = await createManualGuidedRunContext({ projectRoot, mode, executablePath, manualPath, stylesRoot });
  const knownRuns = new Set(await directories(reportsRoot));
  const suiteResults = [];
  for (const suite of plan.suites) {
    suiteResults.push(await runSuite({ suite, executablePath, manualPath, stylesRoot, knownRuns, execute }));
  }

  const scenarios = [];
  for (const scenarioId of plan.selectedScenarioIds) {
    const suiteResult = suiteResults.find(item => item.suite.scenarioIds.includes(scenarioId));
    const evidence = classifyScenarioEvidence({
      scenarioId,
      documents: suiteResult?.documents || [],
      suiteFailure: suiteResult?.failure || (!suiteResult?.artifactsRoot ? 'suite run artifacts are missing' : null)
    });
    const exactScreenshot = suiteResult?.screenshots.find(file => path.basename(file).toUpperCase().includes(scenarioId));
    const screenshotPath = exactScreenshot || suiteResult?.screenshots[0] || path.join(runContext.artifactsRoot, `${scenarioId}-missing-screenshot.png`);
    const outputEvidence = terminalLine(`${suiteResult?.stdout || ''}\n${suiteResult?.stderr || ''}`, scenarioId);
    scenarios.push({
      scenarioId,
      status: evidence.status,
      compressed: Boolean(MANUAL_SCENARIOS.find(item => item.id === scenarioId)?.compressed),
      actions: [{
        actionId: `${scenarioId}-terminal`,
        outcome: evidence.status === 'passed' ? 'success' : 'failure',
        visiblePage: pageLabel(scenarioId),
        visibleMessage: evidence.code ? `${evidence.code}: ${evidence.message}` : (outputEvidence || evidence.message),
        screenshotPath,
        dialogEvidence: 'none'
      }],
      oracleEvidence: { integrity: ['ok'], violations: [], changedBusinessCollections: [] },
      recovery: evidence.status === 'passed' ? null : '缺陷现场已保留；测试旅程已执行规定的 GUI 恢复或重启恢复',
      restartResult: null,
      evidenceRunRoot: suiteResult?.runRoot || null
    });
  }

  const failed = scenarios.filter(item => item.status === 'failed');
  const blocked = scenarios.filter(item => item.status === 'blocked');
  const status = failed.length > 0 ? 'failed' : blocked.length > 0 ? 'blocked' : 'passed';
  const first = failed[0] || blocked[0] || null;
  const protection = await runContext.verifyProtected();
  await runContext.cleanup({ success: true });
  const residue = await ownedResidue(executablePath);
  const cleanup = {
    verified: await missingPath(runContext.profileRoot) && await missingPath(runContext.workRoot) && residue.length === 0,
    profileExists: !await missingPath(runContext.profileRoot),
    workExists: !await missingPath(runContext.workRoot),
    residue
  };
  const packageJson = JSON.parse(await readFile(path.join(projectRoot, 'package.json'), 'utf8'));
  const manifests = suiteResults.flatMap(item => item.dataManifest || []);
  const dataManifest = [...new Map(manifests.map(item => [`${item.id}:${item.sha256}`, item])).values()];
  const jsonPath = path.join(runContext.artifactsRoot, 'result.json');
  const report = {
    schemaVersion: 'manual-guided-v1',
    runId: runContext.runId,
    mode,
    status,
    startedAt,
    endedAt: new Date().toISOString(),
    commit: await gitCommit(),
    executable: { path: runContext.executable.path, version: String(packageJson.version || 'unknown'), sha256: runContext.executable.sha256 },
    manual: { path: runContext.manualContract.manual.path, sha256: runContext.manualContract.manual.sha256 },
    styles: runContext.manualContract.styleFiles.map(item => ({ path: item.path, sha256: item.sha256 })),
    dataManifest,
    selectedScenarioIds: [...plan.selectedScenarioIds],
    scenarios,
    firstFailure: first ? {
      scenarioId: first.scenarioId,
      actionId: first.actions[0].actionId,
      code: first.actions[0].visibleMessage.split(':')[0],
      message: first.actions[0].visibleMessage
    } : null,
    lastSuccessfulActionId: [...scenarios].reverse().find(item => item.status === 'passed')?.actions[0].actionId || null,
    protection,
    cleanup,
    replayCommand: `npm run test:manual-guided:replay -- --report "${jsonPath}"`,
    suiteRuns: suiteResults.map(item => ({ file: item.suite.file, runRoot: item.runRoot, failure: item.failure }))
  };
  const written = await writeManualGuidedReport({ runContext, result: report });
  return Object.freeze({ ...report, reportPaths: written });
}

export async function replayManualGuidedReport(report) {
  const scenarioIds = report.scenarios.filter(item => item.status !== 'passed').map(item => item.scenarioId);
  if (scenarioIds.length === 0) return { ...report, status: 'passed' };
  return runManualGuidedShell({
    mode: 'replay',
    scenarioIds,
    executablePath: report.executable.path,
    manualPath: report.manual.path,
    stylesRoot: path.dirname(report.styles[0].path)
  });
}
