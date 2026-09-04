import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const enabled = process.platform === 'win32' && process.env.BATTERY_UNINSTALL_PACKAGE_GATE === '1';
const productName = '电池测试通道预约与使用看板';
const installDir = path.join(process.env.LOCALAPPDATA ?? '', 'Programs', 'battery-channel-hub');
const launcherPath = path.resolve('dist', 'Battery-Channel-Hub-1.0.0-uninstall.exe');
const desktopLink = path.join(os.homedir(), 'Desktop', `${productName}.lnk`);
const startMenuLink = path.join(
  process.env.APPDATA ?? '',
  'Microsoft',
  'Windows',
  'Start Menu',
  'Programs',
  `${productName}.lnk`
);
const defaultUserData = path.join(process.env.APPDATA ?? '', 'battery-channel-hub');
const isolatedUserData = path.resolve('..', 'install-smoke-20260904', 'userData');
const uninstallKey = String.raw`HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\7e5d1e3a-5ee0-5cae-9de6-141a448aca23`;

function fileSha256(filePath) {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex');
}

function treeSha256(root) {
  if (!existsSync(root)) return 'missing';
  const rows = [];
  const visit = current => {
    for (const name of readdirSync(current).sort()) {
      const fullPath = path.join(current, name);
      const stat = statSync(fullPath);
      if (stat.isDirectory()) visit(fullPath);
      else rows.push(`${path.relative(root, fullPath)}|${fileSha256(fullPath)}`);
    }
  };
  visit(root);
  return createHash('sha256').update(rows.join('\n')).digest('hex');
}

test('independent uninstall package removes the installed app while preserving unrelated shortcuts and user data', {
  skip: !enabled
}, () => {
  assert.equal(existsSync(launcherPath), true, `缺少独立卸载包 ${launcherPath}`);
  assert.equal(existsSync(installDir), true, `缺少测试安装 ${installDir}`);
  assert.equal(existsSync(startMenuLink), true, `缺少开始菜单入口 ${startMenuLink}`);
  assert.equal(existsSync(desktopLink), true, `缺少要保护的既有桌面快捷方式 ${desktopLink}`);
  assert.equal(existsSync(isolatedUserData), true, `缺少隔离用户数据 ${isolatedUserData}`);

  const desktopBefore = fileSha256(desktopLink);
  const userDataBefore = treeSha256(defaultUserData);
  const isolatedBefore = treeSha256(isolatedUserData);
  const registryBefore = spawnSync('reg.exe', ['query', uninstallKey], { encoding: 'utf8' });
  assert.equal(registryBefore.status, 0, `缺少测试卸载项 ${uninstallKey}`);

  const result = spawnSync(launcherPath, [], { encoding: 'utf8', timeout: 120_000 });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, `卸载启动器退出码 ${result.status}`);

  assert.equal(existsSync(installDir), false, '安装目录仍然存在');
  assert.equal(existsSync(startMenuLink), false, '开始菜单入口仍然存在');
  assert.equal(existsSync(desktopLink), true, '既有桌面快捷方式被卸载器删除');
  assert.equal(fileSha256(desktopLink), desktopBefore, '既有桌面快捷方式未按字节恢复');
  assert.equal(treeSha256(defaultUserData), userDataBefore, '默认用户数据发生变化');
  assert.equal(treeSha256(isolatedUserData), isolatedBefore, '隔离用户数据发生变化');

  const registryAfter = spawnSync('reg.exe', ['query', uninstallKey], { encoding: 'utf8' });
  assert.notEqual(registryAfter.status, 0, '卸载注册项仍然存在');
});
