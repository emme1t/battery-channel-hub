const { contextBridge, ipcRenderer } = require('electron');

let revision = 0;
let saveTail = Promise.resolve();
let commandGeneration = 0;
let acknowledgedState = null;

function acknowledge(state, command = false) {
  revision = state.revision;
  acknowledgedState = structuredClone(state);
  if (command) commandGeneration += 1;
}

function rebaseQueuedSnapshot(snapshot, base) {
  const latest = structuredClone(acknowledgedState);
  for (const key of Object.keys(snapshot)) {
    if (['revision', 'savedAt'].includes(key)) continue;
    if (['auditLogs', 'formChangeJournal'].includes(key)) {
      const known = new Set((base?.[key] || []).map(item => item.id));
      const retained = new Set((latest[key] || []).map(item => item.id));
      latest[key] = [...(snapshot[key] || []).filter(item => !known.has(item.id) && !retained.has(item.id)), ...(latest[key] || [])];
      continue;
    }
    if (JSON.stringify(snapshot[key]) === JSON.stringify(base?.[key])) continue;
    if (JSON.stringify(latest[key]) !== JSON.stringify(base?.[key]) && JSON.stringify(latest[key]) !== JSON.stringify(snapshot[key])) {
      throw Object.assign(new Error('状态已被命令更新，请刷新后重试'), { code: 'REVISION_CONFLICT' });
    }
    latest[key] = snapshot[key];
  }
  return latest;
}

async function loadState() {
  await saveTail;
  const state = await ipcRenderer.invoke('state:load');
  acknowledge(state);
  return state;
}

function saveState(state) {
  const snapshot = structuredClone(state);
  const generation = commandGeneration;
  const base = acknowledgedState;
  const operation = saveTail.then(async () => {
    const pending = generation === commandGeneration ? snapshot : rebaseQueuedSnapshot(snapshot, base);
    const result = await ipcRenderer.invoke('state:save', {
      expectedRevision: revision,
      state: pending,
      journalEntries: pending.formChangeJournal || []
    });
    if (!result.ok) {
      throw Object.assign(new Error(result.message), { code: result.code, details: result.details });
    }
    acknowledge(result.state);
    return result.state;
  });
  saveTail = operation.catch(() => undefined);
  return operation;
}

function executeReservation(command) {
  const snapshot = structuredClone(command);
  const operation = saveTail.then(async () => {
    const result = await ipcRenderer.invoke('reservation:execute', {
      ...snapshot,
      expectedRevision: revision
    });
    if (result.ok) acknowledge(result.state, true);
    return result;
  });
  saveTail = operation.catch(() => undefined);
  return operation;
}

function executeStorage(command) {
  const snapshot = structuredClone(command);
  const operation = saveTail.then(async () => {
    const result = await ipcRenderer.invoke('storage:execute', {
      ...snapshot,
      expectedRevision: revision
    });
    if (result.ok) acknowledge(result.state, true);
    return result;
  });
  saveTail = operation.catch(() => undefined);
  return operation;
}

function executeApplication(command) {
  const snapshot = structuredClone(command);
  const operation = saveTail.then(async () => {
    const result = await ipcRenderer.invoke('application:execute', {
      ...snapshot,
      expectedRevision: revision
    });
    if (result.ok) acknowledge(result.state, true);
    return result;
  });
  saveTail = operation.catch(() => undefined);
  return operation;
}

function invokeExcel(channel, payload) {
  const snapshot = payload === undefined ? undefined : structuredClone(payload);
  return saveTail.then(() => ipcRenderer.invoke(channel, snapshot));
}

function backupState() {
  return saveTail.then(() => ipcRenderer.invoke('state:backup'));
}

function restoreState(command = {}) {
  const snapshot = structuredClone(command);
  const operation = saveTail.then(async () => {
    const result = await ipcRenderer.invoke('state:restore', {
      ...snapshot,
      expectedRevision: revision
    });
    if (result.ok) acknowledge(result.state, true);
    return result;
  });
  saveTail = operation.catch(() => undefined);
  return operation;
}

contextBridge.exposeInMainWorld('batteryDesktop', {
  isTestEnvironment: process.defaultApp === true,
  loadState,
  saveState,
  executeReservation,
  executeStorage,
  executeApplication,
  importExcel: () => invokeExcel('excel:import'),
  importFolder: () => invokeExcel('excel:import-folder'),
  exportExcel: payload => invokeExcel('excel:export', payload),
  exportDashboardPng: payload => invokeExcel('dashboard:export-png', payload),
  backupState,
  restoreState
});
