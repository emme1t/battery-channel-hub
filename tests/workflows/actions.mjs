import { WORKFLOW_OUTCOMES } from './contracts.mjs';
import { isDeepStrictEqual } from 'node:util';
import path from 'node:path';
import { mkdir, readdir, stat } from 'node:fs/promises';

import { importRequests } from '../../src/domain/legacy-request-transactions.mjs';
import { parseFolder } from '../../src/main/excel-service.mjs';

const OUTCOMES = new Set(WORKFLOW_OUTCOMES);
const SUCCESS = Object.freeze(['success']);
const MUTATION_OUTCOMES = Object.freeze(['success', 'warning', 'cancelled', 'rejected', 'failure']);
const FILE_OUTCOMES = Object.freeze(['success', 'cancelled', 'rejected', 'failure']);
const REJECTION_OUTCOMES = Object.freeze(['rejected', 'failure']);
const OUTCOME_REVISION_ACTIONS = new Set(['exportLog', 'exportRequest', 'backup', 'restore']);
const NON_MUTATING_OUTCOMES = new Set(['cancelled', 'rejected']);
const BUSINESS_ENTITY_COLLECTIONS = Object.freeze([
  'requests', 'samples', 'channels', 'deviceProfiles', 'records',
  'storageRecords', 'requestSourceRows', 'testers', 'auditLogs', 'formChangeJournal'
]);
const NAVIGATION_PAGES = Object.freeze({
  '看板': 'dashboard', '通道看板': 'dashboard', dashboard: 'dashboard',
  '已预约': 'reserved', reserved: 'reserved',
  '预约': 'apply', '开始预约测试': 'apply', '开始/预约测试': 'apply', apply: 'apply',
  '申请': 'requests', '测试申请表格': 'requests', requests: 'requests',
  '日志': 'records', records: 'records',
  '正在测试样品': 'runningSamples', runningSamples: 'runningSamples',
  '长期存储样品': 'storageSamples', storageSamples: 'storageSamples',
  '设备': 'devices', '设备与通道': 'devices', devices: 'devices',
  '及时率': 'timeliness', timeliness: 'timeliness',
  '测试人员': 'testers', testers: 'testers'
});
const KNOWN_PAGES = new Set([...Object.values(NAVIGATION_PAGES), 'reserved', 'testers']);
const PAGER_VIEWS = new Set(['records', 'audits', 'channels', 'todo', 'request', 'sample', 'channel']);
const RETAINED_ACTION_TYPES = new Set(['manageRunning', 'startTodo', 'cancelTodo', 'staleSubmit']);
const BUSINESS_PAGES = Object.freeze({
  search: params => params.targetPage ? [params.targetPage] : null,
  importRequest: ['requests'], editExecution: ['requests'], deleteRequest: ['requests'], exportRequest: ['requests'],
  reserve: ['apply'], startImmediately: ['apply'],
  selectSample: params => params.requestNo !== undefined ? ['apply'] : null,
  startTodo: ['dashboard', 'reserved'], cancelTodo: ['dashboard', 'reserved'],
  manageRunning: ['records'], finishRunning: ['records'], delayRunning: ['records'], exportLog: ['records'],
  startStorage: ['apply'],
  updateStorage: ['storageSamples'], finishStorage: ['storageSamples'], returnStorage: ['storageSamples'],
  returnRunning: ['runningSamples'],
  createTester: ['testers'], renameTester: ['testers'], deleteTester: ['testers'],
  createDevice: ['devices'], createChannel: ['devices'], deleteResource: ['devices'],
  backup: ['dashboard'], restore: ['dashboard'],
  staleSubmit: params => params.session === 'B' ? null : [params.targetPage || (params.operation === 'manageRunning' ? 'records' : 'apply')],
  lockedWrite: params => [params.operation === 'manageRunning' ? 'records' : 'apply']
});

function encodedAttribute(value) {
  return String(value).replaceAll('\\', '\\\\').replaceAll('"', '\\"');
}

function regexEscape(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function missing(value) {
  return value === undefined || value === null || value === '' || (Array.isArray(value) && value.length === 0);
}

function revisionOf(ui) {
  const value = ui?.projection?.summary?.revision ?? ui?.summary?.revision;
  return Number.isInteger(value) ? value : null;
}

function projectionAtRevision(ui, revision) {
  if (!Number.isInteger(revision)) throw new Error('persisted revision is required');
  const snapshot = structuredClone(ui);
  if (!snapshot?.projection?.summary) throw new Error('cached UI projection summary is required');
  snapshot.projection.summary.revision = revision;
  return deepFreeze(snapshot);
}

function expectedDeltas(value) {
  const values = Array.isArray(value) ? value : [value];
  if (values.length === 0 || values.some(item => !Number.isInteger(item))) throw new TypeError('revisionDelta must contain integers');
  return values;
}

function actionError(type, stage, message, cause) {
  return new Error(`[${type}] ${stage}: ${message}`, cause ? { cause } : undefined);
}

function deepFreeze(value, seen = new WeakSet()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return value;
  seen.add(value);
  for (const key of Reflect.ownKeys(value)) deepFreeze(value[key], seen);
  return Object.freeze(value);
}

function immutableSnapshot(value) {
  return deepFreeze(structuredClone(value));
}

function runtimeFor(context) {
  return context?.runtime && typeof context.runtime === 'object' ? context.runtime : null;
}

function retainedKey(type, sampleId) {
  return `${type}:${sampleId}`;
}

function staleDraftKey(session = 'B', operation = 'reserve') {
  return `${session}:${operation}`;
}

function sameStringArray(left, right) {
  return Array.isArray(left) && Array.isArray(right)
    && left.length === right.length
    && left.every((value, index) => value === right[index]);
}

function matchesStaleDraft(draft, params) {
  if (!draft || draft.operation !== (params.operation || 'reserve')) return false;
  if (draft.operation !== 'reserve') return false;
  return draft.params.requestNo === params.requestNo
    && sameStringArray(draft.params.sampleIds, params.sampleIds)
    && sameStringArray(draft.params.channelKeys, params.channelKeys)
    && String(draft.params.start || '') === String(params.start || '')
    && String(draft.params.end || '') === String(params.end || '');
}

function retainedHandle(context, type, sampleId) {
  const handles = runtimeFor(context)?.retainedDom;
  return handles instanceof Map ? handles.get(retainedKey(type, sampleId)) : null;
}

function stateOf(snapshot) {
  const state = snapshot?.state;
  const collections = ['requests', 'samples', 'channels', 'deviceProfiles', 'records', 'storageRecords', 'testers'];
  return state && typeof state === 'object' && collections.every(key => Array.isArray(state[key])) ? state : null;
}

function persistenceBoundaryFromSnapshot(snapshot) {
  const state = stateOf(snapshot);
  const revision = state?.revision ?? snapshot?.summary?.revision;
  if (!state || !Number.isInteger(revision)) throw new Error('fresh persisted snapshot is required');
  return deepFreeze({
    revision,
    auditIds: (state.auditLogs || []).map(item => String(item?.id || '')).filter(Boolean),
    state: immutableSnapshot(state)
  });
}

function projectionOf(ui) {
  const projection = ui?.projection;
  if (!projection || !KNOWN_PAGES.has(projection.currentPage) || !projection.visible || typeof projection.visible !== 'object') return null;
  return projection;
}

function activeRecord(state, sampleId, status) {
  const records = state.records.filter(record => String(record.sampleId || '') === String(sampleId) && record.status === status);
  if (records.length !== 1) return null;
  const record = records[0];
  const sample = state.samples.find(item => String(item.id) === String(sampleId));
  const channel = state.channels.find(item => String(item.key) === String(record.channelKey || record.keys?.[0] || ''));
  const pointer = status === 'reserved' ? 'nextRecordId' : 'currentRecordId';
  return sample?.status === status && channel && String(channel[pointer] || '') === String(record.id) ? record : null;
}

function actionAvailable(type, snapshot, ui, params, context) {
  const override = context?.availability?.[type];
  if (override === false || runtimeFor(context)?.poisoned) return false;
  if (typeof override === 'function') return override(snapshot, ui, params, context);
  const state = stateOf(snapshot);
  const projection = projectionOf(ui);
  if (!state || !projection) return false;
  const page = projection.currentPage;
  if (type === 'navigate') return Boolean(NAVIGATION_PAGES[String(params.label || '')]);
  if (['search', 'filter', 'focusBlur', 'restart'].includes(type)) return true;
  if (type === 'expand' && params.requestNo !== undefined) return page === 'apply' && Boolean(runtimeFor(context))
    && state.requests.some(item => item.id === params.requestNo)
    && params.sampleIds?.every(id => state.samples.some(item => item.id === id && item.status === 'pending'))
    && params.channelKeys?.every(key => state.channels.some(item => item.key === key));
  if (['expand', 'collapse'].includes(type)) return page === 'dashboard' && state.deviceProfiles.some(item => item.name === params.device);
  if (['nextPage', 'previousPage'].includes(type)) {
    if (!PAGER_VIEWS.has(params.view)) return false;
    return ({ records: 'records', audits: 'records', channels: 'devices', todo: 'dashboard', request: 'apply', sample: 'apply', channel: 'apply' })[params.view] === page;
  }
  if (['selectSample', 'unselectSample'].includes(type)) {
    const pending = state.samples.some(item => item.id === params.sampleId && item.status === 'pending');
    return pending && (page === 'apply' || (type === 'selectSample' && params.requestNo !== undefined));
  }
  if (type === 'selectChannel') return page === 'apply' && state.channels.some(item => item.key === params.channelKey);
  if (type === 'unselectChannel') return false;
  if (type === 'importRequest') return true;
  if (['editExecution', 'deleteRequest', 'exportRequest'].includes(type)) return type === 'exportRequest' || state.requests.some(item => String(item.id) === String(params.requestNo));
  if (['reserve', 'startImmediately'].includes(type)) return params.sampleIds.every(id => state.samples.some(item => item.id === id && item.status === 'pending')) && params.channelKeys.every(key => state.channels.some(item => item.key === key));
  if (['startTodo', 'cancelTodo', 'manageRunning'].includes(type) && params.old === true) return Boolean(retainedHandle(context, type, params.sampleId));
  if (['startTodo', 'cancelTodo'].includes(type)) return Boolean(activeRecord(state, params.sampleId, 'reserved'));
  if (['manageRunning', 'finishRunning', 'delayRunning'].includes(type)) return Boolean(activeRecord(state, params.sampleId, 'running'));
  if (type === 'startStorage') {
    const activeSampleIds = new Set([
      ...state.records.filter(record => ['running', 'reserved'].includes(record.status)).map(record => String(record.sampleId || '')),
      ...state.storageRecords.filter(record => ['storing', 'exception'].includes(record.status)).flatMap(record => record.sampleIds || []).map(String)
    ]);
    return state.requests.some(item => String(item.id ?? item.requestNo ?? '') === String(params.requestNo))
      && String(params.tester || '') === String(state.username || '')
      && params.sampleIds?.every(id => state.samples.some(item => String(item.id) === String(id)
        && item.status === 'pending' && String(item.requestNo || '') === String(params.requestNo)) && !activeSampleIds.has(String(id)))
      && !state.storageRecords.some(item => String(item.id) === String(params.storageId));
  }
  if (['updateStorage', 'finishStorage', 'returnStorage'].includes(type)) {
    const records = state.storageRecords.filter(item => String(item.id) === String(params.storageId)
      && ['storing', 'exception'].includes(item.status));
    return records.length === 1;
  }
  if (type === 'returnRunning') return Boolean(activeRecord(state, params.sampleId, 'running'));
  if (type === 'createTester') return true;
  if (['renameTester', 'deleteTester'].includes(type)) return state.testers.some(item => item.name === params.name);
  if (['createDevice', 'createChannel'].includes(type)) return true;
  if (type === 'deleteResource') return params.kind === 'device'
    ? state.deviceProfiles.some(item => item.name === params.name)
    : state.channels.some(item => item.key === params.name || item.name === params.name);
  if (['exportLog', 'backup', 'restore'].includes(type)) return true;
  if (type === 'staleSubmit') {
    if (params.old === true) return Boolean(retainedHandle(context, type, params.sampleId));
    if (params.session !== 'B') return true;
    const drafts = runtimeFor(context)?.staleDrafts;
    return drafts instanceof Map && matchesStaleDraft(drafts.get(staleDraftKey(params.session, params.operation)), params);
  }
  if (type === 'lockedWrite') return true;
  if (type === 'editDraft') return Boolean(runtimeFor(context)) && (params.requestNo === undefined || (page === 'apply'
    && state.requests.some(item => item.id === params.requestNo)
    && params.sampleIds?.every(id => state.samples.some(item => item.id === id && item.status === 'pending'))
    && params.channelKeys?.every(key => state.channels.some(item => item.key === key))));
  if (['assertDraftDiscarded', 'assertDraftPreserved'].includes(type)) return Boolean(runtimeFor(context)?.draft);
  if (['reloadCurrent', 'openSecondSession', 'closeSecondSession', 'retainOldDom'].includes(type)) return Boolean(runtimeFor(context));
  return false;
}

export function normalizeSettlement(write, settlement) {
  if (!write) return undefined;
  if (!settlement || !['boundary', 'audit-chain'].includes(settlement.mode)) {
    throw new TypeError('write action settlement is required');
  }
  if (typeof settlement.audits !== 'function') {
    throw new TypeError(`${settlement.mode} settlement requires explicit audits resolver`);
  }
  return Object.freeze({ ...settlement });
}

function define(type, {
  write,
  settlement,
  revisionDelta,
  evidenceRevisionDelta,
  available,
  execute,
  maxMs,
  allowedOutcomes,
  required = [],
  validate
}) {
  const definition = {
    type,
    write,
    settlement: normalizeSettlement(write, settlement),
    revisionDelta: Array.isArray(revisionDelta) ? Object.freeze([...revisionDelta]) : revisionDelta,
    available: available || ((snapshot, ui, params, context) => actionAvailable(type, snapshot, ui, params, context)),
    execute,
    maxMs,
    allowedOutcomes: Object.freeze([...allowedOutcomes])
  };
  if (evidenceRevisionDelta !== undefined) {
    definition.evidenceRevisionDelta = Array.isArray(evidenceRevisionDelta)
      ? Object.freeze([...evidenceRevisionDelta])
      : evidenceRevisionDelta;
  }
  Object.defineProperties(definition, {
    required: { value: Object.freeze([...required]), enumerable: false },
    validate: { value: validate, enumerable: false }
  });
  return Object.freeze(definition);
}

function pageFor(driver, params, context) {
  if (params?.session === 'B') {
    const runtime = runtimeFor(context);
    const draft = runtime?.staleDrafts instanceof Map
      ? runtime.staleDrafts.get(staleDraftKey(params.session, params.operation))
      : null;
    const active = runtime?.secondDriver || draft?.activeDriver || draft?.driver;
    if (!active) throw new Error('second session is not open');
    return draft?.page || active.page();
  }
  return driver.page();
}

function driverFor(driver, params, context) {
  if (params?.session === 'B') {
    const runtime = runtimeFor(context);
    const draft = runtime?.staleDrafts instanceof Map
      ? runtime.staleDrafts.get(staleDraftKey(params.session, params.operation))
      : null;
    const active = runtime?.secondDriver || draft?.activeDriver || draft?.driver;
    if (!active) throw new Error('second session is not open');
    return active;
  }
  return driver;
}

async function unique(locator, label) {
  const count = await locator.count();
  if (count !== 1) throw new Error(`${label} must resolve exactly once; actual ${count}`);
  return locator;
}

async function click(locator, double = false, label = 'locator') {
  await unique(locator, label);
  if (double) await locator.dblclick({ delay: 0 });
  else await locator.click();
}

async function clickable(locator, label) {
  await unique(locator, label);
  if (typeof locator.isDisabled === 'function' && await locator.isDisabled()) return false;
  return true;
}

async function fillOptional(page, label, value, { exact = true } = {}) {
  if (value === undefined) return;
  const field = await unique(page.getByLabel(label, { exact }), `field ${label}`);
  await field.fill(String(value));
}

function datetimeLocal(value) {
  if (value === undefined || value === '') return value;
  const source = String(value);
  if (/^\d{4}-\d{2}-\d{2}$/.test(source)) return `${source}T00:00`;
  const match = source.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2})/);
  if (!match) throw new TypeError('datetime-local value must be YYYY-MM-DDTHH:mm or date-only');
  return match[1];
}

