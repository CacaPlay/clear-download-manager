import { renderDownloadManager, bindDownloadManager, patchDownloadManagerAppearance, patchDownloadManagerLive, forceDownloadManagerAllView, clearDownloadManagerSearchState, setOptimisticJobStatus, isTransientUiOpen } from './download-manager/index.js?v=0.95.0-verify-20260911-r5';
import { runtimeState } from './download-manager/state.js';
import { clearFloatingLayer } from './download-manager/floating.js';
import {
  configureAppearance, appearancePresets, defaultAppearance, APPEARANCE_REVISION, THUMBNAIL_CACHE_VERSION,
  visualDiagnosticsSnapshot, bindVisualDiagnostics, thumbnailSrc, clamp,
  displayedScalePercent, normalizeAppearance, loadStoredAppearance, storeAppearanceLocally,
  automaticScalePercent, scheduleAppearanceLivePreview, applyAppearance, markAppearancePersistence
} from './modules/appearance/index.js?v=0.95.0-verify-20260911-r4';
import { bindAppearanceSync } from './modules/appearance/sync.js?v=0.95.0-verify-appearance';
import { configureSettings, settingsMarkup, setSettingsAdvancedOpen } from './modules/settings/index.js?v=0.95.0-verify-20260911-r3';
import {
  configureMedia, mediaSizeLabel, outputModeIsAudio, preferredVideoFormat, preferredFormatForOutput
} from './modules/media/index.js';
import {
  configurePlaylist, selectedPlaylistSizeSummary, startPlaylistSizeAnalysis,
  selectedPlaylistItems, stablePlaylistThumbnail, hydratePlaylistRuntimeItem,
  playlistPreviewUrl, playlistPlayableThumb, bindPlaylistPreviewButtons
} from './modules/playlists/index.js';
import {
  configureExtension, processExtensionBridgeRequests, scheduleExtensionStatePublish
} from './modules/extension/index.js';
import {
  configureDownloads, downloadManagerVisualPreferences, openInternalDownloadWorkspace,
  classifyLinkIntent, routeDownloadAnalysis, routeLinkIntent
} from './modules/downloads/index.js';
import { createPromptCoordinator, createClipboardFocusWatcher } from './modules/link-intake/index.js';
import { bindDestinationPickerState, chooseDestinationDirectory } from './modules/downloads/destination-picker.js?v=0.45.1';
import {
  DEFAULT_EXPERIENCE_SETTINGS,
  buildNewsInbox,
  markNewsViewed,
  NEWS_FEED_CACHE_KEY,
  newsAttention,
  newsCachePatch,
  normalizeExperienceSettings,
  parseCachedNews,
  recordInstalledUpdate,
  validateRemoteNewsFeed
} from './modules/news/index.js';
import {
  configureRuntime, snapshotSignature, bindDynamicListEvents,
  loadSnapshot, startSnapshotRefreshLoop,
  rememberQueueSpeed, animateDownloadProgressBars, runProgressAcceptanceAutopilot
} from './modules/runtime/index.js?v=0.95.0-verify-20260911-r3';
import {
  configureComposition, render, bindThumbnailFallbacks, start
} from './modules/composition/index.js?v=0.95.0-verify-20260911-r3';
import { formatLocaleDate, loadLocale, messagesFor, resolveLocale, saveLocale, translate } from './modules/i18n/index.js';
import { localizeDom } from './modules/i18n/runtime.js';

// CDM uses its own context menus for downloads and no browser context menu on
// empty content. Keep this at document capture phase so every main-view area
// (including settings and What's New) behaves consistently.
document.addEventListener('contextmenu', (event) => event.preventDefault(), true);
const qs = new URLSearchParams(window.location.search);
const previewMode = qs.has('preview');
const previewView = qs.get('view') || 'home';
const previewAccent = qs.get('accent') || '';
const previewPreset = qs.get('preset') || '';
configureAppearance({ previewAccent, previewPreset, getAppState: () => appState, onDownloadManagerAppearance: patchDownloadManagerAppearance });
const APP_VERSION = '0.95.4';
const storeManagedDistribution = document.querySelector('meta[name="cdm-distribution"]')?.content === 'microsoft-store';
const initialLocale = loadLocale();
const BUILD_ID = 'CDM-0.95.4-20260922-release-migration';
let deferredDownloadManagerRefresh = false;
let deferredDownloadManagerRefreshTimer = 0;
let snapshotRefreshTimer = 0;
let lastFullSnapshotAt = 0;
const DOWNLOAD_ACTIVITY_REFRESH_MS = 250;
const BACKGROUND_SNAPSHOT_REFRESH_MS = 1000;
const FULL_SNAPSHOT_REFRESH_MS = 15_000;
function settingsEditingIsActive() {
  const active = document.activeElement;
  return active instanceof HTMLElement && active.matches('.settings-workspace input, .settings-workspace select, .settings-workspace textarea, .settings-workspace [contenteditable="true"]');
}
function currentLocale() { return appState.experienceSettings?.locale || initialLocale || 'system'; }
function t(key, ...args) { return translate(currentLocale(), key, ...args); }
function downloadManagerInteractionIsActive() {
  const active = document.activeElement;
  const editing = active instanceof HTMLElement && (
    active.matches('[data-dm-unified-input], .dm-settings-popover input, .dm-settings-popover select, .dm-modal input, .dm-modal select, .settings-workspace input, .settings-workspace select, .settings-workspace textarea')
    || active.isContentEditable
  );
  return Boolean(
    isTransientUiOpen()
    || settingsEditingIsActive()
    || editing
    || document.querySelector(
      '.dm-row-menu-floating:not([hidden]), .dm-add-menu:not([hidden]), .dm-settings-popover:not([hidden]), .dm-modal-backdrop:not([hidden]), .dm-category-menu:not([hidden]), .dm-category-control.is-open'
    )
  );
}
function flushDeferredDownloadManagerRefresh() {
  window.clearTimeout(deferredDownloadManagerRefreshTimer);
  deferredDownloadManagerRefreshTimer = window.setTimeout(() => {
    if (!deferredDownloadManagerRefresh || downloadManagerInteractionIsActive()) return;
    deferredDownloadManagerRefresh = false;
    render();
  }, 140);
}
function requestDownloadManagerRender({ force = false } = {}) {
  // Status/news refreshes must never replace a transient control while it is
  // open or owns focus. The `force` flag only bypasses normal coalescing; it
  // must not bypass this interaction boundary.
  if (downloadManagerInteractionIsActive()) {
    deferredDownloadManagerRefresh = true;
    flushDeferredDownloadManagerRefresh();
    return false;
  }
  deferredDownloadManagerRefresh = false;
  render();
  return true;
}
// Deterministic browser gates use this preview-only hook to exercise the same
// refresh boundary that the native timers call. It is never exposed in the
// packaged runtime.
if (previewMode) window.__cacatoolsRequestDownloadManagerRender = requestDownloadManagerRender;
function patchCurrentDownloadManagerLive(changedJobIds = null) {
  if (!document.querySelector('.dm-host')) return false;
  return patchDownloadManagerLive({
    snapshot: appState.snapshot,
    pendingJobs: appState.pendingJobs,
    runtimeStatus: appState.runtimeStatus,
    mediaRuntimeStatus: appState.mediaRuntimeStatus,
    downloadDirectory: appState.downloadDirectory,
    schedules: appState.downloadSchedules,
    changedJobIds,
    progressEngineStatus: appState.progressEngineStatus
  });
}
// Preview-only deterministic state harness. It exercises the same keyed live
// patch path as native refreshes without adding a production command or state
// authority. The harness is intentionally unavailable in packaged runtime.
if (previewMode) {
  window.__cacatoolsMotionStateHarness = {
    setJobState(id, patch = {}) {
      const job = appState.snapshot?.jobs?.find((entry) => String(entry.id) === String(id));
      if (!job || !patch || typeof patch !== 'object') return false;
      Object.assign(job, patch);
      patchCurrentDownloadManagerLive(new Set([String(id)]));
      return true;
    },
    rowState(id) {
      const row = document.querySelector(`.dm-download-item[data-dm-select-job="${CSS.escape(String(id))}"]`);
      return row ? {
        state: row.dataset.dmState || '',
        visualState: row.dataset.dmVisualState || '',
        transition: row.dataset.statusTransition || '',
        active: row.classList.contains('dm-status-transition-active')
      } : null;
    }
  };
}
async function refreshDownloadManager({ liveOnly = false, changedJobIds = null } = {}) {
  await loadSnapshot({ includeSchedules: false, activityOnly: false });
  if (liveOnly && document.querySelector('.dm-host')) patchCurrentDownloadManagerLive(changedJobIds);
  else requestDownloadManagerRender();
}
const AUTO_UPDATE_STORAGE_KEY = 'cacatools.desktop.auto-update.v1';
const LAST_UPDATE_CHECK_KEY = 'cacatools.desktop.update-check.v1';
const UPDATE_NOTIFICATION_KEY = 'clear-download-manager/update-notified-v1';
const LEGACY_EXPERIENCE_MIGRATION_KEY = 'cacatools.experience-v1-migrated';
function playlistMetadata(item = {}) {
  const source = item && typeof item === 'object' ? item : {};
  return [source.creator, source.album, source.duration || source.duration_label]
    .map((value) => String(value || '').trim())
    .filter(Boolean)
    .join(' · ');
}
function playlistResolutionLabel(item = {}) {
  const source = item && typeof item === 'object' ? item : {};
  const state = String(source.resolutionState || source.resolution_state || '').toLocaleLowerCase();
  if (state === 'ready') return '';
  if (state === 'ambiguous') return 'Revisar coincidencia';
  if (state === 'not_found') return 'Sin coincidencia';
  if (['failed', 'metadata_incomplete', 'incomplete'].includes(state)) return 'No resuelta';
  return 'Resolviendo';
}
function loadAutoUpdatePreference() {
  try { return localStorage.getItem(AUTO_UPDATE_STORAGE_KEY) !== '0'; } catch { return true; }
}
function saveAutoUpdatePreference(enabled) {
  try { localStorage.setItem(AUTO_UPDATE_STORAGE_KEY, enabled ? '1' : '0'); } catch {}
}
function shouldCheckForAppUpdate() {
  const last = Number(appState.experienceSettings?.lastUpdateCheckAt || 0);
  return !last || Date.now() - last >= 6 * 60 * 60 * 1000;
}
function markAppUpdateCheck() {
  const timestamp = Date.now();
  appState.experienceSettings = normalizeExperienceSettings({ ...(appState.experienceSettings || {}), lastUpdateCheckAt: timestamp });
  void persistExperienceSettings({ lastUpdateCheckAt: timestamp });
  try { localStorage.setItem(LAST_UPDATE_CHECK_KEY, String(timestamp)); } catch {}
}
function dismissAvailableAppUpdate() {
  requestDownloadManagerRender({ force: true });
}
const ICON_PATHS = Object.freeze({
  home: '<path d="M3 11.5 12 4l9 7.5"/><path d="M5.5 10.5V20h13v-9.5"/><path d="M9.5 20v-6h5v6"/>',
  download: '<path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M4 20h16"/>',
  http: '<path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M4 20h16"/><path d="M4 6h4M16 6h4"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m16.2 16.2 4.3 4.3"/>',
  file: '<path d="M6 2h8l4 4v16H6z"/><path d="M14 2v5h5"/>',
  image: '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="2"/><path d="m21 15-5-5L5 20"/>',
  tools: '<path d="M4 6h16M4 12h16M4 18h16"/><circle cx="8" cy="6" r="2"/><circle cx="15" cy="12" r="2"/><circle cx="11" cy="18" r="2"/>',
  library: '<rect x="3" y="4" width="5" height="16" rx="1"/><rect x="10" y="4" width="5" height="16" rx="1"/><path d="m17 5 3-1 2 15-3 1z"/>',
  playlist: '<path d="M16 5H3"/><path d="M11 12H3"/><path d="M11 19H3"/><path d="M21 16V5"/><circle cx="18" cy="16" r="3"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-2.8 2.8-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6V21h-4v-.2A1.7 1.7 0 0 0 9 19.2a1.7 1.7 0 0 0-1.9.3l-.1.1L4.2 17l.1-.1a1.7 1.7 0 0 0 .3-1.9A1.7 1.7 0 0 0 3 14H3v-4h.2A1.7 1.7 0 0 0 4.8 9a1.7 1.7 0 0 0-.3-1.9L4.4 7 7.2 4.2l.1.1a1.7 1.7 0 0 0 1.9.3A1.7 1.7 0 0 0 10 3V3h4v.2A1.7 1.7 0 0 0 15 4.8a1.7 1.7 0 0 0 1.9-.3l.1-.1L19.8 7l-.1.1a1.7 1.7 0 0 0-.3 1.9A1.7 1.7 0 0 0 21 10h.1v4H21a1.7 1.7 0 0 0-1.6 1Z"/>',
  shield: '<path d="M12 3 20 6v6c0 5-3.4 8.2-8 10-4.6-1.8-8-5-8-10V6z"/><path d="m8.5 12 2.2 2.2 4.8-5"/>',
  drive: '<path d="M5 6h14l2 9H3z"/><path d="M3 15h18v4H3z"/><circle cx="17.5" cy="17" r=".6" fill="currentColor"/>',
  database: '<ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v6c0 1.7 3.6 3 8 3s8-1.3 8-3V5"/><path d="M4 11v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6"/>',
  folder: '<path d="M3 7h7l2 2h9v10H3z"/><path d="M3 7V5h7l2 2"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  pause: '<path d="M9 6v12M15 6v12"/>',
  play: '<path d="m9 6 9 6-9 6z"/>',
  x: '<path d="m7 7 10 10M17 7 7 17"/>',
  arrow: '<path d="m9 18 6-6-6-6"/>',
  grid: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>',
  queue: '<path d="M8 6h12M8 12h12M8 18h12"/><circle cx="4" cy="6" r="1"/><circle cx="4" cy="12" r="1"/><circle cx="4" cy="18" r="1"/>',
  currency: '<circle cx="12" cy="12" r="9"/><path d="M15.5 8.5c-.8-.7-1.9-1-3.1-1-1.7 0-3 .8-3 2.1 0 3.4 6.1 1.6 6.1 5 0 1.3-1.3 2.2-3.2 2.2-1.4 0-2.7-.5-3.7-1.3M12 5.7v12.6"/>',
  convert: '<path d="M7 7h10l-2.5-2.5M17 17H7l2.5 2.5"/><path d="m17 7-2.5 2.5M7 17l2.5-2.5"/>',
  link: '<path d="M10 13a5 5 0 0 0 7.1.1l2-2a5 5 0 0 0-7.1-7.1l-1.1 1.1"/><path d="M14 11a5 5 0 0 0-7.1-.1l-2 2A5 5 0 0 0 12 20l1.1-1.1"/>',
  magnet: '<path d="M6 4v8a6 6 0 0 0 12 0V4"/><path d="M6 8h4M14 8h4"/>',
  clipboard: '<rect x="6" y="4" width="12" height="17" rx="2"/><path d="M9 4.5V3h6v1.5M9 8h6M9 12h6M9 16h4"/>',
  qr: '<rect x="3.5" y="3.5" width="6.5" height="6.5" rx=".7"/><rect x="14" y="3.5" width="6.5" height="6.5" rx=".7"/><rect x="3.5" y="14" width="6.5" height="6.5" rx=".7"/><path d="M14 14h2.5v2.5H14zM18.5 14v3M14 19h3M19 19h1.5v1.5"/>',
  privacy: '<path d="M12 3 20 6v6c0 5-3.4 8.2-8 10-4.6-1.8-8-5-8-10V6z"/><path d="M9 12h6M12 9v6"/>',
  collage: '<rect x="3" y="3" width="8" height="8" rx="1"/><rect x="13" y="3" width="8" height="5" rx="1"/><rect x="3" y="13" width="8" height="8" rx="1"/><rect x="13" y="10" width="8" height="11" rx="1"/>',
  metadata: '<path d="M7 3h10l4 4v14H7z"/><path d="M17 3v5h5M10 12h8M10 16h8"/><circle cx="5" cy="6" r="2"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  history: '<path d="M4 12a8 8 0 1 0 2.4-5.7L4 8.5"/><path d="M4 4v4.5h4.5M12 8v5l3 2"/>',
  bell: '<path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9"/><path d="M10 21h4"/>',
  calendar: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M7 3v4M17 3v4M3 10h18"/>',
  doc: '<path d="M6 2h8l4 4v16H6z"/><path d="M14 2v5h5"/><path d="M9 12h6M9 16h6"/>',
  sheet: '<path d="M6 2h8l4 4v16H6z"/><path d="M14 2v5h5"/><path d="M9 11h6v7H9zM12 11v7M9 14.5h6"/>',
  wand: '<path d="m15 4 5 5L9 20l-5-5z"/><path d="m14 5 5 5M6 4v3M4.5 5.5h3M18 16v4M16 18h4"/>',
  scissors: '<circle cx="6" cy="7" r="3"/><circle cx="6" cy="17" r="3"/><path d="m8.5 8.5 10 7M8.5 15.5l10-7"/>',
  sparkles: '<path d="m12 3 1.2 3.8L17 8l-3.8 1.2L12 13l-1.2-3.8L7 8l3.8-1.2zM5 14l.8 2.2L8 17l-2.2.8L5 20l-.8-2.2L2 17l2.2-.8zM19 14l.7 1.7L21.5 16l-1.8.7L19 18.5l-.7-1.8-1.8-.7 1.8-.3z"/>',
  palette: '<path d="M12 3a9 9 0 1 0 0 18h1.2a1.8 1.8 0 0 0 0-3.6h-.8a1.6 1.6 0 0 1 0-3.2H15a6 6 0 0 0 0-12z"/><circle cx="7.5" cy="10" r=".8" fill="currentColor"/><circle cx="9.5" cy="6.8" r=".8" fill="currentColor"/><circle cx="14" cy="6.5" r=".8" fill="currentColor"/><circle cx="17" cy="9.5" r=".8" fill="currentColor"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  video: '<rect x="3" y="5" width="14" height="14" rx="2"/><path d="m17 9 4-2v10l-4-2z"/><path d="m9 9 4 3-4 3z"/>',
  audio: '<path d="M9 18V6l10-2v12"/><circle cx="6" cy="18" r="3"/><circle cx="16" cy="16" r="3"/>',
  archive: '<path d="M5 3h14v5H5zM4 8h16v13H4z"/><path d="M9 12h6"/>',
  pdf: '<path d="M6 2h8l4 4v16H6z"/><path d="M14 2v5h5"/><path d="M8.5 16h1.2a1.5 1.5 0 0 0 0-3H8.5v5M12.5 13h1.1c1.3 0 2.1.9 2.1 2.5S14.9 18 13.6 18h-1.1zM17 18v-5h3"/>',
  app: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18M8 4v5"/>',
  disk: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="3"/><path d="M12 3v6"/>',
  presentation: '<path d="M4 4h16v12H4zM8 20l4-4 4 4M12 16v4"/><path d="m8 12 2-3 2 2 3-4 2 5"/>',
  more: '<circle cx="5" cy="12" r="1" fill="currentColor"/><circle cx="12" cy="12" r="1" fill="currentColor"/><circle cx="19" cy="12" r="1" fill="currentColor"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c3 3.2 3 14.8 0 18M12 3c-3 3.2-3 14.8 0 18"/>',
  trend: '<path d="M4 17.5 9 12l4 3.5L20 7"/><path d="M15.5 7H20v4.5"/>',
  panel: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M8 4v16M8 10h13"/>',
  terminal: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="m7 9 3 3-3 3M12 16h5"/>',
  chevron: '<path d="m6 9 6 6 6-6"/>',
  maximize: '<rect x="5" y="5" width="14" height="14" rx="1.5"/>',
  restore: '<path d="M8 7h13v13H8z"/><path d="M3 17V3h14"/>',
  minimize: '<path d="M6 18h12"/>'
});
const ICON_ALIASES = Object.freeze({ document: 'doc', software: 'app', package: 'app', disc: 'disk', torrent: 'magnet', list: 'queue' });
const iconMarkupCache = new Map();
const unknownIconNames = new Set();

