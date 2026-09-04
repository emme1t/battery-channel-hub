import assert from 'node:assert/strict';
import test from 'node:test';

import {
  auditForResult,
  failureAudit,
  successAudit,
  warningAudit
} from '../src/domain/audit-result.mjs';

const context = {
  id: 'AUDIT-001',
  actor: 'admin',
  now: '2026-08-20T15:00:00-07:00',
  action: '导出申请单',
  target: '测试申请数据',
  before: { count: 2 },
  after: { count: 2, file: 'C:\\exports\\requests.xlsx' },
  note: '系统文件对话框'
};

test('cancellation returns no audit and verified success has normalized semantics', () => {
  assert.equal(auditForResult({ canceled: true }, context), null);
  const entry = auditForResult({ ok: true, verified: true, file: 'C:\\exports\\requests.xlsx' }, context);
  assert.equal(entry.outcome, 'success');
  assert.equal(entry.result, 'success');
  assert.equal(entry.level, 'normal');
  assert.equal(entry.verified, true);
  assert.equal(entry.id, 'AUDIT-001');
});

test('unverified success is rejected and failure is never mislabeled success', () => {
  assert.throws(
    () => auditForResult({ ok: true, verified: false }, context),
    error => error.code === 'SUCCESS_NOT_VERIFIED'
  );
  const entry = auditForResult({ ok: false, code: 'WRITE_FAILED', message: '磁盘写入失败' }, context);
  assert.equal(entry.outcome, 'failure');
  assert.equal(entry.result, 'failure');
  assert.equal(entry.level, 'warning');
  assert.deepEqual(entry.after, { code: 'WRITE_FAILED', message: '磁盘写入失败' });
});

test('warning result and direct builders share the same required fields', () => {
  const warning = auditForResult({ ok: true, verified: true, warning: true, code: 'PARTIAL_IMPORT' }, context);
  assert.equal(warning.outcome, 'warning');
  assert.equal(warning.level, 'warning');
  for (const entry of [
    successAudit(context),
    failureAudit({ ...context, code: 'FAILED', message: '失败' }),
    warningAudit(context)
  ]) {
    assert.equal(entry.id, context.id);
    assert.equal(entry.actor, 'admin');
    assert.equal(entry.user, 'admin');
    assert.equal(entry.time, context.now);
    assert.equal(entry.action, context.action);
    assert.equal(entry.target, context.target);
  }
});

test('audit snapshots retain summaries but redact workbook content and private fields', () => {
  const entry = successAudit({
    ...context,
    before: {
      count: 1,
      rows: [{ 委托单号: 'REQ-001', 身份证号: 'SECRET-ID' }],
      rawFields: { 申请人: '张三', 联系方式: '13800000000' },
      token: 'SECRET-TOKEN'
    },
    after: {
      count: 1,
      errors: [{ file: 'bad.xlsx', code: 'BROKEN', message: '损坏' }]
    }
  });
  assert.deepEqual(entry.before, {
    count: 1,
    rows: '[已省略 1 项]',
    rawFields: '[原始申请字段已省略]',
    token: '[已脱敏]'
  });
  assert.deepEqual(entry.after, {
    count: 1,
    errors: [{ file: 'bad.xlsx', code: 'BROKEN', message: '损坏' }]
  });
  assert.equal(JSON.stringify(entry).includes('SECRET-ID'), false);
  assert.equal(JSON.stringify(entry).includes('13800000000'), false);
  assert.equal(JSON.stringify(entry).includes('SECRET-TOKEN'), false);
});