export function datetimeLocalInstant(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new TypeError('datetime instant must be parseable');
  const pad = number => String(number).padStart(2, '0');
  return `${String(date.getFullYear()).padStart(4, '0')}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function offsetDateTimeLocal(record, offsetMinutes) {
  const start = Date.parse(record?.actualStart ?? record?.start ?? record?.time ?? '');
  const end = new Date(start + offsetMinutes * 60_000);
  if (!Number.isFinite(start) || !Number.isFinite(end.getTime())) {
    throw new TypeError('active record start must be a parseable datetime');
  }
  const pad = value => String(value).padStart(2, '0');
  return `${String(end.getFullYear()).padStart(4, '0')}-${pad(end.getMonth() + 1)}-${pad(end.getDate())}T${pad(end.getHours())}:${pad(end.getMinutes())}`;
}

function armConfirmSequence(page, answers) {
  const queue = [...answers];
  const handled = [];
  if (queue.length === 0 || typeof page.on !== 'function') {
    const cleanup = () => undefined;
    cleanup.handledAnswers = () => Object.freeze([]);
    return cleanup;
  }
  const handler = async dialog => {
    if (queue.length === 0) return dialog.dismiss();
    const answer = queue.shift();
    if (answer) await dialog.accept(); else await dialog.dismiss();
    handled.push(answer);
  };
  page.on('dialog', handler);
  const cleanup = () => page.off?.('dialog', handler);
  cleanup.handledAnswers = () => Object.freeze([...handled]);
  return cleanup;
}

async function visibleMessage(page) {
  const status = page.locator('[role="status"], .toast.show, .legacy-inline-message');
  try {
    if (await status.count() > 0 && await status.isVisible()) return String(await status.textContent() || '').trim();
  } catch {
    // A success path is allowed to have no transient message.
  }
  return '';
}

async function messageState(page, context) {
  if (typeof context?.messageStateReader === 'function') return context.messageStateReader(page);
  try {
    const state = await page.evaluate(() => {
      const selector = '[role="status"], .toast, .legacy-inline-message';
      if (!globalThis.__workflowActionMessageProbe) {
        const probe = { version: 0, nextInstance: 1, instances: new WeakMap() };
        const touchesMessage = node => node instanceof Element && (node.matches(selector) || node.closest(selector) || node.querySelector(selector));
        probe.observer = new MutationObserver(mutations => {
          if (mutations.some(mutation => touchesMessage(mutation.target) || [...mutation.addedNodes, ...mutation.removedNodes].some(touchesMessage))) probe.version += 1;
        });
        probe.observer.observe(document.documentElement, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['class', 'hidden', 'style'] });
        globalThis.__workflowActionMessageProbe = probe;
      }
      const elements = [...document.querySelectorAll(selector)];
      const isVisible = item => {
        if (!(item instanceof Element) || item.getClientRects().length === 0) return false;
        const style = getComputedStyle(item);
        return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) !== 0;
      };
      const visibleElement = elements.find(isVisible);
      const element = visibleElement || elements[0];
      let instance = null;
      if (element) {
        instance = globalThis.__workflowActionMessageProbe.instances.get(element);
        if (!instance) {
          instance = `message-${globalThis.__workflowActionMessageProbe.nextInstance++}`;
          globalThis.__workflowActionMessageProbe.instances.set(element, instance);
        }
      }
      return { version: globalThis.__workflowActionMessageProbe.version, text: String(element?.textContent || '').trim(), visible: Boolean(visibleElement), instance };
    });
    if (state && Number.isInteger(state.version) && typeof state.text === 'string') return state;
  } catch { /* fall through to the driver-compatible text probe */ }
  const text = await visibleMessage(page);
  return { version: null, text, visible: Boolean(text), instance: null };
}

function freshMessage(before, after) {
  if (!after?.text) return false;
  if (String(after.text) !== String(before?.text || '')) {
    if (after.visible !== false) return true;
    return before?.instance !== null && before?.instance !== undefined
      && before.instance === after.instance
      && Number.isInteger(before?.version) && Number.isInteger(after?.version)
      && after.version > before.version;
  }
  if (after.visible === false) return false;
  if (before?.visible === false && after.visible === true) return true;
  return before?.instance !== null && before?.instance !== undefined
    && after.instance !== null && after.instance !== undefined
    && before.instance !== after.instance;
}

function outcomeFromMessage(message) {
  const text = String(message || '').trim();
  if (!text) return null;
  if (/\b(cancelled|canceled)\b|已取消|取消了/.test(text)) return 'cancelled';
  if (/REVISION_CONFLICT|修订冲突|数据已被其它操作更新|数据已(?:更新|变化)|重新加载/i.test(text)) return 'rejected';
  if (/\bwarning\b|警告|冲突|重叠/i.test(text)) return 'warning';
  if (/\brejected\b|\bdatabase is locked\b|拒绝|阻断|不能|不允许|无法|已变化|未(?:发生)?变化|重新加载|锁定|占用/.test(text)) return 'rejected';
  if (/\bfailure\b|\bfailed\b|失败|异常|错误/.test(text)) return 'failure';
  if (/\bsuccess\b|成功|已保存|已开始|已结束|已预约|已导出|已恢复|已删除|已延期/.test(text)) return 'success';
  return null;
}

async function clickAndRead(driver, locator, params, context, options = {}) {
  const beforeMessage = await messageState(driver.page(), context);
  await click(locator, Boolean(params?.double), options.label || 'write target');
  const explicitOutcome = typeof options.outcome === 'function'
    ? await options.outcome()
    : options.outcome;
  if (explicitOutcome) {
    return {
      outcome: explicitOutcome,
      message: String(options.message || ''),
      evidenceBaseUi: options.evidenceBaseUi,
      cleanup: options.cleanup
    };
  }
  return { awaitEvidence: true, evidence: options.evidence, evidenceBaseUi: options.evidenceBaseUi, beforeMessage, cleanup: options.cleanup };
}

async function wait(ms) {
  await new Promise(resolve => setTimeout(resolve, ms));
}

async function boundedOperation(operation, timeoutMs, message) {
  let timer;
  try {
    return await Promise.race([
      operation,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), timeoutMs); })
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function waitForEvidence({ driver, beforeUi, allowedDeltas, context, result, deadline }) {
  let lastUi = beforeUi;
  let lastMessage = '';
  let lastMessageState = null;
  do {
    if (typeof context?.outcomeReader === 'function') {
      const seam = await context.outcomeReader(driver);
      if (seam !== undefined && seam !== null) return { outcome: seam, message: `test seam: ${seam}`, uiEvidence: await driver.uiProjection() };
    }
    try { lastUi = await driver.uiProjection(); } catch { /* driver may be closing after an explicit rejection */ }
    let currentMessage;
    try {
      currentMessage = await messageState(driver.page(), context);
      lastMessage = currentMessage.text;
      lastMessageState = currentMessage;
    } catch { /* preserve prior message */ }
    const messageOutcome = freshMessage(result.beforeMessage, currentMessage) ? outcomeFromMessage(lastMessage) : null;
    if (messageOutcome) return { outcome: messageOutcome, message: lastMessage, uiEvidence: lastUi };
    const beforeRevision = revisionOf(beforeUi);
    const afterRevision = revisionOf(lastUi);
    if (beforeRevision !== null && afterRevision !== null) {
      const delta = afterRevision - beforeRevision;
      if (delta !== 0 && allowedDeltas.includes(delta)) return { outcome: 'success', message: `revision advanced by ${delta}`, uiEvidence: lastUi };
    }
    if (typeof result.evidence === 'function') {
      const evidence = await result.evidence(lastUi);
      if (evidence === true) return { outcome: 'success', message: 'target state changed', uiEvidence: lastUi };
      if (evidence && typeof evidence === 'object' && OUTCOMES.has(evidence.outcome)) {
        return { ...evidence, uiEvidence: lastUi, message: String(evidence.message || '') };
      }
    }
    await wait(5);
  } while (Date.now() + 5 < deadline);
  throw new Error(`no fresh explicit outcome evidence; last message: ${lastMessage || '<empty>'}; before=${JSON.stringify(result.beforeMessage)}; after=${JSON.stringify(lastMessageState)}`);
}

function validateString(value, name) {
  if (typeof value !== 'string' || value.trim() === '') throw new TypeError(`${name} must be a non-empty string`);
}

function validateStringArray(value, name) {
  if (!Array.isArray(value) || value.length === 0 || value.some(item => typeof item !== 'string' || item.trim() === '')) {
    throw new TypeError(`${name} must be a non-empty string array`);
  }
}

function validateBooleanIfPresent(params, name) {
  if (params[name] !== undefined && typeof params[name] !== 'boolean') throw new TypeError(`${name} must be boolean`);
}

function validateActionParams(type, params) {
  const stringParams = [
    'requestNo', 'sampleId', 'channelKey', 'label', 'name', 'nextName',
    'device', 'role', 'path', 'preBackupPath', 'end', 'start', 'note', 'condition', 'targetPage', 'actionType',
    'storageId', 'expectedEndAt', 'reason', 'status', 'tester'
  ];
  for (const name of stringParams) {
    if (type === 'reserve' && name === 'end' && params[name] === '') continue;
    if (params[name] !== undefined) validateString(params[name], name);
  }
  if (params.value !== undefined) {
    if (type === 'filter' && params.control === 'checkbox') {
      if (typeof params.value !== 'boolean') throw new TypeError('checkbox value must be boolean');
    } else if (type === 'search') {
      if (typeof params.value !== 'string') throw new TypeError('value must be a string');
    } else {
      validateString(params.value, 'value');
    }
  }
  if (params.session !== undefined && !['A', 'B'].includes(params.session)) throw new TypeError('session must be A or B');
  for (const name of ['confirm', 'double', 'cancel', 'old', 'invalidConfirm', 'usePrepared']) validateBooleanIfPresent(params, name);
  if (params.paths !== undefined) validateStringArray(params.paths, 'paths');
  if (params.sampleIds !== undefined) validateStringArray(params.sampleIds, 'sampleIds');
  if (params.expectedVisibleIds !== undefined) validateStringArray(params.expectedVisibleIds, 'expectedVisibleIds');
  if (params.excludedVisibleIds !== undefined) validateStringArray(params.excludedVisibleIds, 'excludedVisibleIds');
  if (params.channelKeys !== undefined) validateStringArray(params.channelKeys, 'channelKeys');
  if (params.actor !== undefined) validateString(params.actor, 'actor');
  if (params.endOffsetMinutes !== undefined && (!Number.isSafeInteger(params.endOffsetMinutes) || params.endOffsetMinutes <= 0)) {
    throw new TypeError('endOffsetMinutes must be a positive safe integer');
  }
  if (params.duplicatePolicy !== undefined && !['skip', 'cover'].includes(params.duplicatePolicy)) throw new TypeError('duplicatePolicy must be skip or cover');
  if (type === 'importRequest' && params.kind !== undefined && !['file', 'folder', 'directory'].includes(params.kind)) throw new TypeError('kind must be file, folder or directory');
  if (type === 'lockedWrite' && !['reserve', 'manageRunning'].includes(params.operation)) throw new TypeError('operation must be reserve or manageRunning');
  if (type === 'staleSubmit' && params.operation !== undefined && !['reserve', 'manageRunning'].includes(params.operation)) throw new TypeError('operation must be reserve or manageRunning');
  if (type === 'search' && params.identity !== undefined && !['requestNo', 'sampleId'].includes(params.identity)) throw new TypeError('identity must be requestNo or sampleId');
  if (type === 'updateStorage' && params.status !== undefined && !['storing', 'exception'].includes(params.status)) throw new TypeError('status must be storing or exception');
  if (params.targetPage !== undefined && !new Set(Object.values(NAVIGATION_PAGES)).has(params.targetPage)) throw new TypeError('targetPage must identify a navigable page');
  if (type === 'retainOldDom' && params.targets !== undefined) {
    if (!Array.isArray(params.targets) || params.targets.length === 0) throw new TypeError('targets must be a non-empty array');
    for (const target of params.targets) {
      if (!target || typeof target !== 'object' || Array.isArray(target) || !['manageRunning', 'startTodo', 'cancelTodo'].includes(target.type)) throw new TypeError('target type must identify a retainable M11 action');
      validateString(target.sampleId, 'target sampleId');
      if (target.channelKey !== undefined) validateString(target.channelKey, 'target channelKey');
    }
  }
  if (type === 'openSecondSession' && params.prepareStale !== undefined) {
    const prepare = params.prepareStale;
    if (!prepare || typeof prepare !== 'object' || Array.isArray(prepare) || Object.getPrototypeOf(prepare) !== Object.prototype) {
      throw new TypeError('prepareStale must be a plain object');
    }
    if (prepare.operation !== undefined && prepare.operation !== 'reserve') throw new TypeError('prepareStale operation must be reserve');
    validateString(prepare.requestNo, 'prepareStale requestNo');
    validateStringArray(prepare.sampleIds, 'prepareStale sampleIds');
    validateStringArray(prepare.channelKeys, 'prepareStale channelKeys');
    if (prepare.sampleIds.length !== prepare.channelKeys.length) throw new TypeError('prepareStale sampleIds and channelKeys length mismatch');
    for (const name of ['start', 'end', 'note', 'username']) {
      if (prepare[name] !== undefined) validateString(prepare[name], `prepareStale ${name}`);
    }
  }
  if (type === 'deleteResource' && !['device', 'channel'].includes(params.kind)) throw new TypeError('resource kind must be device or channel');
  if (['nextPage', 'previousPage'].includes(type) && !PAGER_VIEWS.has(params.view)) throw new TypeError('view must identify a supported pager');
  if (['expand', 'collapse'].includes(type) && params.requestNo === undefined) validateString(params.device, 'device');
  if (type === 'filter' && params.control !== undefined && !['fill', 'select', 'checkbox'].includes(params.control)) throw new TypeError('control must be fill, select or checkbox');
  if (params.selector !== undefined) {
    validateString(params.selector, 'selector');
    if (!/^\[data-(?:bounded-filter|bounded-action|legacy-action|dashboard-action|testid)="[^"\\]+"\](?:\[data-[a-z0-9-]+="[^"\\]+"\])*$/.test(params.selector)) {
      throw new TypeError('selector must be a stable data-* selector');
    }
  }
  if (params.fields !== undefined) {
    if (!params.fields || typeof params.fields !== 'object' || Array.isArray(params.fields) || Object.getPrototypeOf(params.fields) !== Object.prototype) {
      throw new TypeError('fields must be a plain object');
    }
    for (const [label, value] of Object.entries(params.fields)) {
      validateString(label, 'field label');
      if (!['string', 'number', 'boolean'].includes(typeof value) || (typeof value === 'number' && !Number.isFinite(value))) {
        throw new TypeError(`field ${label} must contain a fillable scalar`);
      }
    }
  }
  if (params.recordIndex !== undefined && (!Number.isInteger(params.recordIndex) || params.recordIndex < 0)) throw new TypeError('recordIndex must be a non-negative integer');
  if (params.expectedValidCount !== undefined && (!Number.isSafeInteger(params.expectedValidCount) || params.expectedValidCount <= 0)) {
    throw new TypeError('expectedValidCount must be a positive safe integer');
  }
  if (params.expectedPointers !== undefined) {
    const value = params.expectedPointers;
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('expectedPointers must be an object');
    validateString(value.channelKey, 'expectedPointers channelKey');
    for (const name of ['currentRecordId', 'nextRecordId', 'currentSampleId', 'nextSampleId']) {
      if (value[name] !== null && value[name] !== undefined) validateString(value[name], `expectedPointers ${name}`);
    }
  }
  if (['reserve', 'startImmediately'].includes(type) || (type === 'editDraft' && params.requestNo !== undefined)) {
    validateString(params.requestNo, 'requestNo');
    validateStringArray(params.sampleIds, 'sampleIds');
    validateStringArray(params.channelKeys, 'channelKeys');
    if (params.sampleIds.length !== params.channelKeys.length) throw new TypeError('sampleIds and channelKeys length mismatch');
  }
  if (['lockedWrite', 'staleSubmit'].includes(type) && params.old !== true) {
    const operation = params.operation || 'reserve';
    if (operation === 'reserve') {
      validateString(params.requestNo, 'requestNo');
      validateStringArray(params.sampleIds, 'sampleIds');
      validateStringArray(params.channelKeys, 'channelKeys');
      if (params.sampleIds.length !== params.channelKeys.length) throw new TypeError('sampleIds and channelKeys length mismatch');
    } else {
      validateString(params.sampleId, 'sampleId');
      if (params.channelKey !== undefined) validateString(params.channelKey, 'channelKey');
    }
  }
}

function stableAction(page, name, attributes = {}) {
  const suffix = Object.entries(attributes)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `[data-${key}="${encodedAttribute(value)}"]`)
    .join('');
  return page.locator(`[data-legacy-action="${name}"]${suffix}`);
}

function boundedAction(page, name, attributes = {}) {
  const suffix = Object.entries(attributes)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `[data-${key}="${encodedAttribute(value)}"]`)
    .join('');
  return page.locator(`[data-bounded-action="${name}"]${suffix}`);
}

function pagerLocator(page, view, direction) {
  if (['records', 'audits', 'channels'].includes(view)) {
    return page.locator(`[data-bounded-action="page"][data-view="${view}"][data-direction="${direction}"]`);
  }
  if (view === 'todo') return page.locator(`[data-dashboard-action="todo-${direction}"]`);
  return page.locator(`[data-legacy-action="${view}-${direction}"]`);
}

function requireViewEvidence(evidence, view) {
  if (!evidence || evidence.view !== view) throw new Error(`${view} page evidence is unavailable`);
  for (const field of ['page', 'pageCount', 'rowCount', 'maxRows']) {
    if (!Number.isInteger(evidence[field]) || evidence[field] < (field === 'rowCount' ? 0 : 1)) {
      throw new Error(`${view} page evidence has invalid ${field}`);
    }
  }
  if (evidence.rowCount > evidence.maxRows || evidence.domWithinLimit !== true) {
    throw new Error(`${view} DOM row limit exceeded: ${evidence.rowCount}/${evidence.maxRows}`);
  }
  if (typeof evidence.token !== 'string' || evidence.token === '') throw new Error(`${view} page evidence token is unavailable`);
  return evidence;
}

async function pagedTransition(driver, target, view, direction) {
  if (typeof driver.viewEvidence !== 'function') throw new Error('driver viewEvidence capability is required');
  const before = requireViewEvidence(await driver.viewEvidence(view), view);
  await target.click();
  const expectedPage = before.page + (direction === 'next' ? 1 : -1);
  const deadline = Date.now() + 2_000;
  let after;
  do {
    after = requireViewEvidence(await driver.viewEvidence(view), view);
    if (after.page === expectedPage && after.token !== before.token) break;
    await wait(10);
  } while (Date.now() < deadline);
  if (after.page !== expectedPage) throw new Error(`${view} ${direction} expected page ${expectedPage}, actual ${after.page}`);
  if (after.token === before.token) throw new Error(`${view} ${direction} did not change the page token`);
  if (before.rowCount > 0 && after.rowCount > 0 && (after.first === before.first || after.last === before.last)) {
    throw new Error(`${view} ${direction} did not change first/last row identities`);
  }
  return Object.freeze({ view, direction, before, after });
}

async function ensureBusinessPage(driver, params, context, type) {
  const configured = BUSINESS_PAGES[type];
  const targets = typeof configured === 'function' ? configured(params, context) : configured;
  if (!targets) return context.ui;
  const active = driverFor(driver, params, context);
  const page = pageFor(driver, params, context);
  let ui = context.ui;
  let current = projectionOf(ui)?.currentPage;
  const operation = params.operation || '';
  const preparesRunningManagement = ['manageRunning', 'delayRunning'].includes(type)
    || (['staleSubmit', 'lockedWrite'].includes(type) && operation === 'manageRunning');
  const reenterCurrentRecordsPage = params.old !== true && current === 'records'
    && (preparesRunningManagement || type === 'finishRunning');
  if (!targets.includes(current) || reenterCurrentRecordsPage) {
    const target = targets[0];
    await click(page.locator(`.nav[data-page="${target}"]`), false, `${type} target page ${target}`);
    ui = await active.uiProjection();
    current = projectionOf(ui)?.currentPage;
    if (current !== target) throw new Error(`target page ${target} did not become active`);
  }
  if (type === 'createChannel') {
    const create = boundedAction(page, 'add-channel', { device: encodeURIComponent(params.device) });
    if (await create.count() === 0) {
      await click(page.locator('.nav[data-page="devices"]'), false, 'reenter devices for channel create');
      ui = await active.uiProjection();
      if (projectionOf(ui)?.currentPage !== 'devices') throw new Error('devices page did not become active after channel reentry');
    }
  }
  if (type === 'deleteResource' && params.kind === 'device') {
    const deleteEntry = boundedAction(page, 'delete-device');
    if (await deleteEntry.count() === 0) {
      await click(page.locator('.nav[data-page="devices"]'), false, 'reenter devices for device delete');
      ui = await active.uiProjection();
      if (projectionOf(ui)?.currentPage !== 'devices') throw new Error('devices page did not become active after device delete reentry');
    }
  }
  if (['startTodo', 'cancelTodo'].includes(type) && params.old !== true && current !== 'reserved') {
    await openTodoDetail(page, context.snapshot, params.sampleId, params.recordIndex);
    ui = await active.uiProjection();
    if (projectionOf(ui)?.currentPage !== 'reserved') throw new Error('reserved detail did not become active');
  }
  if (type === 'finishRunning' && params.old !== true) {
    await page.getByLabel('搜索申请、样品、项目、通道或人员', { exact: true }).fill(params.sampleId);
  }
  if (preparesRunningManagement && params.old !== true && projectionOf(ui)?.currentPage !== 'devices') {
    const { record } = activeRecordIndex(context.snapshot, params.sampleId, 'running');
    const channelKey = params.channelKey || record.channelKey || record.keys?.[0];
    const search = page.getByLabel('搜索申请、样品、项目、通道或人员', { exact: true });
    await search.fill(params.sampleId);
    const manage = boundedAction(page, 'manage-running', {
      'sample-id': encodeURIComponent(params.sampleId),
      'channel-key': encodeURIComponent(channelKey)
    });
    await click(manage, false, `prepare running management ${params.sampleId}`);
    ui = await active.uiProjection();
    if (projectionOf(ui)?.currentPage !== 'devices') throw new Error('running management page did not become active');
  }
  return ui;
}

function resolveSettlementValue(resolver, details) {
  return typeof resolver === 'function' ? resolver(details) : resolver;
}

async function waitForFinalPage(driver, expectedPage, remainingMs) {
  if (expectedPage === undefined) return undefined;
  if (typeof expectedPage !== 'string' || expectedPage.trim() === '') throw new TypeError('settlement finalPage must resolve to a non-empty string');
  const page = expectedPage.trim();
  if (!KNOWN_PAGES.has(page)) throw new TypeError(`settlement finalPage is unknown: ${page}`);
  const locator = driver.page().locator(`#${page}.page.active`);
  const timeout = remainingMs();
  await boundedOperation(locator.waitFor({ state: 'visible', timeout }), timeout, `final page ${page} timed out`);
  const ui = await boundedOperation(driver.uiProjection(), remainingMs(), `final page ${page} projection timed out`);
  const actual = projectionOf(ui)?.currentPage || '';
  if (actual !== page) throw new Error(`final page ${page} did not match projection; actual ${actual || '<unknown>'}`);
  return page;
}

