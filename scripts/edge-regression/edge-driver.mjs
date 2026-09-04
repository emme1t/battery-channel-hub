import { execFile } from 'node:child_process';
import { access, mkdir, readdir } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import { chromium } from 'playwright-core';

const execFileAsync = promisify(execFile);
const DEFAULT_ACTION_TIMEOUT_MS = 30_000;
const DEFAULT_CLEANUP_GRACE_MS = 5_000;

async function listEdgeProcesses() {
  if (process.platform !== 'win32') return [];
  const script = [
    "$items = @(Get-CimInstance Win32_Process -Filter \"Name='msedge.exe'\" | Select-Object ProcessId,WorkingSetSize,CommandLine)",
    'if ($items.Count -eq 0) { Write-Output \'[]\' } else { $items | ConvertTo-Json -Compress }'
  ].join('; ');
  const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    windowsHide: true,
    timeout: 10_000,
    maxBuffer: 4 * 1024 * 1024
  });
  const parsed = JSON.parse(stdout.trim() || '[]');
  return (Array.isArray(parsed) ? parsed : [parsed]).map(item => ({
    pid: Number(item.ProcessId),
    rss: Number(item.WorkingSetSize || 0),
    commandLine: String(item.CommandLine || '')
  })).filter(item => Number.isInteger(item.pid));
}

function edgeError(code, message, details = undefined) {
  const error = new Error(message);
  error.code = code;
  if (details !== undefined) error.details = details;
  return error;
}

function versionParts(value) {
  return value.split('.').map(part => Number(part));
}

function compareVersions(left, right) {
  const a = versionParts(left);
  const b = versionParts(right);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const delta = (a[index] || 0) - (b[index] || 0);
    if (delta !== 0) return delta;
  }
  return 0;
}

async function executableVersion(executablePath) {
  const entries = await readdir(path.dirname(executablePath), { withFileTypes: true });
  const versions = entries
    .filter(entry => entry.isDirectory() && /^\d+(?:\.\d+){3}$/.test(entry.name))
    .map(entry => entry.name)
    .sort(compareVersions);
  if (versions.length === 0) {
    throw edgeError('EDGE_VERSION_UNKNOWN', `无法从 Edge 安装目录识别版本：${path.dirname(executablePath)}`);
  }
  return versions.at(-1);
}

export async function findMicrosoftEdge(env = process.env) {
  const candidates = [
    env.EDGE_EXECUTABLE_PATH,
    env['ProgramFiles(x86)'] && path.join(env['ProgramFiles(x86)'], 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    env.ProgramFiles && path.join(env.ProgramFiles, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'Microsoft', 'Edge', 'Application', 'msedge.exe')
  ].filter(Boolean).map(candidate => path.resolve(candidate));
  for (const executablePath of [...new Set(candidates)]) {
    if (path.basename(executablePath).toLowerCase() !== 'msedge.exe') continue;
    try {
      await access(executablePath);
      return { executablePath, version: await executableVersion(executablePath) };
    } catch (error) {
      if (!['ENOENT', 'EACCES', 'EPERM'].includes(error.code)) throw error;
    }
  }
  throw edgeError('EDGE_NOT_INSTALLED', '未找到本机 Microsoft Edge；自动化不会下载或回退到 Chromium', { candidates });
}

function safeName(value) {
  return String(value || 'scenario').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120) || 'scenario';
}

function allowedRequest(requestUrl, origin) {
  if (requestUrl === 'about:blank' || requestUrl.startsWith('data:') || requestUrl.startsWith('blob:')) return true;
  try {
    return new URL(requestUrl).origin === origin;
  } catch {
    return false;
  }
}

function deadlineError(code, message, stage, timeoutMs) {
  return edgeError(code, message, { stage, timeoutMs });
}

function runBeforeDeadline(callback, deadline, { code, message, stage }) {
  let timer;
  const remainingMs = Math.max(0, Math.ceil(deadline - performance.now()));
  if (remainingMs === 0) return Promise.reject(deadlineError(code, message, stage, 0));
  const operation = Promise.resolve().then(callback);
  operation.catch(() => undefined);
  return Promise.race([
    operation,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(deadlineError(code, message, stage, remainingMs)), remainingMs);
    })
  ]).finally(() => clearTimeout(timer));
}

