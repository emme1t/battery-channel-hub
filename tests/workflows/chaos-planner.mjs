import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { ACTION_LIBRARY, validateWorkflowActionContract } from './actions.mjs';
import { createSeededRandom } from './prng.mjs';
import { runWorkflow } from './runner.mjs';
import { SQLITE_FILE } from '../../src/main/legacy-sqlite-store.mjs';

const FAMILY_WEIGHTS = Object.freeze({
  legal: 60,
  rejectCancel: 25,
  uiPerturbation: 10,
  restartStaleFailure: 5
});

function deepFreeze(value, seen = new WeakSet()) {
  if (value === null || typeof value !== 'object' || seen.has(value)) return value;
  seen.add(value);
  for (const key of Reflect.ownKeys(value)) deepFreeze(value[key], seen);
  return Object.freeze(value);
}

function immutableClone(value) {
  return deepFreeze(structuredClone(value));
}

function activity(id, fixture, maxActions, quickSeed, actionTypes, extra = {}) {
  return Object.freeze({
    id,
    fixture,
    maxActions,
    quickSeed,
    fullSeeds: Object.freeze([0, 1_000, 2_000, 3_000, 4_000].map(offset => quickSeed + offset)),
    actionTypes: Object.freeze([...actionTypes]),
    familyWeights: FAMILY_WEIGHTS,
    ...extra
  });
}

export const CHAOS_ACTIVITIES = Object.freeze({
  C01: activity('C01', 'production-529', 200, 22_001, ['navigate', 'search', 'filter', 'expand', 'collapse', 'nextPage', 'previousPage']),
  C02: activity('C02', 'baseline', 120, 22_002, ['reserve', 'startImmediately', 'startTodo', 'cancelTodo', 'manageRunning', 'finishRunning', 'delayRunning']),
  C03: activity('C03', 'baseline', 120, 22_003, ['openSecondSession', 'reserve', 'staleSubmit', 'reloadCurrent', 'closeSecondSession'], { groups: 60, actionsPerGroup: 2 }),
  C04: activity('C04', 'import-mixed', 120, 22_004, ['importRequest', 'editExecution', 'createTester', 'renameTester', 'deleteTester', 'createDevice', 'createChannel', 'deleteResource']),
  C05: activity('C05', 'production-999', 300, 22_005, ['search', 'nextPage', 'previousPage', 'selectSample', 'unselectSample', 'selectChannel']),
  C06: activity('C06', 'baseline', 100, 22_006, ['reserve', 'startImmediately', 'startTodo', 'cancelTodo', 'manageRunning', 'finishRunning', 'delayRunning', 'restart', 'lockedWrite'])
});

export function createRecordedActionSource(actions) {
  if (!Array.isArray(actions) || actions.length === 0) {
    throw new TypeError('recorded actions must be a non-empty array');
  }
  const recorded = actions.map((action, index) => {
    if (!action || typeof action !== 'object' || Array.isArray(action)) {
      throw new TypeError(`recorded action ${index} must be an object`);
    }
    try { validateWorkflowActionContract(action); } catch (error) {
      throw new TypeError(`recorded action ${index}: ${error.message}`, { cause: error });
    }
    return immutableClone(action);
  });
  let index = 0;
  return Object.freeze({
    kind: 'replay',
    needsUi: false,
    maxSteps: recorded.length,
    next() {
      return index < recorded.length ? immutableClone(recorded[index++]) : null;
    }
  });
}

function armSqliteWriteLock(sqlitePath) {
  const database = new DatabaseSync(sqlitePath);
  try {
    database.exec('PRAGMA busy_timeout=0; BEGIN IMMEDIATE;');
  } catch (error) {
    database.close();
    throw error;
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    try {
      database.exec('ROLLBACK;');
    } finally {
      database.close();
    }
  };
}

