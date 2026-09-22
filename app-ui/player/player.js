import { loadStoredAppearance, storeAppearanceLocally } from '../modules/appearance/index.js?v=0.95.0-verify-20260911-r4';
import { bindAppearanceSync } from '../modules/appearance/sync.js?v=0.95.0-verify-appearance';
import { applyBrandIconVariant, iconVariantForColor } from '../modules/appearance/index.js?v=0.95.0-verify-20260911-r4';
import { loadLocale, resolveLocale } from '../modules/i18n/index.js';
import { localizeDom } from '../modules/i18n/runtime.js';

document.addEventListener('contextmenu', (event) => event.preventDefault(), true);

const shell = document.querySelector('.player-shell');
const video = document.querySelector('.player-video');
const audio = document.querySelector('.player-audio');
const mediaWrap = document.querySelector('.player-media-wrap');
const playerStage = document.querySelector('.player-stage');
const youtubeFrame = document.querySelector('.player-youtube');
const timeline = document.querySelector('.player-timeline');
const volume = document.querySelector('.player-volume');
const volumeControls = document.querySelector('.player-volume-controls');
const volumePopover = document.querySelector('[data-player-volume-popover]');
const playButton = document.querySelector('[data-player-action="play"]');
const muteButton = document.querySelector('[data-player-action="mute"]');
const stateCard = document.querySelector('.player-state-card');
const fallbackButton = document.querySelector('[data-player-fallback]');
const infoPanel = document.querySelector('.player-info');
const infoButton = document.querySelector('[data-player-action="info"]');
const infoCloseButton = document.querySelector('[data-player-info-close]');
const titleLabel = document.querySelector('[data-player-title]');
const sourceLabel = document.querySelector('[data-player-source-label]');
const detailSourceLabel = document.querySelector('[data-player-detail-source]');
const heading = document.querySelector('.player-heading');
const audioCard = document.querySelector('[data-audio-card]');
const audioArtwork = document.querySelector('[data-audio-artwork]');
const audioSourceLabel = document.querySelector('[data-audio-source]');
const audioTitleLabel = document.querySelector('[data-audio-title]');
const audioSubtitleLabel = document.querySelector('[data-audio-subtitle]');
const previewNotice = document.querySelector('[data-preview-notice]');
const previewNoticeText = document.querySelector('[data-preview-notice-text]');
const previewNoticeClose = document.querySelector('[data-preview-notice-close]');
const playlistPanel = document.querySelector('[data-player-playlist-panel]');
const playlistList = document.querySelector('[data-player-playlist-list]');
const playlistTitle = document.querySelector('[data-player-playlist-title]');
const playlistSummary = document.querySelector('[data-player-playlist-summary]');
const playlistCloseButton = document.querySelector('[data-player-playlist-close]');
const playlistToggleButton = document.querySelector('[data-player-action="playlist-list"]');
const previousTrackButton = document.querySelector('[data-player-action="previous-track"]');
const nextTrackButton = document.querySelector('[data-player-action="next-track"]');
const revealButton = document.querySelector('[data-player-action="reveal"]');
const repeatButton = document.querySelector('[data-player-action="repeat"]');
const qualityButton = document.querySelector('[data-player-action="quality"]');
const captionsButton = document.querySelector('[data-player-action="captions"]');
const qualityLabel = document.querySelector('[data-player-quality]');
const speedButton = document.querySelector('[data-player-action="speed"]');
const speedLabel = document.querySelector('[data-player-speed]');
const qualityMenu = document.querySelector('[data-player-quality-menu]');
const qualityList = document.querySelector('[data-player-quality-list]');
const qualityCloseButton = document.querySelector('[data-player-quality-close]');
const compactMenu = document.querySelector('[data-player-compact-menu]');
const compactCloseButton = document.querySelector('[data-player-compact-close]');
const compactBackdropCanvas = document.querySelector('[data-player-backdrop-canvas]');
const playerControls = document.querySelector('.player-controls');

// The player is rendered in its own window and updates several labels after
// startup.  Observe only this shell and run the existing runtime i18n pass so
// dynamic quality, playlist, status and error messages follow live locale
// changes without touching playback behavior.
let playerLocalizationQueued = false;
function localizePlayerDom() {
  if (playerLocalizationQueued) return;
  playerLocalizationQueued = true;
  queueMicrotask(() => {
    playerLocalizationQueued = false;
    localizeDom(document, resolveLocale(loadLocale()));
  });
}
const playerLocalizationObserver = new MutationObserver(localizePlayerDom);
playerLocalizationObserver.observe(document.documentElement, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['title', 'aria-label', 'placeholder', 'data-tooltip'] });
localizePlayerDom();
const playerLifecycle = [];
function markPlayerLifecycle(label) {
  const entry = { label, time: performance.now() };
  playerLifecycle.push(entry);
  window.__cdmPlayerLifecycle = playerLifecycle;
  return entry;
}
markPlayerLifecycle('webview-bootstrap');
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => markPlayerLifecycle('dom-ready'), { once: true });
} else {
  markPlayerLifecycle('dom-ready');
}
if (document.fonts?.ready) {
  document.fonts.ready.then(() => markPlayerLifecycle('css-ready')).catch(() => markPlayerLifecycle('css-ready'));
} else {
  markPlayerLifecycle('css-ready');
}
const params = new URLSearchParams(location.search);
const LOW_PREVIEW_NOTICE_KEY = 'cacatools.player.low-preview-notice.v1';
const MEDIA_DOWNLOAD_PREFERENCES_KEY = 'cacatools.media-download-preferences.v1';
const PREVIEW_NETWORK_METRICS_KEY = 'cacatools.player.network-metrics.v1';

let activeMedia = video;
let activeJobId = Number(params.get('job') || 0);
let activePreviewUrl = params.get('preview') || '';
let activePlaylistBatchId = Number(params.get('playlist') || 0);
let activePlaylistTitle = '';
let activePlaylistQueue = [];
let activePlaylistIndex = -1;
let currentSnapshot = null;
let currentSource = activePreviewUrl ? 'preview' : activePlaylistBatchId ? 'playlist' : 'local';
let loadGeneration = 0;
let mediaGeneration = 0;
let refreshTimer = 0;
let youtubeIframeApiPromise = null;
let youtubePlayer = null;
let youtubeTimelineTimer = 0;
let youtubeFallbackTimer = 0;
let previewStageTimer = 0;
let youtubeFallbackAttempted = false;
let onlineEmbedPlatform = '';
let activePreviewAudioUrl = '';
let onlinePreviewStage = 'idle';
let dualPreviewState = null;
let naturalWidth = 854;
let naturalHeight = 480;
let mediaKind = 'video';
let repeatEnabled = false;
let playbackRate = 1;
let activePreviewQualityId = '';
let playerCloseRequested = false;
let playerUiIdleTimer = 0;
let playlistAdvancePending = false;
let previewResumeTime = 0;
let previewRecoveryTimer = 0;
let playerResizeObserver = null;
let releaseNativeFullscreenListener = null;
let releaseAppearanceListener = null;
let previewNetworkState = null;
let fullscreenTransitionPending = false;
let fullscreenBackdropFrame = 0;
let currentAppearance = loadStoredAppearance();
const PLAYER_UI_IDLE_DELAY = 1800;
let playerEntryStarted = false;
let playerEntryStartTimer = 0;
let playerEntryFinishTimer = 0;

function finishPlayerEntry() {
  if (!playerEntryStarted || document.body.classList.contains('player-entry-complete')) return;
  window.clearTimeout(playerEntryFinishTimer);
  document.body.classList.remove('player-ready');
  document.body.classList.add('player-entry-complete');
  markPlayerLifecycle('entry-class-removed');
}

function startPlayerEntry(reason = 'entry-start') {
  if (playerEntryStarted) return;
  playerEntryStarted = true;
  window.clearTimeout(playerEntryStartTimer);
  markPlayerLifecycle(reason);
  document.body.classList.add('player-ready');
  markPlayerLifecycle('entry-class-added');
  // A one-shot cleanup also covers reduced/off modes, where CSS correctly
  // suppresses the animation and therefore emits no animationend event.
  playerEntryFinishTimer = window.setTimeout(finishPlayerEntry, 360);
  shell?.addEventListener('animationend', (event) => {
    if (event.animationName === 'cdm-motion-player-enter') finishPlayerEntry();
  }, { once: true });
}

function schedulePlayerEntry() {
  playerEntryStartTimer = window.setTimeout(() => startPlayerEntry('entry-failsafe'), 500);
  const afterFirstVisibleFrame = () => window.requestAnimationFrame(() => {
    markPlayerLifecycle('first-visible-frame');
    window.requestAnimationFrame(() => startPlayerEntry());
  });
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', afterFirstVisibleFrame, { once: true });
  else afterFirstVisibleFrame();
}

const ICONS = {
  play: '<svg viewBox="0 0 24 24" aria-hidden="true"><path class="fill" d="M8.2 5.8v12.4L18 12 8.2 5.8Z"/></svg>',
  pause: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect class="fill" x="7" y="5.5" width="3.4" height="13" rx="1"/><rect class="fill" x="13.6" y="5.5" width="3.4" height="13" rx="1"/></svg>',
  volume: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 10v4h3l4 3V7l-4 3H5Z"/><path d="M15 9.2c1.7 1.5 1.7 4.1 0 5.6M17.5 6.8a7.2 7.2 0 0 1 0 10.4"/></svg>',
  muted: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 10v4h3l4 3V7l-4 3H5Z"/><path d="m15.5 9 4 4m0-4-4 4"/></svg>',
  previous: '<svg viewBox="0 0 24 24" aria-hidden="true"><path class="fill" d="M7 5.5h2.2v13H7zM18 6.2v11.6L10.2 12 18 6.2Z"/></svg>',
  next: '<svg viewBox="0 0 24 24" aria-hidden="true"><path class="fill" d="M14.8 5.5H17v13h-2.2zM6 6.2v11.6L13.8 12 6 6.2Z"/></svg>',
  replay10: '<svg viewBox="0 0 32 32" aria-hidden="true"><path d="M10.1 8.7A10.4 10.4 0 1 1 7.2 16"/><path d="M6.6 6.2v7.4h7.4"/><text class="icon-number" x="17.1" y="19.2" text-anchor="middle">10</text></svg>',
  forward10: '<svg viewBox="0 0 32 32" aria-hidden="true"><path d="M21.9 8.7A10.4 10.4 0 1 0 24.8 16"/><path d="M25.4 6.2v7.4H18"/><text class="icon-number" x="14.9" y="19.2" text-anchor="middle">10</text></svg>',
  list: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 7h10M9 12h10M9 17h10"/><circle class="fill" cx="5" cy="7" r="1.2"/><circle class="fill" cx="5" cy="12" r="1.2"/><circle class="fill" cx="5" cy="17" r="1.2"/></svg>',
  settings: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-2.8 2.8-.1-.1a1.7 1.7 0 0 0-1.9-.3A1.7 1.7 0 0 0 14 21v.1h-4V21a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1-2.8-2.8.1-.1a1.7 1.7 0 0 0 .3-1.9A1.7 1.7 0 0 0 3 14H2.9v-4H3a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9l-.1-.1L7 4.2l.1.1a1.7 1.7 0 0 0 1.9.3A1.7 1.7 0 0 0 10 3V2.9h4V3a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.9-.3l.1-.1 2.8 2.8-.1.1a1.7 1.7 0 0 0-.3 1.9A1.7 1.7 0 0 0 21 10h.1v4H21a1.7 1.7 0 0 0-1.6 1Z"/></svg>',
  repeat: '<svg viewBox="0 0 24 24" aria-hidden="true"><path class="fill" d="M7 7h11.2l-2.6-2.6L17 3l5 5-5 5-1.4-1.4L18.2 9H7v3l-2-2V7h2Zm10 10H5.8l2.6 2.6L7 21l-5-5 5-5 1.4 1.4L5.8 15H17v-3l2 2v3h-2Z"/></svg>',
  reveal: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3.5 7.5A2.5 2.5 0 0 1 6 5h4l2 2h6.5A2.5 2.5 0 0 1 21 9.5v7A2.5 2.5 0 0 1 18.5 19h-13A2.5 2.5 0 0 1 3 16.5v-9Z"/><path d="M8 12h8M12 9v6"/></svg>',
  fullscreen: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8.5 4H4v4.5M15.5 4H20v4.5M8.5 20H4v-4.5M15.5 20H20v-4.5"/></svg>',
  captions: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3.5" y="5.5" width="17" height="13" rx="2"/><path d="M7 11.5h3M14 11.5h3M7 14.5h2M13 14.5h3"/></svg>',
  speed: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 14a8 8 0 1 1 16 0"/><path d="m12 14 3.5-4"/><path d="M7 19h10"/><circle class="fill" cx="12" cy="14" r="1.35"/></svg>'
};

