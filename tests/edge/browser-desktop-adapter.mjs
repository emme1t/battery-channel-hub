(function installBatteryDesktopAdapter(host) {
  const token = String(host.__EDGE_TEST_TOKEN__ || new URL(host.location.href).searchParams.get('token') || '');

  async function request(pathname, body) {
    const response = await fetch(pathname, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' })
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
    const result = await response.json().catch(() => ({
      ok: false,
      code: 'TEST_HOST_RESPONSE_INVALID',
      message: `测试宿主返回非 JSON：HTTP ${response.status}`
    }));
    if (!response.ok) {
      throw Object.assign(new Error(result.message || `测试宿主请求失败：HTTP ${response.status}`), {
        code: result.code || 'TEST_HOST_REQUEST_FAILED',
        details: result.details
      });
    }
    return result;
  }

  host.batteryDesktop = Object.freeze({
    isTestEnvironment: true,
    loadState: () => request('/api/state'),
    saveState: state => request('/api/state/save', state),
    executeReservation: command => request('/api/reservation', command),
    executeStorage: command => request('/api/storage', command),
    executeApplication: command => request('/api/application', command),
    importExcel: () => request('/api/excel/import', {}),
    importFolder: () => request('/api/excel/import-folder', {}),
    exportExcel: payload => request('/api/excel/export', payload || {}),
    exportDashboardPng: payload => request('/api/dashboard/export-png', payload || {}),
    backupState: () => request('/api/state/backup', {}),
    restoreState: command => request('/api/state/restore', command || {})
  });
})(globalThis);