function oneShotArmWriteLock(capability) {
  let used = false;
  return async input => {
    if (used) throw new Error('armWriteLock capability is one-shot and has already been used');
    used = true;
    return capability(input);
  };
}

function fullAction({ activityId, seed, step, type, params, expect = 'success', revisionDelta, evidenceRevisionDelta, maxMs, chaos }) {
  const definition = ACTION_LIBRARY[type];
  if (!definition) throw new TypeError(`unknown chaos action type: ${type}`);
  const selectedRevisionDelta = revisionDelta ?? definition.revisionDelta;
  return immutableClone({
    id: `${activityId}-${seed}-step-${String(step).padStart(3, '0')}`,
    type,
    params,
    expect,
    revisionDelta: Array.isArray(selectedRevisionDelta) ? [...selectedRevisionDelta] : selectedRevisionDelta,
    evidenceRevisionDelta: Array.isArray(evidenceRevisionDelta ?? selectedRevisionDelta)
      ? [...(evidenceRevisionDelta ?? selectedRevisionDelta)]
      : (evidenceRevisionDelta ?? selectedRevisionDelta),
    maxMs: maxMs ?? definition.maxMs,
    ...(chaos ? { chaos } : {})
  });
}

function c01Candidates(details) {
  const previous = details.input?.previousStep;
  const last = details.memory.c01LastAction;
  if (previous && last && previous.actionId === last.id) {
    if (previous.outcome === 'success') {
      if (last.type === 'search' && last.params.label === '搜索设备、通道或量程') details.memory.c01ChannelPage = 1;
      if (last.type === 'nextPage' && last.params.view === 'channels') details.memory.c01ChannelPage = (details.memory.c01ChannelPage || 1) + 1;
      if (last.type === 'previousPage' && last.params.view === 'channels') details.memory.c01ChannelPage = Math.max(1, (details.memory.c01ChannelPage || 1) - 1);
    }
    details.memory.c01LastAction = null;
  }
  const candidates = [
    ['看板', 'dashboard'], ['预约', 'apply'], ['申请', 'requests'], ['日志', 'records'],
    ['设备', 'devices'], ['及时率', 'timeliness'], ['测试人员', 'testers']
  ].map(([label]) => ({
    family: 'uiPerturbation',
    action: fullAction({ ...details, type: 'navigate', params: { label } })
  }));
  const state = stateOf(details.input);
  const request = (state.requests || [])[0];
  const page = details.input?.ui?.projection?.currentPage;
  if (page === 'apply') {
    candidates.push({
      family: 'uiPerturbation',
      action: fullAction({
        ...details,
        type: 'search',
        params: { label: '搜索申请单、项目、样品或人员', value: request?.id || '' }
      })
    });
  }
  if (page === 'devices') {
    candidates.push({
      family: 'uiPerturbation',
      action: fullAction({ ...details, type: 'search', params: { label: '搜索设备、通道或量程', value: '' } })
    });
  }
  if (page === 'records') {
    candidates.push({
      family: 'uiPerturbation',
      action: fullAction({
        ...details,
        type: 'search',
        params: { label: '搜索申请、样品、项目、通道或人员', value: '' }
      })
    });
  }
  if (page === 'records') {
    candidates.push({
      family: 'uiPerturbation',
      action: fullAction({
        ...details,
        type: 'filter',
        params: { selector: '[data-bounded-filter="record-state"]', value: 'running', control: 'select' }
      })
    });
    candidates.push({
      family: 'uiPerturbation',
      action: fullAction({
        ...details,
        type: 'nextPage',
        params: { view: 'records' },
        expect: 'rejected'
      })
    });
  }
  if (page === 'devices') {
    const pageCount = Math.max(1, Math.ceil((state.channels || []).length / 50));
    const current = details.memory.c01ChannelPage || 1;
    if (current < pageCount) candidates.push({ family: 'uiPerturbation', action: fullAction({ ...details, type: 'nextPage', params: { view: 'channels' } }) });
    if (current > 1) candidates.push({ family: 'uiPerturbation', action: fullAction({ ...details, type: 'previousPage', params: { view: 'channels' } }) });
  }
  if (page === 'apply' && request?.id && (state.samples || []).filter(sample => requestNoFor(sample) === request.id).length > 25) {
    candidates.push({
      family: 'uiPerturbation',
      action: fullAction({ ...details, type: 'nextPage', params: { view: 'sample', requestNo: request.id } })
    });
  }
  return candidates;
}

