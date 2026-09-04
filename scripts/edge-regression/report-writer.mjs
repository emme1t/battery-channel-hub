import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import path from 'node:path';

import { validateRunResult } from '../../tests/edge/result-contract.mjs';

function reportError(code, message, details = undefined) {
  const error = new Error(message);
  error.code = code;
  if (details !== undefined) error.details = details;
  return error;
}
async function removeIfPresent(filePath) {
  try {
    await unlink(filePath);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

async function atomicWrite(filePath, content, verify) {
  const absolute = path.resolve(filePath);
  await mkdir(path.dirname(absolute), { recursive: true });
  const temporary = `${absolute}.${randomUUID()}.tmp`;
  let handle;
  try {
    handle = await open(temporary, 'wx');
    await handle.writeFile(content, 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    const persisted = await readFile(temporary, 'utf8');
    if (verify) await verify(persisted);
    await rename(temporary, absolute);
  } catch (error) {
    if (handle) await handle.close().catch(() => undefined);
    await removeIfPresent(temporary);
    throw error;
  }
}

function escapeCell(value) {
  return String(value ?? '').replaceAll('|', '\\|').replaceAll('\r', ' ').replaceAll('\n', ' ');
}

function evidenceLinks(items) {
  return (items || []).map(item => {
    const normalized = String(item).replaceAll('\\', '/');
    return `[${escapeCell(normalized)}](${encodeURI(normalized)})`;
  }).join('<br>');
}

function scenarioSummary(scenarios) {
  const counts = { PASS: 0, FAIL: 0, BLOCKED: 0 };
  for (const scenario of scenarios) counts[scenario.status] += 1;
  return { ...counts, total: scenarios.length };
}

export function renderMarkdown(result) {
  const summary = scenarioSummary(result.scenarios);
  const lines = [
    '# Edge HTML 自动回归报告',
    '',
    `- Run ID：\`${escapeCell(result.runId)}\``,
    `- 模式：\`${escapeCell(result.mode)}\`（\`${escapeCell(result.coverage)}\`）`,
    `- 分支 / SHA：\`${escapeCell(result.environment?.branch || '')}\` / \`${escapeCell(result.environment?.gitSha || '')}\``,
    `- 开始 / 结束：${escapeCell(result.startedAt)} / ${escapeCell(result.finishedAt)}`,
    `- 耗时：${Number(result.durationMs).toLocaleString('en-US')} ms`,
    `- 汇总：PASS ${summary.PASS}/${summary.total} · FAIL ${summary.FAIL} · BLOCKED ${summary.BLOCKED}`,
    `- 数据保护：${result.protection?.ok === true ? 'PASS' : 'FAIL'}`,
    '',
    '| 编号 | 场景 | 执行面 | 结果 | 耗时 | 证据 |',
    '|---|---|---|---|---:|---|'
  ];
  for (const scenario of result.scenarios) {
    lines.push(`| ${escapeCell(scenario.id)} | ${escapeCell(scenario.title)} | ${escapeCell(scenario.surface)} | ${escapeCell(scenario.status)} | ${Number(scenario.durationMs).toLocaleString('en-US')} ms | ${evidenceLinks(scenario.evidence)} |`);
  }
  const failures = result.scenarios.filter(item => item.status !== 'PASS');
  if (failures.length > 0) {
    lines.push('', '## 失败与阻断', '');
    for (const scenario of failures) {
      lines.push(`- **${escapeCell(scenario.id)}** \`${escapeCell(scenario.error?.code || 'UNKNOWN')}\`：${escapeCell(scenario.error?.message || '未提供错误信息')}`);
    }
  }
  lines.push('', '## 环境', '', '```json', JSON.stringify(result.environment || {}, null, 2), '```', '');
  return `${lines.join('\n')}\n`;
}

export async function writeRunReport({ runRoot, result }) {
  if (!runRoot) throw reportError('REPORT_ROOT_REQUIRED', 'runRoot is required');
  const validation = validateRunResult(result);
  if (!validation.ok) {
    throw reportError('REPORT_INVALID', validation.errors.join('\n'), validation.errors);
  }
  const resolvedRoot = path.resolve(runRoot);
  const jsonPath = path.join(resolvedRoot, 'result.json');
  await atomicWrite(jsonPath, `${JSON.stringify(result, null, 2)}\n`, async text => {
    const parsed = JSON.parse(text);
    const persistedValidation = validateRunResult(parsed);
    if (!persistedValidation.ok) throw reportError('REPORT_RELOAD_INVALID', persistedValidation.errors.join('\n'));
  });
  const persisted = JSON.parse(await readFile(jsonPath, 'utf8'));
  const markdownPath = path.join(resolvedRoot, '自动测试报告.md');
  await atomicWrite(markdownPath, renderMarkdown(persisted), async text => {
    if (!text.includes(`PASS ${scenarioSummary(persisted.scenarios).PASS}/${persisted.scenarios.length}`)) {
      throw reportError('MARKDOWN_RELOAD_INVALID', 'Markdown summary is missing');
    }
  });
  return { jsonPath, markdownPath };
}