export async function createEdgeDriver({
  origin,
  token,
  runRoot,
  viewport = { width: 1366, height: 768 },
  headed = false,
  timeoutMs = 30_000,
  actionTimeoutMs = DEFAULT_ACTION_TIMEOUT_MS,
  cleanupGraceMs = DEFAULT_CLEANUP_GRACE_MS,
  environment = process.env
}) {
  const parsedOrigin = new URL(origin);
  if (parsedOrigin.protocol !== 'http:' || parsedOrigin.hostname !== '127.0.0.1') {
    throw edgeError('EDGE_ORIGIN_INVALID', 'Edge 测试只允许 127.0.0.1 HTTP 宿主');
  }
  if (typeof token !== 'string' || token.length < 8) throw edgeError('EDGE_TOKEN_INVALID', 'Edge 测试令牌无效');
  if (!runRoot) throw edgeError('EDGE_RUN_ROOT_REQUIRED', 'Edge 证据目录不能为空');
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw edgeError('EDGE_TIMEOUT_INVALID', 'Edge 场景 deadline 必须为正数');
  if (!Number.isFinite(actionTimeoutMs) || actionTimeoutMs <= 0) throw edgeError('EDGE_TIMEOUT_INVALID', 'Edge locator timeout 必须为正数');
  if (!Number.isFinite(cleanupGraceMs) || cleanupGraceMs <= 0) throw edgeError('EDGE_TIMEOUT_INVALID', 'Edge cleanup grace 必须为正数');
  const edge = await findMicrosoftEdge(environment);
  const preexistingEdgePids = new Set((await listEdgeProcesses()).map(item => item.pid));
  const screenshotsRoot = path.join(path.resolve(runRoot), 'screenshots');
  const tracesRoot = path.join(path.resolve(runRoot), 'traces');
  await Promise.all([mkdir(screenshotsRoot, { recursive: true }), mkdir(tracesRoot, { recursive: true })]);
  const browser = await chromium.launch({
    executablePath: edge.executablePath,
    headless: !headed
  });
  let closePromise = null;

  function closeBrowser() {
    if (!closePromise) {
      const deadline = performance.now() + cleanupGraceMs;
      closePromise = runBeforeDeadline(
        () => browser.close(),
        deadline,
        {
          code: 'EDGE_CLEANUP_TIMEOUT',
          message: `Edge browser close 超过 ${cleanupGraceMs} ms`,
          stage: 'browser-close'
        }
      );
      closePromise.catch(() => undefined);
    }
    return closePromise;
  }

  return Object.freeze({
    executablePath: edge.executablePath,
    version: browser.version() || edge.version,

    async sampleMemory() {
      if (closePromise) throw edgeError('EDGE_DRIVER_CLOSED', 'Edge driver is closed');
      const processes = (await listEdgeProcesses()).filter(item => !preexistingEdgePids.has(item.pid));
      const rendererRss = processes
        .filter(item => /--type=renderer(?:\s|$)/.test(item.commandLine))
        .reduce((total, item) => total + item.rss, 0);
      const edgeRss = processes.reduce((total, item) => total + item.rss, 0);
      const hostRss = process.memoryUsage().rss;
      return {
        hostRss,
        edgeRss,
        rendererRss,
        edgeProcessCount: processes.length,
        aggregateRss: hostRss + edgeRss,
        processes
      };
    },

    async run(name, callback) {
      if (closePromise) throw edgeError('EDGE_DRIVER_CLOSED', 'Edge driver is closed');
      const evidenceName = safeName(name);
      const screenshotPath = path.join(screenshotsRoot, `${evidenceName}.png`);
      const tracePath = path.join(tracesRoot, `${evidenceName}.zip`);
      const consoleErrors = [];
      const pageErrors = [];
      const requestFailures = [];
      const networkViolations = [];
      const started = performance.now();
      const scenarioDeadline = started + timeoutMs;
      let context;
      let page;
      let value;
      let primaryError = null;
      let evidenceError = null;
      let cleanupError = null;
      try {
        context = await runBeforeDeadline(
          () => browser.newContext({ viewport, locale: 'zh-CN' }),
          scenarioDeadline,
          {
            code: 'EDGE_SCENARIO_TIMEOUT',
            message: `Edge 场景 setup 超过 ${timeoutMs} ms`,
            stage: 'context-setup'
          }
        );
        await runBeforeDeadline(async () => {
          await context.addInitScript(({ testToken }) => {
            globalThis.__EDGE_TEST_TOKEN__ = testToken;
          }, { testToken: token });
          await context.route('**/*', async route => {
            const requestUrl = route.request().url();
            if (allowedRequest(requestUrl, parsedOrigin.origin)) await route.continue();
            else {
              networkViolations.push(requestUrl);
              await route.abort('blockedbyclient');
            }
          });
          await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
          page = await context.newPage();
          page.setDefaultTimeout(actionTimeoutMs);
          page.setDefaultNavigationTimeout(actionTimeoutMs);
          page.on('console', message => {
            if (message.type() === 'error') consoleErrors.push(message.text());
          });
          page.on('pageerror', error => pageErrors.push(error.message));
          page.on('crash', () => pageErrors.push('PAGE_CRASHED'));
          page.on('requestfailed', request => requestFailures.push({
            url: request.url(),
            errorText: request.failure()?.errorText || 'unknown request failure'
          }));
        }, scenarioDeadline, {
          code: 'EDGE_SCENARIO_TIMEOUT',
          message: `Edge 场景 setup 超过 ${timeoutMs} ms`,
          stage: 'context-setup'
        });
        value = await runBeforeDeadline(
          () => callback({ page, context, browser }),
          scenarioDeadline,
          {
            code: 'EDGE_SCENARIO_TIMEOUT',
            message: `Edge 场景超过 ${timeoutMs} ms`,
            stage: 'callback'
          }
        );
      } catch (error) {
        primaryError = error;
      }
      const postScenarioDeadline = performance.now() + cleanupGraceMs;
      const evidenceDeadline = primaryError ? postScenarioDeadline : scenarioDeadline;
      if (page) {
        try {
          await runBeforeDeadline(
            () => page.screenshot({ path: screenshotPath, fullPage: true, timeout: actionTimeoutMs }),
            evidenceDeadline,
            {
              code: 'EDGE_EVIDENCE_TIMEOUT',
              message: `Edge screenshot 超过证据 deadline`,
              stage: 'screenshot'
            }
          );
        } catch (error) {
          evidenceError ??= error;
          pageErrors.push(`SCREENSHOT_FAILED: ${error.message}`);
        }
      }
      if (context) {
        try {
          await runBeforeDeadline(
            () => context.tracing.stop({ path: tracePath }),
            evidenceDeadline,
            {
              code: 'EDGE_EVIDENCE_TIMEOUT',
              message: `Edge trace 超过证据 deadline`,
              stage: 'trace'
            }
          );
        } catch (error) {
          evidenceError ??= error;
          pageErrors.push(`TRACE_FAILED: ${error.message}`);
        }
        const contextCleanupDeadline = performance.now() + cleanupGraceMs;
        try {
          await runBeforeDeadline(
            () => context.close(),
            contextCleanupDeadline,
            {
              code: 'EDGE_CLEANUP_TIMEOUT',
              message: `Edge context close 超过 ${cleanupGraceMs} ms`,
              stage: 'context-close'
            }
          );
        } catch (error) {
          cleanupError = error;
          pageErrors.push(`CONTEXT_CLOSE_FAILED: ${error.message}`);
        }
      }

      let error = null;
      if (primaryError) {
        error = { code: primaryError.code || 'EDGE_SCENARIO_FAILED', message: primaryError.message, details: primaryError.details };
      } else if (networkViolations.length > 0) {
        error = { code: 'EDGE_EXTERNAL_REQUEST', message: `阻断 ${networkViolations.length} 个非 localhost 请求` };
      } else if (evidenceError) {
        error = { code: evidenceError.code || 'EDGE_EVIDENCE_FAILED', message: evidenceError.message, details: evidenceError.details };
      } else if (cleanupError) {
        error = { code: cleanupError.code || 'EDGE_CLEANUP_FAILED', message: cleanupError.message, details: cleanupError.details };
      } else if (consoleErrors.length > 0 || pageErrors.length > 0) {
        error = { code: 'EDGE_PAGE_ERROR', message: 'Edge 页面产生控制台错误、脚本错误或崩溃' };
      }
      return {
        ok: error === null,
        value: cloneForResult(value),
        durationMs: Math.round((performance.now() - started) * 100) / 100,
        screenshotPath,
        tracePath,
        consoleErrors,
        pageErrors,
        requestFailures,
        networkViolations,
        error
      };
    },

    async close() {
      return closeBrowser();
    }
  });
}

function cloneForResult(value) {
  if (value === undefined) return undefined;
  return structuredClone(value);
}