function stateOf(input) {
  return input?.snapshot?.state && typeof input.snapshot.state === 'object' ? input.snapshot.state : {};
}

function deviceHasActiveUsage(state, deviceName) {
  const channels = (state.channels || []).filter(channel => String(channel?.device || '') === String(deviceName));
  const keys = new Set(channels.map(channel => String(channel?.key || '')));
  return channels.some(channel => ['busy', 'booked'].includes(String(channel?.state || '')))
    || (state.records || []).some(record => ['reserved', 'running'].includes(String(record?.status || ''))
      && [record?.channelKey, ...(Array.isArray(record?.keys) ? record.keys : [])]
        .some(key => keys.has(String(key || ''))));
}

function requestNoFor(sample) {
  if (typeof sample?.requestNo === 'string' && sample.requestNo) return sample.requestNo;
  return String(sample?.id || '').replace(/\.\d{3}$/, '');
}

function activeRecord(state, status) {
  return (state.records || []).find(record => {
    if (record?.status !== status) return false;
    const sample = (state.samples || []).find(item => item.id === record.sampleId && item.status === status);
    const channelKey = record.channelKey || record.keys?.[0];
    const channel = (state.channels || []).find(item => item.key === channelKey);
    const pointer = status === 'reserved' ? 'nextRecordId' : 'currentRecordId';
    return Boolean(sample && channel && String(channel[pointer] || '') === String(record.id));
  });
}

function c02Candidates(details) {
  const state = stateOf(details.input);
  const pending = (state.samples || []).find(sample => sample.status === 'pending');
  const free = (state.channels || []).find(channel => !['busy', 'booked'].includes(channel.state));
  const reserved = activeRecord(state, 'reserved');
  const running = activeRecord(state, 'running');
  const candidates = [];
  if (pending && free) {
    const params = { requestNo: requestNoFor(pending), sampleIds: [pending.id], channelKeys: [free.key], note: `chaos ${details.step}` };
    for (const type of ['reserve', 'startImmediately']) {
      candidates.push({ family: 'legal', action: fullAction({ ...details, type, params }) });
    }
  }
  if (reserved) {
    candidates.push({ family: 'legal', action: fullAction({ ...details, type: 'startTodo', params: { sampleId: reserved.sampleId } }) });
    candidates.push({
      family: 'rejectCancel',
      action: fullAction({
        ...details,
        type: 'cancelTodo',
        params: { sampleId: reserved.sampleId, confirm: false },
        expect: 'cancelled',
        revisionDelta: 0,
        evidenceRevisionDelta: 0
      })
    });
  }
  if (running) {
    const channelKey = running.channelKey || running.keys?.[0];
    candidates.push({ family: 'legal', action: fullAction({ ...details, type: 'manageRunning', params: { sampleId: running.sampleId, channelKey, note: `chaos ${details.step}` } }) });
    candidates.push({ family: 'legal', action: fullAction({ ...details, type: 'finishRunning', params: { sampleId: running.sampleId } }) });
    candidates.push({ family: 'legal', action: fullAction({ ...details, type: 'delayRunning', params: { sampleId: running.sampleId, channelKey, endOffsetMinutes: 300, confirm: true } }) });
  }
  return candidates;
}

