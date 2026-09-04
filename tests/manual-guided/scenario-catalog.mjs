import { normalizeManualScenario } from './contracts.mjs';

const QUICK_IDS = Object.freeze(['A01', 'B01', 'C01', 'D01', 'E04', 'F01', 'G01']);

function action(scenarioId, suffix, type, expect = 'success', params = {}) {
  return Object.freeze({
    id: `${scenarioId}-${suffix}`,
    type,
    expect,
    params: Object.freeze(params)
  });
}

function scenario({
  id,
  title,
  risk,
  manualSection,
  dataIds = [],
  visiblePrecondition,
  actions,
  oracleRule,
  recovery,
  compressed = false,
  maximumDurationMs = 120_000
}) {
  const normalized = normalizeManualScenario({
    id,
    title,
    risk,
    manualSection,
    dataIds: Object.freeze([...dataIds]),
    visiblePrecondition,
    actions,
    allowedVisibleOutcomes: Object.freeze([...new Set(actions.map(item => item.expect))]),
    oracleRule,
    recovery,
    compressed,
    maximumDurationMs
  });
  return Object.freeze(normalized);
}

const safety = '每个可见动作后重开 SQLite 只读快照并核验完整性、归属和通道安全';
const zeroWriteRecovery = '拒绝或取消后核验零业务写入，并在同一会话继续既定目标';

