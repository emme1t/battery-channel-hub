import test from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';

import {
  channelCandidates,
  requestPage,
  samplePage
} from '../../src/renderer/reservation-view-model.mjs';
import { makeProductionScaleState } from '../fixtures/production-scale.mjs';

test('production-scale reservation selectors finish within 300 ms', (context) => {
  const state = makeProductionScaleState({
    channelCount: 529,
    requestCount: 100,
    auditCount: 2000
  });
  const durations = [];

  for (let iteration = 0; iteration < 20; iteration += 1) {
    const started = performance.now();
    requestPage(state, { text: '生产项目', page: 1, pageSize: 50 });
    samplePage(state, 'R-0001', 1);
    channelCandidates(state, { mode: 'reserve', text: '', limit: 40 });
    durations.push(performance.now() - started);
  }

  const maximum = Math.max(...durations);
  const average = durations.reduce((sum, value) => sum + value, 0) / durations.length;
  context.diagnostic(`selectors average=${average.toFixed(2)}ms max=${maximum.toFixed(2)}ms`);
  assert.ok(maximum <= 300, `最慢查询 ${maximum.toFixed(2)}ms 超过 300ms`);
});

test('production-scale selectors keep all list result caps', () => {
  const state = makeProductionScaleState({
    channelCount: 529,
    requestCount: 100,
    auditCount: 2000
  });

  assert.equal(requestPage(state, { page: 1, pageSize: 999 }).items.length, 50);
  assert.equal(samplePage(state, 'R-0001', 1).items.length, 25);
  assert.equal(channelCandidates(state, { mode: 'reserve', limit: 999 }).items.length, 40);
});
