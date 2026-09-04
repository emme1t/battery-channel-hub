import test from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';

import {
  createReservationPageState,
  renderReservationWorkspace,
  selectRequest
} from '../../src/renderer/reservation-page.mjs';
import { makeProductionScaleState } from '../fixtures/production-scale.mjs';

function count(html, marker) {
  return (html.match(new RegExp(marker, 'g')) ?? []).length;
}

test('999-sample details render stays within row and markup budgets', (context) => {
  const state = makeProductionScaleState({
    channelCount: 529,
    requestCount: 100,
    auditCount: 2000
  });
  const uiState = {
    ...selectRequest(createReservationPageState(), 'R-0001'),
    channelPickerSampleId: 'R-0001.001'
  };
  const started = performance.now();
  const html = renderReservationWorkspace(state, uiState);
  const duration = performance.now() - started;

  const requestRows = count(html, 'data-testid="request-row"');
  const sampleRows = count(html, 'data-testid="sample-row"');
  const channelRows = count(html, 'class="channel-result"');
  const bytes = Buffer.byteLength(html, 'utf8');
  context.diagnostic(`render=${duration.toFixed(2)}ms rows=${requestRows}/${sampleRows}/${channelRows} bytes=${bytes}`);

  assert.equal(requestRows, 50);
  assert.equal(sampleRows, 25);
  assert.equal(channelRows, 40);
  assert.ok(bytes < 200_000, `渲染标记 ${bytes} bytes 超过预算`);
  assert.ok(duration <= 300, `渲染 ${duration.toFixed(2)}ms 超过 300ms`);
});

test('default workspace does not create details or channel candidate markup', () => {
  const state = makeProductionScaleState({
    channelCount: 529,
    requestCount: 100,
    auditCount: 2000
  });
  const html = renderReservationWorkspace(state, createReservationPageState());

  assert.doesNotMatch(html, /data-testid="reservation-details"/);
  assert.doesNotMatch(html, /class="channel-result"/);
});