function c03Candidates(details) {
  const state = stateOf(details.input);
  const runtime = details.input?.context?.runtime ?? details.input?.runtime;
  const group = details.memory.c03Group ?? 0;
  const phase = details.memory.c03Phase ?? 0;
  if (group >= CHAOS_ACTIVITIES.C03.groups) return [];
  const cycle = group % 3;
  const plans = cycle === 0
    ? [
        { type: 'openSecondSession', groupKind: 'open-write', session: 'B', behavior: 'read', stateBefore: 'closed', stateAfter: 'stale-open' },
        { type: 'reserve', groupKind: 'open-write', session: 'A', behavior: 'write', stateBefore: 'stale-open', stateAfter: 'committed' }
      ]
    : cycle === 1
      ? [
          { type: 'staleSubmit', groupKind: 'stale-reload', session: 'B', behavior: 'staleSubmit', stateBefore: 'committed', stateAfter: 'stale-rejected' },
          { type: 'reloadCurrent', groupKind: 'stale-reload', session: 'A', behavior: 'reload', stateBefore: 'stale-rejected', stateAfter: 'reloaded' }
        ]
      : [
          { type: 'reloadCurrent', groupKind: 'reload-close', session: 'A', behavior: 'reload', stateBefore: 'reloaded', stateAfter: 'reloaded' },
          { type: 'closeSecondSession', groupKind: 'reload-close', session: 'B', behavior: 'read', stateBefore: 'reloaded', stateAfter: 'closed' }
        ];
  const plan = plans[phase];
  const sessionState = details.memory.c03SessionState ?? 'closed';
  if (sessionState !== plan.stateBefore) {
    throw new Error(`C03 group ${group} phase ${phase} expected ${plan.stateBefore}, got ${sessionState}`);
  }
  const chaos = { activityId: 'C03', group, phase, ...plan };
  if (plan.type === 'openSecondSession') {
    if (!runtime || runtime.secondDriver) return [];
    const pending = (state.samples || []).find(sample => sample.status === 'pending');
    const free = (state.channels || []).find(channel => !['busy', 'booked'].includes(channel.state));
    if (!pending || !free) return [];
    const params = {
      operation: 'reserve',
      requestNo: requestNoFor(pending),
      sampleIds: [pending.id],
      channelKeys: [free.key],
      note: `chaos C03 group ${group}`
    };
    details.memory.c03Target = structuredClone(params);
    return [{
      family: 'restartStaleFailure',
      action: fullAction({ ...details, type: 'openSecondSession', params: { session: 'B', prepareStale: params }, chaos })
    }];
  }
  const target = details.memory.c03Target;
  if (!target) return [];
  if (plan.type === 'reserve') {
    return [{ family: 'legal', action: fullAction({ ...details, type: 'reserve', params: target, chaos }) }];
  }
  if (plan.type === 'staleSubmit') {
    return [{
      family: 'restartStaleFailure',
      action: fullAction({
        ...details,
        type: 'staleSubmit',
        params: { ...target, session: 'B' },
        expect: 'rejected',
        revisionDelta: 0,
        evidenceRevisionDelta: 0,
        chaos
      })
    }];
  }
  if (plan.type === 'reloadCurrent') {
    return [{ family: 'legal', action: fullAction({ ...details, type: 'reloadCurrent', params: {}, chaos }) }];
  }
  if (!runtime?.secondDriver) return [];
  return [{
    family: 'legal',
    action: fullAction({ ...details, type: 'closeSecondSession', params: { session: 'B' }, chaos })
  }];
}

