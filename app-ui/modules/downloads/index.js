let downloadsContext = {};
let appState = {};
let previewMode = false;

const contextValue = (name, fallback) => downloadsContext[name] || fallback;
const invoke = (...args) => contextValue('invoke', async () => {})(...args);
const showToast = (...args) => contextValue('showToast', () => {})(...args);
const friendlyError = (...args) => contextValue('friendlyError', (value) => String(value ?? ''))(...args);

// The preparation surface is native-only. There is deliberately no HTML
// fallback here: the old integrated workspace was a second implementation of
// the same flow and could reappear after the main window was rerendered.
const nativePreparationRuntime = () => Boolean(globalThis.window?.__TAURI__?.core?.invoke);

export function configureDownloads(context = {}) {
  downloadsContext = context;
  appState = context.getAppState?.() || {};
  previewMode = Boolean(context.previewMode);
}

function downloadManagerVisualPreferences() {
  try {
    const value = JSON.parse(localStorage.getItem('cacatools.download-manager.v2') || '{}');
    const theme = value.theme === 'light'
      ? 'light'
      : value.theme === 'system' && window.matchMedia?.('(prefers-color-scheme: light)').matches
        ? 'light'
        : 'dark';
    return { theme, accent: appState.appearance?.accent || '', layout: 'zen-sidebar' };
  } catch {
    return { theme: 'system', accent: appState.appearance?.accent || '#24b8e8', layout: 'zen-sidebar' };
  }
}

function previewOnlyPreparationNotice() {
  showToast('La preparación multimedia se abre como ventana nativa en la aplicación de escritorio.', 'info');
}

async function openNativePreparationWindow(source = '', metadata = {}, kind = 'media') {
  const cleanSource = String(source || '').trim();
  try {
    contextValue('onBeforeOpenPreparation', () => {})();
    const options = metadata && typeof metadata === 'object'
      ? {
        windowMode: metadata.windowMode || metadata.windowBehavior || '',
        preferredQuality: metadata.preferredQuality || '',
        preferredFormat: metadata.preferredFormat || '',
        filename: metadata.filename || '',
        mime: metadata.mime || '',
        expectedExtension: metadata.expectedExtension || '',
        title: metadata.title || '',
        pageTitle: metadata.pageTitle || ''
      }
      : {};
    await invoke('open_preparation_window', {
      kind,
      source: cleanSource,
      options
    });
  } catch (error) {
    console.error('Native preparation window could not be opened.', error);
    showToast(`No se pudo abrir la ventana de preparacion: ${friendlyError(error)}`, 'error');
  }
}

let linkRouteRequestId = 0;

function normalizeLinkSource(source) {
  const value = String(source || '').trim();
  if (!/^https?:\/\//i.test(value)) return '';
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) ? url.toString() : '';
  } catch {
    return '';
  }
}

/**
 * Single URL authority for paste, explicit actions, extension handoff and
 * clipboard suggestions. It intentionally delegates type detection to the
 * existing backend inspection command instead of maintaining a second list of
 * providers in the UI.
 */
async function inspectLinkIntent(source) {
  const cleanSource = normalizeLinkSource(source);
  if (!cleanSource) {
    return { status: 'unsupported', kind: 'unsupported', source: '' };
  }
  const inspected = await invoke('inspect_download_url', { url: cleanSource });
  const playlistHint = /[?&](?:list|playlist|album)=|\/playlist(?:[/?]|$)/i.test(cleanSource);
  const kind = inspected?.kind === 'playlist' || playlistHint
    ? 'playlist'
    : inspected?.requires_media_resolver || inspected?.kind === 'media'
      ? 'media'
      : 'direct';
  return { status: 'classified', kind, source: cleanSource, inspection: inspected };
}

export async function classifyLinkIntent(source) {
  try {
    return await inspectLinkIntent(source);
  } catch (error) {
    return { status: 'error', kind: 'unknown', source: normalizeLinkSource(source), error };
  }
}

export async function routeLinkIntent(source, metadata = {}) {
  const cleanSource = normalizeLinkSource(source);
  if (!cleanSource) {
    showToast('Pega un enlace HTTP o HTTPS válido.', 'error');
    return { status: 'unsupported', kind: 'unsupported' };
  }
  const requestId = ++linkRouteRequestId;
  try {
    const suppliedIntent = metadata?.__linkIntent;
    const intent = suppliedIntent?.source === cleanSource
      ? suppliedIntent
      : await inspectLinkIntent(cleanSource);
    if (requestId !== linkRouteRequestId) return { status: 'stale', kind: 'stale' };
    if (intent.kind === 'unknown' || intent.kind === 'unsupported') {
      throw intent.error || new Error('El enlace no es compatible.');
    }
    const { __linkIntent: _privateIntent, ...windowMetadata } = metadata || {};
    await openNativePreparationWindow(cleanSource, windowMetadata, intent.kind);
    return { status: 'opened', kind: intent.kind, inspection: intent.inspection };
  } catch (error) {
    if (requestId !== linkRouteRequestId) return { status: 'stale', kind: 'stale' };
    console.error('No se pudo enrutar el enlace.', error);
    showToast(`No se pudo preparar el enlace: ${friendlyError(error)}`, 'error');
    return { status: 'error', kind: 'error', error };
  }
}

export async function openInternalDownloadWorkspace(source = '') {
  const cleanSource = String(source || '').trim();
  if (nativePreparationRuntime() || !previewMode) {
    if (cleanSource) await routeLinkIntent(cleanSource);
    else await openNativePreparationWindow('');
    return;
  }
  previewOnlyPreparationNotice();
}

export async function routeDownloadAnalysis(source, metadata = {}) {
  const cleanSource = String(source || '').trim();
  if (!cleanSource) return openInternalDownloadWorkspace();
  if (nativePreparationRuntime() || !previewMode) {
    await routeLinkIntent(cleanSource, metadata);
    return;
  }
  previewOnlyPreparationNotice();
}

export {
  downloadManagerVisualPreferences,
  nativePreparationRuntime
};
