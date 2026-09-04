import {
  channelCandidates,
  requestPage,
  samplePage
} from './reservation-view-model.mjs';
import {
  reserveSample,
  startSample
} from '../domain/reservation-transactions.mjs';
import { assertValidState } from '../domain/state-schema.mjs';

const STATUS_LABELS = {
  pending: '待安排',
  reserved: '已预约',
  running: '测试中',
  completed: '已完成',
  cancelled: '已取消'
};

export function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function displayDate(value) {
  if (!value) return '未设置';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return escapeHtml(value);
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  }).format(date);
}

export function createReservationPageState(overrides = {}) {
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
    message: '',
    messageTone: 'normal',
    busy: false,
    ...structuredClone(overrides)
  };
}

export function selectRequest(uiState, requestNo) {
  return {
    ...structuredClone(uiState),
    selectedRequestNo: requestNo,
    detailsOpen: true,
    samplePage: 1,
    assignments: {},
    channelPickerSampleId: null,
    channelSearch: '',
    message: '',
    messageTone: 'normal'
  };
}

export function closeReservation(uiState) {
  return {
    ...structuredClone(uiState),
    selectedRequestNo: null,
    detailsOpen: false,
    samplePage: 1,
    assignments: {},
    channelPickerSampleId: null,
    channelSearch: '',
    message: '',
    messageTone: 'normal'
  };
}

function renderRequestRows(page, uiState) {
  if (page.items.length === 0) {
    return `
      <div class="empty-state" role="status">
        <strong>没有匹配的申请</strong>
        <span>调整搜索词或关闭“仅看待安排”后重试。</span>
      </div>`;
  }
  return page.items.map((request) => {
    const selected = request.requestNo === uiState.selectedRequestNo;
    return `
      <div class="request-row${selected ? ' is-selected' : ''}" role="row" data-testid="request-row">
        <div class="request-check" role="cell"><input type="checkbox" aria-label="选择申请 ${escapeHtml(request.requestNo)}"></div>
        <div class="request-primary" role="cell">
          <strong title="${escapeHtml(request.requestNo)}">${escapeHtml(request.requestNo)}</strong>
          <span title="${escapeHtml(request.testName || '')}">${escapeHtml(request.testName || '测试项目待完善')}</span>
        </div>
        <div class="request-project" role="cell" title="${escapeHtml(request.project || '')}">${escapeHtml(request.project || '项目名称待完善')}</div>
        <div class="request-number" role="cell"><strong>${escapeHtml(request.quantity)}</strong><span>件</span></div>
        <div class="request-number pending" role="cell"><strong>${escapeHtml(request.pendingCount)}</strong><span>待安排</span></div>
        <div class="request-plan" role="cell">${escapeHtml(displayDate(request.expectedStart))}</div>
        <div class="request-action" role="cell">
          <button class="button button-secondary button-compact" type="button" data-action="select-request" data-request-no="${escapeHtml(request.requestNo)}">预约</button>
        </div>
      </div>`;
  }).join('');
}

function renderPager(name, page) {
  return `
    <div class="pager" aria-label="${escapeHtml(name)}分页">
      <span>第 ${page.page} / ${page.pageCount} 页，共 ${page.total} 条</span>
      <div>
        <button class="button button-ghost button-compact" type="button" data-action="${escapeHtml(name)}-previous" ${page.page <= 1 ? 'disabled' : ''}>上一页</button>
        <button class="button button-ghost button-compact" type="button" data-action="${escapeHtml(name)}-next" ${page.page >= page.pageCount ? 'disabled' : ''}>下一页</button>
      </div>
    </div>`;
}

function renderRequestList(state, uiState) {
  const page = requestPage(state, {
    text: uiState.searchText,
    pendingOnly: uiState.pendingOnly,
    page: uiState.requestPage,
    pageSize: 50
  });
  return `
    <section class="reservation-list-panel" aria-labelledby="request-list-title">
      <header class="panel-heading">
        <div>
          <h2 id="request-list-title">选择测试申请</h2>
          <p>只显示预约所需信息，执行字段在右侧填写。</p>
        </div>
        <span class="result-count">${page.total} 条结果</span>
      </header>
      <div class="list-toolbar">
        <label class="search-field">
          <span>搜索申请单、项目或样品</span>
          <input type="search" data-action="search-requests" value="${escapeHtml(uiState.searchText)}" placeholder="例如：2026007 无人机 35Ah" autocomplete="off">
        </label>
        <label class="check-field">
          <input type="checkbox" data-action="pending-only" ${uiState.pendingOnly ? 'checked' : ''}>
          <span>仅看待安排</span>
        </label>
      </div>
      <div class="request-table" role="table" aria-label="测试申请列表">
        <div class="request-table-head" role="row">
          <span role="columnheader"></span>
          <span role="columnheader">申请单</span>
          <span role="columnheader">项目名称</span>
          <span role="columnheader">数量</span>
          <span role="columnheader">待安排</span>
          <span role="columnheader">计划开始</span>
          <span role="columnheader">操作</span>
        </div>
        <div class="request-table-body">${renderRequestRows(page, uiState)}</div>
      </div>
      ${renderPager('request', page)}
    </section>`;
}

