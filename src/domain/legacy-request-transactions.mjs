import { sampleId } from './sample-quantity.mjs';
import { isDeepStrictEqual } from 'node:util';

const EXECUTION_FIELDS = new Set([
  'tester',
  'fee',
  'device',
  'plannedStart',
  'plannedEnd',
  'note'
]);

const ACTIVE_RECORD_STATUSES = new Set(['reserved', 'running']);

const ACTIVE_SAMPLE_STATUSES = new Set(['reserved', 'running']);

const ACTIVE_STORAGE_STATUSES = new Set(['storing', 'exception']);

function domainError(code, message, details = undefined) {
  const error = new Error(message);
  error.code = code;
  if (details !== undefined) error.details = details;
  return error;
}

function requireState(state) {
  if (!state || typeof state !== 'object' || Array.isArray(state)) {
    throw domainError('STATE_REQUIRED', '缺少 legacy 状态');
  }
  for (const name of [
    'requests', 'samples', 'records', 'storageRecords', 'requestSourceRows',
    'auditLogs', 'formChangeJournal', 'testers'
  ]) {
    if (!Array.isArray(state[name])) {
      throw domainError('STATE_COLLECTION_INVALID', `状态集合 ${name} 无效`, { collection: name });
    }
  }
}

function requireText(value, field, label) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw domainError('COMMAND_FIELD_REQUIRED', `${label}不能为空`, { field });
  }
  return value.trim();
}

function requireMetadata(state, command, { journal = false } = {}) {
  const actor = requireText(command?.actor, 'actor', '操作者');
  const auditId = requireText(command?.auditId, 'auditId', '审计标识');
  const now = requireText(command?.now, 'now', '操作时间');
  if (!Number.isFinite(Date.parse(now))) {
    throw domainError('COMMAND_TIME_INVALID', '操作时间无效');
  }
  if (state.auditLogs.some(item => String(item?.id || '') === auditId)) {
    throw domainError('IDENTIFIER_ALREADY_EXISTS', '审计标识已存在', { id: auditId });
  }

  let journalId = '';
  if (journal) {
    journalId = requireText(command?.journalId, 'journalId', '变更记录标识');
    if (state.formChangeJournal.some(item => String(item?.id || '') === journalId)) {
      throw domainError('IDENTIFIER_ALREADY_EXISTS', '变更记录标识已存在', { id: journalId });
    }
  }
  return { actor, auditId, journalId, now };
}

function requestNumber(request) {
  return String(request?.id ?? request?.requestNo ?? '').trim();
}

function requestQuantity(request) {
  return Number(request?.qty ?? request?.quantity);
}

function recordRequestNumber(record) {
  return String(record?.requestNo ?? record?.no ?? '').trim();
}

function recordStatus(record) {
  return String(record?.status || '').trim();
}

function findRequest(state, requestNo) {
  const id = String(requestNo || '').trim();
  const request = state.requests.find(item => requestNumber(item) === id);
  if (!request) throw domainError('REQUEST_NOT_FOUND', `申请不存在：${id || '(空)'}`);
  return request;
}

function executionFields(request) {
  const current = request?.execution && typeof request.execution === 'object'
    ? request.execution
    : {};
  return {
    tester: current.tester ?? request?.tester ?? '',
    fee: current.fee ?? request?.fee ?? '',
    device: current.device ?? request?.device ?? '',
    plannedStart: current.plannedStart ?? request?.plannedStart ?? request?.startDate ?? '',
    plannedEnd: current.plannedEnd ?? request?.plannedEnd ?? request?.end ?? '',
    note: current.note ?? request?.note ?? ''
  };
}

export function executionView(request) {
  const view = structuredClone(request || {});
  const execution = executionFields(view);
  return {
    ...view,
    execution,
    tester: execution.tester,
    fee: execution.fee,
    device: execution.device,
    plannedStart: execution.plannedStart,
    plannedEnd: execution.plannedEnd,
    startDate: execution.plannedStart,
    end: execution.plannedEnd,
    note: execution.note
  };
}

