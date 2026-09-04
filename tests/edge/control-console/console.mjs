const token = String(globalThis.__EDGE_TEST_TOKEN__ || new URL(location.href).searchParams.get('token') || '');
const elements = Object.fromEntries([
  'runId', 'mode', 'progress', 'runStatus', 'updatedAt', 'scenarioRows', 'consoleError', 'stopRun'
].map(id => [id, document.getElementById(id)]));

async function api(pathname, options = {}) {
  const response = await fetch(pathname, {
    ...options,
    headers: {
      authorization: `Bearer ${token}`,
      ...(options.body ? { 'content-type': 'application/json' } : {}),
      ...(options.headers || {})
    }
  });
  const value = await response.json();
  if (!response.ok) throw Object.assign(new Error(value.message || `HTTP ${response.status}`), value);
  return value;
}

function render(snapshot) {
  const scenarios = snapshot.scenarios || [];
  const complete = scenarios.filter(item => ['PASS', 'FAIL', 'BLOCKED'].includes(item.status)).length;
  elements.runId.textContent = snapshot.runId || '—';
  elements.mode.textContent = `${snapshot.mode || '—'}${snapshot.coverage ? ` · ${snapshot.coverage}` : ''}`;
  elements.progress.textContent = `${complete} / ${scenarios.length || 52}`;
  elements.runStatus.textContent = snapshot.status || (snapshot.stopped ? '停止中' : '运行中');
  elements.updatedAt.textContent = `最后刷新：${new Date().toLocaleTimeString('zh-CN')}`;
  elements.stopRun.disabled = ['complete', 'failed', 'stopped'].includes(snapshot.status);
  elements.scenarioRows.innerHTML = scenarios.length === 0
    ? '<tr><td colspan="5" class="empty">等待场景清单</td></tr>'
    : scenarios.map(item => `<tr><td>${escapeHtml(item.id)}</td><td>${escapeHtml(item.title)}</td><td>${escapeHtml(item.surface)}</td><td><span class="status ${escapeHtml(item.status)}">${escapeHtml(item.status)}</span></td><td>${Number(item.durationMs || 0).toLocaleString('zh-CN')} ms</td></tr>`).join('');
}

function escapeHtml(value) {
  return String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
}

async function refresh() {
  try {
    render(await api('/api/run'));
    elements.consoleError.textContent = '';
  } catch (error) {
    elements.consoleError.textContent = `无法读取测试状态：${error.message}`;
  }
}

elements.stopRun.addEventListener('click', async () => {
  elements.stopRun.disabled = true;
  try {
    await api('/api/run/stop', { method: 'POST', body: '{}' });
    await refresh();
  } catch (error) {
    elements.consoleError.textContent = `停止请求失败：${error.message}`;
    elements.stopRun.disabled = false;
  }
});

await refresh();
setInterval(refresh, 1000);
