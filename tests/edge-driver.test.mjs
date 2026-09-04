import assert from 'node:assert/strict';
import { access, mkdtemp } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const driverModule = await import('../scripts/edge-regression/edge-driver.mjs').catch(() => ({}));

async function startPageServer() {
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end('<!doctype html><html lang="zh-CN"><title>Edge Probe</title><h1>本机 Edge 已连接</h1></html>');
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  return {
    origin,
    close: () => {
      server.closeAllConnections?.();
      return new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  };
}

function settlesWithin(promise, timeoutMs) {
  let timer;
  const observed = Promise.resolve(promise);
  observed.catch(() => undefined);
  return Promise.race([
    observed,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`operation exceeded ${timeoutMs} ms`)), timeoutMs);
    })
  ]).finally(() => clearTimeout(timer));
}

function waitForEvidenceBarrier(evidencePromise, runPromise, timeoutMs) {
  const runSettledBeforeBarrier = Promise.resolve(runPromise).then(
    result => {
      const source = result?.error;
      const error = new Error(source?.message || 'Edge run settled before the evidence callback barrier');
      error.code = source?.code || 'EDGE_CALLBACK_NOT_ENTERED';
      if (source?.details !== undefined) error.details = source.details;
      throw error;
    },
    error => { throw error; }
  );
  runSettledBeforeBarrier.catch(() => undefined);
  return settlesWithin(Promise.race([
    Promise.resolve(evidencePromise),
    runSettledBeforeBarrier
  ]), timeoutMs);
}

function deferred() {
  let resolve;
  const promise = new Promise(innerResolve => {
    resolve = innerResolve;
  });
  return { promise, resolve };
}

async function createLocalDriver(server, runRoot, overrides = {}) {
  return driverModule.createEdgeDriver({
    origin: server.origin,
    token: 'driver-secret',
    runRoot,
    viewport: { width: 1366, height: 768 },
    timeoutMs: 2_000,
    actionTimeoutMs: 50,
    cleanupGraceMs: 5_000,
    ...overrides
  });
}

test('Edge driver exports the required API', () => {
  assert.equal(typeof driverModule.findMicrosoftEdge, 'function');
  assert.equal(typeof driverModule.createEdgeDriver, 'function');
});

test('discovers installed Microsoft Edge without a bundled browser fallback', async () => {
  assert.equal(typeof driverModule.findMicrosoftEdge, 'function');
  const edge = await driverModule.findMicrosoftEdge(process.env);
  assert.match(edge.executablePath, /msedge\.exe$/i);
  assert.match(edge.version, /^\d+\./);
  await access(edge.executablePath);
});

test('launches installed Edge, records evidence and blocks external network', async () => {
  assert.equal(typeof driverModule.createEdgeDriver, 'function');
  const server = await startPageServer();
  const runRoot = await mkdtemp(path.join(os.tmpdir(), 'edge-driver-'));
  const driver = await driverModule.createEdgeDriver({
    origin: server.origin,
    token: 'driver-secret',
    runRoot,
    viewport: { width: 1366, height: 768 }
  });
  try {
    const success = await driver.run('local-page', async ({ page }) => {
      await page.goto(`${server.origin}/`);
      return page.locator('h1').textContent();
    });
    assert.equal(success.ok, true);
    assert.equal(success.value, '本机 Edge 已连接');
    assert.deepEqual(success.consoleErrors, []);
    assert.deepEqual(success.networkViolations, []);
    await access(success.screenshotPath);
    await access(success.tracePath);
    const memory = await driver.sampleMemory();
    assert.ok(memory.edgeProcessCount >= 1, JSON.stringify(memory));
    assert.ok(memory.edgeRss > 0, JSON.stringify(memory));
    assert.ok(memory.aggregateRss >= memory.edgeRss, JSON.stringify(memory));

    const blocked = await driver.run('external-request', async ({ page }) => {
      await page.goto(`${server.origin}/`);
      await page.evaluate(() => fetch('https://example.com/').catch(() => null));
    });
    assert.equal(blocked.ok, false);
    assert.equal(blocked.error.code, 'EDGE_EXTERNAL_REQUEST');
    assert.equal(blocked.networkViolations[0], 'https://example.com/');
  } finally {
    await driver.close();
    await server.close();
  }
});

test('Edge locator timeout stays short when the scenario deadline is long', async () => {
  const server = await startPageServer();
  const runRoot = await mkdtemp(path.join(os.tmpdir(), 'edge-driver-action-timeout-'));
  const driver = await createLocalDriver(server, runRoot);
  try {
    const result = await settlesWithin(driver.run('missing-locator', async ({ page }) => {
      await page.goto(`${server.origin}/`);
      await page.locator('[data-never-exists]').click();
    }), 8_000);
    assert.equal(result.ok, false);
    assert.match(result.error.message, /50ms|50 ms/);
    assert.notEqual(result.error.code, 'EDGE_SCENARIO_TIMEOUT');
  } finally {
    await driver.close();
    await server.close();
  }
});

