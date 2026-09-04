import { SCENARIOS } from '../scenario-manifest.mjs';
import { createEvidenceRunners } from './evidence-plan.mjs';

const node = (key, file, namePattern, success) => ({ kind: 'node', key, files: [file], namePattern, success });
const edge = (key, probe, success) => ({ kind: 'edge', key, probe, success });
const electron = (key, script, success) => ({ kind: 'electron', key, script, success });

export const P0_EVIDENCE_PLANS = Object.freeze({
  'P0-01': [
    electron('isolated-electron-data-root', 'test:smoke:data-safety', 'Electron 仅操作临时数据根并保持旧 JSON 不变'),
    node('path-write-boundary', 'tests/edge-path-guard.test.mjs', 'write guard permits only real descendants', '写边界拒绝越界和 junction 逃逸')
  ],
  'P0-02': [
    node('baseline-26-529', 'tests/device-preset.test.cjs', 'approved preset is exactly 26 devices and 529 unique free channels', '预设为 26 台设备和 529 个唯一空闲通道'),
    node('default-board-bounded', 'tests/legacy-large-list-render.test.mjs', 'collapsed dashboard renders 26 device summaries without 529 channel cards', '默认看板不渲染 529 张通道卡')
  ],
  'P0-03': [
    node('quantity-1-999', 'tests/legacy-reservation-transactions.test.mjs', 'quantity 1 and 999 create fixed three-digit child identifiers', '数量 1/999 生成连续三位子样品'),
    edge('live-refresh', 'mounted-import-refresh', '已挂载预约页实时采用主进程返回状态')
  ],
  'P0-04': [
    node('invalid-quantity-zero-write', 'tests/legacy-reservation-transactions.test.mjs', 'quantity outside 1..999 and unconfirmed reduction leave the input unchanged', '0、1000、小数和非数字均为零写入阻断')
  ],
  'P0-05': [
    edge('editable-fields', 'reservation-editable-fields', '执行方式、时间和备注可修改且不丢值'),
    node('all-channels-reachable', 'tests/legacy-list-selectors.test.mjs', 'all 529 eligible channels remain reachable through bounded non-overlapping pages', '529 个唯一通道按每页 40 全部可达'),
    node('invalid-batch-zero-write', 'tests/reservation-command-service.test.mjs', 'multi-sample assignment validates the whole batch and persists exactly once', '无效批次整批零写入'),
    node('valid-batch-single-commit', 'tests/reservation-command-service.test.mjs', 'multi-sample assignment validates the whole batch and persists exactly once', '修正后整批只提交一次')
  ],
  'P0-06': [
    node('time-boundaries', 'tests/reservation-policy.test.mjs', 'half-open intervals may touch but not overlap|existing reservations are a hard block|reserve mode warns when', '相邻、重叠和开放结束时间按策略处理')
  ],
  'P0-07': [
    node('legal-state-transitions', 'tests/legacy-reservation-transactions.test.mjs', 'starting a pending sample updates|ending a running record preserves|a booked channel starts|extend and fault recovery enforce', '合法迁移同步更新通道、样品、记录和审计')
  ],
  'P0-08': [
    node('raw-field-isolation', 'tests/legacy-request-transactions.test.mjs', 'editing execution fields never changes imported raw fields or source trace', '执行字段与原始字段及来源证据隔离')
  ],
  'P0-09': [
    node('skip-cover-import', 'tests/legacy-request-transactions.test.mjs', 'duplicate skip preserves|cover import touching active records', '跳过、覆盖和活动引用阻断保持原子性')
  ],
  'P0-10': [
    node('mixed-folder-errors', 'tests/excel-service.test.mjs', 'parseFolder collects nested workbooks, skips lock files and reports all file errors', '混合目录完整列出错误并保留有效项'),
    node('partial-import-choice', 'tests/legacy-request-transactions.test.mjs', 'abort-on-error blocks the whole import while commit-valid', '整批取消或仅提交有效项均为显式选择')
  ],
  'P0-11': [
    node('atomic-request-delete', 'tests/legacy-request-transactions.test.mjs', 'batch delete blocks on any active request and otherwise preserves historical records', '活动引用阻断整批，历史记录保持')
  ],
  'P0-12': [
    node('resource-delete-guards', 'tests/application-command-service.test.mjs', 'active devices and channels block deletion while historical records are retained', '活动设备/通道阻断，历史文字与键保持')
  ],
  'P0-13': [
    node('tester-history-preserved', 'tests/legacy-request-transactions.test.mjs', 'tester upsert rejects duplicate names and deletion never rewrites historical request names', '删除名单不改写历史人员姓名')
  ],
  'P0-14': [
    node('revision-conflict-zero-write', 'tests/legacy-sqlite-store.test.mjs', 'revision conflicts return a structured failure and change no logical state', '旧 revision 明确冲突且零覆盖')
  ],
  'P0-15': [
    node('backup-cancel-failure', 'tests/legacy-backup-service.test.mjs', 'dialog cancellation performs no state load|revision conflict and pre-restore backup failure leave current state unchanged', '取消与失败均不改当前 SQLite')
  ],
  'P0-16': [
    node('verified-backup', 'tests/legacy-backup-service.test.mjs', 'writeLegacyBackupFile atomically writes and re-reads a verified package', '备份格式、revision 和状态哈希写后重读通过')
  ],
  'P0-17': [
    node('tamper-block-before-write', 'tests/legacy-backup-service.test.mjs', 'tampered restore is rejected before pre-backup or current-state mutation', '篡改包在恢复前备份和 SQLite 写入前阻断')
  ],
  'P0-18': [
    node('restore-reopen-consistency', 'tests/legacy-backup-service.test.mjs', 'successful restore preserves current and backup audit histories and verifies database reload', '恢复前备份、历史合并、revision 和重读一致')
  ],
  'P0-19': [
    node('switch-dry-run-zero-write', 'tests/production-switch-service.test.mjs', 'default dry-run reports exact paths and changes no byte or mtime', 'dry-run 报告路径/哈希且字节与 mtime 不变')
  ],
  'P0-20': [
    node('paired-switch-rollback', 'tests/production-switch-service.test.mjs', 'successful apply and paired rollback retain both program/data generations', '隔离副本中程序和 SQLite 成对切换并回滚')
  ],
  'P0-21': [
    node('adopt-returned-state', 'tests/legacy-reservation-workspace.test.mjs', 'successful multi-sample submit sends one batch command and adopts only returned state', '预约工作区只采用主进程返回状态'),
    edge('mounted-page-sync', 'mounted-management-refresh', '打开详情时导入/管理修改立即刷新且无旧快照')
  ]
});

const definitions = SCENARIOS.filter(item => item.group === 'P0');
export const P0_RUNNERS = createEvidenceRunners(definitions, P0_EVIDENCE_PLANS);
