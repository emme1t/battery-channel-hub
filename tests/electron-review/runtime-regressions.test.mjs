import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { _electron } from 'playwright-core';

const projectRoot = path.resolve(import.meta.dirname, '../..');
const runRoot = path.join(projectRoot, '自动测试报告', 'workflows', `runtime-review-${Date.now()}`);
const now = '2026-09-04T08:00:00.000Z';
let sequence = 0;
const metadata = () => ({ actor: 'Electron reviewer', now, auditId: `review-${++sequence}` });
function seed() {
  return { requests: [{ id: 'REVIEW', qty: 2, project: 'review', test: 'cycle', sample: 'A' }],
    deviceProfiles: [{ id: 'D1', name: 'D1', status: 'enabled' }],
    channels: [{ key: 'D1|1', device: 'D1', name: '1', state: 'free', currentRecordId: '', nextRecordId: '', end: '' }],
    records: [], samples: [], storageRecords: [], auditLogs: [], testers: [], formChangeJournal: [], requestSourceRows: [] };
}
async function fixture(t, initial = seed()) {
  const root = path.join(runRoot, String(++sequence));
  await mkdir(root, { recursive: true });
  const env = { ...process.env, BATTERY_CHANNEL_DATA_DIR: path.join(root, 'data') };
  delete env.ELECTRON_RUN_AS_NODE;
  for (const key of Object.keys(env)) if (key.startsWith('NODE_TEST_') || key.startsWith('BATTERY_CHANNEL_SMOKE')) delete env[key];
  const app = await _electron.launch({ args: [projectRoot, `--user-data-dir=${path.join(root, 'profile')}`], env, timeout: 30000 });
  const page = await app.firstWindow();
  t.after(async () => {
    await page.screenshot({ path: path.join(root, 'final.png') }).catch(() => {});
    await app.close();
  });
  await page.waitForFunction(() => Boolean(window.batteryDesktop));
  await page.evaluate(async initial => { await batteryDesktop.loadState(); await batteryDesktop.saveState(initial); }, initial);
  const execute = (kind, type, payload) => page.evaluate(async ({ kind, type, payload }) => batteryDesktop[kind]({ type, payload }), { kind, type, payload: { ...payload, ...metadata() } });
  const command = async (kind, type, payload) => {
    const result = await execute(kind, type, payload);
    assert.equal(result.ok, true, JSON.stringify(result));
    return result.state;
  };
  return { app, page, execute, command, load: () => page.evaluate(() => batteryDesktop.loadState()) };
}
const application = 'executeApplication';
const reservation = 'executeReservation';
const assignment = (recordId, sample, start, end) => ({ requestNo: 'REVIEW', sampleId: `REVIEW.00${sample}`, channelKey: 'D1|1', recordId, start, end });

test('real preload preserves successful command and additive navigation audit across queued stale save', async t => {
  const { app, page, load } = await fixture(t);
  await app.evaluate(({ ipcMain }) => {
    const original = ipcMain._invokeHandlers.get('application:execute');
    globalThis.reviewGateStarted = false;
    ipcMain.removeHandler('application:execute');
    ipcMain.handle('application:execute', async (...args) => {
      globalThis.reviewGateStarted = true;
      await new Promise(resolve => { globalThis.releaseReviewGate = resolve; });
      return original(...args);
    });
  });
  await page.evaluate(async meta => {
    const stale = await batteryDesktop.loadState();
    window.reviewCommand = batteryDesktop.executeApplication({ type: 'upsertTester', payload: { tester: { id: 'T1', name: 'Review tester', status: 'enabled' }, ...meta } });
    stale.auditLogs.unshift({ id: 'navigation', action: '查看页面' });
    window.reviewSave = batteryDesktop.saveState(stale);
  }, metadata());
  assert.equal(await app.evaluate(() => globalThis.reviewGateStarted), true);
  await app.evaluate(() => globalThis.releaseReviewGate());
  const result = await page.evaluate(async () => ({ command: await reviewCommand, saved: await reviewSave }));
  assert.equal(result.command.ok, true);
  const state = await load();
  assert.equal(state.testers.length, 1);
  assert.ok(state.auditLogs.some(a => a.id === result.command.state.auditLogs[0].id));
  assert.ok(state.auditLogs.some(a => a.id === 'navigation'));
  assert.equal(state.revision, result.command.state.revision + 1);
});

