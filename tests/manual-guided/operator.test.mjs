import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { createManualOperator } from './operator.mjs';

const projectRoot = path.resolve(import.meta.dirname, '..', '..');

test('manual operator rejects missing visible driver and actor inputs', () => {
  assert.throws(() => createManualOperator(), /driver is required/i);
  assert.throws(
    () => createManualOperator({ driver: {}, actor: '虚构测试工程师' }),
    /driver must provide/i
  );
  assert.throws(
    () => createManualOperator({
      driver: { page() {}, restart() {}, screenshot() {}, configureDialogs() {} },
      actor: '   '
    }),
    /actor is required/i
  );
});

test('manual operator exposes semantic form and confirmation primitives', () => {
  const operator = createManualOperator({
    driver: { page() {}, restart() {}, screenshot() {}, configureDialogs() {} },
    actor: '虚构测试工程师'
  });
  for (const method of ['fill', 'choose', 'click', 'confirm', 'cancelDialog']) {
    assert.equal(typeof operator[method], 'function', `${method} must be a visible operator primitive`);
  }
});

test('importFile clicks the single-file control rather than the earlier folder control', async () => {
  const clicked = [];
  const page = {
    getByRole(role, options = {}) {
      if (role === 'heading') {
        return {
          isVisible: async () => options.name === '测试申请表格'
        };
      }
      const names = ['导入文件夹', '导入单个 Excel'];
      const selected = names.find(name => options.name instanceof RegExp
        ? options.name.test(name)
        : (options.exact ? name === options.name : name.includes(options.name))) || '';
      return {
        first() { return this; },
        async click() { clicked.push(selected); }
      };
    },
    getByText() {
      return { async waitFor() {} };
    },
    locator() {
      return {
        isVisible: async () => false,
        filter() { return { async waitFor() {} }; }
      };
    }
  };
  const operator = createManualOperator({
    driver: {
      page: () => page,
      restart() {},
      screenshot: async () => 'C:\\evidence\\import.png',
      configureDialogs: async () => {}
    },
    actor: '虚构测试工程师'
  });

  const result = await operator.perform({
    id: 'B01-import',
    type: 'importFile',
    params: { path: 'C:\\run\\input.xlsx', expectText: '导入完成' }
  });

  assert.equal(result.outcome, 'success');
  assert.deepEqual(clicked, ['导入单个 Excel']);
});

test('dialog-routed actions arm transient toast observation before clicking', async () => {
  const events = [];
  const page = {
    getByRole() {
      return {
        first() { return this; },
        isVisible: async () => true,
        async click() { events.push('click'); }
      };
    },
    locator() {
      return {
        isVisible: async () => false,
        filter() {
          return { waitFor: async () => { events.push('wait'); } };
        }
      };
    }
  };
  const operator = createManualOperator({
    driver: {
      page: () => page,
      restart() {},
      screenshot: async () => 'C:\\evidence\\transient-toast.png',
      configureDialogs: async () => {}
    },
    actor: '虚构测试工程师'
  });

  const result = await operator.perform({
    id: 'B03-import',
    type: 'importFile',
    params: { path: 'C:\\run\\input.xlsx', expectText: '导入完成' }
  });

  assert.equal(result.outcome, 'success');
  assert.deepEqual(events, ['wait', 'click']);
});

test('dialog-routed actions apply the operator timeout to slow visible clicks', async () => {
  const clickOptions = [];
  const page = {
    getByRole() {
      return {
        first() { return this; },
        isVisible: async () => true,
        async click(options) { clickOptions.push(options); }
      };
    },
    locator() {
      return {
        isVisible: async () => false,
        filter() { return { async waitFor() {} }; }
      };
    }
  };
  const operator = createManualOperator({
    driver: {
      page: () => page,
      restart() {},
      screenshot: async () => 'C:\\evidence\\slow-import.png',
      configureDialogs: async () => {}
    },
    actor: '虚构测试工程师',
    timeoutMs: 123_456
  });

  const result = await operator.perform({
    id: 'B05-slow-import',
    type: 'importFile',
    params: { path: 'C:\\run\\sheet-50000.xlsx' }
  });

  assert.equal(result.outcome, 'success');
  assert.deepEqual(clickOptions, [{ timeout: 123_456 }]);
});

