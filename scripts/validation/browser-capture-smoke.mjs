import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';

const listeners = new Map();
const register = (name) => ({ addListener(handler) { listeners.set(name, handler); } });
const calls = [];
const searchAttempts = new Map();
let nativeStatus = 'accepted';

globalThis.chrome = {
  runtime: {
    id: 'abcdefghijklmnopabcdefghijklmnop',
    lastError: undefined,
    onConnect: register('runtime.onConnect'),
    onMessage: register('runtime.onMessage'),
    onInstalled: register('runtime.onInstalled'),
    onStartup: register('runtime.onStartup'),
    sendNativeMessage(_host, message, callback) {
      // The real client performs ping/capabilities before capture. The former
      // generic response failed at that handshake and never exercised pause,
      // metadata refresh, accepted/cancel or temporary-failure fallback.
      const response = message.action === 'ping'
        ? { ok: true, host: 'lat.cacaplay.cacatools.downloadmanager', protocolVersion: 1, hostVersion: '0.45.4', desktopAppVersion: '0.95.0' }
        : message.action === 'capabilities'
          ? { ok: true, protocolVersion: 1, actions: ['ping', 'capabilities', 'browser_download_capture', 'get_status'], sourceTypes: ['direct_file', 'generic_url'], spotifyEnabled: false }
          : { ok: ['accepted', 'review_opened'].includes(nativeStatus), status: nativeStatus };
      setTimeout(() => callback(response), 0);
    }
  },
  storage: { local: { get: async (defaults) => ({ ...defaults, browserCaptureMode: 'automatic' }), set: async () => {}, remove: async () => {} } },
  downloads: {
    onCreated: register('downloads.onCreated'),
    onDeterminingFilename: register('downloads.onDeterminingFilename'),
    onChanged: register('downloads.onChanged'),
    onErased: register('downloads.onErased'),
    pause(id, callback) { calls.push(`pause:${id}`); callback(); },
    resume(id, callback) { calls.push(`resume:${id}`); callback(); },
    cancel(id, callback) { calls.push(`cancel:${id}`); callback(); },
    search(query, callback) {
      const id = Number(query?.id || 0);
      const attempt = (searchAttempts.get(id) || 0) + 1;
      searchAttempts.set(id, attempt);
      const pdf = id === 11;
      if (id === 10 && attempt === 1) {
        callback([{ id, url: 'https://example.com/file.zip', finalUrl: '', filename: 'Unconfirmed 7788.crdownload', mime: '', state: 'in_progress' }]);
        return;
      }
      callback([{ id, url: `https://example.com/file.${pdf ? 'pdf' : 'zip'}`, finalUrl: `https://example.com/file.${pdf ? 'pdf' : 'zip'}`, filename: `file.${pdf ? 'pdf' : 'zip'}`, mime: pdf ? 'application/pdf' : 'application/zip', state: 'in_progress' }]);
    }
  },
  scripting: { executeScript: async () => {} },
  tabs: { query: async () => [], get: async () => ({ url: 'https://example.com' }), onActivated: register('tabs.onActivated'), onUpdated: register('tabs.onUpdated'), sendMessage: async () => ({ detections: [] }) },
  sidePanel: { setPanelBehavior: async () => {} }
};

await import(`${pathToFileURL('extension/service-worker.js').href}?capture-smoke=${Date.now()}`);
const created = listeners.get('downloads.onCreated');
assert.equal(typeof created, 'function');

await created({ id: 10, url: 'https://example.com/file.zip', finalUrl: 'https://example.com/file.zip', filename: 'file.zip', mime: 'application/zip', state: 'in_progress', startTime: 'now', incognito: false });
await new Promise((resolve) => setTimeout(resolve, 140));
assert.deepEqual(calls, ['pause:10', 'cancel:10']);
assert.equal(searchAttempts.get(10), 2, 'debe reintentar metadatos cuando Chrome aún reporta .crdownload');

nativeStatus = 'review_opened';
const determining = listeners.get('downloads.onDeterminingFilename');
assert.equal(typeof determining, 'function');
let suggested = 0;
const asyncFilenameDecision = determining({ id: 12, url: 'https://example.com/setup.exe', finalUrl: 'https://example.com/setup.exe', filename: 'setup.exe', mime: 'application/x-msdownload', state: 'in_progress', startTime: 'review', incognito: false }, () => { suggested += 1; });
assert.equal(asyncFilenameDecision, true, 'La extensión debe mantener abierto el evento mientras confirma la captura');
await new Promise((resolve) => setTimeout(resolve, 40));
assert.equal(suggested, 1, 'La sugerencia de nombre debe resolverse exactamente una vez');
assert.ok(calls.includes('cancel:12'), 'La copia de Chromium debe cancelarse después de abrir la revisión HTTP');
assert.equal(calls.includes('pause:12'), false, 'La decisión temprana de nombre no debe pausar la descarga');

nativeStatus = 'temporary_failure';
await created({ id: 11, url: 'https://example.com/file.pdf', finalUrl: 'https://example.com/file.pdf', filename: 'file.pdf', mime: 'application/pdf', state: 'in_progress', startTime: 'later', incognito: false });
await new Promise((resolve) => setTimeout(resolve, 20));
// An uncertain/temporary host response deliberately leaves the browser copy
// paused; resuming could create two transfers before the user reviews CDM.
assert.deepEqual(calls, ['pause:10', 'cancel:10', 'cancel:12', 'pause:11']);

console.log('OK: captura HTTP temprana abre revisión, cancela la copia aceptada y conserva la pausa ante resultado incierto.');