function c04Candidates(details) {
  const state = stateOf(details.input);
  const context = details.input?.context ?? {};
  const dataRoot = context.runContext?.dataRoot;
  const vertical = context.fixtureManifest?.imports?.vertical;
  const request = (state.requests || [])[0];
  const tester = (state.testers || [])[0];
  const device = (state.deviceProfiles || [])[0];
  const deviceDeleteBlocked = device?.name ? deviceHasActiveUsage(state, device.name) : false;
  const token = `C04-${details.seed}-step-${String(details.step).padStart(3, '0')}`;
  const candidates = [];
  if (typeof dataRoot === 'string' && typeof vertical === 'string') {
    const relative = path.relative(path.resolve(dataRoot), path.resolve(vertical));
    if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) {
      candidates.push({
        family: 'legal',
        action: fullAction({
          ...details,
          type: 'importRequest',
          params: { path: relative, kind: 'file', duplicatePolicy: 'skip', expectedValidCount: 1 }
        })
      });
    }
  }
  if (request?.id) {
    candidates.push({
      family: 'legal',
      action: fullAction({
        ...details,
        type: 'editExecution',
        params: { requestNo: request.id, fields: { '备注': token } }
      })
    });
  }
  candidates.push({
    family: 'legal',
    action: fullAction({
      ...details,
      type: 'createTester',
      params: { name: `测试员 ${token}`, dept: '测试部', phone: '00000000', note: token }
    })
  });
  candidates.push({
    family: 'legal',
    action: fullAction({
      ...details,
      type: 'createDevice',
      params: { name: `设备 ${token}`, manufacturer: 'WF', temperature: '常温', note: token }
    })
  });
  if (device?.name) {
    candidates.push({
      family: 'legal',
      action: fullAction({
        ...details,
        type: 'createChannel',
        params: { device: device.name, name: `通道 ${token}`, temperature: '常温', note: token }
      })
    });
    candidates.push({
      family: deviceDeleteBlocked ? 'rejectCancel' : 'legal',
      action: fullAction({
        ...details,
        type: 'deleteResource',
        params: { kind: 'device', name: device.name, confirm: true },
        ...(deviceDeleteBlocked ? {
          expect: 'rejected',
          revisionDelta: 0,
          evidenceRevisionDelta: 0
        } : {})
      })
    });
  }
  if (tester?.name) {
    candidates.push({
      family: 'legal',
      action: fullAction({ ...details, type: 'renameTester', params: { name: tester.name, nextName: `测试员 ${token}` } })
    });
  }
  candidates.push({
    family: 'rejectCancel',
    action: fullAction({
      ...details,
      type: 'importRequest',
      params: { cancel: true },
      expect: 'cancelled',
      revisionDelta: 0,
      evidenceRevisionDelta: 0
    })
  });
  return candidates;
}

function reconcileC05(details) {
  const previous = details.input?.previousStep;
  const last = details.memory.c05LastAction;
  if (!previous || !last || previous.actionId !== last.id) return;
  if (previous.outcome === 'success') {
    if (last.type === 'selectSample') {
      details.memory.c05PickerSampleId = last.params.sampleId;
      details.memory.c05SamplePage = 1;
    } else if (last.type === 'selectChannel' || last.type === 'unselectSample') {
      details.memory.c05PickerSampleId = null;
    } else if (last.type === 'nextPage') {
      details.memory.c05PickerSampleId = null;
      details.memory.c05SamplePage = (details.memory.c05SamplePage || 1) + 1;
    } else if (last.type === 'previousPage') {
      details.memory.c05SamplePage = Math.max(1, (details.memory.c05SamplePage || 1) - 1);
    }
  }
  details.memory.c05LastAction = null;
}

