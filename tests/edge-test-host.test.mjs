import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

const projectRoot = path.resolve(import.meta.dirname, '..');
const hostModule = await import('../scripts/edge-regression/test-host.mjs').catch(() => ({}));

function fakeHarness() {
  return {
    loadState: async () => ({ revision: 7, requests: [], samples: [], channels: [] }),
    saveState: async state => ({ ...state, revision: 8 }),
    executeReservation: async command => ({ ok: true, command }),
    executeApplication: async command => ({ ok: true, command }),
    importExcel: async () => ({ ok: true, records: [] }),
    importFolder: async () => ({ ok: true, records: [], errors: [] }),
    exportExcel: async payload => ({ ok: true, payload }),
    exportDashboardPng: async payload => ({ ok: true, payload }),
    backupState: async () => ({ ok: true, verified: true }),
    restoreState: async command => ({ ok: true, command })
  };
}

function fakeRun() {
  let stopped = false;
  return {
    snapshot: () => ({ runId: 'host-test', stopped, scenarios: [] }),
    requestStop: source => {
      stopped = true;
      return { ok: true, source };
    }
  };
}

async function authenticated(origin, token, pathname, options = {}) {
  return fetch(`${origin}${pathname}`, {
    ...options,
    headers: {
      authorization: `Bearer ${token}`,
      origin,
      ...(options.headers || {})
    }
  });
}

test('test host exports the required API', () => {
  assert.equal(typeof hostModule.startTestHost, 'function');
});

test('host binds loopback and protects API with token and origin checks', async () => {
  assert.equal(typeof hostModule.startTestHost, 'function');
  const token = 'host-secret';
  const host = await hostModule.startTestHost({
    projectRoot,
    run: fakeRun(),
    harness: fakeHarness(),
    token
  });
  try {
    assert.match(host.origin, /^http:\/\/127\.0\.0\.1:\d+$/);
    assert.equal((await fetch(`${host.origin}/api/state`)).status, 401);
    assert.equal((await fetch(`${host.origin}/api/state`, {
      headers: { authorization: `Bearer ${token}`, origin: 'http://attacker.invalid' }
    })).status, 403);
    const response = await authenticated(host.origin, token, '/api/state');
    assert.equal(response.status, 200);
    assert.equal((await response.json()).revision, 7);
  } finally {
    await host.close();
  }
});

test('host serves the MAIN page with adapter first and rejects traversal', async () => {
  assert.equal(typeof hostModule.startTestHost, 'function');
  const host = await hostModule.startTestHost({
    projectRoot,
    run: fakeRun(),
    harness: fakeHarness(),
    token: 'host-secret'
  });
  try {
    const response = await fetch(`${host.origin}/app/`);
    assert.equal(response.status, 200);
    const html = await response.text();
    assert.ok(html.indexOf('/test/browser-desktop-adapter.mjs') < html.indexOf('const desktop=window.batteryDesktop'));
    assert.notEqual((await fetch(`${host.origin}/app/%2e%2e/package.json`)).status, 200);
    assert.equal((await fetch(`${host.origin}/app/main.js`)).status, 404);
    assert.equal((await fetch(`${host.origin}/control/`)).status, 200);
  } finally {
    await host.close();
  }
});

test('stop route is cooperative and oversized JSON is rejected', async () => {
  assert.equal(typeof hostModule.startTestHost, 'function');
  const run = fakeRun();
  const token = 'host-secret';
  const host = await hostModule.startTestHost({
    projectRoot,
    run,
    harness: fakeHarness(),
    token,
    maxBodyBytes: 32
  });
  try {
    const oversized = await authenticated(host.origin, token, '/api/application', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ value: 'x'.repeat(64) })
    });
    assert.equal(oversized.status, 413);
    const stopped = await authenticated(host.origin, token, '/api/run/stop', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}'
    });
    assert.equal(stopped.status, 200);
    assert.equal((await stopped.json()).source, 'control-console');
    assert.equal(run.snapshot().stopped, true);
  } finally {
    await host.close();
  }
});