function invoke(command, args = {}) {
  const tauriInvoke = window.__TAURI__?.core?.invoke;
  if (!tauriInvoke) return Promise.reject(new Error('Tauri no disponible'));
  return tauriInvoke(command, args);
}

function invokeWithTimeout(command, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = window.setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error(`La resolucion de la vista previa supero ${Math.round(timeoutMs / 1000)} segundos.`));
    }, timeoutMs);
    invoke(command, args).then((value) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      resolve(value);
    }).catch((error) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      reject(error);
    });
  });
}

function convertFileSrc(path) {
  const converter = window.__TAURI__?.core?.convertFileSrc;
  return converter ? converter(path) : path;
}

function formatTime(value) {
  const seconds = Number.isFinite(Number(value)) ? Math.max(0, Number(value)) : 0;
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = Math.floor(seconds % 60);
  return hours
    ? `${hours}:${String(minutes).padStart(2, '0')}:${String(rest).padStart(2, '0')}`
    : `${minutes}:${String(rest).padStart(2, '0')}`;
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  })[character]);
}

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

function clearPlayerUiIdleTimer() {
  window.clearTimeout(playerUiIdleTimer);
  playerUiIdleTimer = 0;
}

function schedulePlayerUiIdle() {
  clearPlayerUiIdleTimer();
  if (shell.dataset.playerState !== 'ready') return;
  playerUiIdleTimer = window.setTimeout(() => {
    if (playerControls?.matches(':hover') || playerControls?.contains(document.activeElement)) {
      schedulePlayerUiIdle();
      return;
    }
    if (!shell.classList.contains('is-playlist-open') && !shell.classList.contains('is-quality-open') && !shell.classList.contains('is-info-open') && !shell.classList.contains('is-compact-menu-open')) {
      shell.classList.add('is-ui-idle');
    }
  }, PLAYER_UI_IDLE_DELAY);
}

function wakePlayerUi() {
  shell.classList.remove('is-ui-idle');
  schedulePlayerUiIdle();
}

let volumeCloseTimer = 0;
function setVolumePopoverOpen(open) {
  window.clearTimeout(volumeCloseTimer);
  // CMP uses the same compact hover/focus volume control for local media and
  // previews. The old local-only inline rule kept the range permanently
  // visible and produced the detached panel reported by the user.
  volumeControls?.classList.toggle('is-volume-open', Boolean(open));
}

function scheduleVolumePopoverClose() {
  window.clearTimeout(volumeCloseTimer);
  volumeCloseTimer = window.setTimeout(() => {
    if (volumeControls?.matches(':hover')) return;
    if (document.activeElement === volume) volume.blur();
    volumeControls?.classList.remove('is-volume-open');
  }, 120);
}

volumeControls?.addEventListener('pointerenter', () => setVolumePopoverOpen(true));
volume?.addEventListener('pointerenter', () => setVolumePopoverOpen(true));
volume?.addEventListener('pointermove', () => setVolumePopoverOpen(true));
volumePopover?.addEventListener('pointerenter', () => setVolumePopoverOpen(true));
volumePopover?.addEventListener('pointermove', () => setVolumePopoverOpen(true));
volumeControls?.addEventListener('pointerleave', (event) => {
  if (event.relatedTarget instanceof Node && volumeControls.contains(event.relatedTarget)) return;
  scheduleVolumePopoverClose();
});
volumePopover?.addEventListener('pointerleave', scheduleVolumePopoverClose);
volume?.addEventListener('focus', () => setVolumePopoverOpen(true));
volume?.addEventListener('blur', scheduleVolumePopoverClose);

function setPlaylistPanelOpen(open) {
  const next = Boolean(open && activePlaylistQueue.length);
  shell.classList.toggle('is-playlist-open', next);
  playlistPanel?.setAttribute('aria-hidden', String(!next));
  playlistToggleButton?.setAttribute('aria-pressed', String(next));
  wakePlayerUi();
}

function setCompactMenuOpen(open) {
  const next = Boolean(open && shell.classList.contains('is-compact'));
  shell.classList.toggle('is-compact-menu-open', next);
  compactMenu?.setAttribute('aria-hidden', String(!next));
  if (next) syncCompactMenuAvailability();
  wakePlayerUi();
}

function compactSourceButton(action) {
  const sourceAction = action === 'volume' ? 'mute' : action;
  return document.querySelector(`[data-player-action="${sourceAction}"]`);
}

function syncCompactMenuAvailability() {
  const local = currentSnapshot?.source === 'local';
  const preview = currentSource === 'preview';
  const playlist = currentSource === 'playlist' && activePlaylistQueue.length > 0;
  const visibility = {
    volume: true,
    reveal: local,
    quality: preview,
    captions: preview && isYoutubeMode(),
    'playlist-list': playlist
  };
  Object.entries(visibility).forEach(([action, visible]) => {
    const proxy = compactMenu?.querySelector(`[data-compact-proxy="${action}"]`);
    if (proxy) proxy.hidden = !visible;
  });
}

function syncCompactProxyIcons() {
  const compactIcons = {
    volume: 'volume',
    repeat: 'repeat',
    reveal: 'reveal',
    quality: 'settings',
    captions: 'captions',
    speed: 'speed',
    'playlist-list': 'list',
    fullscreen: 'fullscreen',
    info: 'settings'
  };
  compactMenu?.querySelectorAll('[data-compact-proxy]').forEach((proxy) => {
    const action = proxy.dataset.compactProxy;
    const icon = proxy.querySelector('[data-compact-icon]');
    const iconName = compactIcons[action];
    if (icon && iconName) setButtonIcon(icon, iconName);
  });
}

function updatePlayerLayout() {
  const width = Math.round(shell?.getBoundingClientRect().width || window.innerWidth || 0);
  const compact = width > 0 && width < 1180;
  const changed = shell.classList.contains('is-compact') !== compact;
  shell.classList.toggle('is-compact', compact);
  shell.dataset.playerLayout = compact ? 'compact' : 'full';
  if (!compact) setCompactMenuOpen(false);
  if (changed) syncCompactMenuAvailability();
}

function installPlayerResizeObserver() {
  if (typeof ResizeObserver === 'undefined' || !shell) return;
  playerResizeObserver?.disconnect();
  playerResizeObserver = new ResizeObserver(() => updatePlayerLayout());
  playerResizeObserver.observe(shell);
  updatePlayerLayout();
}

async function installNativeFullscreenListener() {
  const listen = window.__TAURI__?.event?.listen;
  if (typeof listen !== 'function') return;
  try {
    releaseNativeFullscreenListener = await listen('player-fullscreen-changed', (event) => {
      const active = Boolean(event?.payload);
      shell.dataset.playerFullscreen = active ? 'on' : 'off';
      if (active) scheduleFullscreenBackdropCapture();
      else {
        clearFullscreenBackdrop();
        window.setTimeout(() => resizeForMedia(false), 0);
      }
    });
  } catch {
    releaseNativeFullscreenListener = null;
  }
}

function playlistItemPlayable(item) {
  return Boolean(item?.playable && Number(item?.job_id || item?.jobId || 0) > 0);
}

function playlistItemStateLabel(item, active = false) {
  if (active) return 'Reproduciendo';
  if (playlistItemPlayable(item)) return 'Reproducir';
  const status = String(item?.status || '').toLowerCase();
  if (status === 'running') return 'Descargando';
  if (status === 'paused') return 'Pausada';
  if (status === 'queued') return 'Pendiente';
  if (status === 'failed') return 'Error';
  if (status === 'cancelled') return 'Cancelada';
  return 'No disponible';
}

