import { SCENARIOS } from '../scenario-manifest.mjs';
import { createEvidenceRunners } from './evidence-plan.mjs';

const node = (key, file, namePattern, success) => ({ kind: 'node', key, files: [file], namePattern, success });
const edge = (key, probe, fixture, success, options = {}) => ({ kind: 'edge', key, probe, fixture, success, ...options });
const electron = (key, script, success) => ({ kind: 'electron', key, script, success });

export const P1_EVIDENCE_PLANS = Object.freeze({
  'P1-01': [
    edge('eight-navigation', 'eight-navigation', 'A01', '十个左侧入口均可进入且页面无控制台错误'),
    electron('native-navigation', 'test:smoke:full-shell', '真实 Electron 外壳中的十个入口均可访问')
  ],
  'P1-02': [
    node('default-workspace-model', 'tests/legacy-reservation-workspace.test.mjs', 'default workspace renders only the full-width compressed request list', '未选申请时只显示全宽压缩列表'),
    edge('default-reservation-layout', 'default-reservation-layout', 'A03', '1366×768 默认不显示右栏且无横向溢出', { viewport: { width: 1366, height: 768 } })
  ],
  'P1-03': [
    edge('laptop-split-ratio', 'expanded-reservation-layout', 'A03', '展开后左右栏采用适合笔记本的非等宽比例', { viewport: { width: 1366, height: 768 } }),
    edge('details-independent-scroll', 'expanded-reservation-layout', 'A03', '右侧详情区独立滚动且翻页不推动外层到底部', { viewport: { width: 1366, height: 768 } }),
    edge('no-horizontal-overflow', 'expanded-reservation-layout', 'A03', '展开详情后页面没有横向溢出', { viewport: { width: 1366, height: 768 } })
  ],
  'P1-04': [
    node('close-preserves-context', 'tests/legacy-reservation-workspace.test.mjs', 'closing details preserves request search, pending filter and pagination context', '关闭详情保留搜索、筛选和页码'),
    edge('close-reopen-context', 'close-reopen-context', 'A03', '关闭后恢复全宽列表，再次打开仍保留上下文')
  ],
  'P1-05': [
    edge('laptop-viewports', 'laptop-viewports', 'A03', '1440×900 和 1536×864 下布局稳定且无横向溢出'),
    electron('native-laptop-layout', 'test:smoke:reservation', '真实 Electron 在三种笔记本视口下通过布局断言')
  ],
  'P1-06': [
    node('channel-search-domain', 'tests/legacy-list-selectors.test.mjs', 'channel filters are AND-composed, mode-aware and treat special characters as text', '通道搜索组合筛选且特殊字符按文本处理'),
    edge('channel-search-ui', 'channel-search', 'A01', '中文、设备名和通道号搜索均在 529 通道数据上生效')
  ],
  'P1-07': [
    node('bounded-board-expansion', 'tests/legacy-large-list-render.test.mjs', 'one expanded device renders only that device channels and escapes visible content', '仅展开目标设备的有限通道卡'),
    edge('board-expansion-ui', 'board-expansion', 'A01', '看板默认折叠，展开/收起不会一次渲染 529 张卡')
  ],
  'P1-08': [
    node('request-page-cap', 'tests/legacy-list-selectors.test.mjs', 'legacy request, sample and channel selectors enforce 50/25/40 result caps', '申请每页最多 50 条且样品每页最多 25 条'),
    edge('request-pagination-ui', 'request-pagination', 'A03', '申请和样品翻页后各自滚动位置稳定')
  ],
  'P1-09': [
    node('log-page-cap', 'tests/legacy-large-list-render.test.mjs', 'device, record and audit selectors cap every page at 50 and clamp page numbers', '记录和审计每页最多 50 条并夹紧页码'),
    edge('log-pagination-ui', 'log-pagination', 'A03', '日志翻页、筛选和详情操作保持稳定')
  ],
  'P1-10': [
    node('single-workbook-parse', 'tests/excel-service.test.mjs', 'parseWorkbook recognizes a vertical application and preserves source evidence|parseWorkbook recognizes the existing flat summary fixture', '单文件导入识别模板并保留源文件证据'),
    electron('native-import-dialog', 'test:smoke:admin', '真实 Electron 导入入口和主进程对话框链路可用')
  ],
  'P1-11': [
    node('folder-import-errors', 'tests/excel-service.test.mjs', 'parseFolder collects nested workbooks, skips lock files and reports all file errors', '文件夹导入递归收集、跳过锁文件并报告全部错误'),
    electron('native-folder-import', 'test:smoke:admin', '真实 Electron 文件夹导入入口可访问')
  ],
  'P1-12': [
    node('request-export-workbook', 'tests/excel-service.test.mjs', 'writeWorkbook writes five expected sheets and re-reads the final file before success|write failure is structured', '申请导出写后重读校验且取消/失败不残留文件'),
    electron('native-request-export', 'test:smoke:admin', '真实 Electron 申请导出取消和成功路径通过')
  ],
  'P1-13': [
    node('log-export-workbook', 'tests/excel-service.test.mjs', 'writeWorkbook writes five expected sheets and re-reads the final file before success', '日志导出文件经写后重读校验'),
    electron('native-log-export', 'test:smoke:admin', '真实 Electron 日志页与导出主进程链路可用')
  ],
  'P1-14': [
    node('resource-maintenance-domain', 'tests/application-command-service.test.mjs', 'device and channel upserts enforce unique identities and commit audited state|tester duplicate rejection', '设备、通道和人员维护具备唯一性与审计约束'),
    electron('native-resource-maintenance', 'test:smoke:admin', '真实 Electron 设备和人员维护页面可访问')
  ],
  'P1-15': [
    edge('keyboard-focus', 'keyboard-focus', 'A02', 'Tab、Enter、Escape 和焦点顺序可完成核心操作')
  ],
  'P1-16': [
    node('timeliness-domain', 'tests/legacy-dashboard-insights.test.mjs', 'timely-start insight is per started sample', '及时率按已开始的单块样品计算'),
    edge('timeliness-panel', 'timeliness-panel', 'A04', '独立及时率入口显示基线中的 50% 证据')
  ],
  'P1-17': [
    node('png-export-bytes', 'tests/dashboard-png-service.test.mjs', 'dashboard PNG export validates the image, writes the selected file and verifies PNG bytes', 'PNG 导出校验签名、落盘并重读'),
    edge('timeliness-date-png', 'timeliness-date-png', 'A04', '及时率按日期筛选且 PNG 导出入口可用')
  ],
  'P1-18': [
    node('dashboard-filter-domain', 'tests/legacy-dashboard-insights.test.mjs', 'dashboard channel filters compose keyword, state and maximum current without expanding cards', '关键字、状态和最大电流按 AND 组合'),
    edge('dashboard-filter-ui', 'dashboard-filters', 'A04', '看板组合筛选结果正确且不隐式展开全部卡片')
  ],
  'P1-19': [
    node('todo-domain', 'tests/legacy-dashboard-insights.test.mjs', 'reservation TODO list is sorted, bounded and keeps the source record index', '预约待办排序、分页且保留详情索引'),
    edge('todo-pagination-detail', 'reservation-todo', 'A04', '待办翻页与跳转详情可用')
  ],
  'P1-20': [
    node('all-channel-pages', 'tests/legacy-list-selectors.test.mjs', 'all 529 eligible channels remain reachable through bounded non-overlapping pages', '529 个通道通过不重叠分页全部可达'),
    edge('full-channel-pagination', 'full-channel-pagination', 'A01', '连续翻页覆盖全部唯一通道且滚动不跳到底部')
  ],
  'P1-21': [
    edge('ime-composition', 'ime-input', 'A03', '中文组合输入、候选上屏、字符顺序和光标方向正确'),
    electron('native-ime-composition', 'test:smoke:admin', '真实 Electron 中英文输入、光标和组合事件通过')
  ],
  'P1-22': [
    node('busy-card-linkage', 'tests/legacy-large-list-render.test.mjs', 'busy channel card shows its running sample and exposes test management', '占用卡显示进行中样品并提供管理入口'),
    edge('running-management-ui', 'running-test-management', 'A02', '看板可跳转进行中样品编辑且状态与数据库一致'),
    electron('native-running-management', 'test:smoke:reservation', '真实 Electron 完成进行中测试管理闭环')
  ]
});

const definitions = SCENARIOS.filter(item => item.group === 'P1');
export const P1_RUNNERS = createEvidenceRunners(definitions, P1_EVIDENCE_PLANS);
