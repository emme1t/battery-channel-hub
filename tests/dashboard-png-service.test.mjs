import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createDashboardPngService } from '../src/main/dashboard-png-service.mjs';

const ONE_PIXEL_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

test('dashboard PNG export validates the image, writes the selected file and verifies PNG bytes', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'dashboard-png-'));
  const target = path.join(root, '及时率.png');
  try {
    const service = createDashboardPngService({
      dialog: { showSaveDialog: async () => ({ canceled: false, filePath: target }) }
    });
    const result = await service.exportPng({ dataUrl: ONE_PIXEL_PNG, defaultFileName: '及时率.png' });
    const bytes = await readFile(target);
    assert.equal(result.ok, true);
    assert.equal(result.filePath, target);
    assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('dashboard PNG export returns cancellation without writing and rejects non-PNG payloads', async () => {
  const canceled = createDashboardPngService({
    dialog: { showSaveDialog: async () => ({ canceled: true }) }
  });
  assert.deepEqual(await canceled.exportPng({ dataUrl: ONE_PIXEL_PNG }), { ok: false, canceled: true });

  await assert.rejects(
    canceled.exportPng({ dataUrl: 'data:text/plain;base64,SGVsbG8=' }),
    error => error.code === 'DASHBOARD_PNG_INVALID'
  );
});