test('dialog-routed actions can timebox one slow boundary operation', async () => {
  const clickOptions = [];
  const page = {
    getByRole() {
      return {
        first() { return this; },
        isVisible: async () => true,
        async click(options) { clickOptions.push(options); }
      };
    },
    locator() {
      return {
        isVisible: async () => false,
        filter() { return { async waitFor() {} }; }
      };
    }
  };
  const operator = createManualOperator({
    driver: {
      page: () => page,
      restart() {},
      screenshot: async () => 'C:\\evidence\\timeboxed-import.png',
      configureDialogs: async () => {}
    },
    actor: '虚构测试工程师',
    timeoutMs: 300_000
  });

  await operator.perform({
    id: 'B05-timeboxed-import',
    type: 'importFile',
    params: { path: 'C:\\run\\sheet-50000.xlsx', timeoutMs: 60_000 }
  });

  assert.deepEqual(clickOptions, [{ timeout: 60_000 }]);
});

test('form primitives choose the visible semantic field when hidden pages reuse a label', async () => {
  const filled = [];
  const hidden = {
    isVisible: async () => false,
    async scrollIntoViewIfNeeded() { throw new Error('hidden field must not be operated'); },
    async fill() { throw new Error('hidden field must not be filled'); }
  };
  const visible = {
    isVisible: async () => true,
    async scrollIntoViewIfNeeded() {},
    async fill(value) { filled.push(value); }
  };
  const collection = {
    count: async () => 2,
    nth(index) { return index === 0 ? hidden : visible; },
    first() { return hidden; }
  };
  const operator = createManualOperator({
    driver: {
      page: () => ({ getByLabel: () => collection }),
      restart() {}, screenshot() {}, configureDialogs() {}
    },
    actor: '虚构测试工程师'
  });

  await operator.fill({ label: '最大电流', value: '100' });

  assert.deepEqual(filled, ['100']);
});

test('doubleClick can target a semantic button when visible text is ambiguous', async () => {
  const doubleClicked = [];
  const target = {
    first() { return this; },
    async dblclick() { doubleClicked.push('button'); },
    async textContent() { return '立即开始'; }
  };
  const hiddenHeading = { isVisible: async () => false };
  const page = {
    getByRole(role, options = {}) {
      if (role === 'heading') {
        return options.name === '选择测试申请'
          ? { isVisible: async () => true }
          : hiddenHeading;
      }
      assert.equal(role, 'button');
      assert.equal(options.name, '立即开始');
      assert.equal(options.exact, true);
      return target;
    },
    getByText() {
      throw new Error('ambiguous text locator must not be used when role is provided');
    },
    locator() {
      return { isVisible: async () => false };
    }
  };
  const operator = createManualOperator({
    driver: {
      page: () => page,
      restart() {},
      screenshot: async () => 'C:\\evidence\\double-click.png',
      configureDialogs() {}
    },
    actor: '虚构测试工程师'
  });

  const result = await operator.doubleClick({
    id: 'F02-double',
    params: { text: '立即开始', role: 'button', exact: true }
  });

  assert.equal(result.outcome, 'success');
  assert.deepEqual(doubleClicked, ['button']);
});

