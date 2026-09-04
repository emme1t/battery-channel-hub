import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { access, mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import {
  commandLineOwnsExactExecutableProfile,
  commandLineOwnsProfile,
  createWorkflowElectronDriver
} from './electron-driver.mjs';
import { seedWorkflowFixture } from './fixtures.mjs';
import { checkWorkflowInvariants } from './invariants.mjs';
import { createWorkflowRunContext } from './run-context.mjs';
import { readWorkflowSnapshot } from './state-probe.mjs';

const projectRoot = path.resolve(import.meta.dirname, '..', '..');
const fixedClock = () => new Date('2026-08-22T08:00:00.000Z');
let runSequence = 40;
const execFileAsync = promisify(execFile);

async function workflowContext() {
  const value = runSequence++;
  const context = await createWorkflowRunContext({
    projectRoot,
    mode: 'quick',
    now: fixedClock,
    randomBytes: () => Buffer.from([
      (process.pid >>> 16) & 0xff,
      (process.pid >>> 8) & 0xff,
      process.pid & 0xff,
      value
    ])
  });
  return context;
}

function driverFor(context, viewport, profileName = viewport, timeoutMs = 25_000) {
  return createWorkflowElectronDriver({
    projectRoot,
    dataRoot: context.dataRoot,
    profileRoot: path.join(context.profileRoot, profileName),
    viewport,
    timeoutMs
  });
}

async function cleanupDriversThenRuns(drivers, contexts) {
  const failures = [];
  const closed = await Promise.allSettled(drivers.map((driver, index) => bounded(`close driver ${index}`, driver.close(), 12_000)));
  closed.forEach((result, index) => {
    if (result.status === 'rejected') failures.push(new Error(`driver ${index} close failed`, { cause: result.reason }));
  });
  const removed = await Promise.allSettled(contexts.map(context => rm(context.runRoot, { recursive: true, force: true })));
  removed.forEach((result, index) => {
    if (result.status === 'rejected') failures.push(new Error(`run ${index} cleanup failed`, { cause: result.reason }));
  });
  if (failures.length) throw new AggregateError(failures, 'workflow Electron cleanup failed');
}

async function electronPidsForProfile(profileRoot) {
  const script = "Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'electron.exe' -and $_.CommandLine } | Select-Object ProcessId, CommandLine | ConvertTo-Json -Compress";
  const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    timeout: 3_000,
    windowsHide: true
  });
  const output = String(stdout).trim();
  if (!output) return [];
  const parsed = JSON.parse(output);
  return (Array.isArray(parsed) ? parsed : [parsed])
    .filter(item => commandLineOwnsProfile(item?.CommandLine, profileRoot))
    .map(item => Number(item.ProcessId))
    .filter(Number.isInteger);
}