function normalizeAuditDescriptors(value) {
  if (!Array.isArray(value)) throw new TypeError('settlement audits resolver must return an array');
  return value.map((descriptor, index) => {
    if (!descriptor || typeof descriptor !== 'object' || Array.isArray(descriptor)) throw new TypeError(`settlement audit ${index} must be an object`);
    if (typeof descriptor.action !== 'string' || descriptor.action.trim() === '') throw new TypeError(`settlement audit ${index} action is required`);
    const count = descriptor.count === undefined ? 1 : descriptor.count;
    if (!Number.isInteger(count) || count <= 0) throw new TypeError(`settlement audit ${index} count must be a positive integer`);
    return { ...descriptor, action: descriptor.action.trim(), count };
  });
}

function safeAuditId(value) {
  const id = String(value || '').trim();
  return id ? id.slice(0, 80).replace(/[^A-Za-z0-9._:-]/g, '?') : '<empty>';
}

function auditIdSummary(ids) {
  return ids.length ? ids.map(safeAuditId).join(',') : '<none>';
}

function auditMatchesDescriptor(audit, descriptor) {
  return String(audit?.action || '') === descriptor.action
    && (descriptor.actor === undefined || String(audit?.user ?? audit?.actor ?? '') === descriptor.actor)
    && (descriptor.target === undefined || String(audit?.target || '') === descriptor.target);
}

function completeAuditDelta(scope, persisted, { allowBaselineMutation = false, outcome = 'unknown' } = {}) {
  if (!Array.isArray(scope?.auditIds) || !Array.isArray(scope?.state?.auditLogs)) {
    throw new Error('before boundary audit evidence is unavailable');
  }
  if (!Array.isArray(persisted?.auditIds) || !Array.isArray(persisted?.state?.auditLogs)) {
    throw new Error('final boundary audit evidence is unavailable');
  }
  const beforeAudits = scope.state.auditLogs;
  const finalAudits = persisted.state.auditLogs;
  const validateIds = (audits, boundary) => {
    const ids = audits.map(item => String(item?.id || '').trim());
    const empty = ids.filter(id => !id);
    const seen = new Set();
    const duplicates = [];
    for (const id of ids) {
      if (!id) continue;
      if (seen.has(id) && !duplicates.includes(id)) duplicates.push(id);
      seen.add(id);
    }
    if (empty.length || duplicates.length) {
      throw new Error(`${boundary} audit IDs invalid; empty=${empty.length}; duplicate=${auditIdSummary(duplicates)}`);
    }
    return ids;
  };
  const beforeIds = validateIds(beforeAudits, 'before');
  const finalIds = validateIds(finalAudits, 'final');
  const validateBoundaryIds = (declared, stateIds, boundary) => {
    const ids = declared.map(value => String(value || '').trim());
    if (new Set(ids).size !== ids.length || ids.some(id => !id)) throw new Error(`${boundary} boundary auditIds are empty or duplicated`);
    if (stateIds.length !== ids.length || stateIds.some(id => !ids.includes(id))) throw new Error(`${boundary} boundary auditIds do not match ${boundary} state`);
  };
  validateBoundaryIds(scope.auditIds, beforeIds, 'before');
  validateBoundaryIds(persisted.auditIds, finalIds, 'final');
  if (!allowBaselineMutation) {
    const finalById = new Map(finalAudits.map(item => [String(item.id), item]));
    const missing = beforeAudits.filter(item => !finalById.has(String(item.id))).map(item => String(item.id));
    const changed = beforeAudits
      .filter(item => finalById.has(String(item.id)) && !isDeepStrictEqual(item, finalById.get(String(item.id))))
      .map(item => String(item.id));
    if (missing.length || changed.length) {
      throw new Error(`${outcome} requires immutable baseline audits; missing=${auditIdSummary(missing)}; changed=${auditIdSummary(changed)}`);
    }
  }
  const baseline = new Set(beforeIds);
  return finalAudits
    .filter((_, index) => !baseline.has(finalIds[index]))
    .map(item => immutableSnapshot(item))
    .sort((left, right) => String(left.id).localeCompare(String(right.id)));
}

function matchBoundaryAuditDescriptors(deltaAudits, descriptors) {
  const unmatched = new Set(deltaAudits.map((_, index) => index));
  const missing = [];
  for (const descriptor of descriptors) {
    for (let count = 0; count < descriptor.count; count += 1) {
      const match = [...unmatched].find(index => auditMatchesDescriptor(deltaAudits[index], descriptor));
      if (match === undefined) missing.push(`${descriptor.action}#${count + 1}`);
      else unmatched.delete(match);
    }
  }
  return {
    missing,
    extraIds: [...unmatched].map(index => String(deltaAudits[index]?.id || ''))
  };
}

export async function settleWorkflowAction({ driver, definition, params, outcome, scope, result, deadline, context }) {
  const type = definition.type;
  const contract = definition.settlement;
  const details = Object.freeze({ type, params, outcome, scope, result, context });
  const remainingMs = stage => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      const error = actionError(type, stage, 'timed out');
      error.code = 'ACTION_TIMEOUT';
      throw error;
    }
    return remaining;
  };
  const settleStage = async (stage, operation) => {
    const budget = Math.max(1, remainingMs(stage) - 10);
    try {
      return await boundedOperation(Promise.resolve().then(operation), budget, `[${type}] ${stage}: timed out`);
    } catch (error) {
      if (String(error?.message || '').startsWith(`[${type}] ${stage}:`)) {
        if (/timed out/.test(error.message)) error.code = 'ACTION_TIMEOUT';
        throw error;
      }
      throw actionError(type, stage, error.message || 'settlement failed', error);
    }
  };

  const finalPage = await settleStage('final-page', () => waitForFinalPage(
    driver,
    resolveSettlementValue(contract.finalPage, details),
    () => remainingMs('final-page')
  ));
  const declaredAuditIds = [];
  const afterAuditIds = [...scope.auditIds];
  let descriptors = [];
  if (contract.mode === 'audit-chain') {
    descriptors = normalizeAuditDescriptors(await settleStage('audit-resolver', () => resolveSettlementValue(contract.audits, details)));
    for (const descriptor of descriptors) {
      for (let index = 0; index < descriptor.count; index += 1) {
        const evidence = await settleStage('persisted-audit', () => driver.waitForPersistenceBarrier({
          auditAction: descriptor.action,
          ...(descriptor.actor === undefined ? {} : { actor: descriptor.actor }),
          ...(descriptor.target === undefined ? {} : { auditTarget: descriptor.target }),
          afterAuditIds: Object.freeze([...afterAuditIds]),
          timeoutMs: remainingMs('persisted-audit')
        }));
        const audit = evidence?.audit;
        const auditId = String(audit?.id || '');
        if (!auditId || String(audit?.action || '') !== descriptor.action
          || (descriptor.actor !== undefined && String(audit?.user ?? audit?.actor ?? '') !== descriptor.actor)
          || (descriptor.target !== undefined && String(audit?.target || '') !== descriptor.target)) {
          throw actionError(type, 'persisted-audit', `exact audit mismatch for ${descriptor.action}`);
        }
        declaredAuditIds.push(auditId);
        afterAuditIds.push(auditId);
      }
    }
  }

  const persisted = await settleStage('final-boundary', () => driver.capturePersistenceBoundary({ timeoutMs: remainingMs('final-boundary') }));
  const auditDelta = await settleStage('audit-delta', () => resolveControlledSettlementStage(
    context,
    'audit-delta',
    completeAuditDelta(scope, persisted, {
      allowBaselineMutation: type === 'restore',
      outcome
    })
  ));
  const auditIds = auditDelta.map(item => String(item.id));
  if (contract.mode === 'audit-chain') {
    const declaredDuplicates = declaredAuditIds.filter((id, index) => declaredAuditIds.indexOf(id) !== index);
    const deltaSet = new Set(auditIds);
    const declaredSet = new Set(declaredAuditIds);
    const missing = declaredAuditIds.filter(id => !deltaSet.has(id));
    const extra = auditIds.filter(id => !declaredSet.has(id));
    if (declaredDuplicates.length || missing.length || extra.length || declaredSet.size !== deltaSet.size) {
      throw actionError(type, 'audit-delta', `expected=${auditIdSummary(declaredAuditIds)}; missing=${auditIdSummary(missing)}; extra=${auditIdSummary(extra)}; duplicate=${auditIdSummary(declaredDuplicates)}`);
    }
  } else {
    const boundaryDescriptors = ['rejected', 'cancelled'].includes(outcome)
      ? []
      : normalizeAuditDescriptors(await settleStage('audit-resolver', () => resolveSettlementValue(contract.audits, Object.freeze({ ...details, persisted }))));
    const { missing, extraIds } = matchBoundaryAuditDescriptors(auditDelta, boundaryDescriptors);
    if (missing.length || extraIds.length) {
      throw actionError(type, 'audit-delta', `expected=${boundaryDescriptors.length ? boundaryDescriptors.map(item => `${item.action}#${item.count}`).join(',') : '<none>'}; missing=${missing.length ? missing.join(',') : '<none>'}; extra=${auditIdSummary(extraIds)}`);
    }
  }
  if (NON_MUTATING_OUTCOMES.has(outcome)) {
    await settleStage('revision', () => {
      const actualDelta = persisted.revision - scope.revision;
      if (actualDelta !== 0) throw new Error(`${outcome} requires 0, actual ${actualDelta}`);
    });
    await settleStage('entity-delta', () => {
      const unavailable = BUSINESS_ENTITY_COLLECTIONS.filter(key => !Array.isArray(scope.state?.[key]) || !Array.isArray(persisted.state?.[key]));
      if (unavailable.length > 0) throw new Error(`${outcome} business entity collections unavailable: ${unavailable.join(',')}`);
      const changed = BUSINESS_ENTITY_COLLECTIONS.filter(key => !isDeepStrictEqual(scope.state[key], persisted.state[key]));
      if (changed.length > 0) throw new Error(`${outcome} requires unchanged business entities; changed=${changed.join(',')}`);
    });
  }
  const uiEvidence = immutableSnapshot(await settleStage('final-projection', () => driver.uiProjection()));
  const uiRevision = revisionOf(uiEvidence);
  if (uiRevision === null || uiRevision !== persisted.revision) {
    throw actionError(type, 'boundary consistency', `SQLite ${persisted.revision}, UI ${uiRevision === null ? '<unknown>' : uiRevision}`);
  }
  const auditEvidence = immutableSnapshot(auditDelta);
  const settlement = deepFreeze({
    mode: contract.mode,
    outcome,
    message: String(result?.message || ''),
    beforeRevision: scope.revision,
    beforeState: immutableSnapshot(scope.state),
    persistedRevision: persisted.revision,
    state: immutableSnapshot(persisted.state),
    auditIds: immutableSnapshot(auditIds),
    audits: auditEvidence,
    auditEvidence,
    uiEvidence,
    finalPage
  });
  if (contract.terminal) {
    const terminal = await settleStage('terminal-state', () => contract.terminal(Object.freeze({ ...details, settlement, state: settlement.state, beforeState: settlement.beforeState })));
    if (terminal !== true) throw actionError(type, 'terminal-state', 'terminal predicate rejected persisted state');
  }
  return settlement;
}

function activeRecordIndex(snapshot, sampleId, status) {
  const state = stateOf(snapshot);
  if (!state) throw new Error('validated snapshot is required');
  const record = activeRecord(state, sampleId, status);
  if (!record) throw new Error(`${status} active pointer not found for sample: ${sampleId}`);
  const index = state.records.findIndex(item => item.id === record.id);
  if (index < 0) throw new Error(`${status} record index not found for sample: ${sampleId}`);
  return { index, record };
}