function renderSampleRows(state, samples, uiState) {
  if (samples.items.length === 0) {
    return '<div class="empty-state compact"><strong>没有待分配的子样品</strong></div>';
  }
  return samples.items.map((sample) => {
    const channelKey = uiState.assignments[sample.id] ?? sample.channelKey ?? '';
    const channel = state.channels.find((item) => item.key === channelKey);
    const channelLabel = channel
      ? `${channel.deviceName || channel.deviceId} / ${channel.name}`
      : '选择通道';
    return `
      <div class="sample-row" data-testid="sample-row">
        <div>
          <strong>${escapeHtml(sample.id)}</strong>
          <span class="status-label status-${escapeHtml(sample.status)}">${escapeHtml(STATUS_LABELS[sample.status] || sample.status)}</span>
        </div>
        <button class="channel-select" type="button" data-action="open-channel-picker" data-sample-id="${escapeHtml(sample.id)}" ${sample.status !== 'pending' ? 'disabled' : ''}>
          <span>${escapeHtml(channelLabel)}</span>
          <small>${channel ? escapeHtml(channel.spec || '参数待完善') : '搜索设备、通道或量程'}</small>
        </button>
      </div>`;
  }).join('');
}

function renderChannelPicker(state, uiState) {
  if (!uiState.channelPickerSampleId) return '';
  const result = channelCandidates(state, {
    mode: uiState.mode,
    text: uiState.channelSearch,
    limit: 40
  });
  const rows = result.items.length > 0
    ? result.items.map((channel) => `
        <button class="channel-result" type="button" data-action="choose-channel" data-channel-key="${escapeHtml(channel.key)}">
          <span><strong>${escapeHtml(channel.deviceName || channel.deviceId)}</strong><b>${escapeHtml(channel.name)}</b></span>
          <small>${escapeHtml(channel.spec || '参数待完善')} / ${escapeHtml(channel.state === 'busy' ? '当前测试结束后可预约' : '空闲')}</small>
        </button>`).join('')
    : '<div class="empty-state compact"><strong>没有可用通道</strong><span>更换搜索词或预约模式后重试。</span></div>';
  return `
    <div class="channel-picker" data-testid="channel-picker">
      <div class="channel-picker-head">
        <div><strong>为 ${escapeHtml(uiState.channelPickerSampleId)} 选择通道</strong><span>最多显示 40 条，共 ${result.total} 条匹配</span></div>
        <button class="icon-button" type="button" data-action="close-channel-picker" aria-label="关闭通道选择">×</button>
      </div>
      <label class="search-field compact">
        <span>搜索设备、通道或量程</span>
        <input type="search" data-action="search-channels" value="${escapeHtml(uiState.channelSearch)}" placeholder="输入设备、通道或参数" autocomplete="off">
      </label>
      <div class="channel-results">${rows}</div>
    </div>`;
}