function sourceTrace(request) {
  return {
    sourceFile: String(request?.sourceFile || ''),
    sourcePath: String(request?.sourcePath || '')
  };
}

function auditEntry(metadata, action, target, before, after, options = {}) {
  const outcome = options.level === 'warning' ? 'warning' : 'success';
  return {
    id: metadata.auditId,
    time: metadata.now,
    at: metadata.now,
    user: metadata.actor,
    actor: metadata.actor,
    action,
    target,
    outcome,
    result: outcome,
    verified: true,
    level: options.level || 'normal',
    before: structuredClone(before),
    after: structuredClone(after),
    note: options.note || ''
  };
}

export function editExecutionFields(state, command) {
  requireState(state);
  if (!command || typeof command !== 'object' || !command.fields || typeof command.fields !== 'object') {
    throw domainError('COMMAND_REQUIRED', '缺少申请执行字段修改命令');
  }
  const fieldNames = Object.keys(command.fields);
  const unsupported = fieldNames.filter(name => !EXECUTION_FIELDS.has(name));
  if (unsupported.length > 0) {
    throw domainError('EXECUTION_FIELD_UNSUPPORTED', `不允许修改原始申请字段：${unsupported.join('、')}`, {
      fields: unsupported
    });
  }
  if (fieldNames.length === 0) throw domainError('EXECUTION_FIELDS_REQUIRED', '至少修改一个执行字段');

  const request = findRequest(state, command.requestNo);
  const metadata = requireMetadata(state, command, { journal: true });
  const before = executionFields(request);
  const after = { ...before };
  for (const field of fieldNames) after[field] = structuredClone(command.fields[field]);
  if (isDeepStrictEqual(after, before)) {
    throw domainError('EXECUTION_FIELDS_UNCHANGED', '执行字段未发生变化');
  }

  const next = structuredClone(state);
  const nextRequest = findRequest(next, command.requestNo);
  nextRequest.execution = after;
  next.formChangeJournal.push({
    id: metadata.journalId,
    requestId: requestNumber(request),
    requestNo: requestNumber(request),
    action: '修改申请执行字段',
    time: metadata.now,
    user: metadata.actor,
    actor: metadata.actor,
    before: structuredClone(before),
    after: structuredClone(after),
    source: sourceTrace(request),
    level: 'warning',
    note: '执行字段修改；原始申请未覆盖'
  });
  next.auditLogs.unshift(auditEntry(
    metadata,
    '修改申请执行字段',
    `申请单 ${requestNumber(request)}`,
    before,
    after,
    { level: 'warning', note: '原始导入字段及来源追溯保持不变' }
  ));
  return next;
}

function normalizeImportRecord(record) {
  const source = record?.normalized && typeof record.normalized === 'object'
    ? { ...record, ...record.normalized }
    : record;
  const id = requestNumber(source);
  const quantity = requestQuantity(source);
  if (!id) throw domainError('REQUEST_NUMBER_REQUIRED', '导入记录缺少申请单号');
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 999) {
    throw domainError('QUANTITY_INVALID', `申请 ${id} 的样品数量必须是 1–999 的整数`, { requestNo: id });
  }

  const normalized = structuredClone(source);
  normalized.id = id;
  normalized.qty = quantity;
  if (Object.hasOwn(normalized, 'requestNo')) normalized.requestNo = id;
  if (Object.hasOwn(normalized, 'quantity')) normalized.quantity = quantity;
  normalized.rawFields = structuredClone(record?.rawFields ?? record?.fields ?? source?.rawFields ?? {});
  normalized.sourceFile = String(record?.sourceFile ?? source?.sourceFile ?? '');
  normalized.sourcePath = String(record?.sourcePath ?? source?.sourcePath ?? '');
  normalized.execution = executionFields(source);
  delete normalized.normalized;
  delete normalized.fields;
  return normalized;
}