test('Edge scenario deadline includes context setup', async () => {
  const server = await startPageServer();
  const runRoot = await mkdtemp(path.join(os.tmpdir(), 'edge-driver-setup-timeout-'));
  const driver = await createLocalDriver(server, runRoot, { timeoutMs: 1_000 });
  let browser;
  try {
    await driver.run('capture-browser', async input => {
      browser = input.browser;
      await input.page.goto(`${server.origin}/`);
    });
    assert.ok(browser);
    const originalNewContext = browser.newContext;
    browser.newContext = () => new Promise(() => {});
    try {
      const result = await settlesWithin(driver.run('hung-context-setup', async () => undefined), 1_500);
      assert.equal(result.ok, false);
      assert.equal(result.error.code, 'EDGE_SCENARIO_TIMEOUT');
      assert.equal(result.error.details?.stage, 'context-setup');
    } finally {
      browser.newContext = originalNewContext;
    }
  } finally {
    await driver.close();
    await server.close();
  }
});

test('Edge evidence barrier propagates setup failure when the callback is never entered', async () => {
  const server = await startPageServer();
  const runRoot = await mkdtemp(path.join(os.tmpdir(), 'edge-driver-barrier-setup-failure-'));
  const driver = await createLocalDriver(server, runRoot, { timeoutMs: 1_000 });
  const evidenceReady = deferred();
  let callbackEntered = false;
  let browser;
  let originalNewContext;
  try {
    await driver.run('capture-browser-for-barrier', async input => {
      browser = input.browser;
      await input.page.goto(`${server.origin}/`);
    });
    originalNewContext = browser.newContext;
    browser.newContext = async () => {
      throw Object.assign(new Error('setup rejected before callback'), { code: 'EDGE_SETUP_REJECTED' });
    };
    const runPromise = driver.run('setup-fails-before-barrier', async () => {
      callbackEntered = true;
      evidenceReady.resolve();
    });

    await assert.rejects(
      () => waitForEvidenceBarrier(evidenceReady.promise, runPromise, 500),
      error => error.code === 'EDGE_SETUP_REJECTED' && /setup rejected before callback/.test(error.message)
    );
    assert.equal(callbackEntered, false);
  } finally {
    if (browser && originalNewContext) browser.newContext = originalNewContext;
    await driver.close().catch(() => undefined);
    await server.close();
  }
});

test('Edge evidence and context cleanup are bounded without masking the primary error', async () => {
  const server = await startPageServer();
  const runRoot = await mkdtemp(path.join(os.tmpdir(), 'edge-driver-evidence-timeout-'));
  const driver = await createLocalDriver(server, runRoot, { timeoutMs: 2_000, cleanupGraceMs: 50 });
  const primary = Object.assign(new Error('primary callback failed'), { code: 'PRIMARY_CALLBACK_FAILED' });
  const evidenceReady = deferred();
  const releasePrimary = deferred();
  let browser;
  let originalBrowserClose;
  try {
    const runPromise = driver.run('hung-evidence', async ({ page, context, browser: currentBrowser }) => {
      browser = currentBrowser;
      originalBrowserClose = currentBrowser.close.bind(currentBrowser);
      page.screenshot = () => new Promise(() => {});
      context.tracing.stop = () => new Promise(() => {});
      context.close = () => new Promise(() => {});
      evidenceReady.resolve();
      await releasePrimary.promise;
      throw primary;
    });
    runPromise.catch(() => undefined);
    await waitForEvidenceBarrier(evidenceReady.promise, runPromise, 2_500);
    releasePrimary.resolve();
    const result = await settlesWithin(runPromise, 500);
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'PRIMARY_CALLBACK_FAILED');
    assert.match(result.error.message, /primary callback failed/);
    assert.ok(result.pageErrors.some(item => item.startsWith('SCREENSHOT_FAILED:')));
    assert.ok(result.pageErrors.some(item => item.startsWith('TRACE_FAILED:')));
    assert.ok(result.pageErrors.some(item => item.startsWith('CONTEXT_CLOSE_FAILED:')));
  } finally {
    await driver.close().catch(error => {
      assert.equal(error.code, 'EDGE_CLEANUP_TIMEOUT');
    });
    await originalBrowserClose?.().catch(() => undefined);
    await server.close();
  }
});

test('Edge browser close is idempotent and bounded while consuming a late close rejection', async () => {
  const server = await startPageServer();
  const runRoot = await mkdtemp(path.join(os.tmpdir(), 'edge-driver-close-timeout-'));
  const driver = await createLocalDriver(server, runRoot, { cleanupGraceMs: 50 });
  let browser;
  let originalClose;
  try {
    await driver.run('capture-browser-close', async input => {
      browser = input.browser;
      await input.page.goto(`${server.origin}/`);
    });
    assert.ok(browser);
    originalClose = browser.close.bind(browser);
    browser.close = () => new Promise((_, reject) => {
      setTimeout(() => reject(new Error('late browser close rejection')), 150);
    });
    const first = driver.close();
    const second = driver.close();
    const outcomes = await settlesWithin(Promise.allSettled([first, second]), 500);
    assert.deepEqual(outcomes.map(item => item.status), ['rejected', 'rejected']);
    assert.ok(outcomes.every(item => item.reason?.code === 'EDGE_CLEANUP_TIMEOUT'));
    await new Promise(resolve => setTimeout(resolve, 175));
  } finally {
    if (browser && originalClose) {
      browser.close = originalClose;
      await originalClose().catch(() => undefined);
    } else await driver.close().catch(() => undefined);
    await server.close();
  }
});
