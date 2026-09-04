const PAGE_SIZE = 10;
const ACTIVE_STORAGE_STATUSES = new Set(['storing', 'exception']);

export function formatLegacyLocalDateTime(value, fallback = '-') {
  const text = String(value ?? '').trim();
  if (!text) return fallback;
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
  const date = new Date(text);
  if (Number.isNaN(date.getTime())) return text;
  const pad = number => String(number).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

if (typeof globalThis !== 'undefined' && typeof globalThis.formatLegacyLocalDateTime !== 'function') {
  globalThis.formatLegacyLocalDateTime = formatLegacyLocalDateTime;
}

function normalize(value) {
  return String(value ?? '').trim().toLocaleLowerCase('zh-CN');
}

function searchable(values) {
  return values
    .filter(value => value !== null && value !== undefined)
    .map(value => typeof value === 'object' ? JSON.stringify(value) : String(value))
    .join(' ')
    .toLocaleLowerCase('zh-CN');
}

function matchesOrdinaryFields(values, query) {
  const tokens = normalize(query).split(/\s+/).filter(Boolean);
  const text = searchable(values);
  return tokens.every(token => text.includes(token));
}

function pageSlice(items, requestedPage) {
  const pageCount = Math.max(1, Math.ceil(items.length / PAGE_SIZE));
  const page = Math.min(Number.isInteger(requestedPage) && requestedPage > 0 ? requestedPage : 1, pageCount);
  const start = (page - 1) * PAGE_SIZE;
  return {
    items: items.slice(start, start + PAGE_SIZE).map(item => structuredClone(item)),
    total: items.length,
    page,
    pageSize: PAGE_SIZE,
    pageCount
  };
}

function identifierAwareFilter(items, query, identifiers, ordinaryFields) {
  const needle = normalize(query);
  if (!needle) return items;
  const hasExact = items.some(item => identifiers(item).some(value => normalize(value) === needle));
  return items.filter(item => hasExact
    ? identifiers(item).some(value => normalize(value) === needle)
    : matchesOrdinaryFields(ordinaryFields(item), query));
}

export function runningSamplePage(state, query = {}) {
  const records = Array.isArray(state?.records) ? state.records : [];
  const running = records
    .map((record, index) => ({ ...record, __legacyIndex: index }))
    .filter(record => String(record?.status || '') === 'running');
  const filtered = identifierAwareFilter(
    running,
    query.text,
    record => [record.no, record.requestNo, record.sampleId],
    record => [
      record.id, record.project, record.test, record.channels, record.channelKey,
      record.keys, record.start, record.time, record.end, record.user, record.actor, record.note
    ]
  );
  return pageSlice(filtered, query.page);
}

export function storageSamplePage(state, query = {}) {
  const records = Array.isArray(state?.storageRecords) ? state.storageRecords : [];
  const indexed = records.map((record, index) => ({ ...record, __legacyIndex: index }));
  const filtered = identifierAwareFilter(
    indexed,
    query.text,
    record => [record.requestNo, ...(Array.isArray(record.sampleIds) ? record.sampleIds : [])],
    record => [
      record.id, record.tester, record.status, record.startedAt, record.expectedEndAt,
      record.endedAt, record.note, record.returnReason
    ]
  );
  return pageSlice(filtered, query.page);
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function workbenchField(field) {
  const value = escapeHtml(field.value ?? '');
  const name = escapeHtml(field.name);
  const label = escapeHtml(field.label);
  if (field.type === 'select') {
    const options = (field.options || []).map(option => {
      const selected = String(option.value) === String(field.value) ? ' selected' : '';
      return `<option value="${escapeHtml(option.value)}"${selected}>${escapeHtml(option.label)}</option>`;
    }).join('');
    return `<label class="field"><span>${label}</span><select data-workbench-field="${name}" name="${name}">${options}</select></label>`;
  }
  if (field.type === 'textarea') {
    return `<label class="field full"><span>${label}</span><textarea data-workbench-field="${name}" name="${name}">${value}</textarea></label>`;
  }
  return `<label class="field"><span>${label}</span><input data-workbench-field="${name}" name="${name}" type="${escapeHtml(field.type || 'text')}" value="${value}"></label>`;
}

export function openLegacyWorkbenchForm(document, spec) {
  if (!document?.createElement || !document?.body?.appendChild) throw new TypeError('in-app workbench form requires a DOM document');
  let dialog = document.getElementById('sampleWorkbenchDialog');
  if (!dialog) {
    dialog = document.createElement('dialog');
    dialog.id = 'sampleWorkbenchDialog';
    dialog.className = 'sample-workbench-dialog';
    dialog.style.width = 'min(560px, calc(100vw - 32px))';
    dialog.style.border = '0';
    dialog.style.borderRadius = '14px';
    dialog.style.padding = '0';
    dialog.style.boxShadow = '0 18px 60px rgba(15, 40, 52, .28)';
    document.body.appendChild(dialog);
  }
  if (dialog.open) dialog.close('cancel');
  dialog.dataset.workbenchKind = String(spec.kind || 'form');
  dialog.innerHTML = `<form class="panel" style="margin:0" data-workbench-form>
    <div class="panel-h">${escapeHtml(spec.title || '样品操作')}</div>
    <div class="panel-b"><div class="form-grid">${(spec.fields || []).map(workbenchField).join('')}</div>
      <div class="actions"><button class="btn light" type="button" data-workbench-cancel>取消</button><button class="btn" type="submit" data-workbench-submit>${escapeHtml(spec.submitLabel || '确认')}</button></div>
    </div>
  </form>`;
  const form = dialog.querySelector('[data-workbench-form]');
  const cancel = dialog.querySelector('[data-workbench-cancel]');
  return new Promise(resolve => {
    let settled = false;
    const cleanup = () => {
      form?.removeEventListener('submit', submit);
      cancel?.removeEventListener('click', cancelClick);
      dialog.removeEventListener('cancel', cancelEvent);
    };
    const finish = value => {
      if (settled) return;
      settled = true;
      cleanup();
      if (dialog.open) dialog.close(value ? 'submit' : 'cancel');
      resolve(value);
    };
    const submit = event => {
      event.preventDefault();
      const values = {};
      for (const field of spec.fields || []) {
        values[field.name] = dialog.querySelector(`[data-workbench-field="${globalThis.CSS?.escape?.(field.name) || field.name}"]`)?.value ?? '';
      }
      finish(values);
    };
    const cancelClick = () => finish(null);
    const cancelEvent = event => { event.preventDefault(); finish(null); };
    form?.addEventListener('submit', submit);
    cancel?.addEventListener('click', cancelClick);
    dialog.addEventListener('cancel', cancelEvent);
    dialog.showModal();
    dialog.querySelector('[data-workbench-field]')?.focus?.();
  });
}

function localDateTimeValue(value) {
  const date = new Date(value || '');
  if (Number.isNaN(date.getTime())) return '';
  const pad = number => String(number).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function statusLabel(status) {
  return {
    running: '测试中',
    storing: '存储中',
    exception: '异常',
    completed: '已结束',
    returned: '已退回'
  }[status] || status || '未知';
}

function pager(view, page) {
  return `<div class="legacy-pager"><span>第 ${page.page} / ${page.pageCount} 页，共 ${page.total} 条</span><div><button class="btn light" type="button" data-sample-action="page" data-sample-view="${view}" data-direction="previous" ${page.page <= 1 ? 'disabled' : ''}>上一页</button><button class="btn light" type="button" data-sample-action="page" data-sample-view="${view}" data-direction="next" ${page.page >= page.pageCount ? 'disabled' : ''}>下一页</button></div></div>`;
}

export function renderRunningSampleWorkbench(page) {
  const rows = page.items.map(record => `<tr data-testid="running-sample-row"><td><b data-request-no="${escapeHtml(record.requestNo || record.no)}">${escapeHtml(record.requestNo || record.no)}</b></td><td data-sample-id="${escapeHtml(record.sampleId || '')}">${escapeHtml(record.sampleId || '-')}</td><td>${escapeHtml(record.project || '-')}</td><td>${escapeHtml(record.channelKey || record.keys?.[0] || '-')}</td><td>${escapeHtml(statusLabel(record.status))}</td><td>${escapeHtml(formatLegacyLocalDateTime(record.start || record.time))}</td><td>${escapeHtml(formatLegacyLocalDateTime(record.end))}</td><td><button class="link-btn" type="button" data-sample-action="running-manage" data-record-id="${escapeHtml(record.id)}">管理测试</button><button class="link-btn danger-link" type="button" data-sample-action="running-return" data-record-id="${escapeHtml(record.id)}">退回申请</button></td></tr>`).join('');
  return `<div class="sample-workbench-table"><table class="table"><thead><tr><th>申请单号</th><th>子样品号</th><th>项目</th><th>通道</th><th>状态</th><th>开始时间</th><th>预计结束</th><th>操作</th></tr></thead><tbody>${rows || '<tr><td colspan="8" class="empty">暂无正在测试样品</td></tr>'}</tbody></table>${pager('running', page)}</div>`;
}

export function renderStorageSampleWorkbench(page) {
  const rows = page.items.map(record => {
    const active = ACTIVE_STORAGE_STATUSES.has(String(record.status || ''));
    const actions = active
      ? `<button class="link-btn" type="button" data-sample-action="storage-edit" data-storage-id="${escapeHtml(record.id)}">编辑存储</button><button class="link-btn" type="button" data-sample-action="storage-finish" data-storage-id="${escapeHtml(record.id)}">结束存储</button><button class="link-btn danger-link" type="button" data-sample-action="storage-return" data-storage-id="${escapeHtml(record.id)}">退回申请</button>`
      : `<button class="link-btn" type="button" data-sample-action="storage-detail" data-storage-id="${escapeHtml(record.id)}">查看详情</button>`;
    const sampleIds = (record.sampleIds || []).map(sampleId => `<span data-sample-id="${escapeHtml(sampleId)}">${escapeHtml(sampleId)}</span>`).join('、');
    return `<tr data-testid="storage-sample-row"><td><b data-request-no="${escapeHtml(record.requestNo)}">${escapeHtml(record.requestNo)}</b></td><td>${sampleIds || '-'}</td><td>${escapeHtml(record.tester || '-')}</td><td>${escapeHtml(statusLabel(record.status))}</td><td>${escapeHtml(formatLegacyLocalDateTime(record.startedAt))}</td><td>${escapeHtml(formatLegacyLocalDateTime(record.expectedEndAt))}</td><td>${escapeHtml(formatLegacyLocalDateTime(record.endedAt))}</td><td>${escapeHtml(record.note || '-')}</td><td>${actions}</td></tr>`;
  }).join('');
  return `<div class="sample-workbench-table"><table class="table"><thead><tr><th>申请单号</th><th>子样品号</th><th>测试人员</th><th>状态</th><th>开始时间</th><th>预计结束</th><th>结束时间</th><th>备注</th><th>操作</th></tr></thead><tbody>${rows || '<tr><td colspan="9" class="empty">暂无长期存储样品</td></tr>'}</tbody></table>${pager('storage', page)}</div>`;
}

function commandMetadata(document, prefix) {
  const actor = document.getElementById('displayUser')?.textContent || '当前用户';
  const id = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`;
  return { actor, auditId: `AUDIT-${prefix}-${id}`, now: new Date().toISOString() };
}

function failed(result, fallback) {
  const error = new Error(result?.message || fallback);
  error.code = result?.code || 'SAMPLE_WORKBENCH_COMMAND_FAILED';
  return error;
}

function requiredText(value, field, message) {
  const text = String(value ?? '').trim();
  if (!text) {
    const error = new Error(message);
    error.code = field === 'sampleIds' ? 'STORAGE_SAMPLE_IDS_INVALID' : 'COMMAND_FIELD_REQUIRED';
    error.details = { field };
    throw error;
  }
  return text;
}

export function buildStartStorageCommand(input, options = {}) {
  const requestNo = requiredText(input?.requestNo, 'requestNo', '申请单号不能为空');
  const tester = requiredText(input?.tester, 'tester', '测试人员不能为空');
  if (!Array.isArray(input?.sampleIds) || input.sampleIds.length === 0) {
    const error = new Error('长期存储必须选择至少一个子样品');
    error.code = 'STORAGE_SAMPLE_IDS_INVALID';
    error.details = { field: 'sampleIds' };
    throw error;
  }
  const sampleIds = input.sampleIds.map(value => requiredText(value, 'sampleIds', '子样品编号不能为空'));
  const expectedInput = requiredText(input?.expectedEndAt, 'expectedEndAt', '预计结束时间不能为空');
  const expectedEnd = new Date(expectedInput);
  if (Number.isNaN(expectedEnd.getTime())) {
    const error = new Error('预计结束时间无效');
    error.code = 'COMMAND_TIME_INVALID';
    throw error;
  }
  const nowValue = options.now ?? new Date();
  const now = nowValue instanceof Date ? nowValue : new Date(nowValue);
  if (Number.isNaN(now.getTime())) {
    const error = new Error('操作时间无效');
    error.code = 'COMMAND_TIME_INVALID';
    throw error;
  }
  const idFactory = options.idFactory ?? (() => globalThis.crypto.randomUUID());
  return {
    type: 'startStorage',
    payload: {
      storageId: String(idFactory()),
      requestNo,
      sampleIds,
      tester,
      expectedEndAt: expectedEnd.toISOString(),
      note: String(input?.note ?? '').trim(),
      actor: tester,
      auditId: String(idFactory()),
      now: now.toISOString()
    }
  };
}

export function mountLegacySampleWorkbenches({ document, desktop, getState, adoptState, notify = () => {}, openForm = spec => openLegacyWorkbenchForm(document, spec) }) {
  if (!document || typeof document.getElementById !== 'function') throw new TypeError('sample workbenches require a document');
  if (!desktop || typeof desktop.executeReservation !== 'function' || typeof desktop.executeStorage !== 'function') {
    throw new TypeError('sample workbenches require preload command APIs');
  }
  if (typeof getState !== 'function' || typeof adoptState !== 'function') {
    throw new TypeError('sample workbenches require state adapters');
  }
  const ui = { runningPage: 1, storagePage: 1, runningText: '', storageText: '' };
  let storageMode = false;
  const selectedStorageSamples = new Set();
  let lastStorageRequestNo = '';

  function enhanceStorageMode() {
    const root = document.getElementById('legacyReservationRoot');
    const workspace = document.defaultView?.__legacyReservationWorkspace;
    if (!root || !workspace) return;
    const workspaceUi = workspace.getUiState?.() || {};
    const selectedRequestNo = workspaceUi.detailsOpen ? String(workspaceUi.selectedRequestNo || '') : '';
    if (selectedRequestNo !== lastStorageRequestNo) {
      selectedStorageSamples.clear();
      lastStorageRequestNo = selectedRequestNo;
    }
    const samples = getState().samples || [];
    const fieldset = root.querySelector?.('.legacy-mode-switch');
    if (fieldset && !fieldset.querySelector?.('[data-sample-action="storage-mode-toggle"]')) {
      fieldset.insertAdjacentHTML('beforeend', '<label><input type="radio" name="legacy-mode" data-sample-action="storage-mode-toggle" value="storage"><span>长期存储</span></label>');
    }
    const storageRadio = fieldset?.querySelector?.('[data-sample-action="storage-mode-toggle"]');
    if (storageRadio) storageRadio.checked = storageMode;
    root.classList?.toggle('legacy-storage-mode', storageMode);
    for (const row of root.querySelectorAll?.('.legacy-sample-row') || []) {
      const sampleId = row.querySelector?.('[data-legacy-action="open-channel-picker"]')?.dataset?.sampleId;
      if (!sampleId) continue;
      let selector = row.querySelector?.('[data-sample-action="storage-sample-toggle"]');
      const sample = samples.find(item => String(item?.id || '') === String(sampleId));
      const selectable = sample?.status === 'pending' && String(sample?.requestNo || '') === selectedRequestNo;
      if (!selectable) {
        selectedStorageSamples.delete(sampleId);
        selector?.remove?.();
        continue;
      }
      if (storageMode && !selector) {
        row.insertAdjacentHTML('beforeend', `<button type="button" class="legacy-storage-select${selectedStorageSamples.has(sampleId) ? ' selected' : ''}" data-sample-action="storage-sample-toggle" data-sample-id="${escapeHtml(sampleId)}">${selectedStorageSamples.has(sampleId) ? '已选择长期存储' : '选择长期存储'}</button>`);
        selector = row.querySelector?.('[data-sample-action="storage-sample-toggle"]');
      }
      if (selector) selector.hidden = !storageMode;
    }
    const submit = root.querySelector?.('.legacy-details-actions .btn:not(.light)');
    if (!submit) return;
    if (storageMode) {
      submit.removeAttribute('data-legacy-action');
      submit.dataset.sampleAction = 'storage-start';
      if (submit.textContent !== '开始长期存储') submit.textContent = '开始长期存储';
    } else if (submit.dataset.sampleAction === 'storage-start') {
      delete submit.dataset.sampleAction;
      submit.dataset.legacyAction = 'submit-operation';
      const label = workspace.getUiState?.().mode === 'start' ? '立即开始' : '提交预约';
      if (submit.textContent !== label) submit.textContent = label;
    }
  }

  function render() {
    const state = getState();
    const running = runningSamplePage(state, { page: ui.runningPage, text: ui.runningText });
    const storage = storageSamplePage(state, { page: ui.storagePage, text: ui.storageText });
    ui.runningPage = running.page;
    ui.storagePage = storage.page;
    const runningTable = document.getElementById('runningSamplesTable');
    const storageTable = document.getElementById('storageSamplesTable');
    if (runningTable) runningTable.innerHTML = renderRunningSampleWorkbench(running);
    if (storageTable) storageTable.innerHTML = renderStorageSampleWorkbench(storage);
    const runningSummary = document.getElementById('runningSamplesSummary');
    const storageSummary = document.getElementById('storageSamplesSummary');
    if (runningSummary) runningSummary.textContent = `共 ${running.total} 条`;
    if (storageSummary) storageSummary.textContent = `共 ${storage.total} 条`;
    enhanceStorageMode();
    return { running, storage };
  }

  async function execute(channel, type, payload) {
    const api = channel === 'reservation' ? desktop.executeReservation : desktop.executeStorage;
    const result = await api.call(desktop, { type, payload });
    if (!result?.ok || !result.state) throw failed(result, '样品操作失败，状态未修改');
    adoptState(result.state);
    render();
    return result;
  }

  async function returnToApplication(channel, type, idField, id, prefix) {
    const response = await openForm({
      kind: 'return',
      title: channel === 'reservation' ? '普通测试退回申请' : '长期存储退回申请',
      submitLabel: '确认退回',
      fields: [{ name: 'reason', label: '退回原因（必填）', type: 'textarea', value: '' }]
    });
    if (!response) return;
    const reason = String(response.reason ?? '').trim();
    if (!reason) {
      notify('退回申请必须填写原因');
      return;
    }
    await execute(channel, type, {
      [idField]: id,
      reason,
      ...commandMetadata(document, prefix)
    });
    notify(channel === 'reservation' ? '普通测试已退回申请' : '长期存储已退回申请');
  }

  async function click(event) {
    const target = event.target.closest?.('[data-sample-action]');
    if (!target || target.disabled) return;
    const action = target.dataset.sampleAction;
    try {
      if (action === 'page') {
        const key = target.dataset.sampleView === 'running' ? 'runningPage' : 'storagePage';
        ui[key] = Math.max(1, ui[key] + (target.dataset.direction === 'next' ? 1 : -1));
        render();
      }
      if (action === 'storage-mode-toggle') {
        storageMode = true;
        selectedStorageSamples.clear();
        for (const radio of document.querySelectorAll?.('[data-legacy-action="mode"]') || []) radio.checked = false;
        enhanceStorageMode();
      }
      if (action === 'storage-sample-toggle') {
        const sampleId = target.dataset.sampleId;
        if (selectedStorageSamples.has(sampleId)) selectedStorageSamples.delete(sampleId);
        else selectedStorageSamples.add(sampleId);
        enhanceStorageMode();
        const selected = document.querySelector?.(`[data-sample-action="storage-sample-toggle"][data-sample-id="${globalThis.CSS?.escape?.(sampleId) || sampleId}"]`);
        if (selected) {
          selected.classList.toggle('selected', selectedStorageSamples.has(sampleId));
          selected.textContent = selectedStorageSamples.has(sampleId) ? '已选择长期存储' : '选择长期存储';
        }
      }
      if (action === 'storage-start') {
        const workspace = document.defaultView?.__legacyReservationWorkspace;
        const root = document.getElementById('legacyReservationRoot');
        const requestNo = String(workspace?.getUiState?.().selectedRequestNo || '');
        const allowedSampleIds = new Set((getState().samples || [])
          .filter(sample => String(sample?.requestNo || '') === requestNo && sample?.status === 'pending')
          .map(sample => String(sample.id)));
        const sampleIds = [...selectedStorageSamples].filter(sampleId => allowedSampleIds.has(String(sampleId)));
        selectedStorageSamples.clear();
        for (const sampleId of sampleIds) selectedStorageSamples.add(sampleId);
        const command = buildStartStorageCommand({
          requestNo,
          sampleIds,
          tester: document.getElementById('displayUser')?.textContent || '当前用户',
          expectedEndAt: root?.querySelector?.('[data-legacy-action="end-time"]')?.value,
          note: root?.querySelector?.('[data-legacy-action="note"]')?.value || ''
        });
        const result = await desktop.executeStorage(command);
        if (!result?.ok || !result.state) throw failed(result, '长期存储开始失败，状态未修改');
        storageMode = false;
        selectedStorageSamples.clear();
        adoptState(result.state);
        render();
        notify('长期存储已开始');
      }
      if (action === 'running-return') {
        await returnToApplication('reservation', 'returnRunningToApplication', 'recordId', target.dataset.recordId, 'RUNNING-RETURN');
      }
      if (action === 'storage-return') {
        await returnToApplication('storage', 'returnStorageToApplication', 'storageId', target.dataset.storageId, 'STORAGE-RETURN');
      }
      if (action === 'storage-finish' && document.defaultView?.confirm?.('确认结束这条长期存储记录？') === true) {
        await execute('storage', 'finishStorage', {
          storageId: target.dataset.storageId,
          ...commandMetadata(document, 'STORAGE-FINISH')
        });
        notify('长期存储已结束');
      }
      if (action === 'storage-edit') {
        const record = (getState().storageRecords || []).find(item => String(item.id) === String(target.dataset.storageId));
        if (!record || !ACTIVE_STORAGE_STATUSES.has(record.status)) return;
        const response = await openForm({
          kind: 'storage-edit',
          title: '编辑长期存储',
          submitLabel: '保存存储信息',
          fields: [
            { name: 'status', label: '存储状态', type: 'select', value: record.status, options: [{ value: 'storing', label: '存储中' }, { value: 'exception', label: '异常' }] },
            { name: 'expectedEndAt', label: '预计结束时间', type: 'datetime-local', value: localDateTimeValue(record.expectedEndAt) },
            { name: 'note', label: '存储备注', type: 'textarea', value: record.note || '' }
          ]
        });
        if (!response) return;
        const status = String(response.status ?? '').trim();
        if (!ACTIVE_STORAGE_STATUSES.has(status)) throw failed({ code: 'STORAGE_STATUS_INVALID', message: '存储状态只能是 storing 或 exception' });
        const expectedEndAt = String(response.expectedEndAt ?? '').trim();
        if (!expectedEndAt) return;
        const note = String(response.note ?? '');
        await execute('storage', 'updateStorage', {
          storageId: record.id,
          status,
          expectedEndAt: new Date(expectedEndAt).toISOString(),
          note,
          ...commandMetadata(document, 'STORAGE-UPDATE')
        });
        notify('长期存储信息已更新');
      }
      if (action === 'storage-detail') {
        const record = (getState().storageRecords || []).find(item => String(item.id) === String(target.dataset.storageId));
        document.defaultView?.alert?.(`长期存储 ${record?.id || ''}\n状态：${statusLabel(record?.status)}\n子样品：${(record?.sampleIds || []).join('、')}\n备注：${record?.note || '-'}`);
      }
      if (action === 'running-manage') {
        const record = (getState().records || []).find(item => String(item.id) === String(target.dataset.recordId));
        document.defaultView?.go?.('devices');
        const channelKey = record?.channelKey || record?.keys?.[0];
        if (channelKey) document.defaultView?.openChannelEditor?.(encodeURIComponent(channelKey), encodeURIComponent(record?.sampleId || ''));
      }
    } catch (error) {
      notify(error?.message || '样品操作失败，状态未修改');
    }
  }

  function input(event) {
    if (event.target?.dataset?.sampleFilter === 'running') {
      ui.runningText = event.target.value;
      ui.runningPage = 1;
      render();
    }
    if (event.target?.dataset?.sampleFilter === 'storage') {
      ui.storageText = event.target.value;
      ui.storagePage = 1;
      render();
    }
  }

  function change(event) {
    if (event.target?.dataset?.legacyAction === 'mode') {
      storageMode = false;
      selectedStorageSamples.clear();
      queueMicrotask(enhanceStorageMode);
    }
  }

  document.addEventListener('click', click);
  document.addEventListener('input', input);
  document.addEventListener('change', change);
  const Observer = document.defaultView?.MutationObserver;
  const reservationRoot = document.getElementById('legacyReservationRoot');
  const observer = Observer && reservationRoot
    ? new Observer(() => queueMicrotask(enhanceStorageMode))
    : null;
  observer?.observe(reservationRoot, { childList: true, subtree: true });
  render();
  return {
    render,
    returnReservedToApplication(recordId) {
      return returnToApplication('reservation', 'returnReservedToApplication', 'recordId', recordId, 'RESERVED-RETURN');
    },
    destroy() {
      document.removeEventListener('click', click);
      document.removeEventListener('input', input);
      document.removeEventListener('change', change);
      observer?.disconnect();
    }
  };
}

function autoMount() {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;
  if (window.__legacySampleWorkbenches || !document.getElementById('runningSamplesTable')) return;
  if (!window.batteryDesktop || typeof window.getLegacyBoundedState !== 'function') return;
  window.__legacySampleWorkbenches = mountLegacySampleWorkbenches({
    document,
    desktop: window.batteryDesktop,
    getState: () => window.getLegacyBoundedState(),
    adoptState: state => window.adoptLegacyApplicationState?.(state),
    notify: message => window.toast?.(message)
  });
  const previousGo = window.go;
  window.go = function(id) {
    previousGo(id);
    if (id === 'runningSamples' || id === 'storageSamples') window.__legacySampleWorkbenches.render();
  };
}

if (typeof window !== 'undefined') queueMicrotask(autoMount);
