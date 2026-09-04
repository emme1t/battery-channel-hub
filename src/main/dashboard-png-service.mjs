import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const PNG_PREFIX = 'data:image/png;base64,';
const PNG_SIGNATURE = '89504e470d0a1a0a';
const MAX_PNG_BYTES = 12 * 1024 * 1024;

function invalidPng(message) {
  return Object.assign(new Error(message), { code: 'DASHBOARD_PNG_INVALID' });
}

function pngBytes(dataUrl) {
  if (typeof dataUrl !== 'string' || !dataUrl.startsWith(PNG_PREFIX)) {
    throw invalidPng('及时率图片格式无效');
  }
  const bytes = Buffer.from(dataUrl.slice(PNG_PREFIX.length), 'base64');
  if (!bytes.length || bytes.length > MAX_PNG_BYTES || bytes.subarray(0, 8).toString('hex') !== PNG_SIGNATURE) {
    throw invalidPng('及时率图片内容无效或过大');
  }
  return bytes;
}

export function createDashboardPngService(options = {}) {
  const saveDialog = options.dialog?.showSaveDialog;
  if (typeof saveDialog !== 'function') throw new TypeError('dashboard PNG dialog is required');
  return {
    async exportPng(payload = {}) {
      const bytes = pngBytes(payload.dataUrl);
      const requestedName = path.basename(String(payload.defaultFileName || '测试及时率.png'));
      const defaultFileName = requestedName.toLowerCase().endsWith('.png') ? requestedName : `${requestedName}.png`;
      const selection = await saveDialog({
        title: '导出及时率趋势 PNG',
        defaultPath: defaultFileName,
        filters: [{ name: 'PNG 图片', extensions: ['png'] }]
      });
      if (selection.canceled || !selection.filePath) return { ok: false, canceled: true };
      const filePath = path.resolve(selection.filePath);
      await writeFile(filePath, bytes);
      const verified = await readFile(filePath);
      if (!verified.equals(bytes)) throw Object.assign(new Error('及时率图片写后校验失败'), { code: 'DASHBOARD_PNG_VERIFY_FAILED' });
      return { ok: true, canceled: false, filePath, bytes: verified.length };
    }
  };
}
