import test from 'node:test';
import assert from 'node:assert/strict';

import { makeState } from './fixtures/state-fixtures.mjs';

test('state fixture returns isolated collections', () => {
  const first = makeState();
  const second = makeState();

  first.requests.push({ requestNo: 'A' });

  assert.equal(second.requests.length, 0);
});
