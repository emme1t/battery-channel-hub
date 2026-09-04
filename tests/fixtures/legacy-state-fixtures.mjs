export function makeLegacyState(overrides = {}) {
  return {
    username: '旧版测试员',
    requests: [{
      id: 'R-001',
      test: '循环寿命',
      project: '旧版项目',
      sample: 'Cell-A',
      qty: 2,
      client: '委托人 A',
      dept: '产品部',
      tester: '测试员 A',
      fee: 120,
      device: '设备 A',
      startDate: '2026-08-20 09:00',
      end: '2026-08-20 12:00',
      note: '执行备注',
      rawFields: { 委托单号: 'R-001', 测试人员: '原始值不得覆盖' },
      sourceFile: 'legacy.xlsx',
      sourcePath: 'C:\\legacy\\legacy.xlsx',
      extraLegacyField: '保留快照'
    }],
    deviceProfiles: [{
      id: 'D-A',
      name: '设备 A',
      manufacturer: '厂家 A',
      type: '常温',
      voltage: 5,
      current: 100,
      status: '启用'
    }],
    channels: [
      { key: '设备 A|1', device: '设备 A', name: '1', state: 'busy', spec: '5V100A' },
      { key: '设备 A|2', device: '设备 A', name: '2', state: 'busy', spec: '5V100A' }
    ],
    records: [{
      id: 'USE-001',
      no: 'R-001',
      keys: ['设备 A|1', '设备 A|2'],
      state: '测试中',
      time: '2026-08-20 09:00',
      end: '2026-08-20 12:00',
      user: '测试员 A',
      note: '旧版双通道记录',
      source: '软件操作'
    }],
    auditLogs: [{
      id: 'OLD-AUD-001',
      time: '2026-08-20 08:50',
      user: '测试员 A',
      action: '开始测试',
      target: '申请单 R-001',
      before: null,
      after: { state: '测试中' },
      note: '',
      level: 'normal'
    }],
    requestSourceRows: [{ 申请单号: 'R-001', 来源: 'legacy.xlsx' }],
    ...structuredClone(overrides)
  };
}

export function makeConflictingLegacyState() {
  const state = makeLegacyState();
  state.requests[0].qty = 0;
  state.channels.push({ key: '设备 A|1', device: '设备 A', name: '重复', state: 'busy' });
  state.records.push({
    id: 'USE-UNKNOWN',
    no: 'R-001',
    keys: ['UNKNOWN|9'],
    state: '测试中',
    time: '2026-08-20 10:00',
    end: '2026-08-20 11:00'
  });
  return state;
}