test('channel end editor changes current record and sample, preserving queued interval', async t => {
  const { command } = await fixture(t);
  await command(reservation, 'start', assignment('R1', 1, now, '2026-09-04T10:00:00.000Z'));
  const before = await command(reservation, 'reserve', assignment('R2', 2, '2026-09-04T12:00:00.000Z', '2026-09-04T14:00:00.000Z'));
  const state = await command(application, 'upsertChannel', { channelKey: 'D1|1', channel: { device: 'D1', name: '1', state: 'busy', end: '2026-09-04T11:00:00.000Z' } });
  assert.deepEqual(state.records.find(r => r.id === 'R2'), before.records.find(r => r.id === 'R2'));
  assert.deepEqual(state.samples.find(r => r.id === 'REVIEW.002'), before.samples.find(r => r.id === 'REVIEW.002'));
  assert.equal(state.records.find(r => r.id === 'R1').end, '2026-09-04T11:00:00.000Z');
  assert.equal(state.samples.find(r => r.id === 'REVIEW.001').end, '2026-09-04T11:00:00.000Z');
});

test('imported quote-bearing request identifier edits without executing identifier text', async t => {
  const initial = seed();
  initial.requests[0].id = "x')-window.reviewMarker(1)-('";
  const { page } = await fixture(t, initial);
  await page.reload();
  await page.locator('#username').fill('review');
  await page.locator('#login .btn.wide').click();
  await page.waitForFunction(() => window.__batteryAppReady === true);
  await page.locator('button.nav[data-page="requests"]').click();
  await page.evaluate(() => { window.reviewMarker = () => { window.reviewInjected = true; }; });
  await page.locator('#requestTable').getByRole('button', { name: '编辑', exact: true }).click();
  assert.equal(await page.evaluate(() => window.reviewInjected === true), false);
  assert.equal(await page.locator('#requestEditor').isVisible(), true);
  assert.ok(await page.locator('#requestEditor input').evaluateAll(inputs => inputs.some(input => input.value === "x')-window.reviewMarker(1)-('")));
});

test('actual tester save then page navigation retains tester and both command/navigation audits', async t => {
  const { app, page, load } = await fixture(t);
  await page.reload();
  await page.locator('#username').fill('review');
  await page.locator('#login .btn.wide').click();
  await page.waitForFunction(() => window.__batteryAppReady === true);
  await page.locator('button.nav[data-page="testers"]').click();
  await load();
  await app.evaluate(({ ipcMain }) => {
    const original = ipcMain._invokeHandlers.get('application:execute');
    ipcMain.removeHandler('application:execute');
    ipcMain.handle('application:execute', async (...args) => {
      await new Promise(resolve => { globalThis.releaseReviewGate = resolve; });
      return original(...args);
    });
  });
  await page.getByRole('button', { name: '＋ 新增测试人员', exact: true }).click();
  await page.locator('#tName').fill('Navigation reviewer');
  await page.getByRole('button', { name: '保存测试人员', exact: true }).click();
  await page.locator('button.nav[data-page="requests"]').click();
  await app.evaluate(() => globalThis.releaseReviewGate());
  await page.waitForFunction(() => document.getElementById('toast')?.textContent.includes('测试人员已保存'));
  const state = await load();
  assert.equal(state.testers.filter(tester => tester.name === 'Navigation reviewer').length, 1);
  assert.ok(state.auditLogs.some(a => a.action === '新增测试人员'));
  assert.ok(state.auditLogs.some(a => a.action === '查看页面' && a.target === '页面 requests'));
  await page.locator('button.nav[data-page="records"]').click();
  const later = await load();
  assert.ok(later.auditLogs.some(a => a.action === '查看页面' && a.target === '页面 requests'));
});

