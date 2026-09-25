import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';

const listeners = new Map();
const register = (name) => ({ addListener(handler) { listeners.set(name, handler); } });
const storage = {};
const nativeMessages = [];
let reloadCalled = false;
const sidePanelCalls = [];
const popupCalls = [];

globalThis.chrome = {
  runtime: {
    id: 'aonppfnabjnicjjeoofkfjofolfibggp',
    lastError: undefined,
    onConnect: register('runtime.onConnect'),
    onMessage: register('runtime.onMessage'),
    onInstalled: register('runtime.onInstalled'),
    onStartup: register('runtime.onStartup'),
    onUpdateAvailable: register('runtime.onUpdateAvailable'),
    getManifest: () => ({ version: '0.95.4' }),
    getURL: (path) => `chrome-extension://aonppfnabjnicjjeoofkfjofolfibggp/${path}`,
    reload() { reloadCalled = true; },
    sendNativeMessage(_host, message, callback) {
      nativeMessages.push(message);
      // Keep the fixture aligned with the production protocol. The former
      // one-shape `{ok:true}` mock could never prove host identity or protocol
      // compatibility and only masked stale handshake assertions.
      const response = message.action === 'ping'
        ? { ok: true, host: 'lat.cacaplay.cacatools.downloadmanager', protocolVersion: 1, hostVersion: '0.45.4', desktopAppVersion: '0.95.4' }
        : message.action === 'capabilities'
          ? { ok: true, protocolVersion: 1, actions: ['ping', 'capabilities', 'enqueue', 'analyze', 'browser_download_capture', 'open_app', 'activate_app', 'open_job', 'open_player', 'list_jobs', 'job_action', 'set_job_options', 'get_status'], sourceTypes: ['video', 'audio', 'playlist', 'direct_file', 'generic_url'] }
          : message.action === 'get_status'
            ? { ok: true, appRunning: true, state: { appVersion: '0.95.4', updatedAt: Date.now(), jobs: [{ id: 12, status: 'completed' }, { id: 13, status: 'running' }], playlist_batches: [], appearance: { theme: 'dark', accent: '#5f73ff' } } }
            : { ok: true, status: 'accepted' };
      setTimeout(() => callback(response), 0);
    }
  },
  storage: {
    local: {
      async get(defaults) { return { ...defaults, ...storage }; },
      async set(values) { Object.assign(storage, values); },
      async remove(key) { delete storage[key]; }
    }
  },
  downloads: {
    onCreated: register('downloads.onCreated'),
    onChanged: register('downloads.onChanged'),
    onErased: register('downloads.onErased'),
    pause(_id, callback) { callback(); },
    resume(_id, callback) { callback(); },
    cancel(_id, callback) { callback(); }
  },
  scripting: { executeScript: async () => {} },
  tabs: {
    query: async (query = {}) => query.windowId === 10 ? [{ id: 18, windowId: 10, url: 'https://www.youtube.com/' }] : [],
    get: async (id) => id === 18 ? { id, windowId: 10, url: 'https://www.youtube.com/' } : { id, url: 'https://example.com' },
    onActivated: register('tabs.onActivated'),
    onCreated: register('tabs.onCreated'),
    onUpdated: register('tabs.onUpdated'),
    sendMessage: async () => ({ detections: [] }),
    create: async (options) => { popupCalls.push({ type: 'tab', options }); return {}; }
  },
  windows: {
    onCreated: register('windows.onCreated'),
    onRemoved: register('windows.onRemoved'),
    getAll: async () => [{ id: 10, type: 'app', tabs: [{ id: 18, windowId: 10, url: 'https://www.youtube.com/' }] }],
    get: async (windowId) => {
      if (windowId === 11) throw new Error('Window metadata unavailable');
      return { id: windowId, type: windowId === 10 ? 'app' : 'normal' };
    },
    create: async (options) => { popupCalls.push({ type: 'window', options }); return {}; }
  },
  action: { onClicked: register('action.onClicked') },
  sidePanel: {
    async setPanelBehavior(options) { sidePanelCalls.push({ type: 'behavior', options }); },
    async setOptions(options) { sidePanelCalls.push({ type: 'options', options }); },
    async open(options) { sidePanelCalls.push({ type: 'open', options }); }
  }
};