const icon = (name, size = 24) => {
  const requestedName = String(name || 'file');
  const resolvedName = ICON_ALIASES[requestedName] || requestedName;
  const known = Object.hasOwn(ICON_PATHS, resolvedName);
  const safeName = known ? resolvedName : 'file';
  if (!known && !unknownIconNames.has(requestedName)) {
    unknownIconNames.add(requestedName);
    console.warn(`[CacaTools] Icono no registrado: ${requestedName}`);
  }
  const safeSize = Math.max(12, Math.min(96, Math.round(Number(size) || 24)));
  const cacheKey = `${safeName}:${safeSize}:${known ? 'known' : requestedName}`;
  if (!iconMarkupCache.has(cacheKey)) {
    iconMarkupCache.set(cacheKey, `<svg class="icon" data-icon="${safeName}"${known ? '' : ` data-icon-fallback="${escapeHtml(requestedName)}"`} width="${safeSize}" height="${safeSize}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.85" stroke-linecap="round" stroke-linejoin="round" shape-rendering="geometricPrecision" overflow="visible" aria-hidden="true">${ICON_PATHS[safeName]}</svg>`);
  }
  return iconMarkupCache.get(cacheKey);
};

const navItems = [
  ['Inicio', 'home'], ['Descargas', 'download'], ['Documentos', 'file'], ['Imágenes', 'image'], ['Utilidades', 'tools']
];


const demoPlaylist = [
  { id: 'p1', title: 'Cafuné — Tek It (I Watch The Moon)', creator: 'Cafuné', duration: '3:14', selected: true, tone: 1 },
  { id: 'p2', title: 'Mitski — My Love Mine All Mine', creator: 'LatinHype', duration: '2:19', selected: true, tone: 2, thumbnail: './app-ui/assets/brand/clear-download-manager-celeste.png' },
  { id: 'p3', title: 'Jace June — Come Home', creator: 'Jace June', duration: '2:49', selected: true, tone: 3, thumbnail: './app-ui/assets/brand/clear-download-manager-celeste.png' },
  { id: 'p4', title: 'Hero', creator: 'Skyper', duration: '2:21', selected: true, tone: 4 },
  { id: 'p5', title: 'Die With A Smile', creator: 'Lady Gaga', duration: '4:12', selected: true, tone: 5 },
  { id: 'p6', title: 'Imogen Heap — Headlock', creator: 'Imogen Heap', duration: '3:35', selected: true, tone: 6 },
  { id: 'p7', title: 'd2s1 — 5469', creator: 'd2s1', duration: '1:30', selected: false, tone: 7 }
];

const demo = {
  storage: { free_bytes: 274877906944, total_bytes: 549755813888 },
  currency: { rate: 59.68, source: 'Tasa en línea · ExchangeRate-API', updated_at: '2026-07-30 06:10:00', mode: 'live', online: true, error: null },
  queue: { active: 3, queued: 0, paused: 0, completed_today: 5, failed: 0, total_speed_bps: 14417920 },
  jobs: [
    { id: 1, title: 'whql-amd-software-adrenalin-edition-26.7.1-win11-a.exe', detail: '595 MB de 941 MB · 8.45 MB/s · 41 s restantes', progress: 63, status: 'running', kind: 'app', engine: 'http', stage: 'Descargando', downloaded_bytes: 623902720, total_bytes: 986710016, speed_bps: 8860467, eta_seconds: 41, indeterminate: false },
    { id: 2, title: 'Jace June - Come Home (Official Lyric Video).mp3', detail: '3.9 MB de 7.6 MB · 3.20 MB/s · 1 s restante', progress: 51, status: 'running', kind: 'audio', engine: 'media', stage: 'Descargando', downloaded_bytes: 4089446, total_bytes: 7969178, speed_bps: 3355443, eta_seconds: 1, indeterminate: false },
    { id: 3, title: 'Viaje a Japón 2024.jpg', detail: '2.1 MB de 3.6 MB · 2.10 MB/s · 1 s restante', progress: 58, status: 'running', kind: 'image', engine: 'http', stage: 'Descargando', downloaded_bytes: 2202009, total_bytes: 3774873, speed_bps: 2202009, eta_seconds: 1, indeterminate: false }
  ],
  recent_files: [
    { id: 1, name: 'Sukuna vs Itadori (Jujutsu Kaisen) Renacimiento MegaR.mp4', category: 'Vídeo · 2.14 GB', opened_at: 'Hoy, 10:23', kind: 'video' },
    { id: 2, name: 'Viaje a Japón 2024.jpg', category: 'Imagen · 3.6 MB', opened_at: 'Ayer, 18:02', kind: 'image' },
    { id: 3, name: 'Plan de proyecto.docx', category: 'Documento · 245 KB', opened_at: 'Ayer, 09:45', kind: 'doc' },
    { id: 4, name: 'Presupuesto 2024.xlsx', category: 'Hoja de cálculo · 118 KB', opened_at: 'Ayer, 08:15', kind: 'sheet' },
    { id: 5, name: 'lofi-chill-study-beats.mp3', category: 'Audio · 12.7 MB', opened_at: 'Ayer, 07:30', kind: 'audio' },
    { id: 6, name: 'Manual CacaTools.pdf', category: 'PDF · 2.1 MB', opened_at: 'Lun, 20:12', kind: 'pdf' }
  ]
};

const emptySnapshot = {
  storage: { free_bytes: 0, total_bytes: 0 },
  currency: { rate: null, source: 'Sin tasa configurada', updated_at: null, mode: 'missing', online: false, error: null },
  queue: { active: 0, queued: 0, paused: 0, completed_today: 0, failed: 0, total_speed_bps: 0 },
  jobs: [],
  recent_files: []
};

const previewSections = { home: 'Inicio', downloads: 'Descargas', documents: 'Documentos', images: 'Imágenes', utilities: 'Utilidades', library: 'Biblioteca', settings: 'Ajustes', currency: 'Utilidades' };


const MEDIA_DOWNLOAD_PREFERENCES_KEY = 'cacatools.media-download-preferences.v1';
const VIDEO_QUALITY_VALUES = new Set(['best', '2160', '1440', '1080', '720', '480', '360', '240', '144']);
function videoSelectorForQuality(value) {
  const quality = normalizeVideoQuality(value);
  return quality === 'best'
    ? 'bestvideo*+bestaudio/best'
    : `bestvideo[height<=${quality}]+bestaudio/best[height<=${quality}]/best[height<=${quality}]`;
}
function normalizeVideoQuality(value) {
  const quality = String(value || 'best');
  return VIDEO_QUALITY_VALUES.has(quality) ? quality : 'best';
}
function videoQualityFromSelector(selector = '') {
  const match = String(selector || '').match(/height<=(2160|1440|1080|720|480|360|240|144)/);
  return match ? match[1] : 'best';
}
function loadMediaDownloadPreferences() {
  try {
    const value = JSON.parse(localStorage.getItem(MEDIA_DOWNLOAD_PREFERENCES_KEY) || '{}');
    const formatSelector = typeof value.formatSelector === 'string' ? value.formatSelector : '';
    return {
      outputMode: typeof value.outputMode === 'string' ? value.outputMode : 'video_mp4',
      formatSelector,
      videoQuality: normalizeVideoQuality(value.videoQuality || videoQualityFromSelector(formatSelector)),
      playlistFormat: value.playlistFormat === 'Mejor calidad disponible' ? 'MP3 320 kbps' : typeof value.playlistFormat === 'string' ? value.playlistFormat : 'MP3 320 kbps'
    };
  } catch {
    return { outputMode: 'video_mp4', formatSelector: '', videoQuality: 'best', playlistFormat: 'MP3 320 kbps' };
  }
}
function persistMediaDownloadPreferences() {
  try {
    localStorage.setItem(MEDIA_DOWNLOAD_PREFERENCES_KEY, JSON.stringify({
      outputMode: appState.selectedOutputMode || 'video_mp4',
      formatSelector: appState.selectedMediaFormat || '',
      videoQuality: normalizeVideoQuality(appState.selectedVideoQuality),
      playlistFormat: appState.selectedPlaylistFormat || 'MP3 320 kbps'
    }));
  } catch {}
}
const storedMediaDownloadPreferences = loadMediaDownloadPreferences();

