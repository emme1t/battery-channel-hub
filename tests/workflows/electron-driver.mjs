import { execFile } from 'node:child_process';
import { statSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import { _electron as electron } from 'playwright-core';

const DEFAULT_TIMEOUT_MS = 25_000;
const execFileAsync = promisify(execFile);
const EMPTY_DIALOG_ROUTES = Object.freeze({
  openFiles: Object.freeze([]),
  openDirectories: Object.freeze([]),
  saveFiles: Object.freeze([])
});

function parseViewport(value) {
  const match = /^(\d{3,4})x(\d{3,4})$/.exec(String(value || ''));
  if (!match) throw new TypeError('viewport must use WIDTHxHEIGHT');
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (width < 320 || height < 240) throw new RangeError('viewport is too small');
  return Object.freeze({ width, height });
}

function isWithin(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function guardedRunRoot(projectRoot, dataRoot, profileRoot, { packaged = false, reportNamespace = 'workflows' } = {}) {
  const reportsRoot = path.join(projectRoot, '自动测试报告', reportNamespace);
  const dataRelative = path.relative(reportsRoot, dataRoot);
  const profileRelative = path.relative(reportsRoot, profileRoot);
  const dataRunId = dataRelative.split(path.sep)[0];
  const profileRunId = profileRelative.split(path.sep)[0];
  if (!dataRunId || dataRunId === '..' || path.isAbsolute(dataRelative) || !isWithin(reportsRoot, dataRoot)) {
    throw new Error('dataRoot must be inside a guarded workflow run root');
  }
  if (!profileRunId || profileRunId === '..' || path.isAbsolute(profileRelative) || !isWithin(reportsRoot, profileRoot)) {
    throw new Error('profileRoot must be inside a guarded workflow run root');
  }
  if (dataRunId !== profileRunId) throw new Error('dataRoot and profileRoot must belong to the same workflow run');
  const isExactPackagedDataRoot = packaged === true && dataRoot === path.join(profileRoot, 'data');
  if (!isExactPackagedDataRoot && (dataRoot === profileRoot || isWithin(dataRoot, profileRoot) || isWithin(profileRoot, dataRoot))) {
    throw new Error('dataRoot and profileRoot must be separate');
  }
  return path.join(reportsRoot, dataRunId);
}

function normalizeRoutes(routes = EMPTY_DIALOG_ROUTES) {
  if (!routes || typeof routes !== 'object' || Array.isArray(routes)) throw new TypeError('dialog routes must be an object');
  const normalized = {
    openFiles: routes.openFiles ?? [],
    openDirectories: routes.openDirectories ?? [],
    saveFiles: routes.saveFiles ?? []
  };
  if (!Array.isArray(normalized.openFiles) || !normalized.openFiles.every(Array.isArray)) {
    throw new TypeError('openFiles must be an array of file path arrays');
  }
  if (!Array.isArray(normalized.openDirectories) || !normalized.openDirectories.every(Array.isArray)) {
    throw new TypeError('openDirectories must be an array of directory path arrays');
  }
  if (!Array.isArray(normalized.saveFiles)) throw new TypeError('saveFiles must be an array');
  for (const value of [...normalized.openFiles.flat(), ...normalized.openDirectories.flat(), ...normalized.saveFiles]) {
    if (typeof value !== 'string') throw new TypeError('dialog route paths must be strings');
  }
  return structuredClone(normalized);
}

function launchEnvironment(dataRoot, { packaged = false } = {}) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith('BATTERY_CHANNEL_SMOKE')) delete env[key];
    if (key.startsWith('NODE_TEST_')) delete env[key];
  }
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.BATTERY_CHANNEL_DATA_DIR;
  if (!packaged) env.BATTERY_CHANNEL_DATA_DIR = dataRoot;
  env.NODE_NO_WARNINGS = '1';
  return env;
}

function isLocalRequest(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (['file:', 'data:', 'blob:', 'about:', 'devtools:', 'chrome-extension:'].includes(parsed.protocol)) return true;
  if (!['http:', 'https:', 'ws:', 'wss:'].includes(parsed.protocol)) return false;
  return ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(parsed.hostname);
}

function errorText(value) {
  if (value instanceof Error) return value.stack || value.message;
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function delay(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

async function synchronizeNativeWindowViewport(application, page, viewportSize) {
  await application.evaluate(({ BrowserWindow }, size) => {
    const target = BrowserWindow.getAllWindows().find(candidate => !candidate.isDestroyed());
    if (!target) throw new Error('workflow Electron window is unavailable');
    target.setContentSize(size.width, size.height);
  }, viewportSize);
  await page.setViewportSize(viewportSize);
}

async function readWindowGeometry(application, page) {
  const [renderer, nativeContent] = await Promise.all([
    page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight })),
    application.evaluate(({ BrowserWindow }) => {
      const target = BrowserWindow.getAllWindows().find(candidate => !candidate.isDestroyed());
      if (!target) throw new Error('workflow Electron window is unavailable');
      const [width, height] = target.getContentSize();
      return { width, height };
    })
  ]);
  return Object.freeze({
    renderer: Object.freeze(renderer),
    nativeContent: Object.freeze(nativeContent)
  });
}

