import path from 'node:path';
import { stat } from 'node:fs/promises';

import { ACTION_LIBRARY, executeWorkflowAction } from './actions.mjs';
import { normalizeActionResult } from './contracts.mjs';
import { checkWorkflowInvariants } from './invariants.mjs';
import { canonicalStateHash, readWorkflowSnapshot, summarizeState } from './state-probe.mjs';

const DEFAULT_CLOSE_TIMEOUT_MS = 12_000;
const RESTART_LIFECYCLE_AUDITS = new Set(['登录看板', '日志初始化', '查看页面']);
let restartVerifierSequence = 0;

class SettlementSnapshotDriftError extends Error {
  constructor(action, shellRevision, settlementRevision) {
    super(
      `[${action.type}] runner: settlement snapshot drift; fresh shell revision ${String(shellRevision)}, settlement revision ${String(settlementRevision)}`
    );
    this.code = 'SETTLEMENT_SNAPSHOT_DRIFT';
    this.violation = Object.freeze({
      code: 'SETTLEMENT_SNAPSHOT_DRIFT',
      severity: 'P0',
      message: this.message,
      entityIds: Object.freeze([String(action.id)])
    });
  }
}

function nowIso(clock) {
  const value = clock();
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new TypeError('clock must return a valid date');
  return date.toISOString();
}

function timestampWithFallback(clock, fallback) {
  try {
    return Object.freeze({ value: nowIso(clock), error: null });
  } catch (error) {
    return Object.freeze({ value: fallback, error });
  }
}

function cloneArray(value) {
  return Array.isArray(value) ? structuredClone(value) : [];
}

function snapshotAtBoundary(shell, boundaryState, action, { strictRevision, source }) {
  const shellRevision = shell?.state?.revision;
  const settlementRevision = boundaryState?.revision;
  if (strictRevision && shellRevision !== settlementRevision) {
    throw new SettlementSnapshotDriftError(action, shellRevision, settlementRevision);
  }
  const state = structuredClone(boundaryState);
  return Object.freeze({
    ...shell,
    state,
    summary: summarizeState(state),
    auditLogs: cloneArray(state.auditLogs),
    formJournal: cloneArray(state.formChangeJournal),
    hash: canonicalStateHash(state),
    boundaryMetadata: Object.freeze({
      source,
      shellRevision,
      sqlitePath: shell?.sqlitePath,
      integrity: Object.freeze(cloneArray(shell?.integrity))
    })
  });
}

function structuralKey(value) {
  if (!value || typeof value !== 'object') return JSON.stringify(value);
  if (String(value.id ?? '').trim()) return `id:${String(value.id).trim()}`;
  const stable = input => {
    if (Array.isArray(input)) return input.map(stable);
    if (!input || typeof input !== 'object') return input;
    return Object.fromEntries(Object.keys(input).sort().map(key => [key, stable(input[key])]));
  };
  return `value:${JSON.stringify(stable(value))}`;
}

function arrayDifference(before, after) {
  const remaining = new Map();
  for (const item of cloneArray(before)) {
    const key = structuralKey(item);
    remaining.set(key, (remaining.get(key) || 0) + 1);
  }
  return cloneArray(after).filter(item => {
    const key = structuralKey(item);
    const count = remaining.get(key) || 0;
    if (count === 0) return true;
    if (count === 1) remaining.delete(key);
    else remaining.set(key, count - 1);
    return false;
  });
}

function auditEvidence(before, after, settlement) {
  const auditLogs = settlement
    ? after.auditLogs.filter(item => new Set(settlement.auditIds || []).has(item?.id))
    : arrayDifference(before.auditLogs, after.auditLogs);
  return Object.freeze({
    auditLogs: Object.freeze(structuredClone(auditLogs)),
    formJournal: Object.freeze(arrayDifference(before.formJournal, after.formJournal))
  });
}

function failureResult({ workflow, steps, startedAt, lastSuccessfulActionId, action, error, violation, stage }) {
  const failure = {
    ...(stage ? { stage } : {}),
    actionId: action?.id ?? null,
    ...(error ? { error } : {}),
    ...(violation ? { violation } : {})
  };
  return {
    workflowId: workflow?.id ?? null,
    status: 'failed',
    startedAt,
    finishedAt: null,
    steps,
    lastSuccessfulActionId,
    failure
  };
}