const appState = {
  activeSection: 'Descargas',
  settingsCategory: 'general',
  settingsReturnSection: 'Descargas',
  activeTool: previewView === 'currency' ? 'currency' : null,
  appearance: loadStoredAppearance(),
  appearanceSaved: false,
  mediaAnalysis: null,
  selectedMediaFormat: storedMediaDownloadPreferences.formatSelector,
  selectedOutputMode: storedMediaDownloadPreferences.outputMode,
  selectedVideoQuality: storedMediaDownloadPreferences.videoQuality,
  selectedPlaylistFormat: storedMediaDownloadPreferences.playlistFormat,
  mediaSessionSettings: { useBraveCookies: false, cookiesPath: null, cookiesFileAvailable: false },
  analysisBusy: false,
  analysisPhase: 'Preparando enlace…',
  analysisError: '',
  unifiedSearchQuery: '',
  unifiedSearchAlternatives: [],
  snapshot: previewMode ? structuredClone(demo) : structuredClone(emptySnapshot),
  progressEngineStatus: { mode: 'stable', v2_ready: false, ui_source: 'stable_metadata_plus_v2_live_projection' },
  toolUpdateStatus: null,
  toolUpdateChecking: false,
  toolUpdateApplying: false,
  downloadSchedules: previewMode ? [
    { id: 1, job_id: 2, action: 'resume', run_at: '2026-08-01 08:30:00', repeat_daily: false, enabled: true, last_run_at: null },
    { id: 2, job_id: 1, action: 'pause', run_at: '2026-08-01 23:00:00', repeat_daily: true, enabled: true, last_run_at: null }
  ] : [],
  downloadDirectory: previewMode ? 'C:\\Users\\Demo\\Downloads\\CacaTools' : 'Descargas\\CacaTools',
  playlistStage: 'selection',
  playlistItems: structuredClone(demoPlaylist),
  playlistCurrentIndex: 0,
  playlistProgress: 0,
  playlistPaused: false,
  playlistBatchId: null,
  playlistRuntime: null,
  playlistLastCurrentId: null,
  playlistAnimateCurrent: false,
  playlistRecoveryJobId: null,
  playlistRecoveryBusy: false,
  playlistThumbnailCache: Object.create(null),
  imageEditorState: null,
  imageEditorTool: '',
  savedLinks: [],
  linkQuery: '',
  qrSvg: '',
  qrText: 'https://example.com',
  qrForeground: '#111827',
  qrBackground: '#ffffff',
  metadataInfo: null,
  runtimeStatus: null,
  mediaRuntimeStatus: null,
  lastSnapshotSignature: '',
  lastRenderError: '',
  lastSuccessfulRenderAt: 0,
  snapshotFailures: 0,
  snapshotRefreshBusy: false,
  currencyRefreshing: false,
  pendingJobs: [],
  displayedProgress: Object.create(null),
  progressAnimations: Object.create(null),
  queueSpeedHistory: [],
  updaterStatus: (previewMode || storeManagedDistribution) ? { enabled: false, configured: false, storeManaged: storeManagedDistribution, currentVersion: APP_VERSION, channel: 'stable', provider: storeManagedDistribution ? 'microsoft-store' : 'github-releases', endpoint: '', repository: '', message: storeManagedDistribution ? 'Esta edición se actualiza a través de Microsoft Store.' : 'Vista previa' } : null,
  updaterCheckBusy: false,
  updaterInstallBusy: false,
  updaterProgress: null,
  availableUpdate: null,
  releaseMetadata: null,
  remoteNewsMessages: [],
  updaterMessage: '',
  experienceSettings: previewMode ? structuredClone(DEFAULT_EXPERIENCE_SETTINGS) : structuredClone(DEFAULT_EXPERIENCE_SETTINGS),
  bandwidthSettings: { mode: 'unlimited' },
  bandwidthEditorMode: null,
  bandwidthCustomValue: 1,
  bandwidthCustomUnit: 'MB',
  downloadConcurrency: { http: 2, multimedia: 1 },
  autoUpdateEnabled: loadAutoUpdatePreference(),
  extensionBridgeStatus: previewMode ? { prepared: true, registered: false, hostName: 'lat.cacaplay.cacatools.downloadmanager', protocolVersion: 1 } : null,
  startupStatus: previewMode ? { supported: false, enabled: false, mode: 'background' } : null,
  windowBehavior: previewMode ? { closeAction: 'tray', minimizeAction: 'taskbar' } : { closeAction: 'tray', minimizeAction: 'taskbar' },
  backgroundLaunch: false,
  extensionBridgeBusy: false,
  extensionBridgePendingRequest: null,
  currencyHistory: previewMode ? [
    { from: '500.00 USD', to: '29,840.00 DOP', ago: 'Hace 5 min' },
    { from: '10,000.00 DOP', to: '167.48 USD', ago: 'Hace 1 h' },
    { from: '250.00 USD', to: '14,920.00 DOP', ago: 'Ayer 11:32' },
    { from: '1,500.00 USD', to: '89,520.00 DOP', ago: 'Ayer 09:18' }
  ] : []
};

// Main-only visual baseline. Appearance remains the owner of the persisted
// preference and Auto Scale algorithm; this factor is applied only while the
// Download Manager workspace is the active page.
const MAIN_BASE_RATIO = 1.20;
function applyAppAppearance(value = appState.appearance, options = {}) {
  const source = value && typeof value === 'object' ? value : appState.appearance;
  // Rendering and progress refreshes happen frequently.  They may repaint the
  // web UI but must not touch the Windows/tray icon; native icon changes are
  // opt-in at startup or after an explicit committed appearance change.
  const result = applyAppearance(source, { updateNativeIcon: false, ...options });
  if (appState.activeSection !== 'Descargas') return result;
  const appearance = normalizeAppearance(source);
  const resolvedScale = appearance.autoScale ? automaticScalePercent() : displayedScalePercent(appearance.scale);
  const mainEffectiveRatio = MAIN_BASE_RATIO * (resolvedScale / 100);
  const densityMap = { compact: .94, balanced: 1, spacious: 1.09 };
  const root = document.documentElement;
  const effectiveFontSize = clamp(16 * mainEffectiveRatio, 16.5, 29);
  const layoutDensity = clamp(mainEffectiveRatio * (densityMap[appearance.density] || 1), .98, 1.48);
  root.style.setProperty('--ui-scale', String(mainEffectiveRatio));
  // The Download Manager consumes this Main-only token. It is deliberately
  // separate from the persisted Settings scale and is not applied to the
  // Settings surface.
  root.style.setProperty('--dm-main-base-ratio', String(mainEffectiveRatio));
  root.style.setProperty('--root-font-size', `${effectiveFontSize.toFixed(2)}px`);
  root.style.setProperty('--effective-font-size', `${effectiveFontSize.toFixed(2)}px`);
  root.style.setProperty('--density-scale', String(layoutDensity));
  return result;
}

// Theme changes are committed atomically.  The download-manager surface must
// not animate through a document snapshot: that animation can temporarily
// change the available width and make rows appear to resize or shift.
function applyThemeWithMotion(value = appState.appearance, options = {}) {
  applyAppAppearance(value, options);
  return Promise.resolve({ used: false, reason: 'theme-static' });
}

configureSettings({
  getAppState: () => appState,
  appearancePresets,
  visualDiagnosticsSnapshot,
  displayedScalePercent,
  automaticScalePercent,
  downloadDirectoryLabel,
  icon,
  escapeHtml,
  invoke,
  locale: currentLocale,
  translate: (key, ...args) => t(key, ...args),
  onLocaleChange: (locale) => {
    const normalized = saveLocale(locale);
    appState.experienceSettings = normalizeExperienceSettings({ ...(appState.experienceSettings || {}), locale: normalized });
    void persistExperienceSettings({ locale: normalized });
    document.documentElement.lang = resolveLocale(normalized);
    render();
  },
  APP_VERSION,
  THUMBNAIL_CACHE_VERSION
});

configurePlaylist({
  getAppState: () => appState,
  previewMode,
  mediaSizeLabel,
  invoke,
  playlistMetadata,
  playlistResolutionLabel,
  thumbnailSrc,
  showToast,
  downloadDirectoryLabel
});

configureMedia({
  getAppState: () => appState,
  icon,
  escapeHtml,
  formatBytes,
  downloadDirectoryLabel,
  normalizeVideoQuality,
  persistMediaDownloadPreferences,
  startPlaylistSizeAnalysis
});

configureExtension({
  getAppState: () => appState,
  previewMode,
  invoke,
  loadSnapshot,
  render,
  showToast,
  routeDownloadAnalysis,
  downloadManagerVisualPreferences,
  forceDownloadManagerAllView
});

configureDownloads({
  getAppState: () => appState,
  previewMode,
  invoke,
  showToast,
  friendlyError
});

const automaticPromptCoordinator = createPromptCoordinator({
  onPresent: async (request) => {
    if (request.kind !== 'clipboard-link') return;
    const url = String(request.payload?.url || '').trim();
    const preview = clipboardPreviewMetadata(url, request.payload?.kind);
    await new Promise((resolve) => {
      appState.clipboardPrompt = { url, ...preview };
      appState.clipboardPromptResolve = resolve;
      requestDownloadManagerRender({ force: true });
    });
  }
});
const clipboardFocusWatcher = createClipboardFocusWatcher({
  coordinator: automaticPromptCoordinator,
  readClipboard: () => invoke('read_clipboard_text'),
  onUrl: async (url) => {
    const intent = await classifyLinkIntent(url);
    if (intent.kind === 'direct') {
      // Direct HTTP files go to the HTTP preparation immediately. The
      // multimedia preview is reserved for media and playlist intents.
      await routeLinkIntent(url, { source: 'clipboard-auto', __linkIntent: intent });
      return false;
    }
    if (intent.kind === 'media' || intent.kind === 'playlist') return { kind: intent.kind };
    return false;
  },
  enabled: () => !previewMode
    && appState.experienceSettings?.clipboardAutoSuggest !== false
    && !document.querySelector('.dm-modal-backdrop')
});

async function bindNativeClipboardFocus() {
  const listen = window.__TAURI__?.event?.listen;
  if (typeof listen !== 'function') return;
  try {
    await listen('cacatools-main-focus-changed', (event) => {
      if (event?.payload?.focused !== false) clipboardFocusWatcher.notifyFocus();
    });
  } catch (error) {
    console.warn('No se pudo registrar el foco nativo del portapapeles.', error);
  }
}

const PREPARATION_WINDOW_LABELS = new Set(['media-prep', 'playlist-prep', 'http-prep']);

function applyPreparationModalState(labels = []) {
  const activeLabels = [...new Set(Array.isArray(labels) ? labels : [])]
    .filter((label) => PREPARATION_WINDOW_LABELS.has(String(label || '').trim()));
  document.body.classList.toggle('has-preparation-modal', activeLabels.length > 0);
  document.body.dataset.preparationModalCount = String(activeLabels.length);
}

window.__cacatoolsSetPreparationModalState = applyPreparationModalState;

async function bindPreparationModalState() {
  const listen = window.__TAURI__?.event?.listen;
  if (typeof listen !== 'function') return;
  try {
    await listen('cacatools-preparation-modal-state', (event) => {
      applyPreparationModalState(event?.payload?.activeLabels);
    });
    const activeLabels = await invoke('preparation_modal_state');
    applyPreparationModalState(activeLabels);
  } catch (error) {
    applyPreparationModalState([]);
    console.warn('No se pudo sincronizar la jerarquía visual de ventanas.', error);
  }
}

async function bindAppUpdateProgress() {
  const listen = window.__TAURI__?.event?.listen;
  if (typeof listen !== 'function') return;
  try {
    await listen('cacatools-app-update-progress', (event) => {
      const payload = event?.payload && typeof event.payload === 'object' ? event.payload : {};
      appState.updaterProgress = payload;
      if (payload.phase === 'install') appState.updaterMessage = 'Verificando e instalando la actualización firmada…';
      requestDownloadManagerRender({ force: true });
    });
  } catch (error) {
    console.warn('No se pudo registrar el progreso del actualizador.', error);
  }
}

configureRuntime({
  getAppState: () => appState,
  previewMode,
  invoke,
  showToast,
  patchDownloadManagerLive,
  icon,
  escapeHtml,
  formatBytes,
  normalizeAppearance,
  scheduleAppearancePersist,
  applyAppearance: applyAppAppearance,
  scheduleExtensionStatePublish,
  hydratePlaylistRuntimeItem,
  stablePlaylistThumbnail,
  playlistPreviewUrl,
  playlistPlayableThumb,
  bindPlaylistPreviewButtons,
  bindThumbnailFallbacks,
  playlistMetadata,
  clamp
});

