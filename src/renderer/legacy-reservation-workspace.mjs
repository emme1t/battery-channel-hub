import {
  channelCandidates,
  requestPage,
  samplePage
} from './legacy-list-selectors.mjs';

const SAMPLE_STATUS_LABEL = {
  pending: '待安排',
  reserved: '已预约',
  running: '测试中',
  completed: '已完成',
  cancelled: '已取消'
};

export function escapeLegacyHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

export function createLegacyReservationUiState(overrides = {}) {
  return {
    selectedRequestNo: null,
    detailsOpen: false,
    searchText: '',
    pendingOnly: false,
    requestPage: 1,
    samplePage: 1,
    mode: 'reserve',
    start: '',
    end: '',
    note: '',
    assignments: {},
    channelPickerSampleId: null,
    channelSearch: '',
    channelPage: 1,
    message: '',
    messageTone: 'normal',
    busy: false,
    ...structuredClone(overrides)
  };
}

export function selectLegacyRequest(uiState, requestNo) {
  return {
    ...structuredClone(uiState),
    selectedRequestNo: requestNo,
    detailsOpen: true,
    samplePage: 1,
    assignments: {},
    channelPickerSampleId: null,
    channelSearch: '',
    channelPage: 1,
    message: '',
    messageTone: 'normal'
  };
}

export function closeLegacyReservation(uiState) {
  return {
    ...structuredClone(uiState),
    selectedRequestNo: null,
    detailsOpen: false,
    samplePage: 1,
    assignments: {},
    channelPickerSampleId: null,
    channelSearch: '',
    channelPage: 1,
    message: '',
    messageTone: 'normal',
    busy: false
  };
}

function pager(name, page) {
  return `<div class="legacy-pager" aria-label="${escapeLegacyHtml(name)}分页"><span>第 ${page.page} / ${page.pageCount} 页，共 ${page.total} 条</span><div><button class="btn light" type="button" data-legacy-action="${name}-previous" ${page.page <= 1 ? 'disabled' : ''}>上一页</button><button class="btn light" type="button" data-legacy-action="${name}-next" ${page.page >= page.pageCount ? 'disabled' : ''}>下一页</button></div></div>`;
}

function requestRows(page, uiState) {
  if (!page.items.length) return '<div class="empty">没有匹配申请，请调整搜索条件。</div>';
  return page.items.map(request => `
    <article class="legacy-request-row${request.requestNo === uiState.selectedRequestNo ? ' is-selected' : ''}" data-testid="legacy-request-row">
      <div class="legacy-request-id"><strong>${escapeLegacyHtml(request.requestNo)}</strong><span>${escapeLegacyHtml(request.testName || '测试项目待完善')}</span></div>
      <div class="legacy-request-project"><strong>${escapeLegacyHtml(request.project || '项目名称待完善')}</strong><span>${escapeLegacyHtml(request.sampleModel || '样品型号待完善')}</span></div>
      <div class="legacy-request-count"><strong>${escapeLegacyHtml(request.quantity)}</strong><span>电池块数</span></div>
      <div class="legacy-request-count pending"><strong>${escapeLegacyHtml(request.pendingCount)}</strong><span>待安排</span></div>
      <button class="btn light" type="button" data-legacy-action="select-request" data-request-no="${escapeLegacyHtml(request.requestNo)}">预约</button>
    </article>`).join('');
}

function renderRequestList(state, uiState) {
  const page = requestPage(state, {
    text: uiState.searchText,
    pendingOnly: uiState.pendingOnly,
    page: uiState.requestPage,
    pageSize: 50
  });
  return `
    <section class="legacy-reservation-list panel">
      <header class="legacy-panel-heading"><div><h2>选择测试申请</h2><p>列表只保留笔记本上预约所需的信息。</p></div><span>${page.total} 条结果</span></header>
      <div class="legacy-list-toolbar">
        <label class="field"><span>搜索申请单、项目、样品或人员</span><input type="search" data-legacy-action="search-requests" value="${escapeLegacyHtml(uiState.searchText)}" placeholder="例如：2026007 无人机 35Ah"></label>
        <label class="legacy-check"><input type="checkbox" data-legacy-action="pending-only" ${uiState.pendingOnly ? 'checked' : ''}><span>仅看待安排</span></label>
      </div>
      <div class="legacy-request-head"><span>申请单 / 测试</span><span>项目 / 样品</span><span>数量</span><span>待安排</span><span>操作</span></div>
      <div class="legacy-request-body">${requestRows(page, uiState)}</div>
      ${pager('request', page)}
    </section>`;
}

