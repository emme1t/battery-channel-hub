const { contextBridge, ipcRenderer } = require('electron');

let revision = 0;
let saveTail = Promise.resolve();

async function loadState() {
  await saveTail;
  const state = await ipcRenderer.invoke('state:load');
  revision = state.revision;
  return state;
}

function saveState(state) {
  const snapshot = structuredClone(state);
  const operation = saveTail.then(async () => {
    const result = await ipcRenderer.invoke('state:save', {
      expectedRevision: revision,
      state: snapshot,
      journalEntries: snapshot.formChangeJournal || []
    });
    if (!result.ok) {
      throw Object.assign(new Error(result.message), { code: result.code, details: result.details });
    }
    revision = result.state.revision;
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
    if (result.ok) revision = result.state.revision;
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
    if (result.ok) revision = result.state.revision;
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
    if (result.ok) revision = result.state.revision;
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
    if (result.ok) revision = result.state.revision;
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
