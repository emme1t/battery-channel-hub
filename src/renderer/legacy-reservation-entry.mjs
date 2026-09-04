import { mountLegacyReservationWorkspace } from './legacy-reservation-workspace.mjs';
import { installLegacyBoundedViews } from './legacy-bounded-views.mjs';

installLegacyBoundedViews(window);

let workspace = null;
let mounting = null;

async function ensureWorkspace() {
  if (mounting) return mounting;
  mounting = (async () => {
    const root = document.getElementById('legacyReservationRoot');
    const page = document.getElementById('apply');
    if (!root || !page) throw new Error('原 MAIN 预约挂载点不存在');
    const state = await window.batteryDesktop.loadState();
    if (workspace) {
      workspace.replaceState(state);
    } else {
      workspace = mountLegacyReservationWorkspace(root, window.batteryDesktop, {
        initialState: state,
        confirmAction: message => window.confirm(message),
        onStateChange: nextState => window.adoptLegacyReservationState?.(nextState),
        notify: message => window.toast?.(message)
      });
      window.__legacyReservationWorkspace = workspace;
    }
    page.classList.add('legacy-workspace-mounted');
    return workspace;
  })();
  try {
    return await mounting;
  } finally {
    mounting = null;
  }
}

window.mountLegacyReservationWorkspaceApp = ensureWorkspace;

const previousGo = window.go;
window.go = function(id) {
  previousGo(id);
  if (id === 'apply') {
    void ensureWorkspace().catch(error => {
      document.getElementById('apply')?.classList.remove('legacy-workspace-mounted');
      window.toast?.(error.message || '预约页面加载失败');
      console.error(error);
    });
  }
};

window.quick = async function(encodedChannelKey) {
  window.go('apply');
  const instance = await ensureWorkspace();
  const state = instance.getState();
  const request = state.requests.find(item =>
    state.samples.some(sample => String(sample.requestNo) === String(item.id ?? item.requestNo) && sample.status === 'pending')
  );
  if (request) instance.openRequest(String(request.id ?? request.requestNo));
  if (!request) window.toast?.(`通道 ${decodeURIComponent(encodedChannelKey)} 当前没有可预约的申请子样品`);
};
