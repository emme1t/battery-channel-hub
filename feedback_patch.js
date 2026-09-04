(() => {
  const v04Style = document.createElement('style');
  v04Style.textContent = `
    body{overflow:hidden}
    .layout{height:calc(100vh - 64px);min-height:0}
    aside{height:100%;overflow-y:auto;overscroll-behavior:contain}
    main{height:100%;overflow-y:auto;overscroll-behavior:contain}
    .bulk-actions{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin:10px 0;color:var(--muted);font-size:12px}
    .bulk-actions .mini-btn{margin:0}
    .import-issues{background:#fff8e8;border:1px solid #f1d18a;color:#855d00;border-radius:8px;padding:12px 14px;margin:0 0 14px;line-height:1.6}
    .import-issues strong{color:#704a00}
    .tester-card{max-width:980px}
    .tester-editor{display:none}
    .tester-editor.open{display:block}
    .request-export-controls{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin:10px 0 14px;color:var(--muted);font-size:12px}
    .request-export-controls input,.request-export-controls button{height:32px}
    @media(max-width:720px){body{overflow:auto}.layout{height:auto;min-height:calc(100vh - 64px)}aside,main{height:auto;overflow:visible}}
  `;
  document.head.appendChild(v04Style);

  const isTestEnvironment = desktop?.isTestEnvironment === true;

  let testers = [];
  let formChangeJournal = [];
  let editingTesterId = null;
  const selectedRequestIds = new Set();
  const html = value => String(value ?? '').replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));

  function appendFormChange(action, requestId, before, after, note = '') {
    const source = after || before || {};
    formChangeJournal.push({
      id: `FORM-${Date.now()}-${Math.floor(Math.random() * 100000)}`,
      requestId: String(requestId || source.id || ''),
      action,
      time: new Date().toLocaleString('zh-CN', { hour12: false }),
      user: document.getElementById('displayUser')?.textContent || 'user001',
      before: typeof v03Copy === 'function' ? v03Copy(before) : before,
      after: typeof v03Copy === 'function' ? v03Copy(after) : after,
      source: {
        sourceFile: source.sourceFile || '',
        sourcePath: source.sourcePath || '',
        rawFields: typeof v03Copy === 'function' ? v03Copy(source.rawFields || {}) : (source.rawFields || {})
      },
      level: 'warning',
      note
    });
  }

  function saveLocalState() {
    if (typeof persist === 'function') persist();
  }

  function testerByName(name) {
    return testers.find(item => item.name === String(name || '').trim());
  }

  function renderTesterOptions() {
    let list = document.getElementById('testerOptions');
    if (!list) {
      list = document.createElement('datalist');
      list.id = 'testerOptions';
      document.body.appendChild(list);
    }
    list.innerHTML = testers.filter(item => item.status !== 'disabled').map(item => `<option value="${html(item.name)}">${html(item.dept || '')}</option>`).join('');
    ['eTester','fTester'].forEach(id => {
      const input = document.getElementById(id);
      if (input) {
        input.setAttribute('list', 'testerOptions');
        input.setAttribute('placeholder', '可下拉选择，也可直接填写');
      }
    });
  }

  function ensureTesterPage() {
    const menu = document.querySelector('[data-submenu="data"]');
    if (menu && !menu.querySelector('[data-page="testers"]')) {
      menu.insertAdjacentHTML('beforeend', '<button class="nav" data-page="testers"><b>♙</b>测试人员</button>');
      menu.querySelector('[data-page="testers"]').onclick = () => go('testers');
    }
    if (document.getElementById('testers')) return;
    const main = document.querySelector('main');
    if (!main) return;
    main.insertAdjacentHTML('beforeend', `
      <section id="testers" class="page">
        <div class="title-row"><div><h1>测试人员</h1><div class="sub">名单独立保存，可在申请执行字段和预约表单中下拉选择，也可直接填写临时人员。</div></div><div class="actions" style="margin-top:0"><button class="btn" onclick="openTesterEditor()">＋ 新增测试人员</button></div></div>
        <div class="panel tester-card"><div class="panel-h">测试人员名单 <span class="sub">新增、修改、编辑、删除都会写入操作日志</span></div><div id="testerTable" class="table-wrap"></div></div>
        <div id="testerEditor" class="panel tester-card tester-editor"><div class="panel-h"><span id="testerEditorTitle">新增测试人员</span><span class="sub">人员字段单独保存</span></div><div class="panel-b"><div class="form-grid"><label class="field">姓名 *<input id="tName"></label><label class="field">部门<input id="tDept"></label><label class="field">联系方式<input id="tPhone"></label><label class="field">状态<select id="tStatus"><option value="enabled">启用</option><option value="disabled">停用</option></select></label><label class="field full">备注<textarea id="tNote"></textarea></label></div><div class="actions"><button class="btn light" onclick="closeTesterEditor()">取消</button><button class="btn" onclick="saveTester()">保存测试人员</button></div></div></div>
      </section>`);
  }

  function renderTesters() {
    ensureTesterPage();
    const box = document.getElementById('testerTable');
    if (!box) return;
    box.innerHTML = testers.length ? `<table class="table management-table"><thead><tr><th>姓名</th><th>部门</th><th>联系方式</th><th>状态</th><th>备注</th><th>操作</th></tr></thead><tbody>${testers.map(item => `<tr><td><b>${html(item.name)}</b></td><td>${html(item.dept)}</td><td>${html(item.phone)}</td><td>${html(businessStatusLabel(item.status || 'enabled'))}</td><td>${html(item.note)}</td><td><button class="mini-btn" onclick="openTesterEditor('${encodeURIComponent(item.id)}')">编辑</button><button class="mini-btn danger" onclick="deleteTester('${encodeURIComponent(item.id)}')">删除</button></td></tr>`).join('')}</tbody></table>` : '<div class="empty">暂无测试人员，请先新增名单</div>';
    renderTesterOptions();
  }

  window.openTesterEditor = function(encoded) {
    ensureTesterPage();
    editingTesterId = encoded ? decodeURIComponent(encoded) : null;
    const item = testers.find(t => t.id === editingTesterId);
    document.getElementById('testerEditorTitle').textContent = item ? '编辑测试人员' : '新增测试人员';
    document.getElementById('tName').value = item?.name || '';
    document.getElementById('tDept').value = item?.dept || '';
    document.getElementById('tPhone').value = item?.phone || '';
    document.getElementById('tStatus').value = item?.status || 'enabled';
    document.getElementById('tNote').value = item?.note || '';
    const editor = document.getElementById('testerEditor');
    editor.classList.add('open');
    editor.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };
  window.closeTesterEditor = function() { editingTesterId = null; document.getElementById('testerEditor')?.classList.remove('open'); };
  window.saveTester = function() {
    const name = document.getElementById('tName').value.trim();
    if (!name) return toast('请填写测试人员姓名');
    if (testers.some(item => item.name === name && item.id !== editingTesterId)) return toast('该测试人员已存在');
    const before = testers.find(item => item.id === editingTesterId) || null;
    const next = { id: editingTesterId || `T-${Date.now()}-${Math.floor(Math.random() * 1000)}`, name, dept: document.getElementById('tDept').value.trim(), phone: document.getElementById('tPhone').value.trim(), status: document.getElementById('tStatus').value, note: document.getElementById('tNote').value.trim() };
    if (before) testers = testers.map(item => item.id === editingTesterId ? next : item); else testers.push(next);
    if (typeof addAudit === 'function') addAudit(before ? '修改测试人员' : '新增测试人员', `测试人员 ${name}`, before, next, '测试人员名单维护');
    saveLocalState();
    renderTesters();
    closeTesterEditor();
    toast(before ? '测试人员已修改' : '测试人员已新增');
  };
  window.deleteTester = function(encoded) {
    const id = decodeURIComponent(encoded);
    const item = testers.find(t => t.id === id);
    if (!item) return;
    if (!confirm(`确定删除测试人员 ${item.name} 吗？历史申请中的姓名不会被清除。`)) return;
    testers = testers.filter(t => t.id !== id);
    if (typeof addAudit === 'function') addAudit('删除测试人员', `测试人员 ${item.name}`, item, null, '仅删除名单，不清除历史申请字段');
    saveLocalState();
    renderTesters();
    toast('测试人员已删除');
  };

  const originalStateSnapshot = stateSnapshot;
  stateSnapshot = function() { return { ...originalStateSnapshot(), testers, formChangeJournal }; };
  const originalLoadPersisted = loadPersisted;
  loadPersisted = async function() {
    const typedUser = document.getElementById('username')?.value.trim();
    let persistedState = null;
    try { persistedState = desktop ? await desktop.loadState() : JSON.parse(localStorage.getItem('battery-channel-hub-state') || 'null'); } catch { persistedState = null; }
    testers = Array.isArray(persistedState?.testers) ? persistedState.testers : [];
    formChangeJournal = Array.isArray(persistedState?.formChangeJournal) ? persistedState.formChangeJournal : [];
    await originalLoadPersisted();
    if (!Array.isArray(testers) || !testers.length) testers = Array.isArray(persistedState?.testers) ? persistedState.testers : [];
    if (typedUser) {
      document.getElementById('displayUser').textContent = typedUser;
      document.querySelector('.avatar').textContent = typedUser.slice(0, 1).toUpperCase();
    }
    ensureTesterPage();
    renderTesterOptions();
  };

  const originalGo = go;
  go = function(id) { originalGo(id); if (id === 'testers') renderTesters(); };
  const originalEnterApp = enterApp;
  enterApp = async function() {
    if (!document.getElementById('username')?.value.trim()) return toast('请输入实际操作用户名');
    return originalEnterApp();
  };
  ensureTesterPage();
  renderTesterOptions();

  function ensureBulkActions() {
    const actions = document.querySelector('#requests .title-row .actions');
    if (!actions || document.getElementById('requestBulkActions')) return;
    actions.insertAdjacentHTML('afterend', '<div id="requestBulkActions" class="bulk-actions"><button class="mini-btn" onclick="toggleAllRequests()">全选/取消全选</button><button class="mini-btn" onclick="exportSelectedRequests()">导出选中</button><button class="mini-btn danger" onclick="deleteSelectedRequests()">删除选中</button><span id="requestSelectionSummary">已选 0 条</span></div>');
  }
  function updateRequestSelection() {
    document.querySelectorAll('.request-check').forEach(box => { box.checked = selectedRequestIds.has(box.value); });
    const all = document.getElementById('requestSelectAll');
    if (all) all.checked = requests.length > 0 && requests.every(item => selectedRequestIds.has(String(item.id)));
    const summary = document.getElementById('requestSelectionSummary');
    if (summary) summary.textContent = `已选 ${selectedRequestIds.size} 条`;
  }
  function displayLocalDateTime(value, fallback = '-') {
    return typeof globalThis.formatLegacyLocalDateTime === 'function'
      ? globalThis.formatLegacyLocalDateTime(value, fallback)
      : (String(value ?? '').trim() || fallback);
  }
  window.toggleAllRequests = function() {
    const allSelected = requests.length > 0 && requests.every(item => selectedRequestIds.has(String(item.id)));
    if (allSelected) selectedRequestIds.clear(); else requests.forEach(item => selectedRequestIds.add(String(item.id)));
    updateRequestSelection();
  };
  function requestRows(list, mode = 'table') {
    return list.map(r => {
      const execution = r.execution && typeof r.execution === 'object' ? r.execution : {};
      const tester = execution.tester ?? r.tester ?? '';
      const plannedEnd = execution.plannedEnd ?? r.end ?? '';
      const reserveButton = mode === 'pick' ? `<button class="link-btn" onclick="selectReq('${encodeURIComponent(r.id)}')">预约 →</button>` : '';
      return `<tr><td><input class="request-check" type="checkbox" value="${html(r.id)}" ${selectedRequestIds.has(String(r.id)) ? 'checked' : ''}></td><td><b>${html(r.id)}</b></td><td>${html(r.test)}</td><td>${html(r.project)}</td><td>${html(r.sample)}</td><td>${html(r.qty || 0)} 块</td><td>${html(r.client)}<br><small>${html(r.dept)}</small></td><td>${html(tester)}</td><td>${html(displayLocalDateTime(plannedEnd))}</td><td>${reserveButton}<button class="link-btn" onclick="editRequest('${encodeURIComponent(r.id)}')">编辑</button><button class="link-btn danger-link" onclick="deleteRequest('${encodeURIComponent(r.id)}')">删除</button></td></tr>`;
    }).join('');
  }
  renderRequestTable = function() {
    ensureBulkActions();
    const container = document.getElementById('requestTable');
    if (!container) return;
    container.innerHTML = `<table class="table"><thead><tr><th><input id="requestSelectAll" type="checkbox" title="全选"></th><th>申请单号</th><th>测试项目</th><th>项目名称</th><th>样品型号</th><th>送测数量</th><th>委托人 / 部门</th><th>测试人员</th><th>计划完成</th><th></th></tr></thead><tbody>${requestRows(requests, 'table') || '<tr><td colspan="10" class="empty">暂无申请单</td></tr>'}</tbody></table>`;
    container.querySelector('#requestSelectAll')?.addEventListener('change', event => { if (event.target.checked) requests.forEach(item => selectedRequestIds.add(String(item.id))); else selectedRequestIds.clear(); updateRequestSelection(); });
    container.querySelectorAll('.request-check').forEach(box => box.addEventListener('change', event => { if (event.target.checked) selectedRequestIds.add(event.target.value); else selectedRequestIds.delete(event.target.value); updateRequestSelection(); }));
    updateRequestSelection();
  };

  function selectedRequests() { return requests.filter(item => selectedRequestIds.has(String(item.id))); }
  window.exportSelectedRequests = async function() {
    const chosenRows = selectedRequests();
    if (!chosenRows.length) return toast('请先勾选要导出的申请单');
    const rows = chosenRows.map(exportApplicationRow);
    if (!desktop) { exportRowsAsCsv('选中测试申请汇总.csv', rows); return; }
    const result = await desktop.exportExcel({ title: '导出选中申请表', defaultFileName: `申请表单汇总_${currentDateKey()}.xlsx`, sheets: [{ name: '选中申请表格', rows }] });
    if (typeof addAudit === 'function') addAudit('批量导出申请单', '测试申请数据', null, { 数量: chosenRows.length }, '用户勾选后导出');
    saveLocalState();
    toast(result.ok ? `已导出 ${chosenRows.length} 条申请单` : (result.message || '导出已取消'));
  };
  window.deleteSelectedRequests = function() {
    const chosenRows = selectedRequests();
    if (!chosenRows.length) return toast('请先勾选要删除的申请单');
    const active = chosenRows.filter(item => records.some(record => String(record.no) === String(item.id) && isActiveRecord(record)));
    if (active.length) return toast(`有 ${active.length} 条申请仍有关联预约或测试，不能批量删除`);
    if (!confirm(`确定删除选中的 ${chosenRows.length} 条申请单吗？此操作会记录审计日志。`)) return;
    requests = requests.filter(item => !selectedRequestIds.has(String(item.id)));
    requestSourceRows = requestSourceRows.filter(item => !selectedRequestIds.has(String(item.id || item['申请单号'] || item['系统申请单号'])));
    if (typeof addAudit === 'function') addAudit('批量删除申请单', '测试申请数据', { 数量: chosenRows.length, 申请单号: chosenRows.map(item => item.id) }, null, '用户勾选后删除');
    selectedRequestIds.clear();
    saveLocalState();
    renderRequestTable();
    renderRequestPick();
    toast(`已删除 ${chosenRows.length} 条申请单`);
  };

  // 开始/预约测试页复用申请表选择能力，并支持只对当前搜索结果全选。
  window.toggleAllRequestPick = function() {
    const q = (document.getElementById('searchReq')?.value || '').toLowerCase();
    const current = requests.filter(item => Object.values(item).join(' ').toLowerCase().includes(q));
    const allSelected = current.length > 0 && current.every(item => selectedRequestIds.has(String(item.id)));
    current.forEach(item => allSelected ? selectedRequestIds.delete(String(item.id)) : selectedRequestIds.add(String(item.id)));
    renderRequestPick();
  };
  const originalRenderRequestPick = renderRequestPick;
  renderRequestPick = function() {
    const container = document.getElementById('requestPick');
    if (!container) return originalRenderRequestPick();
    const q = (document.getElementById('searchReq')?.value || '').toLowerCase();
    const list = requests.filter(item => Object.values(item).join(' ').toLowerCase().includes(q));
    const stale = [...selectedRequestIds].filter(id => !requests.some(item => String(item.id) === id));
    stale.forEach(id => selectedRequestIds.delete(id));
    container.innerHTML = `<div class="bulk-actions"><button class="mini-btn" onclick="toggleAllRequestPick()">全选当前结果</button><button class="mini-btn danger" onclick="deleteSelectedRequests()">批量删除</button><span>当前结果 ${list.length} 条 · 已选 ${selectedRequestIds.size} 条</span></div><table class="table"><thead><tr><th><input id="requestPickSelectAll" type="checkbox" title="全选当前结果"></th><th>申请单号</th><th>测试项目</th><th>项目名称</th><th>样品型号</th><th>送测数量</th><th>委托人 / 部门</th><th>测试人员</th><th>计划完成</th><th></th></tr></thead><tbody>${requestRows(list, 'pick') || '<tr><td colspan="10" class="empty">未找到匹配申请</td></tr>'}</tbody></table>`;
    const all = container.querySelector('#requestPickSelectAll');
    if (all) {
      all.checked = list.length > 0 && list.every(item => selectedRequestIds.has(String(item.id)));
      all.addEventListener('change', event => {
        list.forEach(item => event.target.checked ? selectedRequestIds.add(String(item.id)) : selectedRequestIds.delete(String(item.id)));
        renderRequestPick();
      });
    }
    container.querySelectorAll('.request-check').forEach(box => box.addEventListener('change', event => {
      if (event.target.checked) selectedRequestIds.add(event.target.value); else selectedRequestIds.delete(event.target.value);
      renderRequestPick();
    }));
  };

  function showImportIssues(title, issues) {
    let box = document.getElementById('importIssues');
    if (!box) {
      const host = document.getElementById('requests');
      box = document.createElement('div');
      box.id = 'importIssues';
      host?.insertBefore(box, host.querySelector('.panel'));
    }
    box.className = 'import-issues';
    box.innerHTML = `<strong>${html(title)}</strong><br>${issues.map(item => `${html(item.file || '')}：${html(item.message || '无法识别')}`).join('<br>')}`;
  }
  function clearImportIssues() { document.getElementById('importIssues')?.remove(); }
  function mergeImportedRecords(records, sourceRows, label) {
    const incoming = records.map(item => item.normalized ? mapImportedRecord(item) : item).filter(item => item?.id);
    if (!incoming.length) return { incoming, info: null };
    const info = typeof v03ImportIntoState === 'function' ? v03ImportIntoState(incoming, sourceRows, label) : null;
    if (!info) {
      requests = [...requests, ...incoming.filter(item => !requests.some(old => String(old.id) === String(item.id)))];
      requestSourceRows = [...requestSourceRows, ...sourceRows];
      saveLocalState();
      renderRequestTable();
      renderRequestPick();
    }
    return { incoming, info };
  }
  importFormFolder = async function() {
    if (!desktop) return toast('浏览器预览模式不支持批量读取文件夹，请使用便携版 exe');
    const result = await desktop.importFolder();
    if (result.canceled) return;
    if (!result.ok) { showImportIssues('批量导入失败', [{ file: '', message: result.message }]); return toast(result.message || '读取文件夹失败'); }
    clearImportIssues();
    const { incoming, info } = mergeImportedRecords(result.records || [], result.records || [], '批量整理文件夹');
    if (result.errors?.length) showImportIssues(`批量导入完成，但有 ${result.errors.length} 个文件未导入`, result.errors);
    if (!incoming.length) return toast(result.errors?.length ? '没有有效申请单，请查看异常清单' : '文件夹中没有可识别的申请单');
    toast(`已导入 ${incoming.length} 条申请单${info?.duplicateIds?.length ? `，重复项已${info.mode === 'cover' ? '覆盖' : '跳过'}` : ''}${result.errors?.length ? `，${result.errors.length} 个异常文件未导入` : ''}`);
  };
  importExcel = async function() {
    if (!desktop) return toast('浏览器预览模式不支持直接读取 Excel，请使用便携版 exe');
    const result = await desktop.importExcel();
    if (result.canceled) return;
    if (!result.ok) { showImportIssues('单个 Excel 导入失败', [{ file: result.file || '', message: result.message }]); return toast(result.message || 'Excel 导入失败'); }
    clearImportIssues();
    const { incoming, info } = mergeImportedRecords(result.records || [], result.records || result.rows || [], '导入单个 Excel');
    saveLocalState();
    if (!incoming.length) return toast('未识别到有效申请单，请检查 Excel 格式');
    toast(`单个 Excel 导入完成：读取 ${incoming.length} 条申请单${info?.duplicateIds?.length ? `，重复项已${info.mode === 'cover' ? '覆盖' : '跳过'}` : ''}`);
  };

  const originalSubmitOperation = submitOperation;
  submitOperation = function(type) {
    const testerName = document.getElementById('fTester')?.value.trim() || '';
    originalSubmitOperation(type);
    const latest = records[0];
    if (latest && testerName) { latest.tester = testerName; saveLocalState(); renderRecords(); }
  };
  const originalRenderAll = renderAll;
  renderAll = function() { originalRenderAll(); ensureTesterPage(); renderTesters(); renderTesterOptions(); ensureBulkActions(); ensureRequestExportControls(); };
  renderRequestTable();

  function ensureTestLogControls() {
    const recordsPage = document.getElementById('records');
    const auditPanel = document.getElementById('auditTable')?.closest('.panel');
    if (!recordsPage || !auditPanel) return;
    const subtitle = recordsPage.querySelector('.panel .panel-h .sub');
    if (subtitle) subtitle.textContent = isTestEnvironment ? '测试环境：可清空本机测试日志；正式版不提供此入口' : '日志长期留存，不提供修改或删除入口';
    if (!isTestEnvironment || document.getElementById('clearTestLogsButton')) return;
    const title = auditPanel.querySelector('.panel-h');
    if (!title) return;
    const button = document.createElement('button');
    button.id = 'clearTestLogsButton';
    button.className = 'mini-btn danger';
    button.textContent = '测试环境：清空日志';
    button.title = '仅源码测试环境可用，正式版不提供此功能';
    button.onclick = window.clearTestLogs;
    title.appendChild(button);
  }

  window.clearTestLogs = async function() {
    if (!isTestEnvironment || typeof desktop?.clearTestLogs !== 'function') return toast('正式版不提供删除日志功能');
    if (!confirm('确定清空测试环境中的全部操作审计、使用日志和表单变更留档吗？此功能不会进入正式版。')) return;
    const result = await desktop.clearTestLogs();
    if (!result.ok) return toast(result.message || '测试日志清理失败');
    auditLogs = [];
    records = [];
    formChangeJournal = [];
    renderAll();
    renderAuditTable();
    ensureTestLogControls();
    toast('测试环境日志已清空');
  };

  function requestDateKey(value) {
    if (value instanceof Date && !Number.isNaN(value.getTime())) {
      return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`;
    }
    const text = String(value ?? '').trim();
    const match = text.match(/(\d{4})[-\/.年](\d{1,2})[-\/.月](\d{1,2})/);
    if (match) return `${match[1]}-${String(match[2]).padStart(2, '0')}-${String(match[3]).padStart(2, '0')}`;
    const compact = text.match(/^(\d{4})(\d{2})(\d{2})/);
    if (compact) return `${compact[1]}-${compact[2]}-${compact[3]}`;
    const parsed = new Date(text.replace(/年|月/g, '-').replace(/日/g, '').replace(/\//g, '-'));
    if (Number.isNaN(parsed.getTime())) return '';
    return `${parsed.getFullYear()}-${String(parsed.getMonth() + 1).padStart(2, '0')}-${String(parsed.getDate()).padStart(2, '0')}`;
  }

  function currentDateKey() {
    return requestDateKey(new Date());
  }

  function ensureRequestExportControls() {
    const actions = document.querySelector('#requests .title-row .actions');
    if (!actions) return;
    const folderButton = actions.querySelector('[onclick*="importFormFolder"]');
    if (folderButton) folderButton.textContent = '⇧ 导入文件夹';
    const exportButton = actions.querySelector('[onclick="exportRequests()"]');
    if (exportButton) exportButton.textContent = '⇩ 导出申请汇总';
    if (document.getElementById('requestExportControls')) return;
    actions.insertAdjacentHTML('afterend', `<div id="requestExportControls" class="request-export-controls">
      <span>按计划完成日期范围导出</span>
      <input id="requestExportStartDate" type="date" aria-label="计划完成开始日期">
      <span>至</span>
      <input id="requestExportEndDate" type="date" aria-label="计划完成结束日期">
      <button class="mini-btn" onclick="exportRequestsByDate()">导出指定日期范围</button>
      <button class="mini-btn" onclick="clearRequestExportDate()">清除日期</button>
      <span id="requestExportHint">未选择日期时导出全部申请</span>
    </div>`);
    ['requestExportStartDate', 'requestExportEndDate'].forEach(id => document.getElementById(id)?.addEventListener('change', updateRequestExportHint));
  }

  window.clearRequestExportDate = function() {
    ['requestExportStartDate', 'requestExportEndDate'].forEach(id => { const input = document.getElementById(id); if (input) input.value = ''; });
    updateRequestExportHint();
  };

  function updateRequestExportHint() {
    const from = document.getElementById('requestExportStartDate')?.value || '';
    const to = document.getElementById('requestExportEndDate')?.value || '';
    const hint = document.getElementById('requestExportHint');
    if (!hint) return;
    hint.textContent = from || to ? `按 ${from || '开始'} 至 ${to || '结束'} 筛选` : '未选择日期时导出全部申请';
  }

  window.exportRequestsByDate = function() {
    return exportRequests();
  };

  exportRequests = async function() {
    ensureRequestExportControls();
    const fromDate = document.getElementById('requestExportStartDate')?.value || '';
    const toDate = document.getElementById('requestExportEndDate')?.value || '';
    if (fromDate && toDate && fromDate > toDate) return toast('开始日期不能晚于结束日期');
    const filtered = (fromDate || toDate) ? requests.filter(item => {
      const key = requestDateKey(item.end);
      return Boolean(key) && (!fromDate || key >= fromDate) && (!toDate || key <= toDate);
    }) : requests;
    if ((fromDate || toDate) && !filtered.length) return toast(`计划完成日期 ${fromDate || '开始'} 至 ${toDate || '结束'} 没有申请表`);
    const rows = filtered.map(exportApplicationRow);
    const items = filtered.map(item => ({ ...exportApplicationRow(item), 测试序号: 1, 测试项目: item.test || '', 测试状态: businessStatusLabel(item.status || 'pending') }));
    const dateForName = fromDate && toDate ? `${fromDate}至${toDate}` : fromDate ? `${fromDate}起` : toDate ? `${toDate}止` : currentDateKey();
    const defaultFileName = `申请表单汇总_${dateForName}.xlsx`;
    addAudit('导出申请表格', '申请数据', null, { 数量: filtered.length, 计划完成开始日期: fromDate || '不限', 计划完成结束日期: toDate || '不限' }, fromDate || toDate ? `按计划完成日期范围导出` : '导出全部申请表');
    persist();
    if (!desktop) {
      exportRowsAsCsv(defaultFileName.replace(/\.xlsx$/i, '.csv'), rows);
      return;
    }
    const result = await desktop.exportExcel({
      title: fromDate || toDate ? '导出指定日期范围申请表' : '导出申请表汇总',
      defaultFileName,
      sheets: [{ name: '测试申请表格', rows }, { name: '测试项目明细', rows: items }]
    });
    toast(result.ok ? `已导出 ${filtered.length} 条申请表：${defaultFileName}` : (result.message || '导出已取消'));
  };

  ensureRequestExportControls();

  // V0.5：预约处理、简单数据包、真实审计日志导出和通道管理延期。
  const v05Style = document.createElement('style');
  v05Style.textContent = `
    .card.overdue{border-left-color:var(--red);background:#fff7f7}
    .card.overdue .badge{color:#a83139;background:#ffe9ea}
    .reservation-actions{display:flex;gap:6px;flex-wrap:wrap}
    .condition-text{color:#9a5a00;font-size:11px}
    .history-note{font-size:12px;color:var(--muted);line-height:1.6}
    .channel-history{display:none}
    .channel-history.open{display:block}
    .channel-history .timeline{max-height:420px;overflow:auto}
  `;
  document.head.appendChild(v05Style);

  const v05IsOverdue = channel => {
    if (!channel || !['busy', 'booked'].includes(channel.state) || !channel.end) return false;
    const end = new Date(channel.end);
    return !Number.isNaN(end.getTime()) && end.getTime() < Date.now();
  };

  function ensureReservationPage() {
    const menu = document.querySelector('[data-submenu="workspace"]');
    if (menu && !menu.querySelector('[data-page="reserved"]')) {
      menu.insertAdjacentHTML('beforeend', '<button class="nav" data-page="reserved"><b>▣</b>已预约表单处理</button>');
      menu.querySelector('[data-page="reserved"]').onclick = () => go('reserved');
    }
    if (document.getElementById('reserved')) return;
    const main = document.querySelector('main');
    if (!main) return;
    main.insertAdjacentHTML('beforeend', `
      <section id="reserved" class="page">
        <div class="title-row"><div><h1>已预约表单处理</h1><div class="sub">集中处理已经提交的预约；开始、取消和延期均保留在长期日志中。</div></div><div class="actions" style="margin-top:0"><button class="btn light" onclick="go('devices')">到设备与通道管理</button></div></div>
        <div class="notice">这里处理的是软件中的预约表单，不连接真实设备。延期/预计结束时间编辑统一放在“设备与通道管理”。</div>
        <div class="panel"><div class="panel-h">当前已预约表单 <span id="reservedSummary" class="sub"></span></div><div id="reservedTable" class="table-wrap"></div></div>
      </section>`);
  }

  function renderReservedPage() {
    ensureReservationPage();
    const box = document.getElementById('reservedTable');
    const summary = document.getElementById('reservedSummary');
    if (!box) return;
    const items = records.map((record, index) => ({ record, index })).filter(item => item.record.status === 'reserved');
    if (summary) summary.textContent = `共 ${items.length} 条，退回或取消后仍保留审计记录`;
    box.innerHTML = items.length ? `<table class="table"><thead><tr><th>申请单号</th><th>项目</th><th>通道</th><th>预约开始</th><th>预计结束</th><th>操作人</th><th>处理</th></tr></thead><tbody>${items.map(({ record, index }) => `<tr data-reserved-row="${index}"><td><b>${html(record.no)}</b></td><td>${html(record.project)}<br><small>${html(record.test)}</small></td><td>${html(record.channels)}</td><td>${html(displayLocalDateTime(record.time))}</td><td>${html(record.end ? displayLocalDateTime(record.end) : '未填写 · 持续占用')}</td><td>${html(record.user || '-')}</td><td class="reservation-actions"><button class="mini-btn" data-res-start="${index}">开始测试</button><button class="mini-btn danger" data-res-return="${index}">退回申请</button><button class="mini-btn danger" data-res-cancel="${index}">取消预约</button></td></tr>`).join('')}</tbody></table>` : '<div class="empty">暂无已预约表单</div>';
    box.querySelectorAll('[data-res-start]').forEach(button => button.addEventListener('click', () => startReservedRecord(Number(button.dataset.resStart))));
    box.querySelectorAll('[data-res-return]').forEach(button => button.addEventListener('click', () => returnReservedRecord(Number(button.dataset.resReturn))));
    box.querySelectorAll('[data-res-cancel]').forEach(button => button.addEventListener('click', () => cancelReservedRecord(Number(button.dataset.resCancel))));
  }

  window.openReservedRecordDetails = function(index) {
    go('reserved');
    renderReservedPage();
    const row = document.querySelector(`[data-reserved-row="${Number(index)}"]`);
    row?.classList.add('reserved-focus');
    row?.scrollIntoView({ block: 'center' });
  };

  async function startReservedRecord(index) {
    const record = records[index];
    if (!record || record.status !== 'reserved') return;
    const channelKey = record.channelKey || record.keys?.[0];
    if (!desktop?.executeReservation || !channelKey) {
      toast('预约记录缺少可用通道，无法开始测试');
      return;
    }
    let result;
    try {
      result = await desktop.executeReservation({
        type: 'transition',
        payload: {
          action: 'start',
          channelKey,
          actor: document.getElementById('displayUser')?.textContent || '当前用户',
          auditId: crypto.randomUUID(),
          now: new Date().toISOString()
        }
      });
    } catch (error) {
      toast(error?.message || '开始预约测试失败，状态未修改');
      return;
    }
    if (!result?.ok) {
      toast(result?.message || '开始预约测试失败，状态未修改');
      return;
    }
    adoptApplicationState(result.state);
    renderReservedPage();
    toast('已开始预约测试');
  }

  async function cancelReservedRecord(index) {
    const record = records[index];
    if (!record || record.status !== 'reserved') return;
    if (!confirm(`确定取消申请单 ${record.no} 的预约吗？取消动作会写入长期日志。`)) return;
    const channelKey = record.channelKey || record.keys?.[0];
    if (!desktop?.executeReservation || !channelKey) {
      toast('预约记录缺少可用通道，无法取消预约');
      return;
    }
    let result;
    try {
      result = await desktop.executeReservation({
        type: 'transition',
        payload: {
          action: 'cancel',
          channelKey,
          actor: document.getElementById('displayUser')?.textContent || '当前用户',
          auditId: crypto.randomUUID(),
          now: new Date().toISOString()
        }
      });
    } catch (error) {
      toast(error?.message || '取消预约失败，状态未修改');
      return;
    }
    if (!result?.ok) {
      toast(result?.message || '取消预约失败，状态未修改');
      return;
    }
    adoptApplicationState(result.state);
    renderReservedPage();
    toast('预约已取消，相关通道已释放');
  }

  async function returnReservedRecord(index) {
    const record = records[index];
    if (!record || record.status !== 'reserved') return;
    const workbench = window.__legacySampleWorkbenches;
    if (!record.id || typeof workbench?.returnReservedToApplication !== 'function') {
      toast('预约退回功能尚未就绪，请刷新页面后重试');
      return;
    }
    try {
      await workbench.returnReservedToApplication(record.id);
      renderReservedPage();
    } catch (error) {
      toast(error?.message || '预约退回失败，状态未修改');
    }
  }

  function ensureRestoreButton() {
    const actions = document.querySelector('#dashboard .title-row .actions');
    if (!actions || document.getElementById('restoreDataButton')) return;
    const button = document.createElement('button');
    button.id = 'restoreDataButton';
    button.className = 'btn light';
    button.textContent = '恢复数据包';
    button.onclick = restoreState;
    actions.insertBefore(button, actions.firstChild);
  }

  window.restoreState = async function() {
    if (!desktop) return toast('浏览器预览模式不支持恢复数据包，请使用便携版 exe');
    const result = await desktop.restoreState();
    if (result.canceled) return;
    if (!result.ok) return toast(result.message || '恢复数据包失败');
    await loadPersisted();
    renderAll();
    renderReservedPage();
    toast(`数据包已恢复；恢复前自动备份已保存${result.autoBackup ? `：${result.autoBackup}` : ''}`);
  };

  // 申请单中的期望开始/完成时间用于计算默认使用时长；完成时间允许手动改动或留空。
  let v05DurationMs = 0;
  let v05EndTouched = false;
  function v05ApplyDefaultEnd() {
    if (!v05DurationMs || v05EndTouched || !fStart?.value) return;
    const start = new Date(fStart.value);
    if (Number.isNaN(start.getTime())) return;
    fEnd.value = new Date(start.getTime() + v05DurationMs).toISOString().slice(0, 16);
  }
  fStart?.addEventListener('input', v05ApplyDefaultEnd);
  fEnd?.addEventListener('input', () => { v05EndTouched = true; });
  const v05SelectReq = selectReq;
  selectReq = function(id) {
    v05EndTouched = false;
    v05DurationMs = 0;
    v05SelectReq(id);
    const request = requests.find(item => String(item.id) === String(id));
    const expectedStart = request?.startDate ? new Date(request.startDate) : null;
    const expectedEnd = request?.end ? new Date(request.end) : null;
    if (expectedStart && expectedEnd && !Number.isNaN(expectedStart.getTime()) && !Number.isNaN(expectedEnd.getTime()) && expectedEnd > expectedStart) {
      v05DurationMs = expectedEnd.getTime() - expectedStart.getTime();
      if (fStart?.value) v05ApplyDefaultEnd();
    } else if (fEnd) {
      fEnd.value = '';
    }
  };

  const v05SubmitOperation = submitOperation;
  submitOperation = function(type) {
    if (type === 'reserve' && fStart?.value) {
      const start = new Date(fStart.value);
      const selectedChannels = chosen.map(key => channels.find(channel => channel.key === key)).filter(Boolean);
      const blockedUntil = selectedChannels.reduce((latest, channel) => {
        const end = channel.end ? new Date(channel.end) : null;
        return end && !Number.isNaN(end.getTime()) && end > latest ? end : latest;
      }, new Date(0));
      if (!Number.isNaN(start.getTime()) && blockedUntil.getTime() > 0 && start < blockedUntil) {
        return toast(`预约开始时间不能早于通道预计结束时间：${blockedUntil.toLocaleString('zh-CN', { hour12: false })}`);
      }
    }
    return v05SubmitOperation(type);
  };

  // 通道延期和特殊状况统一放到设备与通道管理，不再放在看板卡片上。
  function ensureChannelManagementFields() {
    const grid = document.querySelector('#channelEditor .form-grid');
    if (!grid || document.getElementById('cEnd')) return;
    grid.insertAdjacentHTML('beforeend', '<label class="field full">预计结束时间（可选）<input id="cEnd" type="datetime-local"><div class="form-help">可用于延期或修正预约结束时间；不填写代表持续占用。</div></label><label class="field full">特殊状况说明<textarea id="cCondition" placeholder="例如：温控异常、等待样品、通道校准中"></textarea></label>');
  }

  function ensureChannelHistoryPanel() {
    if (document.getElementById('channelHistoryPanel')) return;
    const host = document.getElementById('devices');
    const tablePanel = document.getElementById('channelTable')?.closest('.panel');
    if (!host || !tablePanel) return;
    tablePanel.insertAdjacentHTML('afterend', `<div id="channelHistoryPanel" class="panel channel-history">
      <div class="panel-h"><span>通道历史时间轴</span><span id="channelHistoryTitle" class="sub">只读展示；记录来自操作审计和使用日志</span></div>
      <div class="panel-b"><div id="channelHistoryBody" class="history-note">请选择一个通道查看历史。</div></div>
    </div>`);
  }

  window.openChannelHistory = function(encoded) {
    ensureChannelHistoryPanel();
    const key = decodeURIComponent(encoded || '');
    const channel = channels.find(item => item.key === key);
    const panel = document.getElementById('channelHistoryPanel');
    const title = document.getElementById('channelHistoryTitle');
    const body = document.getElementById('channelHistoryBody');
    if (!panel || !body || !channel) return;
    const target = `通道 ${channel.device} · ${channel.name}`;
    const audits = (Array.isArray(auditLogs) ? auditLogs : []).filter(item => String(item.target || '') === target);
    const usage = (Array.isArray(records) ? records : []).filter(item => item.keys?.includes(key));
    const events = [
      ...audits.map(item => ({ time: item.time || '', type: '操作审计', title: item.action || '通道操作', text: item.note || '', level: item.level || 'normal', before: item.before, after: item.after })),
      ...usage.map(item => ({ time: item.time || item.cancelledAt || '', type: '使用日志', title: `${item.state || '使用记录'} · 申请单 ${item.no || ''}`, text: `${item.project || ''}${item.user ? ` · 操作人：${item.user}` : ''}`, level: 'normal', before: null, after: null }))
    ].sort((a, b) => String(b.time).localeCompare(String(a.time), 'zh-CN'));
    title.textContent = `${channel.device} · ${channel.name} · ${events.length} 条记录`;
    body.innerHTML = events.length ? `<div class="timeline">${events.map(event => `<div class="event"><b>${html(event.title)} <span class="status ${event.level === 'warning' ? 'red' : 'done'}">${event.level === 'warning' ? 'WARNING' : event.type}</span></b><small>${html(event.time)}${event.text ? ` · ${html(event.text)}` : ''}</small>${event.before || event.after ? `<div class="history-note">前：${html(auditText(event.before))}<br>后：${html(auditText(event.after))}</div>` : ''}</div>`).join('')}</div>` : '<div class="empty">该通道暂无历史记录</div>';
    panel.classList.add('open');
    panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };
  const v05OpenChannelEditor = window.openChannelEditor;
  window.openChannelEditor = function(encoded) {
    ensureChannelManagementFields();
    v05OpenChannelEditor(encoded);
    const key = encoded ? decodeURIComponent(encoded) : null;
    const channel = channels.find(item => item.key === key);
    if (document.getElementById('cEnd')) document.getElementById('cEnd').value = channel?.end || '';
    if (document.getElementById('cCondition')) document.getElementById('cCondition').value = channel?.specialCondition || channel?.note || '';
  };
  const v05SaveChannel = window.saveChannel;
  window.saveChannel = function() {
    const device = document.getElementById('cDevice')?.value || '';
    const name = document.getElementById('cName')?.value.trim() || '';
    const key = `${device}|${name}`;
    const before = channels.find(item => item.key === key);
    v05SaveChannel();
    const after = channels.find(item => item.key === key);
    if (!after) return;
    const nextEnd = document.getElementById('cEnd')?.value || '';
    const condition = document.getElementById('cCondition')?.value.trim() || '';
    after.end = ['free', 'fault'].includes(after.state) ? null : (nextEnd || null);
    after.specialCondition = condition;
    records.forEach(record => {
      if (record.keys?.includes(key) && !['completed', 'cancelled'].includes(record.status)) record.end = nextEnd;
    });
    if (JSON.stringify(before?.end || '') !== JSON.stringify(after.end || '') || JSON.stringify(before?.specialCondition || before?.note || '') !== JSON.stringify(condition)) {
      addAudit('编辑通道预计结束/特殊状况', `通道 ${after.device} · ${after.name}`, before ? { end: before.end || '', specialCondition: before.specialCondition || before.note || '' } : null, { end: after.end || '', specialCondition: condition }, '延期编辑统一在设备与通道管理中进行');
    }
    persist();
    renderBoard();
    renderDevices();
    renderRecords();
  };

  const v05RenderBoard = renderBoard;
  renderBoard = function() {
    v05RenderBoard();
    const groups = [...document.querySelectorAll('#board .board-device')];
    groups.forEach(group => {
      const title = group.querySelector('.device-h b')?.textContent || '';
      const cards = [...group.querySelectorAll('.card')];
      channels.filter(channel => channel.device === title).forEach((channel, index) => {
        const card = cards[index];
        if (!card) return;
        if (v05IsOverdue(channel)) {
          card.classList.add('overdue');
          const badge = card.querySelector('.badge');
          if (badge) badge.textContent = '已超期';
        }
        if (channel.specialCondition && card.querySelector('.content')) card.querySelector('.content').insertAdjacentHTML('beforeend', `<br><span class="condition-text">特殊状况：${html(channel.specialCondition)}</span>`);
        card.querySelectorAll('[onclick*="extend"]').forEach(button => button.remove());
      });
    });
    ensureRestoreButton();
  };

  const v05RenderDevices = renderDevices;
  renderDevices = function() {
    ensureChannelManagementFields();
    v05RenderDevices();
    const head = document.querySelector('#channelTable thead tr');
    if (head && !head.querySelector('[data-special-condition]')) {
      const cell = document.createElement('th');
      cell.dataset.specialCondition = '1';
      cell.textContent = '特殊状况';
      head.insertBefore(cell, head.lastElementChild);
    }
    const rows = [...document.querySelectorAll('#channelTable tbody tr')];
    channels.forEach((channel, index) => {
      const row = rows[index];
      if (!row) return;
      const cells = row.querySelectorAll('td');
      const statusCell = cells[6];
      if (statusCell && v05IsOverdue(channel)) statusCell.innerHTML = '<span class="status red">已超期</span>';
      const conditionCell = document.createElement('td');
      conditionCell.textContent = channel.specialCondition || channel.note || '-';
      row.insertBefore(conditionCell, row.lastElementChild);
      if (['busy', 'booked'].includes(channel.state)) {
        const actions = row.lastElementChild;
        if (actions && !actions.querySelector('[data-channel-delay]')) {
          const button = document.createElement('button');
          button.className = 'mini-btn';
          button.dataset.channelDelay = '1';
          button.textContent = '延期/编辑';
          button.onclick = () => window.openChannelEditor(encodeURIComponent(channel.key));
          actions.insertBefore(button, actions.firstChild);
        }
      }
      const actions = row.lastElementChild;
      if (actions && !actions.querySelector('[data-channel-history]')) {
        const button = document.createElement('button');
        button.className = 'mini-btn';
        button.dataset.channelHistory = '1';
        button.textContent = '查看历史';
        button.onclick = () => openChannelHistory(encodeURIComponent(channel.key));
        actions.appendChild(button);
      }
    });
    ensureChannelHistoryPanel();
  };

  const v05RenderRecords = renderRecords;
  renderRecords = function() {
    v05RenderRecords();
    [...document.querySelectorAll('#recordTable tbody tr')].forEach((row, index) => {
      if (records[index]?.status === 'cancelled') {
        row.cells[4].innerHTML = '<span class="status done">已取消</span>';
        row.lastElementChild.innerHTML = '<span class="history-note">预约已取消，日志保留</span>';
      }
    });
    renderReservedPage();
  };

  const v05ExportRecords = exportRecords;
  exportRecords = async function() {
    addAudit('导出真实日志', '日志数据', null, { 审计数量: auditLogs.length, 使用记录数量: records.length }, '导出实际审计日志、使用记录和通道状态');
    persist();
    const auditRows = auditLogs.map(item => ({
      日志编号: item.id || '', 时间: item.time || '', 等级: String(item.level || 'normal').toUpperCase(), 操作人: item.user || '', 动作: item.action || '', 对象: item.target || '', 修改前: JSON.stringify(item.before ?? ''), 修改后: JSON.stringify(item.after ?? ''), 备注: item.note || '', 记录来源: item.source || '软件操作'
    }));
    const recordRows = records.map(item => ({ 申请单号: item.no || '', 项目名称: item.project || '', 测试项目: item.test || '', 使用通道: item.channels || '', 状态: businessStatusLabel(item.status || 'pending'), 预约或开始时间: item.time || '', 预计结束时间: item.end || '', 操作人: item.user || '', 记录来源: item.source || '软件操作', 备注: item.note || '' }));
    const usageRows = typeof buildUsageRows === 'function' ? buildUsageRows() : recordRows;
    const channelRows = channels.map(channel => ({ 设备: channel.device || '', 通道: channel.name || '', 量程: channel.spec || '', 状态: v05IsOverdue(channel) ? '已超期' : (channel.state || ''), 特殊状况: channel.specialCondition || channel.note || '', 项目: channel.project || '', 操作人: channel.user || '', 预计结束: channel.end || '', 数据来源: '软件看板状态' }));
    const defaultFileName = `日志_${currentDateKey()}.xlsx`;
    if (!desktop) { exportRowsAsCsv(defaultFileName.replace(/\.xlsx$/i, '.csv'), auditRows); return; }
    const result = await desktop.exportExcel({ title: '导出日志', defaultFileName, sheets: [{ name: '日志', rows: auditRows }, { name: '使用记录', rows: recordRows }, { name: '测试设备使用表2', rows: usageRows }, { name: '通道当前状态', rows: channelRows }] });
    toast(result.ok ? '真实日志和使用数据已导出' : (result.message || '导出已取消'));
  };

  // 表单变更单独追加完整前后快照；不依赖页面上的审计表，因此导出入口无需展示这些记录。
  const originalSaveRequestEdit = saveRequestEdit;
  saveRequestEdit = function() {
    if (!editingRequest) return;
    const requestId = editingRequest.id;
    const before = typeof v03Copy === 'function' ? v03Copy(editingRequest) : JSON.parse(JSON.stringify(editingRequest));
    originalSaveRequestEdit();
    const after = requests.find(item => String(item.id) === String(requestId));
    if (after && JSON.stringify(before) !== JSON.stringify(after)) {
      appendFormChange('修改申请执行字段', requestId, before, after, '测试人员字段修改；原始申请字段保留在快照中');
      persist();
    }
  };

  const originalDeleteRequest = deleteRequest;
  deleteRequest = function(id) {
    const before = requests.find(item => String(item.id) === String(id));
    const snapshot = before && (typeof v03Copy === 'function' ? v03Copy(before) : JSON.parse(JSON.stringify(before)));
    originalDeleteRequest(id);
    if (snapshot && !requests.some(item => String(item.id) === String(id))) {
      appendFormChange('删除申请单', id, snapshot, null, '单个申请单删除；删除前完整快照留存');
      persist();
    }
  };

  const originalDeleteSelectedRequests = window.deleteSelectedRequests;
  window.deleteSelectedRequests = function() {
    const before = selectedRequests().map(item => typeof v03Copy === 'function' ? v03Copy(item) : JSON.parse(JSON.stringify(item)));
    originalDeleteSelectedRequests();
    const removed = before.filter(item => !requests.some(current => String(current.id) === String(item.id)));
    if (removed.length) {
      removed.forEach(item => appendFormChange('批量删除申请单', item.id, item, null, '批量删除；删除前完整快照留存'));
      persist();
    }
  };

  function journalImportedRequests(beforeRequests, action) {
    const beforeMap = new Map(beforeRequests.map(item => [String(item.id), item]));
    const afterMap = new Map(requests.map(item => [String(item.id), item]));
    let changed = false;
    for (const [id, after] of afterMap) {
      const before = beforeMap.get(id);
      if (!before) {
        appendFormChange(action, id, null, after, '导入申请单；保留原始文件名和完整路径');
        changed = true;
      } else if (JSON.stringify(before) !== JSON.stringify(after)) {
        appendFormChange('覆盖导入申请单', id, before, after, '重复申请单号选择覆盖；旧表单完整快照留存');
        changed = true;
      }
    }
    if (changed) persist();
  }

  const originalImportFormFolder = importFormFolder;
  importFormFolder = async function() {
    const before = requests.map(item => typeof v03Copy === 'function' ? v03Copy(item) : JSON.parse(JSON.stringify(item)));
    const result = await originalImportFormFolder();
    journalImportedRequests(before, '批量导入申请单');
    return result;
  };

  const originalImportExcel = importExcel;
  importExcel = async function() {
    const before = requests.map(item => typeof v03Copy === 'function' ? v03Copy(item) : JSON.parse(JSON.stringify(item)));
    const result = await originalImportExcel();
    journalImportedRequests(before, '导入申请单');
    return result;
  };

  const fullRequestAliasMap = {
    '申请单号': 'id', '申请单编号': 'id', '单号': 'id', '申请编号': 'id', '系统申请单号': 'id',
    '测试项目': 'test', '测试类型': 'test', '项目类型': 'test', '测试类型（申请）': 'test',
    '项目名称': 'project', '项目': 'project', '归属项目': 'project', '归属项目号': 'projectNo',
    '样品名称': 'sampleName', '样品型号': 'sample', '电芯型号': 'sample', '型号': 'sample',
    '样品数量': 'qty', '送测样品数量': 'qty', '送测数量': 'qty', '额定容量(Ah)': 'capacity', '额定容量': 'capacity',
    '委托人': 'client', '申请人': 'client', '委托部门': 'dept', '部门': 'dept', '联系方式': 'phone', '联系电话': 'phone',
    '接收人': 'tester', '测试人员': 'tester', '测试人': 'tester', '测试费用': 'fee', '测试通道/设备': 'device',
    '计划开始日期': 'startDate', '计划开始时间': 'startDate', '期望开始时间': 'startDate', '期望开始日期': 'startDate',
    '计划完成日期': 'end', '计划完成时间': 'end', '期望完成时间': 'end', '期望完成日期': 'end', '需求完成时间': 'end',
    '备注': 'note'
  };
  const fullRequestCanonicalFields = [
    { label: '系统申请单号', prop: 'id' }, { label: '测试项目', prop: 'test' }, { label: '项目名称', prop: 'project' },
    { label: '归属项目号', prop: 'projectNo' }, { label: '样品名称', prop: 'sampleName' }, { label: '样品型号', prop: 'sample' },
    { label: '样品数量', prop: 'qty' }, { label: '额定容量(Ah)', prop: 'capacity' }, { label: '委托人', prop: 'client' },
    { label: '委托部门', prop: 'dept' }, { label: '联系方式', prop: 'phone' }, { label: '测试人员', prop: 'tester' },
    { label: '测试费用', prop: 'fee' }, { label: '测试通道/设备', prop: 'device' }, { label: '计划开始日期', prop: 'startDate' },
    { label: '计划完成日期', prop: 'end' }, { label: '备注', prop: 'note', multiline: true },
    { label: '原始文件名', prop: 'sourceFile', readOnly: true }, { label: '原始文件路径', prop: 'sourcePath', readOnly: true }
  ];

  function fullRequestFieldDefs(request) {
    const rawFields = request?.rawFields && typeof request.rawFields === 'object' ? request.rawFields : {};
    const rawDefs = Object.keys(rawFields).map((key, index) => ({
      domKey: `raw-${index}-${key}`,
      rawKey: key,
      prop: fullRequestAliasMap[key] || '',
      label: key,
      multiline: /备注|说明|流程|判定|要求/.test(key)
    }));
    const mappedProps = new Set(rawDefs.map(item => item.prop).filter(Boolean));
    const canonicalDefs = fullRequestCanonicalFields
      .filter(item => !mappedProps.has(item.prop) || item.readOnly)
      .map((item, index) => ({ ...item, domKey: `canonical-${index}-${item.prop}` }));
    return [...rawDefs, ...canonicalDefs];
  }

  function fullRequestFieldValue(request, def) {
    if (def.rawKey) {
      if (request?.editedFields && Object.prototype.hasOwnProperty.call(request.editedFields, def.rawKey)) return request.editedFields[def.rawKey];
      return request?.rawFields?.[def.rawKey] ?? '';
    }
    return request?.[def.prop] ?? '';
  }

  function fullRequestNormalizeValue(prop, value) {
    const text = String(value ?? '').trim();
    if (text === '') return '';
    if (['qty', 'capacity', 'fee'].includes(prop)) {
      const number = Number(text);
      return Number.isFinite(number) ? number : text;
    }
    return text;
  }

  function fullRequestSnapshot(request) {
    return typeof v03Copy === 'function' ? v03Copy({
      id: request?.id || '', test: request?.test || '', project: request?.project || '', projectNo: request?.projectNo || '',
      sampleName: request?.sampleName || '', sample: request?.sample || '', qty: request?.qty ?? '', capacity: request?.capacity ?? '',
      client: request?.client || '', dept: request?.dept || '', phone: request?.phone || '', tester: request?.tester || '',
      fee: request?.fee ?? '', device: request?.device || '', startDate: request?.startDate || '', end: request?.end || '',
      note: request?.note || '', sourceFile: request?.sourceFile || '', sourcePath: request?.sourcePath || '',
      rawFields: request?.rawFields || {}, editedFields: request?.editedFields || {}
    }) : JSON.parse(JSON.stringify(request || {}));
  }

  function ensureFullRequestEditor() {
    const panel = document.querySelector('#requestEditor .panel-b');
    if (!panel || panel.dataset.fullEditor === 'true') return;
    panel.dataset.fullEditor = 'true';
    panel.innerHTML = `<div id="requestFullFields" class="form-grid request-full-fields"></div><div class="form-help">所有申请字段均可修改；原始导入值保存在原始字段快照中，修改后的值单独保存并写入 WARNING 日志。原始文件名和路径仅用于追溯。</div><div class="actions"><button class="btn light" onclick="closeRequestEditor()">取消</button><button class="btn" onclick="saveRequestEdit()">保存全部字段</button></div>`;
    const style = document.createElement('style');
    style.textContent = '.request-full-fields{grid-column:1/-1;max-height:540px;overflow:auto;padding-right:6px}.request-full-fields .field input[readonly],.request-full-fields .field textarea[readonly]{background:#f4f7f9;color:#71808b}.request-full-fields .field textarea{min-height:72px}';
    document.head.appendChild(style);
  }

  function renderFullRequestEditor(request) {
    ensureFullRequestEditor();
    const box = document.getElementById('requestFullFields');
    if (!box) return;
    const defs = fullRequestFieldDefs(request);
    box.innerHTML = defs.map(def => {
      const value = html(fullRequestFieldValue(request, def));
      const readonly = def.readOnly ? ' readonly' : '';
      const input = def.multiline ? `<textarea data-full-field="${encodeURIComponent(def.domKey)}"${readonly}>${value}</textarea>` : `<input data-full-field="${encodeURIComponent(def.domKey)}" value="${value}"${readonly}>`;
      return `<label class="field">${html(def.label)}${input}</label>`;
    }).join('');
  }

  editRequest = function(id) {
    editingRequest = requests.find(item => String(item.id) === String(decodeURIComponent(id)));
    if (!editingRequest) return;
    requestEditor.style.display = 'block';
    renderFullRequestEditor(editingRequest);
    requestEditor.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  saveRequestEdit = function() {
    if (!editingRequest) return;
    const beforeId = String(editingRequest.id || '');
    const before = fullRequestSnapshot(editingRequest);
    const defs = fullRequestFieldDefs(editingRequest);
    const values = new Map([...document.querySelectorAll('#requestFullFields [data-full-field]')].map(input => [decodeURIComponent(input.dataset.fullField), input.value]));
    const next = { ...editingRequest, editedFields: { ...(editingRequest.editedFields || {}) } };
    defs.forEach(def => {
      if (def.readOnly || !values.has(def.domKey)) return;
      const value = values.get(def.domKey);
      next.editedFields[def.rawKey || def.label] = value;
      if (def.prop) next[def.prop] = fullRequestNormalizeValue(def.prop, value);
    });
    next.id = String(next.id || '').trim();
    if (!next.id) return toast('申请单号不能为空');
    if (requests.some(item => item !== editingRequest && String(item.id) === next.id)) return toast('申请单号已存在，不能重复');
    if (beforeId !== next.id) records.forEach(record => { if (String(record.no) === beforeId) record.no = next.id; });
    requests = requests.map(item => item === editingRequest ? next : item);
    const after = fullRequestSnapshot(next);
    if (JSON.stringify(before) !== JSON.stringify(after)) {
      addAudit('修改申请全字段', `申请单 ${beforeId || next.id}`, before, after, '编辑页面修改全部申请字段；原始字段保留');
      appendFormChange('修改申请全字段', next.id, before, after, '编辑页面修改全部申请字段；原始表单快照保留');
    }
    editingRequest = next;
    persist();
    renderRequestTable();
    renderRequestPick();
    closeRequestEditor();
    toast('申请单全部字段已保存');
  };

  exportApplicationRow = function(request) {
    const rawFields = request?.rawFields && typeof request.rawFields === 'object' ? request.rawFields : {};
    const editedFields = request?.editedFields && typeof request.editedFields === 'object' ? request.editedFields : {};
    const row = {};
    Object.entries(rawFields).forEach(([key, value]) => { row[key] = value ?? ''; row[`原始_${key}`] = value ?? ''; });
    Object.entries(editedFields).forEach(([key, value]) => { row[`当前_${key}`] = value ?? ''; });
    Object.assign(row, {
      '系统申请单号': request?.id || '', '原始文件名': request?.sourceFile || '', '原始文件路径': request?.sourcePath || '',
      '归属项目': request?.project || '', '归属项目号': request?.projectNo || '', '委托部门': request?.dept || '',
      '委托人': request?.client || '', '联系方式': request?.phone || '', '样品名称': request?.sampleName || '',
      '样品型号': request?.sample || '', '样品数量': request?.qty ?? '', '额定容量(Ah)': request?.capacity ?? '',
      '测试类型（申请）': request?.test || '', '测试人员': request?.tester || '', '测试费用': request?.fee ?? '',
      '计划开始日期': request?.startDate || '', '计划完成日期': request?.end || '', '测试通道/设备': request?.device || '',
      '备注': request?.note || '', '导入状态': businessStatusLabel(request?.status || 'pending')
    });
    return row;
  };

  ensureFullRequestEditor();

  const v05Go = go;
  go = function(id) {
    v05Go(id);
    if (id === 'reserved') renderReservedPage();
    if (id === 'devices') { ensureChannelManagementFields(); renderDevices(); }
    if (id === 'records') ensureTestLogControls();
  };

  const v05RenderAll = renderAll;
  renderAll = function() {
    ensureReservationPage();
    v05RenderAll();
    renderReservedPage();
    ensureRestoreButton();
    ensureTestLogControls();
  };

  // 管理页的持久化统一通过主进程白名单命令完成。页面不再先改本地数组再保存，
  // 也不再把执行字段反写进 Excel 原始字段。
  let applicationCommandSequence = 0;
  function applicationMetadata(prefix) {
    applicationCommandSequence += 1;
    const stamp = `${Date.now()}-${applicationCommandSequence}-${Math.floor(Math.random() * 100000)}`;
    return {
      actor: document.getElementById('displayUser')?.textContent || 'user001',
      auditId: `AUDIT-${prefix}-${stamp}`,
      journalId: `JOURNAL-${prefix}-${stamp}`,
      now: new Date().toISOString()
    };
  }

  function adoptApplicationState(state) {
    requests = Array.isArray(state?.requests) ? state.requests : [];
    samples = Array.isArray(state?.samples) ? state.samples : [];
    channels = Array.isArray(state?.channels) ? state.channels : [];
    deviceProfiles = Array.isArray(state?.deviceProfiles) ? state.deviceProfiles : [];
    records = Array.isArray(state?.records) ? state.records : [];
    storageRecords = Array.isArray(state?.storageRecords) ? state.storageRecords : [];
    requestSourceRows = Array.isArray(state?.requestSourceRows) ? state.requestSourceRows : [];
    auditLogs = Array.isArray(state?.auditLogs) ? state.auditLogs : [];
    formChangeJournal = Array.isArray(state?.formChangeJournal) ? state.formChangeJournal : [];
    testers = Array.isArray(state?.testers) ? state.testers : [];
    selectedRequestIds.forEach(id => {
      if (!requests.some(item => String(item.id) === String(id))) selectedRequestIds.delete(id);
    });
    window.__legacyReservationWorkspace?.replaceState?.(state);
    renderAll();
    renderTesters();
    renderTesterOptions();
  }
  window.adoptLegacyApplicationState = adoptApplicationState;

  async function executeApplicationCommand(type, payload) {
    if (!desktop || typeof desktop.executeApplication !== 'function') {
      toast('当前运行入口未启用安全管理命令');
      return { ok: false, code: 'APPLICATION_COMMAND_UNAVAILABLE' };
    }
    let result;
    try {
      result = await desktop.executeApplication({ type, payload });
    } catch (error) {
      toast(error?.message || '管理操作失败，状态未修改');
      return { ok: false, code: error?.code || 'APPLICATION_COMMAND_FAILED' };
    }
    if (!result?.ok) {
      if (result?.code === 'REVISION_CONFLICT') {
        try { adoptApplicationState(await desktop.loadState()); } catch {}
      }
      toast(result?.message || '管理操作被阻断，状态未修改');
      return result || { ok: false, code: 'APPLICATION_COMMAND_FAILED' };
    }
    adoptApplicationState(result.state);
    return result;
  }

  function executionOf(request) {
    const current = request?.execution && typeof request.execution === 'object' ? request.execution : {};
    return {
      tester: current.tester ?? request?.tester ?? '',
      fee: current.fee ?? request?.fee ?? '',
      device: current.device ?? request?.device ?? '',
      plannedStart: current.plannedStart ?? request?.startDate ?? '',
      plannedEnd: current.plannedEnd ?? request?.end ?? '',
      note: current.note ?? request?.note ?? ''
    };
  }

  function renderExecutionEditor(request) {
    const panel = document.querySelector('#requestEditor .panel-b');
    if (!panel) return;
    const execution = executionOf(request);
    panel.dataset.fullEditor = 'false';
    panel.innerHTML = `<div class="form-grid">
      <label class="field">申请单号<input id="eNo" readonly value="${html(request.id || '')}"></label>
      <label class="field">测试人员<input id="eTester" value="${html(execution.tester)}"></label>
      <label class="field">测试费用<input id="eFee" type="number" step="0.01" value="${html(execution.fee)}"></label>
      <label class="field">测试通道/设备<input id="eDevice" value="${html(execution.device)}"></label>
      <label class="field">计划开始日期<input id="eStartDate" type="date" value="${html(String(execution.plannedStart || '').slice(0, 10))}"></label>
      <label class="field">计划完成日期<input id="eEndDate" type="date" value="${html(String(execution.plannedEnd || '').slice(0, 10))}"></label>
      <label class="field full">备注<textarea id="eNote" aria-label="备注">${html(execution.note)}</textarea></label>
    </div>
    <details class="form-help"><summary>查看原始申请字段（只读）</summary><pre id="requestRawPreview" style="white-space:pre-wrap;max-height:260px;overflow:auto"></pre></details>
    <div class="actions"><button class="btn light" onclick="closeRequestEditor()">取消</button><button class="btn" onclick="saveRequestEdit()">保存执行字段</button></div>`;
    document.getElementById('requestRawPreview').textContent = JSON.stringify(request.rawFields || {}, null, 2);
    renderTesterOptions();
  }

  editRequest = function(encoded) {
    const id = decodeURIComponent(encoded || '');
    editingRequest = requests.find(item => String(item.id) === String(id));
    if (!editingRequest) return;
    requestEditor.style.display = 'block';
    renderExecutionEditor(editingRequest);
    requestEditor.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  saveRequestEdit = async function() {
    if (!editingRequest) return;
    const requestNo = String(editingRequest.id || '');
    const result = await executeApplicationCommand('editRequest', {
      requestNo,
      fields: {
        tester: document.getElementById('eTester')?.value.trim() || '',
        fee: Number(document.getElementById('eFee')?.value || 0) || 0,
        device: document.getElementById('eDevice')?.value.trim() || '',
        plannedStart: document.getElementById('eStartDate')?.value || '',
        plannedEnd: document.getElementById('eEndDate')?.value || '',
        note: document.getElementById('eNote')?.value.trim() || ''
      },
      ...applicationMetadata('REQUEST-EDIT')
    });
    if (!result.ok) return;
    editingRequest = null;
    closeRequestEditor();
    toast('测试执行字段已保存；原始申请未覆盖');
  };

  const transactionExportApplicationRow = exportApplicationRow;
  exportApplicationRow = function(request) {
    const row = transactionExportApplicationRow(request);
    const execution = executionOf(request);
    row['测试人员'] = execution.tester;
    row['测试费用'] = execution.fee;
    row['测试通道/设备'] = execution.device;
    row['计划开始日期'] = execution.plannedStart;
    row['计划完成日期'] = execution.plannedEnd;
    row['备注'] = execution.note;
    return row;
  };

  async function importParsedApplications(result, label) {
    const parsedRecords = Array.isArray(result.records) ? result.records : [];
    const errors = Array.isArray(result.errors) ? result.errors : [];
    if (!parsedRecords.length) {
      if (errors.length) showImportIssues(`${label}没有可提交记录`, errors);
      toast(errors.length ? '没有有效申请单，请查看异常清单' : '未识别到有效申请单');
      return;
    }
    let strategy = 'abort-on-error';
    if (errors.length > 0) {
      showImportIssues(`${label}发现 ${errors.length} 个异常文件`, errors);
      if (!confirm(`有 ${errors.length} 个文件未通过预检。确定仅提交其余有效申请吗？取消将整批不导入。`)) {
        toast('已取消：整批申请未写入');
        return;
      }
      strategy = 'commit-valid';
    } else {
      clearImportIssues();
    }
    const duplicates = parsedRecords.filter(record => requests.some(item => String(item.id) === String(record.id)));
    const duplicateMode = duplicates.length > 0 && confirm(
      `发现 ${duplicates.length} 条重复申请单。确定覆盖原始版本并保留历史快照；取消则跳过重复项。`
    ) ? 'cover' : 'skip';
    const resultState = await executeApplicationCommand('importRequests', {
      records: parsedRecords,
      errors,
      strategy,
      duplicateMode,
      ...applicationMetadata('REQUEST-IMPORT')
    });
    if (!resultState.ok) return;
    const summary = resultState.state.auditLogs?.[0]?.after || {};
    toast(`${label}完成：新增 ${summary.committed || 0}，覆盖 ${summary.covered || 0}，跳过 ${summary.skipped || 0}`);
  }

  importFormFolder = async function() {
    if (!desktop) return toast('浏览器预览模式不支持批量读取文件夹，请使用便携版 exe');
    const result = await desktop.importFolder();
    if (result.canceled) return;
    if (!result.ok) {
      showImportIssues('批量导入失败', [{ file: '', message: result.message }]);
      return toast(result.message || '读取文件夹失败');
    }
    return importParsedApplications(result, '批量导入');
  };

  importExcel = async function() {
    if (!desktop) return toast('浏览器预览模式不支持直接读取 Excel，请使用便携版 exe');
    const result = await desktop.importExcel();
    if (result.canceled) return;
    if (!result.ok) {
      showImportIssues('单个 Excel 导入失败', [{ file: result.file || '', message: result.message }]);
      return toast(result.message || 'Excel 导入失败');
    }
    return importParsedApplications({ ...result, errors: [] }, '单个 Excel 导入');
  };

  deleteRequest = async function(encoded) {
    const requestNo = decodeURIComponent(encoded || '');
    const request = requests.find(item => String(item.id) === String(requestNo));
    if (!request) return;
    if (!confirm(`确定删除申请单 ${requestNo} 吗？活动引用会由系统再次检查。`)) return;
    const result = await executeApplicationCommand('deleteRequests', {
      requestNos: [requestNo],
      ...applicationMetadata('REQUEST-DELETE')
    });
    if (result.ok) toast('申请单已删除；历史使用记录保留');
  };

  window.deleteSelectedRequests = async function() {
    const chosenRows = selectedRequests();
    if (!chosenRows.length) return toast('请先勾选要删除的申请单');
    if (!confirm(`确定删除选中的 ${chosenRows.length} 条申请单吗？任一活动引用都会阻断整批操作。`)) return;
    const result = await executeApplicationCommand('deleteRequests', {
      requestNos: chosenRows.map(item => String(item.id)),
      ...applicationMetadata('REQUEST-BATCH-DELETE')
    });
    if (result.ok) {
      selectedRequestIds.clear();
      toast(`已删除 ${chosenRows.length} 条申请单；历史使用记录保留`);
    }
  };

  window.saveTester = async function() {
    const name = document.getElementById('tName')?.value.trim() || '';
    if (!name) return toast('请填写测试人员姓名');
    const tester = {
      id: editingTesterId || `T-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
      name,
      dept: document.getElementById('tDept')?.value.trim() || '',
      phone: document.getElementById('tPhone')?.value.trim() || '',
      status: document.getElementById('tStatus')?.value || 'enabled',
      note: document.getElementById('tNote')?.value.trim() || ''
    };
    const result = await executeApplicationCommand('upsertTester', {
      tester,
      ...applicationMetadata('TESTER-SAVE')
    });
    if (!result.ok) return;
    editingTesterId = null;
    closeTesterEditor();
    toast('测试人员已保存');
  };

  window.deleteTester = async function(encoded) {
    const testerId = decodeURIComponent(encoded || '');
    const tester = testers.find(item => String(item.id) === testerId);
    if (!tester || !confirm(`确定删除测试人员 ${tester.name} 吗？历史申请中的姓名不会被清除。`)) return;
    const result = await executeApplicationCommand('deleteTester', {
      testerId,
      ...applicationMetadata('TESTER-DELETE')
    });
    if (result.ok) toast('测试人员已删除；历史姓名保持不变');
  };

  saveDevice = async function() {
    const name = document.getElementById('dName')?.value.trim() || '';
    if (!name) return toast('请填写设备名称');
    const voltage = limitValue(document.getElementById('dVoltage')?.value, '最大电压');
    const current = limitValue(document.getElementById('dCurrent')?.value, '最大电流');
    if (voltage === null || current === null) return;
    const result = await executeApplicationCommand('upsertDevice', {
      device: {
        id: editingDeviceId || `D-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
        name,
        manufacturer: document.getElementById('dManufacturer')?.value.trim() || name.split(/\s+/)[0],
        type: document.getElementById('dType')?.value || '常温',
        tempRange: document.getElementById('dTemp')?.value.trim() || '',
        voltage,
        current,
        status: document.getElementById('dStatus')?.value || 'enabled',
        note: document.getElementById('dNote')?.value.trim() || ''
      },
      ...applicationMetadata('DEVICE-SAVE')
    });
    if (!result.ok) return;
    editingDeviceId = null;
    closeDeviceEditor();
    toast('设备参数已保存');
  };

  deleteDevice = async function(encoded) {
    const deviceId = decodeURIComponent(encoded || '');
    const device = deviceProfiles.find(item => String(item.id) === deviceId);
    if (!device || !confirm(`确定删除设备 ${device.name} 及其空闲通道吗？历史日志会保留。`)) return;
    const result = await executeApplicationCommand('deleteDevice', {
      deviceId,
      ...applicationMetadata('DEVICE-DELETE')
    });
    if (result.ok) toast('设备及空闲通道已删除；历史日志保留');
  };

  window.saveChannel = async function() {
    const deviceName = document.getElementById('cDevice')?.value || '';
    const name = document.getElementById('cName')?.value.trim() || '';
    if (!deviceName || !name) return toast('请选择设备并填写通道号');
    const voltage = limitValue(document.getElementById('cVoltage')?.value, '最大电压');
    const current = limitValue(document.getElementById('cCurrent')?.value, '最大电流');
    if (voltage === null || current === null) return;
    const existing = editingChannelKey ? channels.find(item => item.key === editingChannelKey) : null;
    const statusValue = document.getElementById('cStatus')?.value || '';
    const state = statusValue || existing?.state || 'free';
    const channel = {
      device: deviceName,
      name,
      state,
      type: document.getElementById('cType')?.value || '常温',
      tempRange: document.getElementById('cTemp')?.value.trim() || '',
      voltage,
      current,
      spec: deviceSpec(
        document.getElementById('cType')?.value || '常温',
        document.getElementById('cTemp')?.value.trim() || '',
        voltage,
        current
      ),
      end: document.getElementById('cEnd')?.value || existing?.end || null,
      specialCondition: document.getElementById('cCondition')?.value.trim() || '',
      note: document.getElementById('cNote')?.value.trim() || ''
    };
    const result = await executeApplicationCommand('upsertChannel', {
      channelKey: editingChannelKey || '',
      channel,
      ...applicationMetadata('CHANNEL-SAVE')
    });
    if (!result.ok) return;
    editingChannelKey = null;
    closeChannelEditor();
    toast('通道参数已保存');
  };

  deleteChannel = async function(encoded) {
    const channelKey = decodeURIComponent(encoded || '');
    const channel = channels.find(item => item.key === channelKey);
    if (!channel || !confirm(`确定删除通道 ${channel.device} · ${channel.name} 吗？历史日志会保留。`)) return;
    const result = await executeApplicationCommand('deleteChannel', {
      channelKey,
      ...applicationMetadata('CHANNEL-DELETE')
    });
    if (result.ok) toast('通道已删除；历史日志保留');
  };

  const auditResultModule = import('./src/domain/audit-result.mjs');
  async function persistOperationAudit(result, context) {
    const module = await auditResultModule;
    let entry;
    try {
      entry = module.auditForResult(result, context);
    } catch (error) {
      entry = module.auditForResult({
        ok: false,
        code: error.code || 'AUDIT_RESULT_INVALID',
        message: error.message
      }, context);
    }
    if (!entry) return null;
    auditLogs.unshift(entry);
    try {
      await persist();
      renderAuditTable();
      return entry;
    } catch (error) {
      auditLogs = auditLogs.filter(item => item.id !== entry.id);
      try { adoptApplicationState(await desktop.loadState()); } catch {}
      toast(`操作结果审计保存失败：${error?.message || '未知错误'}`);
      return null;
    }
  }

  async function runExcelExport(payload, auditContext) {
    let result;
    try {
      result = await desktop.exportExcel(payload);
    } catch (error) {
      result = { ok: false, code: error?.code || 'EXCEL_EXPORT_FAILED', message: error?.message || 'Excel 导出失败' };
    }
    const metadata = applicationMetadata('EXCEL-EXPORT');
    await persistOperationAudit(result, {
      id: metadata.auditId,
      actor: metadata.actor,
      now: metadata.now,
      action: auditContext.action,
      target: auditContext.target,
      before: auditContext.before || null,
      after: result.ok ? { ...auditContext.after, file: result.file || '' } : null,
      note: auditContext.note || '系统文件对话框导出'
    });
    return result;
  }

  exportRequests = async function() {
    ensureRequestExportControls();
    const fromDate = document.getElementById('requestExportStartDate')?.value || '';
    const toDate = document.getElementById('requestExportEndDate')?.value || '';
    if (fromDate && toDate && fromDate > toDate) return toast('开始日期不能晚于结束日期');
    const filtered = (fromDate || toDate) ? requests.filter(request => {
      const key = requestDateKey(executionOf(request).plannedEnd);
      return Boolean(key) && (!fromDate || key >= fromDate) && (!toDate || key <= toDate);
    }) : requests;
    if ((fromDate || toDate) && !filtered.length) return toast(`计划完成日期 ${fromDate || '开始'} 至 ${toDate || '结束'} 没有申请表`);
    const rows = filtered.map(exportApplicationRow);
    const items = filtered.map(request => {
      const execution = executionOf(request);
      return {
        系统申请单号: request.id,
        原始文件名: request.sourceFile || '',
        测试序号: 1,
        测试项目: request.test || '',
        样品数量: request.qty || '',
        依据标准: request.rawFields?.['依据标准'] || '',
        工步流程: request.rawFields?.['测试需求说明'] || '',
        判定要求: request.rawFields?.['判定要求'] || '',
        测试人员: execution.tester,
        测试费用: execution.fee,
        测试状态: businessStatusLabel(request.status || 'pending')
      };
    });
    const dateForName = fromDate && toDate ? `${fromDate}至${toDate}` : fromDate ? `${fromDate}起` : toDate ? `${toDate}止` : currentDateKey();
    const defaultFileName = `申请表单汇总_${dateForName}.xlsx`;
    if (!desktop) return exportRowsAsCsv(defaultFileName.replace(/\.xlsx$/i, '.csv'), rows);
    const result = await runExcelExport({
      title: fromDate || toDate ? '导出指定日期范围申请表' : '导出申请表汇总',
      defaultFileName,
      sheets: [{ name: '测试申请表格', rows }, { name: '测试项目明细', rows: items }]
    }, {
      action: '导出申请汇总',
      target: '测试申请数据',
      after: {
        requests: rows.length,
        details: items.length,
        plannedEndFrom: fromDate || '不限',
        plannedEndTo: toDate || '不限'
      },
      note: fromDate || toDate ? '按计划完成日期范围导出' : '导出全部申请表'
    });
    toast(result.ok ? `测试申请汇总 XLSX 已导出：${filtered.length} 条申请表 · ${defaultFileName}` : (result.canceled ? '已取消导出' : (result.message || '导出失败')));
  };

  window.exportSelectedRequests = async function() {
    const chosenRows = selectedRequests();
    if (!chosenRows.length) return toast('请先勾选要导出的申请单');
    const rows = chosenRows.map(exportApplicationRow);
    if (!desktop) return exportRowsAsCsv('选中测试申请汇总.csv', rows);
    const result = await runExcelExport({
      title: '导出选中申请表',
      defaultFileName: `申请表单汇总_${currentDateKey()}.xlsx`,
      sheets: [{ name: '选中申请表格', rows }]
    }, {
      action: '导出选中申请单',
      target: '测试申请数据',
      after: { requests: rows.length }
    });
    toast(result.ok ? `已导出 ${rows.length} 条申请单` : (result.canceled ? '已取消导出' : (result.message || '导出失败')));
  };

  exportRecords = async function() {
    const auditRows = auditLogs.map(item => ({
      日志编号: item.id || '',
      时间: item.time || '',
      等级: String(item.level || 'normal').toUpperCase(),
      结果: item.outcome || item.result || '',
      操作人: item.user || item.actor || '',
      动作: item.action || '',
      对象: item.target || '',
      修改前: JSON.stringify(item.before ?? ''),
      修改后: JSON.stringify(item.after ?? ''),
      备注: item.note || '',
      记录来源: item.source || '软件操作'
    }));
    const recordRows = records.map(item => ({
      申请单号: item.no || item.requestNo || '',
      项目名称: item.project || '',
      测试项目: item.test || '',
      使用通道: item.channels || '',
      状态: businessStatusLabel(item.status || 'pending'),
      预约或开始时间: item.time || item.start || '',
      预计结束时间: item.end || '',
      操作人: item.user || item.actor || '',
      记录来源: item.source || '软件操作',
      备注: item.note || ''
    }));
    const usageRows = typeof buildUsageRows === 'function' ? buildUsageRows() : recordRows;
    const channelRows = channels.map(channel => ({
      设备: channel.device || '',
      通道: channel.name || '',
      量程: channel.spec || '',
      状态: typeof v05IsOverdue === 'function' && v05IsOverdue(channel) ? '已超期' : (channel.state || ''),
      特殊状况: channel.specialCondition || channel.note || '',
      项目: channel.project || '',
      操作人: channel.user || '',
      预计结束: channel.end || '',
      数据来源: '软件看板状态'
    }));
    const defaultFileName = `日志_${currentDateKey()}.xlsx`;
    if (!desktop) return exportRowsAsCsv(defaultFileName.replace(/\.xlsx$/i, '.csv'), auditRows);
    const result = await runExcelExport({
      title: '导出日志',
      defaultFileName,
      sheets: [
        { name: '日志', rows: auditRows },
        { name: '使用记录', rows: recordRows },
        { name: '测试设备使用表2', rows: usageRows },
        { name: '通道当前状态', rows: channelRows }
      ]
    }, {
      action: '导出日志与使用数据',
      target: '日志数据',
      after: { audits: auditRows.length, records: recordRows.length, channels: channelRows.length }
    });
    toast(result.ok ? '真实日志和使用数据已导出' : (result.canceled ? '已取消导出' : (result.message || '导出失败')));
  };

  backupState = async function() {
    if (!desktop || typeof desktop.backupState !== 'function') {
      return toast('浏览器预览模式不支持备份，请使用便携版 exe');
    }
    let result;
    try {
      result = await desktop.backupState();
    } catch (error) {
      result = { ok: false, code: error?.code || 'BACKUP_FAILED', message: error?.message || '备份失败' };
    }
    const metadata = applicationMetadata('STATE-BACKUP');
    await persistOperationAudit(result, {
      id: metadata.auditId,
      actor: metadata.actor,
      now: metadata.now,
      action: '手动备份数据',
      target: '本机 SQLite 看板数据',
      before: { revision: null },
      after: result.ok ? { file: result.file || '', sourceRevision: result.sourceRevision } : null,
      note: '备份包包含 SHA-256，写后重新读取验证'
    });
    toast(result.ok ? '数据备份成功并已校验' : (result.canceled ? '已取消备份' : (result.message || '备份失败')));
  };

  window.restoreState = async function() {
    if (!desktop || typeof desktop.restoreState !== 'function') {
      return toast('浏览器预览模式不支持恢复，请使用便携版 exe');
    }
    if (!confirm('恢复会先生成并校验当前 SQLite 状态备份。确定选择备份包吗？')) return;
    let result;
    try {
      result = await desktop.restoreState({
        actor: document.getElementById('displayUser')?.textContent || 'user001'
      });
    } catch (error) {
      result = { ok: false, code: error?.code || 'RESTORE_FAILED', message: error?.message || '恢复失败' };
    }
    if (result.ok) {
      adoptApplicationState(result.state);
      toast('数据恢复成功；恢复前备份与恢复后 SQLite 均已校验');
      return;
    }
    const metadata = applicationMetadata('STATE-RESTORE-FAILURE');
    await persistOperationAudit(result, {
      id: metadata.auditId,
      actor: metadata.actor,
      now: metadata.now,
      action: '恢复数据备份',
      target: '本机 SQLite 看板数据',
      before: null,
      after: null,
      note: '恢复失败；当前状态保持不变'
    });
    toast(result.canceled ? '已取消恢复' : (result.message || '恢复失败，当前状态未修改'));
  };

  ensureReservationPage();
  ensureRestoreButton();
  ensureTestLogControls();
})();

window.adoptLegacyReservationState = function(state) {
  if (typeof window.adoptLegacyApplicationState === 'function') {
    window.adoptLegacyApplicationState(state);
    return;
  }
  requests = Array.isArray(state?.requests) ? state.requests : [];
  samples = Array.isArray(state?.samples) ? state.samples : [];
  channels = Array.isArray(state?.channels) ? state.channels : [];
  deviceProfiles = Array.isArray(state?.deviceProfiles) ? state.deviceProfiles : [];
  records = Array.isArray(state?.records) ? state.records : [];
  storageRecords = Array.isArray(state?.storageRecords) ? state.storageRecords : [];
  requestSourceRows = Array.isArray(state?.requestSourceRows) ? state.requestSourceRows : [];
  auditLogs = Array.isArray(state?.auditLogs) ? state.auditLogs : [];
  formChangeJournal = Array.isArray(state?.formChangeJournal) ? state.formChangeJournal : [];
  testers = Array.isArray(state?.testers) ? state.testers : [];
  renderBoard();
  renderRecords();
  renderRequestTable();
  renderRequestPick();
  renderDevices();
  if (typeof renderTesters === 'function') renderTesters();
};

window.getLegacyBoundedState = function() {
  return { requests, samples, channels, deviceProfiles, records, storageRecords, auditLogs };
};