configureComposition({
  getAppState: () => appState,
  previewMode,
  icon,
  escapeHtml,
  downloadsPageMarkup,
  documentsPageMarkup,
  imageEditorMarkup,
  settingsMarkup,
  libraryPageMarkup,
  applyAppearance: applyAppAppearance,
  bindEvents,
  bindVisualDiagnostics,
  rememberQueueSpeed,
  animateDownloadProgressBars,
  renderFatalError,
  selectedPlaylistItems,
  selectedPlaylistSizeSummary,
  invoke,
  displayedScalePercent,
  automaticScalePercent,
  loadSnapshot: loadSnapshotForApp,
  refreshNewsFeed,
  snapshotSignature,
  processExtensionBridgeRequests,
  flushDeferredDownloadManagerRefresh,
  shouldCheckForAppUpdate,
  checkForAppUpdate,
  startSnapshotRefreshLoop,
  runProgressAcceptanceAutopilot,
  clearFloatingLayer,
  localizeDom,
  locale: currentLocale
});

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1; }
  return `${value >= 100 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`;
}

function displayWindowsPath(path) {
  const value = String(path || '');
  if (value.startsWith('\\\\?\\UNC\\')) return `\\\\${value.slice(8)}`;
  return value.startsWith('\\\\?\\') ? value.slice(4) : value;
}


function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[character]);
}


function showToast(message, type = 'info') {
  let region = document.querySelector('.toast-region');
  if (!region) {
    region = document.createElement('div');
    region.className = 'toast-region';
    document.body.append(region);
  }
  const item = document.createElement('div');
  item.className = `app-toast ${type}`;
  item.textContent = String(message || 'Acción completada');
  region.append(item);
  window.setTimeout(() => item.remove(), 3600);
}

function renderFatalError(error) {
  const root = document.querySelector('#app');
  if (!root) return;
  const message = String(error?.message || error || 'Error desconocido');
  appState.lastRenderError = message;
  root.innerHTML = `<section class="fatal-screen"><div><h1>CacaTools encontró un error de interfaz</h1><p>${escapeHtml(message)}</p><button id="recover-interface">Recargar la interfaz</button></div></section>`;
  document.querySelector('#recover-interface')?.addEventListener('click', () => window.location.reload());
}

function downloadDirectoryLabel() {
  const value = displayWindowsPath(appState.downloadDirectory || 'Descargas\\CacaTools');
  if (value.length <= 54) return value;
  const segments = value.split(/[\\/]/).filter(Boolean);
  return segments.length > 2 ? `…\\${segments.slice(-2).join('\\')}` : `…${value.slice(-51)}`;
}

async function invoke(command, args = {}) {
  const tauriInvoke = window.__TAURI__?.core?.invoke;
  if (!tauriInvoke) throw new Error('Tauri no disponible');
  return tauriInvoke(command, args);
}

let experiencePersistPromise = Promise.resolve();
function persistExperienceSettings(patch = {}) {
  const next = normalizeExperienceSettings({ ...(appState.experienceSettings || {}), ...patch });
  experiencePersistPromise = experiencePersistPromise.then(async () => {
    if (previewMode) {
      appState.experienceSettings = next;
      appState.autoUpdateEnabled = next.automaticUpdateChecks;
      return next;
    }
    try {
      const saved = await invoke('save_experience_settings', { settings: next });
      appState.experienceSettings = normalizeExperienceSettings(saved || next);
    } catch (error) {
      console.warn('No se pudieron guardar las preferencias de experiencia.', error);
      appState.experienceSettings = next;
    }
    appState.autoUpdateEnabled = appState.experienceSettings.automaticUpdateChecks;
    return appState.experienceSettings;
  });
  return experiencePersistPromise;
}

function hydrateExperienceSettings(raw = {}) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const hasPersistedUpdatePreference = Object.prototype.hasOwnProperty.call(source, 'automaticUpdateChecks');
  const legacyPreference = loadAutoUpdatePreference();
  const normalized = normalizeExperienceSettings({
    ...source,
    automaticUpdateChecks: hasPersistedUpdatePreference ? source.automaticUpdateChecks !== false : legacyPreference
  });
  const needsMigration = !hasPersistedUpdatePreference || !localStorage.getItem(LEGACY_EXPERIENCE_MIGRATION_KEY);
  appState.experienceSettings = normalized;
  document.documentElement.lang = resolveLocale(normalized.locale || initialLocale);
  appState.autoUpdateEnabled = normalized.automaticUpdateChecks;
  if (needsMigration && !previewMode) {
    try { localStorage.setItem(LEGACY_EXPERIENCE_MIGRATION_KEY, '1'); } catch {}
    void persistExperienceSettings(normalized);
  }
  return normalized;
}

function normalizeBandwidthSettings(raw = {}) {
  const bytes = Number(raw?.bytesPerSecond);
  if (raw?.mode !== 'limited' || !Number.isSafeInteger(bytes) || bytes < 64_000 || bytes > 10_000_000_000) {
    return { mode: 'unlimited' };
  }
  return { mode: 'limited', bytesPerSecond: bytes };
}

function hydrateBandwidthEditor(settings = appState.bandwidthSettings) {
  const normalized = normalizeBandwidthSettings(settings);
  appState.bandwidthSettings = normalized;
  const bytes = normalized.mode === 'limited' ? normalized.bytesPerSecond : 1_000_000;
  if (bytes % 1_000_000 === 0) {
    appState.bandwidthCustomValue = bytes / 1_000_000;
    appState.bandwidthCustomUnit = 'MB';
  } else {
    appState.bandwidthCustomValue = Math.max(1, Math.round(bytes / 1_000));
    appState.bandwidthCustomUnit = 'KB';
  }
  appState.bandwidthEditorMode = null;
}

async function persistBandwidthSettings(settings) {
  let normalized;
  if (settings?.mode === 'unlimited') {
    normalized = { mode: 'unlimited' };
  } else {
    const bytesPerSecond = Number(settings?.bytesPerSecond);
    if (settings?.mode !== 'limited' || !Number.isSafeInteger(bytesPerSecond) || bytesPerSecond < 64_000 || bytesPerSecond > 10_000_000_000) {
      throw new Error('La velocidad debe estar entre 64 KB/s y 10 000 MB/s');
    }
    normalized = { mode: 'limited', bytesPerSecond };
  }
  if (previewMode) {
    hydrateBandwidthEditor(normalized);
    return normalized;
  }
  const saved = await invoke('save_bandwidth_settings', { settings: normalized });
  hydrateBandwidthEditor(saved);
  return appState.bandwidthSettings;
}

function normalizeDownloadConcurrency(raw = {}) {
  const http = Number(raw?.http);
  const multimedia = Number(raw?.multimedia);
  if (!Number.isSafeInteger(http) || http < 1 || http > 8) {
    throw new Error('Las descargas HTTP simultáneas deben estar entre 1 y 8');
  }
  if (!Number.isSafeInteger(multimedia) || multimedia < 1 || multimedia > 4) {
    throw new Error('Las descargas multimedia simultáneas deben estar entre 1 y 4');
  }
  return { http, multimedia };
}

async function persistDownloadConcurrency(settings) {
  const normalized = normalizeDownloadConcurrency(settings);
  if (previewMode) {
    appState.downloadConcurrency = normalized;
    return normalized;
  }
  const saved = await invoke('save_download_concurrency', { settings: normalized });
  appState.downloadConcurrency = normalizeDownloadConcurrency(saved);
  return appState.downloadConcurrency;
}

function newsMessages() {
  return buildNewsInbox({
    update: appState.availableUpdate,
    releaseMetadata: appState.releaseMetadata,
    remoteMessages: appState.remoteNewsMessages || parseCachedNews(appState.experienceSettings, { appVersion: APP_VERSION }),
    experience: appState.experienceSettings,
    appVersion: APP_VERSION,
    includeExtension: true,
    locale: resolveLocale(currentLocale())
  });
}

async function refreshNewsFeed({ force = false } = {}) {
  if (previewMode) return [];
  const settings = normalizeExperienceSettings(appState.experienceSettings);
  const ttl = 6 * 60 * 60 * 1000;
  const cacheIsCurrent = settings.newsCacheSource === NEWS_FEED_CACHE_KEY;
  if (!force && cacheIsCurrent && settings.newsCacheFetchedAt && Date.now() - settings.newsCacheFetchedAt < ttl) {
    appState.remoteNewsMessages = parseCachedNews(settings, { appVersion: APP_VERSION });
    return appState.remoteNewsMessages;
  }
  try {
    const response = await invoke('fetch_remote_news_feed', {
      // Do not send validators from the retired feed. A fresh canonical fetch
      // must replace that cache instead of accepting a legacy 304 response.
      etag: cacheIsCurrent ? settings.newsCacheEtag || null : null,
      lastModified: cacheIsCurrent ? settings.newsCacheLastModified || null : null
    });
    if (response?.notModified) {
      appState.remoteNewsMessages = parseCachedNews(settings, { appVersion: APP_VERSION });
      await persistExperienceSettings({ newsCacheFetchedAt: Date.now() });
      return appState.remoteNewsMessages;
    }
    const parsed = JSON.parse(String(response?.body || ''));
    const valid = validateRemoteNewsFeed(parsed, { appVersion: APP_VERSION });
    const cachePatch = newsCachePatch(response, valid);
    appState.remoteNewsMessages = valid;
    if (Object.keys(cachePatch).length) await persistExperienceSettings(cachePatch);
    return valid;
  } catch (error) {
    console.info('Feed remoto de novedades no disponible; se conserva last-known-good.', error);
    appState.remoteNewsMessages = parseCachedNews(settings, { appVersion: APP_VERSION });
    return appState.remoteNewsMessages;
  } finally {
    requestDownloadManagerRender({ force: true });
  }
}

async function loadSnapshotForApp(options = {}) {
  const result = await loadSnapshot(options);
  if (options.includeSettings) hydrateExperienceSettings(appState.experienceSettings);
  return result;
}

function clipboardPreviewMetadata(url = '', routedKind = '') {
  let host = '';
  let title = 'Enlace detectado';
  let kind = routedKind === 'playlist' ? 'playlist' : 'media';
  try {
    const parsed = new URL(String(url || '').trim());
    host = parsed.hostname.replace(/^www\./i, '');
    const isPlaylist = kind === 'playlist';
    if (/youtube\.com|youtu\.be/i.test(host)) title = isPlaylist ? 'Playlist de YouTube' : 'Vídeo de YouTube';
    else if (/tiktok/i.test(host)) title = 'Vídeo de TikTok';
    else if (/pinterest/i.test(host)) title = 'Vídeo de Pinterest';
    else title = isPlaylist ? 'Playlist detectada' : 'Contenido multimedia detectado';
    if (!isPlaylist && /youtube\.com|youtu\.be/i.test(host)) {
      const id = parsed.hostname === 'youtu.be' ? parsed.pathname.slice(1).split('/')[0] : parsed.searchParams.get('v') || parsed.pathname.match(/^\/(?:shorts|embed|live)\/([^/?]+)/i)?.[1] || '';
      if (id) return { kind, host, title, thumbnail: `https://i.ytimg.com/vi/${encodeURIComponent(id)}/hqdefault.jpg` };
    }
  } catch {}
  return { kind, host, title, thumbnail: '' };
}

function finishClipboardPrompt(action = 'cancel', suppress = false) {
  const prompt = appState.clipboardPrompt;
  if (!prompt) return;
  appState.clipboardPrompt = null;
  const resolve = appState.clipboardPromptResolve;
  appState.clipboardPromptResolve = null;
  if (suppress) void persistExperienceSettings({ clipboardAutoSuggest: false });
  resolve?.(action);
  // The prompt is still mounted in the DOM when this callback runs, so the
  // transient-render guard would defer forever waiting for a modal that this
  // action is explicitly closing. Render the cleared state immediately.
  render();
}

let youtubeIframeApiPromise = null;
let youtubePreviewPlayer = null;

function youtubeVideoId(value) {
  try {
    const parsed = new URL(String(value || '').trim());
    if (parsed.hostname === 'youtu.be') return parsed.pathname.slice(1).split('/')[0] || '';
    if (!/(^|\.)youtube\.com$/i.test(parsed.hostname)) return '';
    if (parsed.pathname === '/watch') return parsed.searchParams.get('v') || '';
    const match = parsed.pathname.match(/^\/(?:shorts|embed|live)\/([^/?]+)/i);
    return match?.[1] || '';
  } catch {
    return '';
  }
}

function loadYoutubeIframeApi() {
  if (window.YT?.Player) return Promise.resolve(window.YT);
  if (youtubeIframeApiPromise) return youtubeIframeApiPromise;
  youtubeIframeApiPromise = new Promise((resolve, reject) => {
    const previous = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      previous?.();
      window.YT?.Player ? resolve(window.YT) : reject(new Error('La API de YouTube no quedó disponible'));
    };
    const script = document.createElement('script');
    script.src = 'https://www.youtube.com/iframe_api';
    script.async = true;
    script.onerror = () => reject(new Error('No se pudo cargar la API oficial de YouTube'));
    document.head.append(script);
  });
  return youtubeIframeApiPromise;
}