function sampleRows(state, samples, uiState) {
  if (!samples.items.length) return '<div class="empty">当前申请没有可显示的子样品。</div>';
  return samples.items.map(sample => {
    const channelKey = uiState.assignments[sample.id] ?? sample.channelKey ?? '';
    const channel = state.channels.find(item => item.key === channelKey);
    const channelLabel = channel ? `${channel.device} / ${channel.name}` : '选择通道';
    return `
      <div class="legacy-sample-row" data-testid="legacy-sample-row">
        <div><strong>${escapeLegacyHtml(sample.id)}</strong><span>${escapeLegacyHtml(SAMPLE_STATUS_LABEL[sample.status] || sample.status)}</span></div>
        <button type="button" class="legacy-channel-select" data-legacy-action="open-channel-picker" data-sample-id="${escapeLegacyHtml(sample.id)}" ${sample.status !== 'pending' ? 'disabled' : ''}>
          <strong>${escapeLegacyHtml(channelLabel)}</strong><small>${channel ? escapeLegacyHtml(channel.spec || '参数待完善') : '按设备、通道或量程搜索'}</small>
        </button>
      </div>`;
  }).join('');
}

function renderChannelPicker(state, uiState) {
  if (!uiState.channelPickerSampleId) return '';
  const result = channelCandidates(state, {
    mode: uiState.mode,
    text: uiState.channelSearch,
    page: uiState.channelPage,
    limit: 40
  });
  const assignedElsewhere = new Set(Object.entries(uiState.assignments)
    .filter(([sampleId]) => sampleId !== uiState.channelPickerSampleId)
    .map(([, channelKey]) => channelKey));
  const options = result.items.map(channel => {
    const alreadySelected = assignedElsewhere.has(channel.key);
    return `
      <button type="button" class="legacy-channel-option" data-testid="legacy-channel-option" data-legacy-action="choose-channel" data-channel-key="${escapeLegacyHtml(channel.key)}" ${alreadySelected ? 'disabled' : ''}>
        <span><strong>${escapeLegacyHtml(channel.device || channel.deviceName)}</strong><b>${escapeLegacyHtml(channel.name)}</b></span>
        <small>${escapeLegacyHtml(channel.spec || '参数待完善')} · ${channel.state === 'busy' ? '当前测试结束后可预约' : '空闲'}${alreadySelected ? ' · 已分配给本批次其它子样品' : ''}</small>
      </button>`;
  }).join('') || '<div class="empty">没有匹配的可用通道。</div>';
  return `
    <section class="legacy-channel-picker" data-testid="legacy-channel-picker">
      <header><div><strong>为 ${escapeLegacyHtml(uiState.channelPickerSampleId)} 选择通道</strong><span>每页最多 40 条，共 ${result.total} 条匹配</span></div><button type="button" data-legacy-action="close-channel-picker" aria-label="关闭">×</button></header>
      <label class="field"><span>搜索设备、通道或量程</span><input type="search" data-legacy-action="search-channels" value="${escapeLegacyHtml(uiState.channelSearch)}" placeholder="输入设备、通道或参数"></label>
      <div class="legacy-channel-options">${options}</div>
      ${pager('channel', result)}
    </section>`;
}

function requestByNo(state, requestNo) {
  return state.requests.find(item => String(item.id ?? item.requestNo) === String(requestNo));
}

