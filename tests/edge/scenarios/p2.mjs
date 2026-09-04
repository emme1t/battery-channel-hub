import { SCENARIOS } from '../scenario-manifest.mjs';
import { createEvidenceRunners } from './evidence-plan.mjs';

const node = (key, file, namePattern, success) => ({ kind: 'node', key, files: [file], namePattern, success });
const edge = (key, probe, fixture, success) => ({ kind: 'edge', key, probe, fixture, success });
const electron = (key, script, success) => ({ kind: 'electron', key, script, success });

export const P2_EVIDENCE_PLANS = Object.freeze({
  'P2-01': [
    node('long-chinese-source', 'tests/excel-service.test.mjs', 'parseWorkbook recognizes a vertical application and preserves source evidence', '长中文申请字段完整解析并保留来源'),
    edge('long-chinese-layout', 'long-chinese-truncation', 'A03', '笔记本视口长中文按省略号收敛且主操作按钮不被裁切')
  ],
  'P2-02': [
    node('blocked-state-semantics', 'tests/app-state-load.test.mjs', 'blocked and malformed inspection results never mount a state|migration-required inspection blocks', '损坏、迁移和阻断状态不会挂载伪成功页面'),
    edge('empty-error-state-ui', 'empty-error-states', 'A01', '空状态和搜索无结果状态可读且不显示堆栈或成功样式')
  ],
  'P2-03': [
    node('main-recovery-language', 'tests/edge-static-product.test.mjs', 'main recovery language does not present vNext as the formal application', 'README 和测试模板明确当前为原 MAIN 差异恢复'),
    node('package-identity', 'tests/edge-static-product.test.mjs', 'package identity remains the restored MAIN desktop application', '包入口和白名单保持原 MAIN'),
    node('candidate-build-path', 'tests/edge-static-product.test.mjs', 'candidate build path and icon acceptance are explicit', '候选构建路径与验收边界明确')
  ],
  'P2-04': [
    node('application-icon-boundary', 'tests/edge-static-product.test.mjs', 'candidate build path and icon acceptance are explicit', '默认 Electron 图标按模板记录为已知 P2 而非功能通过伪装'),
    electron('native-window-icon', 'test:smoke:full-shell', '真实 Electron 窗口边界可启动并保留图标观察证据')
  ]
});

const definitions = SCENARIOS.filter(item => item.group === 'P2');
export const P2_RUNNERS = createEvidenceRunners(definitions, P2_EVIDENCE_PLANS);