async function openEmbeddedYoutubePreview(url) {
  const videoId = youtubeVideoId(url);
  const shell = document.querySelector('[data-youtube-preview-shell]');
  const target = document.querySelector('[data-youtube-preview-player]');
  if (!videoId || !shell || !target) return false;
  const marked = new URL(url);
  marked.searchParams.set('cacatools_preview', 'embedded');
  await invoke('open_online_media_player', { url: marked.toString() });
  shell.hidden = false;
  target.replaceChildren();
  const api = await loadYoutubeIframeApi();
  youtubePreviewPlayer?.destroy?.();
  youtubePreviewPlayer = new api.Player(target, {
    videoId,
    host: 'https://www.youtube-nocookie.com',
    playerVars: { autoplay: 1, playsinline: 1, rel: 0, modestbranding: 1, origin: window.location.origin }
  });
  return true;
}

function withTimeout(promise, timeoutMs, message = 'La operación tardó demasiado') {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = window.setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => window.clearTimeout(timer));
}

function friendlyError(error) {
  const raw = String(error?.message || error || '');
  if (/timed out|tardó demasiado|timeout/i.test(raw)) return 'La operación tardó demasiado.';
  if (/cancel|cancelad/i.test(raw)) return 'La descarga fue cancelada.';
  if (/metadata_incomplete|no se encontraron canciones|no se encontró la canción/i.test(raw)) return 'No se encontró la canción.';
  if (/provider_failed|download_not_allowed/i.test(raw)) return 'No se encontró una versión disponible para descargar.';
  if (/archivo final|ffmpeg_unavailable/i.test(raw)) return 'No se pudo crear el archivo final.';
  return raw || 'No se pudo completar la operación.';
}

async function checkForAppUpdate({ silent = false } = {}) {
  if (previewMode || storeManagedDistribution || appState.updaterStatus?.storeManaged || appState.updaterCheckBusy || appState.updaterInstallBusy) return appState.availableUpdate;
  appState.updaterCheckBusy = true;
  appState.updaterMessage = 'Comprobando la versión publicada…';
  requestDownloadManagerRender({ force: true });
  try {
    const update = await invoke('check_for_app_update');
    markAppUpdateCheck();
    appState.availableUpdate = update || null;
    appState.releaseMetadata = null;
    if (update?.version) {
      try {
        if (localStorage.getItem(UPDATE_NOTIFICATION_KEY) !== String(update.version)) {
          await invoke('notify_app_update', { version: String(update.version), locale: resolveLocale(currentLocale()) });
          localStorage.setItem(UPDATE_NOTIFICATION_KEY, String(update.version));
        }
      } catch (error) { console.info('No se pudo mostrar la notificación de actualización.', error); }
      appState.experienceSettings = normalizeExperienceSettings({
        ...(appState.experienceSettings || {}),
        pendingUpdateVersion: String(update.version)
      });
      void persistExperienceSettings({ pendingUpdateVersion: String(update.version) });
      try { appState.releaseMetadata = await withTimeout(invoke('fetch_release_metadata', { version: String(update.version) }), 9000, 'metadata de release agotada'); } catch { appState.releaseMetadata = null; }
    } else {
      void persistExperienceSettings({ pendingUpdateVersion: '' });
    }
    appState.updaterMessage = update
      ? `CacaTools ${update.version} está disponible.`
      : 'Estás usando la versión más reciente.';
    if (!silent) showToast(appState.updaterMessage, update ? 'success' : 'info');
    return update;
  } catch (error) {
    const rawMessage = String(error || '');
    const notConfigured = /todav[ií]a no est[aá] configurado|actualizador.*configurad/i.test(rawMessage);
    appState.updaterMessage = notConfigured
      ? 'Comprobación no disponible: el actualizador todavía no está configurado.'
      : 'No se pudo comprobar la actualización.';
    if (!silent) showToast(appState.updaterMessage, notConfigured ? 'info' : 'error');
    return null;
  } finally {
    appState.updaterCheckBusy = false;
    requestDownloadManagerRender({ force: true });
  }
}

async function installAvailableAppUpdate() {
  if (previewMode || storeManagedDistribution || appState.updaterStatus?.storeManaged || appState.updaterInstallBusy) return;
  const activeDownloads = Array.isArray(appState.snapshot?.jobs)
    ? appState.snapshot.jobs.some((job) => ['running', 'processing', 'finalizing', 'verifying'].includes(String(job.status || '').toLowerCase()))
    : false;
  if (activeDownloads) {
    showToast('Espera a que terminen las descargas activas antes de instalar.', 'info');
    return;
  }
  appState.updaterInstallBusy = true;
  appState.updaterProgress = { phase: 'download', percent: null, downloadedBytes: 0, contentLength: null };
  appState.updaterMessage = 'Descargando y verificando la actualización firmada…';
  requestDownloadManagerRender({ force: true });
  try {
    await invoke('install_app_update');
    const installedVersion = String(appState.availableUpdate?.version || '');
    const recorded = recordInstalledUpdate(appState.experienceSettings, installedVersion, appState.availableUpdate?.notes || '');
    await persistExperienceSettings({ ...recorded, pendingUpdateVersion: '' });
    appState.updaterMessage = 'Actualización instalada. Windows cerrará la aplicación para finalizar.';
  } catch (error) {
    appState.updaterMessage = String(error);
    appState.updaterProgress = null;
    appState.updaterInstallBusy = false;
    requestDownloadManagerRender({ force: true });
    showToast(appState.updaterMessage, 'error');
  }
}

let appearancePersistTimer = 0;
let autoScaleResizeTimer = 0;
let autoScaleResizeBound = false;
let autoScaleLastMeasurement = '';

function bindAutoScaleResize() {
  if (autoScaleResizeBound) return;
  autoScaleResizeBound = true;
  window.addEventListener('resize', () => {
    if (!appState.appearance?.autoScale) return;
    window.clearTimeout(autoScaleResizeTimer);
    autoScaleResizeTimer = window.setTimeout(() => {
      const measurement = `${Math.round(window.innerWidth)}x${Math.round(window.innerHeight)}:${automaticScalePercent()}`;
      if (measurement === autoScaleLastMeasurement) return;
      autoScaleLastMeasurement = measurement;
      applyAppAppearance(appState.appearance, { synchronize: false });
    }, 200);
  });
}

async function persistAppearance({ notify = false } = {}) {
  appState.appearance = normalizeAppearance({ ...appState.appearance, appearanceRevision: APPEARANCE_REVISION });
  storeAppearanceLocally(appState.appearance);
  applyAppAppearance(appState.appearance, { updateNativeIcon: true });
  if (!previewMode) {
    try { await invoke('save_appearance_settings', { appearance: appState.appearance }); } catch (error) { console.info(error); }
  }
  markAppearancePersistence();
  scheduleExtensionStatePublish(0);
  appState.appearanceSaved = true;
  const state = document.querySelector('.settings-saved-state');
  if (state) state.textContent = 'Guardado';
  if (notify) showToast('Ajustes guardados', 'success');
  window.setTimeout(() => {
    appState.appearanceSaved = false;
    const current = document.querySelector('.settings-saved-state');
    if (current) current.textContent = 'Guardando automáticamente';
  }, 1100);
}

function scheduleAppearancePersist(delay = 260) {
  window.clearTimeout(appearancePersistTimer);
  const state = document.querySelector('.settings-saved-state');
  if (state) state.textContent = 'Guardando…';
  appearancePersistTimer = window.setTimeout(() => void persistAppearance(), delay);
}

function imageEditorMarkup() {
  return `<section class="module-page image-editor-page"><header class="page-heading"><div class="page-title-wrap"><span class="page-title-icon">${icon('image', 25)}</span><div><h1>Editor de imágenes</h1><p>Edición local sin subir archivos a la nube.</p></div></div><button class="ghost-button image-editor-home">Volver al inicio</button></header><div class="module-embed-shell"><iframe class="module-iframe" title="Editor de imágenes" src="./modules/images/index.html"></iframe></div></section>`;
}

function documentsPageMarkup() {
  return localModuleMarkup('documents');
}
function localModuleMarkup(section) {
  const labels = { documents: 'Documentos', library: 'Biblioteca', images: 'Imágenes' };
  const label = labels[section] || 'Archivos locales';
  return `<section class="module-page local-module-page"><header class="page-heading"><div class="page-title-wrap"><span class="page-title-icon">${icon('folder', 25)}</span><div><h1>${escapeHtml(label)}</h1><p>Contenido administrado localmente por CacaTools.</p></div></div></header></section>`;
}

function libraryPageMarkup() {
  return localModuleMarkup('library');
}
function downloadsPageMarkup() {
  const openDownloadDialog = (prefillUrl = '') => { void openInternalDownloadWorkspace(prefillUrl); };
  return renderDownloadManager({
    snapshot: appState.snapshot,
    pendingJobs: appState.pendingJobs,
    schedules: appState.downloadSchedules,
    runtimeStatus: appState.runtimeStatus,
    mediaRuntimeStatus: appState.mediaRuntimeStatus,
    downloadDirectory: appState.downloadDirectory,
    updaterStatus: appState.updaterStatus,
    updaterCheckBusy: appState.updaterCheckBusy,
    updaterInstallBusy: appState.updaterInstallBusy,
    updaterProgress: appState.updaterProgress,
    availableUpdate: appState.availableUpdate,
    updaterMessage: appState.updaterMessage,
    autoUpdateEnabled: appState.autoUpdateEnabled,
    extensionBridgeStatus: appState.extensionBridgeStatus,
    startupStatus: appState.startupStatus,
    progressEngineStatus: appState.progressEngineStatus,
    windowBehavior: appState.windowBehavior,
    appearanceDensity: appState.appearance.density,
     appearance: { theme: appState.appearance.theme, accent: appState.appearance.accent, intensity: appState.appearance.intensity, scale: appState.appearance.scale, textScale: appState.appearance.textScale, progressActive: appState.appearance.progressActive, progressCompleted: appState.appearance.progressCompleted, progressPaused: appState.appearance.progressPaused, progressError: appState.appearance.progressError, progressActiveCustomized: appState.appearance.progressActiveCustomized, progressCompletedCustomized: appState.appearance.progressCompletedCustomized, iconColorMode: appState.appearance.iconColorMode, iconColor: appState.appearance.iconColor, density: appState.appearance.density },
    mediaPreferences: { outputMode: appState.selectedOutputMode, formatSelector: appState.selectedMediaFormat, videoQuality: appState.selectedVideoQuality, playlistFormat: appState.selectedPlaylistFormat },
    mediaSessionSettings: appState.mediaSessionSettings,
    experienceSettings: appState.experienceSettings,
    clipboardPrompt: appState.clipboardPrompt,
    newsMessages: newsMessages(),
    locale: currentLocale,
    newsFilter: runtimeState.newsFilter,
    translate: (key, ...args) => t(key, ...args),
    formatDate: (value) => formatLocaleDate(value, currentLocale()),
    onSupport: () => { void invoke('open_external_url', { url: 'https://www.paypal.com/donate/?hosted_button_id=JV9DUQKE265HY' }).catch((error) => showToast(friendlyError(error), 'error')); },
    onDismissHistory: (id) => {
      const ids = [...(appState.experienceSettings?.dismissedHistoryIds || []), String(id || '')].filter(Boolean).slice(-32);
      void persistExperienceSettings({ dismissedHistoryIds: ids });
      requestDownloadManagerRender({ force: true });
    },
    onDismissNews: (id) => {
      const ids = [...(appState.experienceSettings?.newsDismissedIds || []), String(id || '')].filter(Boolean).slice(-64);
      void persistExperienceSettings({ newsDismissedIds: ids });
      requestDownloadManagerRender({ force: true });
    },
    newsHasAttention: newsAttention(newsMessages(), appState.experienceSettings),
    previewMode,
    invoke,
    onNewDownload: openDownloadDialog,
    onBeforeOpenPreparation: () => {
      clearDownloadManagerSearchState();
      appState.unifiedSearchQuery = '';
      appState.unifiedSearchAlternatives = [];
      render();
    },
    onAnalyzeSource: routeDownloadAnalysis,
    onRefresh: async (options = {}) => { await refreshDownloadManager(options); },
    onOptimisticJobStatus: (id, status, options = {}) => {
      setOptimisticJobStatus(id, status, options);
      patchCurrentDownloadManagerLive(new Set([String(id)]));
    },
    onToast: showToast,
    onCheckUpdate: () => checkForAppUpdate(),
    onInstallUpdate: () => installAvailableAppUpdate(),
    onDismissUpdate: () => dismissAvailableAppUpdate(),
    onOpenExtension: async () => {
      await persistExperienceSettings({ extensionPromptDecision: 'accepted' });
      await invoke('open_external_url', { url: 'https://chromewebstore.google.com/detail/aonppfnabjnicjjeoofkfjofolfibggp?utm_source=item-share-cb' }).catch((error) => showToast(friendlyError(error), 'error'));
      requestDownloadManagerRender({ force: true });
    },
    onExtensionPromptDecision: (decision) => { if (['accepted', 'declined'].includes(decision)) { void persistExperienceSettings({ extensionPromptDecision: decision }); requestDownloadManagerRender({ force: true }); } },
    onNewsOpened: () => {
      const next = markNewsViewed(appState.experienceSettings, newsMessages());
      void persistExperienceSettings({ newsReadIds: next.newsReadIds });
      requestDownloadManagerRender({ force: true });
    },
    getClipboardPrompt: () => appState.clipboardPrompt,
    onClipboardPreviewAction: async (prompt, action, suppress) => {
      finishClipboardPrompt(action, suppress);
      if (action === 'analyze' && prompt?.url) await routeLinkIntent(prompt.url, { source: 'clipboard-preview' });
    },
    onOpenFeedback: async () => {
      await invoke('open_external_url', { url: 'https://github.com/CacaPlay/clear-download-manager/issues/new' }).catch((error) => showToast(friendlyError(error), 'error'));
    },
    onOpenNewsUrl: async (url) => {
      try {
        const parsed = new URL(String(url || ''));
        if (parsed.protocol !== 'https:' || !['github.com', 'chromewebstore.google.com'].includes(parsed.hostname.toLowerCase())) throw new Error('URL de novedades no permitida');
        await invoke('open_external_url', { url: parsed.toString() });
      } catch (error) { showToast(friendlyError(error), 'error'); }
    },
    onOpenPlayer: async (jobId) => { if (!previewMode) await invoke('open_media_player', { jobId: Number(jobId) }); },
    onOpenPlaylistPlayer: async (batchId) => { if (!previewMode) await invoke('open_playlist_media_player', { batchId: Number(batchId) }); },
    onSection: (section) => {
      if (section !== 'settings') return false;
      appState.settingsReturnSection = appState.activeSection === 'Ajustes' ? 'Descargas' : appState.activeSection;
      appState.activeSection = 'Ajustes';
      render();
      return true;
    }
  });
}

