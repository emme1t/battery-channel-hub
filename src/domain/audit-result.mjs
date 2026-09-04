const OMITTED_COLLECTION_KEYS = new Set([
  'rows', 'sheets', 'workbook', 'content', 'contents', 'fileContent', 'excelContent'
]);
const RAW_FIELD_KEYS = new Set(['rawFields', 'original', 'originalFields']);
const SENSITIVE_KEY_PATTERN = /token|secret|password|credential|身份证|手机号|联系电话|联系方式|phone/i;

function auditError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function sanitizeErrors(errors) {
  return errors.slice(0, 50).map(item => ({
    file: String(item?.file || ''),
    code: String(item?.code || ''),
    message: String(item?.message || '')
  }));
}

function sanitize(value, key = '', depth = 0) {
  if (RAW_FIELD_KEYS.has(key)) return '[原始申请字段已省略]';
  if (SENSITIVE_KEY_PATTERN.test(key)) return '[已脱敏]';
  if (value === null || value === undefined) return value;
  if (typeof value !== 'object') return value;
  if (depth >= 4) return '[嵌套内容已省略]';
  if (Array.isArray(value)) {
    if (key === 'errors') return sanitizeErrors(value);
    return `[已省略 ${value.length} 项]`;
  }
  const result = {};
  for (const [childKey, childValue] of Object.entries(value).slice(0, 40)) {
    if (OMITTED_COLLECTION_KEYS.has(childKey) && Array.isArray(childValue)) {
      result[childKey] = `[已省略 ${childValue.length} 项]`;
    } else {
      result[childKey] = sanitize(childValue, childKey, depth + 1);
    }
  }
  return result;
}

function requireContext(context) {
  if (!context || typeof context !== 'object') throw auditError('AUDIT_CONTEXT_REQUIRED', '缺少审计上下文');
  const required = ['id', 'actor', 'now', 'action', 'target'];
  for (const field of required) {
    if (typeof context[field] !== 'string' || context[field].trim() === '') {
      throw auditError('AUDIT_CONTEXT_INVALID', `审计字段 ${field} 不能为空`);
    }
  }
  if (!Number.isFinite(Date.parse(context.now))) throw auditError('AUDIT_TIME_INVALID', '审计时间无效');
}

function makeAudit(context, outcome, options = {}) {
  requireContext(context);
  return {
    id: context.id,
    time: context.now,
    at: context.now,
    user: context.actor,
    actor: context.actor,
    action: context.action,
    target: context.target,
    outcome,
    result: outcome,
    level: outcome === 'success' ? 'normal' : 'warning',
    verified: outcome === 'success' || outcome === 'warning',
    before: sanitize(context.before ?? null, 'before'),
    after: sanitize(options.after ?? context.after ?? null, 'after'),
    code: String(options.code ?? context.code ?? ''),
    note: String(options.note ?? context.note ?? '')
  };
}

export function successAudit(context) {
  return makeAudit(context, 'success');
}

export function failureAudit(context) {
  const code = String(context?.code || 'OPERATION_FAILED');
  const message = String(context?.message || '操作失败');
  return makeAudit(context, 'failure', {
    code,
    after: { code, message },
    note: context?.note || message
  });
}

export function warningAudit(context) {
  return makeAudit(context, 'warning');
}

export function auditForResult(result, context) {
  if (result?.canceled === true) return null;
  if (!result || result.ok !== true) {
    return failureAudit({
      ...context,
      code: String(result?.code || 'OPERATION_FAILED'),
      message: String(result?.message || '操作失败')
    });
  }
  if (result.verified !== true) {
    throw auditError('SUCCESS_NOT_VERIFIED', '操作未通过写后校验，不能记录成功审计');
  }
  if (result.warning === true || result.level === 'warning') {
    return warningAudit({ ...context, code: result.code || context?.code || '' });
  }
  return successAudit(context);
}

export function sanitizeAuditSnapshot(value) {
  return sanitize(value, 'snapshot');
}