test('preload preserves ordinary queued saves, failure recovery, and rejects conflicting stale business edits', async t => {
  const { page } = await fixture(t);
  const state = await page.evaluate(async meta => {
    const initial = await batteryDesktop.loadState();
    const failed = batteryDesktop.executeApplication({ type: 'unknown', payload: meta });
    const one = structuredClone(initial); one.testers.push({ id: 'T0', name: 'First', status: 'enabled' });
    const savedOne = batteryDesktop.saveState(one);
    const two = structuredClone(one); two.auditLogs.unshift({ id: 'queued-two', action: '查看页面' });
    const savedTwo = batteryDesktop.saveState(two);
    const failure = await failed;
    const first = await savedOne; const second = await savedTwo;
    const stale = structuredClone(second); stale.testers[0].name = 'Stale local edit';
    const command = batteryDesktop.executeApplication({ type: 'upsertTester', payload: { ...meta, tester: { id: 'T0', name: 'Authoritative edit', status: 'enabled' } } });
    const rejected = batteryDesktop.saveState(stale).then(() => false, () => true);
    const result = await command;
    return { failure, first, second, result, rejected: await rejected, final: await batteryDesktop.loadState() };
  }, metadata());
  assert.equal(state.failure.ok, false);
  assert.equal(state.second.revision, state.first.revision + 1);
  assert.equal(state.result.ok, true);
  assert.equal(state.rejected, true);
  assert.equal(state.final.testers[0].name, 'Authoritative edit');
  assert.equal(state.final.revision, state.result.state.revision);
});

test('reservation start and later navigation preserve pending navigation audit in shared state adoption', async t => {
  const { app, page, command, load } = await fixture(t);
  await command(reservation, 'reserve', assignment('R1', 1, now, '2026-09-05T10:00:00.000Z'));
  await page.reload();
  await page.locator('#username').fill('review');
  await page.locator('#login .btn.wide').click();
  await page.waitForFunction(() => window.__batteryAppReady === true);
  await page.locator('button.nav[data-page="reserved"]').click();
  await load();
  await app.evaluate(({ ipcMain }) => {
    const original = ipcMain._invokeHandlers.get('reservation:execute');
    ipcMain.removeHandler('reservation:execute');
    ipcMain.handle('reservation:execute', async (...args) => {
      await new Promise(resolve => { globalThis.releaseReviewGate = resolve; });
      return original(...args);
    });
  });
  await page.locator('#reserved').getByRole('button', { name: '开始测试', exact: true }).click();
  await page.locator('button.nav[data-page="requests"]').click();
  await app.evaluate(() => globalThis.releaseReviewGate());
  await page.waitForFunction(() => document.getElementById('toast')?.textContent.includes('已开始预约测试'));
  assert.equal((await load()).records[0].status, 'running');
  await page.locator('button.nav[data-page="records"]').click();
  assert.ok((await load()).auditLogs.some(a => a.action === '查看页面' && a.target === '页面 requests'));
});

test('booked owner end edits and invalid interval rejection remain atomic', async t => {
  const { command, execute, load } = await fixture(t);
  await command(reservation, 'reserve', assignment('R1', 1, '2026-09-04T12:00:00.000Z', '2026-09-04T14:00:00.000Z'));
  const before = await command(application, 'upsertChannel', { channelKey: 'D1|1', channel: { device: 'D1', name: '1', state: 'booked', end: '2026-09-04T15:00:00.000Z' } });
  assert.equal(before.records[0].end, '2026-09-04T15:00:00.000Z');
  assert.equal(before.samples.find(s => s.id === 'REVIEW.001').end, '2026-09-04T15:00:00.000Z');
  const failure = await execute(application, 'upsertChannel', { channelKey: 'D1|1', channel: { device: 'D1', name: '1', state: 'booked', end: '2026-09-04T11:00:00.000Z' } });
  assert.equal(failure.ok, false);
  assert.equal(failure.code, 'ACTIVE_CHANNEL_END_BEFORE_START');
  assert.deepEqual(await load(), before);
});

