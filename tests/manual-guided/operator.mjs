import { normalizeManualActionResult } from './contracts.mjs';

const DEFAULT_TIMEOUT_MS = 15_000;

const PAGE_HEADINGS = Object.freeze({
  '登录': '欢迎使用',
  '通道看板': '测试通道看板',
  '测试及时率': '测试及时率',
  '开始/预约测试': '选择测试申请',
  '正在测试样品': '正在测试样品',
  '长期存储样品': '长期存储样品',
  '已预约表单处理': '已预约表单处理',
  '测试申请表格': '测试申请表格',
  '日志': '日志',
  '测试人员': '测试人员',
  '设备与通道': '设备与通道配置'
});

const BUTTON_NAMES = Object.freeze({
  reserve: /提交预约/,
  startImmediately: /立即开始测试/,
  startReserved: /开始(?:已预约)?测试/,
  finishRunning: /结束测试/,
  returnRunning: /退回申请/,
  startStorage: /开始存储|登记长期存储|提交存储/,
  finishStorage: /结束存储|结束/,
  returnStorage: /退回申请/,
  editTester: /新增测试人员|编辑/,
  editDevice: /新建设备|编辑设备/,
  exportTimeliness: /导出 PNG/,
  exportRequests: /导出申请汇总/,
  exportSelectedRequests: /导出选中申请/,
  exportLogs: /导出 Excel/,
  backup: /备份数据/,
  restore: /恢复数据/
});

const SAVE_ACTIONS = new Set([
  'exportTimeliness', 'exportRequests', 'exportSelectedRequests', 'exportLogs', 'backup'
]);

function requiredText(value, field) {
  if (typeof value !== 'string' || value.trim() === '') throw new TypeError(`${field} is required`);
  return value.trim();
}

function actionId(action) {
  return requiredText(action?.id ?? action?.actionId, 'action id');
}