async function openTodoDetail(page, snapshot, sampleId, configuredIndex) {
  const verified = activeRecordIndex(snapshot, sampleId, 'reserved');
  const recordIndex = Number.isInteger(configuredIndex)
    ? configuredIndex
    : verified.index;
  if (recordIndex !== verified.index) throw new Error(`configured recordIndex does not match reserved pointer for sample: ${sampleId}`);
  if (!Number.isInteger(recordIndex) || recordIndex < 0) throw new Error(`reserved TODO not found for sample: ${sampleId}`);
  const detail = page.locator(`[data-dashboard-action="todo-detail"][data-record-index="${recordIndex}"]`);
  const previous = page.locator('[data-dashboard-action="todo-previous"]');
  const next = page.locator('[data-dashboard-action="todo-next"]');
  while (!await previous.isDisabled()) {
    await click(previous, false, `todo previous page for ${sampleId}`);
  }
  while (await detail.count() === 0) {
    await unique(next, `todo next page for ${sampleId}`);
    if (await next.isDisabled()) throw new Error(`reserved TODO is not visible on any dashboard page: ${sampleId}`);
    await next.click();
  }
  await click(detail, false, `reserved TODO detail ${sampleId}`);
  return recordIndex;
}

async function retainedOldResult(context, actionName, sampleId) {
  const handle = retainedHandle(context, actionName, sampleId);
  if (!handle) return { outcome: 'rejected', message: `${actionName}: retained DOM unavailable` };
  try {
    const connected = await handle.evaluate(node => Boolean(node?.isConnected));
    if (!connected) return { outcome: 'rejected', message: `${actionName}: retained DOM detached` };
  } catch {
    return { outcome: 'rejected', message: `${actionName}: retained DOM detached` };
  }
  try {
    if (typeof handle.isVisible === 'function' && !await handle.isVisible()) {
      return { outcome: 'rejected', message: `${actionName}: retained DOM hidden` };
    }
  } catch {
    return { outcome: 'rejected', message: `${actionName}: retained DOM detached` };
  }
  try {
    await handle.click();
    return { awaitEvidence: true };
  } catch {
    return { outcome: 'rejected', message: `${actionName}: retained DOM rejected the stale operation` };
  }
}

function requestedRetentionTargets(snapshot, params) {
  if (params.targets !== undefined) return params.targets.map(target => ({ ...target }));
  const state = stateOf(snapshot);
  if (!state) throw new Error('validated snapshot is required');
  const targets = [];
  for (const sample of state.samples) {
    const running = activeRecord(state, sample.id, 'running');
    if (running) targets.push({ type: 'manageRunning', sampleId: sample.id, channelKey: running.channelKey || running.keys?.[0] });
    const reserved = activeRecord(state, sample.id, 'reserved');
    if (reserved) {
      targets.push({ type: 'startTodo', sampleId: sample.id });
      targets.push({ type: 'cancelTodo', sampleId: sample.id });
    }
  }
  if (targets.length === 0) throw new Error('no active sample-bound DOM targets are available');
  return targets;
}

async function goRetentionPage(activeDriver, page, ui, target) {
  if (projectionOf(ui)?.currentPage === target) return ui;
  await click(page.locator(`.nav[data-page="${target}"]`), false, `retainOldDom target page ${target}`);
  const next = await activeDriver.uiProjection();
  if (projectionOf(next)?.currentPage !== target) throw new Error(`retainOldDom target page ${target} did not become active`);
  return next;
}

async function captureRetainedDom(driver, params, context) {
  const runtime = runtimeFor(context);
  if (!runtime) throw new Error('mutable runtime is required');
  const activeDriver = driverFor(driver, params, context);
  const page = pageFor(driver, params, context);
  const targets = requestedRetentionTargets(context.snapshot, params);
  const captured = [];
  let ui = context.ui;

  for (const target of targets.filter(item => item.type === 'manageRunning')) {
    ui = await goRetentionPage(activeDriver, page, ui, 'records');
    const { record } = activeRecordIndex(context.snapshot, target.sampleId, 'running');
    const channelKey = record.channelKey || record.keys?.[0];
    if (target.channelKey !== undefined && target.channelKey !== channelKey) throw new Error(`channelKey does not match running pointer for sample: ${target.sampleId}`);
    const locator = await unique(boundedAction(page, 'manage-running', {
      'sample-id': encodeURIComponent(target.sampleId),
      'channel-key': encodeURIComponent(channelKey)
    }), `retain manageRunning ${target.sampleId}`);
    const handle = await locator.elementHandle();
    if (!handle) throw new Error(`sample-bound handle not found: manageRunning ${target.sampleId}`);
    captured.push([retainedKey(target.type, target.sampleId), handle]);
  }

  const reservedSamples = [...new Set(targets.filter(item => ['startTodo', 'cancelTodo'].includes(item.type)).map(item => item.sampleId))];
  for (const sampleId of reservedSamples) {
    ui = await goRetentionPage(activeDriver, page, ui, 'dashboard');
    const recordIndex = await openTodoDetail(page, context.snapshot, sampleId);
    ui = await activeDriver.uiProjection();
    const requested = targets.filter(item => item.sampleId === sampleId && ['startTodo', 'cancelTodo'].includes(item.type));
    for (const target of requested) {
      const selector = target.type === 'startTodo' ? `[data-res-start="${recordIndex}"]` : `[data-res-cancel="${recordIndex}"]`;
      const locator = await unique(page.locator(selector), `retain ${target.type} ${sampleId}`);
      const handle = await locator.elementHandle();
      if (!handle) throw new Error(`sample-bound handle not found: ${target.type} ${sampleId}`);
      captured.push([retainedKey(target.type, sampleId), handle]);
    }
  }

  if (!(runtime.retainedDom instanceof Map)) runtime.retainedDom = new Map();
  for (const [key, handle] of captured) runtime.retainedDom.set(key, handle);
  return { outcome: 'success', evidenceBaseUi: ui, message: `retained ${captured.length} sample-bound handles` };
}

function requireSavePath(params) {
  if (params.cancel !== true && missing(params.path)) throw new TypeError('path required');
}

function inside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

async function resolvePath(params, context, mode) {
  const runContext = context?.runContext;
  if (params.cancel === true) return params.path;
  if (!runContext) throw new Error('workflow runContext is required for file actions');
  const root = mode === 'input' ? runContext.dataRoot : runContext.exportsRoot;
  const resolved = path.resolve(root, params.path);
  if (!inside(root, resolved)) throw new Error(`path outside workflow run root: ${params.path}`);
  if (mode === 'input') {
    await runContext.prepareInput?.(resolved, params.kind);
    const details = await stat(resolved);
    const directory = params.kind === 'folder' || params.kind === 'directory';
    if (directory ? !details.isDirectory() : !details.isFile()) throw new Error(`workflow input must be a ${directory ? 'directory' : 'file'}: ${params.path}`);
  } else {
    runContext.assertWritable(resolved);
    await mkdir(path.dirname(resolved), { recursive: true });
  }
  return resolved;
}

export async function resolveWorkflowFileRoute(params, context, mode) {
  const resolved = await resolvePath(params, context, mode);
  return mode === 'input'
    ? Object.freeze({ openFiles: Object.freeze([Object.freeze([resolved])]) })
    : Object.freeze({ saveFiles: Object.freeze([resolved]) });
}

async function configureOpen(driver, params, kind, context) {
  const paths = params.paths ? await Promise.all(params.paths.map(item => resolvePath({ ...params, path: item }, context, 'input'))) : params.path ? [await resolvePath(params, context, 'input')] : [];
  const canceled = params.cancel === true;
  if (typeof driver.configureDialogs === 'function') {
    await driver.configureDialogs({
      openFiles: kind === 'file' ? [canceled ? [] : paths] : [],
      openDirectories: kind === 'directory' ? [canceled ? [] : paths] : [],
      saveFiles: []
    });
  }
  return paths;
}

async function workbookCandidates(root) {
  const found = [];
  async function walk(current) {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(absolute);
      else if (['.xlsx', '.xls', '.csv'].includes(path.extname(entry.name).toLowerCase())) found.push(absolute);
    }
  }
  await walk(root);
  return found.sort((left, right) => left.localeCompare(right, 'zh-CN'));
}

async function mixedImportEvidence(inputPath, state, params) {
  const candidates = await workbookCandidates(inputPath);
  const parsed = parseFolder(inputPath);
  const existingIds = new Set((state.requests || []).map(item => String(item.id || item.requestNo || '')));
  let suffix = 1;
  let auditId = 'WORKFLOW-IMPORT-DRY-RUN';
  while ((state.auditLogs || []).some(item => item.id === auditId)) auditId = `WORKFLOW-IMPORT-DRY-RUN-${++suffix}`;
  const dryRun = importRequests(state, {
    records: parsed.records,
    errors: parsed.errors,
    strategy: 'commit-valid',
    duplicateMode: params.duplicatePolicy || 'skip',
    actor: 'workflow-import-dry-run',
    auditId,
    journalId: `${auditId}-JOURNAL`,
    now: '2000-01-01T00:00:00.000Z'
  });
  const audit = dryRun.auditLogs.find(item => item.id === auditId);
  if (!audit) throw new Error('mixed import dry-run audit is unavailable');
  const validMatch = String(audit.target || '').match(/（(\d+) 条有效）/);
  if (!validMatch) throw new Error(`mixed import dry-run valid count is unavailable: ${audit.target || '<empty>'}`);
  return immutableSnapshot({
    enumeration: {
      workbookFiles: candidates.length,
      parserFiles: parsed.files,
      skippedLockFiles: candidates.filter(file => path.basename(file).startsWith('~$')).map(file => path.basename(file))
    },
    parser: {
      records: parsed.records.map(item => ({ requestNo: item.id, sourceFile: item.sourceFile })),
      errors: parsed.errors.map(item => ({ file: item.file, code: item.code }))
    },
    domain: {
      validCount: Number(validMatch[1]),
      committed: audit.after.committed,
      skipped: audit.after.skipped,
      covered: audit.after.covered,
      errors: audit.after.errors.map(item => ({
        file: item.file || '',
        requestNo: item.requestNo || '',
        code: item.code
      })),
      wouldPersist: dryRun.requests
        .filter(item => !existingIds.has(String(item.id || item.requestNo || '')))
        .map(item => ({ requestNo: item.id || item.requestNo, sourceFile: item.sourceFile }))
    }
  });
}

async function configureSave(driver, params, context) {
  if (typeof driver.configureDialogs !== 'function') return;
  await driver.configureDialogs({
    openFiles: [],
    openDirectories: [],
    saveFiles: [params.cancel === true ? '' : String(await resolvePath(params, context, 'output') || '')]
  });
}

async function configureRestore(driver, params, context) {
  if (typeof driver.configureDialogs !== 'function') return;
  await driver.configureDialogs({
    openFiles: [params.cancel === true ? [] : [String(await resolvePath(params, context, 'output') || '')]],
    openDirectories: [],
    saveFiles: params.preBackupPath ? [String(await resolvePath({ ...params, path: params.preBackupPath }, context, 'output'))] : []
  });
}

async function assignChannels(page, sampleIds, channelKeys) {
  for (let index = 0; index < sampleIds.length; index += 1) {
    await click(stableAction(page, 'open-channel-picker', { 'sample-id': sampleIds[index] }), false, `open channel picker ${sampleIds[index]}`);
    const option = stableAction(page, 'choose-channel', { 'channel-key': channelKeys[index] });
    if (await option.count() === 0) {
      await page.getByLabel('搜索设备、通道或量程', { exact: true }).fill(String(channelKeys[index]));
    }
    if (await option.count() === 0) {
      await click(stableAction(page, 'close-channel-picker'), false, `close unavailable picker ${sampleIds[index]}`);
      return { sampleId: sampleIds[index], channelKey: channelKeys[index] };
    }
    await click(option, false, `choose channel ${channelKeys[index]}`);
  }
  return null;
}

async function openReservationRequest(page, requestNo) {
  const target = stableAction(page, 'select-request', { 'request-no': requestNo });
  const search = page.getByLabel('搜索申请单、项目、样品或人员', { exact: true });
  let filtered = false;
  if (await target.count() === 0) {
    await search.fill(String(requestNo));
    filtered = true;
  }
  await click(target, false, `select request ${requestNo}`);
  if (filtered) {
    const selectedDetails = await reservationDetails(page, requestNo);
    const selectedGeneration = await reservationDetailsGeneration(selectedDetails);
    await search.fill('');
    await replacementReservationDetails(page, requestNo, selectedGeneration);
  }
}

function reservationDetailsSelector(requestNo) {
  return `[data-testid="legacy-reservation-details"][data-request-no="${encodedAttribute(requestNo)}"]`;
}

async function reservationDetails(page, requestNo) {
  const details = page.locator(reservationDetailsSelector(requestNo));
  await details.waitFor({ state: 'visible' });
  return unique(details, 'reservation details');
}

async function reservationDetailsGeneration(details) {
  const generation = await details.getAttribute('data-details-generation');
  if (!/^[1-9]\d*$/.test(String(generation || ''))) throw new Error('reservation details generation is unavailable');
  return String(generation);
}

async function replacementReservationDetails(page, requestNo, previousGeneration) {
  const selector = reservationDetailsSelector(requestNo);
  await page.waitForFunction(
    ({ selector: expectedSelector, previousGeneration: expectedGeneration }) => {
      const details = document.querySelector(expectedSelector);
      if (!(details instanceof Element) || details.getClientRects().length === 0) return false;
      return details.getAttribute('data-details-generation') !== expectedGeneration;
    },
    { selector, previousGeneration }
  );
  const details = await reservationDetails(page, requestNo);
  const generation = await reservationDetailsGeneration(details);
  if (generation === previousGeneration) throw new Error('reservation details generation did not change');
  return details;
}

async function prepareReservation(driver, params, context, mode) {
  const page = pageFor(driver, params, context);
  const activeDriver = driverFor(driver, params, context);
  await openReservationRequest(page, params.requestNo);
  const startLabel = mode === 'start' ? '开始时间' : '预约开始时间';
  const radio = page.getByRole('radio', { name: mode === 'start' ? '立即开始' : '提交预约', exact: true });
  let details;
  if (await radio.isChecked()) {
    details = await reservationDetails(page, params.requestNo);
  } else {
    const selectedDetails = await reservationDetails(page, params.requestNo);
    const selectedGeneration = await reservationDetailsGeneration(selectedDetails);
    await radio.check();
    details = await replacementReservationDetails(page, params.requestNo, selectedGeneration);
  }
  await fillOptional(details, startLabel, datetimeLocal(params.start));
  await fillOptional(details, '预计结束时间（可选）', datetimeLocal(params.end));
  await fillOptional(details, '备注', params.note);
  const unavailableChannel = params.sampleIds && params.channelKeys
    ? await assignChannels(page, params.sampleIds, params.channelKeys)
    : null;
  if (unavailableChannel) return { activeDriver, page, unavailableChannel };
  return { activeDriver, page };
}

async function submitReservation(driver, params, context, mode) {
  const { activeDriver, page, unavailableChannel } = params.usePrepared === true
    ? { activeDriver: driverFor(driver, params, context), page: pageFor(driver, params, context), unavailableChannel: null }
    : await prepareReservation(driver, params, context, mode);
  if (unavailableChannel) {
    return {
      outcome: 'rejected',
      message: `channel unavailable for requested interval: ${unavailableChannel.channelKey}`
    };
  }
  const cleanup = armConfirmSequence(page, params.confirm === undefined ? [] : [params.confirm]);
  return clickAndRead(activeDriver, page.getByRole('button', {
    name: mode === 'start' ? '立即开始' : '提交预约', exact: true
  }), params, context, { cleanup, label: `${mode} reservation submit` });
}

async function prepareSecondSessionStaleDraft(second, prepare, context) {
  const runtime = runtimeFor(context);
  if (!runtime) throw new Error('mutable runtime is required');
  const page = second.page();
  const actualUsername = prepare.username || stateOf(context.snapshot)?.username || 'workflow-stale';
  const username = page.getByLabel('用户名', { exact: true });
  if (await username.count() === 1) {
    await username.fill(actualUsername);
    await click(page.getByRole('button', { name: '进入看板', exact: true }), false, 'second session login');
    if (typeof page.waitForFunction === 'function') await page.waitForFunction(() => window.__batteryAppReady === true);
  }
  if (typeof second.waitForPersistenceBarrier !== 'function') {
    throw new Error('second session persistence barrier capability is required for prepareStale');
  }
  const loginEvidence = await second.waitForPersistenceBarrier({
    auditAction: '登录看板', actor: actualUsername, timeoutMs: 5_000
  });

  let ui = await second.uiProjection();
  if (projectionOf(ui)?.currentPage !== 'apply') {
    await click(page.locator('.nav[data-page="apply"]'), false, 'stale reserve target page apply');
    ui = await second.uiProjection();
  }
  await prepareReservation(second, prepare, { ...context, ui }, 'reserve');
  const evidenceBaseUi = await second.uiProjection();
  const locator = await unique(page.getByRole('button', { name: '提交预约', exact: true }), 'prepared stale reserve submit');
  if (!(runtime.staleDrafts instanceof Map)) runtime.staleDrafts = new Map();
  runtime.staleDrafts.set(staleDraftKey('B', 'reserve'), {
    operation: 'reserve', driver: second, locator, evidenceBaseUi, loginEvidence,
    params: {
      requestNo: prepare.requestNo,
      sampleIds: [...prepare.sampleIds],
      channelKeys: [...prepare.channelKeys],
      start: prepare.start,
      end: prepare.end
    }
  });
}