export const MANUAL_SCENARIOS = Object.freeze([
  scenario({
    id: 'A01', title: '首次使用与规定导航', risk: 'P0', manualSection: '使用说明 §2-3',
    visiblePrecondition: '指定 packaged EXE 显示登录页且隔离数据为空',
    actions: [
      action('A01', 'login', 'login', 'success'),
      action('A01', 'devices', 'navigate', 'success', { label: '设备与通道' }),
      action('A01', 'testers', 'navigate', 'success', { label: '测试人员' }),
      action('A01', 'requests', 'navigate', 'success', { label: '测试申请表格' })
    ],
    oracleRule: safety,
    recovery: '导航失败时保留当前页截图并从仍可见的侧栏继续'
  }),
  scenario({
    id: 'A02', title: '空用户名回退与有效登录', risk: 'P1', manualSection: '使用说明 §2',
    visiblePrecondition: '登录页可见且没有业务数据',
    actions: [
      action('A02', 'blank', 'login', 'rejected', { username: '' }),
      action('A02', 'spaces', 'login', 'rejected', { username: '   ' }),
      action('A02', 'recover', 'login', 'success')
    ],
    oracleRule: '两次拒绝均为零业务写入；有效登录后核验只增加规定审计',
    recovery: zeroWriteRecovery
  }),
  scenario({
    id: 'B01', title: '纵向申请单 GUI 导入', risk: 'P0', manualSection: '使用说明 §4.1-4.3',
    dataIds: ['normal-vertical-1'], visiblePrecondition: '已登录并位于测试申请表格',
    actions: [action('B01', 'import-vertical', 'importFile', 'success', { dataId: 'normal-vertical-1' })],
    oracleRule: '导入后申请来源存在且子样品按三位序号生成', recovery: zeroWriteRecovery
  }),
  scenario({
    id: 'B02', title: '横向 XLSX、真实 XLS 与 CSV 导入', risk: 'P0', manualSection: '使用说明 §4.1-4.3',
    dataIds: ['normal-horizontal-3', 'normal-xls-2', 'normal-csv-4'], visiblePrecondition: '测试申请表格可见',
    actions: [
      action('B02', 'xlsx', 'importFile', 'success', { dataId: 'normal-horizontal-3' }),
      action('B02', 'xls', 'importFile', 'success', { dataId: 'normal-xls-2' }),
      action('B02', 'csv', 'importFile', 'success', { dataId: 'normal-csv-4' })
    ],
    oracleRule: safety, recovery: zeroWriteRecovery
  }),
  scenario({
    id: 'B03', title: '300 份纵向单表递归导入与汇总', risk: 'P0', manualSection: '使用说明 §4.1-4.2',
    dataIds: ['folder-vertical-300'], visiblePrecondition: '测试申请表格可见且当前申请数量已记录',
    actions: [action('B03', 'folder', 'importFolder', 'success', { dataId: 'folder-vertical-300' })],
    oracleRule: '新增 300 条申请，GUI 汇总包含全部申请单号，重启后仍完整存在', recovery: zeroWriteRecovery
  }),
  scenario({
    id: 'B04', title: '数量与申请单号异常回退', risk: 'P0', manualSection: '使用说明 §4.2、§11.1',
    dataIds: ['quantity-blank', 'quantity-0', 'quantity-1000', 'quantity-decimal', 'quantity-text', 'quantity-spaces', 'request-number-missing', 'request-number-duplicate', 'request-number-conflict'],
    visiblePrecondition: '测试申请表格可见且 prior valid request 可重新找到',
    actions: [
      action('B04', 'quantity-zero', 'importFile', 'rejected', { dataId: 'quantity-0' }),
      action('B04', 'quantity-1000', 'importFile', 'rejected', { dataId: 'quantity-1000' }),
      action('B04', 'number-missing', 'importFile', 'rejected', { dataId: 'request-number-missing' }),
      action('B04', 'number-conflict', 'importFile', 'rejected', { dataId: 'request-number-conflict' })
    ],
    oracleRule: '所有拒绝动作零业务写入且 prior valid request 集合哈希不变', recovery: zeroWriteRecovery
  }),
  scenario({
    id: 'B05', title: '格式、大小与行数边界', risk: 'P0', manualSection: '使用说明 §4.1、§11.3',
    dataIds: ['damaged-xlsx', 'fake-extension', 'blank-workbook', 'file-under-25mb', 'file-over-25mb', 'sheet-50000', 'sheet-50001'],
    visiblePrecondition: '测试申请表格可见且 prior valid request 可重新找到',
    actions: [
      action('B05', 'damaged', 'importFile', 'rejected', { dataId: 'damaged-xlsx' }),
      action('B05', 'over-size', 'importFile', 'rejected', { dataId: 'file-over-25mb' }),
      action('B05', 'over-rows', 'importFile', 'rejected', { dataId: 'sheet-50001' })
    ],
    oracleRule: '拒绝边界零业务写入，允许边界按使用说明写入', recovery: zeroWriteRecovery,
    maximumDurationMs: 300_000
  }),
  scenario({
    id: 'C01', title: '立即开始并结束普通测试', risk: 'P0', manualSection: '使用说明 §5.1、§5.3',
    dataIds: ['normal-vertical-1'], visiblePrecondition: '申请、测试人员、设备与空闲通道已通过 GUI 建立',
    actions: [
      action('C01', 'apply', 'navigate', 'success', { label: '开始/预约测试' }),
      action('C01', 'request', 'selectRequest'),
      action('C01', 'samples', 'selectSamples'),
      action('C01', 'channels', 'assignChannels'),
      action('C01', 'start', 'startImmediately'),
      action('C01', 'running', 'navigate', 'success', { label: '正在测试样品' }),
      action('C01', 'finish', 'finishRunning')
    ],
    oracleRule: '运行阶段样品和通道唯一归属；结束后通道释放并保留审计', recovery: '失败时从正在测试样品或日志页继续',
    compressed: true, maximumDurationMs: 180_000
  }),
  scenario({
    id: 'C02', title: '预约、开始并结束普通测试', risk: 'P0', manualSection: '使用说明 §5.1-5.2',
    dataIds: ['normal-horizontal-3'], visiblePrecondition: '存在未处理子样品和空闲通道',
    actions: [action('C02', 'reserve', 'reserve'), action('C02', 'start', 'startReserved'), action('C02', 'finish', 'finishRunning')],
    oracleRule: safety, recovery: '从已预约表单处理或正在测试样品继续', compressed: true
  }),
  scenario({
    id: 'C03', title: '运行中与预约退回申请', risk: 'P0', manualSection: '使用说明 §5.2-5.3',
    dataIds: ['normal-horizontal-3'], visiblePrecondition: '分别存在一条运行和预约记录',
    actions: [action('C03', 'return-running', 'returnRunning'), action('C03', 'return-reserved', 'returnRunning')],
    oracleRule: '退回后样品可重新处理且通道释放，原因和审计保留', recovery: '从申请详情确认回退结果', compressed: true
  }),
  scenario({
    id: 'C04', title: '多样品混合普通测试', risk: 'P1', manualSection: '使用说明 §4.3、§5',
    dataIds: ['normal-quantity-3'], visiblePrecondition: '同一申请至少三个子样品且有三个独立空闲通道',
    actions: [action('C04', 'samples', 'selectSamples'), action('C04', 'channels', 'assignChannels'), action('C04', 'start', 'startImmediately')],
    oracleRule: '每个子样品和通道一一对应且重启后保持', recovery: '失败时撤销当前选择后重新分配', compressed: true
  }),
  scenario({
    id: 'D01', title: '开始并结束不占通道的长期存储', risk: 'P0', manualSection: '使用说明 §6',
    dataIds: ['normal-horizontal-3'], visiblePrecondition: '存在未处理子样品和负责人',
    actions: [action('D01', 'storage-page', 'navigate', 'success', { label: '长期存储样品' }), action('D01', 'start', 'startStorage'), action('D01', 'finish', 'finishStorage')],
    oracleRule: '存储活动期只占用样品且通道状态保持不变，结束后历史保留', recovery: '从长期存储样品列表继续', compressed: true
  }),
  scenario({
    id: 'D02', title: '长期存储退回申请', risk: 'P0', manualSection: '使用说明 §6',
    dataIds: ['normal-horizontal-3'], visiblePrecondition: '存在一条活动长期存储记录',
    actions: [action('D02', 'return', 'returnStorage')], oracleRule: safety,
    recovery: '回到申请详情确认样品与通道释放', compressed: true
  }),
  scenario({
    id: 'D03', title: '普通测试与长期存储的样品重复占用防护', risk: 'P0', manualSection: '使用说明 §5.1、§6',
    dataIds: ['normal-horizontal-3'], visiblePrecondition: '一个样品已经被活动普通测试或长期存储记录占用',
    actions: [action('D03', 'ordinary-to-storage-overlap', 'startStorage', 'rejected'), action('D03', 'storage-to-ordinary-overlap', 'startImmediately', 'rejected')],
    oracleRule: '普通测试与长期存储不能重复占用同一样品，拒绝后原活动归属不变；长期存储不占用通道', recovery: zeroWriteRecovery, compressed: true
  }),
  scenario({
    id: 'E01', title: '及时率 PNG 导出并打开', risk: 'P1', manualSection: '使用说明 §7',
    visiblePrecondition: '及时率页可见且存在可统计样品',
    actions: [action('E01', 'export', 'exportTimeliness')], oracleRule: '导出不改变业务状态，PNG 可重新打开', recovery: '取消保存后使用新路径重试'
  }),
  scenario({
    id: 'E02', title: '申请与日志 XLSX 导出并打开', risk: 'P1', manualSection: '使用说明 §8',
    visiblePrecondition: '申请和日志页存在可导出数据',
    actions: [action('E02', 'requests', 'exportRequests'), action('E02', 'selected', 'exportSelectedRequests'), action('E02', 'logs', 'exportLogs')],
    oracleRule: '三个导出均不改变业务集合，工作表与使用说明一致', recovery: '取消保存后保持页面和选择并重试'
  }),
  scenario({
    id: 'E03', title: '两种备份扩展名与 GUI 恢复', risk: 'P0', manualSection: '使用说明 §9',
    visiblePrecondition: '已有通过 GUI 建立的可识别业务状态',
    actions: [action('E03', 'batterydata', 'backup'), action('E03', 'json', 'backup'), action('E03', 'change', 'editTester'), action('E03', 'restore', 'restore')],
    oracleRule: '恢复后规范化集合哈希与备份前一致', recovery: '恢复失败时保持当前状态并保留失败包'
  }),
  scenario({
    id: 'E04', title: '文件对话框取消、重试与篡改备份拒绝', risk: 'P0', manualSection: '使用说明 §4.2、§7-9、§11.4',
    dataIds: ['normal-csv-4'], visiblePrecondition: '测试申请表格可见且当前状态可只读核验',
    actions: [
      action('E04', 'cancel-import', 'cancelDialog', 'cancelled', { buttonName: '导入单个 Excel' }),
      action('E04', 'retry-import', 'importFile', 'success', { dataId: 'normal-csv-4' }),
      action('E04', 'cancel-backup', 'cancelDialog', 'cancelled', { buttonName: '备份数据' }),
      action('E04', 'backup', 'backup'),
      action('E04', 'tampered-restore', 'restore', 'rejected')
    ],
    oracleRule: '取消与篡改恢复均零业务写入，成功重试只写入预期申请', recovery: zeroWriteRecovery
  }),
  scenario({
    id: 'F01', title: '缺少选择与错误顺序', risk: 'P0', manualSection: '使用说明 §5-6、§11',
    visiblePrecondition: '业务页面可见但没有选择申请、样品或通道',
    actions: [action('F01', 'start-without-selection', 'startImmediately', 'rejected')], oracleRule: '拒绝后零业务写入', recovery: zeroWriteRecovery
  }),
  scenario({ id: 'F02', title: '重复提交与双击', risk: 'P0', manualSection: '使用说明 §5-6', visiblePrecondition: '提交按钮可见且表单完整', actions: [action('F02', 'double-submit', 'doubleClick')], oracleRule: safety, recovery: '只保留一个活动记录并继续' }),
  scenario({ id: 'F03', title: '错误时间与半填表导航', risk: 'P1', manualSection: '使用说明 §5-6', visiblePrecondition: '表单可编辑', actions: [action('F03', 'bad-time', 'reserve', 'rejected'), action('F03', 'navigate-away', 'navigate', 'success', { label: '日志' })], oracleRule: safety, recovery: zeroWriteRecovery }),
  scenario({ id: 'F04', title: '活动资源编辑冲突', risk: 'P0', manualSection: '使用说明 §10', visiblePrecondition: '设备或测试人员正在被活动记录引用', actions: [action('F04', 'edit-device', 'editDevice', 'rejected')], oracleRule: '冲突编辑零业务写入', recovery: zeroWriteRecovery }),
  scenario({ id: 'F05', title: '长文本与特殊字符输入', risk: 'P1', manualSection: '使用说明 §10-11', dataIds: ['long-chinese'], visiblePrecondition: '可编辑字段可见', actions: [action('F05', 'long-text', 'importFile', 'success', { dataId: 'long-chinese' })], oracleRule: safety, recovery: '失败时保留输入和截图' }),
  scenario({ id: 'F06', title: '高频导航搜索与分页', risk: 'P1', manualSection: '使用说明 §3', visiblePrecondition: '主界面与分页控件可见', actions: [action('F06', 'search', 'search'), action('F06', 'page', 'paginate')], oracleRule: '只读动作不改变业务集合', recovery: '从当前可见页面继续' }),
  scenario({ id: 'F07', title: '陈旧详情与错误对象操作', risk: 'P0', manualSection: '使用说明 §5-6', visiblePrecondition: '详情打开后其记录已被另一可见动作改变', actions: [action('F07', 'stale-finish', 'finishRunning', 'rejected')], oracleRule: '陈旧动作拒绝且不覆盖新状态', recovery: zeroWriteRecovery }),
  scenario({ id: 'G01', title: '关键阶段重启持久化', risk: 'P0', manualSection: '使用说明 §1-2、§9', visiblePrecondition: '已完成至少一个 GUI 业务写入', actions: [action('G01', 'restart', 'restart')], oracleRule: '重启前后规范化状态一致且页面可重新找到记录', recovery: '重新登录并从侧栏定位记录' }),
  scenario({ id: 'G02', title: '同 profile 单实例保护', risk: 'P0', manualSection: '使用说明 §1-2', visiblePrecondition: '指定 EXE 已以当前隔离 profile 运行', actions: [action('G02', 'second-launch', 'restart')], oracleRule: '第二次启动不产生重复窗口或业务写入', recovery: '关闭第二次启动尝试并保留主窗口' }),
  scenario({ id: 'G03', title: '最终跨页面与 SQLite 一致性', risk: 'P0', manualSection: '使用说明 §3、§8-9', visiblePrecondition: '正常、存储、导入和导出旅程均已完成', actions: [action('G03', 'dashboard', 'navigate', 'success', { label: '通道看板' }), action('G03', 'logs', 'navigate', 'success', { label: '日志' })], oracleRule: safety, recovery: '保留最终证据并停止任何进一步写入' })
]);

const BY_ID = new Map(MANUAL_SCENARIOS.map(item => [item.id, item]));

export function selectManualScenarios({ mode, ids } = {}) {
  if (ids !== undefined) {
    if (!Array.isArray(ids) || ids.length === 0) throw new TypeError('ids must be a non-empty array');
    return Object.freeze(ids.map(id => {
      const found = BY_ID.get(String(id));
      if (!found) throw new TypeError(`unknown manual scenario: ${String(id)}`);
      return found;
    }));
  }
  if (!['quick', 'full'].includes(mode)) throw new TypeError('mode must be quick or full');
  return mode === 'quick'
    ? Object.freeze(QUICK_IDS.map(id => BY_ID.get(id)))
    : MANUAL_SCENARIOS;
}
