import {
  auditPage,
  deviceChannelPage,
  recordPage,
  renderBoardView
} from './legacy-list-selectors.mjs';
import { escapeLegacyHtml } from './legacy-reservation-workspace.mjs';
import { formatLegacyLocalDateTime } from './legacy-storage-workbench.mjs';
import {
  dashboardChannelSummary,
  reservationTodoPage,
  timelyStartInsight
} from './legacy-dashboard-insights.mjs';

function pager(view, page) {
  return `<div class="legacy-pager"><span>第 ${page.page} / ${page.pageCount} 页，共 ${page.total} 条</span><div><button class="btn light" type="button" data-bounded-action="page" data-view="${view}" data-direction="previous" ${page.page <= 1 ? 'disabled' : ''}>上一页</button><button class="btn light" type="button" data-bounded-action="page" data-view="${view}" data-direction="next" ${page.page >= page.pageCount ? 'disabled' : ''}>下一页</button></div></div>`;
}

function statusLabel(value) {
  return {
    free: '空闲', busy: '测试中', booked: '已预约', fault: '停用',
    running: '测试中', reserved: '已预约', completed: '已结束', cancelled: '已取消',
    returned: '已退回', storing: '存储中', exception: '异常',
    enabled: '启用', disabled: '停用'
  }[value] || value || '未知';
}

function activePage(id) {
  return document.getElementById(id)?.classList.contains('active') === true;
}

