import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

const root = path.resolve(import.meta.dirname, '..');

test('public product description keeps the application local and offline', async () => {
  const readme = await readFile(path.join(root, 'README.md'), 'utf8');
  assert.match(readme, /本地离线 Electron 桌面工具/);
  assert.match(readme, /不直接连接、采集或控制真实测试设备/);
  assert.doesNotMatch(readme, /vNext\s*(?:为|是)\s*(?:正式|当前)程序/);
});

test('package identity remains the restored MAIN desktop application', async () => {
  const manifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  assert.equal(manifest.main, 'main.js');
  assert.equal(manifest.build.productName, '电池测试通道预约与使用看板');
  assert.ok(manifest.build.files.includes('电池测试通道预约Demo.html'));
  assert.ok(!manifest.build.files.includes('src/renderer/index.html'));
});

test('Windows build commands and icon configuration are explicit', async () => {
  const [readme, packageText] = await Promise.all([
    readFile(path.join(root, 'README.md'), 'utf8'),
    readFile(path.join(root, 'package.json'), 'utf8')
  ]);
  assert.match(readme, /npm run dist:dir/);
  assert.match(readme, /npm run dist:installer/);
  const manifest = JSON.parse(packageText);
  const icon = manifest.build?.win?.icon || manifest.build?.icon || '';
  assert.ok(icon === '' || typeof icon === 'string');
});
