import assert from 'node:assert/strict';
import { copyFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createLegacySqliteStore } from '../src/main/legacy-sqlite-store.mjs';
import { reservationTodoPage, timelyStartInsight } from '../src/renderer/legacy-dashboard-insights.mjs';

const projectRoot = path.resolve(import.meta.dirname, '..');
const fixturePath = path.join(projectRoot, '人工回归数据包', 'v0.4.3', 'SQLite', '04-及时率筛选与预约待办.sqlite');

test('v0.4.3 timeliness/TODO fixture has exact 26/529 scale and expected evidence', async () => {
  const dataRoot = await mkdtemp(path.join(tmpdir(), 'battery-v043-verify-'));
  await copyFile(fixturePath, path.join(dataRoot, 'battery-channel-hub.sqlite'));
  const store = await createLegacySqliteStore({ dataRoot });
  try {
    const loaded = await store.load();
    assert.equal(loaded.ok, true);
    const state = loaded.state;
    assert.equal(state.deviceProfiles.length, 26);
    assert.equal(state.channels.length, 529);
    assert.equal(new Set(state.channels.map(channel => channel.key)).size, 529);
    assert.equal(state.requests.length, 4);
    assert.equal(state.samples.length, 15);
    assert.equal(state.records.length, 15);
    const insight = timelyStartInsight(state, { from: '2026-08-18', to: '2026-08-20' });
    assert.deepEqual(
      { total: insight.total, timely: insight.timely, late: insight.late, missingPlan: insight.missingPlan, rate: insight.rate },
      { total: 2, timely: 1, late: 1, missingPlan: 1, rate: 50 }
    );
    assert.equal(reservationTodoPage(state, { page: 1, pageSize: 10 }).total, 12);
  } finally {
    store.close();
    await rm(dataRoot, { recursive: true, force: true });
  }
});