function importValidation(records, suppliedErrors) {
  const valid = [];
  const errors = structuredClone(Array.isArray(suppliedErrors) ? suppliedErrors : []);
  const seen = new Set();
  for (const [index, record] of (Array.isArray(records) ? records : []).entries()) {
    try {
      const normalized = normalizeImportRecord(record);
      if (seen.has(normalized.id)) {
        errors.push({
          index,
          requestNo: normalized.id,
          code: 'DUPLICATE_REQUEST_IN_IMPORT',
          message: `同一批次重复申请单号：${normalized.id}`
        });
      } else {
        seen.add(normalized.id);
        valid.push(normalized);
      }
    } catch (error) {
      errors.push({
        index,
        code: error.code || 'IMPORT_RECORD_INVALID',
        message: error.message
      });
    }
  }
  return { valid, errors };
}

function requestHasActiveReference(state, requestNo) {
  return state.records.some(record =>
    recordRequestNumber(record) === requestNo && ACTIVE_RECORD_STATUSES.has(recordStatus(record))
  ) || state.storageRecords.some(record =>
    String(record?.requestNo || '').trim() === requestNo &&
    ACTIVE_STORAGE_STATUSES.has(String(record?.status || '').trim())
  );
}

function requestSamples(state, requestNo) {
  return state.samples.filter(sample => String(sample?.requestNo || '') === requestNo);
}

export function recomputeLegacyRequestStatus(state, requestNo) {
  const normalized = String(requestNo || '');
  const request = state.requests.find(item => requestNumber(item) === normalized);
  if (!request) return;
  const samples = requestSamples(state, normalized);
  const pendingCount = samples.filter(sample => sample?.status === 'pending').length;
  request.status = pendingCount === samples.length && pendingCount > 0
    ? 'pending'
    : pendingCount > 0
      ? 'partially_assigned'
      : 'assigned';
}

function hasHistoricalSamples(state, requestNo) {
  return requestSamples(state, requestNo).some(sample =>
    sample?.hasHistory === true || String(sample?.status || '') !== 'pending'
  );
}

function buildSamples(requestNo, quantity) {
  return Array.from({ length: quantity }, (_, index) => ({
    id: sampleId(requestNo, index + 1),
    requestNo,
    ordinal: index + 1,
    status: 'pending',
    channelKey: '',
    start: '',
    end: '',
    hasHistory: false
  }));
}

function replaceRequestSamples(next, requestNo, quantity) {
  const firstIndex = next.samples.findIndex(sample => String(sample?.requestNo || '') === requestNo);
  next.samples = next.samples.filter(sample => String(sample?.requestNo || '') !== requestNo);
  next.samples.splice(firstIndex < 0 ? next.samples.length : firstIndex, 0, ...buildSamples(requestNo, quantity));
}

function replaceSourceRow(next, request) {
  const id = requestNumber(request);
  next.requestSourceRows = next.requestSourceRows.filter(row => requestNumber(row) !== id);
  next.requestSourceRows.push({
    id,
    requestNo: id,
    sourceFile: request.sourceFile,
    sourcePath: request.sourcePath,
    rawFields: structuredClone(request.rawFields)
  });
}

function coverJournal(metadata, requestNo, index, before, after) {
  return {
    id: index === 0 ? metadata.journalId : `${metadata.journalId}-${index + 1}`,
    requestId: requestNo,
    requestNo,
    action: '覆盖导入申请原始字段',
    time: metadata.now,
    user: metadata.actor,
    actor: metadata.actor,
    before: {
      rawFields: structuredClone(before.rawFields),
      ...sourceTrace(before)
    },
    after: {
      rawFields: structuredClone(after.rawFields),
      ...sourceTrace(after)
    },
    source: sourceTrace(after),
    level: 'warning',
    note: '旧原始字段已写入 rawHistory；执行字段保持不变'
  };
}