test('paginate skips hidden same-name controls and clicks the visible candidate', async () => {
  const clicked = [];
  const hidden = {
    isVisible: async () => false,
    async click() { throw new Error('hidden pagination must not be clicked'); }
  };
  const visible = {
    isVisible: async () => true,
    async scrollIntoViewIfNeeded() {},
    async click() { clicked.push('visible-next'); }
  };
  const collection = {
    count: async () => 2,
    nth(index) { return index === 0 ? hidden : visible; },
    first() { return hidden; }
  };
  const page = {
    getByRole(role, options = {}) {
      if (role === 'heading') {
        return options.name === '选择测试申请'
          ? { isVisible: async () => true }
          : { isVisible: async () => false };
      }
      assert.equal(role, 'button');
      assert.match(String(options.name), /下一页/);
      return collection;
    },
    locator() { return { isVisible: async () => false }; }
  };
  const operator = createManualOperator({
    driver: {
      page: () => page,
      restart() {},
      screenshot: async () => 'C:\\evidence\\paginate.png',
      configureDialogs() {}
    },
    actor: '虚构测试工程师'
  });

  const result = await operator.paginate({ id: 'F06-next', params: { direction: 'next' } });

  assert.equal(result.outcome, 'success');
  assert.deepEqual(clicked, ['visible-next']);
});

test('login confirms the visible actor when a hidden page contains the same name', async () => {
  const hiddenActor = {
    isVisible: async () => false,
    async waitFor() { throw new Error('hidden actor must not confirm login'); }
  };
  const visibleActor = {
    isVisible: async () => true,
    async waitFor() {},
    async textContent() { return '虚构测试工程师'; }
  };
  const actors = {
    count: async () => 2,
    nth(index) { return index === 0 ? hiddenActor : visibleActor; },
    first() { return hiddenActor; }
  };
  const username = { async fill() {} };
  const page = {
    getByLabel(label) {
      assert.equal(label, '用户名');
      return username;
    },
    getByRole(role, options = {}) {
      if (role === 'heading') {
        return options.name === '测试通道看板'
          ? { isVisible: async () => true, async waitFor() {}, async textContent() { return options.name; } }
          : { isVisible: async () => false };
      }
      assert.equal(role, 'button');
      return { async click() {} };
    },
    getByText(text) {
      if (text === '虚构测试工程师') return actors;
      return { async waitFor() {} };
    },
    locator() { return { isVisible: async () => false }; }
  };
  const operator = createManualOperator({
    driver: {
      page: () => page,
      restart() {},
      screenshot: async () => 'C:\\evidence\\login.png',
      configureDialogs() {}
    },
    actor: '虚构测试工程师'
  });

  const result = await operator.login({ id: 'F06-login', username: '虚构测试工程师' });

  assert.equal(result.outcome, 'success');
});

test('manual operator source is limited to visible Playwright controls', async () => {
  const source = await readFile(path.join(import.meta.dirname, 'operator.mjs'), 'utf8');
  const forbidden = [
    ['renderer execution', /\bpage\s*\.\s*evaluate\s*\(/],
    ['desktop bridge', /window\s*\.\s*batteryDesktop/],
    ['direct IPC', /\b(?:ipcMain|ipcRenderer)\b/],
    ['state injection', /\b(?:loadState|saveState|seedWorkflowFixture|uiProjection|capturePersistenceBoundary|waitForPersistenceBarrier)\b/],
    ['main process import', /from\s+['"][^'"]*src[\\/]main(?:[\\/]|['"])/],
    ['domain import', /from\s+['"][^'"]*src[\\/]domain(?:[\\/]|['"])/],
    ['old workflow actions', /from\s+['"][^'"]*workflows[\\/]actions\.mjs['"]/],
    ['old workflow catalog', /from\s+['"][^'"]*workflows[\\/]catalog(?:-[^'"]+)?\.mjs['"]/]
  ];
  for (const [name, pattern] of forbidden) {
    assert.doesNotMatch(source, pattern, `${name} must not appear in the manual operator`);
  }
  assert.match(source, /getByRole|getByLabel|getByText/, 'operator must use semantic visible locators');
  assert.match(source, /keyboard|mouse|screenshot|restart|configureDialogs/, 'operator must expose human-visible input and evidence tools');
});
