import { createHash } from 'node:crypto';
import { open, readFile, rename } from 'node:fs/promises';
import path from 'node:path';

const SHA256 = /^[a-f0-9]{64}$/i;
const TERMINAL = new Set(['passed', 'failed', 'blocked']);

function requireValue(condition, message) {
  if (!condition) throw new TypeError(message);
}

export function validateManualGuidedReport(value) {
  requireValue(value && typeof value === 'object' && !Array.isArray(value), 'report object is required');
  requireValue(value.schemaVersion === 'manual-guided-v1', 'schema version is invalid');
  requireValue(['quick', 'full', 'replay'].includes(value.mode), 'report mode is invalid');
  requireValue(['passed', 'failed', 'blocked'].includes(value.status), 'report status is invalid');
  requireValue(typeof value.commit === 'string' && value.commit.trim(), 'commit is required');
  requireValue(value.executable && path.isAbsolute(value.executable.path), 'executable path is invalid');
  requireValue(SHA256.test(value.executable.sha256 || ''), 'executable hash is invalid');
  requireValue(typeof value.executable.version === 'string' && value.executable.version, 'executable version is required');
  requireValue(value.manual && path.isAbsolute(value.manual.path) && SHA256.test(value.manual.sha256 || ''), 'manual hash is invalid');
  requireValue(Array.isArray(value.styles) && value.styles.length === 10, 'ten styles are required');
  requireValue(value.styles.every(item => path.isAbsolute(item.path) && SHA256.test(item.sha256 || '')), 'style hash is invalid');
  requireValue(Array.isArray(value.dataManifest), 'data manifest is required');
  requireValue(Array.isArray(value.selectedScenarioIds) && value.selectedScenarioIds.length > 0, 'selected scenarios are required');
  requireValue(Array.isArray(value.scenarios), 'scenario results are required');
  requireValue(value.scenarios.length === value.selectedScenarioIds.length
    && value.selectedScenarioIds.every(id => value.scenarios.some(item => item.scenarioId === id)), 'omitted scenario result');
  for (const scenario of value.scenarios) {
    requireValue(TERMINAL.has(scenario.status), 'scenario terminal status is required');
    requireValue(typeof scenario.compressed === 'boolean', 'compressed flag is required');
    requireValue(Array.isArray(scenario.actions) && scenario.actions.length > 0, 'scenario actions are required');
    for (const action of scenario.actions) {
      requireValue(typeof action.actionId === 'string' && action.actionId, 'action id is required');
      requireValue(typeof action.visiblePage === 'string' && action.visiblePage, 'visible evidence page is required');
      requireValue(typeof action.visibleMessage === 'string' && action.visibleMessage, 'visible evidence message is required');
      requireValue(typeof action.screenshotPath === 'string' && action.screenshotPath, 'visible evidence screenshot is required');
      if (/^AUTOMATED_DIALOG_ROUTE:/i.test(action.visibleMessage)) {
        requireValue(action.dialogEvidence === 'automated-route', 'automated dialog route cannot be native evidence');
      }
    }
    requireValue(scenario.oracleEvidence && typeof scenario.oracleEvidence === 'object', 'oracle evidence is required');
    const violations = scenario.oracleEvidence.violations ?? [];
    requireValue(Array.isArray(violations) && violations.length === 0, 'oracle safety violation is present');
    const changedBusiness = scenario.oracleEvidence.changedBusinessCollections ?? [];
    requireValue(Array.isArray(changedBusiness), 'changed business collections are invalid');
    if (scenario.actions.some(action => ['cancelled', 'rejected', 'failure', 'failed'].includes(action.outcome))) {
      requireValue(changedBusiness.length === 0, 'cancelled or rejected action changed business state');
    }
  }
  if (value.status === 'failed') {
    requireValue(value.firstFailure && value.firstFailure.scenarioId && value.firstFailure.actionId
      && value.firstFailure.code && value.firstFailure.message, 'first failure is required');
  }
  requireValue(value.protection?.ok === true && Array.isArray(value.protection.changed), 'protection verification is required');
  requireValue(value.cleanup?.verified === true && value.cleanup.profileExists === false
    && value.cleanup.workExists === false && Array.isArray(value.cleanup.residue), 'cleanup verification is required');
  requireValue(typeof value.replayCommand === 'string' && value.replayCommand.trim(), 'replay command is required');
  return true;
}

function markdown(report) {
  const rows = report.scenarios.map(item => {
    const action = item.actions.at(-1);
    return `| ${item.scenarioId} | ${item.status} | ${item.compressed ? '是' : '否'} | ${action.visiblePage}：${action.visibleMessage} |`;
  }).join('\n');
  return `# Electron 黑盒测试报告\n\n- 运行：${report.runId}\n- 模式：${report.mode}\n- 状态：${report.status}\n- EXE SHA-256：${report.executable.sha256}\n\n## 场景与可见证据\n\n| 场景 | 终态 | 时间压缩 | 可见证据 |\n|---|---|---|---|\n${rows}\n\n## 保护与清理\n\n- 保护路径：${report.protection.ok ? '未改变' : '改变'}\n- 清理：${report.cleanup.verified ? '已核验' : '未核验'}\n\n## 重放\n\n\`${report.replayCommand}\`\n`;
}

async function atomicWrite(filePath, contents) {
  const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  const handle = await open(tempPath, 'wx');
  try {
    await handle.writeFile(contents, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  await readFile(tempPath, 'utf8');
  await rename(tempPath, filePath);
  return readFile(filePath, 'utf8');
}

export async function writeManualGuidedReport({ runContext, result } = {}) {
  requireValue(runContext && path.isAbsolute(runContext.artifactsRoot || ''), 'artifacts root is required');
  validateManualGuidedReport(result);
  const jsonPath = path.join(runContext.artifactsRoot, 'result.json');
  const markdownPath = path.join(runContext.artifactsRoot, 'Electron黑盒测试报告.md');
  const json = `${JSON.stringify(result, null, 2)}\n`;
  await atomicWrite(jsonPath, json);
  validateManualGuidedReport(JSON.parse(await readFile(jsonPath, 'utf8')));
  await atomicWrite(markdownPath, markdown(result));
  await readFile(markdownPath, 'utf8');
  return Object.freeze({ jsonPath, markdownPath });
}

export async function readManualGuidedReplay(reportPath) {
  requireValue(typeof reportPath === 'string' && path.isAbsolute(reportPath), 'absolute report path is required');
  const value = JSON.parse(await readFile(reportPath, 'utf8'));
  validateManualGuidedReport(value);
  return value;
}

async function fileHash(filePath) {
  return createHash('sha256').update(await readFile(filePath)).digest('hex');
}

export async function verifyManualGuidedReplayBindings(report) {
  validateManualGuidedReport(report);
  if (await fileHash(report.executable.path) !== report.executable.sha256) {
    throw new Error('executable hash mismatch');
  }
  if (await fileHash(report.manual.path) !== report.manual.sha256) {
    throw new Error('manual hash mismatch');
  }
  for (const style of report.styles) {
    if (await fileHash(style.path) !== style.sha256) throw new Error(`style hash mismatch: ${style.path}`);
  }
  return true;
}