function renderDetails(state, uiState, detailsGeneration = 0) {
  if (!uiState.detailsOpen || !uiState.selectedRequestNo) return '';
  const request = requestByNo(state, uiState.selectedRequestNo);
  if (!request) return `<aside class="legacy-reservation-details panel" data-testid="legacy-reservation-details" data-request-no="${escapeLegacyHtml(uiState.selectedRequestNo)}" data-details-generation="${detailsGeneration}"><div class="empty">申请已不存在，请关闭面板后刷新。</div></aside>`;
  const samples = samplePage(state, uiState.selectedRequestNo, uiState.samplePage);
  return `
    <aside class="legacy-reservation-details panel" data-testid="legacy-reservation-details" data-request-no="${escapeLegacyHtml(uiState.selectedRequestNo)}" data-details-generation="${detailsGeneration}">
      <header class="legacy-details-heading"><div><span>${escapeLegacyHtml(uiState.selectedRequestNo)}</span><h2>本次测试信息</h2></div><button type="button" data-legacy-action="close-details" aria-label="关闭详情">×</button></header>
      <div class="legacy-details-scroll">
        <div class="notice"><strong>原始申请保持不变</strong><br>本次安排只写入使用记录和审计。</div>
        <dl class="legacy-request-summary"><div><dt>批号（申请单号）</dt><dd>${escapeLegacyHtml(uiState.selectedRequestNo)}</dd></div><div><dt>测试项目</dt><dd>${escapeLegacyHtml(request.test || request.testName || '待完善')}</dd></div><div><dt>项目名称</dt><dd>${escapeLegacyHtml(request.project || '待完善')}</dd></div><div><dt>样品型号</dt><dd>${escapeLegacyHtml(request.sample || request.sampleModel || '待完善')}</dd></div><div><dt>子样品</dt><dd>${samples.total} 块</dd></div></dl>
        <fieldset class="legacy-mode-switch"><legend>执行方式</legend><label><input type="radio" name="legacy-mode" data-legacy-action="mode" value="reserve" ${uiState.mode === 'reserve' ? 'checked' : ''}><span>提交预约</span></label><label><input type="radio" name="legacy-mode" data-legacy-action="mode" value="start" ${uiState.mode === 'start' ? 'checked' : ''}><span>立即开始</span></label></fieldset>
        <div class="legacy-time-grid"><label class="field"><span>${uiState.mode === 'start' ? '开始时间' : '预约开始时间'}</span><input type="datetime-local" data-legacy-action="start-time" value="${escapeLegacyHtml(uiState.start)}"></label><label class="field"><span>预计结束时间（可选）</span><input type="datetime-local" data-legacy-action="end-time" value="${escapeLegacyHtml(uiState.end)}"></label><label class="field full"><span>备注</span><textarea data-legacy-action="note" aria-label="备注" rows="2">${escapeLegacyHtml(uiState.note)}</textarea></label></div>
        <section class="legacy-sample-assignment"><header><div><h3>分配子样品</h3><p>每个子编号代表一块电池，每个通道只能分配一块；整批校验后一次写入。</p></div><span>${Object.keys(uiState.assignments).length} 块已选</span></header><div>${sampleRows(state, samples, uiState)}</div>${pager('sample', samples)}</section>
        ${renderChannelPicker(state, uiState)}
        ${uiState.message ? `<div class="legacy-inline-message ${escapeLegacyHtml(uiState.messageTone)}" role="status">${escapeLegacyHtml(uiState.message)}</div>` : ''}
      </div>
      <footer class="legacy-details-actions"><button class="btn light" type="button" data-legacy-action="close-details">取消</button><button class="btn" type="button" data-legacy-action="submit-operation" ${uiState.busy ? 'disabled' : ''}>${uiState.mode === 'start' ? '立即开始' : '提交预约'}</button></footer>
    </aside>`;
}

export function renderLegacyReservationWorkspace(state, uiState, detailsGeneration = 0) {
  const detailsOpen = Boolean(uiState.detailsOpen && uiState.selectedRequestNo);
  return `<div class="legacy-reservation-workspace" data-testid="legacy-reservation-workspace" data-details-open="${detailsOpen}">${renderRequestList(state, uiState)}${renderDetails(state, uiState, detailsGeneration)}</div>`;
}

function localInputToIso(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    const error = new Error('时间格式无效');
    error.code = 'TIME_INTERVAL_INVALID';
    throw error;
  }
  return date.toISOString();
}

function failedResult(result) {
  const error = new Error(result?.message || '预约保存失败，当前页面未采用本次修改');
  error.code = result?.code || 'RESERVATION_COMMAND_FAILED';
  error.details = result?.details;
  return error;
}