const module = await import(`${pathToFileURL('extension/service-worker.js').href}?sync-smoke=${Date.now()}`);
assert.equal(typeof module.sendSelectionToApp, 'function');
await new Promise((resolve) => setTimeout(resolve, 0));
assert.ok(sidePanelCalls.some((entry) => entry.type === 'behavior' && entry.options?.openPanelOnActionClick === true), 'Chromium debe abrir el panel lateral dentro del gesto nativo del clic');
const actionListener = listeners.get('action.onClicked');
assert.equal(typeof actionListener, 'function');
actionListener({ id: 17, windowId: 9, url: 'https://example.com' });
await new Promise((resolve) => setTimeout(resolve, 0));
assert.equal(popupCalls.length, 0, 'Una pestaña normal debe conservar el panel lateral, no abrir una ventana');
assert.equal(sidePanelCalls.some((entry) => entry.type === 'open'), false, 'La pestaña normal debe usar la apertura nativa y no perder el gesto del clic');
const appWindowSidePanelOpens = sidePanelCalls.filter((entry) => entry.type === 'open').length;
actionListener({ id: 18, windowId: 10 });
await new Promise((resolve) => setTimeout(resolve, 0));
assert.equal(sidePanelCalls.filter((entry) => entry.type === 'open').length, appWindowSidePanelOpens, 'Una ventana PWA no debe abrir el panel lateral');
assert.ok(sidePanelCalls.some((entry) => entry.type === 'options' && entry.options?.tabId === 18 && entry.options?.enabled === false), 'La pestaña PWA debe desactivar el panel antes del acceso alternativo');
assert.ok(popupCalls.some((entry) => entry.type === 'window' && entry.options?.url?.includes('/sidepanel.html?sourceTabId=18') && entry.options?.type === 'popup'), 'El clic desde una ventana PWA debe abrir una ventana aislada conservando la pestaña origen');
actionListener({ id: 19, windowId: 11, url: 'https://example.com' });
await new Promise((resolve) => setTimeout(resolve, 0));
assert.equal(popupCalls.some((entry) => entry.options?.url?.includes('/sidepanel.html?sourceTabId=19')), false, 'Una pestaña normal sin clasificación no debe convertirse en popup');
const result = await module.sendSelectionToApp([
  { id: 'one', type: 'video', title: 'Vídeo uno', mediaUrl: 'https://www.youtube.com/watch?v=one', selected: true },
  { id: 'two', type: 'video', title: 'Vídeo dos', mediaUrl: 'https://www.youtube.com/watch?v=two', selected: true }
], {
  preferredQuality: '1080p',
  preferredFormat: 'auto',
  windowMode: 'foreground',
  manualPlaylist: true,
  playlistTitle: 'Mi lista'
});
assert.equal(result.ok, true, JSON.stringify(result));
const enqueue = nativeMessages.find((message) => message.action === 'enqueue');
assert.ok(enqueue, 'No se envió la colección al host nativo');
assert.equal(enqueue.payload.windowMode, 'foreground');
assert.equal(enqueue.payload.manualPlaylist, true);
assert.equal(enqueue.payload.playlistTitle, 'Mi lista');
assert.equal(enqueue.payload.items.length, 2);
assert.equal(enqueue.payload.sourceType, 'playlist');
assert.equal(enqueue.payload.provider, 'youtube');
assert.ok(enqueue.payload.commandId && enqueue.payload.idempotencyKey, 'Faltan claves de idempotencia del envío');
assert.equal(nativeMessages.some((message) => message.action === 'open_app'), false, 'El envío no debe abrir la app por una llamada adicional');

const messageListener = listeners.get('runtime.onMessage');
assert.equal(typeof messageListener, 'function');

await new Promise((resolve, reject) => {
  const asyncResponse = messageListener({ type: 'OPEN_JOB', jobId: 12, mode: 'play' }, {}, (response) => {
    try { assert.equal(response.ok, true); resolve(); } catch (error) { reject(error); }
  });
  assert.equal(asyncResponse, true);
});
assert.equal(nativeMessages.filter((message) => message.action === 'open_player').length, 1, 'Reproducir debe usar open_player una sola vez');

await new Promise((resolve, reject) => {
  const asyncResponse = messageListener({ type: 'JOB_ACTION', jobId: 13, action: 'pause' }, {}, (response) => {
    try { assert.equal(response.ok, true); resolve(); } catch (error) { reject(error); }
  });
  assert.equal(asyncResponse, true);
});
assert.equal(nativeMessages.filter((message) => message.action === 'job_action').length, 1, 'La acción de job debe llegar una sola vez');

const updateListener = listeners.get('runtime.onUpdateAvailable');
assert.equal(typeof updateListener, 'function');
updateListener({ version: '0.95.4' });
await new Promise((resolve) => setTimeout(resolve, 0));
assert.equal(storage.pendingExtensionUpdate.version, '0.95.4');

await new Promise((resolve, reject) => {
  const asyncResponse = messageListener({ type: 'GET_APP_STATUS' }, {}, (response) => {
    try {
      assert.equal(response.ok, true);
      assert.equal(response.result.appRunning, true);
      resolve();
    } catch (error) { reject(error); }
  });
  assert.equal(asyncResponse, true);
});

await new Promise((resolve, reject) => {
  const asyncResponse = messageListener({ type: 'APPLY_EXTENSION_UPDATE' }, {}, (response) => {
    try { assert.equal(response.applying, true); resolve(); } catch (error) { reject(error); }
  });
  assert.equal(asyncResponse, true);
});
await new Promise((resolve) => setTimeout(resolve, 70));
assert.equal(reloadCalled, true);

console.log('OK: apertura del panel, sincronización y acciones pasan la simulación de las API de extensión Chromium.');