async function prepareRunningManagement(driver, params, context) {
  const activeDriver = driverFor(driver, params, context);
  const page = pageFor(driver, params, context);
  const { record } = activeRecordIndex(context.snapshot, params.sampleId, 'running');
  const channelKey = params.channelKey || record.channelKey || record.keys?.[0];
  if (projectionOf(context.ui)?.currentPage !== 'devices') {
    await click(boundedAction(page, 'manage-running', {
      'sample-id': encodeURIComponent(params.sampleId),
      'channel-key': encodeURIComponent(channelKey)
    }), false, `manage running ${params.sampleId}`);
  }
  const editor = page.locator('#channelEditor');
  const end = params.endOffsetMinutes === undefined
    ? datetimeLocal(params.end)
    : offsetDateTimeLocal(record, params.endOffsetMinutes);
  await fillOptional(editor, '预计结束时间（可选）', end, { exact: false });
  await fillOptional(editor, '特殊状况说明', params.condition);
  return { activeDriver, page };
}

async function reenterAfterLifecycle(activeDriver, context, label) {
  const page = activeDriver.page();
  const lifecycle = await page.evaluate(() => ({
    ready: window.__batteryAppReady === true && document.getElementById('app')?.style.display !== 'none',
    loginVisible: document.getElementById('login')?.style.display !== 'none',
    canResume: typeof window.loadPersisted === 'function' && typeof window.renderAll === 'function'
  }));
  if (!lifecycle || typeof lifecycle !== 'object') {
    return { outcome: 'success', message: `${label} completed without a real renderer lifecycle` };
  }
  if (lifecycle.ready) throw new Error(`${label} did not return to the login page`);
  if (!lifecycle.loginVisible) throw new Error(`${label} login page is not visible`);
  const actor = String(stateOf(context.snapshot)?.username || 'workflow-recovery');
  await page.locator('#username').fill(actor);
  await click(page.locator('#login .btn.wide'), false, `${label} login`);
  await page.waitForFunction(() => window.__batteryAppReady === true && document.getElementById('app')?.style.display !== 'none');
  if (typeof activeDriver.waitForPersistenceBarrier !== 'function') throw new Error(`${label} persistence barrier capability is required`);
  const loginEvidence = await activeDriver.waitForPersistenceBarrier({ auditAction: '登录看板', actor, timeoutMs: 5_000 });
  return {
    outcome: 'success',
    message: `${label} login settled at revision ${loginEvidence.revision}`
  };
}

function rowButton(page, rowText, buttonName) {
  const row = page.getByRole('row', { name: new RegExp(regexEscape(rowText)) });
  return row.getByRole('button', { name: buttonName, exact: true });
}

async function editFields(page, fields) {
  for (const [label, value] of Object.entries(fields || {})) await fillOptional(page, label, value);
}

async function prepareWorkbenchForm(page, trigger, values, label) {
  await click(trigger, false, label);
  const dialog = page.locator('#sampleWorkbenchDialog');
  await dialog.waitFor({ state: 'visible' });
  for (const [name, value] of Object.entries(values)) {
    const field = dialog.locator(`[data-workbench-field="${encodedAttribute(name)}"]`);
    if (name === 'status') await field.selectOption(String(value));
    else await field.fill(String(value ?? ''));
  }
  return dialog;
}

async function draftField(page, label, reservation) {
  if (reservation && label !== '备注') throw new Error(`unsupported reservation draft field: ${label}`);
  const locator = reservation
    ? page.locator('.legacy-reservation-details').locator('[data-legacy-action="note"]')
    : page.getByLabel(label, { exact: true });
  await locator.waitFor({ state: 'attached' });
  return unique(locator, `draft field ${label}`);
}

function auditActor({ params, scope }) {
  const actor = String(params?.actor || scope?.state?.username || '').trim();
  if (!actor) throw new Error('audit actor is unavailable');
  return actor;
}

function ownedAudit(action, target, details) {
  const actor = auditActor(details);
  const resolvedTarget = typeof target === 'function' ? target(details) : target;
  return {
    action,
    actor,
    ...(resolvedTarget ? { target: String(resolvedTarget) } : {}),
    count: 1
  };
}

function boundaryAuditPolicy(action, target, { auditedOutcomes = ['success', 'warning'] } = {}) {
  const outcomes = new Set(auditedOutcomes);
  return Object.freeze({
    mode: 'boundary',
    audits: details => outcomes.has(details.outcome) ? [ownedAudit(action, target, details)] : []
  });
}

function storageRecord(state, storageId) {
  const records = stateOf({ state })?.storageRecords?.filter(item => String(item.id) === String(storageId)) || [];
  return records.length === 1 ? records[0] : null;
}

function storageTerminal(type) {
  return details => {
    if (details.outcome !== 'success') return true;
    const record = storageRecord(details.state, details.params.storageId);
    if (!record) return false;
    const samples = new Map((details.state.samples || []).map(item => [String(item.id), item]));
    if (type === 'startStorage') {
      return record.status === 'storing'
        && String(record.requestNo) === String(details.params.requestNo)
        && String(record.tester) === String(details.params.tester)
        && sameStringArray(record.sampleIds, details.params.sampleIds)
        && record.sampleIds.every(id => samples.get(String(id))?.status === 'storing');
    }
    if (type === 'updateStorage') {
      const fieldsMatch = ['status', 'expectedEndAt', 'note']
        .every(key => details.params[key] === undefined || String(record[key] ?? '') === String(details.params[key]));
      return fieldsMatch && record.sampleIds.every(id => samples.get(String(id))?.status === record.status);
    }
    if (type === 'finishStorage') {
      return record.status === 'completed' && Boolean(String(record.endedAt || '').trim())
        && record.sampleIds.every(id => samples.get(String(id))?.status === 'completed');
    }
    return record.status === 'returned' && record.returnReason === details.params.reason
      && record.sampleIds.every(id => samples.get(String(id))?.status === 'pending');
  };
}

function returnRunningTarget({ params, scope }) {
  const state = stateOf({ state: scope?.state });
  const record = state && activeRecord(state, params.sampleId, 'running');
  return record ? `record:${record.id}` : undefined;
}

function returnRunningTerminal(details) {
  if (details.outcome !== 'success') return true;
  const before = stateOf({ state: details.beforeState });
  const after = stateOf({ state: details.state });
  const source = before && activeRecord(before, details.params.sampleId, 'running');
  if (!source || !after) return false;
  const record = after.records.find(item => String(item.id) === String(source.id));
  const sample = after.samples.find(item => String(item.id) === String(details.params.sampleId));
  const channelKey = String(source.channelKey || source.keys?.[0] || '');
  const beforeChannel = before.channels.find(item => String(item.key) === channelKey);
  const afterChannel = after.channels.find(item => String(item.key) === channelKey);
  return record?.status === 'returned' && record?.returnReason === details.params.reason
    && sample?.status === 'pending' && String(sample?.channelKey || '') === ''
    && String(afterChannel?.currentRecordId || '') === ''
    && String(afterChannel?.nextRecordId || '') === String(beforeChannel?.nextRecordId || '');
}

function recordChannelTarget({ params, scope }) {
  const record = scope?.state?.records?.find(item => String(item?.sampleId || '') === String(params?.sampleId || '')
    && ['reserved', 'running'].includes(String(item?.status || '')));
  const channelKey = String(record?.channelKey || record?.keys?.[0] || '').trim();
  return channelKey ? `通道 ${channelKey}` : undefined;
}

const NO_AUDIT_SETTLEMENT = Object.freeze({ mode: 'boundary', audits: () => [] });
const IMPORT_SETTLEMENT = boundaryAuditPolicy('导入申请单', ({ params }) => `申请单批次（${params.expectedValidCount} 条有效）`);
const EDIT_EXECUTION_SETTLEMENT = boundaryAuditPolicy('修改申请执行字段', ({ params }) => `申请单 ${params.requestNo}`);
const START_TODO_SETTLEMENT = boundaryAuditPolicy('开始预约测试', recordChannelTarget);
const CANCEL_TODO_SETTLEMENT = boundaryAuditPolicy('取消预约', recordChannelTarget);
const MANAGE_RUNNING_SETTLEMENT = boundaryAuditPolicy('修改通道', recordChannelTarget);
const FINISH_RUNNING_SETTLEMENT = boundaryAuditPolicy('结束测试', recordChannelTarget);
const DELAY_RUNNING_SETTLEMENT = boundaryAuditPolicy('修改通道', recordChannelTarget);
const START_STORAGE_SETTLEMENT = Object.freeze({ ...boundaryAuditPolicy('storage_started', ({ params }) => `storage:${params.storageId}`), terminal: storageTerminal('startStorage') });
const UPDATE_STORAGE_SETTLEMENT = Object.freeze({ ...boundaryAuditPolicy('storage_updated', ({ params }) => `storage:${params.storageId}`), terminal: storageTerminal('updateStorage') });
const FINISH_STORAGE_SETTLEMENT = Object.freeze({ ...boundaryAuditPolicy('storage_finished', ({ params }) => `storage:${params.storageId}`), terminal: storageTerminal('finishStorage') });
const RETURN_STORAGE_SETTLEMENT = Object.freeze({ ...boundaryAuditPolicy('storage_returned_to_application', ({ params }) => `storage:${params.storageId}`), terminal: storageTerminal('returnStorage') });
const RETURN_RUNNING_SETTLEMENT = Object.freeze({ ...boundaryAuditPolicy('running_returned_to_application', returnRunningTarget), terminal: returnRunningTerminal });
const DELETE_REQUEST_SETTLEMENT = boundaryAuditPolicy('批量删除申请单', ({ params }) => String(params.requestNo));
const CREATE_TESTER_SETTLEMENT = boundaryAuditPolicy('新增测试人员', ({ params }) => `测试人员 ${params.name}`);
const RENAME_TESTER_SETTLEMENT = boundaryAuditPolicy('修改测试人员', ({ params }) => `测试人员 ${params.nextName}`);
const DELETE_TESTER_SETTLEMENT = boundaryAuditPolicy('删除测试人员', ({ params }) => `测试人员 ${params.name}`);
const CREATE_DEVICE_SETTLEMENT = boundaryAuditPolicy('新增设备', ({ params }) => `设备 ${params.name}`);
const CREATE_CHANNEL_SETTLEMENT = boundaryAuditPolicy('新增通道', ({ params }) => `通道 ${params.device}|${params.name}`);
const DELETE_RESOURCE_SETTLEMENT = Object.freeze({
  mode: 'boundary',
  audits: details => ['success', 'warning'].includes(details.outcome)
    ? [ownedAudit(
        details.params.kind === 'device' ? '删除设备' : '删除通道',
        `${details.params.kind === 'device' ? '设备' : '通道'} ${details.params.name}`,
        details
      )]
    : []
});
const EXPORT_LOG_SETTLEMENT = boundaryAuditPolicy('导出日志与使用数据', '日志数据', { auditedOutcomes: ['success', 'failure'] });
const EXPORT_REQUEST_SETTLEMENT = boundaryAuditPolicy('导出申请汇总', '测试申请数据', { auditedOutcomes: ['success', 'failure'] });
const BACKUP_SETTLEMENT = boundaryAuditPolicy('手动备份数据', '本机 SQLite 看板数据', { auditedOutcomes: ['success', 'failure'] });
const RESTORE_SETTLEMENT = boundaryAuditPolicy('恢复数据备份', '本机 SQLite 看板数据', { auditedOutcomes: ['success', 'failure'] });

function pointerTerminal(details) {
  if (!details.params.expectedPointers || details.outcome !== 'success') return true;
  const expected = details.params.expectedPointers;
  const channel = details.state?.channels?.find(item => String(item?.key) === expected.channelKey);
  const recordIdFor = (sampleId, status) => {
    const records = details.state?.records?.filter(item => String(item?.sampleId) === String(sampleId) && item?.status === status) || [];
    return records.length === 1 ? records[0].id : null;
  };
  const expectedCurrent = expected.currentSampleId === undefined ? expected.currentRecordId : recordIdFor(expected.currentSampleId, 'running');
  const expectedNext = expected.nextSampleId === undefined ? expected.nextRecordId : recordIdFor(expected.nextSampleId, 'reserved');
  if ((expected.currentSampleId !== undefined && expectedCurrent === null) || (expected.nextSampleId !== undefined && expectedNext === null)) return false;
  return Boolean(channel) && String(channel.currentRecordId || '') === String(expectedCurrent || '') && String(channel.nextRecordId || '') === String(expectedNext || '');
}

function withPointerTerminal(contract) {
  return Object.freeze({ ...contract, terminal: details => pointerTerminal(details) });
}

function verifyReservationTerminal({ outcome, type, params, state }) {
  if (outcome !== 'success') return true;
  const persistedState = stateOf({ state });
  if (!persistedState) return false;
  const status = type === 'startImmediately' ? 'running' : 'reserved';
  const pointer = status === 'running' ? 'currentRecordId' : 'nextRecordId';
  return params.sampleIds.every((sampleId, index) => {
    const channelKey = params.channelKeys[index];
    const sample = persistedState.samples.find(item => String(item.id) === String(sampleId));
    const records = persistedState.records.filter(item => String(item.sampleId || '') === String(sampleId)
      && String(item.channelKey || item.keys?.[0] || '') === String(channelKey)
      && item.status === status);
    const channel = persistedState.channels.find(item => String(item.key) === String(channelKey));
    return sample?.status === status && records.length === 1 && String(channel?.[pointer] || '') === String(records[0].id);
  });
}

function resolveControlledSettlementStage(context, stage, value) {
  return typeof context?.settlementStage === 'function' ? context.settlementStage(stage, value) : value;
}

const reservationSettlement = Object.freeze({
  mode: 'audit-chain',
  finalPage: 'apply',
  audits: ({ outcome, type, params, context, scope }) => resolveControlledSettlementStage(
    context,
    'audit-resolver',
    outcome === 'success'
      ? params.sampleIds.map((sampleId, index) => ({
          action: type === 'startImmediately' ? '开始测试' : '提交预约',
          actor: auditActor({ params, scope }),
          target: `申请单 ${params.requestNo} / 子样品 ${sampleId} / 通道 ${params.channelKeys[index]}`,
          count: 1
        }))
      : []
  ),
  terminal: details => resolveControlledSettlementStage(details.context, 'terminal-state', verifyReservationTerminal(details))
});

async function visibleIdentityIds(page, identity) {
  const selector = identity === 'requestNo' ? '[data-request-no]' : '[data-sample-id]';
  return page.locator(selector).evaluateAll((elements, selectedIdentity) => {
    const visible = element => {
      if (!(element instanceof Element) || element.getClientRects().length === 0) return false;
      for (let node = element; node instanceof Element; node = node.parentElement) {
        const style = getComputedStyle(node);
        if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false;
      }
      return true;
    };
    const key = selectedIdentity === 'requestNo' ? 'requestNo' : 'sampleId';
    const decode = value => {
      try { return decodeURIComponent(value || ''); } catch { return String(value || ''); }
    };
    return [...new Set(elements.filter(visible).map(element => decode(element.dataset[key])).filter(Boolean))].sort();
  }, identity);
}

async function armOneShotStorageId(page, storageId) {
  await page.evaluate(({ storageId: id }) => {
    const cryptoObject = globalThis.crypto;
    if (!cryptoObject || typeof cryptoObject.randomUUID !== 'function') {
      throw new Error('crypto.randomUUID is required for deterministic workflow storage IDs');
    }
    const key = '__batteryWorkflowStorageIdOverride';
    const restore = record => {
      if (record.descriptor === undefined) delete cryptoObject.randomUUID;
      else Object.defineProperty(cryptoObject, 'randomUUID', record.descriptor);
    };
    if (globalThis[key]) restore(globalThis[key]);
    const descriptor = Object.getOwnPropertyDescriptor(cryptoObject, 'randomUUID');
    const original = cryptoObject.randomUUID;
    let calls = 0;
    Object.defineProperty(cryptoObject, 'randomUUID', {
      configurable: true,
      value() {
        calls += 1;
        if (calls === 1) return id;
        return Reflect.apply(original, cryptoObject, []);
      }
    });
    globalThis[key] = { descriptor };
  }, { phase: 'arm-storage-id', storageId });
}

async function restoreStorageId(page) {
  await page.evaluate(() => {
    const cryptoObject = globalThis.crypto;
    const key = '__batteryWorkflowStorageIdOverride';
    const record = globalThis[key];
    if (!record || !cryptoObject) return;
    if (record.descriptor === undefined) delete cryptoObject.randomUUID;
    else Object.defineProperty(cryptoObject, 'randomUUID', record.descriptor);
    delete globalThis[key];
  }, { phase: 'restore-storage-id' });
}