function localDateKey(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function dashboardDateRange(state) {
  const dates = (state.records || [])
    .filter(record => !['reserved', 'cancelled'].includes(String(record.status || '')))
    .map(record => new Date(record.actualStart ?? record.start ?? record.time ?? ''))
    .filter(date => !Number.isNaN(date.getTime()))
    .sort((left, right) => left - right);
  const to = dates.at(-1) || new Date();
  const from = new Date(to);
  from.setDate(from.getDate() - 29);
  return { from: localDateKey(from), to: localDateKey(to) };
}

function drawTimelyTrend(canvas, points) {
  if (!canvas) return;
  const width = Math.max(520, Math.round(canvas.clientWidth || 720));
  const height = 124;
  const ratio = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.round(width * ratio);
  canvas.height = Math.round(height * ratio);
  canvas.style.height = `${height}px`;
  const context = canvas.getContext('2d');
  context.scale(ratio, ratio);
  context.clearRect(0, 0, width, height);
  const bounds = { left: 42, right: width - 14, top: 14, bottom: height - 28 };
  context.font = '11px "Microsoft YaHei", sans-serif';
  context.fillStyle = '#687b8c';
  context.strokeStyle = '#e3edf1';
  context.lineWidth = 1;
  for (const value of [0, 25, 50, 75, 100]) {
    const y = bounds.bottom - (bounds.bottom - bounds.top) * value / 100;
    context.beginPath();
    context.moveTo(bounds.left, y);
    context.lineTo(bounds.right, y);
    context.stroke();
    context.fillText(`${value}%`, 4, y + 4);
  }
  const visible = points.length > 64
    ? points.filter((_, index) => index % Math.ceil(points.length / 64) === 0 || index === points.length - 1)
    : points;
  const plotted = visible.map((point, index) => ({
    ...point,
    x: bounds.left + (bounds.right - bounds.left) * (visible.length <= 1 ? 0.5 : index / (visible.length - 1)),
    y: point.rate === null ? null : bounds.bottom - (bounds.bottom - bounds.top) * point.rate / 100
  }));
  context.strokeStyle = '#1976b9';
  context.lineWidth = 2.5;
  context.beginPath();
  let drawing = false;
  for (const point of plotted) {
    if (point.y === null) { drawing = false; continue; }
    if (!drawing) context.moveTo(point.x, point.y);
    else context.lineTo(point.x, point.y);
    drawing = true;
  }
  context.stroke();
  context.fillStyle = '#1976b9';
  for (const point of plotted) {
    if (point.y === null) continue;
    context.beginPath();
    context.arc(point.x, point.y, 3, 0, Math.PI * 2);
    context.fill();
  }
  if (!plotted.some(point => point.y !== null)) {
    context.fillStyle = '#687b8c';
    context.textAlign = 'center';
    context.fillText('当前日期范围内暂无可计算的实际开始记录', width / 2, height / 2);
    context.textAlign = 'start';
  }
  const first = visible[0]?.date || '';
  const last = visible.at(-1)?.date || '';
  context.fillStyle = '#687b8c';
  if (first) context.fillText(first, bounds.left, height - 8);
  if (last && last !== first) {
    const measured = context.measureText(last).width;
    context.fillText(last, bounds.right - measured, height - 8);
  }
}

function deviceRows(state) {
  return state.deviceProfiles.map(device => {
    const count = state.channels.filter(channel => channel.device === device.name).length;
    return `<tr><td><b>${escapeLegacyHtml(device.name)}</b></td><td>${escapeLegacyHtml(device.manufacturer || String(device.name).split(/\s+/)[0])}</td><td>${escapeLegacyHtml(device.type || '')}</td><td>${escapeLegacyHtml(device.tempRange || '-')}</td><td>${escapeLegacyHtml(device.voltage || '-')} V</td><td>${escapeLegacyHtml(device.current || '-')} A</td><td>${count}</td><td>${escapeLegacyHtml(statusLabel(device.status || 'enabled'))}</td><td><button class="mini-btn" type="button" data-bounded-action="edit-device" data-device-id="${escapeLegacyHtml(encodeURIComponent(device.id))}">编辑设备</button><button class="mini-btn" type="button" data-bounded-action="add-channel" data-device="${escapeLegacyHtml(encodeURIComponent(device.name))}">新增通道</button><button class="mini-btn danger" type="button" data-bounded-action="delete-device" data-device-id="${escapeLegacyHtml(encodeURIComponent(device.id))}">删除设备</button></td></tr>`;
  }).join('');
}

function channelRows(page) {
  return page.items.map(channel => `<tr data-testid="bounded-channel-row"><td>${escapeLegacyHtml(channel.device)}</td><td><b>${escapeLegacyHtml(channel.name)}</b></td><td>${escapeLegacyHtml(channel.type || '')}</td><td>${escapeLegacyHtml(channel.tempRange || '-')}</td><td>${escapeLegacyHtml(channel.voltage || '-')} V</td><td>${escapeLegacyHtml(channel.current || '-')} A</td><td>${escapeLegacyHtml(statusLabel(channel.state))}</td><td><button class="mini-btn" type="button" data-bounded-action="edit-channel" data-channel-key="${escapeLegacyHtml(encodeURIComponent(channel.key))}">编辑</button><button class="mini-btn danger" type="button" data-bounded-action="delete-channel" data-channel-key="${escapeLegacyHtml(encodeURIComponent(channel.key))}">删除</button></td></tr>`).join('');
}

function recordRows(page) {
  return page.items.map(record => {
    const state = statusLabel(record.status);
    const channelKey = record.channelKey || record.keys?.[0] || '';
    const encodedChannelKey = escapeLegacyHtml(encodeURIComponent(channelKey));
    const encodedSampleId = escapeLegacyHtml(encodeURIComponent(record.sampleId || ''));
    const action = record.status === 'running'
      ? `${channelKey ? `<button class="link-btn" type="button" data-bounded-action="manage-running" data-channel-key="${encodedChannelKey}" data-sample-id="${encodedSampleId}">管理测试</button>` : ''}<button class="link-btn" type="button" data-bounded-action="record-transition" data-transition="end" data-record-index="${record.__legacyIndex}">结束测试</button>`
      : record.status === 'reserved'
        ? `<button class="link-btn" type="button" data-bounded-action="record-transition" data-transition="start" data-record-index="${record.__legacyIndex}">开始测试</button>`
        : `<button class="link-btn danger-link" type="button" data-bounded-action="delete-record" data-record-index="${record.__legacyIndex}">删除</button>`;
    return `<tr data-testid="bounded-record-row"><td><b>${escapeLegacyHtml(record.no || record.requestNo || '')}</b></td><td>${escapeLegacyHtml(record.sampleId || '-')}</td><td>${escapeLegacyHtml(record.project || '')}</td><td>${escapeLegacyHtml(record.test || '-')}</td><td>${escapeLegacyHtml(record.channels || (record.keys || []).join(', ') || '-')}</td><td>${escapeLegacyHtml(state)}</td><td>${escapeLegacyHtml(record.time || record.start || '-')}</td><td>${escapeLegacyHtml(record.end || '-')}</td><td>${escapeLegacyHtml(record.user || record.actor || '-')}</td><td>${escapeLegacyHtml(record.source || '软件操作')}</td><td>${action}</td></tr>`;
  }).join('');
}

function auditValue(value) {
  if (value === null || value === undefined || value === '') return '';
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return escapeLegacyHtml(text.length > 180 ? `${text.slice(0, 180)}…` : text);
}

function auditRows(page) {
  return page.items.map(audit => `<tr data-testid="bounded-audit-row"><td>${escapeLegacyHtml(audit.time || audit.at || '')}</td><td>${String(audit.level || 'normal').toLowerCase() === 'warning' ? 'WARNING' : 'NORMAL'}</td><td>${escapeLegacyHtml(audit.user || audit.actor || '')}</td><td>${escapeLegacyHtml(audit.action || '')}</td><td>${escapeLegacyHtml(audit.target || '')}</td><td>${auditValue(audit.before)}</td><td>${auditValue(audit.after)}</td><td>${escapeLegacyHtml(audit.note || '')}</td></tr>`).join('');
}

export function installLegacyBoundedViews(host = window) {
  const expandedDevices = new Set();
  const pages = { channels: 1, records: 1, audits: 1 };
  const filters = { channels: '', records: '', recordState: '', audits: '' };
  const dashboard = { text: '', state: '', maxCurrent: '', todoPage: 1 };
  const timeliness = { from: '', to: '', lastInsight: null };
  const state = () => host.getLegacyBoundedState?.() || {
    channels: [], deviceProfiles: [], records: [], auditLogs: []
  };

  function ensureTimelinessShell() {
    const dashboardNav = document.querySelector('.nav[data-page="dashboard"]');
    if (dashboardNav && !document.querySelector('.nav[data-page="timeliness"]')) {
      const nav = document.createElement('button');
      nav.className = 'nav';
      nav.type = 'button';
      nav.dataset.page = 'timeliness';
      nav.innerHTML = '<b>◴</b>测试及时率';
      nav.addEventListener('click', () => host.go?.('timeliness'));
      dashboardNav.insertAdjacentElement('afterend', nav);
    }
    const dashboardPage = document.getElementById('dashboard');
    if (dashboardPage && !document.getElementById('timeliness')) {
      const page = document.createElement('section');
      page.id = 'timeliness';
      page.className = 'page';
      page.innerHTML = `
        <div class="title-row"><div><h1>测试及时率</h1><div class="sub">按单个子样品核对实际开始时间与申请计划开始时间</div></div></div>
        <section id="timelinessTrendPanel" class="panel">
          <div class="panel-h"><div>及时率趋势 <span class="sub">日期型计划时间按当日结束计算，缺少计划时间不进入分母</span></div><button class="btn light" type="button" data-timeliness-action="export-png">导出 PNG</button></div>
          <div class="timeliness-analysis">
            <div class="timeliness-range"><label class="field"><span>开始日期</span><input type="date" data-timeliness-filter="from"></label><label class="field"><span>结束日期</span><input type="date" data-timeliness-filter="to"></label></div>
            <div class="timeliness-summary"><div class="timeliness-metric timeliness-rate"><b id="timelyRateNum">--</b><span>测试及时率</span></div><div class="timeliness-metric"><b id="timelyKnown">0</b><span>可计算样品</span></div><div class="timeliness-metric"><b id="timelyCount">0</b><span>及时开始</span></div><div class="timeliness-metric"><b id="lateCount">0</b><span>延迟开始</span></div><div class="timeliness-metric"><b id="missingPlanCount">0</b><span>缺少计划时间</span></div></div>
            <canvas id="timelyTrendCanvas" role="img" aria-label="测试及时率趋势图"></canvas>
          </div>
        </section>`;
      dashboardPage.insertAdjacentElement('afterend', page);
    }
  }

  function ensureDashboardShell() {
    ensureTimelinessShell();
    const page = document.getElementById('dashboard');
    const board = document.getElementById('board');
    const boardPanel = board?.closest('.panel');
    if (!page || !boardPanel) return;
    if (!document.getElementById('legacyDashboardStyles')) {
      const style = document.createElement('style');
      style.id = 'legacyDashboardStyles';
      style.textContent = `
        .timeliness-analysis{padding:14px 16px 16px}.timeliness-range{display:flex;gap:9px;align-items:end;flex-wrap:wrap;margin-bottom:14px}.timeliness-range .field{margin:0;min-width:170px}.timeliness-summary{display:grid;grid-template-columns:1.25fr repeat(4,minmax(0,1fr));border:1px solid var(--line);border-radius:10px;overflow:hidden;margin-bottom:14px}.timeliness-metric{min-width:0;padding:13px 15px;background:#fff}.timeliness-metric+.timeliness-metric{border-left:1px solid var(--line)}.timeliness-metric b{display:block;font-size:21px;line-height:1.2}.timeliness-metric span{display:block;margin-top:4px;font-size:11px;color:var(--muted)}.timeliness-rate{background:#edf8fa}.timeliness-rate b{font-size:27px;color:#17687b}#timelyTrendCanvas{display:block;width:100%;border:1px solid #edf2f5;border-radius:8px;background:#fff}.dashboard-main-grid{display:grid;grid-template-columns:minmax(240px,280px) minmax(0,1fr);gap:14px;align-items:start}.dashboard-main-grid>.panel{margin:0}.dashboard-todo-list{display:grid}.dashboard-todo{padding:11px 14px;border-bottom:1px solid #edf2f5}.dashboard-todo strong,.dashboard-todo span,.dashboard-todo small{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.dashboard-todo span{margin-top:3px;font-size:12px}.dashboard-todo small{margin-top:4px;color:var(--muted)}.dashboard-todo .link-btn{padding-top:6px}.dashboard-board-filter{display:grid;grid-template-columns:minmax(180px,1fr) 130px 150px auto;gap:9px;align-items:end;padding:12px 16px;border-bottom:1px solid var(--line);background:#f8fbfc}.dashboard-board-filter .field{margin:0}.dashboard-filter-count{font-size:11px;color:var(--muted);padding-bottom:11px;white-space:nowrap}.reserved-focus td{background:#e6f4fb!important;box-shadow:inset 0 1px #8cc6df,inset 0 -1px #8cc6df}.channel-sample{display:block;margin:4px 0;color:#0c6f85;font-weight:700;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.card-main{display:flex;gap:8px;flex-wrap:wrap}
        @media(max-width:1180px){.dashboard-main-grid{grid-template-columns:240px minmax(0,1fr)}.timeliness-summary{grid-template-columns:repeat(3,minmax(0,1fr))}.timeliness-metric:nth-child(4){border-left:0;border-top:1px solid var(--line)}.timeliness-metric:nth-child(n+4){border-top:1px solid var(--line)}}
        @media(max-width:900px){.dashboard-main-grid{grid-template-columns:1fr}.dashboard-board-filter{grid-template-columns:1fr 1fr}.timeliness-summary{grid-template-columns:1fr 1fr}.timeliness-metric:nth-child(odd){border-left:0}.timeliness-metric:nth-child(n+3){border-top:1px solid var(--line)}}
      `;
      document.head.appendChild(style);
    }
    if (!document.getElementById('dashboardMainGrid')) {
      const grid = document.createElement('div');
      grid.id = 'dashboardMainGrid';
      grid.className = 'dashboard-main-grid';
      boardPanel.before(grid);
      grid.insertAdjacentHTML('beforeend', '<section class="panel"><div class="panel-h">预约待办 <span id="reservationTodoSummary" class="sub"></span></div><div id="reservationTodoList" class="dashboard-todo-list"></div><div id="reservationTodoPager"></div></section>');
      grid.appendChild(boardPanel);
    }
    if (!document.getElementById('dashboardBoardFilter')) {
      boardPanel.querySelector('.panel-h')?.insertAdjacentHTML('afterend', `<div id="dashboardBoardFilter" class="dashboard-board-filter"><label class="field"><span>设备或通道</span><input type="search" data-dashboard-filter="text" placeholder="设备、通道、量程"></label><label class="field"><span>状态</span><select data-dashboard-filter="state"><option value="">全部</option><option value="free">空闲</option><option value="busy">测试中</option><option value="booked">已预约</option><option value="fault">维护/异常</option></select></label><label class="field"><span>最大电流不超过 (A)</span><input type="number" min="0" step="0.1" data-dashboard-filter="max-current"></label><span id="dashboardFilterCount" class="dashboard-filter-count"></span></div>`);
    }
  }

  function renderTimeliness(current) {
    ensureTimelinessShell();
    if (!activePage('timeliness')) return;
    if (!timeliness.from || !timeliness.to) Object.assign(timeliness, dashboardDateRange(current));
    const insight = timelyStartInsight(current, { from: timeliness.from, to: timeliness.to });
    timeliness.lastInsight = insight;
    const rateText = insight.rate === null ? '--' : `${insight.rate}%`;
    const values = {
      timelyRateNum: rateText,
      timelyKnown: insight.total,
      timelyCount: insight.timely,
      lateCount: insight.late,
      missingPlanCount: insight.missingPlan
    };
    for (const [id, value] of Object.entries(values)) {
      const element = document.getElementById(id);
      if (element) element.textContent = String(value);
    }
    const fromInput = document.querySelector('[data-timeliness-filter="from"]');
    const toInput = document.querySelector('[data-timeliness-filter="to"]');
    if (fromInput && fromInput !== document.activeElement) fromInput.value = timeliness.from;
    if (toInput && toInput !== document.activeElement) toInput.value = timeliness.to;
    drawTimelyTrend(document.getElementById('timelyTrendCanvas'), insight.points);
  }

  function renderDashboardTodo(current) {
    const todo = reservationTodoPage(current, { page: dashboard.todoPage, pageSize: 10 });
    dashboard.todoPage = todo.page;
    const summary = document.getElementById('reservationTodoSummary');
    if (summary) summary.textContent = `${todo.total} 项`;
    const list = document.getElementById('reservationTodoList');
    if (list) list.innerHTML = todo.items.map(record => `<article class="dashboard-todo"><strong>${escapeLegacyHtml(record.no || record.requestNo || '未关联申请')}</strong><span>${escapeLegacyHtml(record.project || record.test || '未填写项目')}</span><small>${escapeLegacyHtml(formatLegacyLocalDateTime(record.start || record.time, '未填写预约时间'))}</small><button class="link-btn" type="button" data-dashboard-action="todo-detail" data-record-index="${record.__legacyIndex}">查看详情 →</button></article>`).join('') || '<div class="empty">暂无已预约待办</div>';
    const todoPager = document.getElementById('reservationTodoPager');
    if (todoPager) todoPager.innerHTML = `<div class="legacy-pager"><span>第 ${todo.page} / ${todo.pageCount} 页</span><div><button class="btn light" type="button" data-dashboard-action="todo-previous" ${todo.page <= 1 ? 'disabled' : ''}>上一页</button><button class="btn light" type="button" data-dashboard-action="todo-next" ${todo.page >= todo.pageCount ? 'disabled' : ''}>下一页</button></div></div>`;
  }

  function activeRecordForChannel(current, channel) {
    const records = Array.isArray(current?.records) ? current.records : [];
    const active = record => ['running', 'reserved'].includes(String(record?.status || '').trim());
    const currentRecord = channel?.currentRecordId
      ? records.find(record => String(record?.id) === String(channel.currentRecordId))
      : null;
    if (currentRecord && active(currentRecord)) return currentRecord;
    return records.find(record => {
      if (!active(record)) return false;
      const keys = new Set(Array.isArray(record?.keys) ? record.keys.map(String) : []);
      if (record?.channelKey) keys.add(String(record.channelKey));
      return keys.has(String(channel?.key ?? ''));
    }) || null;
  }

  function localDateTimeValue(value) {
    const text = String(value || '').trim();
    if (!text) return '';
    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(text)) return text;
    const date = new Date(text);
    if (Number.isNaN(date.getTime())) return text.slice(0, 16);
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}T${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
  }

  function configureChannelEditor(encodedKey, encodedSampleId = '') {
    const current = state();
    const channelKey = decodeURIComponent(encodedKey || '');
    const channel = current.channels.find(item => item.key === channelKey);
    const record = activeRecordForChannel(current, channel);
    const sampleId = decodeURIComponent(encodedSampleId || '') || record?.sampleId || '';
    const isActive = channel && ['busy', 'booked'].includes(channel.state);
    for (const id of ['cDevice', 'cName', 'cType', 'cTemp', 'cVoltage', 'cCurrent', 'cStatus', 'cNote']) {
      const field = document.getElementById(id);
      if (field) field.disabled = Boolean(isActive);
    }
    const end = document.getElementById('cEnd');
    const condition = document.getElementById('cCondition');
    if (end) {
      end.disabled = false;
      end.value = localDateTimeValue(channel?.end || '');
    }
    if (condition) condition.disabled = false;
    const editor = document.getElementById('channelEditor');
    const title = document.getElementById('channelEditorTitle');
    const subtitle = editor?.querySelector('.panel-h .sub');
    const saveButton = editor?.querySelector('.actions button[onclick="saveChannel()"]');
    if (isActive) {
      if (title) title.textContent = `${channel.state === 'busy' ? '管理进行中测试' : '管理已预约测试'}${sampleId ? ` · ${sampleId}` : ''}`;
      if (subtitle) subtitle.textContent = '仅允许修改预计结束时间和特殊状况';
      if (saveButton) saveButton.textContent = '保存测试管理';
    } else {
      if (subtitle) subtitle.textContent = '通道参数';
      if (saveButton) saveButton.textContent = '保存通道';
    }
  }

  const previousOpenChannelEditor = host.openChannelEditor;
  if (typeof previousOpenChannelEditor === 'function') {
    host.openChannelEditor = function(encodedKey, encodedSampleId = '') {
      previousOpenChannelEditor(encodedKey);
      configureChannelEditor(encodedKey, encodedSampleId);
    };
  }

  function openRunningManagement(encodedKey, encodedSampleId = '') {
    host.go?.('devices');
    host.renderDevices?.();
    host.openChannelEditor?.(encodedKey, encodedSampleId);
  }

  host.renderBoard = function() {
    const current = state();
    ensureDashboardShell();
    renderDashboardTodo(current);
    const summary = dashboardChannelSummary(current, dashboard);
    const filteredState = {
      ...current,
      channels: summary.channels,
      deviceProfiles: current.deviceProfiles.filter(profile => summary.deviceNames.includes(profile.name))
    };
    const board = document.getElementById('board');
    if (board) board.innerHTML = renderBoardView(filteredState, { expandedDevices: [...expandedDevices] }) || '<div class="empty">没有符合筛选条件的设备或通道</div>';
    const filterCount = document.getElementById('dashboardFilterCount');
    if (filterCount) filterCount.textContent = `显示 ${summary.channels.length} / ${current.channels.length} 通道`;
    const count = status => current.channels.filter(channel => channel.state === status).length;
    if (document.getElementById('totalNum')) document.getElementById('totalNum').textContent = current.channels.length;
    if (document.getElementById('freeNum')) document.getElementById('freeNum').textContent = count('free');
    if (document.getElementById('busyNum')) document.getElementById('busyNum').textContent = count('busy');
    if (document.getElementById('bookedNum')) document.getElementById('bookedNum').textContent = count('booked');
    if (document.getElementById('faultNum')) document.getElementById('faultNum').textContent = count('fault');
  };

  host.renderTimeliness = function() {
    renderTimeliness(state());
  };

  async function exportTimelinessPng() {
    const canvas = document.getElementById('timelyTrendCanvas');
    if (!canvas || typeof host.batteryDesktop?.exportDashboardPng !== 'function') {
      host.toast?.('当前运行入口不支持导出 PNG');
      return;
    }
    const result = await host.batteryDesktop.exportDashboardPng({
      dataUrl: canvas.toDataURL('image/png'),
      defaultFileName: `测试及时率_${timeliness.from}_至_${timeliness.to}.png`
    });
    if (result?.ok) host.toast?.(`及时率图片已导出：${result.filePath}`);
  }

  host.renderDevices = function() {
    if (!activePage('devices')) return;
    const current = state();
    const deviceTable = document.getElementById('deviceTable');
    const channelTable = document.getElementById('channelTable');
    if (deviceTable) deviceTable.innerHTML = `<table class="table management-table"><thead><tr><th>设备名称</th><th>设备厂家</th><th>类别</th><th>温度范围</th><th>最大电压</th><th>最大电流</th><th>通道数</th><th>状态</th><th>操作</th></tr></thead><tbody>${deviceRows(current)}</tbody></table>`;
    const page = deviceChannelPage(current, { page: pages.channels, text: filters.channels });
    pages.channels = page.page;
    if (channelTable) channelTable.innerHTML = `<div class="bounded-toolbar"><label class="field"><span>搜索设备、通道或量程</span><input type="search" data-bounded-filter="channels" value="${escapeLegacyHtml(filters.channels)}"></label></div><table class="table management-table"><thead><tr><th>设备</th><th>通道号</th><th>类型</th><th>温度范围</th><th>最大电压</th><th>最大电流</th><th>状态</th><th>操作</th></tr></thead><tbody>${channelRows(page) || '<tr><td colspan="8" class="empty">没有匹配通道</td></tr>'}</tbody></table>${pager('channels', page)}`;
  };

  host.renderRecords = function() {
    const table = document.getElementById('recordTable');
    if (!table || !activePage('records')) {
      if (table) table.replaceChildren();
      return;
    }
    const page = recordPage(state(), {
      page: pages.records,
      text: filters.records,
      state: filters.recordState
    });
    pages.records = page.page;
    table.innerHTML = `<div class="bounded-toolbar"><label class="field"><span>搜索申请、样品、项目、通道或人员</span><input type="search" data-bounded-filter="records" value="${escapeLegacyHtml(filters.records)}"></label><label class="field"><span>状态</span><select data-bounded-filter="record-state"><option value="">全部</option><option value="running" ${filters.recordState === 'running' ? 'selected' : ''}>测试中</option><option value="reserved" ${filters.recordState === 'reserved' ? 'selected' : ''}>已预约</option><option value="completed" ${filters.recordState === 'completed' ? 'selected' : ''}>已结束</option></select></label></div><table class="table"><thead><tr><th>申请单号</th><th>样品编号</th><th>项目名称</th><th>测试项目</th><th>使用通道</th><th>状态</th><th>预约/开始</th><th>预计结束</th><th>操作人</th><th>来源</th><th>操作</th></tr></thead><tbody>${recordRows(page) || '<tr><td colspan="11" class="empty">暂无匹配日志</td></tr>'}</tbody></table>${pager('records', page)}`;
  };

  host.renderAuditTable = function() {
    const table = document.getElementById('auditTable');
    if (!table || !activePage('records')) {
      if (table) table.replaceChildren();
      return;
    }
    const auditFilter = document.getElementById('auditFilter');
    const level = auditFilter?.value || '';
    const current = state();
    const page = auditPage(current, { page: pages.audits, text: filters.audits, level });
    pages.audits = page.page;
    const warning = current.auditLogs.filter(item => String(item.level || 'normal').toLowerCase() === 'warning').length;
    const summary = document.getElementById('auditSummary');
    if (summary) summary.textContent = `共 ${current.auditLogs.length} 条：WARNING ${warning} 条 · NORMAL ${current.auditLogs.length - warning} 条`;
    table.innerHTML = `<div class="bounded-toolbar"><label class="field"><span>搜索动作、对象、操作人或备注</span><input type="search" data-bounded-filter="audits" value="${escapeLegacyHtml(filters.audits)}"></label></div><table class="table"><thead><tr><th>时间</th><th>等级</th><th>操作人</th><th>动作</th><th>对象</th><th>修改前</th><th>修改后</th><th>备注</th></tr></thead><tbody>${auditRows(page) || '<tr><td colspan="8" class="empty">暂无匹配审计</td></tr>'}</tbody></table>${pager('audits', page)}`;
  };

  host.renderAll = function() {
    host.renderBoard();
    host.renderTimeliness();
    host.__legacySampleWorkbenches?.render?.();
    if (activePage('requests')) host.renderRequestTable?.();
    const recordTable = document.getElementById('recordTable');
    const auditTable = document.getElementById('auditTable');
    const deviceTable = document.getElementById('deviceTable');
    const channelTable = document.getElementById('channelTable');
    recordTable?.replaceChildren();
    auditTable?.replaceChildren();
    deviceTable?.replaceChildren();
    channelTable?.replaceChildren();
  };

  async function transition(action, encodedKey) {
    const result = await host.batteryDesktop.executeReservation({
      type: 'transition',
      payload: {
        action,
        channelKey: decodeURIComponent(encodedKey),
        actor: document.getElementById('displayUser')?.textContent || '当前用户',
        auditId: crypto.randomUUID(),
        now: new Date().toISOString(),
        hours: action === 'extend' ? 24 : undefined
      }
    });
    if (!result.ok) {
      host.toast?.(result.message || '通道状态更新失败');
      return;
    }
    host.adoptLegacyReservationState?.(result.state);
    host.toast?.('通道状态已更新');
  }

  function click(event) {
    const target = event.target.closest('[data-bounded-action]');
    if (!target || target.disabled) return;
    const action = target.dataset.boundedAction;
    if (action === 'toggle-device') {
      const device = decodeURIComponent(target.dataset.device);
      expandedDevices.has(device) ? expandedDevices.delete(device) : expandedDevices.add(device);
      host.renderBoard();
    }
    if (action === 'reserve-channel') void host.quick(target.dataset.channelKey);
    if (action === 'manage-running') openRunningManagement(target.dataset.channelKey, target.dataset.sampleId);
    if (action === 'transition-channel') void transition(target.dataset.transition, target.dataset.channelKey);
    if (action === 'record-transition') {
      const record = state().records[Number(target.dataset.recordIndex)];
      const key = record?.channelKey || record?.keys?.[0];
      if (key) void transition(target.dataset.transition, encodeURIComponent(key));
    }
    if (action === 'delete-record') host.deleteRecord?.(Number(target.dataset.recordIndex));
    if (action === 'edit-device') host.openDeviceEditor?.(target.dataset.deviceId);
    if (action === 'add-channel') host.openChannelEditorForDevice?.(target.dataset.device);
    if (action === 'delete-device') host.deleteDevice?.(target.dataset.deviceId);
    if (action === 'edit-channel') host.openChannelEditor?.(target.dataset.channelKey);
    if (action === 'delete-channel') host.deleteChannel?.(target.dataset.channelKey);
    if (action === 'page') {
      const view = target.dataset.view;
      pages[view] = Math.max(1, pages[view] + (target.dataset.direction === 'next' ? 1 : -1));
      if (view === 'channels') host.renderDevices();
      if (view === 'records') host.renderRecords();
      if (view === 'audits') host.renderAuditTable();
    }
  }

  function updateBoundedFilter(filter, value) {
    if (!['channels', 'records', 'audits'].includes(filter)) return false;
    filters[filter] = value;
    pages[filter] = 1;
    return true;
  }

  function renderBoundedFilter(filter, selectionStart, selectionEnd) {
    if (filter === 'channels') host.renderDevices();
    if (filter === 'records') host.renderRecords();
    if (filter === 'audits') host.renderAuditTable();
    const target = document.querySelector(`[data-bounded-filter="${filter}"]`);
    target?.focus({ preventScroll: true });
    if (target && typeof target.setSelectionRange === 'function') {
      const start = Math.min(selectionStart ?? target.value.length, target.value.length);
      const end = Math.min(selectionEnd ?? start, target.value.length);
      target.setSelectionRange(start, end);
    }
  }

  function input(event) {
    const dashboardFilter = event.target.dataset.dashboardFilter;
    if (dashboardFilter === 'text' || dashboardFilter === 'max-current') {
      dashboard[dashboardFilter === 'max-current' ? 'maxCurrent' : dashboardFilter] = event.target.value;
      host.renderBoard();
      return;
    }
    const filter = event.target.dataset.boundedFilter;
    if (!updateBoundedFilter(filter, event.target.value)) return;
    if (event.isComposing) return;
    renderBoundedFilter(filter, event.target.selectionStart, event.target.selectionEnd);
  }

  function compositionEnd(event) {
    const filter = event.target.dataset.boundedFilter;
    if (!updateBoundedFilter(filter, event.target.value)) return;
    renderBoundedFilter(filter, event.target.selectionStart, event.target.selectionEnd);
  }

  function change(event) {
    const timelinessFilter = event.target.dataset.timelinessFilter;
    if (timelinessFilter) {
      const previous = timeliness[timelinessFilter];
      timeliness[timelinessFilter] = event.target.value;
      if (timeliness.from && timeliness.to && timeliness.from > timeliness.to) {
        timeliness[timelinessFilter] = previous;
        event.target.value = previous;
        host.toast?.('开始日期不能晚于结束日期');
        return;
      }
      host.renderTimeliness();
      return;
    }
    const dashboardFilter = event.target.dataset.dashboardFilter;
    if (dashboardFilter) {
      const key = dashboardFilter === 'max-current' ? 'maxCurrent' : dashboardFilter;
      dashboard[key] = event.target.value;
      host.renderBoard();
      return;
    }
    if (event.target.dataset.boundedFilter === 'record-state') {
      filters.recordState = event.target.value;
      pages.records = 1;
      host.renderRecords();
    }
    if (event.target.id === 'auditFilter') {
      pages.audits = 1;
      host.renderAuditTable();
    }
  }

  function dashboardClick(event) {
    const target = event.target.closest('[data-dashboard-action]');
    if (!target || target.disabled) return;
    const action = target.dataset.dashboardAction;
    if (action === 'todo-previous' || action === 'todo-next') {
      dashboard.todoPage = Math.max(1, dashboard.todoPage + (action.endsWith('next') ? 1 : -1));
      renderDashboardTodo(state());
    }
    if (action === 'todo-detail') host.openReservedRecordDetails?.(Number(target.dataset.recordIndex));
  }

  function timelinessClick(event) {
    const target = event.target.closest('[data-timeliness-action]');
    if (!target || target.disabled) return;
    if (target.dataset.timelinessAction === 'export-png') {
      void exportTimelinessPng().catch(error => host.toast?.(error?.message || '及时率图片导出失败'));
    }
  }

  ensureTimelinessShell();
  const previousGo = host.go;
  if (typeof previousGo === 'function') {
    host.go = function(id) {
      previousGo(id);
      if (id === 'dashboard') host.renderBoard();
      if (id === 'timeliness') host.renderTimeliness();
    };
  }
  document.addEventListener('click', click);
  document.addEventListener('click', dashboardClick);
  document.addEventListener('click', timelinessClick);
  document.addEventListener('input', input);
  document.addEventListener('compositionend', compositionEnd);
  document.addEventListener('change', change);
  return { expandedDevices, pages, filters, dashboard, timeliness };
}