function renderPlaylistQueue() {
  if (!playlistList) return;
  if (playlistTitle) playlistTitle.textContent = activePlaylistTitle || 'Playlist';
  const playableCount = activePlaylistQueue.filter(playlistItemPlayable).length;
  if (playlistSummary) {
    playlistSummary.textContent = activePlaylistQueue.length
      ? `${activePlaylistQueue.length} elemento${activePlaylistQueue.length === 1 ? '' : 's'} · ${playableCount} reproducible${playableCount === 1 ? '' : 's'}`
      : 'La playlist no contiene elementos.';
  }
  playlistList.innerHTML = activePlaylistQueue.map((item, index) => {
    const active = index === activePlaylistIndex;
    const playable = playlistItemPlayable(item);
    const thumb = String(item.thumbnail || '').trim();
    const creator = String(item.creator || '').trim();
    const state = playlistItemStateLabel(item, active);
    return `<button type="button" class="player-playlist-item ${active ? 'is-active' : ''} ${playable ? '' : 'is-unavailable'}" data-player-playlist-index="${index}" aria-current="${active ? 'true' : 'false'}" ${playable ? '' : 'disabled aria-disabled="true"'}>
      <span class="player-playlist-index">${index + 1}</span>
      <span class="player-playlist-thumb">${thumb ? `<img src="${escapeHtml(thumb)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : ICONS.play}</span>
      <span class="player-playlist-copy"><strong>${escapeHtml(item.title || `Elemento ${index + 1}`)}</strong><small>${escapeHtml(creator || 'Elemento de la playlist')}</small></span>
      <span class="player-playlist-state">${escapeHtml(state)}</span>
    </button>`;
  }).join('');
}

function playablePlaylistIndexFrom(start, direction) {
  const step = direction >= 0 ? 1 : -1;
  for (let index = start + step; index >= 0 && index < activePlaylistQueue.length; index += step) {
    if (playlistItemPlayable(activePlaylistQueue[index])) return index;
  }
  return -1;
}

function updatePlaylistNavigationState() {
  const playlist = currentSource === 'playlist' && activePlaylistQueue.length > 0;
  const previousIndex = playlist && activePlaylistIndex >= 0 ? playablePlaylistIndexFrom(activePlaylistIndex, -1) : -1;
  const nextIndex = playlist && activePlaylistIndex >= 0 ? playablePlaylistIndexFrom(activePlaylistIndex, 1) : -1;
  if (previousTrackButton) previousTrackButton.disabled = previousIndex < 0;
  if (nextTrackButton) nextTrackButton.disabled = nextIndex < 0;
  if (playlistToggleButton) playlistToggleButton.disabled = !playlist;
}

function applyAppearance(appearance = currentAppearance || loadStoredAppearance()) {
  const root = document.documentElement;
  root.style.removeProperty('--player-bg');
  root.style.removeProperty('--player-surface');
  root.style.removeProperty('--player-elevated');
  root.style.removeProperty('--player-border');
  root.style.removeProperty('--player-text');
  root.style.removeProperty('--player-muted');
  try {
    const stored = appearance && typeof appearance === 'object' ? appearance : {};
    if (/^#[0-9a-f]{6}$/i.test(stored.accent || '')) root.style.setProperty('--player-accent', stored.accent);
    else root.style.removeProperty('--player-accent');
    // The integrated player is intentionally dark-only. The preparation
    // windows may follow the app theme, but a light player makes the media
    // canvas and fullscreen letterboxing inconsistent.
    root.dataset.theme = 'dark';
    root.style.setProperty('--player-ui-scale', String(Math.max(.5, Math.min(1.3, Number(stored.scale || 100) / 100))));
    root.style.setProperty('--player-text-scale', String(Math.max(.8, Math.min(1.2, Number(stored.textScale || 100) / 100))));
    // The player brand follows the application accent, not the optional
    // per-file icon color setting.
    applyBrandIconVariant(iconVariantForColor(stored.accent));
  } catch {
    root.dataset.theme = 'dark';
  }
}

async function installAppearanceSync() {
  try {
    currentAppearance = await invoke('get_appearance_settings') || currentAppearance;
    storeAppearanceLocally(currentAppearance);
    applyAppearance(currentAppearance);
  } catch {
    currentAppearance = loadStoredAppearance();
    applyAppearance(currentAppearance);
  }
  try {
    releaseAppearanceListener = await bindAppearanceSync({
      getAppearance: () => currentAppearance,
      onAppearance: (next) => {
        currentAppearance = next;
        storeAppearanceLocally(next);
        applyAppearance(next);
      }
    });
  } catch {
    releaseAppearanceListener = null;
  }
}

function setButtonIcon(button, icon) {
  if (button) button.innerHTML = ICONS[icon] || '';
}

function setMuteButtonState(muted) {
  const next = Boolean(muted);
  setButtonIcon(muteButton, next ? 'muted' : 'volume');
  muteButton?.setAttribute('aria-label', next ? 'Activar sonido' : 'Silenciar');
  if (muteButton) muteButton.title = next ? 'Activar sonido' : 'Silenciar';
}

function setRepeatEnabled(enabled) {
  repeatEnabled = Boolean(enabled);
  [video, audio].forEach((element) => { element.loop = repeatEnabled; });
  if (repeatButton) {
    repeatButton.setAttribute('aria-pressed', String(repeatEnabled));
    repeatButton.setAttribute('aria-label', repeatEnabled ? 'Repetir activado' : 'Repetir desactivado');
    repeatButton.title = repeatEnabled ? 'Repetir activado' : 'Repetir indefinidamente';
  }
  shell.dataset.playerRepeat = repeatEnabled ? 'on' : 'off';
}

function updateQualityLabel(snapshot = currentSnapshot) {
  if (!qualityLabel) return;
  const activeQuality = Array.isArray(snapshot?.qualities)
    ? snapshot.qualities.find((entry) => entry.id === activePreviewQualityId)
      || snapshot.qualities.find((entry) => entry.url === snapshot.stream_url)
    : null;
  if (activeQuality && !activePreviewQualityId) activePreviewQualityId = activeQuality.id;
  const height = Number(activeQuality?.height || snapshot?.progressive_height || snapshot?.height || snapshot?.video?.height || 0);
  const label = height > 0 ? `${Math.round(height)}p` : mediaKind === 'audio' ? 'Audio' : currentSource === 'preview' ? 'Auto' : 'Local';
  qualityLabel.textContent = label;
  qualityButton?.setAttribute('aria-label', `Calidad actual: ${label}`);
}

function readPreviewDesiredQuality() {
  try {
    const stored = JSON.parse(localStorage.getItem(MEDIA_DOWNLOAD_PREFERENCES_KEY) || '{}');
    const explicit = Number(stored?.desiredQuality);
    if (Number.isFinite(explicit) && explicit > 0) return Math.round(explicit);
    const legacy = String(stored?.videoQuality || '').trim().toLowerCase();
    if (/^\d+$/.test(legacy) && Number(legacy) > 0) return Number(legacy);
  } catch {}
  return null;
}

function persistPreviewDesiredQuality(height) {
  const value = Number(height);
  if (!Number.isFinite(value) || value <= 0) return;
  try {
    const stored = JSON.parse(localStorage.getItem(MEDIA_DOWNLOAD_PREFERENCES_KEY) || '{}');
    stored.desiredQuality = Math.round(value);
    localStorage.setItem(MEDIA_DOWNLOAD_PREFERENCES_KEY, JSON.stringify(stored));
  } catch {}
}

function previewQualityHeight(quality) {
  const value = Number(quality?.height || 0);
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function readStoredPreviewCapacityMbps() {
  try {
    const value = JSON.parse(localStorage.getItem(PREVIEW_NETWORK_METRICS_KEY) || '{}');
    const observed = Number(value?.observedMbps);
    return Number.isFinite(observed) && observed > 0 ? observed : 0;
  } catch { return 0; }
}

function observedPreviewCapacityMbps() {
  const values = [readStoredPreviewCapacityMbps()];
  const downlink = Number(navigator.connection?.downlink);
  if (Number.isFinite(downlink) && downlink > 0) values.push(downlink);
  if (previewNetworkState?.throughputMbps > 0) values.push(previewNetworkState.throughputMbps);
  try {
    performance.getEntriesByType('resource').filter((entry) => {
      return entry.name === activePreviewUrl || entry.name === video.currentSrc || entry.name === audio.currentSrc;
    }).slice(-3).forEach((entry) => {
      const bytes = Number(entry.transferSize || entry.encodedBodySize || 0);
      const seconds = Number(entry.duration || 0) / 1000;
      if (bytes > 0 && seconds > 0) values.push((bytes * 8) / seconds / 1000000);
    });
  } catch {}
  const valid = values.filter((value) => Number.isFinite(value) && value > 0).sort((a, b) => a - b);
  if (!valid.length) return 0;
  return valid[Math.floor(valid.length / 2)];
}

function beginPreviewNetworkMeasurement(quality) {
  previewNetworkState = {
    quality,
    startedAt: performance.now(),
    lastSampleAt: performance.now(),
    lastCurrentTime: Number(video.currentTime || 0),
    lastBufferAhead: 0,
    throughputMbps: 0,
    stalls: 0,
    waitingAt: 0
  };
}

function samplePreviewNetworkCapacity() {
  const state = previewNetworkState;
  if (!state || currentSource !== 'preview' || activeMedia !== video) return;
  const now = performance.now();
  const elapsed = (now - state.lastSampleAt) / 1000;
  if (elapsed < 0.5) return;
  const current = Number(video.currentTime || 0);
  let bufferAhead = 0;
  try {
    if (video.buffered.length) bufferAhead = Math.max(0, video.buffered.end(video.buffered.length - 1) - current);
  } catch {}
  const played = Math.max(0, current - state.lastCurrentTime);
  const bufferGrowth = bufferAhead - state.lastBufferAhead + played;
  const bitrateMbps = Number(state.quality?.bitrate_kbps || 0) / 1000;
  if (bitrateMbps > 0 && bufferGrowth > 0) {
    const estimate = bitrateMbps * Math.max(1, bufferGrowth / elapsed);
    state.throughputMbps = state.throughputMbps > 0
      ? state.throughputMbps * 0.65 + estimate * 0.35
      : estimate;
    try { localStorage.setItem(PREVIEW_NETWORK_METRICS_KEY, JSON.stringify({ observedMbps: state.throughputMbps, updatedAt: Date.now() })); } catch {}
  }
  state.lastSampleAt = now;
  state.lastCurrentTime = current;
  state.lastBufferAhead = bufferAhead;
}

function qualityFitsCapacity(quality, capacityMbps) {
  const bitrate = Number(quality?.bitrate_kbps || 0) / 1000;
  return !bitrate || !capacityMbps || bitrate * 1.25 <= capacityMbps;
}

function chooseInitialPreviewQuality(snapshot) {
  const qualities = (Array.isArray(snapshot?.qualities) ? snapshot.qualities : [])
    .filter((quality) => quality?.url && previewQualityHeight(quality) > 0)
    .slice()
    .sort((left, right) => previewQualityHeight(right) - previewQualityHeight(left));
  if (!qualities.length) return null;
  const desired = readPreviewDesiredQuality();
  const desiredPool = desired
    ? qualities.filter((quality) => previewQualityHeight(quality) <= desired)
    : qualities;
  const pool = desiredPool.length ? desiredPool : qualities.slice().sort((left, right) => previewQualityHeight(left) - previewQualityHeight(right));
  const capacity = observedPreviewCapacityMbps();
  const stable = pool.filter((quality) => qualityFitsCapacity(quality, capacity));
  return (stable.length ? stable : pool.slice().sort((left, right) => previewQualityHeight(left) - previewQualityHeight(right)))[0];
}

function setQualityMenuOpen(open) {
  const next = Boolean(open && currentSource === 'preview');
  shell.classList.toggle('is-quality-open', next);
  qualityMenu?.setAttribute('aria-hidden', String(!next));
  wakePlayerUi();
}

function qualityLabelForId(value) {
  const known = {
    hd2160: '2160p', hd1440: '1440p', hd1080: '1080p', hd720: '720p',
    large: '480p', medium: '360p', small: '240p', tiny: '144p', auto: 'Auto'
  };
  return known[String(value || '')] || String(value || 'Auto');
}

function renderQualityMenu() {
  if (!qualityList) return;
  if (currentSource !== 'preview') {
    qualityList.innerHTML = '<p class="player-quality-empty">Este archivo se reproduce en la calidad descargada.</p>';
    return;
  }
  if (isYoutubeMode()) {
    const levels = youtubePlayer?.getAvailableQualityLevels?.() || [];
    const current = youtubePlayer?.getPlaybackQuality?.() || 'auto';
    qualityList.innerHTML = (levels.length ? levels : ['auto']).map((level) => `<button type="button" class="player-quality-option ${level === current ? 'is-active' : ''}" data-youtube-quality="${escapeHtml(level)}"><strong>${qualityLabelForId(level)}</strong><small>Calidad oficial de YouTube</small><span>${level === current ? 'Activa' : 'Seleccionar'}</span></button>`).join('');
    return;
  }
  const qualities = Array.isArray(currentSnapshot?.qualities) ? currentSnapshot.qualities : [];
  const activeQuality = qualities.find((quality) => quality.id === activePreviewQualityId)
    || qualities.find((quality) => quality.url === currentSnapshot?.stream_url);
  if (activeQuality) activePreviewQualityId = activeQuality.id;
  if (!qualities.length) {
    qualityList.innerHTML = '<p class="player-quality-empty">La fuente no expuso más flujos directos seleccionables.</p>';
    return;
  }
  qualityList.innerHTML = qualities.map((quality) => `<button type="button" class="player-quality-option ${quality.id === activePreviewQualityId ? 'is-active' : ''}" data-quality-id="${escapeHtml(quality.id)}"><strong>${escapeHtml(quality.label)}</strong><small>${quality.has_audio ? 'Video y audio en un solo flujo' : 'Video adaptativo · audio sincronizado'}</small><span>${quality.id === activePreviewQualityId ? 'Activa' : 'Seleccionar'}</span></button>`).join('');
}

function applyPreviewQuality(qualityId) {
  if (currentSource !== 'preview' || !currentSnapshot) return;
  if (isYoutubeMode()) {
    const level = String(qualityId || 'auto');
    youtubePlayer?.setPlaybackQualityRange?.(level);
    youtubePlayer?.setPlaybackQuality?.(level);
    if (qualityLabel) qualityLabel.textContent = qualityLabelForId(level);
    renderQualityMenu();
    return;
  }
  const quality = currentSnapshot.qualities?.find((entry) => entry.id === qualityId);
  if (!quality?.url || quality.id === activePreviewQualityId) {
    setQualityMenuOpen(false);
    return;
  }
  rememberPreviewPosition();
  const wasPlaying = !video.paused || (Boolean(activePreviewAudioUrl) && !audio.paused);
  const wasMuted = Boolean(activePreviewAudioUrl ? audio.muted : video.muted);
  const generation = ++loadGeneration;
  activePreviewQualityId = quality.id;
  persistPreviewDesiredQuality(quality.height);
  const selectedSnapshot = {
    ...currentSnapshot,
    stream_url: quality.url,
    audio_stream_url: quality.has_audio ? '' : (quality.audio_url || currentSnapshot.audio_stream_url || ''),
    width: quality.width || currentSnapshot.width,
    height: quality.height || currentSnapshot.height,
    preview_quality: quality,
    progressive_stream_url: quality.has_audio ? quality.url : '',
    progressive_width: quality.has_audio ? quality.width : null,
    progressive_height: quality.has_audio ? quality.height : null,
    progressive_technical: quality.has_audio ? currentSnapshot.technical : null
  };
  currentSnapshot = selectedSnapshot;
  setQualityMenuOpen(false);
  if (quality.has_audio) {
    prepareSinglePreview(selectedSnapshot, generation, `Vista previa · ${quality.label}`, 'progressive', wasPlaying, wasMuted);
  } else {
    applySnapshotHeading({ title: selectedSnapshot.title, subtitle: `Vista previa adaptativa · ${quality.label}`, source: 'VISTA PREVIA' });
    prepareDualPreview(selectedSnapshot, generation, wasPlaying, wasMuted);
  }
  renderQualityMenu();
}

function openQualityMenu() {
  renderQualityMenu();
  setQualityMenuOpen(!shell.classList.contains('is-quality-open'));
}

function setPlaybackRate(rate) {
  playbackRate = Number(rate) || 1;
  [video, audio].forEach((element) => { element.playbackRate = playbackRate; });
  youtubePlayer?.setPlaybackRate?.(playbackRate);
  if (speedLabel) speedLabel.textContent = `${playbackRate.toFixed(1)}x`;
  speedButton?.setAttribute('aria-label', `Velocidad ${playbackRate.toFixed(1)}x`);
}

function cyclePlaybackRate() {
  const rates = [0.5, 0.75, 1, 1.25, 1.5, 2];
  const index = rates.findIndex((rate) => Math.abs(rate - playbackRate) < 0.01);
  setPlaybackRate(rates[(index + 1) % rates.length]);
}

function openCapability(kind) {
  if (kind === 'quality') {
    openQualityMenu();
    return;
  }
  const online = currentSource === 'preview';
  const title = kind === 'quality' ? 'Calidad actual' : 'Subtítulos';
  if (kind === 'quality' && isYoutubeMode()) {
    const levels = youtubePlayer.getAvailableQualityLevels?.() || [];
    const current = youtubePlayer.getPlaybackQuality?.() || levels[0] || 'auto';
    const next = levels.length ? levels[(Math.max(0, levels.indexOf(current)) + 1) % levels.length] : 'auto';
    youtubePlayer.setPlaybackQualityRange?.(next);
    youtubePlayer.setPlaybackQuality?.(next);
    const label = next === 'hd2160' ? '2160p' : next === 'hd1440' ? '1440p' : next === 'hd1080' ? '1080p' : next === 'hd720' ? '720p' : next === 'large' ? '480p' : next === 'medium' ? '360p' : next === 'small' ? '240p' : 'Auto';
    if (qualityLabel) qualityLabel.textContent = label;
    const detail = heading?.querySelector('p');
    if (detail) detail.textContent = `Calidad oficial de YouTube: ${label}. Pulsa de nuevo para cambiarla.`;
    return;
  }
  if (kind === 'captions' && isYoutubeMode()) {
    const enabled = shell.dataset.playerCaptions === 'on';
    youtubePlayer.loadModule?.('captions');
    youtubePlayer.setOption?.('captions', 'track', enabled ? {} : { languageCode: 'es' });
    shell.dataset.playerCaptions = enabled ? 'off' : 'on';
    captionsButton?.setAttribute('aria-pressed', String(!enabled));
    const detail = heading?.querySelector('p');
    if (detail) detail.textContent = enabled ? 'Subtítulos oficiales desactivados.' : 'Subtítulos oficiales activados cuando el video expone una pista compatible.';
    return;
  }
  const message = kind === 'quality'
    ? (online ? 'La vista previa usa la calidad que entrega la fuente en este momento; no se cambia una calidad que no haya sido expuesta por el reproductor.' : `Este archivo se reproduce en la calidad descargada: ${qualityLabel?.textContent || 'la registrada en sus metadatos'}.`)
    : 'No hay una pista de subtítulos seleccionable para este contenido.';
  setInfoOpen(true);
  const detail = heading?.querySelector('p');
  if (detail) detail.textContent = message;
  infoButton?.setAttribute('aria-label', `${title}. Ocultar ajustes`);
}

function setState(title, message, state = 'waiting', allowSystemFallback = false) {
  shell.dataset.playerState = state;
  fallbackButton.hidden = !allowSystemFallback;
  stateCard.querySelector('strong').textContent = title;
  stateCard.querySelector('p').textContent = message;
  // Translate immediately rather than waiting for MutationObserver's next
  // microtask; this keeps transient loading/error states consistent with the
  // rest of the player when the locale is English.
  localizeDom(stateCard, resolveLocale(loadLocale()));
  setControlsEnabled(state === 'ready');
  updateQualityLabel();
  if (state === 'ready') wakePlayerUi();
  else { clearPlayerUiIdleTimer(); shell.classList.remove('is-ui-idle'); }
}

function setControlsEnabled(enabled) {
  document.querySelectorAll('[data-player-action]').forEach((button) => {
    const action = button.dataset.playerAction;
    if (action === 'info') button.disabled = false;
    else if (action === 'playlist-list') button.disabled = !(currentSource === 'playlist' && activePlaylistQueue.length);
    else if (action === 'previous-track' || action === 'next-track') button.disabled = !enabled;
    else if (action === 'reveal') button.disabled = !enabled || currentSnapshot?.source !== 'local' || !currentSnapshot?.local_path;
    else button.disabled = !enabled;
  });
  timeline.disabled = !enabled;
  volume.disabled = !enabled;
  updatePlaylistNavigationState();
  syncCompactMenuAvailability();
}

function resizeForMedia(detailsOpen = shell.classList.contains('is-info-open')) {
  if (document.fullscreenElement || shell.dataset.playerFullscreen === 'on') return;
  let width = Number(naturalWidth || 0);
  let height = Number(naturalHeight || 0);
  if (mediaKind === 'video' && width > 0 && height > 0) {
    const availableWidth = Math.max(480, Number(window.screen?.availWidth || width) * 0.92);
    const availableHeight = Math.max(320, Number(window.screen?.availHeight || height) - 72);
    const scale = Math.min(1, availableWidth / width, availableHeight / height);
    width *= scale;
    height *= scale;
  }
  void invoke('player_resize_for_media', {
    width,
    height,
    kind: mediaKind,
    detailsOpen: Boolean(detailsOpen)
  }).catch(() => {});
}

function setInfoOpen(open) {
  const next = Boolean(open);
  shell.classList.toggle('is-info-open', next);
  infoPanel.setAttribute('aria-hidden', String(!next));
  infoButton.setAttribute('aria-pressed', String(next));
  infoButton.setAttribute('aria-label', next ? 'Ocultar detalles' : 'Mostrar detalles');
  if (mediaKind === 'audio' && shell.dataset.playerState === 'ready') resizeForMedia(next);
  wakePlayerUi();
}

function setTechnical(technical = {}, converted = null) {
  const audioStream = technical.audio || {};
  const videoStream = technical.video || {};
  const codec = [videoStream.codec, audioStream.codec].filter(Boolean).join(' + ') || 'No disponible';
  const bitrate = Number(audioStream.bitrate_kbps || technical.bitrate_kbps || 0);
  const sampleRate = Number(audioStream.sample_rate_hz || 0);
  const channels = Number(audioStream.channels || 0);
  document.querySelector('[data-tech="codec"]').textContent = codec;
  document.querySelector('[data-tech="bitrate"]').textContent = bitrate > 0 ? `${Math.round(bitrate)} kbps` : 'No disponible';
  document.querySelector('[data-tech="sample-rate"]').textContent = sampleRate > 0 ? `${(sampleRate / 1000).toFixed(sampleRate % 1000 ? 1 : 0)} kHz` : 'No disponible';
  document.querySelector('[data-tech="channels"]').textContent = channels > 0 ? (channels === 1 ? 'Mono' : channels === 2 ? 'Estéreo' : `${channels} canales`) : 'No disponible';
  document.querySelector('[data-tech="container"]').textContent = technical.container || 'No disponible';
  document.querySelector('[data-tech="converted"]').textContent = converted === true ? 'Sí' : converted === false ? 'No' : 'No';
}

function isYoutubeMode() {
  return shell.dataset.playerMode === 'youtube' && Boolean(youtubePlayer);
}

function setAudioCard(snapshot = {}) {
  if (!audioCard) return;
  const thumbnail = String(snapshot.thumbnail || '').trim();
  audioCard.classList.toggle('has-artwork', Boolean(thumbnail));
  audioArtwork.src = thumbnail || '../media-preview.svg';
  audioArtwork.alt = snapshot.title ? `Carátula de ${snapshot.title}` : '';
  audioSourceLabel.textContent = currentSource === 'playlist' ? 'PLAYLIST' : 'ARCHIVO LOCAL';
  audioTitleLabel.textContent = String(snapshot.title || 'Contenido de audio');
  audioSubtitleLabel.textContent = String(snapshot.detail || snapshot.message || 'Reproducción de audio local.');
}

function setPlayerBackdrop(source = '') {
  const value = String(source || '').trim();
  if (!value) {
    shell.style.removeProperty('--player-backdrop-image');
    return;
  }
  const safe = value.replace(/["\\)]/g, '\\$&');
  shell.style.setProperty('--player-backdrop-image', `url("${safe}")`);
}

function clearFullscreenBackdrop() {
  shell.classList.remove('has-static-backdrop');
  if (compactBackdropCanvas) {
    compactBackdropCanvas.width = 0;
    compactBackdropCanvas.height = 0;
  }
}

function captureFullscreenBackdrop() {
  clearFullscreenBackdrop();
  if (!compactBackdropCanvas || activeMedia !== video || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return false;
  const width = Number(video.videoWidth || naturalWidth || 0);
  const height = Number(video.videoHeight || naturalHeight || 0);
  if (!width || !height) return false;
  try {
    compactBackdropCanvas.width = Math.min(width, 720);
    compactBackdropCanvas.height = Math.max(1, Math.round(compactBackdropCanvas.width * height / width));
    const context = compactBackdropCanvas.getContext('2d', { alpha: false });
    if (!context) return false;
    context.drawImage(video, 0, 0, compactBackdropCanvas.width, compactBackdropCanvas.height);
    shell.classList.add('has-static-backdrop');
    return true;
  } catch {
    // Cross-origin media can refuse canvas reads. The CSS thumbnail fallback
    // remains available, but the video itself is never replaced or altered.
    clearFullscreenBackdrop();
    return false;
  }
}

function scheduleFullscreenBackdropCapture() {
  if (fullscreenBackdropFrame) return;
  fullscreenBackdropFrame = window.requestAnimationFrame(() => {
    fullscreenBackdropFrame = 0;
    if (shell.dataset.playerFullscreen === 'on') captureFullscreenBackdrop();
  });
}

function bindMediaElement(next) {
  const generation = ++mediaGeneration;
  activeMedia = next;
  window.clearTimeout(previewRecoveryTimer);
  previewRecoveryTimer = 0;
  activePreviewAudioUrl = '';
  dualPreviewState = null;
  window.clearTimeout(youtubeFallbackTimer);
  window.clearTimeout(previewStageTimer);
  window.clearInterval(youtubeTimelineTimer);
  youtubeTimelineTimer = 0;
  youtubePlayer?.destroy?.();
  youtubePlayer = null;
  onlineEmbedPlatform = '';
  setPlayerBackdrop('');
  youtubeFrame.hidden = true;
  youtubeFrame.removeAttribute('src');
  shell.removeAttribute('data-player-mode');
  shell.removeAttribute('data-player-embed-platform');
  [video, audio].forEach((element) => {
    element.pause();
    element.removeAttribute('src');
    if (element === video) element.removeAttribute('poster');
    element.load();
  });
  activeMedia.volume = Number(volume.value || 1);
  activeMedia.muted = false;
  setPlaybackRate(playbackRate);
  setButtonIcon(muteButton, 'volume');
  return generation;
}

function armPreviewStageTimeout(generation, stage, timeoutMs, onTimeout) {
  window.clearTimeout(previewStageTimer);
  previewStageTimer = window.setTimeout(() => {
    if (generation !== loadGeneration || onlinePreviewStage !== stage) return;
    onTimeout();
  }, timeoutMs);
}

function clearPreviewStageTimeout() {
  window.clearTimeout(previewStageTimer);
  previewStageTimer = 0;
}

function showLowPreviewNotice(snapshot) {
  previewNotice.hidden = true;
  if (!snapshot?.quality_limited) return;
  if (localStorage.getItem(LOW_PREVIEW_NOTICE_KEY) === '1') return;
  const previewHeight = Number(snapshot.height || 0);
  const maxHeight = Number(snapshot.max_height || 0);
  previewNoticeText.textContent = previewHeight > 0 && maxHeight > previewHeight
    ? `La vista previa disponible es ${previewHeight}p y sirve solo para comprobar el contenido. Si descargas el video, podrás elegir calidades de hasta ${maxHeight}p cuando la fuente las ofrezca.`
    : 'Esta reproducción es solo una muestra para comprobar el contenido. La descarga final puede ofrecer una calidad considerablemente mayor.';
  localStorage.setItem(LOW_PREVIEW_NOTICE_KEY, '1');
  previewNotice.hidden = false;
}

function isCurrentMediaBinding(element, generation = mediaGeneration) {
  return generation === mediaGeneration && element === activeMedia;
}

function rememberPreviewPosition() {
  if (currentSource !== 'preview' || activeMedia !== video || video.ended) return;
  const position = Number(video.currentTime || 0);
  if (Number.isFinite(position) && position > 0.5) previewResumeTime = position;
}

function restorePreviewPosition() {
  const position = Number(previewResumeTime || 0);
  const duration = Number(video.duration || 0);
  if (!Number.isFinite(position) || position <= 0.5) return;
  if (Number.isFinite(duration) && duration > 0 && position >= duration - 0.25) {
    previewResumeTime = 0;
    return;
  }
  try { video.currentTime = position; } catch {}
  previewResumeTime = 0;
}

function schedulePreviewRecovery() {
  if (currentSource !== 'preview' || video.paused || video.ended || video.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA) return;
  window.clearTimeout(previewRecoveryTimer);
  previewRecoveryTimer = window.setTimeout(() => {
    if (currentSource !== 'preview' || video.paused || video.ended) return;
    void video.play().catch(() => {});
  }, 350);
}

async function startPlayback(element, generation = mediaGeneration) {
  if (!isCurrentMediaBinding(element, generation)) return;
  try {
    await element.play();
    if (!isCurrentMediaBinding(element, generation)) return;
    return;
  } catch (error) {
    if (!isCurrentMediaBinding(element, generation)) return;
    if (error?.name === 'NotAllowedError' && !element.muted) {
      element.muted = true;
      setButtonIcon(muteButton, 'muted');
      try {
        await element.play();
        if (!isCurrentMediaBinding(element, generation)) return;
        return;
      } catch {}
    }
    updateTimeline();
  }
}

function prepareMedia(next, src, poster = '') {
  const generation = bindMediaElement(next);
  setPlayerBackdrop(poster);
  if (poster && next === video) next.poster = poster;
  next.autoplay = true;
  next.src = src;
  next.addEventListener('loadedmetadata', () => {
    if (next === video) {
      naturalWidth = Number(next.videoWidth || naturalWidth || 854);
      naturalHeight = Number(next.videoHeight || naturalHeight || 480);
    }
    if (next === video) restorePreviewPosition();
    resizeForMedia(false);
    updateTimeline();
    void startPlayback(next, generation);
  }, { once: true });
  next.addEventListener('canplay', () => { void startPlayback(next, generation); }, { once: true });
  next.load();
}

function syncPreviewAudio(force = false) {
  if (!activePreviewAudioUrl || !dualPreviewState || dualPreviewState.syncing) return;
  const videoTime = Number(video.currentTime || 0);
  const audioTime = Number(audio.currentTime || 0);
  if (!force && Math.abs(audioTime - videoTime) <= 0.25) return;
  dualPreviewState.syncing = true;
  try {
    audio.currentTime = videoTime;
  } catch {}
  window.queueMicrotask(() => {
    if (dualPreviewState) dualPreviewState.syncing = false;
  });
}

function disablePreviewAudioForCurrentBinding(state = dualPreviewState) {
  if (!state || state !== dualPreviewState || state.mediaGeneration !== mediaGeneration) return;
  activePreviewAudioUrl = '';
  state.audioFailed = true;
  audio.pause();
  audio.removeAttribute('src');
  audio.load();
}

function prepareSinglePreview(snapshot, generation, reason = '', streamKind = 'progressive', shouldPlay = true, preserveMuted = null) {
  const lowQuality = streamKind === 'low';
  const sourceUrl = String((lowQuality ? snapshot?.low_progressive_stream_url : snapshot?.progressive_stream_url) || '').trim();
  if (!sourceUrl) throw new Error('La fuente no expuso un flujo progresivo reproducible');
  const nextMuted = preserveMuted == null
    ? Boolean(activePreviewAudioUrl ? audio.muted : video.muted)
    : Boolean(preserveMuted);
  const mediaBinding = bindMediaElement(video);
  beginPreviewNetworkMeasurement(snapshot?.preview_quality || snapshot);
  setPlayerBackdrop(snapshot?.thumbnail || '');
  onlinePreviewStage = lowQuality ? 'low' : 'progressive';
  shell.dataset.playerMode = lowQuality ? 'progressive-low' : 'progressive';
  shell.dataset.playerState = 'loading';
  video.autoplay = shouldPlay;
  video.muted = nextMuted;
  video.src = sourceUrl;
  applySnapshotHeading({
    title: snapshot.title,
    subtitle: reason || `${snapshot.creator || 'Vista previa online'} · flujo progresivo estable`,
    source: 'VISTA PREVIA'
  });
  setTechnical((lowQuality ? snapshot.low_progressive_technical : snapshot.progressive_technical) || snapshot.technical || {}, false);
  showLowPreviewNotice({
    ...snapshot,
    width: (lowQuality ? snapshot.low_progressive_width : snapshot.progressive_width) || snapshot.width,
    height: (lowQuality ? snapshot.low_progressive_height : snapshot.progressive_height) || snapshot.height
  });
  video.addEventListener('loadedmetadata', () => {
    if (generation !== loadGeneration || !isCurrentMediaBinding(video, mediaBinding)) return;
    naturalWidth = Number(video.videoWidth || (lowQuality ? snapshot.low_progressive_width : snapshot.progressive_width) || snapshot.width || 854);
    naturalHeight = Number(video.videoHeight || (lowQuality ? snapshot.low_progressive_height : snapshot.progressive_height) || snapshot.height || 480);
    restorePreviewPosition();
    resizeForMedia(false);
    updateTimeline();
  }, { once: true });
  video.addEventListener('canplay', () => {
    if (generation !== loadGeneration || !isCurrentMediaBinding(video, mediaBinding) || !['progressive', 'low'].includes(onlinePreviewStage)) return;
    clearPreviewStageTimeout();
    shell.dataset.playerState = 'ready';
    setControlsEnabled(true);
    wakePlayerUi();
    if (shouldPlay) void startPlayback(video, mediaBinding);
  }, { once: true });
  armPreviewStageTimeout(generation, lowQuality ? 'low' : 'progressive', 10000, () => {
    if (lowQuality) {
      onlinePreviewStage = 'failed';
      setState('Vista previa no disponible', 'El flujo seguro de baja calidad tampoco respondió. La descarga normal sigue disponible.', 'error');
      return;
    }
    void fallbackFromProgressive(activePreviewUrl, generation, 'timeout');
  });
  video.load();
}

function prepareDualPreview(snapshot, generation, shouldPlay = true, preserveMuted = null) {
  const videoUrl = String(snapshot?.stream_url || '').trim();
  const audioUrl = String(snapshot?.audio_stream_url || '').trim();
  if (!videoUrl) throw new Error('La fuente no expuso un flujo de video reproducible');
  const nextMuted = preserveMuted == null
    ? Boolean(activePreviewAudioUrl ? audio.muted : video.muted)
    : Boolean(preserveMuted);

  const mediaBinding = bindMediaElement(video);
  beginPreviewNetworkMeasurement(snapshot?.preview_quality || snapshot);
  setPlayerBackdrop(snapshot?.thumbnail || '');
  activePreviewAudioUrl = audioUrl;
  onlinePreviewStage = 'adaptive';
  dualPreviewState = {
    generation,
    mediaGeneration: mediaBinding,
    videoReady: false,
    audioReady: !audioUrl,
    started: false,
    starting: false,
    shouldPlay,
    syncingPlayback: false,
    syncing: false
  };
  shell.dataset.playerMode = 'direct';
  shell.dataset.playerState = 'loading';
  video.autoplay = false;
  video.muted = true;
  video.src = videoUrl;
  if (audioUrl) {
    audio.autoplay = false;
    audio.volume = Number(volume.value || 1);
    audio.muted = nextMuted;
    audio.src = audioUrl;
    audio.load();
  }
  video.addEventListener('loadedmetadata', () => {
    if (generation !== loadGeneration || !isCurrentMediaBinding(video, mediaBinding)) return;
    naturalWidth = Number(video.videoWidth || snapshot.width || 854);
    naturalHeight = Number(video.videoHeight || snapshot.height || 480);
    restorePreviewPosition();
    resizeForMedia(false);
    updateTimeline();
  }, { once: true });
  video.addEventListener('canplay', () => {
    if (generation !== loadGeneration || !isCurrentMediaBinding(video, mediaBinding)) return;
    if (dualPreviewState) dualPreviewState.videoReady = true;
    void startPreviewPlayback();
  }, { once: true });
  audio.addEventListener('canplay', () => {
    if (generation !== loadGeneration || !dualPreviewState || dualPreviewState.mediaGeneration !== mediaBinding) return;
    if (dualPreviewState) dualPreviewState.audioReady = true;
    void startPreviewPlayback();
  }, { once: true });
  armPreviewStageTimeout(generation, 'adaptive', 12000, () => {
    void fallbackFromLowProgressive(activePreviewUrl, generation, 'adaptive-timeout');
  });
  setControlsEnabled(false);
  video.load();
}

async function startPreviewPlayback({ userInitiated = false } = {}) {
  if (!dualPreviewState || !dualPreviewState.videoReady || !dualPreviewState.audioReady) return;
  const state = dualPreviewState;
  if (state.mediaGeneration !== mediaGeneration) return;
  if ((state.started || state.starting) && !userInitiated) return;
  if (state.starting) return;
  if (!state.shouldPlay && !userInitiated) {
    clearPreviewStageTimeout();
    shell.dataset.playerState = 'ready';
    setControlsEnabled(true);
    wakePlayerUi();
    return;
  }
  state.started = true;
  state.starting = true;
  clearPreviewStageTimeout();
  syncPreviewAudio(true);
  shell.dataset.playerState = 'ready';
  setControlsEnabled(true);
  wakePlayerUi();
  try {
    if (video.paused) await video.play();
    if (dualPreviewState !== state || state.mediaGeneration !== mediaGeneration) return;
    if (activePreviewAudioUrl) {
      if (userInitiated) audio.muted = false;
      try {
        if (audio.paused) await audio.play();
      } catch (error) {
        if (error?.name === 'NotAllowedError') {
          // WebView2 can reject the separate audio stream while allowing the
          // muted video stream. Keep video running; a later user gesture retries
          // audio instead of pausing the whole preview.
          audio.muted = true;
          await audio.play().catch(() => {});
        } else {
          // A temporary/expired CDN audio URL must not restart the preview.
          // Keep the already-playing video at its current position.
          disablePreviewAudioForCurrentBinding(state);
        }
      }
    }
  } catch (error) {
    if (error?.name !== 'NotAllowedError') throw error;
    setState('Vista previa lista', 'Pulsa reproducir para iniciar el video con su audio en la calidad disponible.', 'ready');
  } finally {
    if (dualPreviewState === state) dualPreviewState.starting = false;
  }
}

function applySnapshotHeading({ title = '', subtitle = '', source = 'LOCAL' } = {}) {
  const safeTitle = title || 'Contenido multimedia';
  document.title = `${safeTitle} · Clear Download Manager`;
  titleLabel.textContent = safeTitle;
  sourceLabel.textContent = source;
  detailSourceLabel.textContent = source === 'VISTA PREVIA' ? 'VISTA PREVIA ONLINE' : source.startsWith('PLAYLIST') ? source : 'ARCHIVO LOCAL';
  heading.querySelector('h1').textContent = safeTitle;
  updateQualityLabel();
  heading.querySelector('p').textContent = subtitle || (source === 'VISTA PREVIA' ? 'Reproducción temporal sin descargar.' : 'Archivo multimedia local.');
  localizeDom(heading, resolveLocale(loadLocale()));
  localizeDom(document.querySelector('.player-titlebar') || document, resolveLocale(loadLocale()));
}

async function loadJob(jobId, { preservePlaylist = false } = {}) {
  const nextJobId = Number(jobId || 0);
  if (!preservePlaylist) {
    activePlaylistBatchId = 0;
    activePlaylistTitle = '';
    activePlaylistQueue = [];
    activePlaylistIndex = -1;
    setPlaylistPanelOpen(false);
  }
  const nextSource = preservePlaylist ? 'playlist' : 'local';
  if (nextJobId !== activeJobId || currentSource !== nextSource) setInfoOpen(false);
  currentSource = nextSource;
  previewResumeTime = 0;
  shell.dataset.playerSource = nextSource;
  activePreviewUrl = '';
  activeJobId = nextJobId;
  previewNotice.hidden = true;
  const generation = ++loadGeneration;
  window.clearTimeout(refreshTimer);
  if (!activeJobId) {
    setState('No hay una descarga seleccionada', 'Abre el reproductor desde una miniatura multimedia.', 'error');
    return;
  }
  setState('Consultando descarga…', 'Comprobando el archivo local final.', 'loading');
  try {
    const snapshot = await invoke('player_media_snapshot', { jobId: activeJobId });
    if (generation !== loadGeneration) return;
    currentSnapshot = { ...snapshot, source: 'local' };
    mediaKind = snapshot.kind === 'audio' ? 'audio' : 'video';
    shell.dataset.mediaKind = mediaKind;
    const playlistLabel = currentSource === 'playlist' && activePlaylistQueue.length
      ? `PLAYLIST · ${Math.max(1, activePlaylistIndex + 1)}/${activePlaylistQueue.length}`
      : 'LOCAL';
    const playlistSubtitle = currentSource === 'playlist' && activePlaylistTitle
      ? `${activePlaylistTitle}${snapshot.detail ? ` · ${snapshot.detail}` : ''}`
      : snapshot.detail || snapshot.message;
    applySnapshotHeading({ title: snapshot.title, subtitle: playlistSubtitle, source: playlistLabel });
    setAudioCard(snapshot);
    setTechnical(snapshot.technical || {}, snapshot.converted);
    if (!snapshot.playable || !snapshot.local_path) {
      bindMediaElement(video);
      const progress = Number(snapshot.progress || 0);
      const suffix = progress > 0 && progress < 100 ? ` Progreso actual: ${Math.round(progress)}%.` : '';
      setState(snapshot.state_title || 'Todavía no se puede reproducir', `${snapshot.message || 'El archivo final aún no está disponible.'}${suffix}`, 'waiting');
      if (currentSource === 'playlist') {
        refreshTimer = window.setTimeout(() => { void advancePlaylist(1, { skipUnavailable: true }); }, 220);
      } else if (['queued', 'running', 'paused', 'analyzing', 'preparing', 'merging', 'converting'].includes(snapshot.status)) {
        refreshTimer = window.setTimeout(() => { void loadJob(activeJobId); }, 1500);
      }
      return;
    }
    const next = mediaKind === 'audio' ? audio : video;
    shell.dataset.playerState = 'ready';
    setControlsEnabled(true);
    wakePlayerUi();
    if (mediaKind === 'audio') resizeForMedia(false);
    prepareMedia(next, convertFileSrc(snapshot.local_path), snapshot.thumbnail || '');
  } catch (error) {
    if (generation !== loadGeneration) return;
    setState('No se pudo abrir el reproductor', String(error?.message || error || 'Error desconocido'), 'error');
  }
}

async function loadDirectPreview(sourceUrl, generation, reason = '', streamKind = 'best') {
  const snapshot = await invokeWithTimeout('player_online_preview_snapshot', { url: sourceUrl }, 15000);
  if (generation !== loadGeneration) return;
  currentSnapshot = { ...snapshot, source: 'preview' };
  activePreviewQualityId = '';
  if (streamKind === 'low') {
    if (!snapshot.low_progressive_stream_url) throw new Error('La fuente no expuso un flujo progresivo seguro de baja calidad');
    naturalWidth = Number(snapshot.low_progressive_width || snapshot.width || 854);
    naturalHeight = Number(snapshot.low_progressive_height || snapshot.height || 480);
    prepareSinglePreview(snapshot, generation, reason || 'Vista previa segura · calidad compatible', 'low');
    return;
  }
  if (reason !== 'adaptive' && snapshot.qualities?.length) {
    const best = chooseInitialPreviewQuality(snapshot) || snapshot.qualities[0];
    const bestSnapshot = {
      ...snapshot,
      stream_url: best.url,
      audio_stream_url: best.has_audio ? '' : (best.audio_url || snapshot.audio_stream_url || ''),
      width: best.width || snapshot.width,
      height: best.height || snapshot.height,
      preview_quality: best,
      progressive_stream_url: best.has_audio ? best.url : '',
      progressive_width: best.has_audio ? best.width : null,
      progressive_height: best.has_audio ? best.height : null,
      progressive_technical: best.has_audio ? snapshot.technical : null
    };
    currentSnapshot = bestSnapshot;
    activePreviewQualityId = best.id;
    if (best.has_audio) {
      prepareSinglePreview(bestSnapshot, generation, `Vista previa · ${best.label}`, 'progressive');
    } else {
      applySnapshotHeading({ title: bestSnapshot.title, subtitle: `Vista previa adaptativa · ${best.label}`, source: 'VISTA PREVIA' });
      setTechnical(bestSnapshot.technical || {}, false);
      showLowPreviewNotice(bestSnapshot);
      prepareDualPreview(bestSnapshot, generation);
    }
    return;
  }
  if (reason !== 'adaptive' && snapshot.progressive_stream_url) {
    naturalWidth = Number(snapshot.progressive_width || snapshot.width || 854);
    naturalHeight = Number(snapshot.progressive_height || snapshot.height || 480);
    prepareSinglePreview(snapshot, generation, reason);
    return;
  }
  naturalWidth = Number(snapshot.width || 854);
  naturalHeight = Number(snapshot.height || 480);
  applySnapshotHeading({
    title: snapshot.title,
    subtitle: 'Vista previa adaptativa · video y audio sincronizados',
    source: 'VISTA PREVIA'
  });
  setTechnical(snapshot.technical || {}, false);
  showLowPreviewNotice(snapshot);
  prepareDualPreview(snapshot, generation);
}

async function fallbackFromYoutube(sourceUrl, generation, errorCode = 'desconocido') {
  if (generation !== loadGeneration || youtubeFallbackAttempted) return;
  youtubeFallbackAttempted = true;
  window.clearTimeout(youtubeFallbackTimer);
  youtubePlayer?.destroy?.();
  youtubePlayer = null;
  youtubeFrame.hidden = true;
  youtubeFrame.removeAttribute('src');
  shell.dataset.playerMode = 'fallback';
  setState('Preparando reproducción…', 'El reproductor oficial no está disponible en este contexto. Probando primero un flujo progresivo estable.', 'loading');
  try {
    await loadDirectPreview(sourceUrl, generation, 'Vista previa progresiva');
    if (generation === loadGeneration) shell.dataset.playerFallback = `youtube-${errorCode}`;
  } catch (error) {
    if (generation !== loadGeneration) return;
    await fallbackFromProgressive(sourceUrl, generation, errorCode, error);
  }
}

async function fallbackFromProgressive(sourceUrl, generation, errorCode = 'progresivo', previousError = null) {
  if (generation !== loadGeneration || onlinePreviewStage === 'adaptive' || onlinePreviewStage === 'failed') return;
  rememberPreviewPosition();
  onlinePreviewStage = 'adaptive';
  setState('Preparando reproducción…', 'El flujo progresivo no respondió. Actualizando la fuente y probando video y audio adaptativos.', 'loading');
  try {
    await loadDirectPreview(sourceUrl, generation, 'adaptive');
  } catch (error) {
    if (generation !== loadGeneration) return;
    await fallbackFromLowProgressive(sourceUrl, generation, errorCode, error || previousError);
    return;
  }
}

async function fallbackFromLowProgressive(sourceUrl, generation, errorCode = 'desconocido', previousError = null) {
  if (generation !== loadGeneration || onlinePreviewStage === 'failed') return;
  rememberPreviewPosition();
  onlinePreviewStage = 'low';
  setState('Preparando reproducción…', 'El reproductor oficial y los flujos de alta calidad no respondieron. Probando el flujo compatible de seguridad.', 'loading');
  try {
    await loadDirectPreview(sourceUrl, generation, 'Vista previa segura · calidad compatible', 'low');
    if (generation === loadGeneration) shell.dataset.playerFallback = `low-${errorCode}`;
  } catch (error) {
    if (generation !== loadGeneration) return;
    onlinePreviewStage = 'failed';
    if (youtubeVideoId(sourceUrl)) {
      showYoutubeManualFallback(sourceUrl, generation, errorCode, error || previousError);
      return;
    }
    const message = String(error?.message || previousError?.message || 'La fuente no permite una vista previa directa.');
    setState('Vista previa no disponible', `No se pudieron abrir los flujos alternativos (código ${errorCode}). ${message} La descarga normal sigue disponible.`, 'error');
  }
}

function showYoutubeManualFallback(sourceUrl, generation, errorCode = 'desconocido', previousError = null) {
  if (generation !== loadGeneration) return;
  currentSnapshot = {
    source: 'preview',
    title: 'YouTube',
    creator: 'Reproducción nativa no disponible',
    width: 854,
    height: 480,
    technical: {}
  };
  bindMediaElement(video);
  applySnapshotHeading({
    title: 'YouTube',
    subtitle: 'Este vídeo no puede reproducirse directamente en este momento.',
    source: 'VISTA PREVIA'
  });
  setTechnical({}, false);
  shell.dataset.playerMode = 'fallback';
  shell.dataset.playerNativeError = String(previousError?.message || previousError || errorCode);
  setState(
    'Vista previa no disponible',
    'El proveedor no permitió el flujo nativo. Pulsa «Abrir enlace oficial» para continuar fuera de CacaTools.',
    'error',
    Boolean(youtubeVideoId(sourceUrl))
  );
}

async function openOfficialOnlineEmbed(sourceUrl, generation, previousError = null) {
  const embed = await invokeWithTimeout('resolve_online_embed', { url: sourceUrl }, 10000);
  if (generation !== loadGeneration) return;
  const platform = String(embed?.platform || 'plataforma').trim() || 'plataforma';
  const embedUrl = String(embed?.url || '').trim();
  if (!embedUrl) throw new Error('La plataforma no devolvió una URL oficial de reproducción.');

  bindMediaElement(video);
  onlineEmbedPlatform = platform;
  currentSnapshot = {
    source: 'preview',
    title: `${platform} · reproducción online`,
    creator: platform,
    width: 854,
    height: 480,
    technical: {}
  };
  applySnapshotHeading({
    title: `${platform} · reproducción online`,
    subtitle: `Reproductor oficial de ${platform}. La plataforma controla sus propios controles y calidad.`,
    source: 'VISTA PREVIA'
  });
  setTechnical({}, false);
  shell.dataset.playerMode = 'embed';
  shell.dataset.playerEmbedPlatform = platform.toLowerCase();
  shell.dataset.playerState = 'loading';
  youtubeFrame.title = `Reproductor oficial de ${platform}`;
  youtubeFrame.allow = 'autoplay; encrypted-media; fullscreen; picture-in-picture';
  youtubeFrame.hidden = false;
  setControlsEnabled(false);
  resizeForMedia(false);

  await new Promise((resolve, reject) => {
    let settled = false;
    let timeout = 0;
    const onLoad = () => finish();
    const onError = () => finish(new Error(`El reproductor oficial de ${platform} no pudo cargarse.`));
    const finish = (error = null) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timeout);
      youtubeFrame.removeEventListener('load', onLoad);
      youtubeFrame.removeEventListener('error', onError);
      error ? reject(error) : resolve();
    };
    timeout = window.setTimeout(() => {
      finish(new Error(`El reproductor oficial de ${platform} tardó demasiado en responder.`));
    }, 12000);
    youtubeFrame.addEventListener('load', onLoad, { once: true });
    youtubeFrame.addEventListener('error', onError, { once: true });
    youtubeFrame.src = embedUrl;
  });
  if (generation !== loadGeneration) return;
  shell.dataset.playerState = 'ready';
  setControlsEnabled(false);
  clearPlayerUiIdleTimer();
  shell.classList.remove('is-ui-idle');
  if (previousError) shell.dataset.playerDirectError = String(previousError?.message || previousError);
}

async function loadPreview(url) {
  const sourceUrl = String(url || '').trim();
  if (sourceUrl !== activePreviewUrl || currentSource !== 'preview') previewResumeTime = 0;
  if (sourceUrl !== activePreviewUrl || currentSource !== 'preview') setInfoOpen(false);
  currentSource = 'preview';
  shell.dataset.playerSource = 'preview';
  activePlaylistBatchId = 0;
  activePlaylistTitle = '';
  activePlaylistQueue = [];
  activePlaylistIndex = -1;
  setPlaylistPanelOpen(false);
  activePreviewUrl = sourceUrl;
  activeJobId = 0;
  previewNotice.hidden = true;
  youtubeFallbackAttempted = false;
  const generation = ++loadGeneration;
  window.clearTimeout(refreshTimer);
  if (!sourceUrl) {
    setState('No hay un video para previsualizar', 'Analiza primero un enlace multimedia.', 'error');
    return;
  }
  mediaKind = 'video';
  shell.dataset.mediaKind = 'video';
  const videoId = youtubeVideoId(sourceUrl);
  onlinePreviewStage = videoId ? 'native-resolving' : 'progressive';
  applySnapshotHeading({ title: 'Preparando vista previa…', subtitle: 'Resolviendo la mejor fuente disponible sin descargar el archivo final.', source: 'VISTA PREVIA' });
  setState('Preparando vista previa…', 'Resolviendo primero un flujo nativo. Si el proveedor lo bloquea, podrás abrir el enlace oficial manualmente.', 'loading');
  if (videoId) {
    try {
      await loadDirectPreview(sourceUrl, generation, 'Vista previa nativa');
      if (generation === loadGeneration) shell.dataset.playerFallback = 'native-first';
    } catch (nativeError) {
      if (generation !== loadGeneration) return;
      void fallbackFromYoutube(sourceUrl, generation, nativeError?.code || 'native', nativeError);
    }
    return;
  }
  // Platform embeds are the reliable online path for TikTok, Instagram and
  // Pinterest because their CDN URLs commonly require request headers that
  // an HTMLVideoElement cannot attach. Use the official player first and
  // retain the direct/progressive path below as a fallback.
  try {
    await openOfficialOnlineEmbed(sourceUrl, generation);
    return;
  } catch {}
  try {
    await loadDirectPreview(sourceUrl, generation, 'Vista previa progresiva');
  } catch (error) {
    if (generation !== loadGeneration) return;
    try {
      await openOfficialOnlineEmbed(sourceUrl, generation, error);
    } catch (embedError) {
      if (generation !== loadGeneration) return;
      const directMessage = String(error?.message || error || 'La fuente no permite vista previa directa.');
      const embedMessage = String(embedError?.message || embedError || 'El reproductor oficial tampoco está disponible.');
      setState('Vista previa no disponible', `${directMessage} ${embedMessage} Puedes descargar el contenido normalmente; CacaTools no simulará una reproducción que la fuente no permita.`, 'error');
    }
  }
}

async function loadPlaylistItem(index) {
  if (!activePlaylistQueue.length) return false;
  if (index < 0 || index >= activePlaylistQueue.length) return false;
  const item = activePlaylistQueue[index];
  const jobId = Number(item.job_id || item.jobId || 0);
  if (!playlistItemPlayable(item) || !jobId) return false;
  activePlaylistIndex = index;
  setPlaylistPanelOpen(false);
  renderPlaylistQueue();
  updatePlaylistNavigationState();
  await loadJob(jobId, { preservePlaylist: true });
  return true;
}

async function advancePlaylist(direction = 1, { skipUnavailable = false } = {}) {
  if (playlistAdvancePending || !activePlaylistQueue.length || activePlaylistIndex < 0) return false;
  const nextIndex = playablePlaylistIndexFrom(activePlaylistIndex, direction);
  if (nextIndex >= 0) {
    playlistAdvancePending = true;
    try {
      return await loadPlaylistItem(nextIndex);
    } finally {
      playlistAdvancePending = false;
    }
  }
  if (!skipUnavailable && activeMedia) activeMedia.pause();
  updatePlaylistNavigationState();
  return false;
}

async function loadPlaylist(batchId) {
  const nextBatchId = Number(batchId || 0);
  setInfoOpen(false);
  window.clearTimeout(refreshTimer);
  activePreviewUrl = '';
  activePlaylistBatchId = nextBatchId;
  activePlaylistTitle = '';
  activePlaylistQueue = [];
  activePlaylistIndex = -1;
  currentSource = 'playlist';
  shell.dataset.playerSource = 'playlist';
  if (!nextBatchId) {
    setState('Playlist no válida', 'No se pudo identificar la playlist seleccionada.', 'error');
    return;
  }
  setState('Preparando playlist…', 'Cargando todos los elementos y comprobando cuáles tienen archivo local reproducible.', 'loading');
  try {
    const snapshot = await invoke('player_playlist_queue_snapshot', { batchId: nextBatchId });
    if (Number(activePlaylistBatchId) !== nextBatchId) return;
    activePlaylistTitle = String(snapshot?.title || 'Playlist');
    activePlaylistQueue = Array.isArray(snapshot?.items) ? snapshot.items : [];
    activePlaylistIndex = -1;
    renderPlaylistQueue();
    const playableCount = activePlaylistQueue.filter(playlistItemPlayable).length;
    applySnapshotHeading({
      title: activePlaylistTitle,
      subtitle: activePlaylistQueue.length
        ? `${activePlaylistQueue.length} elementos · ${playableCount} disponibles para reproducir · elige uno de la lista.`
        : 'La playlist no contiene elementos.',
      source: 'PLAYLIST'
    });
    if (!activePlaylistQueue.length) {
      setPlaylistPanelOpen(false);
      setState('Playlist vacía', 'No hay elementos guardados en esta playlist.', 'waiting');
      return;
    }
    bindMediaElement(video);
    setPlaylistPanelOpen(true);
    if (!playableCount) {
      setState('Playlist todavía no reproducible', 'Puedes ver todos sus elementos en la lista, pero ninguno tiene todavía un archivo local final reproducible.', 'waiting');
      setControlsEnabled(false);
      return;
    }
    setState('Elige qué reproducir', 'Selecciona un video o canción de la lista. Después podrás avanzar o retroceder entre los elementos disponibles desde los controles.', 'waiting');
    setControlsEnabled(false);
  } catch (error) {
    setState('No se pudo abrir la playlist', String(error?.message || error || 'Error desconocido'), 'error');
  }
}

window.cacatoolsPlayerLoadJob = (jobId) => { void loadJob(jobId); };
window.cacatoolsPlayerLoadPreview = (url) => { void loadPreview(url); };
window.cacatoolsPlayerLoadPlaylist = (batchId) => { void loadPlaylist(batchId); };
window.cacatoolsPlayerLoadPlaylistItem = (batchId, index) => {
  const nextBatchId = Number(batchId || 0);
  const nextIndex = Number(index);
  if (nextBatchId !== activePlaylistBatchId || !activePlaylistQueue.length) {
    void loadPlaylist(nextBatchId).then(() => loadPlaylistItem(nextIndex));
  } else {
    void loadPlaylistItem(nextIndex);
  }
};

function updateTimeline() {
  if (isYoutubeMode()) {
    const duration = Number(youtubePlayer.getDuration?.() || 0);
    const current = Number(youtubePlayer.getCurrentTime?.() || 0);
    const playerState = Number(youtubePlayer.getPlayerState?.() || -1);
    timeline.value = duration > 0 ? String(Math.round((current / duration) * 1000)) : '0';
    document.querySelector('[data-time="current"]').textContent = formatTime(current);
    document.querySelector('[data-time="duration"]').textContent = formatTime(duration);
    const paused = playerState !== 1;
    setButtonIcon(playButton, paused ? 'play' : 'pause');
    playButton.setAttribute('aria-label', paused ? 'Reproducir' : 'Pausar');
    setButtonIcon(muteButton, youtubePlayer.isMuted?.() ? 'muted' : 'volume');
    updatePlaylistNavigationState();
    return;
  }
  const duration = Number(activeMedia.duration || 0);
  const current = Number(activeMedia.currentTime || 0);
  timeline.value = duration > 0 ? String(Math.round((current / duration) * 1000)) : '0';
  document.querySelector('[data-time="current"]').textContent = formatTime(current);
  document.querySelector('[data-time="duration"]').textContent = formatTime(duration);
  const paused = activeMedia.paused;
  setButtonIcon(playButton, paused ? 'play' : 'pause');
  playButton.setAttribute('aria-label', paused ? 'Reproducir' : 'Pausar');
  updatePlaylistNavigationState();
}

[video, audio].forEach((element) => {
  element.addEventListener('timeupdate', () => {
    if (element === activeMedia) updateTimeline();
  });
  element.addEventListener('durationchange', () => {
    if (element === activeMedia) updateTimeline();
  });
  element.addEventListener('play', () => {
    if (element === activeMedia) updateTimeline();
  });
  element.addEventListener('pause', () => {
    if (element === activeMedia) updateTimeline();
  });
  element.addEventListener('ended', () => {
    if (element !== activeMedia) return;
    updateTimeline();
    if (currentSource === 'playlist' && !repeatEnabled) void advancePlaylist(1);
  });
  element.addEventListener('volumechange', () => {
    if (element === activeMedia || (activePreviewAudioUrl && element === audio && dualPreviewState?.mediaGeneration === mediaGeneration)) {
      setButtonIcon(muteButton, element.muted || element.volume === 0 ? 'muted' : 'volume');
    }
  });
  element.addEventListener('error', () => {
    const currentElement = element === activeMedia
      || (activePreviewAudioUrl && element === audio && dualPreviewState?.mediaGeneration === mediaGeneration);
    if (!currentElement) return;
    if (element === audio && activePreviewAudioUrl && dualPreviewState?.mediaGeneration === mediaGeneration) {
      // A CDN can expire the secondary audio URL while the video stream is
      // already playing. Do not restart the whole preview and repeat the
      // first seconds; keep the video position and continue without that
      // optional audio track.
      disablePreviewAudioForCurrentBinding();
      return;
    }
    const online = currentSource === 'preview';
    const playlist = currentSource === 'playlist';
    if (online && onlinePreviewStage === 'progressive') {
      void fallbackFromProgressive(activePreviewUrl, loadGeneration, 'progresivo');
      return;
    }
    if (online && onlinePreviewStage === 'adaptive') {
      void fallbackFromLowProgressive(activePreviewUrl, loadGeneration, 'adaptive');
      return;
    }
    if (online && onlinePreviewStage === 'low') {
      onlinePreviewStage = 'failed';
      setState('Vista previa no disponible', 'El flujo seguro compatible tampoco pudo reproducirse. La descarga normal sigue disponible.', 'error');
      return;
    }
    setState(
      online ? 'La fuente bloqueó esta vista previa' : playlist ? 'Elemento omitido de la playlist' : 'El archivo no pudo reproducirse',
      online
        ? 'El enlace temporal existe, pero esta fuente exige condiciones que WebView2 no puede aplicar directamente. La descarga normal sigue disponible.'
        : playlist
          ? 'Este archivo local existe, pero WebView2 no admite su codec o contenedor. CacaTools continuará con el siguiente elemento reproducible.'
          : 'El archivo existe, pero WebView2 no admite este codec o contenedor.',
      'error',
      !online && !playlist && Boolean(currentSnapshot?.local_path)
    );
    if (playlist) {
      window.clearTimeout(refreshTimer);
      refreshTimer = window.setTimeout(() => { void advancePlaylist(1, { skipUnavailable: true }); }, 350);
    }
  });
});

video.addEventListener('play', () => {
  if (!activePreviewAudioUrl || !dualPreviewState || dualPreviewState.syncingPlayback || !audio.paused) return;
  dualPreviewState.syncingPlayback = true;
  void audio.play().catch(() => {}).finally(() => {
    if (dualPreviewState) dualPreviewState.syncingPlayback = false;
  });
});
video.addEventListener('pause', () => {
  if (activePreviewAudioUrl && dualPreviewState && !audio.paused) audio.pause();
});
video.addEventListener('seeking', () => {
  syncPreviewAudio(true);
});
['stalled', 'waiting'].forEach((eventName) => {
  video.addEventListener(eventName, () => {
    if (previewNetworkState) previewNetworkState.stalls += 1;
    schedulePreviewRecovery();
  });
});
video.addEventListener('timeupdate', () => {
  syncPreviewAudio(false);
  samplePreviewNetworkCapacity();
});
audio.addEventListener('play', () => {
  if (!activePreviewAudioUrl || !dualPreviewState || dualPreviewState.syncingPlayback || !video.paused) return;
  dualPreviewState.syncingPlayback = true;
  void video.play().catch(() => {}).finally(() => {
    if (dualPreviewState) dualPreviewState.syncingPlayback = false;
  });
});

['pointermove', 'pointerdown', 'wheel', 'touchstart', 'focusin'].forEach((eventName) => {
  shell.addEventListener(eventName, wakePlayerUi, { passive: eventName !== 'pointerdown' });
});
shell.addEventListener('mouseleave', () => {
  if (shell.dataset.playerState === 'ready') schedulePlayerUiIdle();
});

const playerTitlebar = document.querySelector('.player-titlebar');
playerTitlebar?.addEventListener('pointerdown', (event) => {
  if (event.button !== 0 || event.target.closest('button, input, select, a, .player-window-controls')) return;
  event.preventDefault();
  void invoke('player_start_dragging').catch(() => {});
});
playerTitlebar?.addEventListener('dblclick', (event) => {
  if (event.target.closest('button, input, select, a, .player-window-controls')) return;
  event.preventDefault();
  void invoke('player_window_action', { action: 'maximize' });
});

document.querySelectorAll('[data-window-action]').forEach((button) => button.addEventListener('click', () => {
  const action = button.dataset.windowAction;
  if (action === 'close') {
    if (playerCloseRequested) return;
    playerCloseRequested = true;
    loadGeneration += 1;
    mediaGeneration += 1;
    clearPreviewStageTimeout();
    window.clearTimeout(refreshTimer);
  }
  void invoke('player_window_action', { action });
}));

playlistList?.addEventListener('click', (event) => {
  const button = event.target.closest('[data-player-playlist-index]');
  if (!button) return;
  const index = Number(button.dataset.playerPlaylistIndex);
  if (Number.isInteger(index)) void loadPlaylistItem(index);
});
playlistToggleButton?.addEventListener('click', () => {
  if (!activePlaylistBatchId || !activePlaylistQueue.length) return;
  setPlaylistPanelOpen(!shell.classList.contains('is-playlist-open'));
});
playlistCloseButton?.addEventListener('click', () => {
  setPlaylistPanelOpen(false);
});
previousTrackButton?.addEventListener('click', () => { void advancePlaylist(-1); });
nextTrackButton?.addEventListener('click', () => { void advancePlaylist(1); });
repeatButton?.addEventListener('click', () => { setRepeatEnabled(!repeatEnabled); });
qualityButton?.addEventListener('click', () => { openQualityMenu(); });
captionsButton?.addEventListener('click', () => { openCapability('captions'); });
speedButton?.addEventListener('click', () => { cyclePlaybackRate(); });
qualityCloseButton?.addEventListener('click', () => { setQualityMenuOpen(false); });
compactCloseButton?.addEventListener('click', () => { setCompactMenuOpen(false); });
compactMenu?.addEventListener('click', (event) => {
  const proxy = event.target.closest?.('[data-compact-proxy]');
  if (!proxy || proxy.hidden) return;
  const action = proxy.dataset.compactProxy;
  if (action === 'fullscreen') {
    void togglePlayerFullscreen();
    setCompactMenuOpen(false);
    return;
  }
  if (action === 'info') {
    setCompactMenuOpen(false);
    setInfoOpen(true);
    return;
  }
  if (action === 'volume') {
    if (event.target.closest('input')) return;
    const source = compactSourceButton('volume');
    if (source && !source.disabled) source.click();
    return;
  }
  const source = compactSourceButton(action);
  if (source && !source.disabled) source.click();
  if (action !== 'mute') setCompactMenuOpen(false);
});
compactMenu?.querySelector('.compact-volume')?.addEventListener('input', (event) => {
  volume.value = event.currentTarget.value;
  volume.dispatchEvent(new Event('input', { bubbles: true }));
});
qualityList?.addEventListener('click', (event) => {
  const option = event.target.closest?.('[data-quality-id],[data-youtube-quality]');
  if (!option) return;
  void applyPreviewQuality(option.dataset.qualityId || option.dataset.youtubeQuality);
});

fallbackButton.addEventListener('click', () => {
  if (currentSnapshot?.source === 'local' && currentSnapshot?.local_path) {
    void invoke('open_local_file', { path: currentSnapshot.local_path });
    return;
  }
  if (currentSource === 'preview' && activePreviewUrl && youtubeVideoId(activePreviewUrl)) {
    void invoke('open_external_url', { url: activePreviewUrl });
  }
});
revealButton?.addEventListener('click', () => {
  if (currentSnapshot?.source === 'local' && currentSnapshot?.local_path) void invoke('reveal_local_file', { path: currentSnapshot.local_path });
});

playButton.addEventListener('click', () => {
  if (isYoutubeMode()) {
    if (Number(youtubePlayer.getPlayerState?.() || -1) === 1) youtubePlayer.pauseVideo?.();
    else youtubePlayer.playVideo?.();
    return;
  }
  if (activeMedia.paused) {
    if (activePreviewAudioUrl) void startPreviewPlayback({ userInitiated: true });
    else void activeMedia.play();
  } else {
    activeMedia.pause();
    if (activePreviewAudioUrl) audio.pause();
  }
});
// Local playback follows the standalone CMP player: clicking anywhere on the
// media stage toggles the active video or audio.  Controls and panels are
// excluded so their own buttons remain single-purpose.  The online preview is
// deliberately left to its existing YouTube/progressive event model.
playerStage?.addEventListener('click', (event) => {
  if (event.button !== 0 || currentSource === 'preview' || isYoutubeMode()) return;
  const target = event.target;
  if (target?.closest?.('button, input, select, a, .player-controls, .player-popover, .player-info, .player-playlist-panel')) return;
  if (target !== mediaWrap && !target?.closest?.('.player-media-wrap, .player-audio-card')) return;
  if (!activeMedia || shell.dataset.playerState !== 'ready') return;
  if (activeMedia.paused) void activeMedia.play();
  else activeMedia.pause();
});
document.querySelector('[data-player-action="back"]').addEventListener('click', () => {
  if (isYoutubeMode()) { youtubePlayer.seekTo(Math.max(0, Number(youtubePlayer.getCurrentTime?.() || 0) - 10), true); return; }
  activeMedia.currentTime = Math.max(0, activeMedia.currentTime - 10);
});
document.querySelector('[data-player-action="forward"]').addEventListener('click', () => {
  if (isYoutubeMode()) { youtubePlayer.seekTo(Math.min(Number(youtubePlayer.getDuration?.() || Infinity), Number(youtubePlayer.getCurrentTime?.() || 0) + 10), true); return; }
  activeMedia.currentTime = Math.min(activeMedia.duration || Infinity, activeMedia.currentTime + 10);
});
muteButton.addEventListener('click', () => {
  if (isYoutubeMode()) {
    if (youtubePlayer.isMuted?.()) youtubePlayer.unMute?.(); else youtubePlayer.mute?.();
    setMuteButtonState(Boolean(youtubePlayer.isMuted?.()));
    updateTimeline();
    return;
  }
  if (activePreviewAudioUrl) {
    audio.muted = !audio.muted;
    video.muted = true;
    setMuteButtonState(audio.muted);
    return;
  }
  activeMedia.muted = !activeMedia.muted;
  setMuteButtonState(activeMedia.muted);
});
infoButton.addEventListener('click', () => {
  if (shell.classList.contains('is-compact')) {
    setCompactMenuOpen(!shell.classList.contains('is-compact-menu-open'));
    return;
  }
  setInfoOpen(!shell.classList.contains('is-info-open'));
});
infoCloseButton.addEventListener('click', () => { setInfoOpen(false); });
previewNoticeClose.addEventListener('click', () => { previewNotice.hidden = true; });
async function togglePlayerFullscreen() {
  // The native Tauri window owns fullscreen on Windows. The WebView
  // fullscreen API only changes the document viewport and can leave the
  // taskbar work-area height behind, which is especially visible with
  // vertical and square media.
  if (fullscreenTransitionPending) return;
  fullscreenTransitionPending = true;
  const entering = shell.dataset.playerFullscreen !== 'on';
  if (!entering) clearFullscreenBackdrop();
  shell.dataset.playerFullscreen = entering ? 'on' : 'off';
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    await invoke('player_window_action', { action: 'fullscreen' });
  } catch (error) {
    shell.dataset.playerFullscreen = entering ? 'off' : 'on';
    if (entering) clearFullscreenBackdrop();
    throw error;
  } finally {
    fullscreenTransitionPending = false;
  }
}
document.querySelector('[data-player-action="fullscreen"]').addEventListener('click', () => { void togglePlayerFullscreen(); });
document.addEventListener('fullscreenchange', () => {
  if (document.fullscreenElement) shell.dataset.playerFullscreen = 'on';
  if (!document.fullscreenElement && shell.dataset.playerFullscreen !== 'on') {
    clearFullscreenBackdrop();
    window.setTimeout(() => resizeForMedia(false), 0);
  }
});
timeline.addEventListener('input', () => {
  if (isYoutubeMode()) { youtubePlayer.seekTo((Number(timeline.value) / 1000) * Number(youtubePlayer.getDuration?.() || 0), true); return; }
  const duration = Number(activeMedia.duration || 0);
  if (duration > 0) activeMedia.currentTime = (Number(timeline.value) / 1000) * duration;
});
volume.addEventListener('input', () => {
  if (isYoutubeMode()) { youtubePlayer.setVolume?.(Number(volume.value) * 100); youtubePlayer.unMute?.(); updateTimeline(); return; }
  activeMedia.volume = Number(volume.value);
  if (activePreviewAudioUrl) audio.volume = Number(volume.value);
  activeMedia.muted = false;
  setMuteButtonState(false);
});
video.addEventListener('dblclick', () => { void togglePlayerFullscreen(); });

document.addEventListener('keydown', (event) => {
  if (event.key === 'MediaPlayPause' || event.code === 'MediaPlayPause') {
    event.preventDefault();
    playButton.click();
    return;
  }
  if (event.key === 'Escape' && shell.classList.contains('is-quality-open')) { setQualityMenuOpen(false); return; }
  if (event.key === 'Escape' && shell.classList.contains('is-playlist-open')) { setPlaylistPanelOpen(false); return; }
  if (event.key === 'Escape' && shell.classList.contains('is-info-open')) { setInfoOpen(false); return; }
  if (event.key === 'Escape' && shell.classList.contains('is-compact-menu-open')) { setCompactMenuOpen(false); return; }
  if (event.target instanceof HTMLInputElement && event.target !== timeline && event.target !== volume) return;
  if (event.code === 'Space') { event.preventDefault(); if (activeMedia.paused) void activeMedia.play(); else activeMedia.pause(); }
  if (event.key === 'ArrowLeft') activeMedia.currentTime = Math.max(0, activeMedia.currentTime - 5);
  if (event.key === 'ArrowRight') activeMedia.currentTime = Math.min(activeMedia.duration || Infinity, activeMedia.currentTime + 5);
  if (event.key.toLowerCase() === 'm') activeMedia.muted = !activeMedia.muted;
  if (event.key.toLowerCase() === 'r') setRepeatEnabled(!repeatEnabled);
  if (currentSource === 'playlist' && event.key.toLowerCase() === 'n') { event.preventDefault(); void advancePlaylist(1); }
  if (currentSource === 'playlist' && event.key.toLowerCase() === 'p') { event.preventDefault(); void advancePlaylist(-1); }
  if (event.key.toLowerCase() === 'f') { event.preventDefault(); void togglePlayerFullscreen(); }
});

function keepBackgroundPlaybackActive() {
  if (!navigator.locks?.request) return;
  void navigator.locks.request('cacatools-player-background-playback', async () => new Promise(() => {}));
}

function bindMediaSession() {
  if (!('mediaSession' in navigator) || typeof navigator.mediaSession.setActionHandler !== 'function') return;
  const handlers = {
    play: () => {
      if (isYoutubeMode()) youtubePlayer?.playVideo?.();
      else if (activeMedia.paused) void activeMedia.play();
    },
    pause: () => {
      if (isYoutubeMode()) youtubePlayer?.pauseVideo?.();
      else activeMedia.pause();
    },
    seekbackward: (details = {}) => {
      const offset = Number(details.seekOffset || 10);
      if (isYoutubeMode()) youtubePlayer?.seekTo?.(Math.max(0, Number(youtubePlayer.getCurrentTime?.() || 0) - offset), true);
      else activeMedia.currentTime = Math.max(0, Number(activeMedia.currentTime || 0) - offset);
    },
    seekforward: (details = {}) => {
      const offset = Number(details.seekOffset || 10);
      if (isYoutubeMode()) youtubePlayer?.seekTo?.(Math.min(Number(youtubePlayer.getDuration?.() || Infinity), Number(youtubePlayer.getCurrentTime?.() || 0) + offset), true);
      else activeMedia.currentTime = Math.min(activeMedia.duration || Infinity, Number(activeMedia.currentTime || 0) + offset);
    },
    previoustrack: () => { if (currentSource === 'playlist') void advancePlaylist(-1); },
    nexttrack: () => { if (currentSource === 'playlist') void advancePlaylist(1); }
  };
  Object.entries(handlers).forEach(([action, handler]) => {
    try { navigator.mediaSession.setActionHandler(action, handler); } catch {}
  });
}

window.addEventListener('beforeunload', () => {
  clearPlayerUiIdleTimer();
  window.clearTimeout(playerEntryStartTimer);
  window.clearTimeout(playerEntryFinishTimer);
  window.clearTimeout(refreshTimer);
  window.clearTimeout(youtubeFallbackTimer);
  window.clearTimeout(previewStageTimer);
  window.clearTimeout(previewRecoveryTimer);
  window.clearInterval(youtubeTimelineTimer);
  [video, audio].forEach((element) => { element.pause(); element.removeAttribute('src'); element.load(); });
  youtubePlayer?.destroy?.();
  youtubePlayer = null;
  releaseNativeFullscreenListener?.();
  releaseNativeFullscreenListener = null;
  releaseAppearanceListener?.();
  releaseAppearanceListener = null;
  playerResizeObserver?.disconnect();
  playerResizeObserver = null;
  if (fullscreenBackdropFrame) window.cancelAnimationFrame(fullscreenBackdropFrame);
  fullscreenBackdropFrame = 0;
  clearFullscreenBackdrop();
});

applyAppearance(currentAppearance);
setButtonIcon(playButton, 'play');
setButtonIcon(muteButton, 'volume');
setButtonIcon(previousTrackButton, 'previous');
setButtonIcon(nextTrackButton, 'next');
setButtonIcon(revealButton, 'reveal');
setButtonIcon(playlistToggleButton, 'list');
setButtonIcon(infoButton, 'settings');
setButtonIcon(repeatButton, 'repeat');
syncCompactProxyIcons();
installPlayerResizeObserver();
void installNativeFullscreenListener();
void installAppearanceSync();
setRepeatEnabled(false);
window.addEventListener('storage', (event) => {
  if (!event.key || event.key === 'cacatools.desktop.appearance.v2' || event.key === 'cacatools.desktop.appearance.v1') {
    currentAppearance = loadStoredAppearance();
    applyAppearance(currentAppearance);
  }
});
keepBackgroundPlaybackActive();
bindMediaSession();
setControlsEnabled(false);
schedulePlayerEntry();
if (activePreviewUrl) void loadPreview(activePreviewUrl);
else if (activePlaylistBatchId) void loadPlaylist(activePlaylistBatchId);
else void loadJob(activeJobId);