const definitions = {
  navigate: define('navigate', { write: false, revisionDelta: [0, 1], maxMs: 5_000, allowedOutcomes: SUCCESS, required: ['label'],
    async execute(driver, params, context) {
      const page = pageFor(driver, params, context);
      const target = NAVIGATION_PAGES[params.label];
      const from = projectionOf(context.ui)?.currentPage;
      await click(page.locator(`.nav[data-page="${target}"]`), false, `navigation ${target}`);
      if (params.requestNo !== undefined) await openReservationRequest(page, params.requestNo);
      return { outcome: 'success', navigationEvidence: Object.freeze({ from, expected: target }) };
    } }),
  search: define('search', { write: false, revisionDelta: 0, maxMs: 5_000, allowedOutcomes: SUCCESS, required: ['label'],
    validate(params) {
      if (typeof params.value !== 'string') throw new TypeError('value must be a string');
      if ((params.expectedVisibleIds !== undefined || params.excludedVisibleIds !== undefined) && params.identity === undefined) {
        throw new TypeError('identity is required for visible ID assertions');
      }
    },
    async execute(driver, params, context) {
      const requestedValue = String(params.value);
      const page = pageFor(driver, params, context);
      const currentPage = projectionOf(context.ui)?.currentPage;
      const filter = currentPage === 'runningSamples' ? 'running' : currentPage === 'storageSamples' ? 'storage' : '';
      const field = filter ? page.locator(`[data-sample-filter="${filter}"]`) : page.getByLabel(params.label, { exact: true });
      await field.fill(requestedValue);
      const appliedValue = await field.inputValue();
      const visibleIds = params.identity ? await visibleIdentityIds(page, params.identity) : undefined;
      const missingIds = (params.expectedVisibleIds || []).filter(id => !visibleIds.includes(id));
      const forbiddenIds = (params.excludedVisibleIds || []).filter(id => visibleIds.includes(id));
      if (missingIds.length || forbiddenIds.length) {
        throw new Error(`visible ${params.identity} mismatch; missing=${missingIds.join(',') || '<none>'}; forbidden=${forbiddenIds.join(',') || '<none>'}; actual=${visibleIds.join(',') || '<none>'}`);
      }
      return { outcome: 'success', searchEvidence: { requestedValue, appliedValue, ...(visibleIds ? { visibleIds } : {}) } };
    } }),
  filter: define('filter', { write: false, revisionDelta: 0, maxMs: 5_000, allowedOutcomes: SUCCESS, required: ['value'],
    validate(params) { if (missing(params.selector) && missing(params.label)) throw new TypeError('selector or label required'); },
    async execute(driver, params, context) {
      const page = pageFor(driver, params, context);
      const locator = params.selector ? page.locator(params.selector) : page.getByLabel(params.label, { exact: true });
      if (params.control === 'select') await locator.selectOption(String(params.value));
      else if (params.control === 'checkbox') params.value ? await locator.check() : await locator.uncheck();
      else await locator.fill(String(params.value));
      return { outcome: 'success' };
    } }),
  expand: define('expand', { write: false, revisionDelta: 0, maxMs: 5_000, allowedOutcomes: Object.freeze(['success', 'rejected']),
    async execute(driver, params, context) {
      if (params.requestNo !== undefined) {
        const runtime = runtimeFor(context); if (!runtime) throw new Error('mutable runtime is required');
        const prepared = await prepareReservation(driver, params, context, 'reserve');
        const evidenceBaseUi = await prepared.activeDriver.uiProjection();
        const locator = await unique(prepared.page.getByRole('button', { name: '提交预约', exact: true }), 'mounted stale reserve submit');
        const handle = await locator.elementHandle();
        if (!handle) throw new Error('mounted stale reserve submit handle unavailable');
        if (!(runtime.staleDrafts instanceof Map)) runtime.staleDrafts = new Map();
        runtime.staleDrafts.set(staleDraftKey('B', 'reserve'), { operation: 'reserve', driver: prepared.activeDriver, locator: handle, evidenceBaseUi, params: { requestNo: params.requestNo, sampleIds: [...params.sampleIds], channelKeys: [...params.channelKeys], start: params.start, end: params.end } });
        return { outcome: 'success', message: 'mounted reservation draft' };
      }
      const target = await unique(boundedAction(pageFor(driver, params, context), 'toggle-device', { device: encodeURIComponent(params.device) }), 'expand device'); const text = String(await target.textContent() || ''); if (!/展开/.test(text) || (typeof target.isDisabled === 'function' && await target.isDisabled())) return { outcome: 'rejected', message: 'device is already expanded or toggle is disabled' }; await target.click(); return { outcome: 'success' };
    } }),
  collapse: define('collapse', { write: false, revisionDelta: 0, maxMs: 5_000, allowedOutcomes: Object.freeze(['success', 'rejected']), required: ['device'],
    async execute(driver, params, context) { const target = await unique(boundedAction(pageFor(driver, params, context), 'toggle-device', { device: encodeURIComponent(params.device) }), 'collapse device'); const text = String(await target.textContent() || ''); if (!/收起/.test(text) || (typeof target.isDisabled === 'function' && await target.isDisabled())) return { outcome: 'rejected', message: 'device is already collapsed or toggle is disabled' }; await target.click(); return { outcome: 'success' }; } }),
  nextPage: define('nextPage', { write: false, revisionDelta: 0, maxMs: 5_000, allowedOutcomes: Object.freeze(['success', 'rejected']), required: ['view'],
    async execute(driver, params, context) { const active = driverFor(driver, params, context); const page = pageFor(driver, params, context); if (params.view === 'sample' && params.requestNo !== undefined) await openReservationRequest(page, params.requestNo); if (params.view === 'channel' && params.sampleId !== undefined) await click(stableAction(page, 'open-channel-picker', { 'sample-id': params.sampleId }), false, `open channel picker ${params.sampleId}`); const target = pagerLocator(page, params.view, 'next'); if (!await clickable(target, `next ${params.view} page`)) return { outcome: 'rejected', message: `next ${params.view} page is disabled` }; const pageEvidence = await pagedTransition(active, target, params.view, 'next'); return { outcome: 'success', pageEvidence }; } }),
  previousPage: define('previousPage', { write: false, revisionDelta: 0, maxMs: 5_000, allowedOutcomes: Object.freeze(['success', 'rejected']), required: ['view'],
    async execute(driver, params, context) { const active = driverFor(driver, params, context); const target = pagerLocator(pageFor(driver, params, context), params.view, 'previous'); if (!await clickable(target, `previous ${params.view} page`)) return { outcome: 'rejected', message: `previous ${params.view} page is disabled` }; const pageEvidence = await pagedTransition(active, target, params.view, 'previous'); return { outcome: 'success', pageEvidence }; } }),
  selectSample: define('selectSample', { write: false, revisionDelta: 0, maxMs: 5_000, allowedOutcomes: SUCCESS, required: ['sampleId'],
    async execute(driver, params, context) { const page = pageFor(driver, params, context); if (params.requestNo !== undefined) await openReservationRequest(page, params.requestNo); await stableAction(page, 'open-channel-picker', { 'sample-id': params.sampleId }).click(); return { outcome: 'success' }; } }),
  unselectSample: define('unselectSample', { write: false, revisionDelta: 0, maxMs: 5_000, allowedOutcomes: Object.freeze(['success', 'rejected']), required: ['sampleId'],
    async execute(driver, params, context) {
      const page = pageFor(driver, params, context);
      const title = page.locator('[data-testid="legacy-channel-picker"] > header strong');
      if (await title.count() === 0) return { outcome: 'rejected', message: `picker for ${params.sampleId} is not visible` };
      await unique(title, 'visible channel picker title');
      if (!await title.isVisible()) return { outcome: 'rejected', message: `picker for ${params.sampleId} is not visible` };
      const actual = String(await title.textContent() || '').trim();
      const expected = `为 ${params.sampleId} 选择通道`;
      if (actual !== expected) return { outcome: 'rejected', message: `picker ${actual || '<empty>'} does not match ${params.sampleId}` };
      await click(stableAction(page, 'close-channel-picker'), false, `close picker for ${params.sampleId}`);
      return { outcome: 'success', message: `closed picker for ${params.sampleId}` };
    } }),
  selectChannel: define('selectChannel', { write: false, revisionDelta: 0, maxMs: 5_000, allowedOutcomes: SUCCESS, required: ['channelKey'],
    async execute(driver, params, context) {
      const page = pageFor(driver, params, context);
      const option = stableAction(page, 'choose-channel', { 'channel-key': params.channelKey });
      if (await option.count() === 0) {
        const search = await unique(page.getByLabel('搜索设备、通道或量程', { exact: true }), 'channel picker search');
        await search.fill(String(params.channelKey));
      }
      await click(option, false, `choose channel ${params.channelKey}`);
      return { outcome: 'success' };
    } } ),
  unselectChannel: define('unselectChannel', { write: false, revisionDelta: 0, maxMs: 5_000, allowedOutcomes: REJECTION_OUTCOMES, required: ['channelKey'],
    async execute() { return { outcome: 'rejected', message: '当前 MAIN 不支持单独取消已分配通道；capability unavailable' }; } }),
  focusBlur: define('focusBlur', { write: false, revisionDelta: 0, maxMs: 5_000, allowedOutcomes: SUCCESS, required: ['label'],
    async execute(driver, params, context) { const field = pageFor(driver, params, context).getByLabel(params.label, { exact: true }); await field.focus(); await field.blur(); return { outcome: 'success' }; } }),

  importRequest: define('importRequest', { write: true, settlement: IMPORT_SETTLEMENT, revisionDelta: 1, maxMs: 30_000, allowedOutcomes: FILE_OUTCOMES,
    validate(params) {
      if (params.cancel !== true && missing(params.path) && missing(params.paths)) throw new TypeError('path or paths required');
      if (params.cancel !== true && (!Number.isSafeInteger(params.expectedValidCount) || params.expectedValidCount <= 0)) {
        throw new TypeError('expectedValidCount must be a positive safe integer');
      }
    },
    async execute(driver, params, context) {
      const active = driverFor(driver, params, context);
      const page = pageFor(driver, params, context);
      const folder = params.kind === 'folder' || params.kind === 'directory';
      const inputPaths = await configureOpen(active, params, folder ? 'directory' : 'file', context);
      const importEvidence = folder && params.invalidConfirm !== undefined && inputPaths.length === 1
        ? await mixedImportEvidence(inputPaths[0], stateOf(context.snapshot), params)
        : undefined;
      const answers = [];
      if (params.invalidConfirm !== undefined) answers.push(params.invalidConfirm);
      if (params.duplicatePolicy !== undefined) answers.push(params.duplicatePolicy === 'cover');
      const cleanup = armConfirmSequence(page, answers);
      const result = await clickAndRead(active, page.getByRole('button', { name: folder ? /\u5bfc入文件夹/ : /\u5bfc入单个 Excel/ }), params, context, {
        cleanup,
        label: 'import request',
        outcome: params.cancel === true ? 'cancelled' : undefined,
        message: params.cancel === true ? 'native import dialog cancelled by configured route' : undefined
      });
      return { ...result, ...(importEvidence ? { importEvidence } : {}) };
    } }),
  editExecution: define('editExecution', { write: true, settlement: EDIT_EXECUTION_SETTLEMENT, revisionDelta: 1, maxMs: 10_000, allowedOutcomes: MUTATION_OUTCOMES, required: ['requestNo'],
    async execute(driver, params, context) {
      const active = driverFor(driver, params, context); const page = pageFor(driver, params, context);
      const editorButton = rowButton(page, params.requestNo, '编辑');
      if (await editorButton.count() !== 1) {
        const details = await page.evaluate(() => ({
          currentPage: document.querySelector('.page.active')?.id || '',
          requestIds: Array.isArray(requests) ? requests.map(item => String(item.id)) : [],
          tableText: document.getElementById('requestTable')?.textContent?.trim() || ''
        }));
        throw new Error(`request editor row unavailable: ${JSON.stringify(details)}`);
      }
      await editorButton.click();
      await editFields(page.locator('#requestEditor'), params.fields);
      return clickAndRead(active, page.locator('#requestEditor').getByRole('button', { name: '保存执行字段', exact: true }), params, context);
    } }),
  reserve: define('reserve', { write: true, settlement: reservationSettlement, revisionDelta: 1, maxMs: 15_000, allowedOutcomes: MUTATION_OUTCOMES, required: ['requestNo', 'sampleIds', 'channelKeys'],
    validate(params) { if (params.sampleIds.length !== params.channelKeys.length) throw new TypeError('sampleIds and channelKeys length mismatch'); },
    execute(driver, params, context) { return submitReservation(driver, params, context, 'reserve'); } }),
  startImmediately: define('startImmediately', { write: true, settlement: reservationSettlement, revisionDelta: 1, maxMs: 15_000, allowedOutcomes: MUTATION_OUTCOMES, required: ['requestNo', 'sampleIds', 'channelKeys'],
    validate(params) { if (params.sampleIds.length !== params.channelKeys.length) throw new TypeError('sampleIds and channelKeys length mismatch'); },
    execute(driver, params, context) { return submitReservation(driver, params, context, 'start'); } }),
  startTodo: define('startTodo', { write: true, settlement: withPointerTerminal(START_TODO_SETTLEMENT), revisionDelta: 1, maxMs: 10_000, allowedOutcomes: MUTATION_OUTCOMES, required: ['sampleId'],
    async execute(driver, params, context) {
      if (params.old) return retainedOldResult(context, 'startTodo', params.sampleId);
      const active = driverFor(driver, params, context); const page = pageFor(driver, params, context);
      const verified = activeRecordIndex(context.snapshot, params.sampleId, 'reserved');
      const recordIndex = projectionOf(context.ui)?.currentPage === 'reserved'
        ? verified.index
        : await openTodoDetail(page, context.snapshot, params.sampleId, params.recordIndex);
      if (params.recordIndex !== undefined && params.recordIndex !== recordIndex) throw new Error(`configured recordIndex does not match reserved pointer for sample: ${params.sampleId}`);
      const evidenceBaseUi = await active.uiProjection();
      return clickAndRead(active, page.locator(`[data-res-start="${recordIndex}"]`), params, context, { evidenceBaseUi, label: `start reserved record ${recordIndex}` });
    } }),
  cancelTodo: define('cancelTodo', { write: true, settlement: CANCEL_TODO_SETTLEMENT, revisionDelta: 1, maxMs: 10_000, allowedOutcomes: MUTATION_OUTCOMES, required: ['sampleId'],
    async execute(driver, params, context) {
      if (params.old) return retainedOldResult(context, 'cancelTodo', params.sampleId);
      const active = driverFor(driver, params, context); const page = pageFor(driver, params, context);
      const answer = params.confirm === undefined ? true : params.confirm;
      const cleanup = armConfirmSequence(page, params.double === true ? [answer, answer] : [answer]);
      const verified = activeRecordIndex(context.snapshot, params.sampleId, 'reserved');
      const recordIndex = projectionOf(context.ui)?.currentPage === 'reserved'
        ? verified.index
        : await openTodoDetail(page, context.snapshot, params.sampleId, params.recordIndex);
      if (params.recordIndex !== undefined && params.recordIndex !== recordIndex) throw new Error(`configured recordIndex does not match reserved pointer for sample: ${params.sampleId}`);
      const evidenceBaseUi = await active.uiProjection();
      return clickAndRead(active, page.locator(`[data-res-cancel="${recordIndex}"]`), params, context, {
        cleanup,
        evidenceBaseUi,
        label: `cancel reserved record ${recordIndex}`,
        outcome: () => cleanup.handledAnswers().includes(answer)
          ? answer ? 'success' : 'cancelled'
          : null,
        message: answer ? 'native cancel confirmation accepted' : 'native cancel confirmation dismissed'
      });
    } }),
  manageRunning: define('manageRunning', { write: true, settlement: MANAGE_RUNNING_SETTLEMENT, revisionDelta: 1, maxMs: 10_000, allowedOutcomes: MUTATION_OUTCOMES, required: ['sampleId'],
    async execute(driver, params, context) {
      if (params.old) return retainedOldResult(context, 'manageRunning', params.sampleId);
      const { activeDriver, page } = await prepareRunningManagement(driver, params, context);
      const evidenceBaseUi = await activeDriver.uiProjection();
      return clickAndRead(activeDriver, page.getByRole('button', { name: '保存测试管理', exact: true }), params, context, { evidenceBaseUi });
    } }),
  finishRunning: define('finishRunning', { write: true, settlement: withPointerTerminal(FINISH_RUNNING_SETTLEMENT), revisionDelta: 1, maxMs: 10_000, allowedOutcomes: MUTATION_OUTCOMES, required: ['sampleId'],
    async execute(driver, params, context) {
      const active = driverFor(driver, params, context); const page = pageFor(driver, params, context);
      const { index } = activeRecordIndex(context.snapshot, params.sampleId, 'running');
      return clickAndRead(active, boundedAction(page, 'record-transition', { transition: 'end', 'record-index': index }), params, context, { label: `finish running ${params.sampleId}` });
    } }),
  startStorage: define('startStorage', { write: true, settlement: START_STORAGE_SETTLEMENT, revisionDelta: 1, maxMs: 15_000, allowedOutcomes: MUTATION_OUTCOMES, required: ['storageId', 'requestNo', 'sampleIds', 'tester', 'expectedEndAt'],
    async execute(driver, params, context) {
      const active = driverFor(driver, params, context);
      const page = pageFor(driver, params, context);
      await openReservationRequest(page, params.requestNo);
      const details = await reservationDetails(page, params.requestNo);
      await details.locator('[data-sample-action="storage-mode-toggle"]').check();
      for (const sampleId of params.sampleIds) {
        await click(
          details.locator(`[data-sample-action="storage-sample-toggle"][data-sample-id="${encodedAttribute(sampleId)}"]`),
          false,
          `select storage sample ${sampleId}`
        );
      }
      await details.locator('[data-legacy-action="end-time"]').fill(datetimeLocalInstant(params.expectedEndAt));
      await details.locator('[data-legacy-action="note"]').fill(String(params.note || ''));
      await armOneShotStorageId(page, params.storageId);
      try {
        return await clickAndRead(
          active,
          details.locator('[data-sample-action="storage-start"]'),
          params,
          context,
          {
            label: `start storage ${params.storageId}`,
            evidence: ui => ui?.projection?.summary?.storageRecords > (context.ui?.projection?.summary?.storageRecords || 0)
          }
        );
      } finally {
        await restoreStorageId(page);
      }
    } }),
  updateStorage: define('updateStorage', { write: true, settlement: UPDATE_STORAGE_SETTLEMENT, revisionDelta: 1, maxMs: 10_000, allowedOutcomes: MUTATION_OUTCOMES, required: ['storageId'],
    validate(params) {
      if (params.status === undefined && params.expectedEndAt === undefined && params.note === undefined) throw new TypeError('storage update requires status, expectedEndAt or note');
    },
    async execute(driver, params, context) {
      const active = driverFor(driver, params, context); const page = pageFor(driver, params, context);
      const record = storageRecord(stateOf(context.snapshot), params.storageId);
      if (!record) throw new Error(`storage record not found: ${params.storageId}`);
      const dialog = await prepareWorkbenchForm(page,
        page.locator(`[data-sample-action="storage-edit"][data-storage-id="${encodedAttribute(params.storageId)}"]`),
        {
          status: params.status ?? record.status,
          expectedEndAt: datetimeLocalInstant(params.expectedEndAt ?? record.expectedEndAt),
          note: params.note ?? record.note ?? ''
        },
        `open storage editor ${params.storageId}`
      );
      return clickAndRead(active, dialog.locator('[data-workbench-submit]'), params, context, { label: `update storage ${params.storageId}` });
    } }),
  finishStorage: define('finishStorage', { write: true, settlement: FINISH_STORAGE_SETTLEMENT, revisionDelta: 1, maxMs: 10_000, allowedOutcomes: MUTATION_OUTCOMES, required: ['storageId'],
    async execute(driver, params, context) {
      const active = driverFor(driver, params, context); const page = pageFor(driver, params, context);
      const answer = params.confirm !== false;
      const cleanup = armConfirmSequence(page, [answer]);
      return clickAndRead(active, page.locator(`[data-sample-action="storage-finish"][data-storage-id="${encodedAttribute(params.storageId)}"]`), params, context, {
        cleanup, label: `finish storage ${params.storageId}`,
        outcome: () => answer ? null : cleanup.handledAnswers().includes(false) ? 'cancelled' : null,
        message: answer ? '' : 'native finish confirmation dismissed'
      });
    } }),
  returnStorage: define('returnStorage', { write: true, settlement: RETURN_STORAGE_SETTLEMENT, revisionDelta: 1, maxMs: 10_000, allowedOutcomes: MUTATION_OUTCOMES, required: ['storageId', 'reason'],
    async execute(driver, params, context) {
      const active = driverFor(driver, params, context); const page = pageFor(driver, params, context);
      const answer = params.confirm !== false;
      const dialog = await prepareWorkbenchForm(page,
        page.locator(`[data-sample-action="storage-return"][data-storage-id="${encodedAttribute(params.storageId)}"]`),
        { reason: params.reason },
        `open storage return ${params.storageId}`
      );
      if (!answer) {
        await click(dialog.locator('[data-workbench-cancel]'), false, `cancel storage return ${params.storageId}`);
        return { outcome: 'cancelled', message: 'in-app storage return form cancelled' };
      }
      return clickAndRead(active, dialog.locator('[data-workbench-submit]'), params, context, { label: `return storage ${params.storageId}` });
    } }),
  returnRunning: define('returnRunning', { write: true, settlement: RETURN_RUNNING_SETTLEMENT, revisionDelta: 1, maxMs: 10_000, allowedOutcomes: MUTATION_OUTCOMES, required: ['sampleId', 'reason'],
    async execute(driver, params, context) {
      const active = driverFor(driver, params, context); const page = pageFor(driver, params, context);
      const record = activeRecord(stateOf(context.snapshot), params.sampleId, 'running');
      if (!record) throw new Error(`running record not found: ${params.sampleId}`);
      const answer = params.confirm !== false;
      const dialog = await prepareWorkbenchForm(page,
        page.locator(`[data-sample-action="running-return"][data-record-id="${encodedAttribute(record.id)}"]`),
        { reason: params.reason },
        `open running return ${params.sampleId}`
      );
      if (!answer) {
        await click(dialog.locator('[data-workbench-cancel]'), false, `cancel running return ${params.sampleId}`);
        return { outcome: 'cancelled', message: 'in-app running return form cancelled' };
      }
      return clickAndRead(active, dialog.locator('[data-workbench-submit]'), params, context, { label: `return running ${params.sampleId}` });
    } }),
  delayRunning: define('delayRunning', { write: true, settlement: DELAY_RUNNING_SETTLEMENT, revisionDelta: 1, maxMs: 10_000, allowedOutcomes: MUTATION_OUTCOMES, required: ['sampleId'],
    async execute(driver, params, context) {
      const { activeDriver: active, page } = await prepareRunningManagement(driver, params, context);
      const cleanup = armConfirmSequence(page, params.confirm === undefined ? [] : [params.confirm]);
      return clickAndRead(active, page.getByRole('button', { name: '保存测试管理', exact: true }), params, context, { cleanup, label: `save delayed running ${params.sampleId}` });
    } }),
  deleteRequest: define('deleteRequest', { write: true, settlement: DELETE_REQUEST_SETTLEMENT, revisionDelta: 1, maxMs: 10_000, allowedOutcomes: MUTATION_OUTCOMES, required: ['requestNo'],
    async execute(driver, params, context) { const active = driverFor(driver, params, context); const page = pageFor(driver, params, context); const cleanup = armConfirmSequence(page, [params.confirm !== false]); return clickAndRead(active, rowButton(page, params.requestNo, '删除'), params, context, { cleanup, label: `delete request ${params.requestNo}` }); } }),
  createTester: define('createTester', { write: true, settlement: CREATE_TESTER_SETTLEMENT, revisionDelta: 1, maxMs: 10_000, allowedOutcomes: MUTATION_OUTCOMES, required: ['name'],
    async execute(driver, params, context) { const active = driverFor(driver, params, context); const page = pageFor(driver, params, context); await page.getByRole('button', { name: /\u65b0增测试人员/ }).click(); await editFields(page.locator('#testerEditor'), { '姓名 *': params.name, '部门': params.dept, '联系方式': params.phone, '备注': params.note }); return clickAndRead(active, page.getByRole('button', { name: '保存测试人员', exact: true }), params, context); } }),
  renameTester: define('renameTester', { write: true, settlement: RENAME_TESTER_SETTLEMENT, revisionDelta: 1, maxMs: 10_000, allowedOutcomes: MUTATION_OUTCOMES, required: ['name', 'nextName'],
    async execute(driver, params, context) { const active = driverFor(driver, params, context); const page = pageFor(driver, params, context); await rowButton(page, params.name, '编辑').click(); await fillOptional(page, '姓名 *', params.nextName); return clickAndRead(active, page.getByRole('button', { name: '保存测试人员', exact: true }), params, context); } }),
  deleteTester: define('deleteTester', { write: true, settlement: DELETE_TESTER_SETTLEMENT, revisionDelta: 1, maxMs: 10_000, allowedOutcomes: MUTATION_OUTCOMES, required: ['name'],
    async execute(driver, params, context) { const active = driverFor(driver, params, context); const page = pageFor(driver, params, context); const cleanup = armConfirmSequence(page, [params.confirm !== false]); return clickAndRead(active, rowButton(page, params.name, '删除'), params, context, { cleanup, label: `delete tester ${params.name}` }); } }),
  createDevice: define('createDevice', { write: true, settlement: CREATE_DEVICE_SETTLEMENT, revisionDelta: 1, maxMs: 10_000, allowedOutcomes: MUTATION_OUTCOMES, required: ['name'],
    async execute(driver, params, context) {
      const active = driverFor(driver, params, context);
      const page = pageFor(driver, params, context);
      await click(page.getByRole('button', { name: '＋ 新建设备', exact: true }), false, 'open device editor');
      const editor = await unique(page.locator('#deviceEditor'), 'device editor');
      await editor.waitFor({ state: 'visible' });
      await editFields(editor, { '设备名称 *': params.name, '设备厂家': params.manufacturer, '温度范围': params.temperature, '备注': params.note });
      return clickAndRead(active, editor.getByRole('button', { name: '保存设备', exact: true }), params, context);
    } }),
  createChannel: define('createChannel', { write: true, settlement: CREATE_CHANNEL_SETTLEMENT, revisionDelta: 1, maxMs: 10_000, allowedOutcomes: MUTATION_OUTCOMES, required: ['device', 'name'],
    async execute(driver, params, context) {
      const active = driverFor(driver, params, context);
      const page = pageFor(driver, params, context);
      const create = await unique(boundedAction(page, 'add-channel', { device: encodeURIComponent(params.device) }), `add channel for device ${params.device}`);
      await click(create, false, `open channel editor for ${params.device}`);
      const editor = await unique(page.locator('#channelEditor'), 'channel editor');
      await editor.waitFor({ state: 'visible' });
      const selectedDevice = await editor.locator('#cDevice').inputValue();
      if (selectedDevice !== params.device) throw new Error(`channel editor device mismatch: expected ${params.device}, actual ${selectedDevice}`);
      await editFields(editor, { '通道号 *': params.name, '温度范围': params.temperature, '备注': params.note });
      return clickAndRead(active, editor.getByRole('button', { name: '保存通道', exact: true }), params, context);
    } }),
  deleteResource: define('deleteResource', { write: true, settlement: DELETE_RESOURCE_SETTLEMENT, revisionDelta: 1, maxMs: 10_000, allowedOutcomes: MUTATION_OUTCOMES, required: ['kind', 'name'],
    async execute(driver, params, context) {
      const active = driverFor(driver, params, context);
      const page = pageFor(driver, params, context);
      const cleanup = armConfirmSequence(page, [params.confirm !== false]);
      let target;
      if (params.kind === 'channel') {
        const filter = await unique(
          page.getByLabel('搜索设备、通道或量程', { exact: true }),
          'channel delete filter'
        );
        await filter.fill(String(params.name));
        target = await unique(
          boundedAction(page, 'delete-channel', { 'channel-key': encodeURIComponent(params.name) }),
          `delete channel ${params.name}`
        );
      } else {
        const devices = stateOf(context.snapshot)?.deviceProfiles || [];
        const matches = devices.filter(device => device?.name === params.name);
        if (matches.length !== 1) throw new Error(`delete device ${params.name} must resolve exactly once; actual ${matches.length}`);
        const deviceId = matches[0]?.id;
        if (typeof deviceId !== 'string' || deviceId.trim() === '') throw new Error(`delete device ${params.name} requires a non-empty device id`);
        target = await unique(
          boundedAction(page, 'delete-device', { 'device-id': encodeURIComponent(deviceId) }),
          `delete device ${params.name}`
        );
      }
      return clickAndRead(active, target, params, context, { cleanup, label: `delete ${params.kind} ${params.name}` });
    } }),
  exportLog: define('exportLog', { write: true, settlement: EXPORT_LOG_SETTLEMENT, revisionDelta: [0, 1], maxMs: 30_000, allowedOutcomes: FILE_OUTCOMES, validate: requireSavePath,
    async execute(driver, params, context) { const active = driverFor(driver, params, context); await configureSave(active, params, context); return clickAndRead(active, pageFor(driver, params, context).getByRole('button', { name: /\u5bfc出 Excel/ }), params, context, { label: 'export log', outcome: params.cancel === true ? 'cancelled' : undefined, message: params.cancel === true ? 'native export dialog cancelled by configured route' : undefined }); } }),
  exportRequest: define('exportRequest', { write: true, settlement: EXPORT_REQUEST_SETTLEMENT, revisionDelta: [0, 1], maxMs: 30_000, allowedOutcomes: FILE_OUTCOMES, validate: requireSavePath,
    async execute(driver, params, context) { const active = driverFor(driver, params, context); await configureSave(active, params, context); return clickAndRead(active, pageFor(driver, params, context).getByRole('button', { name: /\u5bfc出申请汇总/ }), params, context, { label: 'export request', outcome: params.cancel === true ? 'cancelled' : undefined, message: params.cancel === true ? 'native export dialog cancelled by configured route' : undefined }); } }),
  backup: define('backup', { write: true, settlement: BACKUP_SETTLEMENT, revisionDelta: [0, 1], maxMs: 30_000, allowedOutcomes: FILE_OUTCOMES, validate: requireSavePath,
    async execute(driver, params, context) { const active = driverFor(driver, params, context); await configureSave(active, params, context); return clickAndRead(active, pageFor(driver, params, context).getByRole('button', { name: '备份数据', exact: true }), params, context, { label: 'backup', outcome: params.cancel === true ? 'cancelled' : undefined, message: params.cancel === true ? 'native backup dialog cancelled by configured route' : undefined }); } }),
  restore: define('restore', { write: true, settlement: RESTORE_SETTLEMENT, revisionDelta: [0, 1], maxMs: 30_000, allowedOutcomes: FILE_OUTCOMES,
    validate(params) { if (params.cancel !== true && missing(params.path)) throw new TypeError('path required'); },
    async execute(driver, params, context) { const active = driverFor(driver, params, context); const page = pageFor(driver, params, context); await configureRestore(active, params, context); const cleanup = armConfirmSequence(page, [params.confirm !== false]); return clickAndRead(active, page.getByRole('button', { name: '恢复数据包', exact: true }), params, context, { cleanup, label: 'restore', outcome: params.cancel === true ? 'cancelled' : undefined, message: params.cancel === true ? 'native restore dialog cancelled by configured route' : undefined }); } }),
  restart: define('restart', { write: false, revisionDelta: [2, 3], maxMs: 30_000, allowedOutcomes: SUCCESS,
    async execute(driver, params, context) { const active = driverFor(driver, params, context); await active.restart(); return reenterAfterLifecycle(active, context, 'restart'); } }),
  staleSubmit: define('staleSubmit', { write: true, settlement: NO_AUDIT_SETTLEMENT, revisionDelta: 0, maxMs: 10_000, allowedOutcomes: REJECTION_OUTCOMES,
    async execute(driver, params, context) {
      if (params.old) return retainedOldResult(context, 'staleSubmit', params.sampleId);
      const operation = params.operation || 'reserve';
      if (params.session === 'B') {
        const drafts = runtimeFor(context)?.staleDrafts;
        const key = staleDraftKey(params.session, operation);
        const draft = drafts instanceof Map ? drafts.get(key) : null;
        if (!matchesStaleDraft(draft, params)) throw new Error(`matching stale draft is required: ${key}`);
        drafts.delete(key);
        try {
          if (typeof draft.locator.evaluate === 'function' && !await draft.locator.evaluate(node => Boolean(node?.isConnected))) {
            return { outcome: 'rejected', message: 'prepared stale submit detached after state replacement' };
          }
          const beforeMessage = await messageState(draft.driver.page(), context);
          await draft.locator.click();
          return { awaitEvidence: true, evidenceBaseUi: context.ui, beforeMessage, label: 'prepared stale submit' };
        } catch {
          return { outcome: 'rejected', message: 'prepared stale submit detached after state replacement' };
        }
      }
      const prepared = operation === 'manageRunning'
        ? await prepareRunningManagement(driver, params, context)
        : await prepareReservation(driver, params, context, 'reserve');
      const evidenceBaseUi = await prepared.activeDriver.uiProjection();
      return clickAndRead(prepared.activeDriver, prepared.page.getByRole('button', { name: operation === 'manageRunning' ? '保存测试管理' : '提交预约', exact: true }), params, context, { evidenceBaseUi, label: 'stale submit' });
    } }),
  lockedWrite: define('lockedWrite', { write: true, settlement: NO_AUDIT_SETTLEMENT, revisionDelta: 0, maxMs: 20_000, allowedOutcomes: REJECTION_OUTCOMES, required: ['operation'],
    async execute(driver, params, context) {
      const prepared = params.operation === 'manageRunning'
        ? await prepareRunningManagement(driver, params, context)
        : await prepareReservation(driver, params, context, 'reserve');
      const evidenceBaseUi = await prepared.activeDriver.uiProjection();
      if (typeof context.armWriteLock !== 'function') throw new Error('armWriteLock capability is required');
      const releaseLock = await context.armWriteLock({ operation: params.operation, driver: prepared.activeDriver });
      if (typeof releaseLock !== 'function') throw new Error('armWriteLock must return a release function');
      try {
        return await clickAndRead(prepared.activeDriver, prepared.page.getByRole('button', {
          name: params.operation === 'manageRunning' ? '保存测试管理' : '提交预约', exact: true
        }), params, context, { evidenceBaseUi, cleanup: releaseLock, label: `locked ${params.operation}` });
      } catch (error) {
        releaseLock();
        throw error;
      }
    } }),

  editDraft: define('editDraft', { write: false, revisionDelta: 0, maxMs: 5_000, allowedOutcomes: SUCCESS, required: ['label', 'value'],
    async execute(driver, params, context) { const runtime = runtimeFor(context); if (!runtime) throw new Error('mutable runtime is required'); const prepared = params.requestNo === undefined ? { page: pageFor(driver, params, context) } : await prepareReservation(driver, params, context, 'reserve'); const field = await draftField(prepared.page, params.label, params.requestNo !== undefined); await field.fill(String(params.value)); runtime.draft = { label: params.label, value: String(params.value), ...(params.requestNo === undefined ? {} : { requestNo: params.requestNo, sampleIds: [...params.sampleIds], channelKeys: [...params.channelKeys] }) }; return { outcome: 'success' }; } }),
  assertDraftDiscarded: define('assertDraftDiscarded', { write: false, revisionDelta: 0, maxMs: 5_000, allowedOutcomes: SUCCESS,
    async execute(driver, params, context) { const runtime = runtimeFor(context); if (!runtime) throw new Error('mutable runtime is required'); const label = params.label || runtime.draft?.label; if (!label) throw new Error('draft label is unavailable'); const value = await pageFor(driver, params, context).getByLabel(label, { exact: true }).inputValue(); if (value === runtime.draft?.value) throw new Error('draft was not discarded'); return { outcome: 'success', message: 'draft discarded' }; } }),
  assertDraftPreserved: define('assertDraftPreserved', { write: false, revisionDelta: 0, maxMs: 5_000, allowedOutcomes: SUCCESS,
    async execute(driver, params, context) { const runtime = runtimeFor(context); if (!runtime) throw new Error('mutable runtime is required'); const label = params.label || runtime.draft?.label; if (!label) throw new Error('draft label is unavailable'); const field = await draftField(pageFor(driver, params, context), label, Boolean(runtime.draft?.requestNo)); const value = await field.inputValue(); if (value !== runtime.draft?.value) throw new Error('reservation draft was not preserved'); return { outcome: 'success', message: 'draft preserved' }; } }),
  reloadCurrent: define('reloadCurrent', { write: false, revisionDelta: [2, 3], maxMs: 10_000, allowedOutcomes: SUCCESS,
    async execute(driver, params, context) { const active = driverFor(driver, params, context); const page = pageFor(driver, params, context); await page.reload(); await page.waitForLoadState('domcontentloaded'); return reenterAfterLifecycle(active, context, 'reload'); } }),
  openSecondSession: define('openSecondSession', { write: false, revisionDelta: [0, 1, 2, 3], evidenceRevisionDelta: [0, 1, 2, 3], maxMs: 30_000, allowedOutcomes: SUCCESS,
    async execute(_driver, params, context) {
      const runtime = runtimeFor(context);
      if (!runtime) throw new Error('mutable runtime is required');
      if (runtime.secondDriver) throw new Error('second session is already open');
      if (typeof context.createDriver !== 'function') throw new Error('createDriver is required');
      const second = await context.createDriver(params);
      await second.start();
      runtime.secondDriver = second;
      if (params.prepareStale) await prepareSecondSessionStaleDraft(second, params.prepareStale, context);
      return { outcome: 'success' };
    } }),
  closeSecondSession: define('closeSecondSession', { write: false, revisionDelta: [0, 1], evidenceRevisionDelta: [0, 1], maxMs: 30_000, allowedOutcomes: SUCCESS,
    async execute(_driver, _params, context) { const runtime = runtimeFor(context); if (!runtime) throw new Error('mutable runtime is required'); if (!runtime.secondDriver) throw new Error('second session is not open'); const second = runtime.secondDriver; runtime.secondDriver = null; await second.close(); return { outcome: 'success' }; } }),
  retainOldDom: define('retainOldDom', { write: false, revisionDelta: 0, maxMs: 5_000, allowedOutcomes: SUCCESS,
    execute(driver, params, context) { return captureRetainedDom(driver, params, context); } })
};

