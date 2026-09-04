import assert from 'node:assert/strict';
import test from 'node:test';

import {
  dashboardChannelSummary,
  reservationTodoPage,
  timelyStartInsight
} from '../src/renderer/legacy-dashboard-insights.mjs';

function fixture() {
  return {
    requests: [
      { id: 'REQ-1', execution: { plannedStart: '2026-08-20' } },
      { id: 'REQ-2', execution: { plannedStart: '2026-08-20T10:00:00-07:00' } },
      { id: 'REQ-3', execution: {} }
    ],
    samples: [
      { id: 'REQ-1.001', requestNo: 'REQ-1' },
      { id: 'REQ-2.001', requestNo: 'REQ-2' },
      { id: 'REQ-3.001', requestNo: 'REQ-3' }
    ],
    records: [
      { id: 'R1', requestNo: 'REQ-1', sampleId: 'REQ-1.001', status: 'running', start: '2026-08-20T18:00:00-07:00' },
      { id: 'R2', requestNo: 'REQ-2', sampleId: 'REQ-2.001', status: 'completed', start: '2026-08-20T10:30:00-07:00' },
      { id: 'R3', requestNo: 'REQ-3', sampleId: 'REQ-3.001', status: 'running', start: '2026-08-21T09:00:00-07:00' },
      { id: 'R4', requestNo: 'REQ-1', sampleId: 'REQ-1.002', status: 'reserved', start: '2026-08-22T09:00:00-07:00', keys: ['D1|CH-01'] }
    ],
    channels: [
      { key: 'D1|CH-01', device: '新威 5V100A', name: 'CH-01', current: '100', state: 'booked' },
      { key: 'D1|CH-02', device: '新威 5V100A', name: 'CH-02', current: '', state: 'free' },
      { key: 'D2|CH-01', device: '蓝奇 5V20A', name: 'CH-01', current: '20', state: 'fault' }
    ],
    deviceProfiles: [
      { name: '新威 5V100A', current: '100' },
      { name: '蓝奇 5V20A', current: '20' }
    ]
  };
}

test('timely-start insight is per started sample, treats a date-only plan as end-of-day and reports missing plans', () => {
  const insight = timelyStartInsight(fixture(), { from: '2026-08-20', to: '2026-08-21' });

  assert.deepEqual(
    { total: insight.total, timely: insight.timely, late: insight.late, missingPlan: insight.missingPlan, rate: insight.rate },
    { total: 2, timely: 1, late: 1, missingPlan: 1, rate: 50 }
  );
  assert.equal(insight.points.length, 2);
  assert.equal(insight.points[0].date, '2026-08-20');
});

test('reservation TODO list is sorted, bounded and keeps the source record index for detail navigation', () => {
  const state = fixture();
  state.records.push(...Array.from({ length: 12 }, (_, index) => ({
    id: `TODO-${index}`,
    requestNo: `REQ-${index + 10}`,
    status: 'reserved',
    start: `2026-09-${String(index + 1).padStart(2, '0')}T09:00:00-07:00`,
    keys: [`D1|CH-${String(index + 3).padStart(2, '0')}`]
  })));

  const first = reservationTodoPage(state, { page: 1, pageSize: 10 });
  const second = reservationTodoPage(state, { page: 2, pageSize: 10 });
  assert.equal(first.items.length, 10);
  assert.equal(first.total, 13);
  assert.equal(second.items.length, 3);
  assert.equal(first.items[0].__legacyIndex, 3);
  assert.equal(new Set([...first.items, ...second.items].map(item => item.__legacyIndex)).size, 13);
});

test('dashboard channel filters compose keyword, state and maximum current without expanding cards', () => {
  const summary = dashboardChannelSummary(fixture(), {
    text: '新威', state: 'free', maxCurrent: '100'
  });

  assert.equal(summary.channels.length, 1);
  assert.equal(summary.channels[0].key, 'D1|CH-02');
  assert.deepEqual(summary.deviceNames, ['新威 5V100A']);
  assert.equal(summary.counts.free, 1);
});