export function importRequests(state, command) {
  requireState(state);
  if (!command || typeof command !== 'object' || !Array.isArray(command.records)) {
    throw domainError('COMMAND_REQUIRED', '缺少申请导入命令');
  }
  if (!['abort-on-error', 'commit-valid'].includes(command.strategy)) {
    throw domainError('IMPORT_STRATEGY_INVALID', '导入策略必须是 abort-on-error 或 commit-valid');
  }
  if (!['skip', 'cover'].includes(command.duplicateMode)) {
    throw domainError('DUPLICATE_MODE_INVALID', '重复申请处理方式必须是 skip 或 cover');
  }

  const { valid, errors } = importValidation(command.records, command.errors);
  if (command.strategy === 'abort-on-error' && errors.length > 0) {
    throw domainError('IMPORT_ERRORS_BLOCK', '导入文件存在错误，整批未写入', { errors });
  }

  const existingById = new Map(state.requests.map(item => [requestNumber(item), item]));
  const covers = valid.filter(item => existingById.has(item.id) && command.duplicateMode === 'cover');
  for (const incoming of covers) {
    const existing = existingById.get(incoming.id);
    if (requestHasActiveReference(state, incoming.id)) {
      throw domainError('REQUEST_ACTIVE_REFERENCE_BLOCK', `申请 ${incoming.id} 存在活动记录，整批导入已阻断`);
    }
    if (requestQuantity(existing) !== incoming.qty && hasHistoricalSamples(state, incoming.id)) {
      throw domainError('SAMPLE_HISTORY_BLOCK', `申请 ${incoming.id} 的数量变化会触及活动或历史子样品`);
    }
  }

  const metadata = requireMetadata(state, command, { journal: covers.length > 0 });
  if (covers.length > 1) {
    for (let index = 1; index < covers.length; index += 1) {
      const id = `${metadata.journalId}-${index + 1}`;
      if (state.formChangeJournal.some(item => String(item?.id || '') === id)) {
        throw domainError('IDENTIFIER_ALREADY_EXISTS', '派生变更记录标识已存在', { id });
      }
    }
  }

  const next = structuredClone(state);
  let committed = 0;
  let skipped = 0;
  let covered = 0;
  for (const incoming of valid) {
    const requestIndex = next.requests.findIndex(item => requestNumber(item) === incoming.id);
    if (requestIndex < 0) {
      next.requests.push(incoming);
      next.samples.push(...buildSamples(incoming.id, incoming.qty));
      replaceSourceRow(next, incoming);
      committed += 1;
      continue;
    }
    if (command.duplicateMode === 'skip') {
      skipped += 1;
      continue;
    }

    const before = structuredClone(next.requests[requestIndex]);
    const history = Array.isArray(before.rawHistory) ? structuredClone(before.rawHistory) : [];
    history.push({
      rawFields: structuredClone(before.rawFields ?? {}),
      ...sourceTrace(before),
      replacedAt: metadata.now
    });
    const replacement = {
      ...incoming,
      execution: executionFields(before),
      rawHistory: history
    };
    next.requests[requestIndex] = replacement;
    if (requestQuantity(before) !== incoming.qty) replaceRequestSamples(next, incoming.id, incoming.qty);
    replaceSourceRow(next, replacement);
    next.formChangeJournal.push(coverJournal(metadata, incoming.id, covered, before, replacement));
    covered += 1;
  }

  const summary = { committed, skipped, covered, errors };
  next.auditLogs.unshift(auditEntry(
    metadata,
    '导入申请单',
    `申请单批次（${valid.length} 条有效）`,
    { strategy: command.strategy, duplicateMode: command.duplicateMode },
    summary,
    {
      level: errors.length > 0 || skipped > 0 || covered > 0 ? 'warning' : 'normal',
      note: errors.length > 0 ? '部分文件失败；仅提交已通过预检的记录' : ''
    }
  ));
  return next;
}