export async function submitLegacyReservation(repository, currentState, uiState, options = {}) {
  if (!repository || typeof repository.executeReservation !== 'function') {
    throw failedResult({ code: 'DESKTOP_API_UNAVAILABLE', message: '桌面预约接口不可用' });
  }
  const assignments = Object.entries(uiState.assignments || {});
  if (!assignments.length) {
    throw failedResult({ code: 'ASSIGNMENT_REQUIRED', message: '请至少为一件待安排子样品选择通道' });
  }
  if (uiState.mode === 'reserve' && !uiState.start) {
    throw failedResult({ code: 'START_TIME_REQUIRED', message: '预约开始时间不能为空' });
  }
  const nowValue = (options.clock ?? (() => new Date()))();
  const now = nowValue instanceof Date ? nowValue : new Date(nowValue);
  if (Number.isNaN(now.getTime())) throw failedResult({ code: 'COMMAND_TIME_INVALID', message: '操作时间无效' });
  const idFactory = options.idFactory ?? (() => crypto.randomUUID());
  const common = {
    requestNo: uiState.selectedRequestNo,
    start: localInputToIso(uiState.start) || now.toISOString(),
    end: localInputToIso(uiState.end),
    actor: currentState.username || '当前用户',
    now: now.toISOString(),
    note: uiState.note || '',
    acceptWarning: false
  };
  const command = {
    type: uiState.mode === 'start' ? 'start' : 'reserve',
    payload: {
      ...common,
      items: assignments.map(([sampleId, channelKey]) => ({
        sampleId,
        channelKey,
        recordId: String(idFactory()),
        auditId: String(idFactory())
      }))
    }
  };

  let result = await repository.executeReservation(command);
  if (!result?.ok && result?.code === 'WARNING_CONFIRMATION_REQUIRED') {
    const confirmed = await (options.confirmAction ?? (message => window.confirm(message)))(
      `${result.message}\n\n确认后将重新校验整批预约并一次提交。`
    );
    if (!confirmed) throw failedResult({ code: 'WARNING_DECLINED', message: '用户未确认 WARNING，整批预约未保存' });
    result = await repository.executeReservation({
      ...command,
      payload: { ...command.payload, acceptWarning: true }
    });
  }
  if (!result?.ok) throw failedResult(result);
  if (!result.state || result.state.revision !== currentState.revision + 1) {
    throw failedResult({ code: 'REVISION_RESULT_INVALID', message: '保存结果修订号异常，请重新加载' });
  }
  return { state: result.state };
}

function toLocalInputValue(date = new Date()) {
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 16);
}