function normalizedWindowsPath(value) {
  return path.win32.normalize(path.win32.resolve(String(value))).replace(/[\\/]+$/, '').toLowerCase();
}

export function commandLineOwnsProfile(commandLine, profileRoot) {
  const expected = normalizedWindowsPath(profileRoot);
  const source = String(commandLine || '');
  const patterns = [
    /(?:^|\s)"--user-data-dir=([^"]*)"(?=\s|$)/gi,
    /(?:^|\s)--user-data-dir="([^"]*)"(?=\s|$)/gi,
    /(?:^|\s)--user-data-dir=([^\s"]+)(?=\s|$)/gi
  ];
  return patterns.some(pattern => [...source.matchAll(pattern)]
    .some(match => normalizedWindowsPath(match[1]) === expected));
}

export function commandLineOwnsExactExecutableProfile(processInfo, profileRoot, executableBasename) {
  const expectedBasename = path.basename(String(executableBasename || '')).toLowerCase();
  if (!expectedBasename) return false;
  return String(processInfo?.Name || '').toLowerCase() === expectedBasename
    && commandLineOwnsProfile(processInfo?.CommandLine, profileRoot);
}

async function electronPidsForProfile(profileRoot, executableBasename = 'electron.exe') {
  if (process.platform !== 'win32') return [];
  const expectedBasename = path.basename(String(executableBasename));
  const script = "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine } | Select-Object ProcessId, Name, CommandLine | ConvertTo-Json -Compress";
  const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    timeout: 3_000,
    windowsHide: true
  });
  const output = String(stdout).trim();
  if (!output) return [];
  const parsed = JSON.parse(output);
  return (Array.isArray(parsed) ? parsed : [parsed])
    .filter(item => commandLineOwnsExactExecutableProfile(item, profileRoot, expectedBasename))
    .map(item => Number(item.ProcessId))
    .filter(Number.isInteger);
}

async function terminateAndConfirmProfileProcesses(profileRoot, waitMs, processControl) {
  const deadline = Date.now() + waitMs;
  let quietPasses = 0;
  let sawOwnedProcess = false;
  let remaining = [];
  do {
    remaining = await processControl.listOwnedPids(profileRoot);
    if (remaining.length > 0) sawOwnedProcess = true;
    for (const pid of remaining) {
      try { processControl.killPid(pid); } catch (error) {
        if (error?.code !== 'ESRCH') throw error;
      }
    }
    if (remaining.length === 0) {
      quietPasses += 1;
      if (sawOwnedProcess || quietPasses >= 2) return;
    } else {
      quietPasses = 0;
    }
    await delay(75);
  } while (Date.now() < deadline);
  remaining = await processControl.listOwnedPids(profileRoot);
  if (remaining.length > 0) {
    throw new Error(`workflow Electron close timed out; remaining owned PIDs: ${remaining.join(', ')}`);
  }
}

async function confirmProfileProcessesExited(profileRoot, waitMs, processControl) {
  const deadline = Date.now() + waitMs;
  let remaining = [];
  do {
    remaining = await processControl.listOwnedPids(profileRoot);
    if (remaining.length === 0) return;
    await delay(75);
  } while (Date.now() < deadline);
  throw new Error(`workflow Electron close timed out; remaining owned PIDs: ${remaining.join(', ')}`);
}

function unhandledCollectorInitScript() {
  if (window.__workflowUnhandledInstalled) return;
  window.__workflowUnhandledInstalled = true;
  window.addEventListener('unhandledrejection', event => {
    const reason = event.reason;
    const message = reason instanceof Error
      ? (reason.stack || reason.message)
      : typeof reason === 'string'
        ? reason
        : (() => {
            try { return JSON.stringify(reason); } catch { return String(reason); }
          })();
    console.error(`[WORKFLOW_UNHANDLED] ${message}`);
  });
}

async function replaceDialogs(application, routes) {
  await application.evaluate(({ dialog }, configuredRoutes) => {
    const queues = structuredClone(configuredRoutes);
    dialog.showOpenDialog = async options => {
      const directory = options?.properties?.includes('openDirectory');
      const filePaths = (directory ? queues.openDirectories : queues.openFiles).shift() || [];
      return { canceled: filePaths.length === 0, filePaths };
    };
    dialog.showSaveDialog = async () => {
      const filePath = queues.saveFiles.shift() || '';
      return { canceled: !filePath, filePath };
    };
  }, routes);
}