function c05Candidates(details) {
  reconcileC05(details);
  const state = stateOf(details.input);
  const page = details.input?.ui?.projection?.currentPage;
  if (page !== 'apply') {
    return [{
      family: 'uiPerturbation',
      action: fullAction({ ...details, type: 'navigate', params: { label: '预约' } })
    }];
  }
  const pending = (state.samples || []).find(sample => sample.status === 'pending');
  const channel = (state.channels || []).find(item => !['busy', 'booked'].includes(item.state));
  if (!pending) return [];
  const requestNo = requestNoFor(pending);
  const candidates = [
    {
      family: 'legal',
      action: fullAction({ ...details, type: 'selectSample', params: { sampleId: pending.id, requestNo } })
    },
    {
      family: 'uiPerturbation',
      action: fullAction({
        ...details,
        type: 'search',
        params: { label: '搜索申请单、项目、样品或人员', value: details.step % 2 ? requestNo : '', targetPage: 'apply' }
      })
    },
    {
      family: 'uiPerturbation',
      action: fullAction({ ...details, type: 'nextPage', params: { view: 'sample', requestNo } })
    }
  ];
  if (!details.memory.c05PickerSampleId && (details.memory.c05SamplePage || 1) > 1) {
    candidates.push({
      family: 'uiPerturbation',
      action: fullAction({ ...details, type: 'previousPage', params: { view: 'sample' } })
    });
  }
  if (details.memory.c05PickerSampleId) {
    candidates.push({
      family: 'legal',
      action: fullAction({
        ...details,
        type: 'unselectSample',
        params: { sampleId: details.memory.c05PickerSampleId }
      })
    });
    if (channel) {
      candidates.push({
        family: 'legal',
        action: fullAction({ ...details, type: 'selectChannel', params: { channelKey: channel.key } })
      });
    }
  } else {
    candidates.push({
      family: 'rejectCancel',
      action: fullAction({
        ...details,
        type: 'unselectSample',
        params: { sampleId: pending.id },
        expect: 'rejected',
        revisionDelta: 0,
        evidenceRevisionDelta: 0
      })
    });
  }
  return candidates;
}

function c06Candidates(details) {
  const candidates = c02Candidates(details);
  candidates.push({
    family: 'restartStaleFailure',
    action: fullAction({ ...details, type: 'restart', params: {} })
  });
  const state = stateOf(details.input);
  const pending = (state.samples || []).find(sample => sample.status === 'pending');
  const free = (state.channels || []).find(channel => !['busy', 'booked'].includes(channel.state));
  const armWriteLock = details.input?.context?.runContext?.armWriteLock;
  if (!details.memory.c06LockedSelected && typeof armWriteLock === 'function' && pending && free) {
    candidates.push({
      family: 'restartStaleFailure',
      action: fullAction({
        ...details,
        type: 'lockedWrite',
        params: {
          operation: 'reserve',
          requestNo: requestNoFor(pending),
          sampleIds: [pending.id],
          channelKeys: [free.key],
          note: `chaos locked write ${details.step}`
        },
        expect: 'rejected',
        revisionDelta: 0,
        evidenceRevisionDelta: 0
      })
    });
  }
  return candidates;
}

function candidatesFor(activityId, details) {
  if (activityId === 'C01') return c01Candidates(details);
  if (activityId === 'C02') return c02Candidates(details);
  if (activityId === 'C03') return c03Candidates(details);
  if (activityId === 'C04') return c04Candidates(details);
  if (activityId === 'C05') return c05Candidates(details);
  if (activityId === 'C06') return c06Candidates(details);
  return [];
}

function availabilityContext(input) {
  if (input?.context && typeof input.context === 'object') return input.context;
  return {
    ...(input?.runtime && typeof input.runtime === 'object' ? { runtime: input.runtime } : {}),
    ...(input?.runContext && typeof input.runContext === 'object' ? { runContext: input.runContext } : {})
  };
}

