import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

const projectRoot = path.resolve(import.meta.dirname, '..');
const require = createRequire(import.meta.url);

async function runMainStartup({ lockAcquired, windows = [], smokeTest = false }) {
  const source = await readFile(path.join(projectRoot, 'main.js'), 'utf8');
  const handlers = new Map();
  const calls = {
    requestSingleInstanceLock: 0,
    quit: 0,
    whenReady: 0
  };
  const neverReady = new Promise(() => {});
  const app = {
    isPackaged: false,
    requestSingleInstanceLock() {
      calls.requestSingleInstanceLock += 1;
      return lockAcquired;
    },
    quit() { calls.quit += 1; },
    exit() {},
    whenReady() {
      calls.whenReady += 1;
      return neverReady;
    },
    on(event, handler) {
      handlers.set(event, [...(handlers.get(event) || []), handler]);
    },
    getPath() { return projectRoot; }
  };
  class BrowserWindow {
    static getAllWindows() { return windows; }
  }
  const processStub = {
    argv: smokeTest ? ['electron', '.', '--smoke-test', '--user-data-dir=isolated-profile'] : ['electron', '.'],
    env: smokeTest ? { BATTERY_CHANNEL_SMOKE: '1' } : {},
    platform: 'win32',
    stderr: { write() {} },
    stdout: { write() {} }
  };
  const context = {
    __dirname: projectRoot,
    Buffer,
    clearTimeout,
    console,
    process: processStub,
    require(specifier) {
      if (specifier === 'electron') {
        return {
          app,
          BrowserWindow,
          dialog: {},
          ipcMain: { handle() {} }
        };
      }
      return require(specifier);
    },
    setTimeout
  };

  vm.runInNewContext(source, context, { filename: 'main.js' });
  return { calls, handlers };
}

test('primary instance takes the lock and restores and focuses its window on second-instance', async () => {
  const windowCalls = { restore: 0, show: 0, focus: 0 };
  const existingWindow = {
    isMinimized: () => true,
    restore: () => { windowCalls.restore += 1; },
    show: () => { windowCalls.show += 1; },
    focus: () => { windowCalls.focus += 1; }
  };
  const { calls, handlers } = await runMainStartup({
    lockAcquired: true,
    windows: [existingWindow],
    smokeTest: true
  });

  assert.equal(calls.requestSingleInstanceLock, 1);
  assert.equal(calls.quit, 0);
  assert.equal(calls.whenReady, 1);
  assert.equal(handlers.get('second-instance')?.length, 1);

  handlers.get('second-instance')[0]();
  assert.deepEqual(windowCalls, { restore: 1, show: 1, focus: 1 });
});

test('secondary instance quits before application initialization', async () => {
  const { calls, handlers } = await runMainStartup({ lockAcquired: false });

  assert.equal(calls.requestSingleInstanceLock, 1);
  assert.equal(calls.quit, 1);
  assert.equal(calls.whenReady, 0);
  assert.equal(handlers.has('second-instance'), false);
});
