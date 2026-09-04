export function makeRequest(overrides = {}) {
  return {
    requestNo: 'R-001',
    project: '循环寿命测试',
    testName: '循环寿命',
    sampleModel: 'Cell-A',
    quantity: 1,
    expectedStart: '2026-08-20T09:00:00-07:00',
    rawFields: {},
    execution: {},
    sourceFileName: 'fixture.xlsx',
    sourceFilePath: 'C:\\fixtures\\fixture.xlsx',
    ...structuredClone(overrides)
  };
}

export function makeSample(overrides = {}) {
  return {
    id: 'R-001.001',
    requestNo: 'R-001',
    ordinal: 1,
    status: 'pending',
    channelKey: '',
    start: '',
    end: '',
    hasHistory: false,
    ...structuredClone(overrides)
  };
}

export function makeChannel(overrides = {}) {
  return {
    key: 'device-01|001',
    deviceId: 'device-01',
    deviceName: '高精度充放电设备 01',
    name: '001',
    state: 'free',
    end: '',
    currentRecordId: '',
    spec: '5V / 100A',
    ...structuredClone(overrides)
  };
}

export function makeDevice(overrides = {}) {
  return {
    id: 'device-01',
    name: '高精度充放电设备 01',
    manufacturer: 'Fixture',
    ...structuredClone(overrides)
  };
}

export function makeRecord(overrides = {}) {
  return {
    id: 'record-001',
    requestNo: 'R-001',
    sampleId: 'R-001.001',
    channelKey: 'device-01|001',
    status: 'reserved',
    start: '2026-08-20T09:00:00-07:00',
    end: '2026-08-20T12:00:00-07:00',
    actualEnd: '',
    ...structuredClone(overrides)
  };
}

export function makeState(overrides = {}) {
  const state = {
    schemaVersion: 2,
    dataRevision: 0,
    username: '测试员',
    requests: [],
    samples: [],
    devices: [makeDevice()],
    channels: [],
    records: [],
    audits: [],
    requestSourceRows: [],
    ...structuredClone(overrides)
  };
  if (!Object.hasOwn(overrides, 'devices') && state.channels.length > 0) {
    state.devices = [...new Map(state.channels.map((channel) => [
      channel.deviceId,
      makeDevice({ id: channel.deviceId, name: channel.deviceName || channel.deviceId })
    ])).values()];
  }
  return state;
}
