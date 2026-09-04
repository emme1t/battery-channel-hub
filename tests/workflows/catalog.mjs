import { STANDARD_WORKFLOWS } from './catalog-standard.mjs';
import { DEVIATION_WORKFLOWS } from './catalog-deviation.mjs';
import { MISUSE_WORKFLOWS } from './catalog-misuse.mjs';

const QUICK_P1 = new Set(['D05', 'D07', 'D08', 'M04', 'M06', 'M08', 'M10']);

export const WORKFLOW_CATALOG = Object.freeze([
  ...STANDARD_WORKFLOWS,
  ...DEVIATION_WORKFLOWS,
  ...MISUSE_WORKFLOWS
]);

const BY_ID = new Map(WORKFLOW_CATALOG.map(workflow => [workflow.id, workflow]));

export function selectWorkflows({ mode, ids = [] }) {
  if (!Array.isArray(ids)) throw new TypeError('ids must be an array');
  if (!['quick', 'full'].includes(mode)) throw new TypeError(`unknown workflow mode: ${mode}`);
  if (ids.length > 0) return Object.freeze(ids.map(id => {
    const workflow = BY_ID.get(id);
    if (!workflow) throw new TypeError(`unknown workflow id: ${id}`);
    return workflow;
  }));
  if (mode === 'full') return WORKFLOW_CATALOG;
  return Object.freeze(WORKFLOW_CATALOG.filter(workflow => workflow.risk === 'P0' || QUICK_P1.has(workflow.id)));
}