test('disabled imported device blocks booked-to-running transition without mutation', async t => {
  const { command, execute, load, page } = await fixture(t);
  await command(reservation, 'reserve', assignment('R1', 1, now, '2026-09-04T10:00:00.000Z'));
  await page.evaluate(async () => { const state = await batteryDesktop.loadState(); state.deviceProfiles[0].status = 'disabled'; await batteryDesktop.saveState(state); });
  const before = await load();
  const result = await execute(reservation, 'transition', { action: 'start', channelKey: 'D1|1' });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'DISABLED_DEVICE_CHANNEL_BLOCK');
  assert.deepEqual(await load(), before);
});

test('legacy missing current pointer resolves running owner rather than first queued record', async t => {
  const { command, page } = await fixture(t);
  await command(reservation, 'start', assignment('R1', 1, now, '2026-09-04T10:00:00.000Z'));
  await command(reservation, 'reserve', assignment('R2', 2, '2026-09-04T12:00:00.000Z', '2026-09-04T14:00:00.000Z'));
  await page.evaluate(async () => { const state = await batteryDesktop.loadState(); state.channels[0].currentRecordId = ''; await batteryDesktop.saveState(state); });
  const after = await command(application, 'upsertChannel', { channelKey: 'D1|1', channel: { device: 'D1', name: '1', state: 'busy', end: '2026-09-04T11:00:00.000Z' } });
  assert.equal(after.records.find(r => r.id === 'R1').end, '2026-09-04T11:00:00.000Z');
  assert.equal(after.records.find(r => r.id === 'R2').end, '2026-09-04T14:00:00.000Z');
});

test('clearing end with an invalid active owner rejects without persistence', async t => {
  const { command, page, execute, load } = await fixture(t);
  await command(reservation, 'start', assignment('R1', 1, now, '2026-09-04T10:00:00.000Z'));
  await page.evaluate(async () => { const state = await batteryDesktop.loadState(); state.channels[0].currentRecordId = 'missing'; await batteryDesktop.saveState(state); });
  const before = await load();
  const result = await execute(application, 'upsertChannel', { channelKey: 'D1|1', channel: { device: 'D1', name: '1', state: 'busy', end: null } });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'ACTIVE_CHANNEL_RECORD_AMBIGUOUS');
  assert.deepEqual(await load(), before);
});

test('disabled device cannot recover channel or assign tests through inconsistent free channel', async t => {
  const { command, execute, page, load } = await fixture(t);
  await command(application, 'upsertDevice', { device: { id: 'D1', name: 'D1', status: 'disabled' } });
  const before = await load();
  const recovered = await execute(reservation, 'transition', { action: 'recover', channelKey: 'D1|1' });
  assert.equal(recovered.ok, false);
  assert.equal(recovered.code, 'DISABLED_DEVICE_CHANNEL_BLOCK');
  assert.deepEqual(await load(), before);
  await page.evaluate(async () => { const state = await batteryDesktop.loadState(); state.channels[0].state = 'free'; await batteryDesktop.saveState(state); });
  for (const type of ['start', 'reserve']) {
    const result = await execute(reservation, type, assignment(`blocked-${type}`, 1, now, '2026-09-04T10:00:00.000Z'));
    assert.equal(result.ok, false);
    assert.equal(result.code, 'DISABLED_DEVICE_CHANNEL_BLOCK');
  }
});

test('disabled profile ID cannot shadow another enabled device name', async t => {
  const initial = seed();
  initial.deviceProfiles = [{ id: 'A', name: 'D1', status: 'enabled' }, { id: 'D1', name: 'Other', status: 'disabled' }];
  const { command } = await fixture(t, initial);
  const result = await command(reservation, 'start', assignment('R1', 1, now, '2026-09-04T10:00:00.000Z'));
  assert.equal(result.channels[0].state, 'busy');
});

test.after(async () => { await mkdir(runRoot, { recursive: true }); await writeFile(path.join(runRoot, 'run.json'), JSON.stringify({ runRoot, runtime: 'real Electron, production main and preload', completedAt: new Date().toISOString() }, null, 2)); console.log(`Electron evidence: ${runRoot}`); });