export function deleteRequests(state, command) {
  requireState(state);
  if (!command || typeof command !== 'object' || !Array.isArray(command.requestNos)) {
    throw domainError('COMMAND_REQUIRED', '缺少批量删除申请命令');
  }
  const requestNos = [...new Set(command.requestNos.map(value => String(value || '').trim()).filter(Boolean))];
  if (requestNos.length === 0) throw domainError('REQUEST_SELECTION_REQUIRED', '至少选择一条申请');
  for (const requestNo of requestNos) findRequest(state, requestNo);

  const blocked = requestNos.filter(requestNo =>
    requestHasActiveReference(state, requestNo) ||
    requestSamples(state, requestNo).some(sample => ACTIVE_SAMPLE_STATUSES.has(String(sample?.status || '')))
  );
  if (blocked.length > 0) {
    throw domainError('REQUEST_ACTIVE_REFERENCE_BLOCK', '所选申请包含活动记录，整批删除已阻断', { requestNos: blocked });
  }

  const metadata = requireMetadata(state, command);
  const selected = new Set(requestNos);
  const next = structuredClone(state);
  next.requests = next.requests.filter(item => !selected.has(requestNumber(item)));
  next.samples = next.samples.filter(item => !selected.has(String(item?.requestNo || '')));
  next.requestSourceRows = next.requestSourceRows.filter(item => !selected.has(requestNumber(item)));
  next.auditLogs.unshift(auditEntry(
    metadata,
    '批量删除申请单',
    requestNos.join('、'),
    { requestNos },
    { deleted: requestNos.length, historicalRecordsPreserved: true },
    { level: 'warning', note: '历史使用记录保留' }
  ));
  return next;
}

function normalizedTesterName(value) {
  return String(value || '').trim().toLocaleLowerCase('zh-CN');
}

export function upsertTester(state, command) {
  requireState(state);
  if (!command || typeof command !== 'object' || !command.tester || typeof command.tester !== 'object') {
    throw domainError('COMMAND_REQUIRED', '缺少测试人员保存命令');
  }
  const tester = structuredClone(command.tester);
  tester.id = requireText(tester.id, 'tester.id', '测试人员标识');
  tester.name = requireText(tester.name, 'tester.name', '测试人员姓名');
  if (state.testers.some(item =>
    String(item?.id || '') !== tester.id && normalizedTesterName(item?.name) === normalizedTesterName(tester.name)
  )) {
    throw domainError('TESTER_NAME_DUPLICATE', `测试人员姓名重复：${tester.name}`);
  }
  const metadata = requireMetadata(state, command);
  const index = state.testers.findIndex(item => String(item?.id || '') === tester.id);
  const before = index >= 0 ? structuredClone(state.testers[index]) : null;
  const next = structuredClone(state);
  if (index >= 0) next.testers[index] = tester;
  else next.testers.push(tester);
  next.auditLogs.unshift(auditEntry(
    metadata,
    index >= 0 ? '修改测试人员' : '新增测试人员',
    `测试人员 ${tester.name}`,
    before,
    tester,
    { level: index >= 0 ? 'warning' : 'normal' }
  ));
  return next;
}

export function deleteTester(state, command) {
  requireState(state);
  if (!command || typeof command !== 'object') {
    throw domainError('COMMAND_REQUIRED', '缺少测试人员删除命令');
  }
  const testerId = requireText(command.testerId, 'testerId', '测试人员标识');
  const tester = state.testers.find(item => String(item?.id || '') === testerId);
  if (!tester) throw domainError('TESTER_NOT_FOUND', `测试人员不存在：${testerId}`);
  const metadata = requireMetadata(state, command);
  const next = structuredClone(state);
  next.testers = next.testers.filter(item => String(item?.id || '') !== testerId);
  next.auditLogs.unshift(auditEntry(
    metadata,
    '删除测试人员',
    `测试人员 ${tester.name || testerId}`,
    tester,
    { deleted: true, requestNamesPreserved: true },
    { level: 'warning', note: '历史申请和使用记录中的人员姓名保持不变' }
  ));
  return next;
}