function isWithin(parent, candidate) {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function validateRunContext(workflow, runContext) {
  if (!runContext || typeof runContext !== 'object') throw new TypeError('runContext is required');
  if (runContext.workflowId !== workflow.id) {
    throw new Error(`runContext workflowId mismatch: expected ${workflow.id}, got ${String(runContext.workflowId)}`);
  }
  if (runContext.fixture !== workflow.fixture) {
    throw new Error(`runContext fixture mismatch: expected ${workflow.fixture}, got ${String(runContext.fixture)}`);
  }
  if (typeof runContext.fixtureSha256 !== 'string' || runContext.fixtureSha256.trim() === '') {
    throw new TypeError('runContext.fixtureSha256 is required');
  }
  for (const key of ['runRoot', 'dataRoot', 'profileRoot', 'exportsRoot', 'screenshotsRoot']) {
    if (typeof runContext[key] !== 'string' || runContext[key].trim() === '') {
      throw new TypeError(`runContext.${key} is required`);
    }
    if (key !== 'runRoot' && !isWithin(runContext.runRoot, runContext[key])) {
      throw new Error(`runContext.${key} must be inside runRoot`);
    }
  }
  if (typeof runContext.assertWritable !== 'function') throw new TypeError('runContext.assertWritable is required');
  if (typeof runContext.verifyProtected !== 'function') throw new TypeError('runContext.verifyProtected is required');
  if (typeof runContext.cleanup !== 'function') throw new TypeError('runContext.cleanup is required');
  for (const key of ['dataRoot', 'profileRoot', 'exportsRoot', 'screenshotsRoot']) {
    runContext.assertWritable(runContext[key]);
  }
}

function deterministicActionSource(actions) {
  let index = 0;
  return Object.freeze({
    kind: 'deterministic',
    needsUi: false,
    maxSteps: actions.length,
    next() { return actions[index++] ?? null; }
  });
}

function resolveActionSource(workflow, actionSource) {
  const source = actionSource ?? deterministicActionSource(workflow.actions);
  if (!source || typeof source.next !== 'function') throw new TypeError('actionSource.next is required');
  if (!['dynamic', 'deterministic', 'replay'].includes(source.kind)) {
    throw new TypeError('actionSource.kind must be dynamic, deterministic, or replay');
  }
  if (source.kind === 'dynamic' && source.needsUi !== true) {
    throw new TypeError('dynamic actionSource needsUi must be true');
  }
  if (source.kind !== 'dynamic' && source.needsUi === true) {
    throw new TypeError(`${source.kind} actionSource must not request planning UI`);
  }
  if (!Number.isInteger(source.maxSteps) || source.maxSteps < 0) {
    throw new TypeError('actionSource.maxSteps must be a non-negative integer');
  }
  return source;
}

function actionSourceLimitViolation(maxSteps) {
  return Object.freeze({
    code: 'ACTION_SOURCE_MAX_STEPS',
    severity: 'P0',
    message: `action source exceeded maxSteps ${maxSteps}`,
    entityIds: Object.freeze([])
  });
}

function restartBusinessHash(state) {
  const normalized = structuredClone(state ?? {});
  delete normalized.revision;
  delete normalized.savedAt;
  normalized.auditLogs = cloneArray(normalized.auditLogs)
    .filter(item => !RESTART_LIFECYCLE_AUDITS.has(String(item?.action || '').trim()));
  return canonicalStateHash(normalized);
}

function restartHashViolation(beforeHash, afterHash) {
  return Object.freeze({
    code: 'RESTART_BUSINESS_HASH_MISMATCH',
    severity: 'P0',
    message: `restart business hash ${afterHash} differs from ${beforeHash}`,
    entityIds: Object.freeze([])
  });
}

function profilePathKey(value) {
  const resolved = path.resolve(String(value));
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

async function profileExists(candidate) {
  try {
    await stat(candidate);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

async function allocateVerifierProfile({ runContext, deps, usedProfileRoots }) {
  const used = new Set(usedProfileRoots.map(profilePathKey));
  for (let attempt = 0; attempt < 10_000; attempt += 1) {
    restartVerifierSequence += 1;
    const profileRoot = path.join(
      runContext.profileRoot,
      `restart-verifier-${String(restartVerifierSequence).padStart(6, '0')}`
    );
    runContext.assertWritable(profileRoot);
    if (used.has(profilePathKey(profileRoot))) continue;
    if (await deps.profileExists(profileRoot)) continue;
    return profileRoot;
  }
  throw new Error('unable to allocate an unused restart verifier profile');
}

async function runRestartVerification({
  result,
  workflow,
  runContext,
  driverFactory,
  deps,
  usedProfileRoots
}) {
  const coordinator = new DriverCoordinator();
  let profileRoot = null;
  let restart = null;
  let restartFailure = null;
  try {
    profileRoot = await allocateVerifierProfile({ runContext, deps, usedProfileRoots });
    const before = await deps.readSnapshot({ dataRoot: runContext.dataRoot });
    const businessHashBefore = restartBusinessHash(before.state);
    const durableViolations = await deps.checkInvariants({
      before,
      after: before,
      action: { id: 'restart-durable', type: 'restartVerification', outcome: 'success' },
      ui: null,
      restart: null
    });
    if (!Array.isArray(durableViolations)) throw new TypeError('checkInvariants must return an array');
    const invariantRuns = [{ stage: 'durable', violations: durableViolations }];
    restart = {
      profileRoot,
      durableSnapshot: before,
      businessHashBefore,
      invariantRuns,
      violations: [...durableViolations]
    };
    const verifier = coordinator.register(await driverFactory({
      workflow,
      runContext,
      role: 'restart-verifier',
      profileRoot
    }), 'restart-verifier', profileRoot);
    if (!verifier || typeof verifier.start !== 'function') {
      throw new TypeError('restart verifier must be an unstarted driver with start()');
    }
    if (typeof verifier.uiProjection !== 'function') {
      throw new TypeError('restart verifier uiProjection() is required');
    }
    await verifier.start();
    const after = await deps.readSnapshot({ dataRoot: runContext.dataRoot });
    const ui = await verifier.uiProjection();
    const businessHashAfter = restartBusinessHash(after.state);
    const freshViolations = await deps.checkInvariants({
      before,
      after,
      action: { id: 'restart-fresh', type: 'restartVerification', outcome: 'success' },
      ui,
      restart: null
    });
    if (!Array.isArray(freshViolations)) throw new TypeError('checkInvariants must return an array');
    invariantRuns.push({ stage: 'fresh', violations: freshViolations });
    const violations = [...durableViolations, ...freshViolations];
    if (businessHashBefore !== businessHashAfter) {
      violations.unshift(restartHashViolation(businessHashBefore, businessHashAfter));
    }
    Object.assign(restart, {
      snapshot: after,
      ui,
      businessHashAfter,
      violations
    });
    const blocking = violations.find(item => item?.severity === 'P0' || item?.severity === 'P1');
    if (blocking) {
      restartFailure = { stage: 'restart-verification', actionId: null, violation: blocking };
    }
  } catch (error) {
    restartFailure = { stage: 'restart-verification', actionId: null, error };
  } finally {
    const cleanup = await coordinator.closeAll({
      timeoutMs: deps.closeTimeoutMs,
      scheduleTimeout: deps.scheduleTimeout,
      clearScheduledTimeout: deps.clearScheduledTimeout
    });
    restart ??= { profileRoot };
    restart.cleanup = cleanup;
    if (!['closed', 'not_started'].includes(cleanup.status)) {
      if (restartFailure) restartFailure.cleanup = cleanup;
      else {
        const error = cleanup.error ?? Object.assign(
          new Error(`restart verifier close timed out after ${cleanup.timeoutMs}ms`),
          { code: 'DRIVER_CLOSE_TIMEOUT' }
        );
        restartFailure = { stage: 'restart-cleanup', actionId: null, error, cleanup };
      }
    }
  }
  result.restart = restart;
  if (restartFailure) {
    result.status = 'failed';
    result.failure = restartFailure;
  }
  return result;
}

function createProtectionLifecycle(runContext) {
  let verificationPromise;
  return Object.freeze({
    verify() {
      verificationPromise ??= Promise.resolve().then(() => {
        if (!runContext || typeof runContext.verifyProtected !== 'function') {
          throw new TypeError('runContext.verifyProtected is required');
        }
        return runContext.verifyProtected();
      });
      return verificationPromise;
    }
  });
}

async function applyProtection(result, protectionLifecycle) {
  try {
    const verification = await protectionLifecycle.verify();
    if (!verification || verification.ok !== true) {
      const changed = Array.isArray(verification?.changed) ? verification.changed : [];
      const violation = Object.freeze({
        code: 'PROTECTED_PATH_CHANGED',
        severity: 'P0',
        message: `protected paths changed: ${changed.map(item => item?.path || String(item)).join(', ') || '<unknown>'}`,
        entityIds: Object.freeze(changed.map(item => String(item?.path || item)).filter(Boolean))
      });
      const protection = Object.freeze({ status: 'failed', verification, violation });
      result.protection = protection;
      if (result.status === 'failed') result.failure.protection = protection;
      else {
        result.status = 'failed';
        result.failure = { stage: 'protected-verification', actionId: null, violation };
      }
      return result;
    }
    result.protection = Object.freeze({ status: 'passed', verification });
  } catch (error) {
    const protection = Object.freeze({ status: 'failed', stage: 'protected-verification', error });
    result.protection = protection;
    if (result.status === 'failed') result.failure.protection = protection;
    else {
      result.status = 'failed';
      result.failure = { stage: 'protected-verification', actionId: null, error };
    }
  }
  return result;
}

async function closeDriverBounded(driver, { timeoutMs, scheduleTimeout, clearScheduledTimeout }) {
  if (!driver) return Object.freeze({ status: 'not_started' });
  if (typeof driver.close !== 'function') {
    return Object.freeze({ status: 'failed', error: new TypeError('driver must provide close()') });
  }

  let timer;
  const closePromise = Promise.resolve().then(() => driver.close());
  void closePromise.catch(() => undefined);
  return new Promise(resolve => {
    let completed = false;
    const finish = value => {
      if (completed) return;
      completed = true;
      clearScheduledTimeout(timer);
      resolve(Object.freeze(value));
    };
    closePromise.then(
      () => finish({ status: 'closed' }),
      error => finish({ status: 'failed', error })
    );
    timer = scheduleTimeout(() => finish({ status: 'timed_out', timeoutMs }), timeoutMs);
  });
}

class DriverCoordinator {
  constructor() {
    this.records = [];
    this.byDriver = new WeakMap();
  }

  register(driver, name = undefined, assignedProfileRoot = undefined) {
    if (!driver || (typeof driver !== 'object' && typeof driver !== 'function')) return driver;
    const existing = this.byDriver.get(driver);
    if (existing) {
      existing.profileRoot ??= assignedProfileRoot;
      return existing.proxy;
    }
    const exposedProfileRoot = typeof driver.profileRoot === 'string' && driver.profileRoot.trim()
      ? driver.profileRoot
      : null;
    const record = {
      name: String(name || driver.name || `driver-${this.records.length + 1}`),
      raw: driver,
      proxy: null,
      closePromise: null,
      profileRoot: assignedProfileRoot ?? exposedProfileRoot
    };
    const proxy = new Proxy(Object.create(null), {
      get(_target, property) {
        const value = Reflect.get(driver, property, driver);
        if (typeof value !== 'function') return value;
        if (property === 'close') {
          return (...args) => {
            if (!record.closePromise) {
              record.closePromise = Promise.resolve().then(() => Reflect.apply(value, driver, args));
              void record.closePromise.catch(() => undefined);
            }
            return record.closePromise;
          };
        }
        return (...args) => Reflect.apply(value, driver, args);
      }
    });
    record.proxy = proxy;
    this.records.push(record);
    this.byDriver.set(driver, record);
    this.byDriver.set(proxy, record);
    return proxy;
  }

  trackExecution(execution) {
    this.register(execution?.driver);
    this.register(execution?.secondaryDriver);
    for (const driver of Array.isArray(execution?.drivers) ? execution.drivers : []) this.register(driver);
  }

  trackRuntime(runtime) {
    this.register(runtime?.secondDriver, 'secondary');
    if (runtime?.staleDrafts instanceof Map) {
      for (const draft of runtime.staleDrafts.values()) {
        this.register(draft?.driver, 'secondary');
        this.register(draft?.activeDriver, 'secondary');
      }
    }
  }

  profileRoots() {
    return this.records.map(item => item.profileRoot).filter(Boolean);
  }

  async closeAll(options) {
    if (this.records.length === 0) {
      return Object.freeze({ status: 'not_started', drivers: Object.freeze([]) });
    }
    const drivers = [];
    for (const record of [...this.records].reverse()) {
      const cleanup = await closeDriverBounded(record.proxy, options);
      drivers.push(Object.freeze({ name: record.name, ...cleanup }));
    }
    const timedOut = drivers.find(item => item.status === 'timed_out');
    const failed = drivers.find(item => item.status === 'failed');
    return Object.freeze({
      status: timedOut ? 'timed_out' : failed ? 'failed' : 'closed',
      drivers: Object.freeze(drivers),
      ...(timedOut ? { timeoutMs: timedOut.timeoutMs } : {}),
      ...(failed?.error ? { error: failed.error } : {})
    });
  }
}

function applyCleanup(result, cleanup) {
  result.cleanup = cleanup;
  if (!cleanup || ['closed', 'not_started'].includes(cleanup.status)) return result;
  if (result.status === 'failed') {
    result.failure.cleanup = cleanup;
    return result;
  }
  const error = cleanup.error ?? Object.assign(
    new Error(`driver close timed out after ${cleanup.timeoutMs}ms`),
    { code: 'DRIVER_CLOSE_TIMEOUT' }
  );
  return {
    ...result,
    status: 'failed',
    failure: { stage: 'cleanup', actionId: null, error, cleanup }
  };
}

function resolvedDependencies(overrides = {}) {
  return {
    readSnapshot: readWorkflowSnapshot,
    executeAction: executeWorkflowAction,
    checkInvariants: checkWorkflowInvariants,
    normalizeResult: normalizeActionResult,
    isWriteAction: action => Boolean(ACTION_LIBRARY[action?.type]?.write),
    closeTimeoutMs: DEFAULT_CLOSE_TIMEOUT_MS,
    scheduleTimeout: (callback, timeoutMs) => setTimeout(callback, timeoutMs),
    clearScheduledTimeout: timer => clearTimeout(timer),
    profileExists,
    ...overrides
  };
}

async function runWorkflowLifecycle(options, protectionLifecycle) {
  const {
    workflow,
    runContext,
    driverFactory,
    clock = () => new Date(),
    dependencies,
    actionSource
  } = options ?? {};
  let deps = resolvedDependencies();
  let startedAt = null;
  let clockStarted = false;
  const steps = [];
  const runtime = {};
  const coordinator = new DriverCoordinator();
  const plannedActions = [];
  let driver;
  let result;
  let currentAction = null;
  let lastSuccessfulActionId = null;
  let source;
  let secondarySequence = 0;

  try {
    if (!workflow || !Array.isArray(workflow.actions)) throw new TypeError('workflow actions are required');
    if (typeof driverFactory !== 'function') throw new TypeError('driverFactory is required');
    deps = resolvedDependencies(dependencies);
    if (!Number.isFinite(deps.closeTimeoutMs) || deps.closeTimeoutMs <= 0) {
      throw new TypeError('closeTimeoutMs must be positive');
    }
    startedAt = nowIso(clock);
    clockStarted = true;
    validateRunContext(workflow, runContext);
    source = resolveActionSource(workflow, actionSource);
    const primaryProfileRoot = path.join(runContext.profileRoot, 'primary');
    runContext.assertWritable(primaryProfileRoot);
    driver = coordinator.register(await driverFactory({
      workflow,
      runContext,
      role: 'primary',
      profileRoot: primaryProfileRoot
    }), 'primary', primaryProfileRoot);
    if (!driver || typeof driver.start !== 'function') {
      throw new TypeError('driverFactory must return an unstarted driver with start()');
    }
    if (source.kind === 'dynamic' && typeof driver.uiProjection !== 'function') {
      throw new TypeError('dynamic actionSource primary uiProjection() is required');
    }
    await driver.start();
    let stepIndex = 0;
    let previousStep = null;
    while (true) {
      if (['deterministic', 'replay'].includes(source.kind) && stepIndex >= source.maxSteps) break;
      currentAction = null;
      const stepShellBefore = await deps.readSnapshot({ dataRoot: runContext.dataRoot });
      const planningUi = source.kind === 'dynamic' ? await driver.uiProjection() : null;
      const action = await source.next({
        step: stepIndex,
        snapshot: stepShellBefore,
        ui: planningUi,
        previousStep,
        runtime,
        runContext
      });
      if (action == null) break;
      if (stepIndex >= source.maxSteps) {
        result = failureResult({
          workflow,
          steps,
          startedAt,
          lastSuccessfulActionId,
          action: null,
          violation: actionSourceLimitViolation(source.maxSteps),
          stage: 'action-source'
        });
        break;
      }
      currentAction = action;
      plannedActions.push(structuredClone(action));
      const context = Object.freeze({
        runContext,
        workflow,
        runtime,
        snapshot: stepShellBefore,
        clock,
        ...(typeof runContext.armWriteLock === 'function' ? { armWriteLock: runContext.armWriteLock } : {}),
        createDriver: async params => {
          secondarySequence += 1;
          const profileRoot = path.join(runContext.profileRoot, `secondary-${secondarySequence}`);
          runContext.assertWritable(profileRoot);
          return coordinator.register(
            await driverFactory({
              workflow,
              runContext,
              params,
              secondary: true,
              role: 'secondary',
              profileRoot
            }),
            'secondary',
            profileRoot
          );
        }
      });
      const execution = await deps.executeAction({ driver, action, context });
      coordinator.trackExecution(execution);
      const settlement = execution?.settlement ?? null;
      if (deps.isWriteAction(action) && !settlement) {
        const error = new Error(`[${action.type}] runner: missing settled action evidence`);
        error.code = 'MISSING_ACTION_SETTLEMENT';
        throw error;
      }

      const stepShellAfter = await deps.readSnapshot({ dataRoot: runContext.dataRoot });
      const before = settlement
        ? snapshotAtBoundary(stepShellBefore, settlement.beforeState, action, {
            strictRevision: false,
            source: 'step-start-shell'
          })
        : stepShellBefore;
      const after = settlement
        ? snapshotAtBoundary(stepShellAfter, settlement.state, action, {
            strictRevision: true,
            source: 'fresh-after-shell'
          })
        : stepShellAfter;
      const ui = execution?.uiEvidence ?? settlement?.uiEvidence
        ?? (typeof driver.uiProjection === 'function' ? await driver.uiProjection() : null);
      const violations = await deps.checkInvariants({
        before,
        after,
        action: { ...action, outcome: execution?.outcome },
        ui,
        restart: null
      });
      if (!Array.isArray(violations)) throw new TypeError('checkInvariants must return an array');
      const step = deps.normalizeResult({
        actionId: action.id,
        outcome: execution?.outcome,
        revisionBefore: before.state.revision,
        revisionAfter: after.state.revision,
        settlement,
        stateSummaryBefore: before.summary,
        stateSummaryAfter: after.summary,
        uiEvidence: ui,
        auditEvidence: auditEvidence(before, after, settlement),
        violations
      });
      steps.push(step);
      previousStep = step;

      const blocking = violations.find(item => item?.severity === 'P0' || item?.severity === 'P1');
      if (blocking) {
        result = failureResult({
          workflow,
          steps,
          startedAt,
          lastSuccessfulActionId,
          action,
          violation: blocking
        });
        break;
      }
      lastSuccessfulActionId = action.id;
      stepIndex += 1;
    }

    result ??= {
      workflowId: workflow.id,
      status: 'passed',
      startedAt,
      finishedAt: null,
      steps,
      lastSuccessfulActionId,
      plannedActions
    };
  } catch (error) {
    if (error instanceof SettlementSnapshotDriftError) {
      result = failureResult({
        workflow,
        steps,
        startedAt,
        lastSuccessfulActionId,
        action: currentAction,
        violation: error.violation,
        stage: driver ? undefined : 'setup'
      });
    } else {
      result = failureResult({
        workflow,
        steps,
        startedAt,
        lastSuccessfulActionId,
        action: currentAction,
        error,
        stage: driver ? undefined : 'setup'
      });
    }
  } finally {
    coordinator.trackRuntime(runtime);
    const cleanup = await coordinator.closeAll({
      timeoutMs: deps.closeTimeoutMs,
      scheduleTimeout: deps.scheduleTimeout,
      clearScheduledTimeout: deps.clearScheduledTimeout
    });
    result = applyCleanup(result ?? failureResult({
      workflow,
      steps,
      startedAt,
      lastSuccessfulActionId,
      action: currentAction,
      error: new Error('workflow ended without a result')
    }), cleanup);
    result.plannedActions ??= plannedActions;
    if (result.status === 'passed') {
      result = await runRestartVerification({
        result,
        workflow,
        runContext,
        driverFactory,
        deps,
        usedProfileRoots: coordinator.profileRoots()
      });
    }
    result = await applyProtection(result, protectionLifecycle);
    if (clockStarted) {
      try {
        result.finishedAt = nowIso(clock);
      } catch (error) {
        result.finishedAt = startedAt;
        if (result.status === 'failed') result.failure.finishedAtError = error;
        else {
          result.status = 'failed';
          result.failure = { stage: 'finalize', actionId: null, error };
        }
      }
    } else {
      result.finishedAt = startedAt;
    }
  }

  return result;
}

export async function runWorkflow(options = {}) {
  const protectionLifecycle = createProtectionLifecycle(options?.runContext);
  return runWorkflowLifecycle(options, protectionLifecycle);
}

export async function runWorkflowSet({
  workflows,
  runContextFactory,
  driverFactory,
  clock = () => new Date(),
  dependencies,
  actionSourceFactory
}) {
  if (!Array.isArray(workflows)) throw new TypeError('workflows must be an array');
  if (typeof runContextFactory !== 'function') throw new TypeError('runContextFactory is required');
  if (actionSourceFactory !== undefined && typeof actionSourceFactory !== 'function') {
    throw new TypeError('actionSourceFactory must be a function');
  }
  const startedAt = nowIso(clock);
  const results = [];

  for (let index = 0; index < workflows.length; index += 1) {
    const workflow = workflows[index];
    let runContext;
    try {
      runContext = await runContextFactory({ workflow, index });
    } catch (error) {
      results.push({
        workflowId: workflow?.id ?? null,
        status: 'failed',
        startedAt: nowIso(clock),
        finishedAt: nowIso(clock),
        steps: [],
        lastSuccessfulActionId: null,
        cleanup: Object.freeze({ status: 'not_started', drivers: Object.freeze([]) }),
        failure: { stage: 'setup', actionId: null, error }
      });
      break;
    }
    const protectionLifecycle = createProtectionLifecycle(runContext);
    let actionSource;
    if (actionSourceFactory) {
      try {
        actionSource = await actionSourceFactory({ workflow, index, runContext });
      } catch (error) {
        const timestamp = timestampWithFallback(clock, startedAt);
        const failed = await applyProtection({
          workflowId: workflow?.id ?? null,
          status: 'failed',
          startedAt,
          finishedAt: timestamp.value,
          steps: [],
          plannedActions: [],
          lastSuccessfulActionId: null,
          cleanup: Object.freeze({ status: 'not_started', drivers: Object.freeze([]) }),
          failure: {
            stage: 'setup',
            actionId: null,
            error,
            ...(timestamp.error ? { finishedAtError: timestamp.error } : {})
          }
        }, protectionLifecycle);
        results.push(failed);
        break;
      }
    }
    let workflowResult;
    try {
      workflowResult = await runWorkflowLifecycle({
        workflow,
        runContext,
        driverFactory,
        clock,
        dependencies,
        actionSource
      }, protectionLifecycle);
    } catch (error) {
      workflowResult = await applyProtection({
        workflowId: workflow?.id ?? null,
        status: 'failed',
        startedAt: null,
        finishedAt: null,
        steps: [],
        plannedActions: [],
        lastSuccessfulActionId: null,
        cleanup: Object.freeze({ status: 'not_started', drivers: Object.freeze([]) }),
        failure: { stage: 'setup', actionId: null, error }
      }, protectionLifecycle);
    }
    results.push(workflowResult);
    if (workflowResult.status === 'failed') break;
  }

  const failed = results.find(item => item.status === 'failed');
  const summary = Object.freeze({
    total: workflows.length,
    passed: results.filter(item => item.status === 'passed').length,
    failed: failed ? 1 : 0,
    notRun: workflows.length - results.length
  });
  const timestamp = timestampWithFallback(clock, startedAt);
  const result = {
    status: failed ? 'failed' : 'passed',
    startedAt,
    finishedAt: timestamp.value,
    workflows: results,
    summary,
    ...(failed ? { failure: { workflowId: failed.workflowId, ...failed.failure } } : {})
  };
  if (timestamp.error) {
    if (result.status === 'failed') result.failure.finishedAtError = timestamp.error;
    else {
      result.status = 'failed';
      result.failure = { workflowId: null, stage: 'finalize', actionId: null, error: timestamp.error };
    }
  }
  return result;
}