function renderDetails(state, uiState) {
  if (!uiState.detailsOpen || !uiState.selectedRequestNo) return '';
  const request = state.requests.find((item) => item.requestNo === uiState.selectedRequestNo);
  if (!request) {
    return `
      <aside class="reservation-details" data-testid="reservation-details">
        <div class="empty-state"><strong>申请已不存在</strong><span>关闭面板并刷新申请列表。</span></div>
      </aside>`;
  }
  const samples = samplePage(state, request.requestNo, uiState.samplePage);
  return `
    <aside class="reservation-details" data-testid="reservation-details" aria-labelledby="details-title">
      <header class="details-heading">
        <div>
          <span class="details-context">${escapeHtml(request.requestNo)}</span>
          <h2 id="details-title">本次测试信息</h2>
        </div>
        <button class="icon-button" type="button" data-action="close-details" aria-label="关闭本次测试信息">×</button>
      </header>
      <div class="details-scroll">
        <div class="source-notice">
          <strong>原始申请保持不变</strong>
          <span>本次填写只进入使用记录和审计。</span>
        </div>
        <dl class="request-summary">
          <div><dt>测试项目</dt><dd>${escapeHtml(request.testName || '待完善')}</dd></div>
          <div><dt>项目名称</dt><dd title="${escapeHtml(request.project || '')}">${escapeHtml(request.project || '待完善')}</dd></div>
          <div><dt>样品型号</dt><dd>${escapeHtml(request.sampleModel || '待完善')}</dd></div>
          <div><dt>待安排</dt><dd>${samples.total} 件</dd></div>
        </dl>
        <fieldset class="mode-switch">
          <legend>执行方式</legend>
          <label><input type="radio" name="operation-mode" data-action="mode" value="reserve" ${uiState.mode === 'reserve' ? 'checked' : ''}><span>提交预约</span></label>
          <label><input type="radio" name="operation-mode" data-action="mode" value="start" ${uiState.mode === 'start' ? 'checked' : ''}><span>立即开始</span></label>
        </fieldset>
        <div class="field-grid">
          <label class="field">
            <span>${uiState.mode === 'start' ? '开始时间' : '预约开始时间'}</span>
            <input type="datetime-local" data-action="start-time" value="${escapeHtml(uiState.start)}">
          </label>
          <label class="field">
            <span>预计结束时间（可选）</span>
            <input type="datetime-local" data-action="end-time" value="${escapeHtml(uiState.end)}">
          </label>
          <label class="field field-full">
            <span>备注</span>
            <textarea data-action="note" rows="2" placeholder="特殊工况、排程说明或确认原因">${escapeHtml(uiState.note)}</textarea>
          </label>
        </div>
        <section class="sample-assignment" aria-labelledby="sample-title">
          <header>
            <div><h3 id="sample-title">分配子样品</h3><p>每页 25 件，通道候选按需搜索。</p></div>
            <span>${Object.keys(uiState.assignments).length} 件已选</span>
          </header>
          <div class="sample-list">${renderSampleRows(state, samples, uiState)}</div>
          ${renderPager('sample', samples)}
        </section>
        ${renderChannelPicker(state, uiState)}
        ${uiState.message ? `<div class="inline-message tone-${escapeHtml(uiState.messageTone)}" role="status">${escapeHtml(uiState.message)}</div>` : ''}
      </div>
      <footer class="details-actions">
        <button class="button button-ghost" type="button" data-action="close-details">取消</button>
        <button class="button button-primary" type="button" data-action="submit-operation" ${uiState.busy ? 'disabled' : ''}>${uiState.mode === 'start' ? '立即开始' : '提交预约'}</button>
      </footer>
    </aside>`;
}

export function renderReservationWorkspace(state, uiState) {
  const detailsOpen = Boolean(uiState.detailsOpen && uiState.selectedRequestNo);
  return `
    <div class="reservation-workspace" data-testid="reservation-workspace" data-details-open="${detailsOpen}">
      ${renderRequestList(state, uiState)}
      ${renderDetails(state, uiState)}
    </div>`;
}

export async function persistReservationDraft(repository, currentState, draft) {
  if (!repository || typeof repository.saveState !== 'function') {
    throw new Error('桌面保存接口不可用');
  }
  const expectedRevision = currentState?.dataRevision;
  if (!Number.isInteger(expectedRevision) || expectedRevision < 0) {
    throw new Error('当前数据修订号无效，请重新加载');
  }
  if (draft?.dataRevision !== expectedRevision) {
    throw new Error('待保存状态的修订号与当前状态不一致，请重新加载');
  }

  const saveResult = await repository.saveState({ state: draft, expectedRevision });
  if (!saveResult?.ok) {
    throw new Error(saveResult?.message || '保存失败，当前页面未采用本次修改');
  }
  const savedState = assertValidState(saveResult.state);
  if (savedState.dataRevision !== expectedRevision + 1) {
    throw new Error('保存结果的修订号异常，请重新加载');
  }
  return savedState;
}

function toLocalInputValue(date = new Date()) {
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 16);
}

function inputToIso(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error('时间格式无效');
  }
  return date.toISOString();
}

function showToast(message, tone = 'normal') {
  const host = document.getElementById('toast-host');
  if (!host) return;
  const toast = document.createElement('div');
  toast.className = `toast tone-${tone}`;
  toast.textContent = message;
  host.replaceChildren(toast);
  window.setTimeout(() => {
    if (host.contains(toast)) host.replaceChildren();
  }, 3200);
}

