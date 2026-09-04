import assert from 'node:assert/strict';
import test from 'node:test';

import { inspectLoadedState } from '../src/renderer/app-state.mjs';
import { makeState } from './fixtures/state-fixtures.mjs';

test('empty inspection creates an in-memory vNext state without claiming persistence', () => {
  const result = inspectLoadedState({ kind: 'empty', state: makeState() });

  assert.equal(result.ok, true);
  assert.equal(result.isNew, true);
  assert.equal(result.state.schemaVersion, 2);
  assert.equal(result.state.dataRevision, 0);
});

test('ready inspection accepts and clones a valid vNext state', () => {
  const state = makeState({ dataRevision: 4, username: 'tester' });
  const result = inspectLoadedState({ kind: 'ready', state });

  assert.equal(result.ok, true);
  assert.deepEqual(result.state, state);
  assert.notEqual(result.state, state);
});

test('migration-required inspection blocks without exposing legacy state', () => {
  const inspection = {
    kind: 'migration-required',
    legacyFiles: ['battery-channel-hub.json'],
    state: { requests: [{ id: 'must-not-leak' }] }
  };
  const result = inspectLoadedState(inspection);

  assert.equal(result.ok, false);
  assert.equal('state' in result, false);
  assert.match(result.message, /dry-run/i);
  assert.match(result.message, /battery-channel-hub\.json/);
});

test('blocked and malformed inspection results never mount a state', () => {
  const blocked = inspectLoadedState({ kind: 'blocked', message: 'checksum failed' });
  const malformed = inspectLoadedState(makeState());

  assert.equal(blocked.ok, false);
  assert.match(blocked.message, /checksum failed/);
  assert.equal('state' in blocked, false);
  assert.equal(malformed.ok, false);
  assert.equal('state' in malformed, false);
});
