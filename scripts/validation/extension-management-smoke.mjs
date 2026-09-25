import assert from 'node:assert/strict';
import { configureExtension, processExtensionBridgeRequests } from '../../app-ui/modules/extension/index.js';

globalThis.window = {
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval
};

const calls = [];
const toasts = [];
const job = { id: 42, title: 'Archivo de prueba.mp4', status: 'completed', destination: 'C:\\Downloads\\Archivo de prueba.mp4', kind: 'video' };
let pending = [{ action: 'open_player', payload: { jobId: 42, mode: 'play', windowMode: 'background' } }];
const appState = { snapshot: { jobs: [job], queue: {} }, appearance: { theme: 'dark', accent: '#00ff2a' } };

configureExtension({
  getAppState: () => appState,
  async invoke(command, args) {
    calls.push({ command, args });
    if (command === 'drain_extension_bridge_requests') return pending.splice(0);
    if (command === 'load_snapshot') return undefined;
    if (command === 'accept_browser_download_capture') return { ok: true, status: 'review_opened' };
    return undefined;
  },
  async loadSnapshot() { calls.push({ command: 'loadSnapshot' }); },
  render() { calls.push({ command: 'render' }); },
  async routeDownloadAnalysis(...args) { calls.push({ command: 'routeDownloadAnalysis', args }); },
  showToast(message, type) { toasts.push({ message, type }); },
  previewMode: false,
  downloadManagerVisualPreferences: () => ({ theme: 'dark', accent: '#00ff2a' })
});

await processExtensionBridgeRequests();
assert.equal(calls.filter((entry) => entry.command === 'open_media_player').length, 1, 'Reproducir no abrió el reproductor exactamente una vez');
assert.equal(calls.some((entry) => entry.command === 'wake_main_window'), false, 'Reproducir no debe despertar el gestor principal');

pending = [{ action: 'job_action', payload: { jobId: 42, action: 'pause', windowMode: 'background' } }];
await processExtensionBridgeRequests();
assert.ok(calls.some((entry) => entry.command === 'set_job_status' && entry.args.id === 42 && entry.args.status === 'paused'), 'La acción pause no llegó al comando existente');

pending = [{ action: 'enqueue', payload: { sourceType: 'playlist', windowMode: 'foreground', items: [{ type: 'playlist', mediaUrl: 'https://www.youtube.com/playlist?list=PL123456', canonicalUrl: 'https://www.youtube.com/playlist?list=PL123456' }] } }];
await processExtensionBridgeRequests();
assert.ok(calls.some((entry) => entry.command === 'routeDownloadAnalysis' && entry.args[0].includes('/playlist?list=PL123456')), 'La playlist detectada no conservó su ruta de preparación');
assert.equal(calls.some((entry) => entry.command === 'queue_playlist_selection' && entry.args?.items?.some((item) => item.sourceUrl.includes('/playlist?'))), false, 'La playlist detectada no debe convertirse en un item manual');

pending = [{ action: 'browser_download_capture', id: 'capture-1', payload: { windowMode: 'foreground', url: 'https://example.com/file.exe', filename: 'file.exe' } }];
await processExtensionBridgeRequests();
assert.ok(calls.some((entry) => entry.command === 'accept_browser_download_capture'), 'La captura HTTP debe abrirse a través del comando de revisión existente');
assert.ok(toasts.some((entry) => entry.message.includes('ventana HTTP')), 'El usuario debe recibir la indicación de confirmar la descarga en la ventana HTTP');

console.log('OK: reproducción interna y acción de job pasan por el adapter de la app sin abrir el gestor principal.');
