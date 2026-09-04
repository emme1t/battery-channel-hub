import test from 'node:test';
import assert from 'node:assert/strict';

import {
  closeReservation,
  createReservationPageState,
  persistReservationDraft,
  renderReservationWorkspace,
  selectRequest
} from '../src/renderer/reservation-page.mjs';
import { makeProductionScaleState } from './fixtures/production-scale.mjs';
import {
  makeChannel,
  makeRecord,
  makeRequest,
  makeSample,
  makeState
} from './fixtures/state-fixtures.mjs';

test('details panel is closed until a request is selected', () => {
  const initial = createReservationPageState();

  assert.equal(initial.selectedRequestNo, null);
  assert.equal(initial.detailsOpen, false);

  const selected = selectRequest(initial, 'R-1');
  assert.equal(selected.selectedRequestNo, 'R-1');
  assert.equal(selected.detailsOpen, true);

  const closed = closeReservation(selected);
  assert.equal(closed.selectedRequestNo, null);
  assert.equal(closed.detailsOpen, false);
});

test('closing details preserves request search and pagination context', () => {
  const initial = createReservationPageState({
    searchText: '无人机',
    requestPage: 3,
    pendingOnly: true
  });
  const closed = closeReservation(selectRequest(initial, 'R-1'));

  assert.equal(closed.searchText, '无人机');
  assert.equal(closed.requestPage, 3);
  assert.equal(closed.pendingOnly, true);
});

test('default workspace renders only the full-width request list', () => {
  const state = makeProductionScaleState({ requestCount: 100, channelCount: 529, auditCount: 2000 });
  const html = renderReservationWorkspace(state, createReservationPageState());

  assert.match(html, /data-testid="reservation-workspace"/);
  assert.doesNotMatch(html, /data-testid="reservation-details"/);
  assert.equal((html.match(/data-testid="request-row"/g) ?? []).length, 50);
});

test('selected workspace renders the details panel with at most 25 sample rows', () => {
  const state = makeProductionScaleState({ requestCount: 100, channelCount: 529, auditCount: 2000 });
  const html = renderReservationWorkspace(
    state,
    selectRequest(createReservationPageState(), 'R-0001')
  );

  assert.match(html, /data-testid="reservation-details"/);
  assert.match(html, /data-details-open="true"/);
  assert.equal((html.match(/data-testid="sample-row"/g) ?? []).length, 25);
});

test('visible request content is escaped before rendering', () => {
  const state = makeState({
    requests: [makeRequest({ requestNo: "R'<script>", project: '<img src=x onerror=alert(1)>', quantity: 1 })],
    samples: [makeSample({ id: "R'<script>.001", requestNo: "R'<script>" })]
  });
  const html = renderReservationWorkspace(state, createReservationPageState());

  assert.doesNotMatch(html, /<script>/);
  assert.doesNotMatch(html, /<img src=x/);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
});

test('successful persistence sends the expected revision and keeps the saved revision', async () => {
  const current = makeState({ dataRevision: 3 });
  const draft = makeState({
    dataRevision: 3,
    requests: [makeRequest()],
    samples: [makeSample({ status: 'reserved', channelKey: 'device-01|001', hasHistory: true })],
    channels: [makeChannel({ state: 'booked', nextRecordId: 'record-001' })],
    records: [makeRecord()]
  });
  let command;
  const repository = {
    saveState: async (value) => {
      command = value;
      return { ok: true, state: { ...value.state, dataRevision: value.expectedRevision + 1 } };
    }
  };

  const saved = await persistReservationDraft(repository, current, draft);

  assert.deepEqual(command, { state: draft, expectedRevision: 3 });
  assert.equal(saved.dataRevision, 4);
  assert.equal(saved.records.length, 1);
  assert.equal(current.dataRevision, 3);
  assert.equal(draft.dataRevision, 3);
});

test('failed persistence rejects without returning the unsaved draft', async () => {
  const current = makeState({ dataRevision: 7 });
  const draft = makeState({ dataRevision: 7, username: 'unsaved' });
  const repository = {
    saveState: async () => ({ ok: false, code: 'REVISION_CONFLICT', message: '请重新加载' })
  };

  await assert.rejects(
    () => persistReservationDraft(repository, current, draft),
    /请重新加载/
  );
  assert.equal(current.username, '测试员');
  assert.equal(draft.username, 'unsaved');
});