function bindEvents() {
  bindAutoScaleResize();
  bindThumbnailFallbacks();
  document.querySelectorAll('.nav-item').forEach((button) => button.addEventListener('click', () => {
    appState.activeSection = button.dataset.section || 'Inicio';
    appState.activeTool = null;
    render();
  }));
  document.querySelectorAll('[data-section-jump]').forEach((button) => button.addEventListener('click', () => {
    appState.activeSection = button.dataset.sectionJump || 'Inicio';
    render();
  }));
  document.querySelector('.settings-back')?.addEventListener('click', () => {
    appState.activeSection = appState.settingsReturnSection || 'Descargas';
    render();
  });
  document.querySelectorAll('[data-settings-category]').forEach((button) => button.addEventListener('click', () => {
    appState.settingsCategory = button.dataset.settingsCategory || 'general';
    render();
  }));
  document.querySelector('#bandwidth-limit-select')?.addEventListener('change', async (event) => {
    const value = event.currentTarget.value;
    if (value === 'custom') {
      hydrateBandwidthEditor(appState.bandwidthSettings);
      appState.bandwidthEditorMode = 'custom';
      render();
      return;
    }
    event.currentTarget.disabled = true;
    try {
      await persistBandwidthSettings(value === 'unlimited'
        ? { mode: 'unlimited' }
        : { mode: 'limited', bytesPerSecond: Number(value) });
      render();
      showToast('Límite de velocidad guardado', 'success');
    } catch (error) {
      event.currentTarget.disabled = false;
      showToast(String(error), 'error');
    }
  });
  const bandwidthCustomValue = document.querySelector('#bandwidth-custom-value');
  const bandwidthCustomUnit = document.querySelector('#bandwidth-custom-unit');
  bandwidthCustomValue?.addEventListener('input', (event) => { appState.bandwidthCustomValue = event.currentTarget.value; });
  bandwidthCustomUnit?.addEventListener('change', (event) => { appState.bandwidthCustomUnit = event.currentTarget.value === 'KB' ? 'KB' : 'MB'; });
  document.querySelector('.save-bandwidth-custom')?.addEventListener('click', async (event) => {
    const value = Number(bandwidthCustomValue?.value);
    const multiplier = bandwidthCustomUnit?.value === 'KB' ? 1_000 : 1_000_000;
    const bytesPerSecond = value * multiplier;
    if (!Number.isSafeInteger(value) || value <= 0 || !Number.isSafeInteger(bytesPerSecond)) {
      showToast('Introduce una velocidad entera válida', 'error');
      return;
    }
    event.currentTarget.disabled = true;
    try {
      await persistBandwidthSettings({ mode: 'limited', bytesPerSecond });
      render();
      showToast('Límite de velocidad guardado', 'success');
    } catch (error) {
      event.currentTarget.disabled = false;
      showToast(String(error), 'error');
    }
  });
  const httpConcurrencyInput = document.querySelector('#http-concurrency-input');
  const multimediaConcurrencyInput = document.querySelector('#multimedia-concurrency-input');
  const saveDownloadConcurrency = async () => {
    const inputs = [httpConcurrencyInput, multimediaConcurrencyInput].filter(Boolean);
    inputs.forEach((input) => { input.disabled = true; });
    try {
      await persistDownloadConcurrency({
        http: Number(httpConcurrencyInput?.value),
        multimedia: Number(multimediaConcurrencyInput?.value)
      });
      render();
      showToast('Descargas simultáneas guardadas', 'success');
    } catch (error) {
      inputs.forEach((input) => { input.disabled = false; });
      showToast(String(error), 'error');
    }
  };
  httpConcurrencyInput?.addEventListener('change', saveDownloadConcurrency);
  multimediaConcurrencyInput?.addEventListener('change', saveDownloadConcurrency);
  document.querySelector('.tool-update-check')?.addEventListener('click', async () => {
    if (appState.toolUpdateChecking || appState.toolUpdateApplying) return;
    appState.toolUpdateChecking = true;
    appState.toolUpdateStatus = { ...(appState.toolUpdateStatus || {}), state: 'CHECKING', canUpdate: false };
    render();
    try {
      appState.toolUpdateStatus = await invoke('check_tool_updates_now');
    } catch {
      appState.toolUpdateStatus = { ...(appState.toolUpdateStatus || {}), state: 'OFFLINE', canUpdate: false };
    } finally {
      appState.toolUpdateChecking = false;
      render();
    }
  });
  const toolRepositories = {
    'yt-dlp': 'https://github.com/yt-dlp/yt-dlp',
    ffmpeg: 'https://github.com/GyanD/codexffmpeg',
    deno: 'https://github.com/denoland/deno',
    aria2: 'https://github.com/aria2/aria2'
  };
  document.querySelectorAll('[data-settings-tool-repo]').forEach((button) => button.addEventListener('click', () => {
    const url = toolRepositories[button.dataset.settingsToolRepo];
    if (url) void invoke('open_external_url', { url }).catch((error) => showToast(friendlyError(error), 'error'));
  }));
  document.querySelector('[data-settings-official-site]')?.addEventListener('click', () => {
    void invoke('open_external_url', { url: 'https://cdm.cacaplay.lat' }).catch((error) => showToast(friendlyError(error), 'error'));
  });
  document.querySelector('.tool-update-apply')?.addEventListener('click', async () => {
    if (!appState.toolUpdateStatus?.canUpdate || appState.toolUpdateChecking || appState.toolUpdateApplying) return;
    appState.toolUpdateApplying = true;
    appState.toolUpdateStatus = { ...(appState.toolUpdateStatus || {}), state: 'INSTALLING', canUpdate: false };
    render();
    try {
      appState.toolUpdateStatus = await invoke('apply_available_tool_update');
    } catch {
      appState.toolUpdateStatus = { ...(appState.toolUpdateStatus || {}), state: 'FAILED', canUpdate: false };
    } finally {
      appState.toolUpdateApplying = false;
      render();
    }
  });
  document.querySelector('.settings-advanced-toggle')?.addEventListener('click', (event) => {
    const expanded = event.currentTarget.getAttribute('aria-expanded') === 'true';
    setSettingsAdvancedOpen(!expanded);
    render();
  });
  document.querySelectorAll('.empty-new-download').forEach((button) => button.addEventListener('click', () => { void openInternalDownloadWorkspace(); }));
  document.querySelectorAll('.settings-accent-swatch:not(.settings-icon-color-swatch)').forEach((button) => button.addEventListener('click', () => {
    const preset = appearancePresets.find((entry) => entry.id === button.dataset.preset);
    if (!preset) return;
    appState.appearance = normalizeAppearance({ ...appState.appearance, ...preset, preset: preset.id, appearanceRevision: APPEARANCE_REVISION });
    storeAppearanceLocally(appState.appearance);
    applyAppAppearance(appState.appearance);
    document.querySelectorAll('.settings-accent-swatch').forEach((entry) => {
      const isActive = entry === button;
      entry.classList.toggle('is-active', isActive);
      entry.setAttribute('aria-pressed', String(isActive));
    });
    const colorInput = document.querySelector('#accent-color');
    const colorCode = document.querySelector('.settings-custom-color code');
    if (colorInput) colorInput.value = appState.appearance.accent;
    if (colorCode) colorCode.textContent = appState.appearance.accent.toUpperCase();
    scheduleAppearancePersist();
  }));
  document.querySelectorAll('.settings-icon-color-swatch').forEach((button) => button.addEventListener('click', () => {
    const color = button.dataset.iconColor;
    if (!/^#[0-9a-f]{6}$/i.test(String(color || ''))) return;
    appState.appearance = normalizeAppearance({ ...appState.appearance, iconColorMode: 'custom', iconColor: color, appearanceRevision: APPEARANCE_REVISION });
    storeAppearanceLocally(appState.appearance);
    applyAppAppearance(appState.appearance);
    const customMode = document.querySelector('[data-appearance-field="iconColorMode"][value="custom"]');
    if (customMode) customMode.checked = true;
    const iconInput = document.querySelector('#icon-color');
    if (iconInput) { iconInput.disabled = false; iconInput.value = color; }
    document.querySelector('.settings-icon-color-picker')?.classList.remove('is-disabled');
    const iconCode = document.querySelector('.settings-icon-color-picker code');
    if (iconCode) iconCode.textContent = color.toUpperCase();
    document.querySelectorAll('.settings-icon-color-swatch').forEach((entry) => {
      const active = entry === button;
      entry.classList.toggle('is-active', active);
      entry.setAttribute('aria-pressed', String(active));
    });
    scheduleAppearancePersist();
  }));
  const scaleRange = document.querySelector('#scale-range');
  const scaleNumber = document.querySelector('#scale-number');
  const scaleDecrease = document.querySelector('#scale-decrease');
  const scaleIncrease = document.querySelector('#scale-increase');
  const syncRangeVisual = (control) => {
    const min = Number(control.min || 0);
    const max = Number(control.max || 100);
    const value = Number(control.value || min);
    const percent = max > min ? Math.max(0, Math.min(100, ((value - min) / (max - min)) * 100)) : 0;
    control.style.setProperty('--range-percent', `${percent}%`);
  };
  const setScaleControls = (rawValue, { disableAuto = true } = {}) => {
    const value = displayedScalePercent(rawValue);
    if (disableAuto) {
      appState.appearance.autoScale = false;
      const auto = document.querySelector('#auto-scale-select');
      if (auto) auto.value = 'false';
    }
    if (scaleRange) { scaleRange.value = String(value); scaleRange.disabled = false; syncRangeVisual(scaleRange); }
    if (scaleNumber) { scaleNumber.value = String(value); scaleNumber.disabled = false; }
    if (scaleDecrease) scaleDecrease.disabled = value <= 50;
    if (scaleIncrease) scaleIncrease.disabled = value >= 130;
    document.querySelector('.settings-scale-control')?.classList.remove('is-disabled');
    return value;
  };
  const updateLiveAccentFromControl = (patch = {}) => {
    appState.appearance = normalizeAppearance({
      ...appState.appearance,
      ...patch,
      preset: 'custom',
      appearanceRevision: APPEARANCE_REVISION
    });
    scheduleAppearanceLivePreview(appState.appearance);
    if (patch.accent) {
      const colorCode = document.querySelector('.settings-custom-color code');
      if (colorCode) colorCode.textContent = appState.appearance.accent.toUpperCase();
    }
    if (patch.intensity != null) {
      const output = document.querySelector('[data-setting-value="intensity"]');
      if (output) output.textContent = `${appState.appearance.intensity}%`;
    }
  };
  const updateAppearanceFromControls = ({ commit = false } = {}) => {
    const appearanceValue = (field, fallback) => document.querySelector(`[data-appearance-field="${field}"]:checked`)?.value
      ?? document.querySelector(`[data-appearance-field="${field}"]`)?.value
      ?? fallback;
    const color = document.querySelector('#accent-color')?.value || appState.appearance.accent;
    const autoScaleValue = document.querySelector('#auto-scale-select')?.value;
    const autoScale = autoScaleValue == null ? appState.appearance.autoScale : autoScaleValue === 'true';
    const scale = displayedScalePercent(scaleNumber?.value ?? scaleRange?.value ?? appState.appearance.scale);
    appState.appearance = normalizeAppearance({
      ...appState.appearance,
      theme: appearanceValue('theme', appState.appearance.theme),
      preset: color === appState.appearance.accent ? appState.appearance.preset : 'custom', accent: color,
      progressActive: document.querySelector('#progress-active-color')?.value ?? appState.appearance.progressActive,
      progressCompleted: document.querySelector('#progress-completed-color')?.value ?? appState.appearance.progressCompleted,
      progressPaused: document.querySelector('#progress-paused-color')?.value ?? appState.appearance.progressPaused,
      progressError: document.querySelector('#progress-error-color')?.value ?? appState.appearance.progressError,
      progressActiveCustomized: appState.appearance.progressActiveCustomized,
      progressCompletedCustomized: appState.appearance.progressCompletedCustomized,
      iconColorMode: appearanceValue('iconColorMode', appState.appearance.iconColorMode),
      iconColor: document.querySelector('#icon-color')?.value ?? appState.appearance.iconColor,
      tone: document.querySelector('#tone-range')?.value ?? appState.appearance.tone,
      intensity: document.querySelector('#intensity-range')?.value ?? appState.appearance.intensity,
      contrast: document.querySelector('#contrast-range')?.value ?? appState.appearance.contrast,
      scale,
      textScale: document.querySelector('#text-scale-range')?.value ?? appState.appearance.textScale,
      density: appearanceValue('density', appState.appearance.density),
      thumbnailSize: appearanceValue('thumbnailSize', appState.appearance.thumbnailSize),
      autoScale,
      motionMode: appearanceValue('motionMode', appState.appearance.motionMode),
      surfaceMode: appearanceValue('surfaceMode', appState.appearance.surfaceMode),
      radius: appearanceValue('radius', appState.appearance.radius),
      appearanceRevision: APPEARANCE_REVISION
    });
    void applyThemeWithMotion(appState.appearance, { synchronize: commit, updateNativeIcon: commit });
    const colorCode = document.querySelector('.settings-custom-color code');
    if (colorCode) colorCode.textContent = appState.appearance.accent.toUpperCase();
    const values = {
      tone: String(appState.appearance.tone),
      intensity: `${appState.appearance.intensity}%`,
      contrast: `${appState.appearance.contrast}%`,
      'text-scale': `${appState.appearance.textScale}%`
    };
    Object.entries(values).forEach(([key, value]) => {
      const output = document.querySelector(`[data-setting-value="${key}"]`);
      if (output) output.textContent = value;
    });
    if (commit) scheduleAppearancePersist(0);
  };
  const syncIconColorControl = () => {
    const mode = document.querySelector('[data-appearance-field="iconColorMode"]:checked')?.value || appState.appearance.iconColorMode;
    const input = document.querySelector('#icon-color');
    const picker = document.querySelector('.settings-icon-color-picker');
    if (input) input.disabled = mode !== 'custom';
    picker?.classList.toggle('is-disabled', mode !== 'custom');
  };
  syncIconColorControl();
  document.querySelector('#icon-color')?.addEventListener('input', (event) => {
    const color = String(event.currentTarget.value || '').toLowerCase();
    document.querySelectorAll('.settings-icon-color-swatch').forEach((entry) => {
      const active = String(entry.dataset.iconColor || '').toLowerCase() === color;
      entry.classList.toggle('is-active', active);
      entry.setAttribute('aria-pressed', String(active));
    });
    const iconCode = document.querySelector('.settings-icon-color-picker code');
    if (iconCode) iconCode.textContent = color.toUpperCase();
  });
  document.querySelectorAll('input[type="range"]').forEach((control) => {
    syncRangeVisual(control);
    control.addEventListener('input', () => syncRangeVisual(control));
    control.addEventListener('pointerdown', (event) => {
      if (typeof control.setPointerCapture === 'function') control.setPointerCapture(event.pointerId);
    });
    const releasePointerCapture = (event) => {
      if (typeof control.hasPointerCapture === 'function' && control.hasPointerCapture(event.pointerId) && typeof control.releasePointerCapture === 'function') control.releasePointerCapture(event.pointerId);
    };
    control.addEventListener('pointerup', releasePointerCapture);
    control.addEventListener('pointercancel', releasePointerCapture);
  });
  document.querySelector('#accent-color')?.addEventListener('input', (event) => updateLiveAccentFromControl({ accent: event.currentTarget.value }));
  document.querySelector('#intensity-range')?.addEventListener('input', (event) => updateLiveAccentFromControl({ intensity: event.currentTarget.value }));
  document.querySelector('#accent-color')?.addEventListener('change', () => scheduleAppearancePersist(0));
  document.querySelector('#intensity-range')?.addEventListener('change', () => scheduleAppearancePersist(0));
  document.querySelectorAll('[data-appearance-field]').forEach((control) => {
    if (control.id !== 'accent-color' && control.id !== 'intensity-range' && control.id !== 'auto-scale-select') {
      control.addEventListener('input', () => {
        const field = control.dataset.appearanceField;
        if (field === 'progressActive') appState.appearance.progressActiveCustomized = true;
        if (field === 'progressCompleted') appState.appearance.progressCompletedCustomized = true;
        if (field === 'iconColorMode') syncIconColorControl();
        updateAppearanceFromControls();
      });
      control.addEventListener('change', () => {
        const field = control.dataset.appearanceField;
        if (field === 'progressActive') appState.appearance.progressActiveCustomized = true;
        if (field === 'progressCompleted') appState.appearance.progressCompletedCustomized = true;
        if (field === 'iconColorMode') syncIconColorControl();
        updateAppearanceFromControls({ commit: true });
      });
    }
  });
  scaleRange?.addEventListener('input', (event) => { setScaleControls(event.target.value); updateAppearanceFromControls(); });
  scaleRange?.addEventListener('change', (event) => { setScaleControls(event.target.value); updateAppearanceFromControls({ commit: true }); });
  scaleNumber?.addEventListener('change', (event) => { setScaleControls(event.target.value); updateAppearanceFromControls({ commit: true }); });
  scaleNumber?.addEventListener('keydown', (event) => { if (event.key === 'Enter') { event.preventDefault(); setScaleControls(event.currentTarget.value); updateAppearanceFromControls({ commit: true }); } });
  scaleDecrease?.addEventListener('click', () => { setScaleControls(Number(scaleNumber?.value || appState.appearance.scale) - 5); updateAppearanceFromControls({ commit: true }); });
  scaleIncrease?.addEventListener('click', () => { setScaleControls(Number(scaleNumber?.value || appState.appearance.scale) + 5); updateAppearanceFromControls({ commit: true }); });
  document.querySelector('#auto-scale-select')?.addEventListener('change', (event) => {
    const disabled = event.target.value === 'true';
    [scaleRange, scaleNumber, scaleDecrease, scaleIncrease].filter(Boolean).forEach((element) => { element.disabled = disabled; });
    document.querySelector('.settings-scale-control')?.classList.toggle('is-disabled', disabled);
    const manualValue = displayedScalePercent(appState.appearance.scale);
    if (scaleRange) { scaleRange.value = String(manualValue); syncRangeVisual(scaleRange); }
    if (scaleNumber) scaleNumber.value = String(manualValue);
    if (!disabled) setScaleControls(manualValue, { disableAuto: false });
    updateAppearanceFromControls({ commit: true });
  });
  document.querySelector('#close-action-select')?.addEventListener('change', async (event) => {
    if (previewMode) { appState.windowBehavior = { closeAction: event.target.value, minimizeAction: 'taskbar' }; return; }
    const closeAction = event.target.value === 'exit' ? 'exit' : 'tray';
    event.target.disabled = true;
    try {
      appState.windowBehavior = await invoke('save_window_behavior_settings', { settings: { closeAction, minimizeAction: 'taskbar' } });
      showToast(closeAction === 'exit' ? 'Cerrar ahora saldrá completamente' : 'Cerrar ahora enviará CacaTools a la bandeja', 'success');
    } catch (error) {
      event.target.value = appState.windowBehavior?.closeAction || 'tray';
      showToast(String(error), 'error');
    } finally {
      event.target.disabled = false;
    }
  });
  document.querySelector('#startup-toggle')?.addEventListener('change', async (event) => {
    if (previewMode) return;
    const enabled = Boolean(event.target.checked);
    event.target.disabled = true;
    try {
      appState.startupStatus = await invoke('set_startup_behavior', { enabled });
      showToast(enabled ? 'Inicio en segundo plano activado' : 'Inicio en segundo plano desactivado', 'success');
    } catch (error) {
      event.target.checked = !enabled;
      showToast(String(error), 'error');
    } finally {
      event.target.disabled = false;
      render();
    }
  });
  document.querySelectorAll('[data-experience-field]').forEach((control) => control.addEventListener('change', async (event) => {
    const key = event.currentTarget.dataset.experienceField;
    if (!key) return;
    const value = event.currentTarget.tagName === 'SELECT' ? event.currentTarget.value : Boolean(event.currentTarget.checked);
    if (key === 'locale') {
      const normalized = saveLocale(value);
      await persistExperienceSettings({ locale: normalized });
      document.documentElement.lang = resolveLocale(normalized);
      showToast('Idioma guardado', 'success');
      render();
      return;
    }
    await persistExperienceSettings({ [key]: value });
    appState.autoUpdateEnabled = appState.experienceSettings.automaticUpdateChecks !== false;
    showToast('Preferencia guardada', 'success');
    render();
  }));
  document.querySelector('.repair-windows-integration')?.addEventListener('click', async (event) => {
    if (previewMode) return;
    const button = event.currentTarget;
    button.disabled = true;
    try {
      const result = await invoke('repair_windows_integration');
      appState.startupStatus = result?.startup || appState.startupStatus;
      appState.extensionBridgeStatus = result?.extension || appState.extensionBridgeStatus;
      showToast('Integración de Windows reparada', 'success');
    } catch (error) {
      showToast(`No se pudo reparar la integración: ${String(error)}`, 'error');
    } finally {
      button.disabled = false;
      render();
    }
  });
  document.querySelector('.settings-reset-colors')?.addEventListener('click', () => {
    appState.appearance = normalizeAppearance({
      ...appState.appearance,
      preset: defaultAppearance.preset,
      accent: defaultAppearance.accent,
      tone: defaultAppearance.tone,
      intensity: defaultAppearance.intensity,
      contrast: defaultAppearance.contrast,
      progressActive: defaultAppearance.progressActive,
      progressCompleted: defaultAppearance.progressCompleted,
      progressPaused: defaultAppearance.progressPaused,
      progressError: defaultAppearance.progressError,
      progressActiveCustomized: false,
      progressCompletedCustomized: false,
      iconColorMode: defaultAppearance.iconColorMode,
      iconColor: defaultAppearance.iconColor,
      appearanceRevision: APPEARANCE_REVISION
    });
    storeAppearanceLocally(appState.appearance);
    applyAppAppearance(appState.appearance);
    scheduleAppearancePersist();
    showToast('Colores predeterminados restaurados', 'success');
    render();
  });
  document.querySelector('.copy-visual-diagnostics')?.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(JSON.stringify(visualDiagnosticsSnapshot(), null, 2));
      showToast('Diagnóstico visual copiado', 'success');
    } catch {
      showToast('No se pudo copiar el diagnóstico visual', 'error');
    }
  });
  document.querySelector('.settings-reset')?.addEventListener('click', async () => { appState.appearance = normalizeAppearance(defaultAppearance); await persistAppearance({ notify: true }); render(); });

  const chooseDownloadDirectory = async () => {
    if (previewMode) {
      appState.downloadDirectory = 'D:\\Descargas\\CacaTools';
      render();
      return;
    }
    try {
      const selected = await chooseDestinationDirectory(invoke);
      if (selected) {
        appState.downloadDirectory = selected;
        await loadSnapshot();
        render();
      }
    } catch (error) {
      showToast(String(error), 'error');
    }
  };
  document.querySelector('.choose-download-directory')?.addEventListener('click', chooseDownloadDirectory);
  document.querySelectorAll('.choose-folder-inline').forEach((button) => button.addEventListener('click', chooseDownloadDirectory));
  bindPlaylistPreviewButtons();
  document.querySelector('.open-download-directory')?.addEventListener('click', async () => {
    if (previewMode) return;
    try { await invoke('open_download_directory'); } catch (error) { showToast(String(error), 'error'); }
  });

  bindDynamicListEvents();

  const openDownloadDialog = (prefillUrl = '') => { void openInternalDownloadWorkspace(prefillUrl); };
  bindDownloadManager({
    snapshot: appState.snapshot,
    pendingJobs: appState.pendingJobs,
    schedules: appState.downloadSchedules,
    availableUpdate: appState.availableUpdate,
    updaterInstallBusy: appState.updaterInstallBusy,
    updaterProgress: appState.updaterProgress,
    experienceSettings: appState.experienceSettings,
    newsMessages: newsMessages(),
    locale: currentLocale,
    newsFilter: runtimeState.newsFilter,
    translate: (key, ...args) => t(key, ...args),
    formatDate: (value) => formatLocaleDate(value, currentLocale()),
    onSupport: () => { void invoke('open_external_url', { url: 'https://www.paypal.com/donate/?hosted_button_id=JV9DUQKE265HY' }).catch((error) => showToast(friendlyError(error), 'error')); },
    onDismissHistory: (id) => {
      const ids = [...(appState.experienceSettings?.dismissedHistoryIds || []), String(id || '')].filter(Boolean).slice(-32);
      void persistExperienceSettings({ dismissedHistoryIds: ids });
      requestDownloadManagerRender({ force: true });
    },
    onDismissNews: (id) => {
      const ids = [...(appState.experienceSettings?.newsDismissedIds || []), String(id || '')].filter(Boolean).slice(-64);
      void persistExperienceSettings({ newsDismissedIds: ids });
      requestDownloadManagerRender({ force: true });
    },
    newsHasAttention: newsAttention(newsMessages(), appState.experienceSettings),
    invoke,
    onNewDownload: openDownloadDialog,
    onBeforeOpenPreparation: () => {
      clearDownloadManagerSearchState();
      appState.unifiedSearchQuery = '';
      appState.unifiedSearchAlternatives = [];
      render();
    },
    onAnalyzeSource: routeDownloadAnalysis,
    onSearchResults: (query, results) => { appState.unifiedSearchQuery = String(query || ''); appState.unifiedSearchAlternatives = Array.isArray(results) ? results.slice(0, 20) : []; },
    onRefresh: async (options = {}) => { await refreshDownloadManager(options); },
    onOptimisticJobStatus: (id, status, options = {}) => {
      setOptimisticJobStatus(id, status, options);
      patchCurrentDownloadManagerLive(new Set([String(id)]));
    },
    onOpenPlayer: async (jobId) => {
      if (previewMode) return;
      await invoke('open_media_player', { jobId: Number(jobId) });
    },
    onOpenPlaylistPlayer: async (batchId) => {
      if (previewMode) return;
      await invoke('open_playlist_media_player', { batchId: Number(batchId) });
    },
    onCheckUpdate: () => checkForAppUpdate(),
    onInstallUpdate: () => installAvailableAppUpdate(),
    onDismissUpdate: () => dismissAvailableAppUpdate(),
    onOpenExtension: async () => {
      await persistExperienceSettings({ extensionPromptDecision: 'accepted' });
      await invoke('open_external_url', { url: 'https://chromewebstore.google.com/detail/aonppfnabjnicjjeoofkfjofolfibggp?utm_source=item-share-cb' }).catch((error) => showToast(friendlyError(error), 'error'));
      requestDownloadManagerRender({ force: true });
    },
    onExtensionPromptDecision: (decision) => { if (['accepted', 'declined'].includes(decision)) { void persistExperienceSettings({ extensionPromptDecision: decision }); requestDownloadManagerRender({ force: true }); } },
    onNewsOpened: () => {
      const next = markNewsViewed(appState.experienceSettings, newsMessages());
      void persistExperienceSettings({ newsReadIds: next.newsReadIds });
      requestDownloadManagerRender({ force: true });
    },
    getClipboardPrompt: () => appState.clipboardPrompt,
    onClipboardPreviewAction: async (prompt, action, suppress) => {
      finishClipboardPrompt(action, suppress);
      if (action === 'analyze' && prompt?.url) await routeLinkIntent(prompt.url, { source: 'clipboard-preview' });
    },
    onOpenFeedback: async (payload = {}) => {
      const type = String(payload.type || 'bug').trim();
      const title = String(payload.title || '').trim();
      const description = String(payload.description || '').trim();
      const steps = String(payload.steps || '').trim();
      if (type === 'problem' && !steps) {
        showToast('Añade los pasos para reproducir el problema.', 'error');
        return;
      }
      const body = [`Versión: ${APP_VERSION}`, `Windows: ${navigator.userAgent}`, `Tipo: ${type}`, '', description ? `Descripción:\n${description}` : '', steps ? `\nPasos para reproducir:\n${steps}` : ''].filter(Boolean).join('\n');
      const url = `https://github.com/CacaPlay/clear-download-manager/issues/new?title=${encodeURIComponent(title || 'Reporte de Clear Download Manager')}&body=${encodeURIComponent(body)}`;
      await invoke('open_external_url', { url }).catch((error) => showToast(friendlyError(error), 'error'));
    },
    onOpenNewsUrl: async (url) => {
      try {
        const parsed = new URL(String(url || ''));
        if (parsed.protocol !== 'https:' || !['github.com', 'chromewebstore.google.com'].includes(parsed.hostname.toLowerCase())) throw new Error('URL de novedades no permitida');
        await invoke('open_external_url', { url: parsed.toString() });
      } catch (error) { showToast(friendlyError(error), 'error'); }
    },
    onAutoUpdateChange: (enabled) => {
      appState.autoUpdateEnabled = Boolean(enabled);
      void persistExperienceSettings({ automaticUpdateChecks: appState.autoUpdateEnabled });
      requestDownloadManagerRender({ force: true });
    },
    onChooseDownloadDirectory: chooseDownloadDirectory,
    onOpenDownloadDirectory: async () => {
      if (previewMode) return;
      try { await invoke('open_download_directory'); } catch (error) { showToast(String(error), 'error'); }
    },
    onMediaPreferencesChange: (patch = {}) => {
      if (patch.outputMode) {
        appState.selectedOutputMode = String(patch.outputMode);
        const formats = appState.mediaAnalysis?.formats || [];
        const preferred = preferredFormatForOutput(formats, appState.selectedOutputMode);
        appState.selectedMediaFormat = preferred?.id
          || (appState.selectedOutputMode === 'audio_m4a' ? 'bestaudio[ext=m4a]/bestaudio/best'
            : appState.selectedOutputMode === 'audio_best' ? 'bestaudio/best'
              : appState.selectedOutputMode.startsWith('audio_') ? 'bestaudio/best'
              : videoSelectorForQuality(appState.selectedVideoQuality));
        if (!outputModeIsAudio(appState.selectedOutputMode) && appState.selectedVideoQuality !== 'best'
          && !/height<=\d+/.test(String(appState.selectedMediaFormat || ''))) {
          appState.selectedMediaFormat = videoSelectorForQuality(appState.selectedVideoQuality);
        }
      }
      if (patch.quality) {
        appState.selectedVideoQuality = normalizeVideoQuality(patch.quality);
        if (!outputModeIsAudio(appState.selectedOutputMode)) {
          const selected = preferredVideoFormat(appState.mediaAnalysis?.formats || [], appState.selectedVideoQuality);
          appState.selectedMediaFormat = selected?.id || videoSelectorForQuality(appState.selectedVideoQuality);
          if (appState.selectedVideoQuality !== 'best' && !/height<=\d+/.test(String(appState.selectedMediaFormat || ''))) {
            appState.selectedMediaFormat = videoSelectorForQuality(appState.selectedVideoQuality);
          }
        }
      }
      if (patch.playlistFormat) appState.selectedPlaylistFormat = String(patch.playlistFormat);
      persistMediaDownloadPreferences();
      showToast('Preferencias multimedia guardadas', 'success');
      requestDownloadManagerRender({ force: true });
    },
    onMediaSessionChange: async (patch = {}) => {
      if (previewMode) return;
      const current = appState.mediaSessionSettings || {};
      try {
        appState.mediaSessionSettings = await invoke('save_media_session_settings', {
          useBraveCookies: patch.useBraveCookies !== undefined ? Boolean(patch.useBraveCookies) : Boolean(current.useBraveCookies),
          cookiesPath: patch.cookiesPath !== undefined ? (patch.cookiesPath || null) : (current.cookiesPath || null)
        });
        showToast('Sesión multimedia guardada en Ajustes', 'success');
      } catch (error) {
        showToast(`No se pudo guardar la sesión multimedia: ${String(error)}`, 'error');
      }
      requestDownloadManagerRender({ force: true });
    },
    onChooseMediaCookies: async () => {
      if (previewMode) return;
      try {
        const path = await invoke('choose_media_cookies_file');
        if (path) {
          appState.mediaSessionSettings = await invoke('save_media_session_settings', { useBraveCookies: false, cookiesPath: String(path) });
          showToast('Archivo de cookies guardado en Ajustes', 'success');
        }
      } catch (error) {
        showToast(`No se pudo guardar el archivo de cookies: ${String(error)}`, 'error');
      }
      requestDownloadManagerRender({ force: true });
    },
    onRepairIntegration: async () => {
      if (previewMode) return;
      try {
        const result = await invoke('repair_windows_integration');
        appState.startupStatus = result?.startup || appState.startupStatus;
        appState.extensionBridgeStatus = result?.extension || appState.extensionBridgeStatus;
        showToast('Integración de Windows reparada', 'success');
      } catch (error) { showToast(String(error), 'error'); }
      requestDownloadManagerRender({ force: true });
    },
    onRefreshRuntime: async () => {
      if (previewMode) return;
      try {
        [appState.runtimeStatus, appState.mediaRuntimeStatus, appState.extensionBridgeStatus] = await Promise.all([
          invoke('runtime_status'),
          invoke('media_runtime_status'),
          invoke('extension_bridge_status')
        ]);
        showToast('Estado de componentes actualizado', 'success');
      } catch (error) { showToast(String(error), 'error'); }
      requestDownloadManagerRender({ force: true });
    },
    onCopyDiagnostics: async () => {
      const diagnostics = {
        generatedAt: new Date().toISOString(),
        application: appState.runtimeStatus,
        multimedia: appState.mediaRuntimeStatus,
        updater: appState.updaterStatus,
        extension: appState.extensionBridgeStatus,
        startup: appState.startupStatus,
        windowBehavior: appState.windowBehavior,
        appearance: appState.appearance,
        mediaPreferences: { outputMode: appState.selectedOutputMode, formatSelector: appState.selectedMediaFormat, videoQuality: appState.selectedVideoQuality, playlistFormat: appState.selectedPlaylistFormat },
        visual: visualDiagnosticsSnapshot()
      };
      try {
        await navigator.clipboard.writeText(JSON.stringify(diagnostics, null, 2));
        showToast('Diagnóstico copiado', 'success');
      } catch { showToast('No se pudo copiar el diagnóstico', 'error'); }
    },
    onStartupChange: async (enabled) => {
      if (previewMode) return;
      try {
        appState.startupStatus = await invoke('set_startup_behavior', { enabled: Boolean(enabled) });
        showToast(enabled ? 'Inicio en segundo plano activado' : 'Inicio en segundo plano desactivado', 'success');
        requestDownloadManagerRender({ force: true });
      } catch (error) {
        showToast(String(error), 'error');
        requestDownloadManagerRender({ force: true });
      }
    },
    onWindowBehaviorChange: async (closeAction) => {
      if (previewMode) return;
      try {
        appState.windowBehavior = await invoke('save_window_behavior_settings', { settings: { closeAction: closeAction === 'exit' ? 'exit' : 'tray', minimizeAction: 'taskbar' } });
        showToast(appState.windowBehavior.closeAction === 'exit' ? 'Cerrar saldrá completamente' : 'Cerrar enviará la app a la bandeja', 'success');
        requestDownloadManagerRender({ force: true });
      } catch (error) {
        showToast(String(error), 'error');
        requestDownloadManagerRender({ force: true });
      }
    },
    onUiScaleChange: (uiScale, { commit = false } = {}) => {
      appState.appearance = normalizeAppearance({ ...appState.appearance, scale: displayedScalePercent(uiScale), autoScale: false, appearanceRevision: APPEARANCE_REVISION });
      applyAppAppearance(appState.appearance, { synchronize: commit, updateNativeIcon: false });
      if (commit) scheduleAppearancePersist(0);
    },
    onAppearanceChange: (patch = {}, { commit = true } = {}) => {
      const customizesAccent = Object.keys(patch).some((key) => key === 'accent' || key === 'intensity');
      appState.appearance = normalizeAppearance({ ...appState.appearance, ...patch, ...(customizesAccent ? { preset: 'custom' } : {}), appearanceRevision: APPEARANCE_REVISION });
      const keys = Object.keys(patch);
      const liveAccent = keys.length > 0 && keys.every((key) => key === 'accent' || key === 'intensity');
      if (liveAccent) scheduleAppearanceLivePreview(appState.appearance);
      else {
        void applyThemeWithMotion(appState.appearance, { synchronize: commit, updateNativeIcon: commit });
      }
      if (commit) scheduleAppearancePersist(0);
    },
    onRerender: render,
    onToast: showToast,
    onSection: (section) => {
      if (section !== 'settings') return false;
      appState.settingsReturnSection = appState.activeSection === 'Ajustes' ? 'Descargas' : appState.activeSection;
      appState.activeSection = 'Ajustes';
      render();
      return true;
    }
  });
  document.querySelector('.download-new')?.addEventListener('click', openDownloadDialog);
  document.querySelector('.new-download-top')?.addEventListener('click', openDownloadDialog);

  // Preparation, analysis and playlist selection run exclusively in the native subwindow.

}

