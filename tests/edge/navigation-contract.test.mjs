import assert from 'node:assert/strict';
import test from 'node:test';

import { MAIN_EDGE_PROBES } from '../../scripts/edge-regression/main-edge-driver.mjs';

const REQUIRED_PAGE_IDS = [
  'dashboard', 'timeliness', 'apply', 'runningSamples', 'storageSamples',
  'reserved', 'requests', 'records', 'testers', 'devices'
];

function pageForNavigation(ids) {
  const calls = [];
  return {
    calls,
    locator(selector) {
      if (selector === 'button.nav[data-page]') {
        return { async evaluateAll(callback) { return callback(ids.map(id => ({ dataset: { page: id } }))); } };
      }
      const navigation = /^button\.nav\[data-page="(.+)"\]$/.exec(selector);
      if (navigation) return { async click() { calls.push(['click', navigation[1]]); } };
      const activePage = /^#(.+)\.page\.active$/.exec(selector);
      if (activePage) return { async waitFor() { calls.push(['active', activePage[1]]); } };
      throw new Error(`unexpected selector: ${selector}`);
    }
  };
}

test('P1-01 导航门禁要求十页精确顺序，并逐页进入', async () => {
  const probe = MAIN_EDGE_PROBES['eight-navigation'];
  const valid = pageForNavigation(REQUIRED_PAGE_IDS);
  const result = await probe({ page: valid });
  assert.deepEqual(result.ids, REQUIRED_PAGE_IDS);
  assert.deepEqual(result.visited, REQUIRED_PAGE_IDS);
  assert.deepEqual(valid.calls, REQUIRED_PAGE_IDS.flatMap(id => [['click', id], ['active', id]]));

  for (const invalid of [
    REQUIRED_PAGE_IDS.slice(0, -1),
    [...REQUIRED_PAGE_IDS, 'extraPage'],
    [...REQUIRED_PAGE_IDS.slice(0, -2), 'records', 'devices'],
    [...REQUIRED_PAGE_IDS.slice(0, 2), 'apply', 'timeliness', ...REQUIRED_PAGE_IDS.slice(4)]
  ]) {
    await assert.rejects(probe({ page: pageForNavigation(invalid) }), /左侧入口|navigation/i);
  }
});