export const ACTION_LIBRARY = Object.freeze(definitions);

export function validateWorkflowActionContract(action, { requireFullPayload = true } = {}) {
  if (!action || typeof action !== 'object' || Array.isArray(action)) {
    throw actionError('missing', 'validate', 'action must be an object');
  }
  if (requireFullPayload) {
    for (const field of ['id', 'type', 'params', 'expect', 'revisionDelta', 'evidenceRevisionDelta', 'maxMs']) {
      if (action[field] === undefined) throw actionError(String(action.type || 'missing'), 'validate', `missing replay field: ${field}`);
    }
    try { validateString(action.id, 'id'); } catch (error) { throw actionError(String(action.type || 'missing'), 'validate', error.message, error); }
  }
  const type = String(action.type || 'missing');
  const definition = ACTION_LIBRARY[type];
  if (!definition) throw actionError(type, 'resolve', 'unknown action type');
  const params = action.params ?? {};
  if (!params || typeof params !== 'object' || Array.isArray(params)) throw actionError(type, 'validate', 'params must be an object');
  for (const name of definition.required) {
    if (missing(params[name])) throw actionError(type, 'validate', `missing parameter: ${name}`);
  }
  if (action.expect !== undefined) {
    if (!OUTCOMES.has(action.expect)) throw actionError(type, 'validate', 'expect must be a declared workflow outcome');
    if (!definition.allowedOutcomes.includes(action.expect)) throw actionError(type, 'validate', `expect ${action.expect} is not allowed`);
  }
  try {
    validateActionParams(type, params);
    definition.validate?.(params);
  } catch (error) {
    throw actionError(type, 'validate', error.message, error);
  }
  const revisionDelta = action.revisionDelta ?? definition.revisionDelta;
  try {
    expectedDeltas(revisionDelta);
  } catch (error) {
    throw actionError(type, 'validate', error.message, error);
  }
  const evidenceRevisionDelta = action.evidenceRevisionDelta ?? definition.evidenceRevisionDelta ?? revisionDelta;
  try {
    expectedDeltas(evidenceRevisionDelta);
  } catch (error) {
    throw actionError(type, 'validate', `evidenceRevisionDelta: ${error.message}`, error);
  }
  const maxMs = action.maxMs ?? definition.maxMs;
  if (!Number.isFinite(maxMs) || maxMs <= 0 || maxMs > definition.maxMs) {
    throw actionError(type, 'validate', `maxMs must be within 1..${definition.maxMs}`);
  }
  const contract = { type, params, revisionDelta, evidenceRevisionDelta, maxMs };
  Object.defineProperty(contract, 'definition', { value: definition });
  return Object.freeze(contract);
}