async function bounded(label, operation, timeoutMs = 5_000) {
  let timer;
  try {
    return await Promise.race([
      operation,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out`)), timeoutMs);
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function fakePage() {
  let closed = false;
  let viewport = { width: 800, height: 600 };
  return {
    on() {},
    async evaluate() {},
    async setViewportSize(size) { viewport = { ...size }; },
    viewportSize: () => ({ ...viewport }),
    async waitForURL() {},
    async waitForLoadState() {},
    isClosed: () => closed,
    markClosed: () => { closed = true; }
  };
}

function fakeNativeWindowEvaluator(initialSize = { width: 800, height: 600 }) {
  let contentSize = { ...initialSize };
  const nativeWindow = {
    isDestroyed: () => false,
    setContentSize(width, height) { contentSize = { width, height }; },
    getContentSize: () => [contentSize.width, contentSize.height]
  };
  const BrowserWindow = { getAllWindows: () => [nativeWindow] };
  return async (callback, argument) => callback({ BrowserWindow }, argument);
}

function fakeApplication({ close, firstWindow } = {}) {
  const page = fakePage();
  return {
    on() {},
    evaluate: fakeNativeWindowEvaluator(),
    windows: () => [page],
    context: () => ({ addInitScript: async () => undefined }),
    process: () => ({ stderr: null, kill() {} }),
    firstWindow: firstWindow || (async () => page),
    close: close || (async () => { page.markClosed(); })
  };
}

function fakeProcessRuntime(initialPids) {
  const ownedPids = new Set(initialPids);
  return {
    ownedPids,
    control: {
      listOwnedPids: async () => [...ownedPids],
      killPid(pid) { ownedPids.delete(pid); }
    }
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function controlledDeadlines() {
  const scheduled = [];
  const waiters = new Map();
  return {
    scheduled,
    control: {
      schedule(stage, milliseconds, callback) {
        const entry = { stage, milliseconds, callback, cancelled: false };
        scheduled.push(entry);
        for (const resolve of waiters.get(stage) || []) resolve(entry);
        waiters.delete(stage);
        return () => { entry.cancelled = true; };
      }
    },
    async waitFor(stage) {
      const existing = scheduled.find(item => item.stage === stage && !item.cancelled);
      if (existing) return existing;
      return new Promise(resolve => {
        waiters.set(stage, [...(waiters.get(stage) || []), resolve]);
      });
    },
    fire(stage) {
      const entry = scheduled.find(item => item.stage === stage && !item.cancelled);
      assert.ok(entry, `missing active ${stage} deadline`);
      entry.callback();
    }
  };
}

function persistenceBarrierApplication({ oldAudit, newAudit, persistenceDelayMs = 40, actorInference }) {
  let closed = false;
  let rendererAudits = [structuredClone(oldAudit)];
  let persistedState = { revision: 7, auditLogs: [structuredClone(oldAudit)] };
  let persistenceTail = Promise.resolve();
  const browserWindow = {
    __workflowUnhandledInstalled: false,
    addEventListener() {},
    batteryDesktop: {
      async loadState() {
        await persistenceTail;
        return structuredClone(persistedState);
      }
    }
  };
  const browserDocument = {
    getElementById(id) {
      if (id !== 'displayUser') return null;
      return actorInference === undefined
        ? { textContent: '' }
        : { textContent: { trim: () => actorInference } };
    }
  };
  async function withBrowserGlobals(callback, argument) {
    const previousWindow = globalThis.window;
    const previousAudits = globalThis.auditLogs;
    const previousDocument = globalThis.document;
    globalThis.window = browserWindow;
    globalThis.auditLogs = rendererAudits;
    globalThis.document = browserDocument;
    try {
      return await callback(argument);
    } finally {
      if (previousWindow === undefined) delete globalThis.window;
      else globalThis.window = previousWindow;
      if (previousAudits === undefined) delete globalThis.auditLogs;
      else globalThis.auditLogs = previousAudits;
      if (previousDocument === undefined) delete globalThis.document;
      else globalThis.document = previousDocument;
    }
  }
  const page = {
    on() {},
    async evaluate(callback, argument) { return withBrowserGlobals(callback, argument); },
    async waitForFunction(callback, argument, options = {}) {
      const deadline = Date.now() + (options.timeout || 1_000);
      do {
        const value = await withBrowserGlobals(callback, argument);
        if (value) return {
          async jsonValue() { return structuredClone(value); },
          async dispose() {}
        };
        await new Promise(resolve => setTimeout(resolve, 5));
      } while (Date.now() < deadline);
      throw new Error(`page.waitForFunction timed out after ${options.timeout || 1_000}ms`);
    },
    async setViewportSize(size) {
      browserWindow.innerWidth = size.width;
      browserWindow.innerHeight = size.height;
    },
    async waitForURL() {},
    async waitForLoadState() {},
    isClosed: () => closed
  };
  const application = {
    on() {},
    evaluate: fakeNativeWindowEvaluator(),
    windows: () => [page],
    context: () => ({ addInitScript: async () => undefined }),
    process: () => ({ stderr: null, kill() {} }),
    firstWindow: async () => page,
    close: async () => { closed = true; }
  };
  return {
    application,
    publish({ renderer = [newAudit], persisted = [newAudit], revision = 8, neverPersist = false } = {}) {
      rendererAudits = [...structuredClone(renderer), ...rendererAudits];
      let rejectPersistence;
      persistenceTail = new Promise((resolve, reject) => {
        rejectPersistence = reject;
        if (neverPersist) return;
        setTimeout(() => {
          const persistedAudits = structuredClone(persisted);
          const includesOldAudit = persistedAudits.some(item => String(item?.id || '') === String(oldAudit?.id || ''));
          persistedState = {
            revision,
            auditLogs: includesOldAudit ? persistedAudits : [...persistedAudits, structuredClone(oldAudit)]
          };
          resolve();
        }, persistenceDelayMs);
      });
      return { rejectPersistence };
    }
  };
}

test('profile ownership 只接受规范化后完整的 user-data-dir argv token', () => {
  const matches = commandLineOwnsProfile;
  const cases = [
    {
      name: 'unquoted target',
      profile: 'C:\\workflow\\watchdog',
      commandLine: 'electron.exe . --user-data-dir=C:\\workflow\\watchdog --disable-gpu',
      expected: true
    },
    {
      name: 'quoted target with spaces',
      profile: 'C:\\workflow root\\watchdog',
      commandLine: '"C:\\Electron\\electron.exe" "." "--user-data-dir=C:\\workflow root\\watchdog" --disable-gpu',
      expected: true
    },
    {
      name: 'quoted value with spaces',
      profile: 'C:\\workflow root\\watchdog',
      commandLine: 'electron.exe --user-data-dir="C:\\workflow root\\watchdog" --disable-gpu',
      expected: true
    },
    {
      name: 'normalized absolute target',
      profile: 'C:\\workflow\\profiles\\..\\watchdog',
      commandLine: 'electron.exe --user-data-dir=C:\\workflow\\watchdog',
      expected: true
    },
    {
      name: 'prefix sibling collision',
      profile: 'C:\\workflow\\watchdog',
      commandLine: 'electron.exe --user-data-dir=C:\\workflow\\watchdog-other',
      expected: false
    },
    {
      name: 'child-like collision',
      profile: 'C:\\workflow\\watchdog',
      commandLine: 'electron.exe "--user-data-dir=C:\\workflow\\watchdog\\child"',
      expected: false
    },
    {
      name: 'argument suffix collision',
      profile: 'C:\\workflow\\watchdog',
      commandLine: 'electron.exe --user-data-dir=C:\\workflow\\watchdog.backup',
      expected: false
    }
  ];
  for (const item of cases) {
    assert.equal(matches(item.commandLine, item.profile), item.expected, item.name);
  }
});

test('packaged cleanup simultaneously requires the exact executable basename and exact profile token', () => {
  const profile = 'C:\\workflow root\\profiles\\visual-pages';
  const owns = commandLineOwnsExactExecutableProfile;
  const matching = {
    Name: '电池测试通道预约与使用看板.exe',
    CommandLine: '"电池测试通道预约与使用看板.exe" "--user-data-dir=C:\\workflow root\\profiles\\visual-pages" --disable-gpu'
  };
  assert.equal(owns(matching, profile, '电池测试通道预约与使用看板.exe'), true);
  assert.equal(owns({ ...matching, Name: 'electron.exe' }, profile, '电池测试通道预约与使用看板.exe'), false);
  assert.equal(owns({ ...matching, CommandLine: matching.CommandLine.replace('visual-pages', 'visual-pages-other') }, profile, '电池测试通道预约与使用看板.exe'), false);
});

test('packaged driver launches only an existing absolute exe and exposes its isolated profile data root', async () => {
  const context = await workflowContext();
  const profileRoot = path.join(context.profileRoot, 'packaged-visual-pages');
  const dataRoot = path.join(profileRoot, 'data');
  const executablePath = path.join(context.runRoot, 'Battery-Visual-Candidate.exe');
  const launches = [];
  await writeFile(executablePath, 'test executable placeholder');
  const driver = createWorkflowElectronDriver({
    projectRoot,
    dataRoot,
    profileRoot,
    viewport: '1366x768',
    packaged: true,
    executablePath,
    launchElectron: async options => {
      launches.push(options);
      return fakeApplication();
    },
    processControl: fakeProcessRuntime([]).control
  });
  try {
    await driver.start();
    assert.equal(launches.length, 1);
    assert.equal(launches[0].executablePath, path.resolve(executablePath));
    assert.deepEqual(launches[0].args, [`--user-data-dir=${path.resolve(profileRoot)}`, '--disable-gpu']);
    assert.equal(launches[0].args.includes('.'), false);
    assert.equal(launches[0].env.BATTERY_CHANNEL_DATA_DIR, undefined);
    assert.equal(await driver.dataRoot(), path.resolve(dataRoot));
  } finally {
    await cleanupDriversThenRuns([driver], [context]);
  }
});

test('packaged driver permits only the exact profileRoot/data nesting', async () => {
  const context = await workflowContext();
  const profileRoot = path.join(context.profileRoot, 'packaged-nesting');
  const executablePath = path.join(context.runRoot, 'candidate.exe');
  await writeFile(executablePath, 'test executable placeholder');
  try {
    assert.doesNotThrow(() => createWorkflowElectronDriver({
      projectRoot,
      profileRoot,
      dataRoot: path.join(profileRoot, 'data'),
      viewport: '1366x768',
      packaged: true,
      executablePath
    }));
    assert.throws(() => createWorkflowElectronDriver({
      projectRoot,
      profileRoot,
      dataRoot: path.join(profileRoot, 'data', 'child'),
      viewport: '1366x768',
      packaged: true,
      executablePath
    }), /separate|exact/i);
  } finally {
    await rm(context.runRoot, { recursive: true, force: true });
  }
});

test('driver accepts only exact workflows or manual-guided report namespaces', async () => {
  const context = await workflowContext();
  const manualRunRoot = path.join(projectRoot, '自动测试报告', 'manual-guided', 'namespace-contract');
  const profileRoot = path.join(manualRunRoot, 'profile');
  const executablePath = path.join(manualRunRoot, 'candidate.exe');
  await mkdir(manualRunRoot, { recursive: true });
  await writeFile(executablePath, 'test executable placeholder');
  try {
    assert.doesNotThrow(() => createWorkflowElectronDriver({
      projectRoot,
      reportNamespace: 'manual-guided',
      profileRoot,
      dataRoot: path.join(profileRoot, 'data'),
      viewport: '1366x768',
      packaged: true,
      executablePath
    }));
    assert.throws(() => createWorkflowElectronDriver({
      projectRoot,
      profileRoot,
      dataRoot: path.join(profileRoot, 'data'),
      viewport: '1366x768',
      packaged: true,
      executablePath
    }), /workflow run root|guarded/i);
    assert.throws(() => createWorkflowElectronDriver({
      projectRoot,
      reportNamespace: 'arbitrary',
      profileRoot,
      dataRoot: path.join(profileRoot, 'data'),
      viewport: '1366x768',
      packaged: true,
      executablePath
    }), /reportNamespace/i);
  } finally {
    await rm(manualRunRoot, { recursive: true, force: true });
    await rm(context.runRoot, { recursive: true, force: true });
  }
});

test('application close reject 后仍精确释放 owned profile 并保留 close cause', async () => {
  const context = await workflowContext();
  const runtime = fakeProcessRuntime([41001]);
  const application = fakeApplication({
    close: async () => { throw new Error('close-rejected'); }
  });
  const driver = createWorkflowElectronDriver({
    projectRoot,
    dataRoot: context.dataRoot,
    profileRoot: path.join(context.profileRoot, 'close-reject'),
    viewport: '1366x768',
    timeoutMs: 25,
    launchElectron: async () => application,
    processControl: runtime.control
  });
  try {
    await driver.start();
    let closeError;
    try { await driver.close(); } catch (error) { closeError = error; }
    assert.match(closeError?.message || '', /workflow Electron close cleanup failed/i);
    assert.equal(closeError?.cause?.message, 'close-rejected');
    assert.deepEqual([...runtime.ownedPids], []);
  } finally {
    await cleanupDriversThenRuns([driver], [context]);
  }
});

test('launch stage cleanup uses a controllable logical deadline and consumes late close rejection', { timeout: 5_000 }, async () => {
  const context = await workflowContext();
  const runtime = fakeProcessRuntime([41002]);
  const deadlines = controlledDeadlines();
  const closeResult = deferred();
  const lateRejections = [];
  const onUnhandled = reason => lateRejections.push(reason);
  process.on('unhandledRejection', onUnhandled);
  const application = fakeApplication({
    firstWindow: async () => { throw new Error('window-stage-failed'); },
    close: () => closeResult.promise
  });
  const driver = createWorkflowElectronDriver({
    projectRoot,
    dataRoot: context.dataRoot,
    profileRoot: path.join(context.profileRoot, 'stage-failure'),
    viewport: '1366x768',
    timeoutMs: 60_000,
    launchElectron: async () => application,
    processControl: runtime.control,
    deadlineControl: deadlines.control
  });
  try {
    const startResult = driver.start().then(
      () => ({ ok: true }),
      error => ({ ok: false, error })
    );
    await deadlines.waitFor('close');
    deadlines.fire('close');
    const { ok, error: startError } = await startResult;
    assert.equal(ok, false);
    assert.match(startError?.message || '', /workflow Electron launch setup failed/i);
    assert.equal(startError?.cause?.message, 'window-stage-failed');
    assert.deepEqual([...runtime.ownedPids], []);
    closeResult.reject(new Error('late-close-rejected'));
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(lateRejections, []);
  } finally {
    closeResult.resolve();
    process.off('unhandledRejection', onUnhandled);
    await cleanupDriversThenRuns([driver], [context]);
  }
});

async function assertBaselineWindow(driver, context, viewport) {
  const [expectedWidth, expectedHeight] = viewport.split('x').map(Number);
  assert.match(await bounded(`${viewport} title`, driver.page().title()), /电池测试通道/);
  assert.deepEqual(driver.page().viewportSize(), {
    width: expectedWidth,
    height: expectedHeight
  });
  assert.deepEqual(await bounded(`${viewport} native window geometry`, driver.windowGeometry()), {
    renderer: { width: expectedWidth, height: expectedHeight },
    nativeContent: { width: expectedWidth, height: expectedHeight }
  });
  assert.equal(await bounded(`${viewport} data root`, driver.dataRoot()), path.resolve(context.dataRoot));

  const ui = await bounded(`${viewport} projection`, driver.uiProjection());
  assert.equal(ui.projection.currentPage, 'dashboard');
  assert.deepEqual(ui.projection.summary, {
    revision: 1,
    devices: 26,
    channels: 529,
    requests: 0,
    samples: 0,
    records: 0,
    storageRecords: 0,
    audits: 0,
    journalEntries: 0,
    runningRecords: 0,
    reservedRecords: 0,
    activeRecords: 0
  });
  assert.deepEqual(Object.keys(ui.projection.visible).sort(), ['channels', 'records', 'samples', 'storageRecords', 'todos']);
  assert.ok(Object.values(ui.projection.visible).every(Array.isArray));
  assert.equal(ui.whiteScreen, false);
  assert.equal(ui.horizontalOverflow, false);
  assert.ok(ui.dom.nodes > 0);
  assert.deepEqual(ui.consoleErrors, []);
  assert.deepEqual(ui.pageErrors, []);
  assert.deepEqual(ui.unhandledRejections, []);
  assert.deepEqual(ui.externalRequests, []);
  assert.deepEqual(ui.mainProcessErrors, []);

  const screenshotPath = await bounded(`${viewport} screenshot`, driver.screenshot(`startup-${viewport}`), 10_000);
  assert.equal(screenshotPath, path.join(context.screenshotsRoot, `startup-${viewport}.png`));
  await access(screenshotPath);
}

async function assertQueueWorkflow(driver, context) {
  const firstPage = driver.page();
  assert.match(await bounded('1366 title', firstPage.title()), /电池测试通道/);
  assert.deepEqual(firstPage.viewportSize(), { width: 1366, height: 768 });
  assert.equal(await bounded('1366 data root', driver.dataRoot()), path.resolve(context.dataRoot));
  const screenshotPath = await bounded('1366 screenshot', driver.screenshot('startup-1366x768'));
  assert.equal(screenshotPath, path.join(context.screenshotsRoot, 'startup-1366x768.png'));
  await access(screenshotPath);

  await bounded('login fill', firstPage.locator('#username').fill('workflow-driver'));
  await bounded('login click', firstPage.locator('#login .btn.wide').click());
  await bounded('login ready', firstPage.waitForFunction(() => window.__batteryAppReady === true));
  const loginEvidence = await bounded('login persistence barrier', driver.waitForPersistenceBarrier({
    auditAction: '登录看板',
    actor: 'workflow-driver',
    timeoutMs: 5_000
  }));
  assert.ok(loginEvidence.revision > 1);
  assert.equal(loginEvidence.audit.action, '登录看板');
  assert.equal(loginEvidence.audit.user, 'workflow-driver');

  const dashboard = await bounded('dashboard projection', driver.uiProjection());
  assert.deepEqual(dashboard.projection.visible.todos, [{ id: 'WF-record-reserved-001', status: 'reserved' }]);
  assert.equal(dashboard.projection.summary.devices, 26);
  assert.equal(dashboard.projection.summary.channels, 529);
  assert.equal(dashboard.projection.summary.requests, 2);
  assert.equal(dashboard.projection.summary.samples, 2);
  assert.equal(dashboard.projection.summary.records, 2);
  assert.equal(dashboard.projection.summary.runningRecords, 1);
  assert.equal(dashboard.projection.summary.reservedRecords, 1);
  const dashboardSnapshot = readWorkflowSnapshot({ dataRoot: context.dataRoot });
  const uiViolations = checkWorkflowInvariants({
    before: dashboardSnapshot,
    after: dashboardSnapshot,
    action: { id: 'driver-projection', type: 'navigate', expect: 'success', outcome: 'success', revisionDelta: [0, 1] },
    ui: dashboard
  }).filter(item => ['UI_PROJECTION_INVALID', 'UI_SQLITE_PROJECTION', 'CHANNEL_DOM_LIMIT', 'CONSOLE_ERROR', 'UNHANDLED_REJECTION', 'EXTERNAL_NETWORK_REQUEST'].includes(item.code));
  assert.deepEqual(uiViolations, []);

  await bounded('records navigation', firstPage.locator('.nav[data-page="records"]').click());
  const records = await bounded('record projection', driver.uiProjection());
  assert.equal(records.projection.currentPage, 'records');
  assert.deepEqual(records.projection.visible.records, [
    { id: 'WF-record-running-001', status: 'running' },
    { id: 'WF-record-reserved-001', status: 'reserved' }
  ]);

  await bounded('apply navigation', firstPage.locator('.nav[data-page="apply"]').click());
  await bounded('request selection', firstPage.locator('[data-legacy-action="select-request"]').first().click());
  const samples = await bounded('sample projection', driver.uiProjection());
  assert.equal(samples.projection.currentPage, 'apply');
  assert.equal(samples.projection.visible.samples.length, 1);
  assert.ok(['running', 'reserved'].includes(samples.projection.visible.samples[0].status));

  await bounded('devices navigation', firstPage.locator('.nav[data-page="devices"]').click());
  const channels = await bounded('channel projection', driver.uiProjection());
  assert.equal(channels.projection.currentPage, 'devices');
  assert.ok(channels.projection.visible.channels.length > 0);
  assert.ok(channels.projection.visible.channels.every(item => item.key && item.state));

  const fileA = path.join(context.exportsRoot, 'missing-a.xlsx');
  const fileB = path.join(context.exportsRoot, 'missing-b.xlsx');
  const directoryA = path.join(context.exportsRoot, 'missing-dir-a');
  const directoryB = path.join(context.exportsRoot, 'missing-dir-b');
  const saveA = path.join(context.exportsRoot, 'saved-a.xlsx');
  const saveB = path.join(context.exportsRoot, 'saved-b.xlsx');
  await bounded('configure dialogs', driver.configureDialogs({
    openFiles: [[fileA], [fileB], []],
    openDirectories: [[directoryA], [directoryB], []],
    saveFiles: [saveA, saveB, '']
  }));
  const fileResults = [];
  const directoryResults = [];
  const saveResults = [];
  for (let index = 0; index < 3; index += 1) {
    fileResults.push(await bounded(`import file dialog ${index}`, firstPage.evaluate(() => window.batteryDesktop.importExcel())));
    directoryResults.push(await bounded(`import directory dialog ${index}`, firstPage.evaluate(() => window.batteryDesktop.importFolder())));
    saveResults.push(await bounded(
      `save file dialog ${index}`,
      firstPage.evaluate(() => window.batteryDesktop.exportExcel({ sheets: [{ name: '数据', rows: [{ 序号: 1 }] }] }))
    ));
  }
  assert.deepEqual(fileResults.map(result => result.file || ''), [fileA, fileB, '']);
  assert.deepEqual(directoryResults.map(result => result.folder || ''), [directoryA, directoryB, '']);
  assert.deepEqual(saveResults.map(result => result.file || ''), [saveA, saveB, '']);
  assert.deepEqual([fileResults[2], directoryResults[2], saveResults[2]], [
    { canceled: true }, { canceled: true }, { canceled: true }
  ]);
  await Promise.all([access(saveA), access(saveB)]);

  await bounded('external request route', firstPage.route('https://outside.invalid/**', route => route.abort()));
  await bounded('diagnostic injection', firstPage.evaluate(() => {
    console.error('workflow-console-marker');
    void fetch('https://outside.invalid/probe').catch(() => undefined);
    setTimeout(() => Promise.reject(new Error('workflow-unhandled-marker')), 0);
  }));
  await new Promise(resolve => setTimeout(resolve, 50));
  const diagnostics = await bounded('diagnostic projection', driver.uiProjection());
  assert.ok(diagnostics.consoleErrors.some(message => message.includes('workflow-console-marker')));
  assert.ok(diagnostics.pageErrors.some(message => message.includes('workflow-unhandled-marker')));
  assert.ok(diagnostics.unhandledRejections.some(message => message.includes('workflow-unhandled-marker')));
  assert.deepEqual(diagnostics.externalRequests, ['https://outside.invalid/probe']);

  await bounded('restart', driver.restart(), 12_000);
  assert.notEqual(driver.page(), firstPage);
  assert.equal(firstPage.isClosed(), true);
  assert.match(await bounded('restart title', driver.page().title()), /电池测试通道/);
  assert.equal(await bounded('restart data root', driver.dataRoot()), path.resolve(context.dataRoot));
  assert.equal((await bounded('dialog route after restart', driver.page().evaluate(() => window.batteryDesktop.importExcel()))).file, fileA);
  const restartedPage = driver.page();
  await bounded('restart external request route', restartedPage.route('https://restart.invalid/**', route => route.abort()));
  await bounded('restart diagnostic injection', restartedPage.evaluate(() => {
    console.error('workflow-restart-console-marker');
    void fetch('https://restart.invalid/probe').catch(() => undefined);
    setTimeout(() => Promise.reject(new Error('workflow-restart-unhandled-marker')), 0);
  }));
  await new Promise(resolve => setTimeout(resolve, 50));
  const restartedDiagnostics = await bounded('restart diagnostic projection', driver.uiProjection());
  assert.ok(restartedDiagnostics.consoleErrors.some(message => message.includes('workflow-restart-console-marker')));
  assert.ok(restartedDiagnostics.pageErrors.some(message => message.includes('workflow-restart-unhandled-marker')));
  assert.ok(restartedDiagnostics.unhandledRejections.some(message => message.includes('workflow-restart-unhandled-marker')));
  assert.ok(restartedDiagnostics.externalRequests.includes('https://restart.invalid/probe'));
}

test('configureDialogs 在未启动时先拒绝且不读取或保存 routes', async () => {
  const context = await workflowContext();
  const driver = driverFor(context, '1366x768', 'not-started');
  let routeReads = 0;
  const routes = {};
  for (const [name, value] of Object.entries({ openFiles: [['C:/a.xlsx']], openDirectories: [['C:/folder']], saveFiles: ['C:/out.xlsx'] })) {
    Object.defineProperty(routes, name, {
      enumerable: true,
      get() { routeReads += 1; return value; }
    });
  }
  try {
    await assert.rejects(driver.configureDialogs(routes), /not started/);
    assert.equal(routeReads, 0);
  } finally {
    await cleanupDriversThenRuns([driver], [context]);
  }
});

test('launch watchdog follows the logical deadline and cleans only the owned profile process', { timeout: 5_000 }, async () => {
  const context = await workflowContext();
  await seedWorkflowFixture({ dataRoot: context.dataRoot, kind: 'baseline', clock: fixedClock });
  const watchdogProfile = path.join(context.profileRoot, 'watchdog');
  const runtime = fakeProcessRuntime([41003]);
  const deadlines = controlledDeadlines();
  let launchCalls = 0;
  const driver = createWorkflowElectronDriver({
    projectRoot,
    dataRoot: context.dataRoot,
    profileRoot: watchdogProfile,
    viewport: '1366x768',
    timeoutMs: 60_000,
    launchElectron() {
      launchCalls += 1;
      return new Promise(() => undefined);
    },
    processControl: runtime.control,
    deadlineControl: deadlines.control
  });
  try {
    const startResult = driver.start().then(
      () => ({ ok: true }),
      error => ({ ok: false, error })
    );
    await deadlines.waitFor('launch');
    deadlines.fire('launch');
    const { ok, error: launchError } = await startResult;
    assert.equal(ok, false);
    assert.match(launchError?.message || '', /workflow Electron launch watchdog timed out/i);
    assert.equal(launchCalls, 1);
    assert.deepEqual([...runtime.ownedPids], []);
  } finally {
    await cleanupDriversThenRuns([driver], [context]);
  }
});

test('capturePersistenceBoundary drains prior page audit before an action scope starts', { timeout: 5_000 }, async () => {
  const context = await workflowContext();
  const pageAudit = { id: 'AUDIT-PAGE', action: '查看页面', target: '页面 apply', user: 'worker-A' };
  const fake = persistenceBarrierApplication({ oldAudit: pageAudit, newAudit: pageAudit });
  const driver = createWorkflowElectronDriver({
    projectRoot,
    dataRoot: context.dataRoot,
    profileRoot: path.join(context.profileRoot, 'boundary-prior-page'),
    viewport: '1366x768',
    timeoutMs: 1_000,
    launchElectron: async () => fake.application,
    processControl: fakeProcessRuntime([]).control
  });
  try {
    await driver.start();
    fake.publish({ renderer: [pageAudit], persisted: [pageAudit] });

    const boundary = await driver.capturePersistenceBoundary({ timeoutMs: 100 });

    assert.equal(boundary.revision, 8);
    assert.deepEqual(boundary.auditIds, ['AUDIT-PAGE']);
    assert.ok(Object.isFrozen(boundary));
    assert.ok(Object.isFrozen(boundary.auditIds));
  } finally {
    await cleanupDriversThenRuns([driver], [context]);
  }
});

test('persistence barrier only accepts a matching target audit after its scoped predecessor', { timeout: 5_000 }, async () => {
  const context = await workflowContext();
  const baselineAudit = { id: 'AUDIT-BASELINE', action: '查看页面', target: '页面 prior', user: 'worker-A' };
  const scopedAudit = { id: 'AUDIT-OLD', action: '查看页面', target: '页面 dashboard', user: 'worker-A' };
  const rightAudit = { id: 'AUDIT-RIGHT', action: '查看页面', target: '页面 dashboard', user: 'worker-A' };
  const fake = persistenceBarrierApplication({ oldAudit: baselineAudit, newAudit: rightAudit });
  const driver = createWorkflowElectronDriver({
    projectRoot,
    dataRoot: context.dataRoot,
    profileRoot: path.join(context.profileRoot, 'boundary-target'),
    viewport: '1366x768',
    timeoutMs: 1_000,
    launchElectron: async () => fake.application,
    processControl: fakeProcessRuntime([]).control
  });
  const boundary = Object.freeze({ revision: 7, auditIds: Object.freeze(['AUDIT-OLD']), state: {} });
  try {
    await driver.start();
    const pending = driver.waitForPersistenceBarrier({
      auditAction: '查看页面', actor: 'worker-A', auditTarget: '页面 dashboard',
      afterAuditIds: boundary.auditIds, timeoutMs: 100
    });
    fake.publish({
      renderer: [
        scopedAudit,
        { id: 'AUDIT-WRONG', action: '查看页面', target: '页面 apply', user: 'worker-A' },
        rightAudit
      ],
      persisted: [
        rightAudit,
        scopedAudit
      ]
    });
    assert.equal((await pending).audit.id, 'AUDIT-RIGHT');
  } finally {
    await cleanupDriversThenRuns([driver], [context]);
  }
});

test('persistence barrier rejects the exact renderer audit when its persisted target is altered', { timeout: 5_000 }, async () => {
  const context = await workflowContext();
  const baselineAudit = { id: 'AUDIT-BASELINE', action: '查看页面', target: '页面 prior', user: 'worker-A' };
  const rendererAudit = { id: 'AUDIT-RIGHT', action: '查看页面', target: '页面 dashboard', user: 'worker-A' };
  const fake = persistenceBarrierApplication({ oldAudit: baselineAudit, newAudit: rendererAudit });
  const driver = createWorkflowElectronDriver({
    projectRoot,
    dataRoot: context.dataRoot,
    profileRoot: path.join(context.profileRoot, 'boundary-persisted-target'),
    viewport: '1366x768',
    timeoutMs: 1_000,
    launchElectron: async () => fake.application,
    processControl: fakeProcessRuntime([]).control
  });
  try {
    await driver.start();
    const pending = driver.waitForPersistenceBarrier({
      auditAction: '查看页面', actor: 'worker-A', auditTarget: '页面 dashboard', timeoutMs: 100
    });
    fake.publish({
      renderer: [rendererAudit],
      persisted: [{ ...rendererAudit, target: '页面 altered' }]
    });
    await assert.rejects(
      pending,
      /\[persistence-barrier\]\[persisted-audit\].*AUDIT-RIGHT/i
    );
  } finally {
    await cleanupDriversThenRuns([driver], [context]);
  }
});

test('persistence barrier bounds inferred actor lookup with its absolute deadline', { timeout: 5_000 }, async () => {
  const context = await workflowContext();
  const oldAudit = { id: 'AUDIT-OLD', action: '查看页面', target: '页面 dashboard', user: 'worker-A' };
  const actorInference = deferred();
  const fake = persistenceBarrierApplication({ oldAudit, newAudit: oldAudit, actorInference: actorInference.promise });
  const driver = createWorkflowElectronDriver({
    projectRoot,
    dataRoot: context.dataRoot,
    profileRoot: path.join(context.profileRoot, 'boundary-actor-inference'),
    viewport: '1366x768',
    timeoutMs: 1_000,
    launchElectron: async () => fake.application,
    processControl: fakeProcessRuntime([]).control
  });
  try {
    await driver.start();
    await assert.rejects(
      bounded('inferred actor barrier', driver.waitForPersistenceBarrier({ auditAction: '查看页面', timeoutMs: 10 }), 250),
      /\[persistence-barrier\]\[actor-inference\].*absolute deadline 10ms exceeded/i
    );
  } finally {
    actorInference.resolve('worker-A');
    await cleanupDriversThenRuns([driver], [context]);
  }
});

test('capturePersistenceBoundary names the save-tail stage and consumes a late rejection', { timeout: 5_000 }, async () => {
  const context = await workflowContext();
  const oldAudit = { id: 'AUDIT-OLD', action: '查看页面', target: '页面 prior', user: 'worker-A' };
  const fake = persistenceBarrierApplication({ oldAudit, newAudit: oldAudit });
  const driver = createWorkflowElectronDriver({
    projectRoot,
    dataRoot: context.dataRoot,
    profileRoot: path.join(context.profileRoot, 'boundary-save-tail-timeout'),
    viewport: '1366x768',
    timeoutMs: 1_000,
    launchElectron: async () => fake.application,
    processControl: fakeProcessRuntime([]).control
  });
  const lateRejections = [];
  const onUnhandled = reason => lateRejections.push(reason);
  process.on('unhandledRejection', onUnhandled);
  try {
    await driver.start();
    const { rejectPersistence } = fake.publish({ neverPersist: true });
    const pending = driver.capturePersistenceBoundary({ timeoutMs: 10 });
    await assert.rejects(bounded('boundary', pending, 250), /\[persistence-boundary\]\[save-tail\]/);
    rejectPersistence(new Error('late-boundary-rejection'));
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(lateRejections, []);
  } finally {
    process.off('unhandledRejection', onUnhandled);
    await cleanupDriversThenRuns([driver], [context]);
  }
});

test('persistence barrier ignores an old same-action audit and waits for the delayed save tail', { timeout: 5_000 }, async () => {
  const context = await workflowContext();
  const oldAudit = { id: 'AUDIT-OLD', action: '登录看板', user: 'workflow-user' };
  const newAudit = { id: 'AUDIT-NEW', action: '登录看板', user: 'workflow-user' };
  const fake = persistenceBarrierApplication({ oldAudit, newAudit });
  const driver = createWorkflowElectronDriver({
    projectRoot,
    dataRoot: context.dataRoot,
    profileRoot: path.join(context.profileRoot, 'persistence-barrier'),
    viewport: '1366x768',
    timeoutMs: 1_000,
    launchElectron: async () => fake.application,
    processControl: fakeProcessRuntime([]).control
  });
  try {
    await driver.start();
    const barrier = driver.waitForPersistenceBarrier({ auditAction: '登录看板', actor: 'workflow-user', timeoutMs: 500 });
    setTimeout(() => fake.publish(), 20);
    const evidence = await barrier;
    assert.equal(evidence.revision, 8);
    assert.deepEqual(evidence.audit, newAudit);
    assert.deepEqual(evidence.state.auditLogs.map(item => item.id), ['AUDIT-NEW', 'AUDIT-OLD']);
  } finally {
    await cleanupDriversThenRuns([driver], [context]);
  }
});

test('persistence barrier persists the exact renderer audit when a competing session writes the same action and actor', { timeout: 5_000 }, async () => {
  const context = await workflowContext();
  const oldAudit = { id: 'AUDIT-OLD', action: '登录看板', user: 'workflow-user' };
  const localAudit = { id: 'AUDIT-LOCAL', action: '登录看板', user: 'workflow-user' };
  const otherAudit = { id: 'AUDIT-OTHER', action: '登录看板', user: 'workflow-user' };
  const fake = persistenceBarrierApplication({ oldAudit, newAudit: localAudit, persistenceDelayMs: 5 });
  const driver = createWorkflowElectronDriver({
    projectRoot,
    dataRoot: context.dataRoot,
    profileRoot: path.join(context.profileRoot, 'persistence-exact-audit'),
    viewport: '1366x768',
    timeoutMs: 1_000,
    launchElectron: async () => fake.application,
    processControl: fakeProcessRuntime([]).control
  });
  try {
    await driver.start();
    const barrier = driver.waitForPersistenceBarrier({ auditAction: '登录看板', actor: 'workflow-user', timeoutMs: 500 });
    fake.publish({ renderer: [localAudit, otherAudit], persisted: [otherAudit, localAudit] });
    const evidence = await barrier;
    assert.equal(evidence.audit.id, 'AUDIT-LOCAL');
  } finally {
    await cleanupDriversThenRuns([driver], [context]);
  }
});

test('persistence barrier applies one absolute deadline to a hung save tail and consumes its late rejection', { timeout: 5_000 }, async () => {
  const context = await workflowContext();
  const oldAudit = { id: 'AUDIT-OLD', action: '登录看板', user: 'workflow-user' };
  const localAudit = { id: 'AUDIT-LOCAL', action: '登录看板', user: 'workflow-user' };
  const fake = persistenceBarrierApplication({ oldAudit, newAudit: localAudit });
  const driver = createWorkflowElectronDriver({
    projectRoot,
    dataRoot: context.dataRoot,
    profileRoot: path.join(context.profileRoot, 'persistence-save-tail-timeout'),
    viewport: '1366x768',
    timeoutMs: 1_000,
    launchElectron: async () => fake.application,
    processControl: fakeProcessRuntime([]).control
  });
  const lateRejections = [];
  const onUnhandled = reason => lateRejections.push(reason);
  process.on('unhandledRejection', onUnhandled);
  try {
    await driver.start();
    const { rejectPersistence } = fake.publish({ renderer: [localAudit], neverPersist: true });
    const pending = driver.waitForPersistenceBarrier({ auditAction: '登录看板', actor: 'workflow-user', timeoutMs: 10 });
    await assert.rejects(
      bounded('hung save-tail barrier', pending, 250),
      /\[persistence-barrier\]\[save-tail\].*登录看板.*workflow-user.*AUDIT-LOCAL/i
    );
    rejectPersistence(new Error('late-save-tail-rejection'));
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(lateRejections, []);
  } finally {
    process.off('unhandledRejection', onUnhandled);
    await cleanupDriversThenRuns([driver], [context]);
  }
});

test('persistence barrier consumes an audit id so a second call cannot return it again', { timeout: 5_000 }, async () => {
  const context = await workflowContext();
  const oldAudit = { id: 'AUDIT-OLD', action: '登录看板', user: 'workflow-user' };
  const localAudit = { id: 'AUDIT-LOCAL', action: '登录看板', user: 'workflow-user' };
  const fake = persistenceBarrierApplication({ oldAudit, newAudit: localAudit, persistenceDelayMs: 5 });
  const driver = createWorkflowElectronDriver({
    projectRoot,
    dataRoot: context.dataRoot,
    profileRoot: path.join(context.profileRoot, 'persistence-consumed'),
    viewport: '1366x768',
    timeoutMs: 1_000,
    launchElectron: async () => fake.application,
    processControl: fakeProcessRuntime([]).control
  });
  try {
    await driver.start();
    const first = driver.waitForPersistenceBarrier({ auditAction: '登录看板', actor: 'workflow-user', timeoutMs: 100 });
    fake.publish();
    assert.equal((await first).audit.id, 'AUDIT-LOCAL');
    await assert.rejects(
      driver.waitForPersistenceBarrier({ auditAction: '登录看板', actor: 'workflow-user', timeoutMs: 20 }),
      /\[persistence-barrier\]\[renderer-audit\].*登录看板.*workflow-user/i
    );
  } finally {
    await cleanupDriversThenRuns([driver], [context]);
  }
});

test('persistence barrier timeout names the renderer-audit stage and requested evidence', { timeout: 5_000 }, async () => {
  const context = await workflowContext();
  const oldAudit = { id: 'AUDIT-OLD', action: '登录看板', user: 'workflow-user' };
  const fake = persistenceBarrierApplication({ oldAudit, newAudit: oldAudit });
  const driver = createWorkflowElectronDriver({
    projectRoot,
    dataRoot: context.dataRoot,
    profileRoot: path.join(context.profileRoot, 'persistence-timeout'),
    viewport: '1366x768',
    timeoutMs: 1_000,
    launchElectron: async () => fake.application,
    processControl: fakeProcessRuntime([]).control
  });
  try {
    await driver.start();
    await assert.rejects(
      driver.waitForPersistenceBarrier({ auditAction: '登录看板', actor: 'workflow-user', timeoutMs: 20 }),
      /\[persistence-barrier\]\[renderer-audit\].*登录看板.*workflow-user/i
    );
  } finally {
    await cleanupDriversThenRuns([driver], [context]);
  }
});

test('dashboard 导航必须重建预约待办入口，不能只切换 active 页面', { timeout: 45_000 }, async (t) => {
  const context = await workflowContext();
  const driver = driverFor(context, '1366x768', 'dashboard-todo-remount');
  t.after(() => cleanupDriversThenRuns([driver], [context]));
  await seedWorkflowFixture({ dataRoot: context.dataRoot, kind: 'queue', clock: fixedClock });
  await bounded('dashboard remount start', driver.start(), 30_000);
  const page = driver.page();
  await bounded('dashboard remount login name', page.locator('#username').fill('dashboard-remount'));
  await bounded('dashboard remount login', page.locator('#login .btn.wide').click());
  await bounded('dashboard remount ready', page.waitForFunction(() => window.__batteryAppReady === true));
  const todoCount = await bounded('dashboard remount todo', page.evaluate(() => {
    document.getElementById('reservationTodoList')?.replaceChildren();
    window.go('dashboard');
    return document.querySelectorAll('[data-dashboard-action="todo-detail"]').length;
  }));
  assert.equal(todoCount, 1);
});

test('运行中切换 viewport 必须同步 Electron 原生内容区，不能留下未绘制白框', { timeout: 45_000 }, async (t) => {
  const context = await workflowContext();
  const driver = driverFor(context, '1366x768', 'native-resize');
  t.after(() => cleanupDriversThenRuns([driver], [context]));
  await seedWorkflowFixture({ dataRoot: context.dataRoot, kind: 'baseline', clock: fixedClock });
  await bounded('native resize start', driver.start(), 30_000);

  const geometry = await bounded('native resize', driver.resizeViewport('1440x900'));

  assert.deepEqual(driver.page().viewportSize(), { width: 1440, height: 900 });
  assert.deepEqual(geometry, {
    renderer: { width: 1440, height: 900 },
    nativeContent: { width: 1440, height: 900 }
  });
});

test('三视口启动真实 Electron，且两个会话的 SQLite 与 profile 相互隔离', { timeout: 120_000 }, async (t) => {
  const viewports = ['1366x768', '1440x900', '1536x864'];
  const contexts = await Promise.all(viewports.map(() => workflowContext()));
  const drivers = contexts.map((context, index) => driverFor(context, viewports[index]));
  t.after(() => cleanupDriversThenRuns(drivers, contexts));
  await Promise.all(contexts.map((context, index) => seedWorkflowFixture({
    dataRoot: context.dataRoot,
    kind: index === 0 ? 'queue' : 'baseline',
    clock: fixedClock
  })));

  await Promise.all([
    bounded('1366 start', drivers[0].start(), 30_000),
    bounded('1440 start', drivers[1].start(), 30_000)
  ]);
  await Promise.all([assertQueueWorkflow(drivers[0], contexts[0]), assertBaselineWindow(drivers[1], contexts[1], viewports[1])]);
  await Promise.all([
    bounded('1366 close', drivers[0].close(), 12_000),
    bounded('1440 close', drivers[1].close(), 12_000)
  ]);

  await bounded('1536 start', drivers[2].start(), 30_000);
  await assertBaselineWindow(drivers[2], contexts[2], viewports[2]);
  await bounded('1536 close', drivers[2].close(), 12_000);
});