export function createWorkflowElectronDriver({
  projectRoot,
  dataRoot,
  profileRoot,
  viewport,
  reportNamespace = 'workflows',
  timeoutMs = DEFAULT_TIMEOUT_MS,
  packaged = false,
  executablePath,
  launchElectron = options => electron.launch(options),
  processControl: configuredProcessControl,
  deadlineControl: configuredDeadlineControl
}) {
  if (typeof projectRoot !== 'string' || projectRoot.trim() === '') throw new TypeError('projectRoot is required');
  if (typeof dataRoot !== 'string' || dataRoot.trim() === '') throw new TypeError('dataRoot is required');
  if (typeof profileRoot !== 'string' || profileRoot.trim() === '') throw new TypeError('profileRoot is required');
  if (!['workflows', 'manual-guided'].includes(reportNamespace)) {
    throw new TypeError('reportNamespace must be workflows or manual-guided');
  }
  if (typeof packaged !== 'boolean') throw new TypeError('packaged must be a boolean');
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new TypeError('timeoutMs must be positive');
  if (typeof launchElectron !== 'function') throw new TypeError('launchElectron must be a function');
  if (configuredProcessControl !== undefined && (
    !configuredProcessControl ||
    typeof configuredProcessControl.listOwnedPids !== 'function' ||
    typeof configuredProcessControl.killPid !== 'function'
  )) throw new TypeError('processControl must provide listOwnedPids and killPid');
  if (configuredDeadlineControl !== undefined && (
    !configuredDeadlineControl || typeof configuredDeadlineControl.schedule !== 'function'
  )) throw new TypeError('deadlineControl must provide schedule');

  const resolvedProjectRoot = path.resolve(projectRoot);
  const resolvedDataRoot = path.resolve(dataRoot);
  const resolvedProfileRoot = path.resolve(profileRoot);
  let resolvedExecutablePath = null;
  if (packaged) {
    if (typeof executablePath !== 'string' || executablePath.trim() === '') throw new TypeError('packaged executablePath is required');
    if (!path.isAbsolute(executablePath)) throw new TypeError('packaged executablePath must be absolute');
    resolvedExecutablePath = path.resolve(executablePath);
    if (path.extname(resolvedExecutablePath).toLowerCase() !== '.exe') throw new TypeError('packaged executablePath must be an .exe file');
    let executableStats;
    try { executableStats = statSync(resolvedExecutablePath); } catch { throw new TypeError('packaged executablePath must be an existing file'); }
    if (!executableStats.isFile()) throw new TypeError('packaged executablePath must be an existing file');
  } else if (executablePath !== undefined) {
    throw new TypeError('executablePath requires packaged mode');
  }
  const runRoot = guardedRunRoot(resolvedProjectRoot, resolvedDataRoot, resolvedProfileRoot, { packaged, reportNamespace });
  const screenshotsRoot = path.join(runRoot, 'artifacts', 'screenshots');
  const viewportSize = parseViewport(viewport);
  const ownedExecutableBasename = packaged ? path.basename(resolvedExecutablePath) : 'electron.exe';
  const ownedProcessControl = configuredProcessControl || Object.freeze({
    listOwnedPids(profile) { return electronPidsForProfile(profile, ownedExecutableBasename); },
    killPid(pid) { process.kill(pid, 'SIGKILL'); }
  });
  const deadlineControl = configuredDeadlineControl || Object.freeze({
    schedule(_stage, milliseconds, callback) {
      const timer = setTimeout(callback, milliseconds);
      return () => clearTimeout(timer);
    }
  });

  let application = null;
  let activePage = null;
  let dialogRoutes = null;
  let knownPersistedAuditIds = new Set();
  const attachedPages = new WeakSet();
  const preparedPages = new WeakSet();
  const consoleErrors = [];
  const pageErrors = [];
  const unhandledRejections = [];
  const externalRequests = [];
  const mainProcessErrors = [];

  function settleWithDeadline(operation, stage, milliseconds) {
    return new Promise(resolve => {
      let settled = false;
      let cancel = () => undefined;
      const finish = outcome => {
        if (settled) return;
        settled = true;
        cancel();
        resolve(outcome);
      };
      cancel = deadlineControl.schedule(stage, milliseconds, () => finish({ status: 'timeout' }));
      Promise.resolve(operation).then(
        value => finish({ status: 'fulfilled', value }),
        error => finish({ status: 'rejected', error })
      );
    });
  }

  function attachPageEvents(page) {
    if (attachedPages.has(page)) return false;
    attachedPages.add(page);
    page.on('console', message => {
      if (message.type() !== 'error') return;
      const text = message.text();
      consoleErrors.push(text);
      const marker = '[WORKFLOW_UNHANDLED] ';
      if (text.startsWith(marker)) unhandledRejections.push(text.slice(marker.length));
    });
    page.on('pageerror', error => pageErrors.push(errorText(error)));
    page.on('request', request => {
      const url = request.url();
      if (!isLocalRequest(url) && !externalRequests.includes(url)) externalRequests.push(url);
    });
    return true;
  }

  async function installUnhandledCollector(page) {
    await page.evaluate(unhandledCollectorInitScript);
  }

  async function prepareAdditionalPage(page) {
    attachPageEvents(page);
    if (preparedPages.has(page)) return;
    preparedPages.add(page);
    try {
      await page.waitForURL(url => url.protocol === 'file:', { timeout: timeoutMs });
      await page.waitForLoadState('domcontentloaded', { timeout: timeoutMs });
      await installUnhandledCollector(page);
    } catch (error) {
      pageErrors.push(errorText(error));
    }
  }

  async function closeAndReleaseApplication(current, stage) {
    const failures = [];
    const closePromise = Promise.resolve().then(() => current.close());
    void closePromise.catch(() => undefined);
    const closeResult = await settleWithDeadline(closePromise, 'close', Math.min(timeoutMs, 5_000));
    const closeOutcome = closeResult.status === 'fulfilled' ? 'closed' : closeResult.status;
    if (closeResult.status === 'rejected') failures.push(closeResult.error);

    if (closeOutcome === 'timeout') {
      try { current.process().kill(); } catch (error) { failures.push(error); }
    }

    try {
      if (closeOutcome === 'closed') {
        try {
          await confirmProfileProcessesExited(resolvedProfileRoot, 5_000, ownedProcessControl);
        } catch {
          await terminateAndConfirmProfileProcesses(resolvedProfileRoot, 5_000, ownedProcessControl);
        }
      } else {
        await terminateAndConfirmProfileProcesses(resolvedProfileRoot, 5_000, ownedProcessControl);
      }
    } catch (error) {
      failures.push(error);
    }

    if (failures.length > 0) {
      throw new AggregateError(failures, `workflow Electron ${stage} cleanup failed`, { cause: failures[0] });
    }
  }

  async function failLaunchSetup(nextApplication, setupError) {
    if (application === nextApplication) application = null;
    activePage = null;
    try {
      await closeAndReleaseApplication(nextApplication, 'launch setup');
    } catch (cleanupError) {
      throw new AggregateError(
        [setupError, cleanupError],
        'workflow Electron launch setup failed and cleanup failed',
        { cause: setupError }
      );
    }
    throw new Error('workflow Electron launch setup failed', { cause: setupError });
  }

  async function launch() {
    await Promise.all([
      mkdir(resolvedDataRoot, { recursive: true }),
      mkdir(resolvedProfileRoot, { recursive: true }),
      mkdir(screenshotsRoot, { recursive: true })
    ]);
    const launchStartedAt = Date.now();
    const watchdogDelayMs = timeoutMs + Math.min(1_000, Math.max(250, Math.ceil(timeoutMs * 0.05)));
    const launchOptions = {
      args: packaged
        ? [`--user-data-dir=${resolvedProfileRoot}`, '--disable-gpu']
        : ['.', `--user-data-dir=${resolvedProfileRoot}`, '--disable-gpu'],
      cwd: resolvedProjectRoot,
      env: launchEnvironment(resolvedDataRoot, { packaged }),
      timeout: timeoutMs
    };
    if (packaged) launchOptions.executablePath = resolvedExecutablePath;
    const launchPromise = Promise.resolve().then(() => launchElectron(launchOptions));
    void launchPromise.catch(() => undefined);
    const launchResult = await settleWithDeadline(launchPromise, 'launch', watchdogDelayMs);
    if (launchResult.status === 'timeout') {
      void launchPromise.then(async lateApplication => {
        await closeAndReleaseApplication(lateApplication, 'late launch').catch(error => {
          mainProcessErrors.push(errorText(error));
        });
      }, () => undefined);
      try {
        await terminateAndConfirmProfileProcesses(resolvedProfileRoot, Math.min(5_000, Math.max(1_000, timeoutMs)), ownedProcessControl);
      } catch (error) {
        throw new Error(`workflow Electron launch watchdog timed out after ${timeoutMs}ms and cleanup failed`, { cause: error });
      }
      throw new Error(`workflow Electron launch watchdog timed out after ${timeoutMs}ms`);
    }
    if (launchResult.status === 'rejected') {
      const error = launchResult.error;
      await terminateAndConfirmProfileProcesses(resolvedProfileRoot, 5_000, ownedProcessControl);
      if (error?.name === 'TimeoutError' || Date.now() - launchStartedAt >= timeoutMs) {
        throw new Error(`workflow Electron launch watchdog timed out after ${timeoutMs}ms`, { cause: error });
      }
      throw error;
    }
    const nextApplication = launchResult.value;
    application = nextApplication;
    try {
      nextApplication.on('window', nextPage => {
        void prepareAdditionalPage(nextPage);
      });
      for (const existingPage of nextApplication.windows()) attachPageEvents(existingPage);
      nextApplication.on('console', message => {
        if (message.type() === 'error') mainProcessErrors.push(message.text());
      });
      const child = nextApplication.process();
      child.stderr?.on('data', chunk => {
        const message = String(chunk).trim();
        if (message) mainProcessErrors.push(message);
      });
      await nextApplication.context().addInitScript(unhandledCollectorInitScript);
      for (const existingPage of nextApplication.windows()) void prepareAdditionalPage(existingPage);
      const page = await nextApplication.firstWindow({ timeout: timeoutMs });
      activePage = page;
      attachPageEvents(page);
      await synchronizeNativeWindowViewport(nextApplication, page, viewportSize);
      await page.waitForURL(url => url.protocol === 'file:', { timeout: timeoutMs });
      await page.waitForLoadState('domcontentloaded', { timeout: timeoutMs });
      await installUnhandledCollector(page);
      const baselineState = await page.evaluate(async () => window.batteryDesktop?.loadState?.());
      knownPersistedAuditIds = new Set((Array.isArray(baselineState?.auditLogs) ? baselineState.auditLogs : [])
        .map(item => String(item?.id || ''))
        .filter(Boolean));
      if (dialogRoutes) await replaceDialogs(nextApplication, dialogRoutes);
      return page;
    } catch (error) {
      return failLaunchSetup(nextApplication, error);
    }
  }

  async function closeApplication() {
    const current = application;
    application = null;
    activePage = null;
    if (!current) return;
    await closeAndReleaseApplication(current, 'close');
  }

  return Object.freeze({
    async start() {
      if (application) throw new Error('Electron driver is already started');
      await launch();
    },

    async restart() {
      await closeApplication();
      await launch();
    },

    page() {
      if (!activePage || activePage.isClosed()) throw new Error('Electron driver is not started');
      return activePage;
    },

    async windowGeometry() {
      if (!application) throw new Error('Electron driver is not started');
      return readWindowGeometry(application, this.page());
    },

    async resizeViewport(viewport) {
      if (!application) throw new Error('Electron driver is not started');
      const nextViewport = parseViewport(viewport);
      const page = this.page();
      await synchronizeNativeWindowViewport(application, page, nextViewport);
      return readWindowGeometry(application, page);
    },

    async dataRoot() {
      if (!application) throw new Error('Electron driver is not started');
      if (packaged) return resolvedDataRoot;
      const configured = await application.evaluate(() => process.env.BATTERY_CHANNEL_DATA_DIR || '');
      return path.resolve(configured);
    },

    async capturePersistenceBoundary({ timeoutMs: boundaryTimeoutMs = timeoutMs } = {}) {
      const page = this.page();
      const operation = Promise.resolve(page.evaluate(async () => window.batteryDesktop.loadState()));
      void operation.catch(() => undefined);
      const settled = await settleWithDeadline(operation, 'persistence-boundary-save-tail', boundaryTimeoutMs);
      if (settled.status === 'timeout') {
        throw new Error(`[persistence-boundary][save-tail]: absolute deadline ${boundaryTimeoutMs}ms exceeded`);
      }
      if (settled.status === 'rejected') {
        throw new Error('[persistence-boundary][save-tail]: operation failed', { cause: settled.error });
      }
      const state = settled.value;
      const auditIds = Object.freeze((state.auditLogs || []).map(item => String(item?.id || '')).filter(Boolean));
      auditIds.forEach(id => knownPersistedAuditIds.add(id));
      return Object.freeze({
        revision: Number(state.revision || 0),
        auditIds,
        state: Object.freeze(structuredClone(state))
      });
    },

    async waitForPersistenceBarrier({ auditAction, actor, auditTarget, afterAuditIds, timeoutMs: barrierTimeoutMs = timeoutMs } = {}) {
      const page = this.page();
      if (typeof auditAction !== 'string' || auditAction.trim() === '') throw new TypeError('auditAction is required');
      if (actor !== undefined && (typeof actor !== 'string' || actor.trim() === '')) throw new TypeError('actor must be a non-empty string');
      if (!Number.isFinite(barrierTimeoutMs) || barrierTimeoutMs <= 0) throw new TypeError('persistence barrier timeoutMs must be positive');
      const expectedAction = auditAction.trim();
      const expectedTarget = auditTarget?.trim() || '';
      const absoluteDeadline = Date.now() + barrierTimeoutMs;
      let expectedActor = actor?.trim() || '';
      const baselineIds = [...new Set([...knownPersistedAuditIds, ...(afterAuditIds || [])])];
      const barrierError = (stage, auditId, detail, cause) => new Error(
        `[persistence-barrier][${stage}] action="${expectedAction}" actor="${expectedActor || '*'}" auditId="${auditId || '?'}": ${detail}`,
        cause === undefined ? undefined : { cause }
      );
      const remainingMilliseconds = (stage, auditId = '') => {
        const remaining = absoluteDeadline - Date.now();
        if (remaining <= 0) throw barrierError(stage, auditId, `absolute deadline ${barrierTimeoutMs}ms exceeded`);
        return remaining;
      };
      const awaitStage = async (operation, stage, auditId = '') => {
        const guardedOperation = Promise.resolve(operation);
        void guardedOperation.catch(() => undefined);
        const result = await settleWithDeadline(
          guardedOperation,
          `persistence-${stage}`,
          remainingMilliseconds(stage, auditId)
        );
        if (result.status === 'fulfilled') return result.value;
        if (result.status === 'timeout') throw barrierError(stage, auditId, `absolute deadline ${barrierTimeoutMs}ms exceeded`);
        throw barrierError(stage, auditId, 'operation failed', result.error);
      };

      if (!expectedActor) {
        expectedActor = await awaitStage(
          page.evaluate(() => document.getElementById('displayUser')?.textContent?.trim() || ''),
          'actor-inference'
        );
      }

      let rendererHandle;
      let rendererAudit;
      try {
        rendererHandle = await awaitStage(page.waitForFunction(({ action, actorName, target, priorIds }) => {
          const known = new Set(priorIds);
          const rendererAudits = typeof auditLogs === 'undefined' || !Array.isArray(auditLogs) ? [] : auditLogs;
          const match = rendererAudits.find(item => String(item?.id || '') !== ''
            && !known.has(String(item.id))
            && String(item?.action || '') === action
            && (!actorName || String(item?.user ?? item?.actor ?? '') === actorName)
            && (!target || String(item?.target || '') === target));
          return match ? {
            id: String(match.id),
            action: String(match.action || ''),
            actor: String(match?.user ?? match?.actor ?? ''),
            target: String(match?.target || '')
          } : false;
        }, { action: expectedAction, actorName: expectedActor, target: expectedTarget, priorIds: baselineIds }, {
          timeout: remainingMilliseconds('renderer-audit')
        }), 'renderer-audit');
        rendererAudit = typeof rendererHandle?.jsonValue === 'function'
          ? await awaitStage(rendererHandle.jsonValue(), 'renderer-audit')
          : rendererHandle;
      } catch (error) {
        if (String(error?.message || '').startsWith('[persistence-barrier]')) throw error;
        throw barrierError('renderer-audit', '', 'operation failed', error);
      } finally {
        if (typeof rendererHandle?.dispose === 'function') void rendererHandle.dispose().catch(() => undefined);
      }
      if (!rendererAudit || typeof rendererAudit.id !== 'string' || rendererAudit.id === ''
        || rendererAudit.action !== expectedAction
        || (expectedActor && rendererAudit.actor !== expectedActor)
        || (expectedTarget && rendererAudit.target !== expectedTarget)) {
        throw barrierError('renderer-audit', rendererAudit?.id, 'returned malformed or mismatched audit evidence');
      }

      const state = await awaitStage(
        page.evaluate(async () => window.batteryDesktop.loadState()),
        'save-tail',
        rendererAudit.id
      );
      remainingMilliseconds('persisted-audit', rendererAudit.id);
      const audits = Array.isArray(state?.auditLogs) ? state.auditLogs : [];
      const audit = audits.find(item => String(item?.id || '') === rendererAudit.id);
      if (!audit || String(audit?.action || '') !== expectedAction
        || (expectedActor && String(audit?.user ?? audit?.actor ?? '') !== expectedActor)
        || (expectedTarget && String(audit?.target || '') !== expectedTarget)) {
        throw barrierError('persisted-audit', rendererAudit.id, 'exact renderer audit missing or mismatched after save-tail');
      }
      knownPersistedAuditIds.add(rendererAudit.id);
      return Object.freeze({
        revision: Number(state?.revision || 0),
        audit: Object.freeze(structuredClone(audit)),
        state: Object.freeze(structuredClone(state))
      });
    },

    async configureDialogs(routes) {
      if (!application) throw new Error('Electron driver is not started');
      const normalizedRoutes = normalizeRoutes(routes);
      await replaceDialogs(application, normalizedRoutes);
      dialogRoutes = normalizedRoutes;
    },

    async viewEvidence(view) {
      const supported = new Set(['request', 'sample', 'channel', 'records', 'audits', 'channels', 'todo']);
      if (!supported.has(view)) throw new TypeError(`unsupported paged view: ${view}`);
      const evidence = await this.page().evaluate(selectedView => {
        const configs = {
          request: { row: '[data-testid="legacy-request-row"]', pager: '[data-legacy-action="request-next"]', maxRows: 50 },
          sample: { row: '[data-testid="legacy-sample-row"]', pager: '[data-legacy-action="sample-next"]', maxRows: 25 },
          channel: { row: '[data-testid="legacy-channel-option"]', pager: '[data-legacy-action="channel-next"]', maxRows: 40 },
          records: { row: '[data-testid="bounded-record-row"]', pager: '[data-bounded-action="page"][data-view="records"][data-direction="next"]', maxRows: 50 },
          audits: { row: '[data-testid="bounded-audit-row"]', pager: '[data-bounded-action="page"][data-view="audits"][data-direction="next"]', maxRows: 50 },
          channels: { row: '[data-testid="bounded-channel-row"]', pager: '[data-bounded-action="page"][data-view="channels"][data-direction="next"]', maxRows: 50 },
          todo: { row: '.dashboard-todo', pager: '[data-dashboard-action="todo-next"]', maxRows: 10 }
        };
        const config = configs[selectedView];
        const isVisible = element => {
          if (!(element instanceof Element) || element.getClientRects().length === 0) return false;
          for (let node = element; node instanceof Element; node = node.parentElement) {
            const style = getComputedStyle(node);
            if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false;
          }
          return true;
        };
        const decode = value => {
          try { return decodeURIComponent(value || ''); } catch { return String(value || ''); }
        };
        const rows = [...document.querySelectorAll(config.row)].filter(isVisible);
        const identity = row => {
          if (selectedView === 'request') return decode(row.querySelector('[data-request-no]')?.dataset.requestNo) || row.querySelector('strong')?.textContent?.trim() || '';
          if (selectedView === 'sample') return decode(row.querySelector('[data-sample-id]')?.dataset.sampleId) || row.querySelector('strong')?.textContent?.trim() || '';
          if (selectedView === 'channel' || selectedView === 'channels') return decode(row.querySelector('[data-channel-key]')?.dataset.channelKey) || row.textContent.trim();
          if (selectedView === 'records' || selectedView === 'todo') return String(row.querySelector('[data-record-index]')?.dataset.recordIndex ?? '').trim() || row.textContent.trim();
          return row.textContent.replace(/\s+/g, ' ').trim();
        };
        const pagerButton = document.querySelector(config.pager);
        const pager = pagerButton?.closest('.legacy-pager');
        const match = String(pager?.querySelector('span')?.textContent || '').match(/第\s*(\d+)\s*\/\s*(\d+)\s*页/);
        if (!match) throw new Error(`paged view ${selectedView} does not expose a readable pager`);
        const page = Number(match[1]);
        const pageCount = Number(match[2]);
        const first = rows.length ? identity(rows[0]) : null;
        const last = rows.length ? identity(rows.at(-1)) : null;
        const rowCount = rows.length;
        return {
          view: selectedView,
          page,
          pageCount,
          rowCount,
          first,
          last,
          maxRows: config.maxRows,
          domWithinLimit: rowCount <= config.maxRows,
          token: `${selectedView}:${page}/${pageCount}:${rowCount}:${first || ''}:${last || ''}`
        };
      }, view);
      return Object.freeze(evidence);
    },

    async uiProjection() {
      const page = this.page();
      const projection = await page.evaluate(async () => {
        const state = await window.batteryDesktop.loadState();
        const collection = key => Array.isArray(state?.[key]) ? state[key] : [];
        const records = collection('records');
        const summary = {
          revision: Number(state?.revision || 0),
          devices: collection('deviceProfiles').length,
          channels: collection('channels').length,
          requests: collection('requests').length,
          samples: collection('samples').length,
          records: records.length,
          storageRecords: collection('storageRecords').length,
          audits: collection('auditLogs').length,
          journalEntries: collection('formChangeJournal').length,
          runningRecords: records.filter(record => record?.status === 'running').length,
          reservedRecords: records.filter(record => record?.status === 'reserved').length,
          activeRecords: records.filter(record => ['running', 'reserved'].includes(record?.status)).length
        };
        const isVisible = element => {
          if (!(element instanceof Element) || element.getClientRects().length === 0) return false;
          for (let node = element; node instanceof Element; node = node.parentElement) {
            const style = getComputedStyle(node);
            if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false;
          }
          return true;
        };
        const visibleElements = selector => [...document.querySelectorAll(selector)].filter(isVisible);
        const decode = value => {
          try { return decodeURIComponent(value || ''); } catch { return String(value || ''); }
        };
        const unique = (items, key) => [...new Map(items.map(item => [item[key], item])).values()];
        const recordIndexes = unique([
          ...visibleElements('[data-testid="bounded-record-row"] [data-record-index]'),
          ...visibleElements('[data-reserved-row]')
        ].map(element => ({ index: Number(element.dataset.recordIndex ?? element.dataset.reservedRow) }))
          .filter(item => Number.isInteger(item.index)), 'index');
        const sampleIds = new Set(visibleElements('[data-sample-id]').map(element => decode(element.dataset.sampleId)).filter(Boolean));
        const channelKeys = new Set(visibleElements('[data-channel-key]').map(element => decode(element.dataset.channelKey)).filter(Boolean));
        const todoIndexes = unique(visibleElements('.dashboard-todo [data-record-index]')
          .map(element => ({ index: Number(element.dataset.recordIndex) }))
          .filter(item => Number.isInteger(item.index)), 'index');
        const storageIds = [...new Set(visibleElements('[data-testid="storage-sample-row"] [data-storage-id]')
          .map(element => decode(element.dataset.storageId)).filter(Boolean))];
        const samplesById = new Map(collection('samples').map(item => [String(item.id), item]));
        const channelsByKey = new Map(collection('channels').map(item => [String(item.key), item]));
        const storageById = new Map(collection('storageRecords').map(item => [String(item.id), item]));
        const visible = {
          records: recordIndexes.map(({ index }) => records[index]).filter(Boolean).map(item => ({ id: String(item.id), status: String(item.status) })),
          samples: [...sampleIds].map(id => samplesById.get(id)).filter(Boolean).map(item => ({ id: String(item.id), status: String(item.status) })),
          channels: [...channelKeys].map(key => channelsByKey.get(key)).filter(Boolean).map(item => ({ key: String(item.key), state: String(item.state) })),
          todos: todoIndexes.map(({ index }) => records[index]).filter(item => item?.status === 'reserved').map(item => ({ id: String(item.id), status: String(item.status) })),
          storageRecords: storageIds.map(id => storageById.get(id)).filter(Boolean).map(item => ({ id: String(item.id), status: String(item.status) }))
        };
        const documentWidth = Math.max(document.documentElement.scrollWidth, document.body?.scrollWidth || 0);
        const visibleRoot = ['login', 'app'].map(id => document.getElementById(id)).find(isVisible);
        return {
          currentPage: document.querySelector('.page.active')?.id || document.querySelector('.nav.active')?.dataset.page || 'dashboard',
          summary,
          visible,
          dom: {
            nodes: document.getElementsByTagName('*').length,
            channelCards: visibleElements('[data-testid="bounded-channel-card"]').length,
            recordRows: visibleElements('[data-testid="bounded-record-row"]').length,
            sampleRows: visibleElements('[data-testid="legacy-sample-row"]').length,
            todoItems: visibleElements('.dashboard-todo').length
          },
          horizontalOverflow: documentWidth > window.innerWidth + 1,
          horizontalOverflowPixels: Math.max(0, documentWidth - window.innerWidth),
          whiteScreen: !visibleRoot || visibleRoot.getBoundingClientRect().width < 1 || visibleRoot.textContent.trim().length === 0
        };
      });
      return Object.freeze({
        projection: Object.freeze({
          currentPage: projection.currentPage,
          summary: Object.freeze(projection.summary),
          visible: Object.freeze({
            records: Object.freeze(projection.visible.records),
            samples: Object.freeze(projection.visible.samples),
            channels: Object.freeze(projection.visible.channels),
            todos: Object.freeze(projection.visible.todos),
            storageRecords: Object.freeze(projection.visible.storageRecords)
          })
        }),
        dom: Object.freeze(projection.dom),
        renderedChannelCards: projection.dom.channelCards,
        horizontalOverflow: projection.horizontalOverflow,
        horizontalOverflowPixels: projection.horizontalOverflowPixels,
        whiteScreen: projection.whiteScreen,
        consoleErrors: Object.freeze([...consoleErrors]),
        pageErrors: Object.freeze([...pageErrors]),
        unhandledRejections: Object.freeze([...unhandledRejections]),
        externalRequests: Object.freeze([...externalRequests]),
        mainProcessErrors: Object.freeze([...mainProcessErrors])
      });
    },

    async screenshot(name) {
      if (typeof name !== 'string' || name.trim() === '') throw new TypeError('screenshot name is required');
      const trimmed = name.trim();
      if (path.basename(trimmed) !== trimmed || trimmed === '.' || trimmed === '..') {
        throw new Error('screenshot name must not contain a path');
      }
      const fileName = trimmed.toLowerCase().endsWith('.png') ? trimmed : `${trimmed}.png`;
      const target = path.join(screenshotsRoot, fileName);
      if (!isWithin(runRoot, target)) throw new Error('screenshot target escaped the guarded run root');
      await mkdir(screenshotsRoot, { recursive: true });
      await this.page().screenshot({ path: target, fullPage: true });
      return target;
    },

    async close() {
      await closeApplication();
    }
  });
}
