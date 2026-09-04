import test from 'node:test';
import assert from 'node:assert/strict';

import {
  assertQuantity,
  reconcileSamples,
  sampleId
} from '../src/domain/sample-quantity.mjs';

function samplesFor(requestNo, count, overrides = {}) {
  return Array.from({ length: count }, (_, index) => ({
    id: sampleId(requestNo, index + 1),
    requestNo,
    ordinal: index + 1,
    status: 'pending',
    hasHistory: false,
    ...overrides[index + 1]
  }));
}

test('accepts 1 and 999 and rejects values outside the integer range', () => {
  assert.equal(assertQuantity(1), 1);
  assert.equal(assertQuantity(999), 999);

  for (const value of [0, 1000, 1.5, '3', null, undefined, Number.NaN]) {
    assert.throws(() => assertQuantity(value), /1–999/);
  }
});

test('builds fixed three-digit child sample identifiers', () => {
  assert.equal(sampleId('申请 01', 1), '申请 01.001');
  assert.equal(sampleId('申请 01', 999), '申请 01.999');
  assert.throws(() => sampleId('', 1), /申请单号/);
});

test('increasing quantity preserves existing samples and adds consecutive identifiers', () => {
  const originalSamples = samplesFor('R-1', 2, {
    1: { status: 'completed', hasHistory: true, channelKey: 'A' }
  });
  const snapshot = structuredClone(originalSamples);

  const result = reconcileSamples({
    request: { requestNo: 'R-1', quantity: 2 },
    samples: originalSamples,
    nextQuantity: 4,
    confirmReduction: false
  });

  assert.deepEqual(originalSamples, snapshot);
  assert.deepEqual(result.samples.slice(0, 2), snapshot);
  assert.deepEqual(result.samples.slice(2).map((sample) => sample.id), ['R-1.003', 'R-1.004']);
  assert.deepEqual(result.addedSampleIds, ['R-1.003', 'R-1.004']);
  assert.equal(result.request.quantity, 4);
});

test('reducing quantity removes only confirmed trailing pending samples', () => {
  const result = reconcileSamples({
    request: { requestNo: 'R-1', quantity: 3 },
    samples: samplesFor('R-1', 3, {
      1: { status: 'completed', hasHistory: true }
    }),
    nextQuantity: 2,
    confirmReduction: true
  });

  assert.deepEqual(result.samples.map((sample) => sample.id), ['R-1.001', 'R-1.002']);
  assert.deepEqual(result.removedSampleIds, ['R-1.003']);
});

test('reduction without confirmation is blocked without mutating inputs', () => {
  const request = { requestNo: 'R-1', quantity: 3 };
  const samples = samplesFor('R-1', 3);
  const snapshot = structuredClone({ request, samples });

  assert.throws(
    () => reconcileSamples({ request, samples, nextQuantity: 2, confirmReduction: false }),
    /二次确认/
  );
  assert.deepEqual({ request, samples }, snapshot);
});

test('reduction touching active or historical samples blocks the whole transaction', () => {
  const protectedStatuses = [
    { status: 'reserved', hasHistory: false },
    { status: 'running', hasHistory: false },
    { status: 'completed', hasHistory: true },
    { status: 'cancelled', hasHistory: true }
  ];

  for (const protectedSample of protectedStatuses) {
    const request = { requestNo: 'R-1', quantity: 3 };
    const samples = samplesFor('R-1', 3, { 3: protectedSample });
    const snapshot = structuredClone({ request, samples });

    assert.throws(
      () => reconcileSamples({ request, samples, nextQuantity: 2, confirmReduction: true }),
      /活动或历史/
    );
    assert.deepEqual({ request, samples }, snapshot);
  }
});

test('rejects inconsistent current sample collections before reconciliation', () => {
  assert.throws(
    () => reconcileSamples({
      request: { requestNo: 'R-1', quantity: 3 },
      samples: samplesFor('R-1', 2),
      nextQuantity: 4,
      confirmReduction: false
    }),
    /数量不一致/
  );
});
