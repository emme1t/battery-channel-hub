import { inspectLoadedState } from './app-state.mjs';
import {
  escapeHtml,
  mountReservationPage
} from './reservation-page.mjs';

const root = document.getElementById('reservation-root');
const userName = document.getElementById('current-user');

function renderBlockingState(title, message) {
  root.innerHTML = `
    <section class="blocking-state" role="alert">
      <strong>${escapeHtml(title)}</strong>
      <p>${escapeHtml(message)}</p>
    </section>`;
}

async function boot() {
  if (!window.batteryDesktop) {
    renderBlockingState('桌面接口不可用', '请从 Electron 桌面程序启动，不要直接打开 HTML 文件。');
    return;
  }
  try {
    const loaded = await window.batteryDesktop.loadState();
    const inspected = inspectLoadedState(loaded);
    if (!inspected.ok) {
      renderBlockingState('为保护现有数据，已停止加载', inspected.message);
      return;
    }
    userName.textContent = inspected.state.username || '未登录';
    mountReservationPage(root, window.batteryDesktop, { initialState: inspected.state });
  } catch (error) {
    renderBlockingState('数据读取失败', error.message || '无法读取本机数据，请检查日志。');
  }
}

void boot();
