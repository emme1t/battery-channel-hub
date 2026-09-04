import {
  createEmptyState,
  validateState
} from '../domain/state-schema.mjs';

export function emptyVnextState() {
  return createEmptyState();
}

export function inspectLoadedState(value) {
  if (!value || typeof value !== 'object') {
    return { ok: false, message: '数据仓库返回了无效的加载结果，已停止挂载页面。' };
  }
  if (value.kind === 'migration-required') {
    const files = Array.isArray(value.legacyFiles) ? value.legacyFiles.join('、') : '';
    return {
      ok: false,
      message: `检测到旧版数据${files ? `（${files}）` : ''}。vNext 不会自动迁移或覆盖；请先使用独立迁移工具完成 dry-run、核对报告和备份。`
    };
  }
  if (value.kind === 'blocked') {
    return {
      ok: false,
      message: value.message || 'vNext 数据无法安全读取，已停止挂载页面。'
    };
  }
  if (!['empty', 'ready'].includes(value.kind)) {
    return { ok: false, message: '数据仓库返回了未知状态，已停止挂载页面。' };
  }

  const state = value.kind === 'empty' ? (value.state ?? emptyVnextState()) : value.state;
  const validation = validateState(state);
  if (!validation.ok) {
    return {
      ok: false,
      message: `vNext 状态校验失败，已停止挂载页面。${validation.blockers[0] ? ` 首个阻断：${validation.blockers[0]}` : ''}`
    };
  }
  return {
    ok: true,
    state: structuredClone(state),
    ...(value.kind === 'empty' ? { isNew: true } : {})
  };
}