export function createChaosPlanner({ activityId, seed }) {
  const activityConfig = CHAOS_ACTIVITIES[activityId];
  if (!activityConfig) throw new TypeError(`unknown chaos activity: ${String(activityId)}`);
  if (!Number.isSafeInteger(seed) || seed < 0 || seed > 0xffff_ffff) {
    throw new TypeError('seed must be a decimal uint32 integer');
  }
  const random = createSeededRandom(seed);
  let selected = 0;
  let restartFallbackUsed = false;
  const memory = {};

  return Object.freeze({
    async next(input = {}) {
      const step = input.step;
      if (!Number.isInteger(step) || step < 0) throw new TypeError('step must be a non-negative integer');
      if (selected >= activityConfig.maxActions) return null;
      const context = availabilityContext(input);
      const parameterized = candidatesFor(activityId, { activityId, seed, step, input, memory });
      const families = [];
      for (const [family, weight] of Object.entries(FAMILY_WEIGHTS)) {
        const available = [];
        for (const candidate of parameterized.filter(item => item.family === family)) {
          const definition = ACTION_LIBRARY[candidate.action.type];
          if (await definition.available(input.snapshot, input.ui, candidate.action.params, context)) {
            available.push(candidate.action);
          }
        }
        if (available.length > 0) families.push({ weight, value: { family, available } });
      }
      let action;
      if (families.length > 0) {
        const selectedFamily = random.weightedPick(families);
        action = random.pick(selectedFamily.available);
      } else if (!restartFallbackUsed) {
        const fallback = fullAction({ activityId, seed, step, type: 'restart', params: {} });
        restartFallbackUsed = true;
        if (await ACTION_LIBRARY.restart.available(input.snapshot, input.ui, fallback.params, context)) action = fallback;
      }
      if (!action) return null;
      selected += 1;
      if (activityId === 'C03' && action.chaos) {
        memory.c03SessionState = action.chaos.stateAfter;
        if (action.chaos.phase === 0) memory.c03Phase = 1;
        else {
          memory.c03Group = action.chaos.group + 1;
          memory.c03Phase = 0;
        }
        if (action.type === 'closeSecondSession') delete memory.c03Target;
      }
      if (activityId === 'C01') memory.c01LastAction = action;
      if (activityId === 'C05') memory.c05LastAction = action;
      if (activityId === 'C06' && action.type === 'lockedWrite') memory.c06LockedSelected = true;
      return action;
    },
    state() {
      return Object.freeze({
        activityId,
        seed,
        selected,
        ...(activityId === 'C03' ? { group: memory.c03Group ?? 0, phase: memory.c03Phase ?? 0, sessionState: memory.c03SessionState ?? 'closed' } : {}),
        restartFallbackUsed,
        prngState: random.state()
      });
    }
  });
}

export async function runChaosActivity({
  activityId,
  seed,
  runContext,
  driverFactory,
  clock = () => new Date(),
  dependencies
}) {
  const config = CHAOS_ACTIVITIES[activityId];
  if (!config) throw new TypeError(`unknown chaos activity: ${String(activityId)}`);
  if (!runContext || typeof runContext !== 'object') throw new TypeError('runContext is required');
  const planner = createChaosPlanner({ activityId, seed });
  let activityRunContext = runContext;
  if (activityId === 'C06') {
    const baseCapability = typeof runContext.armWriteLock === 'function'
      ? runContext.armWriteLock
      : async () => armSqliteWriteLock(path.join(runContext.dataRoot, SQLITE_FILE));
    activityRunContext = Object.freeze({
      ...runContext,
      armWriteLock: oneShotArmWriteLock(baseCapability)
    });
  }
  const workflow = Object.freeze({
    id: config.id,
    name: config.id,
    risk: 'P0',
    fixture: config.fixture,
    actions: Object.freeze([])
  });
  const actionSource = Object.freeze({
    kind: 'dynamic',
    needsUi: true,
    maxSteps: config.maxActions,
    next({ step, snapshot, ui, previousStep, runtime, runContext: liveRunContext }) {
      return planner.next({
        step,
        snapshot,
        ui,
        previousStep,
        context: {
          runtime,
          runContext: liveRunContext,
          fixtureManifest: liveRunContext.fixtureManifest,
          ...(liveRunContext.availability ? { availability: liveRunContext.availability } : {})
        }
      });
    }
  });
  return runWorkflow({
    workflow,
    runContext: activityRunContext,
    driverFactory,
    clock,
    dependencies,
    actionSource
  });
}