function actionParams(action) {
  if (action?.params === undefined) return action || {};
  if (!action.params || typeof action.params !== 'object' || Array.isArray(action.params)) {
    throw new TypeError('action params must be an object');
  }
  return action.params;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function safeEvidenceName(value) {
  return value.replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'action';
}

function validateDriver(driver) {
  if (!driver) throw new TypeError('driver is required');
  const methods = ['page', 'restart', 'screenshot', 'configureDialogs'];
  if (methods.some(name => typeof driver[name] !== 'function')) {
    throw new TypeError(`driver must provide ${methods.join(', ')}`);
  }
}

export function createManualOperator({ driver, actor, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  validateDriver(driver);
  const defaultActor = requiredText(actor, 'actor');
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new TypeError('timeoutMs must be positive');
  let evidenceSequence = 0;

  function page() {
    return driver.page();
  }

  async function firstVisible(locator) {
    if (typeof locator?.count === 'function' && typeof locator?.nth === 'function') {
      const count = await locator.count();
      for (let index = 0; index < count; index += 1) {
        const candidate = locator.nth(index);
        if (await candidate.isVisible().catch(() => false)) return candidate;
      }
    }
    return locator.first();
  }

  function headingFor(label) {
    const heading = PAGE_HEADINGS[label];
    if (!heading) throw new TypeError(`unsupported visible page: ${label}`);
    return page().getByRole('heading', { name: heading, exact: true });
  }

  async function waitForPage(label) {
    await headingFor(label).waitFor({ state: 'visible', timeout: timeoutMs });
    return label;
  }

  async function visiblePage() {
    for (const [label, heading] of Object.entries(PAGE_HEADINGS)) {
      if (await page().getByRole('heading', { name: heading, exact: true }).isVisible().catch(() => false)) return label;
    }
    throw new Error('no known visible product page was found');
  }

  async function visibleToast() {
    const toast = page().locator('#toast');
    if (!await toast.isVisible().catch(() => false)) return '';
    return String(await toast.textContent() || '').trim();
  }

  async function finish(id, startedAt, { outcome, visiblePage: pageLabel, visibleMessage }) {
    const resolvedPage = pageLabel || await visiblePage();
    const resolvedMessage = String(visibleMessage || await visibleToast() || resolvedPage).trim();
    evidenceSequence += 1;
    const screenshotPath = await driver.screenshot(
      `${String(evidenceSequence).padStart(3, '0')}-${safeEvidenceName(id)}`
    );
    return normalizeManualActionResult({
      actionId: id,
      outcome,
      visiblePage: resolvedPage,
      visibleMessage: resolvedMessage,
      screenshotPath,
      startedAt,
      endedAt: new Date().toISOString()
    });
  }

  async function fail(id, startedAt, error) {
    return finish(id, startedAt, {
      outcome: 'failure',
      visibleMessage: await visibleToast() || error?.message || String(error)
    });
  }

  async function login(action = {}) {
    const id = actionId(action);
    const startedAt = new Date().toISOString();
    const params = actionParams(action);
    const username = params.username === undefined ? defaultActor : String(params.username);
    try {
      const usernameInput = page().getByLabel('用户名', { exact: true });
      await usernameInput.fill(username);
      await page().getByRole('button', { name: '进入看板', exact: true }).click();
      if (username.trim() === '') {
        const message = page().getByText('请输入实际操作用户名', { exact: true });
        await message.waitFor({ state: 'visible', timeout: timeoutMs });
        return finish(id, startedAt, {
          outcome: 'rejected',
          visiblePage: '登录',
          visibleMessage: String(await message.textContent() || '').trim()
        });
      }
      await waitForPage('通道看板');
      const actorDisplay = await firstVisible(page().getByText(username.trim(), { exact: true }));
      await actorDisplay.waitFor({ state: 'visible', timeout: timeoutMs });
      await page().getByText('请输入实际操作用户名', { exact: true })
        .waitFor({ state: 'hidden', timeout: timeoutMs });
      return finish(id, startedAt, {
        outcome: 'success',
        visiblePage: '通道看板',
        visibleMessage: String(await actorDisplay.textContent() || '').trim()
      });
    } catch (error) {
      return fail(id, startedAt, error);
    }
  }

  async function navigate(action = {}) {
    const id = actionId(action);
    const startedAt = new Date().toISOString();
    const params = actionParams(action);
    const label = requiredText(params.label, 'navigation label');
    try {
      const navigation = page().getByRole('button', {
        name: new RegExp(`${escapeRegExp(label)}$`)
      }).first();
      await navigation.scrollIntoViewIfNeeded();
      await navigation.click();
      await waitForPage(label);
      return finish(id, startedAt, {
        outcome: 'success',
        visiblePage: label,
        visibleMessage: String(await headingFor(label).textContent() || '').trim()
      });
    } catch (error) {
      return fail(id, startedAt, error);
    }
  }

  async function restart(action = {}) {
    const id = actionId(action);
    const startedAt = new Date().toISOString();
    try {
      await driver.restart();
      await waitForPage('登录');
      return finish(id, startedAt, {
        outcome: 'success',
        visiblePage: '登录',
        visibleMessage: String(await headingFor('登录').textContent() || '').trim()
      });
    } catch (error) {
      return fail(id, startedAt, error);
    }
  }

  async function clickNamed(action = {}) {
    const id = actionId(action);
    const startedAt = new Date().toISOString();
    const params = actionParams(action);
    try {
      const configured = params.buttonName
        ? new RegExp(escapeRegExp(requiredText(params.buttonName, 'button name')))
        : BUTTON_NAMES[action.type];
      if (!configured) throw new TypeError(`visible button is not configured for ${action.type}`);
      const button = page().getByRole('button', { name: configured }).first();
      await button.scrollIntoViewIfNeeded();
      await button.click();
      if (params.expectText) {
        await page().locator('#toast').filter({ hasText: String(params.expectText) })
          .waitFor({ state: 'visible', timeout: timeoutMs });
      }
      return finish(id, startedAt, {
        outcome: params.outcome || 'success',
        visibleMessage: params.expectText || await visibleToast() || String(await button.textContent() || '').trim()
      });
    } catch (error) {
      return fail(id, startedAt, error);
    }
  }

  async function routeAndClick(action = {}) {
    const id = actionId(action);
    const startedAt = new Date().toISOString();
    const params = actionParams(action);
    try {
      const actionTimeoutMs = params.timeoutMs === undefined ? timeoutMs : Number(params.timeoutMs);
      if (!Number.isFinite(actionTimeoutMs) || actionTimeoutMs <= 0) throw new TypeError('action timeoutMs must be positive');
      const routePath = requiredText(params.path, 'dialog route path');
      const routes = { openFiles: [], openDirectories: [], saveFiles: [] };
      if (action.type === 'importFolder') routes.openDirectories.push([routePath]);
      else if (SAVE_ACTIONS.has(action.type)) routes.saveFiles.push(routePath);
      else routes.openFiles.push([routePath]);
      await driver.configureDialogs(routes);
      const defaultName = action.type === 'importFile'
        ? /(?:导入单个 Excel|导入文件)$/
        : action.type === 'importFolder'
          ? /导入文件夹/
          : BUTTON_NAMES[action.type];
      const buttonName = params.buttonName ? new RegExp(escapeRegExp(String(params.buttonName))) : defaultName;
      if (!buttonName) throw new TypeError(`dialog button is not configured for ${action.type}`);
      if (params.expectText) {
        const staleToast = page().locator('#toast');
        const staleText = typeof staleToast.textContent === 'function'
          ? String(await staleToast.textContent().catch(() => '') || '')
          : '';
        if (staleText.includes(String(params.expectText)) && await staleToast.isVisible().catch(() => false)
          && typeof staleToast.waitFor === 'function') {
          await staleToast.waitFor({ state: 'hidden', timeout: timeoutMs });
        }
      }
      const button = await firstVisible(page().getByRole('button', { name: buttonName }));
      const expectedToast = params.expectText
        ? page().locator('#toast').filter({ hasText: String(params.expectText) })
          .waitFor({ state: 'visible', timeout: actionTimeoutMs })
        : null;
      expectedToast?.catch(() => {});
      if (params.acceptConfirmation === true) {
        const confirmation = page().waitForEvent('dialog', { timeout: actionTimeoutMs });
        const clicking = button.click({ timeout: actionTimeoutMs });
        const dialog = await confirmation;
        await dialog.accept();
        await clicking;
      } else {
        await button.click({ timeout: actionTimeoutMs });
      }
      if (expectedToast) await expectedToast;
      return finish(id, startedAt, {
        outcome: params.outcome || 'success',
        visibleMessage: `AUTOMATED_DIALOG_ROUTE: ${params.expectText || await visibleToast() || routePath}`
      });
    } catch (error) {
      return fail(id, startedAt, error);
    }
  }

  async function clickTexts(action = {}) {
    const id = actionId(action);
    const startedAt = new Date().toISOString();
    const params = actionParams(action);
    try {
      const values = params.values ?? (params.value === undefined ? [] : [params.value]);
      if (!Array.isArray(values) || values.length === 0) throw new TypeError('visible values are required');
      for (const value of values) {
        const target = page().getByText(String(value), { exact: true }).first();
        await target.scrollIntoViewIfNeeded();
        await target.click();
      }
      return finish(id, startedAt, {
        outcome: 'success',
        visibleMessage: values.map(String).join(', ')
      });
    } catch (error) {
      return fail(id, startedAt, error);
    }
  }

  async function search(action = {}) {
    const id = actionId(action);
    const startedAt = new Date().toISOString();
    const params = actionParams(action);
    try {
      const query = String(params.query ?? '');
      const input = params.label
        ? page().getByLabel(String(params.label), { exact: false }).first()
        : page().getByRole('searchbox').first();
      await input.fill(query);
      return finish(id, startedAt, { outcome: 'success', visibleMessage: query || '已清空搜索' });
    } catch (error) {
      return fail(id, startedAt, error);
    }
  }

  async function paginate(action = {}) {
    const id = actionId(action);
    const startedAt = new Date().toISOString();
    const params = actionParams(action);
    try {
      const label = params.direction === 'previous' ? '上一页' : '下一页';
      const button = await firstVisible(page().getByRole('button', { name: new RegExp(label) }));
      await button.scrollIntoViewIfNeeded();
      await button.click();
      return finish(id, startedAt, { outcome: 'success', visibleMessage: label });
    } catch (error) {
      return fail(id, startedAt, error);
    }
  }

  async function doubleClick(action = {}) {
    const id = actionId(action);
    const startedAt = new Date().toISOString();
    const params = actionParams(action);
    try {
      const text = requiredText(params.text, 'double-click text');
      const locator = params.role
        ? page().getByRole(requiredText(params.role, 'double-click role'), {
          name: text,
          exact: params.exact !== false
        })
        : page().getByText(text, { exact: params.exact !== false });
      const target = await firstVisible(locator);
      await target.dblclick();
      return finish(id, startedAt, { outcome: 'success', visibleMessage: text });
    } catch (error) {
      return fail(id, startedAt, error);
    }
  }

  async function cancelDialog(action = {}) {
    const id = actionId(action);
    const startedAt = new Date().toISOString();
    const params = actionParams(action);
    try {
      await driver.configureDialogs({ openFiles: [[]], openDirectories: [[]], saveFiles: [''] });
      if (params.buttonName) {
        await page().getByRole('button', { name: new RegExp(escapeRegExp(String(params.buttonName))) }).first().click();
      } else {
        await page().keyboard.press('Escape');
      }
      return finish(id, startedAt, {
        outcome: 'cancelled',
        visibleMessage: 'AUTOMATED_DIALOG_ROUTE: 用户取消'
      });
    } catch (error) {
      return fail(id, startedAt, error);
    }
  }

  async function fill({ label, value, exact = false } = {}) {
    const fieldLabel = requiredText(label, 'field label');
    const field = await firstVisible(page().getByLabel(fieldLabel, { exact }));
    await field.scrollIntoViewIfNeeded();
    await field.fill(String(value ?? ''));
  }

  async function choose({ label, value, text, exact = false } = {}) {
    const fieldLabel = requiredText(label, 'choice label');
    const field = await firstVisible(page().getByLabel(fieldLabel, { exact }));
    await field.scrollIntoViewIfNeeded();
    if (text !== undefined) await field.selectOption({ label: String(text) });
    else await field.selectOption(String(value ?? ''));
  }

  async function click({ name, role = 'button', exact = false } = {}) {
    const accessibleName = requiredText(name, 'visible control name');
    const control = await firstVisible(page().getByRole(role, { name: accessibleName, exact }));
    await control.scrollIntoViewIfNeeded();
    await control.click();
  }

  async function confirm({ name = '确认', exact = false } = {}) {
    return click({ name, role: 'button', exact });
  }

  async function perform(action, _context = {}) {
    if (!action || typeof action !== 'object' || Array.isArray(action)) throw new TypeError('action is required');
    if (action.type === 'login') return login(action);
    if (action.type === 'navigate') return navigate(action);
    if (action.type === 'restart') return restart(action);
    if (['importFile', 'importFolder', 'restore', ...SAVE_ACTIONS].includes(action.type)) return routeAndClick(action);
    if (['selectRequest', 'selectSamples', 'assignChannels'].includes(action.type)) return clickTexts(action);
    if (action.type === 'search') return search(action);
    if (action.type === 'paginate') return paginate(action);
    if (action.type === 'doubleClick') return doubleClick(action);
    if (action.type === 'cancelDialog') return cancelDialog(action);
    return clickNamed(action);
  }

  return Object.freeze({
    login,
    navigate,
    restart,
    perform,
    search,
    paginate,
    doubleClick,
    cancelDialog,
    fill,
    choose,
    click,
    confirm
  });
}