export function mountLegacyReservationWorkspace(root, repository, options = {}) {
  let state = options.initialState;
  let uiState = createLegacyReservationUiState({ start: toLocalInputValue() });
  let detailsGeneration = 0;

  function render(focusAction = '') {
    const detailsScrollTop = root.querySelector('.legacy-details-scroll')?.scrollTop;
    if (uiState.detailsOpen && uiState.selectedRequestNo) detailsGeneration += 1;
    root.innerHTML = renderLegacyReservationWorkspace(state, uiState, detailsGeneration);
    if (Number.isFinite(detailsScrollTop)) {
      const detailsScroll = root.querySelector('.legacy-details-scroll');
      if (detailsScroll) detailsScroll.scrollTop = detailsScrollTop;
    }
    if (focusAction) {
      const target = root.querySelector(`[data-legacy-action="${focusAction}"]`);
      target?.focus();
      if (target && typeof target.setSelectionRange === 'function') {
        target.setSelectionRange(target.value.length, target.value.length);
      }
    }
  }

  async function submit() {
    uiState = { ...uiState, busy: true, message: '' };
    render();
    try {
      const result = await submitLegacyReservation(repository, state, uiState, {
        confirmAction: options.confirmAction
      });
      state = result.state;
      uiState = closeLegacyReservation(uiState);
      options.onStateChange?.(state);
      options.notify?.(uiState.mode === 'start' ? '测试已开始' : '预约已提交', 'success');
      render();
    } catch (error) {
      let message = error.message || '操作失败，整批状态未保存';
      if (error?.code === 'REVISION_CONFLICT') {
        try {
          if (typeof repository.loadState !== 'function') throw new Error('桌面状态读取接口不可用');
          const latest = await repository.loadState();
          if (!latest || typeof latest !== 'object' || !Number.isInteger(latest.revision) || latest.revision <= state.revision) {
            throw new Error('未返回更新后的有效状态');
          }
          state = latest;
          options.onStateChange?.(state);
        } catch (refreshError) {
          message = `${message}；刷新最新状态失败：${refreshError?.message || '未知错误'}`;
        }
      }
      uiState = {
        ...uiState,
        busy: false,
        message,
        messageTone: 'error'
      };
      options.notify?.(message, 'error');
      render();
    }
  }

  function click(event) {
    const target = event.target.closest('[data-legacy-action]');
    if (!target || !root.contains(target) || target.disabled) return;
    const action = target.dataset.legacyAction;
    if (['search-requests', 'pending-only', 'mode', 'start-time', 'end-time', 'note', 'search-channels'].includes(action)) return;
    if (action === 'select-request') uiState = selectLegacyRequest(uiState, target.dataset.requestNo);
    if (action === 'close-details') uiState = closeLegacyReservation(uiState);
    if (action === 'request-previous' || action === 'request-next') {
      uiState = { ...uiState, requestPage: Math.max(1, uiState.requestPage + (action.endsWith('next') ? 1 : -1)) };
    }
    if (action === 'sample-previous' || action === 'sample-next') {
      uiState = { ...uiState, samplePage: Math.max(1, uiState.samplePage + (action.endsWith('next') ? 1 : -1)) };
    }
    if (action === 'channel-previous' || action === 'channel-next') {
      uiState = { ...uiState, channelPage: Math.max(1, uiState.channelPage + (action.endsWith('next') ? 1 : -1)) };
    }
    if (action === 'open-channel-picker') {
      uiState = { ...uiState, channelPickerSampleId: target.dataset.sampleId, channelSearch: '', channelPage: 1 };
      render('search-channels');
      return;
    }
    if (action === 'close-channel-picker') uiState = { ...uiState, channelPickerSampleId: null, channelSearch: '', channelPage: 1 };
    if (action === 'choose-channel') {
      const duplicate = Object.entries(uiState.assignments).some(([sampleId, key]) =>
        sampleId !== uiState.channelPickerSampleId && key === target.dataset.channelKey
      );
      if (!duplicate) {
        uiState = {
          ...uiState,
          assignments: { ...uiState.assignments, [uiState.channelPickerSampleId]: target.dataset.channelKey },
          channelPickerSampleId: null,
          channelSearch: '',
          channelPage: 1
        };
      }
    }
    if (action === 'submit-operation') {
      void submit();
      return;
    }
    render();
  }

  function input(event) {
    const action = event.target.dataset.legacyAction;
    if (action === 'search-requests') {
      uiState = { ...uiState, searchText: event.target.value, requestPage: 1 };
      render('search-requests');
    }
    if (action === 'search-channels') {
      uiState = { ...uiState, channelSearch: event.target.value, channelPage: 1 };
      render('search-channels');
    }
    if (action === 'start-time') uiState = { ...uiState, start: event.target.value };
    if (action === 'end-time') uiState = { ...uiState, end: event.target.value };
    if (action === 'note') uiState = { ...uiState, note: event.target.value };
  }

  function change(event) {
    const action = event.target.dataset.legacyAction;
    if (action === 'pending-only') {
      uiState = { ...uiState, pendingOnly: event.target.checked, requestPage: 1 };
      render();
    }
    if (action === 'mode') {
      uiState = {
        ...uiState,
        mode: event.target.value,
        start: event.target.value === 'start' ? toLocalInputValue() : uiState.start,
        assignments: {},
        channelPickerSampleId: null,
        channelSearch: '',
        channelPage: 1,
        message: ''
      };
      render();
    }
  }

  root.addEventListener('click', click);
  root.addEventListener('input', input);
  root.addEventListener('change', change);
  render();

  return {
    getState: () => state,
    getUiState: () => structuredClone(uiState),
    replaceState(nextState) {
      state = nextState;
      render();
    },
    openRequest(requestNo) {
      uiState = selectLegacyRequest(uiState, requestNo);
      render();
    },
    destroy() {
      root.removeEventListener('click', click);
      root.removeEventListener('input', input);
      root.removeEventListener('change', change);
      root.replaceChildren();
    }
  };
}