window.addEventListener('error', (event) => {
  console.error('Error global de CacaTools', event.error || event.message);
  if (!document.querySelector('.dm-host')) renderFatalError(event.error || event.message);
});
let lastUnhandledUiError = { message: '', at: 0 };
window.addEventListener('unhandledrejection', (event) => {
  console.error('Promesa rechazada en CacaTools', event.reason);
  const message = friendlyError(event.reason);
  const now = Date.now();
  if (message === lastUnhandledUiError.message && now - lastUnhandledUiError.at < 4000) return;
  lastUnhandledUiError = { message, at: now };
  showToast(message, 'error');
});
window.addEventListener('message', (event) => {
  if (event.data?.type === 'cacatools:images:state') appState.imageEditorState = event.data;
  if (event.data?.type === 'cacatools:theme-request' && ['dark', 'light'].includes(event.data.theme)) {
    appState.appearance = normalizeAppearance({ ...appState.appearance, theme: event.data.theme, appearanceRevision: APPEARANCE_REVISION });
    void applyThemeWithMotion(appState.appearance, { updateNativeIcon: false }, event.source === window ? document.activeElement : null);
    scheduleAppearancePersist(0);
  }
});

void bindAppearanceSync({
  getAppearance: () => appState.appearance,
  onAppearance: (next) => {
    appState.appearance = normalizeAppearance(next);
    storeAppearanceLocally(appState.appearance);
    void applyThemeWithMotion(appState.appearance, { updateNativeIcon: true });
  },
  onSystemTheme: () => {
    applyAppAppearance(appState.appearance, { updateNativeIcon: false });
  }
});

const nativeClipboardFocusBinding = !previewMode ? bindNativeClipboardFocus() : Promise.resolve();
const destinationPickerStateBinding = !previewMode ? bindDestinationPickerState() : Promise.resolve();
const preparationModalStateBinding = !previewMode ? bindPreparationModalState() : Promise.resolve();
const appUpdateProgressBinding = !previewMode ? bindAppUpdateProgress() : Promise.resolve();
const startupPromise = start();
// The startup snapshot hydrates the persisted accent asynchronously.  Apply
// the native icon once, after that snapshot is ready, then leave it alone while
// ordinary renders and download updates occur.
void startupPromise.then(() => {
  if (!previewMode) applyAppAppearance(appState.appearance, { updateNativeIcon: true });
}).catch(() => {});
if (!previewMode) {
  clipboardFocusWatcher.start();
  // A launch can complete without emitting a new focus event. Check only
  // after the real startup lifecycle has hydrated settings and rendered the
  // main surface, so the coordinator can present the suggestion safely.
  void Promise.all([nativeClipboardFocusBinding, destinationPickerStateBinding, preparationModalStateBinding, appUpdateProgressBinding, startupPromise])
    .then(() => clipboardFocusWatcher.checkNow())
    .catch(() => {});
}