export async function executeWorkflowAction({ driver, action, context = {} }) {
  const contract = validateWorkflowActionContract(action, { requireFullPayload: false });
  const { type, params, revisionDelta, evidenceRevisionDelta, maxMs } = contract;
  const definition = contract.definition;
  if (runtimeFor(context)?.poisoned) throw actionError(type, 'available', 'workflow runtime is poisoned');
  const allowedDeltas = expectedDeltas(revisionDelta);
  const evidenceAllowedDeltas = expectedDeltas(evidenceRevisionDelta);
  if (!driver || typeof driver.page !== 'function' || typeof driver.uiProjection !== 'function') {
    throw actionError(type, 'validate', 'driver must provide page() and uiProjection()');
  }

  const deadline = Date.now() + maxMs;
  const remainingMs = stage => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      const error = actionError(type, stage, `timed out after ${maxMs}ms`);
      error.code = 'ACTION_TIMEOUT';
      throw error;
    }
    return remaining;
  };
  const activeDriver = type === 'openSecondSession'
    ? driver
    : driverFor(driver, params, context);
  const finalProjectionDriver = type === 'closeSecondSession'
    ? driver
    : activeDriver;
  const usesCachedStaleDraft = type === 'staleSubmit' && params.session === 'B' && params.old !== true;
  const staleDrafts = runtimeFor(context)?.staleDrafts;
  const cachedStaleDraft = usesCachedStaleDraft
    && staleDrafts instanceof Map
    ? staleDrafts.get(staleDraftKey(params.session, params.operation))
    : null;
  if (usesCachedStaleDraft && !matchesStaleDraft(cachedStaleDraft, params)) {
    throw actionError(type, 'available', `matching stale draft is required: ${staleDraftKey(params.session, params.operation)}`);
  }
  let actionResult;
  let settlement = null;
  let outcome;
  let inFlight = null;
  let currentStage = 'initial projection';

  async function runStage(stage, operation) {
    currentStage = stage;
    const remaining = remainingMs(stage);
    let timer;
    const operationPromise = Promise.resolve().then(operation);
    inFlight = operationPromise;
    void operationPromise.catch(() => undefined);
    try {
      return await Promise.race([
        operationPromise,
        new Promise((_, reject) => {
          timer = setTimeout(() => {
            const error = actionError(type, stage, `timed out after ${maxMs}ms`);
            error.code = 'ACTION_TIMEOUT';
            reject(error);
          }, remaining);
        })
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  let ui;
  let result;
  try {
    ui = usesCachedStaleDraft
      ? cachedStaleDraft.evidenceBaseUi
      : await runStage('initial projection', () => activeDriver.uiProjection());
    const allowed = await runStage('available', () => definition.available(context.snapshot, ui, params, context));
    const expectedUnavailableMisuse = !allowed && type === 'unselectChannel' && action.expect === 'rejected';
    if (!allowed && !expectedUnavailableMisuse) throw actionError(type, 'available', 'action is unavailable for current state');
    const targetUi = expectedUnavailableMisuse
      ? ui
      : await runStage('ensure page', () => ensureBusinessPage(driver, params, { ...context, ui }, type));
    const scope = definition.write
      ? usesCachedStaleDraft
        ? persistenceBoundaryFromSnapshot(context.snapshot)
        : await runStage('before boundary', () => activeDriver.capturePersistenceBoundary({ timeoutMs: remainingMs('before boundary') }))
      : null;
    const executionContext = Object.freeze({
      ...context,
      ui: usesCachedStaleDraft ? projectionAtRevision(targetUi, scope.revision) : targetUi
    });
    actionResult = await runStage('execute', () => definition.execute(driver, params, executionContext));
    if (actionResult?.awaitEvidence) {
      const evidenceBaseUi = actionResult.evidenceBaseUi ?? targetUi;
      const evidenceMargin = Math.min(50, Math.max(5, Math.floor(maxMs / 10)));
      const evidenceDeadline = deadline - evidenceMargin;
      const evidence = await runStage('evidence', () => waitForEvidence({ driver: activeDriver, beforeUi: evidenceBaseUi, allowedDeltas: evidenceAllowedDeltas, context: executionContext, result: actionResult, deadline: evidenceDeadline }));
      result = { ...evidence, evidenceBaseUi };
    } else {
      result = {
        ...actionResult,
        evidenceBaseUi: actionResult?.evidenceBaseUi ?? (usesCachedStaleDraft ? executionContext.ui : targetUi)
      };
    }
    outcome = result?.outcome;
    if (!OUTCOMES.has(outcome) || !definition.allowedOutcomes.includes(outcome)) {
      throw actionError(type, 'outcome', `undeclared outcome: ${String(outcome)}`);
    }
    if (action.expect !== undefined && outcome !== action.expect) throw actionError(type, 'outcome', `expected ${action.expect}, actual ${outcome}`);
    settlement = definition.write
      ? await runStage('settlement', () => settleWorkflowAction({
          driver: activeDriver, definition, params, outcome, scope,
          result, deadline, context: executionContext
        }))
      : null;
  } catch (error) {
    if (error?.code === 'ACTION_TIMEOUT') {
      const runtime = runtimeFor(context);
      if (runtime) runtime.poisoned = true;
      const cleanupFailures = [];
      const cleanupBudget = Math.min(500, Math.max(50, maxMs));
      try {
        if (typeof activeDriver.close !== 'function') throw new Error('active driver does not provide close()');
        await boundedOperation(activeDriver.close(), cleanupBudget, 'driver close timed out');
      } catch (cleanupError) {
        cleanupFailures.push(cleanupError);
      }
      try {
        await boundedOperation(Promise.resolve(inFlight).catch(() => undefined), cleanupBudget, 'late action did not settle after close');
      } catch (settleError) {
        cleanupFailures.push(settleError);
      }
      actionResult?.cleanup?.();
      if (cleanupFailures.length) {
        throw new AggregateError([error, ...cleanupFailures], `[${type}] ${currentStage} timed out; cleanup failed`, { cause: error });
      }
      throw error;
    }
    if (String(error?.message).startsWith(`[${type}] `)) throw error;
    if (/no (?:fresh )?explicit outcome evidence/.test(String(error?.message))) throw actionError(type, 'evidence', error.message, error);
    throw actionError(type, currentStage, error.message || 'action failed', error);
  } finally {
    actionResult?.cleanup?.();
  }

  let uiEvidence = settlement?.uiEvidence;
  if (!settlement) {
    try {
      uiEvidence = await runStage('final projection', () => finalProjectionDriver.uiProjection());
    } catch (error) {
      if (error?.code === 'ACTION_TIMEOUT') {
        const runtime = runtimeFor(context);
        if (runtime) runtime.poisoned = true;
        const cleanupFailures = [];
        const cleanupBudget = Math.min(500, Math.max(50, maxMs));
        try { await boundedOperation(activeDriver.close(), cleanupBudget, 'driver close timed out'); } catch (cleanupError) { cleanupFailures.push(cleanupError); }
        try { await boundedOperation(Promise.resolve(inFlight).catch(() => undefined), cleanupBudget, 'late final projection did not settle after close'); } catch (settleError) { cleanupFailures.push(settleError); }
        if (cleanupFailures.length) throw new AggregateError([error, ...cleanupFailures], `[${type}] final projection timed out; cleanup failed`, { cause: error });
        throw error;
      }
      throw actionError(type, 'final projection', error.message || 'UI projection failed', error);
    }
  }
  const beforeRevision = revisionOf(result.evidenceBaseUi ?? ui);
  const afterRevision = revisionOf(uiEvidence);
  if (settlement) {
    const actualDelta = settlement.persistedRevision - settlement.beforeRevision;
    const persistedAllowedDeltas = NON_MUTATING_OUTCOMES.has(outcome) ? [0] : allowedDeltas;
    if (!persistedAllowedDeltas.includes(actualDelta)) {
      throw actionError(type, 'revision', `expected ${persistedAllowedDeltas.join(' or ')}, actual ${actualDelta}`);
    }
    if (OUTCOME_REVISION_ACTIONS.has(type) && outcome === 'success' && actualDelta !== 1) {
      throw actionError(type, 'revision', `success requires 1, actual ${actualDelta}`);
    }
    if (OUTCOME_REVISION_ACTIONS.has(type) && outcome === 'cancelled' && actualDelta !== 0) {
      throw actionError(type, 'revision', `cancelled requires 0, actual ${actualDelta}`);
    }
  }
  if (beforeRevision !== null && afterRevision !== null) {
    const actualDelta = afterRevision - beforeRevision;
    const allowedEvidenceDeltas = NON_MUTATING_OUTCOMES.has(outcome) ? [0] : evidenceAllowedDeltas;
    if (!allowedEvidenceDeltas.includes(actualDelta)) {
      throw actionError(type, 'revision', `expected evidence delta ${allowedEvidenceDeltas.join(' or ')}, actual ${actualDelta}`);
    }
  }
  const pageEvidence = result.pageEvidence === undefined ? undefined : immutableSnapshot(result.pageEvidence);
  let navigationEvidence;
  if (result.navigationEvidence !== undefined) {
    const from = result.navigationEvidence.from;
    const expected = result.navigationEvidence.expected;
    const to = projectionOf(uiEvidence)?.currentPage;
    if (to !== expected) throw actionError(type, 'final projection', `navigation expected ${expected}, observed ${to || '<unknown>'}`);
    navigationEvidence = immutableSnapshot({ from, to, changed: from !== to });
  }
  const rawImportEvidence = result.importEvidence ?? actionResult?.importEvidence;
  const importEvidence = rawImportEvidence === undefined ? undefined : immutableSnapshot(rawImportEvidence);
  const rawSearchEvidence = result.searchEvidence ?? actionResult?.searchEvidence;
  const searchEvidence = rawSearchEvidence === undefined ? undefined : immutableSnapshot(rawSearchEvidence);
  return Object.freeze({
    outcome,
    uiEvidence,
    message: String(result.message || ''),
    settlement,
    ...(pageEvidence ? { pageEvidence } : {}),
    ...(navigationEvidence ? { navigationEvidence } : {}),
    ...(importEvidence ? { importEvidence } : {}),
    ...(searchEvidence ? { searchEvidence } : {})
  });
}