export function mountReservationPage(root, repository, options = {}) {
  let state = options.initialState;
  let uiState = createReservationPageState({ start: toLocalInputValue() });
  const confirmAction = options.confirmAction ?? ((message) => window.confirm(message));

  function render(focusAction = '') {
    root.innerHTML = renderReservationWorkspace(state, uiState);
    if (focusAction) {
      const target = root.querySelector(`[data-action="${focusAction}"]`);
      if (target) {
        target.focus();
        if (typeof target.setSelectionRange === 'function') {
          const end = target.value.length;
          target.setSelectionRange(end, end);
        }
      }
    }
  }

  async function submitOperation() {
    const assignments = Object.entries(uiState.assignments);
    if (assignments.length === 0) {
      uiState = { ...uiState, message: '请至少为一件待安排子样品选择通道', messageTone: 'error' };
      render();
      return;
    }
    if (uiState.mode === 'reserve' && !uiState.start) {
      uiState = { ...uiState, message: '预约开始时间不能为空', messageTone: 'error' };
      render();
      return;
    }

    uiState = { ...uiState, busy: true, message: '', messageTone: 'normal' };
    render();
    try {
      let draft = state;
      for (const [sampleId, channelKey] of assignments) {
        const now = new Date();
        const command = {
          requestNo: uiState.selectedRequestNo,
          sampleId,
          channelKey,
          start: uiState.mode === 'start' ? now.toISOString() : inputToIso(uiState.start),
          end: inputToIso(uiState.end),
          actor: state.username || '当前用户',
          recordId: crypto.randomUUID(),
          auditId: crypto.randomUUID(),
          now: now.toISOString(),
          note: uiState.note,
          acceptWarning: false
        };
        try {
          const result = uiState.mode === 'start'
            ? startSample(draft, command)
            : reserveSample(draft, command);
          draft = result.state;
        } catch (error) {
          if (error.code !== 'WARNING_CONFIRMATION_REQUIRED') throw error;
          const accepted = await confirmAction(`${error.message}\n\n确认后继续提交该预约。`);
          if (!accepted) throw new Error('用户未确认 WARNING，预约未保存');
          command.acceptWarning = true;
          draft = reserveSample(draft, command).state;
        }
      }

      state = await persistReservationDraft(repository, state, draft);
      uiState = closeReservation(uiState);
      render();
      showToast(uiState.mode === 'start' ? '测试已开始' : '预约已提交', 'success');
    } catch (error) {
      uiState = {
        ...uiState,
        busy: false,
        message: error.message || '操作失败，状态未保存',
        messageTone: 'error'
      };
      render();
    }
  }

  function handleClick(event) {
    const target = event.target.closest('[data-action]');
    if (!target || !root.contains(target) || target.disabled) return;
    const action = target.dataset.action;
    if (action === 'select-request') {
      uiState = selectRequest(uiState, target.dataset.requestNo);
      render();
      return;
    }
    if (action === 'close-details') {
      uiState = closeReservation(uiState);
      render();
      return;
    }
    if (action === 'request-previous' || action === 'request-next') {
      uiState = {
        ...uiState,
        requestPage: Math.max(1, uiState.requestPage + (action.endsWith('next') ? 1 : -1))
      };
      render();
      return;
    }
    if (action === 'sample-previous' || action === 'sample-next') {
      uiState = {
        ...uiState,
        samplePage: Math.max(1, uiState.samplePage + (action.endsWith('next') ? 1 : -1))
      };
      render();
      return;
    }
    if (action === 'open-channel-picker') {
      uiState = {
        ...uiState,
        channelPickerSampleId: target.dataset.sampleId,
        channelSearch: ''
      };
      render('search-channels');
      return;
    }
    if (action === 'close-channel-picker') {
      uiState = { ...uiState, channelPickerSampleId: null, channelSearch: '' };
      render();
      return;
    }
    if (action === 'choose-channel') {
      uiState = {
        ...uiState,
        assignments: {
          ...uiState.assignments,
          [uiState.channelPickerSampleId]: target.dataset.channelKey
        },
        channelPickerSampleId: null,
        channelSearch: ''
      };
      render();
      return;
    }
    if (action === 'submit-operation') {
      void submitOperation();
    }
  }

  function handleInput(event) {
    const action = event.target.dataset.action;
    if (action === 'search-requests') {
      uiState = { ...uiState, searchText: event.target.value, requestPage: 1 };
      render('search-requests');
      return;
    }
    if (action === 'search-channels') {
      uiState = { ...uiState, channelSearch: event.target.value };
      render('search-channels');
      return;
    }
    if (action === 'start-time') uiState = { ...uiState, start: event.target.value };
    if (action === 'end-time') uiState = { ...uiState, end: event.target.value };
    if (action === 'note') uiState = { ...uiState, note: event.target.value };
  }

  function handleChange(event) {
    const action = event.target.dataset.action;
    if (action === 'pending-only') {
      uiState = { ...uiState, pendingOnly: event.target.checked, requestPage: 1 };
      render();
      return;
    }
    if (action === 'mode') {
      uiState = {
        ...uiState,
        mode: event.target.value,
        start: event.target.value === 'start' ? toLocalInputValue() : uiState.start,
        assignments: {},
        channelPickerSampleId: null,
        channelSearch: '',
        message: ''
      };
      render();
    }
  }

  root.addEventListener('click', handleClick);
  root.addEventListener('input', handleInput);
  root.addEventListener('change', handleChange);
  render();

  return {
    getState: () => state,
    destroy() {
      root.removeEventListener('click', handleClick);
      root.removeEventListener('input', handleInput);
      root.removeEventListener('change', handleChange);
      root.replaceChildren();
    }
  };
}
