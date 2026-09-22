import { lucideIcon, playlistPrepLogo } from './assets/icons/lucide.js';
import { applyAppearance, iconVariantForColor, loadStoredAppearance, storeAppearanceLocally } from './modules/appearance/index.js?v=0.95.0-verify-20260911-r4';
import { bindAppearanceSync } from './modules/appearance/sync.js?v=0.95.0-verify-20260911-r4';
import { bindDestinationPickerState, chooseDestinationDirectory } from './modules/downloads/destination-picker.js?v=0.45.1';
import { loadLocale, resolveLocale } from './modules/i18n/index.js';
import { localizeDom } from './modules/i18n/runtime.js';

document.addEventListener('contextmenu', (event) => event.preventDefault(), true);

const query = new URLSearchParams(window.location.search);
const requestedKind = query.get('kind') === 'playlist'
  ? 'playlist'
  : ['direct', 'http'].includes(query.get('kind'))
    ? 'direct'
    : 'media';
const windowLabel = requestedKind === 'playlist'
  ? 'playlist-prep'
  : requestedKind === 'direct'
    ? 'http-prep'
    : 'media-prep';
const root = document.querySelector('#subwindow-root');
const isHttpPreparation = windowLabel === 'http-prep';
const previewMode = query.has('preview');
const sourceFromQuery = String(query.get('source') || '').trim();
const abortController = new AbortController();
const thumbnailCache = new Map();
const analysisCache = new Map();
const subwindowLifecycle = [];
function markSubwindowLifecycle(label) {
  const entry = { label, time: performance.now(), window: windowLabel };
  subwindowLifecycle.push(entry);
  window.__cdmSubwindowLifecycle = subwindowLifecycle;
  return entry;
}
markSubwindowLifecycle('webview-bootstrap');
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => markSubwindowLifecycle('dom-ready'), { once: true });
} else {
  markSubwindowLifecycle('dom-ready');
}
if (document.fonts?.ready) {
  document.fonts.ready.then(() => markSubwindowLifecycle('css-ready')).catch(() => markSubwindowLifecycle('css-ready'));
} else {
  markSubwindowLifecycle('css-ready');
}
let subwindowEntryStarted = false;
let subwindowEntryStartTimer = 0;
let subwindowEntryFinishTimer = 0;

function finishSubwindowEntry() {
  if (!subwindowEntryStarted || document.body.classList.contains('subwindow-entry-complete')) return;
  window.clearTimeout(subwindowEntryFinishTimer);
  document.body.classList.remove('subwindow-ready');
  document.body.classList.add('subwindow-entry-complete');
  markSubwindowLifecycle('entry-class-removed');
}

function startSubwindowEntry(reason = 'entry-start') {
  if (subwindowEntryStarted) return;
  subwindowEntryStarted = true;
  window.clearTimeout(subwindowEntryStartTimer);
  markSubwindowLifecycle(reason);
  document.body.classList.add('subwindow-ready');
  markSubwindowLifecycle('entry-class-added');
  subwindowEntryFinishTimer = window.setTimeout(finishSubwindowEntry, 360);
  root?.querySelector(':scope > .app-window')?.addEventListener('animationend', (event) => {
    if (event.animationName === 'cdm-motion-subwindow-enter') finishSubwindowEntry();
  }, { once: true });
}

function scheduleSubwindowEntry() {
  subwindowEntryStartTimer = window.setTimeout(() => startSubwindowEntry('entry-failsafe'), 700);
  window.requestAnimationFrame(() => {
    markSubwindowLifecycle('first-visible-frame');
    window.requestAnimationFrame(() => startSubwindowEntry());
  });
}

function armSubwindowEntryFailSafe() {
  window.clearTimeout(subwindowEntryStartTimer);
  subwindowEntryStartTimer = window.setTimeout(() => startSubwindowEntry('entry-failsafe'), 700);
}

function applySubwindowLayoutTokens() {
  const interfaceRatio = Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--ui-scale')) || 1;
  const mediaThumbRatio = Math.max(36, 44 - Math.max(0, interfaceRatio - 1) * 32);
  const mediaHeroPadding = Math.max(16, 22 - Math.max(0, interfaceRatio - 1) * 25);
  const mediaUsesNaturalHeight = interfaceRatio > 1.08;
  const rootStyle = document.querySelector('#subwindow-root')?.style || document.documentElement.style;
  rootStyle.setProperty('--media-thumb-ratio', `${mediaThumbRatio.toFixed(2)}%`);
  rootStyle.setProperty('--media-hero-padding', `${mediaHeroPadding.toFixed(2)}px`);
  rootStyle.setProperty('--multimedia-grid-height', mediaUsesNaturalHeight ? 'auto' : '100%');
  rootStyle.setProperty('--multimedia-grid-rows', mediaUsesNaturalHeight ? 'auto auto' : 'minmax(0,1.16fr) minmax(0,.94fr)');
}
const MEDIA_DOWNLOAD_PREFERENCES_KEY = 'cacatools.media-download-preferences.v1';
const MEDIA_OUTPUT_MODES = new Set(['video_mp4', 'video_webm', 'audio_best', 'audio_mp3', 'audio_m4a']);
const VIDEO_QUALITY_VALUES = new Set(['best', '2160', '1440', '1080', '720', '480', '360', '240', '144']);
const PLAYLIST_FORMAT_OPTIONS = [
  ['MP3 320 kbps', 'MP3 320 kbps'],
  ['M4A', 'M4A'],
  ['Opus', 'Opus'],
  ['MP3 V0', 'MP3 V0'],
  ['Video · MP4 720p', 'Video · MP4 720p'],
  ['Video · MP4 480p', 'Video · MP4 480p'],
  ['Video · MP4 1080p', 'Video · MP4 1080p'],
  ['Video · mejor disponible', 'Video · mejor disponible']
];

function normalizeVideoQuality(value) {
  const quality = String(value || 'best');
  return VIDEO_QUALITY_VALUES.has(quality) ? quality : 'best';
}

function videoSelectorForQuality(value) {
  const quality = normalizeVideoQuality(value);
  return quality === 'best'
    ? 'bestvideo*+bestaudio/best'
    : `bestvideo[height<=${quality}]+bestaudio/best[height<=${quality}]/best[height<=${quality}]`;
}

function selectorMatchesQuality(selector, quality) {
  const normalized = normalizeVideoQuality(quality);
  if (normalized === 'best') return true;
  return new RegExp(`height<=${normalized}(?:\\D|$)`).test(String(selector || ''));
}

function selectorHasUnsafeBestFallback(selector, quality) {
  const normalized = normalizeVideoQuality(quality);
  if (normalized === 'best') return false;
  const value = String(selector || '');
  if (!selectorMatchesQuality(value, normalized)) return true;
  // yt-dlp evaluates the first branch before the slash. A generic bestvideo
  // branch there would ignore the bounded fallback that follows it.
  return /^(?:bestvideo\*?|bv\*)\+bestaudio(?:\/|$)/i.test(value);
}

function qualityFromText(value) {
  const match = String(value || '').match(/(?:height<=|\b)(2160|1440|1080|720|480|360|240|144)p?/i);
  return match ? match[1] : 'best';
}

function loadMediaDownloadPreferences() {
  try {
    const value = JSON.parse(localStorage.getItem(MEDIA_DOWNLOAD_PREFERENCES_KEY) || '{}');
    const outputMode = MEDIA_OUTPUT_MODES.has(value.outputMode) ? value.outputMode : 'video_mp4';
    return {
      outputMode,
      formatSelector: typeof value.formatSelector === 'string' ? value.formatSelector : '',
      videoQuality: normalizeVideoQuality(value.videoQuality || qualityFromText(value.formatSelector)),
      playlistFormat: typeof value.playlistFormat === 'string' && value.playlistFormat.trim()
        ? value.playlistFormat
        : 'MP3 320 kbps'
    };
  } catch {
    return { outputMode: 'video_mp4', formatSelector: '', videoQuality: 'best', playlistFormat: 'MP3 320 kbps' };
  }
}

const storedMediaDownloadPreferences = loadMediaDownloadPreferences();
const handoffPreferredFormat = String(query.get('preferredFormat') || '').trim().toLowerCase();
const handoffPreferredQuality = String(query.get('preferredQuality') || '').trim().toLowerCase();
const handoffFilename = String(query.get('filename') || '').trim().slice(0, 180);
const handoffHasMediaPreference = Boolean(handoffPreferredFormat || handoffPreferredQuality);
const handoffMediaPreferences = (() => {
  let outputMode = storedMediaDownloadPreferences.outputMode;
  let videoQuality = storedMediaDownloadPreferences.videoQuality;
  if (handoffPreferredFormat === 'mp3') outputMode = 'audio_mp3';
  else if (handoffPreferredFormat === 'm4a') outputMode = 'audio_m4a';
  else if (handoffPreferredFormat === 'webm') outputMode = 'video_webm';
  else if (handoffPreferredFormat === 'mp4') outputMode = 'video_mp4';
  if (/^(2160|1440|1080|720|480|360|240|144)p?$/.test(handoffPreferredQuality)) videoQuality = handoffPreferredQuality.replace(/p$/, '');
  return { outputMode, videoQuality };
})();
const state = {
  kind: requestedKind,
  source: sourceFromQuery,
  title: '',
  creator: '',
  analysis: null,
  direct: null,
  busy: false,
  phase: 'Preparando enlace…',
  error: '',
  outputMode: handoffMediaPreferences.outputMode,
  selectedFormat: handoffHasMediaPreference ? '' : storedMediaDownloadPreferences.formatSelector,
  videoQuality: handoffMediaPreferences.videoQuality,
  sessionConsent: false,
  cookiesPath: '',
  playlistFormat: storedMediaDownloadPreferences.playlistFormat,
  destination: 'Descargas\\CacaTools',
  filename: handoffFilename,
  filenameTouched: Boolean(handoffFilename),
  formatError: '',
  items: [],
  sizeGeneration: 0,
  sizeActive: 0,
  sizeQueue: [],
  submitted: false,
  analysisRequestId: 0,
  activeAnalysisRequestId: 0,
  closeRequested: false,
  visibleStart: 0,
  visibleEnd: 24,
  visibleColumns: 2,
  rowHeight: 111.875,
  listController: null
};

const invoke = async (command, args = {}) => {
  const call = window.__TAURI__?.core?.invoke;
  if (!call) throw new Error('Tauri no disponible');
  return call(command, args);
};

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[character]));
}

function normalizedFormatLabel(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase()
    .replace(/v[^a-z]*deo/g, 'video')
    .trim();
}

function playlistFormatOptions() {
  const selected = normalizedFormatLabel(state.playlistFormat);
  return PLAYLIST_FORMAT_OPTIONS.map(([value, label]) => `<option value="${escapeHtml(value)}" ${normalizedFormatLabel(value) === selected ? 'selected' : ''}>${escapeHtml(label)}</option>`).join('');
}

function isTikTokSource(value) {
  try { return /(?:^|\.)tiktok\.com$/i.test(new URL(String(value || ''), window.location.href).hostname); } catch { return /tiktok\.com/i.test(String(value || '')); }
}

function waitForAnalysisRetry(delayMs) {
  return new Promise((resolve) => window.setTimeout(resolve, delayMs));
}

function analysisIsCurrent(requestId, generation) {
  return !state.closeRequested
    && state.activeAnalysisRequestId === requestId
    && state.sizeGeneration === generation;
}

async function invokeMediaAnalysisWithRetry(url, generation = state.sizeGeneration, requestId = state.activeAnalysisRequestId) {
  const source = String(url || '').trim();
  const attempts = isTikTokSource(source) ? 3 : 1;
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    if (!analysisIsCurrent(requestId, generation)) return null;
    try {
       return await invoke('analyze_media_url_with_session_for_window', {
         url: source,
         useBraveCookies: Boolean(state.sessionConsent),
         cookiesPath: state.cookiesPath || null,
         windowLabel
       });
    }
    catch (error) {
      lastError = error;
      if (attempt >= attempts) break;
      state.phase = `Reintentando análisis (${attempt + 1}/${attempts})…`;
      if (analysisIsCurrent(requestId, generation) && state.busy) render();
      await waitForAnalysisRetry(450 * attempt);
    }
  }
  throw lastError || new Error('No se pudo analizar el enlace.');
}

function isSpotifyUrl(value) {
  return /^(?:spotify:|https?:\/\/(?:open\.)?spotify\.com|https?:\/\/.*\.scdn\.co)/i.test(String(value || '').trim());
}

function formatBytes(value, estimated = false) {
  const bytes = Number(value);
  if (!Number.isFinite(bytes) || bytes <= 0) return '';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let amount = bytes;
  let index = 0;
  while (amount >= 1024 && index < units.length - 1) { amount /= 1024; index += 1; }
  const digits = amount >= 100 || index === 0 ? 0 : amount >= 10 ? 1 : 2;
  return `${estimated ? '~' : ''}${amount.toFixed(digits)} ${units[index]}`;
}

function displayWindowsPath(path) {
  const value = String(path || '');
  if (value.startsWith('\\\\?\\UNC\\')) return `\\\\${value.slice(8)}`;
  return value.startsWith('\\\\?\\') ? value.slice(4) : value;
}

function safeThumbnail(source, key = '') {
  const value = String(source || '').trim();
  const cacheKey = key || value;
  if (!value) return '';
  if (thumbnailCache.has(cacheKey)) return thumbnailCache.get(cacheKey);
  let result = value;
  try {
    const url = new URL(value, window.location.href);
    if ((url.protocol === 'http:' || url.protocol === 'https:') && !/(?:tiktokcdn|ibytedtos|muscdn|byteimg|byteoversea)/i.test(url.hostname)) {
      url.searchParams.set('ct_thumbnail_v', '3');
    }
    result = url.toString();
  } catch {}
  thumbnailCache.set(cacheKey, result);
  while (thumbnailCache.size > 96) thumbnailCache.delete(thumbnailCache.keys().next().value);
  return result;
}

function icon(name, size = 20) { return lucideIcon(name, size); }

function platformInfo(source = state.source) {
  let host = '';
  try { host = new URL(String(source || '').trim()).hostname.toLowerCase(); } catch {}
  return host.includes('youtube') || host === 'youtu.be' ? ['youtube', 'YouTube', 'youtube.ico']
    : host.includes('tiktok') ? ['tiktok', 'TikTok', 'media_social_tiktok_icon_124256.ico']
      : host.includes('pinterest') || host === 'pin.it' ? ['pinterest', 'Pinterest', 'pinterest.ico']
        : host.includes('instagram') ? ['instagram', 'Instagram', 'instagram.ico']
          : host.includes('spotify') ? ['spotify', 'Spotify', 'spotify.ico']
            : host.includes('vimeo') ? ['vimeo', 'Vimeo', '']
              : host.includes('dailymotion') ? ['dailymotion', 'Dailymotion', '']
                : host.includes('twitter') || host === 'x.com' ? ['x', 'X', 'twitter.ico']
                  : host.includes('facebook') ? ['facebook', 'Facebook', 'facebook.ico']
                    : host.includes('reddit') ? ['reddit', 'Reddit', '']
                      : host.includes('twitch') ? ['twitch', 'Twitch', '']
                        : host.includes('soundcloud') ? ['soundcloud', 'SoundCloud', '']
                          : host.includes('bilibili') ? ['bilibili', 'Bilibili', '']
                            : host ? ['http', host.replace(/^www\./, ''), ''] : ['http', 'Descarga HTTP', ''];
}

function platformLogo(source = state.source) {
  const platform = platformInfo(source);
  const logo = platform[2]
    ? `<img src="./assets/platforms/${platform[2]}" alt="${escapeHtml(platform[1])}" aria-hidden="true">`
    : icon('link', 18);
  return `<div class="platform-slot platform-${platform[0]}" title="${escapeHtml(platform[1])}" aria-label="${escapeHtml(platform[1])}">${logo}</div>`;
}

function platformBadge(source = state.source) {
  const platform = platformInfo(source);
  const logo = platform[2] ? `<img src="./assets/platforms/${platform[2]}" alt="" aria-hidden="true">` : icon('link', 18);
  return `<span class="platform-badge platform-${platform[0]}">${logo}<strong>${escapeHtml(platform[1])}</strong></span>`;
}

function mediaFormats() {
  const source = Array.isArray(state.analysis?.formats) ? state.analysis.formats : [];
  if (source.length) return source.slice(0, 16);
  return [{ id: 'bestvideo*+bestaudio/best', label: 'Mejor disponible', audio_only: false }];
}

function outputModeIsAudio(mode = state.outputMode) { return String(mode || '').startsWith('audio_'); }

function formatsForOutputMode(formats = mediaFormats(), mode = state.outputMode) {
  const source = Array.isArray(formats) ? formats : [];
  if (mode === 'source') return source;
  const audio = outputModeIsAudio(mode);
  const matching = source.filter((format) => Boolean(format.audio_only) === audio);
  return matching.length ? matching : source;
}

function formatVideoHeight(format = {}) {
  const match = `${format.resolution || ''} ${format.label || ''} ${format.id || ''}`.match(/(?:height<=|\b)(2160|1440|1080|720|480|360|240|144)p?/i);
  return match ? Number(match[1]) : 0;
}

function formatName(format = {}) {
  return String(format.label || format.resolution || format.ext || 'Mejor disponible')
    .replace(/\s*·?\s*vídeo\s*\+\s*audio/gi, '')
    .trim() || 'Mejor disponible';
}

function formatLabel(format = {}) {
  const label = formatName(format);
  const size = formatBytes(format.filesize).replace(/^~/, '');
  return size ? `${label} · aprox. ${size}` : label;
}

function formatCompatibilityMessage() {
  return state.formatError ? 'Selecciona un formato y calidad compatibles.' : '';
}

function persistMediaDownloadPreferences() {
  try {
    localStorage.setItem(MEDIA_DOWNLOAD_PREFERENCES_KEY, JSON.stringify({
      outputMode: MEDIA_OUTPUT_MODES.has(state.outputMode) ? state.outputMode : 'video_mp4',
      formatSelector: state.selectedFormat || '',
      videoQuality: normalizeVideoQuality(state.videoQuality || qualityFromText(state.selectedFormat)),
      playlistFormat: state.playlistFormat || 'MP3 320 kbps'
    }));
  } catch {}
}

function chooseFormat() {
  const formats = mediaFormats();
  const audio = outputModeIsAudio();
  const current = formats.find((format) => String(format.id || '') === state.selectedFormat);
  if (current && Boolean(current.audio_only) === audio
    && (audio || state.videoQuality === 'best'
      || selectorMatchesQuality(current.id, state.videoQuality)
      || (formatVideoHeight(current) > 0 && formatVideoHeight(current) <= Number(state.videoQuality)))) return current;
  const compatible = formatsForOutputMode(formats);
  if (!audio && state.videoQuality !== 'best') {
    const limit = Number(state.videoQuality);
    const preferred = compatible
      .map((format) => ({ format, height: Number(format.height || formatVideoHeight(format) || qualityFromText(format.label || format.id)) || 0 }))
      .filter((entry) => entry.height > 0 && entry.height <= limit)
      .sort((left, right) => right.height - left.height)[0]?.format;
    if (preferred) {
      state.selectedFormat = selectorMatchesQuality(preferred.id, state.videoQuality)
        ? String(preferred.id || videoSelectorForQuality(state.videoQuality))
        : videoSelectorForQuality(state.videoQuality);
      state.formatError = '';
      return preferred;
    }
    state.selectedFormat = videoSelectorForQuality(state.videoQuality);
    state.formatError = `La calidad ${state.videoQuality}p no está disponible en esta fuente.`;
    return null;
  }
  const candidate = audio
    ? compatible.find((format) => String(format.id || '') === 'bestaudio/best' || /original\s*\/\s*mejor audio|mejor audio disponible/i.test(format.label || '')) || compatible[0]
    : compatible.find((format) => /mejor disponible/i.test(format.label || '') || String(format.id || '').startsWith('bestvideo*')) || compatible[0];
  state.selectedFormat = String(candidate?.id || 'bestvideo*+bestaudio/best');
  return candidate || formats[0];
}

function selectedItems() { return state.items.filter((item) => item.selected); }

function playlistSummary() {
  const selected = selectedItems();
  if (!selected.length) return 'Sin elementos seleccionados';
  const known = selected.filter((item) => Number(item.filesize) > 0);
  const pending = selected.filter((item) => ['pending', 'analyzing'].includes(item.sizeStatus)).length;
  const unknown = Math.max(0, selected.length - known.length - pending);
  if (!known.length) return '';
  const total = known.reduce((sum, item) => sum + Number(item.filesize || 0), 0);
  const partial = Boolean(pending || unknown || known.some((item) => item.filesizeEstimated));
  if (pending || unknown) return `${formatBytes(total, true)} · parcial`;
  return formatBytes(total, partial);
}

function mapPlaylistItem(item, index) {
  const sourceUrl = String(item.selected_source_url || item.selectedSourceUrl || item.source_url || item.sourceUrl || '').trim();
  const sourceId = String(item.source_id || item.sourceId || `item-${index + 1}`);
  return {
    ...item,
    id: sourceId,
    sourceId,
    sourceUrl,
    selectedSourceUrl: String(item.selected_source_url || item.selectedSourceUrl || '').trim() || sourceUrl,
    metadataUrl: String(item.metadata_url || item.metadataUrl || '').trim(),
    spotifyUrl: String(item.spotify_url || item.spotifyUrl || '').trim(),
    title: String(item.title || `Elemento ${index + 1}`),
    creator: String(item.creator || state.creator || 'Origen multimedia'),
    durationLabel: String(item.duration_label || item.durationLabel || '—'),
    expectedDurationSeconds: Number(item.duration_seconds || item.expectedDurationSeconds || 0) || null,
    thumbnail: String(item.thumbnail || ''),
    providerId: String(item.provider || item.provider_id || item.providerId || ''),
    resolutionState: String(item.resolution_state || item.resolutionState || ''),
    matchScore: Number(item.match_similarity || item.matchScore || 0),
    selected: item.selected !== false,
    filesize: Number(item.filesize || 0) || null,
    filesizeEstimated: Boolean(item.filesize_estimated || item.filesizeEstimated),
    sizeStatus: Number(item.filesize || 0) > 0 ? 'known' : sourceUrl ? 'pending' : 'unknown'
  };
}

function rowProgressLabel(item) {
  if (!item.sourceUrl) return 'Origen pendiente';
  if (item.sizeStatus === 'analyzing' || item.sizeStatus === 'pending') return 'Analizando…';
  if (item.resolutionState && !['ready', 'download_queued', 'completed'].includes(item.resolutionState)) return 'Revisar coincidencia';
  return item.selected ? 'Preparado' : 'No seleccionado';
}

function playlistRow(item, index) {
  const sourceThumbnail = safeThumbnail(item.thumbnail, item.id);
  const thumbnail = sourceThumbnail || './media-preview.svg';
  const thumbnailClass = sourceThumbnail ? '' : ' is-placeholder';
  const unresolved = !item.sourceUrl || (item.resolutionState && !['ready', 'download_queued', 'completed'].includes(item.resolutionState));
  return `<article class="track-card ${item.selected ? 'selected is-selected' : ''} ${unresolved ? 'is-unresolved' : ''}" data-track-id="${escapeHtml(item.id)}" data-track-index="${index}" tabindex="0" aria-selected="${item.selected ? 'true' : 'false'}">
    <label class="check ${item.selected ? 'on' : ''} track-check" aria-label="${item.selected ? 'Excluir' : 'Incluir'} ${escapeHtml(item.title)}"><input type="checkbox" data-role="item-check" ${item.selected ? 'checked' : ''}><span aria-hidden="true">${item.selected ? icon('check', 14) : ''}</span></label>
    <span class="track-thumb"><img class="${thumbnailClass.trim()}" src="${escapeHtml(thumbnail)}" data-role="track-thumbnail" data-track-thumb-key="${escapeHtml(item.id)}" data-thumbnail-placeholder="${sourceThumbnail ? '0' : '1'}" alt="" loading="lazy" decoding="async"><button type="button" class="preview-play" data-action="preview-track" data-role="track-preview" aria-label="Reproducir ${escapeHtml(item.title)}" title="Vista previa">${icon('play')}</button><b class="duration">${escapeHtml(item.durationLabel)}</b></span>
    <span class="track-copy"><strong>${escapeHtml(item.title)}</strong><span>${escapeHtml(item.creator)}</span></span>
  </article>`;
}

function playlistListMarkup() {
  return `<div class="track-scroll" data-role="track-scroll" tabindex="0" aria-label="Elementos de la playlist"><div class="track-grid" data-role="track-content"></div></div>`;
}

function mediaMarkup() {
  const analysis = state.analysis || {};
  chooseFormat();
  const sourceThumbnail = safeThumbnail(analysis.thumbnail);
  const thumbnail = sourceThumbnail || './media-preview.svg';
  const formats = formatsForOutputMode();
  const formatOptions = formats.map((format) => `<option value="${escapeHtml(format.id || '')}" ${String(format.id || '') === state.selectedFormat ? 'selected' : ''}>${escapeHtml(formatLabel(format))}</option>`).join('');
  const formatError = formatCompatibilityMessage();
  const destinationLabel = displayWindowsPath(state.destination);
  const destination = `<div class="control split"><span data-role="destination-path" title="${escapeHtml(destinationLabel)}">${escapeHtml(destinationLabel)}</span><button type="button" class="btn" data-action="change-folder">Cambiar</button></div>`;
  return `<div class="multimedia-grid">
    <article class="panel accent-rail media-hero">
      <div class="media-thumb"><img class="${sourceThumbnail ? '' : 'is-placeholder'}" src="${escapeHtml(thumbnail)}" data-role="thumbnail" data-thumbnail-placeholder="${sourceThumbnail ? '0' : '1'}" alt="Miniatura de ${escapeHtml(analysis.title || 'contenido multimedia')}" loading="eager" decoding="async"><button type="button" class="preview-play" data-action="preview" tabindex="0" aria-label="Reproducir vista previa">${icon('play')}</button><span class="duration">${escapeHtml(analysis.duration_label || '—')}</span></div>
      <div class="media-copy"><div class="eyebrow">MULTIMEDIA · CONTENIDO</div><h2 class="media-title">${escapeHtml(analysis.title || 'Contenido multimedia')}</h2><div class="media-meta">${escapeHtml(analysis.creator || 'Origen multimedia')} · ${escapeHtml(analysis.duration_label || '—')}</div></div>
    </article>
    <section class="media-options">
      <article class="panel"><div class="panel-head"><div class="icon-box" data-role="panel-icon-format">${icon('settings')}</div><div><div class="panel-kicker">1. PREPARACIÓN</div><h2>Formato y calidad</h2></div></div>
        <label class="field-group"><span class="field-label">Formato de salida</span><div class="control"><select data-role="output"><option value="video_mp4" ${state.outputMode === 'video_mp4' ? 'selected' : ''}>MP4 · vídeo</option><option value="video_webm" ${state.outputMode === 'video_webm' ? 'selected' : ''}>WebM · vídeo</option><option value="audio_best" ${state.outputMode === 'audio_best' ? 'selected' : ''}>Mejor audio disponible</option><option value="audio_mp3" ${state.outputMode === 'audio_mp3' ? 'selected' : ''}>MP3 320 kbps</option><option value="audio_m4a" ${state.outputMode === 'audio_m4a' ? 'selected' : ''}>M4A</option></select>${icon('chevron-down')}</div></label>
         <label class="field-group"><span class="field-label">Calidad / formato</span><div class="control"><select data-role="quality">${formatOptions}</select>${icon('chevron-down')}</div>${formatError ? `<span class="inline-note" role="alert">${escapeHtml(formatError)}</span>` : ''}</label>
      </article>
      <article class="panel"><div class="panel-head"><div class="icon-box" data-role="panel-icon-destination">${icon('folder')}</div><div><div class="panel-kicker">2. DESTINO</div><h2>Destino y archivo</h2></div></div>
        <label class="field-group"><span class="field-label">Guardar en</span>${destination}</label>
        <label class="field-group"><span class="field-label">Nombre del archivo</span><div class="control"><input data-role="filename" aria-label="Nombre del archivo" value="${escapeHtml(state.filename)}" placeholder="Automático (título original)" maxlength="180" autocomplete="off"></div></label>
      </article>
    </section>
  </div>`;
}

function directFileDescriptor(filename = '', contentType = '') {
  const extension = (String(filename).match(/\.([a-z0-9]{1,16})$/i)?.[1] || '').toLowerCase();
  const mime = String(contentType || '').toLowerCase();
  if (extension === 'pdf' || mime.includes('application/pdf')) return { extension: 'PDF', label: 'PDF', icon: 'pdf', kind: 'pdf' };
  if (['doc', 'docx', 'rtf', 'odt'].includes(extension) || mime.includes('word') || mime.includes('document')) return { extension: extension.toUpperCase() || 'DOC', label: 'Documento', icon: 'document', kind: 'document' };
  if (['ppt', 'pptx', 'odp'].includes(extension) || mime.includes('presentation') || mime.includes('powerpoint')) return { extension: extension.toUpperCase() || 'PPT', label: 'Presentación', icon: 'presentation', kind: 'presentation' };
  if (['zip', 'rar', '7z', 'tar', 'gz', 'bz2', 'xz', 'zst', 'cab', 'jar'].includes(extension) || mime.includes('zip') || mime.includes('compressed')) return { extension: extension.toUpperCase() || 'ZIP', label: 'Archivo comprimido', icon: 'archive', kind: 'archive' };
  if (['iso', 'img', 'vhd', 'vhdx'].includes(extension) || mime.includes('iso') || mime.includes('disk')) return { extension: extension.toUpperCase() || 'ISO', label: 'Imagen de disco', icon: 'disc', kind: 'disc' };
  if (['exe', 'msi', 'msix', 'appx', 'appxbundle'].includes(extension) || mime.includes('executable') || mime.includes('msdownload')) return { extension: extension.toUpperCase() || 'EXE', label: 'Aplicación', icon: 'package', kind: 'package' };
  if (['jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp', 'svg', 'avif'].includes(extension) || mime.startsWith('image/')) return { extension: extension.toUpperCase() || 'IMG', label: 'Imagen', icon: 'image', kind: 'image' };
  if (['mp3', 'm4a', 'wav', 'flac', 'ogg', 'opus'].includes(extension) || mime.startsWith('audio/')) return { extension: extension.toUpperCase() || 'AUDIO', label: 'Audio', icon: 'audio', kind: 'audio' };
  if (['mp4', 'mkv', 'webm', 'mov', 'avi'].includes(extension) || mime.startsWith('video/')) return { extension: extension.toUpperCase() || 'VIDEO', label: 'Vídeo', icon: 'video', kind: 'video' };
  return { extension: extension.toUpperCase() || 'FILE', label: 'Archivo', icon: 'file', kind: 'generic' };
}

function httpFileVisual(descriptor) {
  return `<div class="http-file-visual file-${escapeHtml(descriptor.kind)}" role="img" aria-label="${escapeHtml(descriptor.label)}"><span class="http-file-sheet"><img class="http-file-sheet-image" src="./assets/http-file-sheet.png" alt="" aria-hidden="true" draggable="false"><b>${escapeHtml(descriptor.extension)}</b></span></div>`;
}

function httpFilenameForQueue() {
  const directName = String(state.direct?.filename || 'descarga').trim() || 'descarga';
  const requested = String(state.filename || '').trim();
  if (!requested) return directName;
  if (/\.[a-z0-9]{1,16}$/i.test(requested) || !/\.[a-z0-9]{1,16}$/i.test(directName)) return requested;
  const extension = directName.match(/\.([a-z0-9]{1,16})$/i)?.[1] || '';
  return extension ? `${requested}.${extension}` : requested;
}

function httpCompactStateMarkup() {
  if (state.busy) {
    return `<section class="http-compact-state is-analyzing" aria-live="polite"><div class="http-state-icon"><span class="spinner"></span></div><div><small>ANALIZANDO</small><h2>Comprobando el archivo</h2><p>${escapeHtml(state.phase || 'Resolviendo el recurso y sus metadatos…')}</p></div></section>`;
  }
  if (state.error) {
    return `<section class="http-compact-state is-error" aria-live="assertive"><div class="http-state-icon">${icon('shield', 28)}</div><div class="http-state-copy"><small>NO DISPONIBLE</small><h2>No se pudo preparar este enlace</h2><p>${escapeHtml(state.error)}</p><div class="http-state-actions"><button type="button" class="btn" data-action="retry-analysis">Reintentar análisis</button><button type="button" class="btn" data-action="close">Cancelar</button></div></div></section>`;
  }
  if (!state.direct) {
    return `<section class="http-compact-state is-analyzing" aria-live="polite"><div class="http-state-icon">${icon('link', 28)}</div><div><small>PREPARACIÓN HTTP</small><h2>Esperando el archivo</h2><p>El análisis comenzará automáticamente.</p></div></section>`;
  }
  const direct = state.direct;
  const descriptor = direct.descriptor || directFileDescriptor(direct.filename, direct.contentType);
  const contentLength = Number(direct.contentLength || 0);
  const knownSize = contentLength > 0 ? formatBytes(contentLength) : '';
  const sizeMarkup = knownSize ? `<span class="http-file-size">${escapeHtml(knownSize)}</span>` : '';
  const destinationLabel = displayWindowsPath(state.destination);
  const destination = `<div class="http-compact-control"><span class="http-field-label">Guardar en</span><div class="control split"><span data-role="destination-path" title="${escapeHtml(destinationLabel)}">${escapeHtml(destinationLabel)}</span><button type="button" class="btn" data-action="change-folder">Cambiar</button></div></div>`;
  return `<section class="http-compact-ready">
    <div class="http-file-anchor">${httpFileVisual(descriptor)}${sizeMarkup}</div>
    <div class="http-compact-fields"><label class="http-compact-control"><span class="http-field-label">Nombre</span><div class="control"><input data-role="filename" aria-label="Nombre del archivo" value="${escapeHtml(state.filename || direct.filename)}" maxlength="180" autocomplete="off"></div></label>${destination}</div>
    <div class="http-compact-actions"><button type="button" class="btn" data-action="close">Cancelar</button><button type="button" class="btn primary strong" data-action="download" ${state.busy || state.submitted || state.error ? 'disabled' : ''}>Iniciar descarga</button></div>
  </section>`;
}

function directMarkup() {
  const destinationLabel = displayWindowsPath(state.destination);
  const destination = `<div class="control split"><span data-role="destination-path" title="${escapeHtml(destinationLabel)}">${escapeHtml(destinationLabel)}</span><button type="button" class="btn" data-action="change-folder">Cambiar</button></div>`;
  const filename = state.direct?.filename || 'Descarga';
  const extension = (filename.match(/\.([a-z0-9]{1,10})$/i)?.[1] || 'FILE').toUpperCase();
  let domain = platformInfo(state.source)[1];
  try { domain = new URL(state.direct?.url || state.source).hostname; } catch {}
  return `<div class="http-layout">
    <article class="panel accent-rail http-info"><div class="file-hero"><div class="file-poster"><div class="file-sheet" data-role="file-ext">.${escapeHtml(extension)}</div></div><div><div class="eyebrow">ARCHIVO DISPONIBLE</div><h2 class="file-title" data-role="file-name">${escapeHtml(filename)}</h2><div class="file-domain">${escapeHtml(domain)}</div></div></div>
      <div class="file-facts"><div class="fact"><span>Tipo de archivo</span><strong data-role="file-type">${escapeHtml(state.direct?.contentType || 'Archivo directo')}</strong></div><div class="fact"><span>Protocolo</span><strong>HTTPS/HTTP</strong></div><div class="fact"><span>Estado</span><strong>Listo para descargar</strong></div></div><div class="http-note">Se descargará como archivo original.</div></article>
    <article class="panel http-destination"><div class="panel-head"><div class="icon-box" data-role="destination-icon">${icon('folder')}</div><div><div class="panel-kicker">DESTINO</div><h3>Destino y opciones</h3></div></div><label class="field-group"><span class="field-label">Guardar en</span>${destination}</label><label class="field-group"><span class="field-label">Nombre del archivo</span><div class="control"><input data-role="filename" aria-label="Nombre del archivo" value="${escapeHtml(state.filename)}" placeholder="Automático (nombre original)" maxlength="180" autocomplete="off"></div></label></article>
  </div>`;
}

function playlistMarkup() {
  const selected = selectedItems();
  const unresolved = state.items.filter((item) => !item.sourceUrl || (item.resolutionState && !['ready', 'download_queued', 'completed'].includes(item.resolutionState))).length;
  const destinationLabel = displayWindowsPath(state.destination);
  const destination = `<div class="control split"><span data-role="destination-path" title="${escapeHtml(destinationLabel)}">${escapeHtml(destinationLabel)}</span><button type="button" class="btn" data-action="change-folder">Cambiar</button></div>`;
  const allSelected = selected.length === state.items.length && state.items.length > 0;
  return `<div class="playlist-layout"><article class="panel accent-rail playlist-main"><div class="playlist-summary"><div class="playlist-cover">${playlistPrepLogo(24)}<span class="count-badge">${state.items.length}</span></div><div><div class="eyebrow">PLAYLIST</div><h2 class="playlist-title">${escapeHtml(state.analysis?.title || 'Playlist')}</h2><div class="playlist-meta">${escapeHtml(state.analysis?.creator || 'Origen multimedia')} · ${state.items.length} elementos</div></div><div class="selection-count"><strong data-role="selected-count">${selected.length} / ${state.items.length}</strong><span>seleccionados</span></div></div><button type="button" class="select-all" data-action="select-all" aria-pressed="${allSelected}"><span class="check ${allSelected ? 'on' : ''}" data-role="select-all-check">${allSelected ? icon('check', 14) : ''}</span><span>${allSelected ? 'Todo seleccionado' : 'Seleccionar todo'}</span></button>${playlistListMarkup()}</article><aside class="panel playlist-side"><div class="panel-head"><div class="icon-box" data-role="side-icon">${icon('settings')}</div><div><div class="panel-kicker">OPCIONES</div><h3>Opciones comunes</h3></div></div><label class="field-group"><span class="field-label">Formato</span><div class="control"><select data-role="playlist-format">${playlistFormatOptions()}</select>${icon('chevron-down')}</div></label><label class="field-group"><span class="field-label">Guardar en</span>${destination}</label><div class="summary-box"><div><span>Elementos seleccionados</span><strong data-role="selected-summary">${selected.length} de ${state.items.length}</strong></div><div><span>Estado</span><strong>Listo para descargar</strong></div></div></aside></div>`;
}

function render() {
  const isPlaylist = state.kind === 'playlist' || state.analysis?.kind === 'playlist';
  const isDirect = Boolean(state.direct) && !isPlaylist;
  if (!isPlaylist && !isDirect && state.analysis) chooseFormat();
  const confirmBlocked = state.busy || state.submitted || Boolean(state.error) || Boolean(state.formatError) || (!state.analysis && !state.direct) || (isPlaylist && !selectedItems().length);
  const title = isHttpPreparation
    ? 'Preparar descarga HTTP'
    : isPlaylist
      ? 'Preparar playlist'
      : isDirect
        ? 'Preparar descarga HTTP'
        : 'Preparar contenido multimedia';
  const httpCompact = isHttpPreparation;
  const brandIconVariant = iconVariantForColor(state.appearance?.accent || loadStoredAppearance().accent);
  const body = httpCompact
    ? httpCompactStateMarkup()
    : state.error
    ? `<section class="state-message"><strong>${escapeHtml(state.error)}</strong><button type="button" class="btn" data-action="retry-analysis">Reintentar análisis</button></section>`
    : !state.analysis && !state.direct
      ? `<section class="state-message">${icon('link')}<h2>Preparar una descarga</h2><p>Pega un enlace multimedia, playlist o archivo directo y pulsa Analizar.</p></section>`
      : isPlaylist ? playlistMarkup() : isDirect ? directMarkup() : mediaMarkup();
  const confirmLabel = isPlaylist ? `Descargar ${selectedItems().length} seleccionados` : isDirect ? 'Iniciar descarga' : 'Descargar';
  const titlebar = `<header class="titlebar" data-tauri-drag-region><div class="titlebar-left" data-tauri-drag-region><img class="cdm-brand-logo" data-cdm-brand-logo data-brand-icon-base="./assets/brand" src="./assets/brand/clear-download-manager-${brandIconVariant}.png" alt="Clear Download Manager"><span>${title} - Clear Download Manager</span></div><div class="window-buttons">${httpCompact ? '' : `<button type="button" data-action="maximize" aria-label="Maximizar/restaurar" title="Maximizar/restaurar">${icon('maximize')}</button>`}<button type="button" data-action="close" aria-label="Cerrar" title="Cerrar">${icon('x')}</button></div></header>`;
  if (httpCompact) {
    root.innerHTML = `<section class="app-window http-compact-window" data-window-type="http" aria-labelledby="window-title">${titlebar}<main class="content http-compact-content"><h1 id="window-title" class="visually-hidden">${title}</h1>${body}</main></section>`;
  } else {
    const footerStatus = state.busy ? 'Analizando contenido' : state.error ? 'No se puede confirmar esta fuente' : 'Listo para confirmar';
    root.innerHTML = `<section class="app-window" data-window-type="${isPlaylist ? 'playlist' : 'multimedia'}" aria-labelledby="window-title">${titlebar}<section class="page-header"><div class="header-icon" data-role="header-icon">${isPlaylist ? playlistPrepLogo(24) : icon('download', 20)}</div><div class="header-copy"><div class="eyebrow">CLEAR DOWNLOAD MANAGER · CENTRO DE DESCARGAS</div><h1 id="window-title">${title}</h1></div></section><form class="url-row" data-role="source-form"><div>${platformLogo(state.source)}</div><input class="url-input" data-role="url" value="${escapeHtml(state.source)}" placeholder="Pega un enlace multimedia, playlist o archivo directo" aria-label="Enlace de descarga"><button type="submit" class="btn" data-action="analyze" ${state.busy ? 'disabled' : ''}>${state.busy ? 'Analizando…' : 'Analizar'}</button></form><main class="content" style="position:relative">${body}<div class="loading-overlay" data-role="loading-overlay" ${state.busy ? '' : 'hidden'}><div class="loading-card"><div class="spinner"></div><strong data-role="loading-title">${escapeHtml(state.phase)}</strong><span data-role="loading-detail">Espera a que termine el análisis para confirmar la descarga.</span></div></div></main><footer class="footer"><div class="status"><span class="status-dot"></span><span>${footerStatus}</span></div><div class="actions"><button type="button" class="btn" data-action="close">Cerrar</button><button type="button" class="btn primary strong" data-action="download" ${confirmBlocked ? 'disabled' : ''}>${confirmLabel}</button></div></footer></section>`;
  }
  // HTTP and multimedia renderers share the same runtime catalog.  Applying
  // it after either branch prevents compact HTTP states from retaining the
  // legacy Spanish labels while a window is rebuilt.
  localizeDom(root, resolveLocale(loadLocale()));
  root.querySelector('.app-dot')?.remove();
  bindSubwindowThumbnailLifecycle();
  const titlebarNode = root.querySelector('.titlebar');
  titlebarNode?.addEventListener('pointerdown', (event) => {
    if (event.button !== 0 || event.target.closest('button, input, select, a, [data-action]')) return;
    event.preventDefault();
    void invoke('preparation_window_start_dragging', { label: windowLabel }).catch(() => {});
  });
  titlebarNode?.addEventListener('dblclick', (event) => {
    if (httpCompact) return;
    if (event.target.closest('button, input, select, a, [data-action]')) return;
    event.preventDefault();
    void invoke('preparation_window_action', { label: windowLabel, action: 'maximize' }).catch(() => {});
  });
  document.querySelectorAll('[data-action="preview"]').forEach((node) => {
    node.tabIndex = 0;
    const openMediaPreview = () => {
      if (node.dataset.previewOpening === '1' || !state.source || !state.analysis || state.busy) return;
      node.dataset.previewOpening = '1';
      void invoke('open_online_media_player', { url: state.source }).catch(showError).finally(() => { delete node.dataset.previewOpening; });
    };
    node.onclick = openMediaPreview;
    node.onkeydown = (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); openMediaPreview(); } };
  });
  if (isPlaylist && !state.busy && !state.error) bindVirtualList();
}

function paintRow(itemId) {
  const row = document.querySelector(`[data-track-id="${CSS.escape(String(itemId))}"]`);
  const item = state.items.find((entry) => String(entry.id) === String(itemId));
  if (!row || !item) return;
  row.classList.toggle('selected', Boolean(item.selected));
  row.classList.toggle('is-selected', Boolean(item.selected));
  row.setAttribute('aria-selected', String(Boolean(item.selected)));
  const check = row.querySelector('.track-check');
  const input = row.querySelector('[data-role="item-check"]');
  if (input) input.checked = Boolean(item.selected);
  if (check) {
    check.classList.toggle('on', Boolean(item.selected));
    const visual = check.querySelector('span');
    if (visual) visual.innerHTML = item.selected ? icon('check', 14) : '';
    check.setAttribute('aria-label', `${item.selected ? 'Excluir' : 'Incluir'} ${item.title}`);
  }
}

function paintSummary() {
  const selected = selectedItems().length;
  document.querySelectorAll('[data-role="selected-count"]').forEach((element) => { element.textContent = `${selected} / ${state.items.length}`; });
  document.querySelectorAll('[data-role="selected-summary"]').forEach((element) => { element.textContent = `${selected} de ${state.items.length}`; });
  const submit = document.querySelector('[data-action="download"]');
  if (submit) submit.disabled = state.busy || Boolean(state.error) || !selectedItems().length;
  const selectAll = document.querySelector('[data-action="select-all"]');
  const allSelected = selected === state.items.length && state.items.length > 0;
  if (selectAll) { selectAll.setAttribute('aria-pressed', String(allSelected)); selectAll.innerHTML = `<span class="check ${allSelected ? 'on' : ''}" data-role="select-all-check">${allSelected ? icon('check', 14) : ''}</span><span>${allSelected ? 'Todo seleccionado' : 'Seleccionar todo'}</span>`; }
}

function bindSubwindowThumbnailLifecycle() {
  root.querySelectorAll('img[data-role="thumbnail"], img[data-role="track-thumbnail"]').forEach((image) => {
    if (image.dataset.thumbnailLifecycleBound === '1') return;
    image.dataset.thumbnailLifecycleBound = '1';
    const markLoaded = () => {
      image.classList.add('loaded');
      image.dataset.thumbnailState = 'loaded';
    };
    const markFailed = () => {
      if (image.dataset.thumbnailPlaceholder === '1' || image.dataset.thumbnailFallback === '1') {
        image.classList.add('loaded', 'is-fallback');
        image.dataset.thumbnailState = 'failed';
        return;
      }
      image.dataset.thumbnailFallback = '1';
      image.dataset.thumbnailPlaceholder = '1';
      image.src = './media-preview.svg';
    };
    image.addEventListener('load', markLoaded, { signal: abortController.signal });
    image.addEventListener('error', markFailed, { signal: abortController.signal });
    if (image.complete) {
      if (image.naturalWidth > 0) markLoaded();
      else markFailed();
    }
  });
}

function renderVisibleRows() {
  const list = document.querySelector('[data-role="track-scroll"]');
  const content = document.querySelector('[data-role="track-content"]');
  if (!list || !content) return;
  const columns = 2;
  // V5 track pitch is the fixed card height plus the grid gap. Keeping this
  // measured pitch preserves the two-column virtualizer without inflating
  // the visible grid or changing selection/scroll semantics.
  const compact = list.clientWidth < 720;
  const scale = Number.parseFloat(getComputedStyle(document.querySelector('#subwindow-root')).getPropertyValue('--ui-scale')) || 1;
  const cardHeight = compact ? 92.875 : 101.875;
  const rowGap = 10 * scale;
  state.rowHeight = (cardHeight + 10) * scale;
  const startRow = Math.max(0, Math.floor(list.scrollTop / state.rowHeight) - 2);
  const endRow = startRow + Math.ceil(list.clientHeight / state.rowHeight) + 5;
  const start = startRow * columns;
  const end = Math.min(state.items.length, endRow * columns);
  const totalRows = Math.max(1, Math.ceil(state.items.length / columns));
  content.style.setProperty('--track-columns', String(columns));
  content.style.height = `${Math.max(0, totalRows * state.rowHeight - rowGap)}px`;
  content.style.paddingTop = `${startRow * state.rowHeight}px`;
  content.style.paddingBottom = `${Math.max(0, (totalRows - endRow) * state.rowHeight)}px`;
  if (state.visibleStart === start && state.visibleEnd === end && state.visibleColumns === columns && content.childElementCount) return;
  state.visibleStart = start; state.visibleEnd = end; state.visibleColumns = columns;
  content.innerHTML = state.items.slice(start, end).map((item, offset) => playlistRow(item, start + offset)).join('');
  bindSubwindowThumbnailLifecycle();
  content.querySelectorAll('img[data-track-thumb-key]').forEach((image) => {
    image.addEventListener('error', () => { image.src = './media-preview.svg'; image.classList.add('is-fallback'); }, { once: true, signal: abortController.signal });
  });
}

function bindVirtualList() {
  state.listController?.abort();
  state.listController = new AbortController();
  const list = document.querySelector('[data-role="track-scroll"]');
  if (!list) return;
  list.addEventListener('scroll', () => { renderVisibleRows(); }, { passive: true, signal: state.listController.signal });
  list.addEventListener('wheel', (event) => { if (list.scrollHeight > list.clientHeight) event.stopPropagation(); }, { passive: true, signal: state.listController.signal });
  window.addEventListener('resize', () => { state.visibleStart = -1; renderVisibleRows(); }, { passive: true, signal: state.listController.signal });
  renderVisibleRows();
}

function sourceLooksPlaylist(value) { return /[?&](?:list|playlist|album)=|\/playlist(?:[/?]|$)/i.test(String(value || '')); }

function friendlyAnalysisError(error, source = state.source) {
  const raw = String(error?.message || error || '').trim();
  const isTikTok = /tiktok\.com|\/tiktok\b/i.test(String(source || ''));
  if (/could not copy .*cookie|failed to copy .*cookie|cookie database|base de cookies/i.test(raw)) {
    return 'No se pudo abrir la sesión de cookies del navegador. Se intentó continuar sin cookies; si la plataforma exige una sesión, cierra Brave/Chrome o configura un archivo Netscape en Ajustes y vuelve a analizar.';
  }
  if (/html_direct_unsupported/i.test(raw)) {
    return 'El enlace devolvió una página web, no el archivo solicitado. Busca el botón de descarga de la página y copia el enlace directo del archivo.';
  }
  if (isTikTok && /unexpected response|webpage request|yt-dlp|github\.com\/yt-dlp/i.test(raw)) {
    return 'TikTok no pudo entregar los metadatos en este momento. Comprueba que el video sea publico y vuelve a intentarlo.';
  }
  return raw.length > 700 ? `${raw.slice(0, 700)}…` : raw || 'No se pudo analizar el enlace.';
}

function normalizeDirectInspection(result) {
  const filename = result?.suggested_filename || 'descarga';
  state.direct = {
    filename,
    url: result?.normalized_url || state.source,
    contentType: result?.content_type || '',
    contentLength: Number(result?.content_length || 0) || null,
    host: result?.host || '',
    descriptor: directFileDescriptor(filename, result?.content_type || '')
  };
  state.analysis = null;
  state.kind = 'direct';
  if (!state.filenameTouched) state.filename = '';
}

async function analyzeSource() {
  const source = String(state.source || '').trim();
  if (!source) return;
  state.closeRequested = false;
  const requestId = state.analysisRequestId + 1;
  state.analysisRequestId = requestId;
  state.activeAnalysisRequestId = requestId;
  state.sizeGeneration += 1;
  state.sizeQueue = [];
  state.sizeActive = 0;
  state.error = '';
  state.analysis = null;
  state.direct = null;
  state.busy = true;
  state.phase = 'Analizando la fuente…';
  render();
  const generation = state.sizeGeneration;
  try {
    if (isSpotifyUrl(source)) throw new Error('Spotify está desactivado temporalmente en esta versión.');
    const inspected = await invoke('inspect_download_url', { url: source });
    const inspectedContentType = String(inspected?.content_type || '').toLowerCase();
    const inspectedIsHtml = inspected?.kind === 'html_page'
      || inspectedContentType.includes('text/html')
      || inspectedContentType.includes('application/xhtml');
    if (inspectedIsHtml) throw new Error('html_direct_unsupported');
    const shouldResolveMedia = !isHttpPreparation && (
      inspected?.requires_media_resolver
      || inspected?.kind === 'media'
      || inspected?.kind === 'generic_url'
      || sourceLooksPlaylist(source)
    );
    if (shouldResolveMedia) {
      state.phase = sourceLooksPlaylist(source) ? 'Analizando elementos de la playlist…' : 'Resolviendo metadatos multimedia…';
      const media = await invokeMediaAnalysisWithRetry(inspected?.normalized_url || source, generation, requestId);
      if (!analysisIsCurrent(requestId, generation)) return;
      state.analysis = media;
      state.kind = media?.kind === 'playlist' ? 'playlist' : 'media';
      state.title = String(media?.title || 'Contenido multimedia');
      state.creator = String(media?.creator || 'Origen multimedia');
      state.outputMode = state.kind === 'playlist' ? 'playlist' : state.outputMode;
      state.items = Array.isArray(media?.items) ? media.items.slice(0, 500).map(mapPlaylistItem) : [];
      state.busy = false;
      render();
      if (state.kind === 'playlist') startSizeAnalysis(generation);
      return;
    }
    if (!analysisIsCurrent(requestId, generation)) return;
    normalizeDirectInspection(inspected);
  } catch (error) {
    if (analysisIsCurrent(requestId, generation)) state.error = friendlyAnalysisError(error, source);
  } finally {
    if (analysisIsCurrent(requestId, generation)) {
      state.busy = false;
      if (state.error) render();
      else if (state.direct) render();
    }
  }
}

function selectedFormatForItem(result) {
  const formats = Array.isArray(result?.formats) ? result.formats : [];
  const label = normalizedFormatLabel(state.playlistFormat);
  if (label.includes('m4a')) return formats.find((format) => /m4a/i.test(`${format.ext || ''} ${format.label || ''}`)) || formats.find((format) => format.audio_only);
  if (label.includes('video')) return formats.find((format) => !format.audio_only && /1080|mejor|best/i.test(`${format.id || ''} ${format.label || ''}`)) || formats.find((format) => !format.audio_only);
  return formats.find((format) => format.audio_only) || formats[0];
}

async function pumpSizeAnalysis(generation) {
  if (generation !== state.sizeGeneration) return;
  while (state.sizeActive < 2 && state.sizeQueue.length) {
    const item = state.items.find((entry) => entry.id === state.sizeQueue.shift());
    if (!item || !item.selected || !item.sourceUrl) continue;
    const url = item.selectedSourceUrl || item.sourceUrl;
    if (isSpotifyUrl(url)) { item.sizeStatus = 'unknown'; continue; }
    item.sizeStatus = 'analyzing'; state.sizeActive += 1; paintRow(item.id); paintSummary();
    const cached = analysisCache.get(url);
    const task = cached
      ? Promise.resolve(cached)
      : invokeMediaAnalysisWithRetry(url, generation).then((result) => {
        if (result) analysisCache.set(url, result);
        return result;
      });
    task.then((result) => {
      if (generation !== state.sizeGeneration) return;
      const format = selectedFormatForItem(result);
      item.filesize = Number(format?.filesize || 0) || null;
      item.filesizeEstimated = Boolean(format?.filesize_estimated) || /mp3|opus/i.test(state.playlistFormat);
      item.sizeStatus = item.filesize ? 'known' : 'unknown';
    }).catch(() => { if (generation === state.sizeGeneration) item.sizeStatus = 'unknown'; }).finally(() => {
      if (generation === state.sizeGeneration) {
        state.sizeActive = Math.max(0, state.sizeActive - 1);
        paintRow(item.id); paintSummary(); window.setTimeout(() => pumpSizeAnalysis(generation), 80);
      }
    });
  }
}

function startSizeAnalysis(generation = state.sizeGeneration) {
  state.sizeGeneration = generation;
  state.sizeQueue = state.items.filter((item) => item.selected && item.sourceUrl && item.sizeStatus !== 'known').map((item) => item.id);
  window.setTimeout(() => pumpSizeAnalysis(generation), 150);
}

async function chooseDestination() {
  if (previewMode) return;
  try {
    const value = await chooseDestinationDirectory(invoke);
    if (value) {
      state.destination = String(value);
      const label = displayWindowsPath(state.destination);
      document.querySelectorAll('[data-role="destination-path"]').forEach((node) => { node.textContent = label; node.title = label; });
    }
  } catch (error) { showError(error); }
}

function showError(error) {
  state.error = friendlyAnalysisError(error, state.source);
  state.busy = false;
  state.submitted = false;
  render();
}

async function confirmDownload() {
  const isPlaylist = state.kind === 'playlist' || state.analysis?.kind === 'playlist';
  if (state.busy || state.submitted || state.error || (!state.analysis && !state.direct) || (isPlaylist && !selectedItems().length)) return;
  if (!isPlaylist && !state.direct && state.selectedFormat) {
    const requested = mediaFormats().find((candidate) => String(candidate.id || '') === String(state.selectedFormat));
    if (!requested || outputModeIsAudio() !== Boolean(requested.audio_only)) {
      state.formatError = 'Selecciona un formato y calidad compatibles.';
      render();
      return;
    }
  }
  state.formatError = '';
  const format = !isPlaylist && !state.direct ? chooseFormat() : null;
  if (!isPlaylist && !state.direct && (!format || outputModeIsAudio() !== Boolean(format.audio_only))) {
    state.formatError = state.formatError || 'Selecciona una calidad disponible.';
    render();
    return;
  }
  state.submitted = true;
  state.busy = true; state.phase = 'Enviando al pipeline local…'; render();
  try {
    if (state.kind === 'playlist') {
      const items = selectedItems().map((item) => ({ sourceId: item.sourceId, sourceUrl: item.sourceUrl, metadataUrl: item.metadataUrl, spotifyUrl: item.spotifyUrl, selectedSourceUrl: item.selectedSourceUrl, resolutionState: item.resolutionState || 'ready', matchScore: item.matchScore || 0, providerId: item.providerId, title: item.title, creator: item.creator, thumbnail: item.thumbnail, durationLabel: item.durationLabel, expectedDurationSeconds: item.expectedDurationSeconds, isrc: item.isrc || '', album: item.album || '', albumArtist: item.albumArtist || '', releaseDate: item.releaseDate || '', trackNumber: item.trackNumber || null, discNumber: item.discNumber || null, explicit: Boolean(item.explicit) }));
      await invoke('queue_playlist_selection', { playlistTitle: state.analysis?.title || 'Playlist', items, format: state.playlistFormat });
    } else if (state.direct) {
      await invoke('queue_http_download', { url: state.direct.url, filename: httpFilenameForQueue(), extensionFilename: null, extensionMime: null, extensionExpectedExtension: null });
    } else {
      const selectedSelector = state.videoQuality !== 'best' && selectorHasUnsafeBestFallback(state.selectedFormat, state.videoQuality)
        ? videoSelectorForQuality(state.videoQuality)
        : (state.selectedFormat || format?.id || videoSelectorForQuality(state.videoQuality));
      await invoke('queue_media_download_secure', { url: state.source, title: state.analysis?.title || 'Contenido multimedia', thumbnail: state.analysis?.thumbnail || null, formatSelector: selectedSelector, outputMode: state.outputMode, expectedDurationSeconds: Number(state.analysis?.duration_seconds || 0) || null, filename: state.filename.trim() || null, useBraveCookies: Boolean(state.sessionConsent), cookiesPath: state.cookiesPath || null });
    }
    state.busy = false;
    // The preparation surface is only for choosing options. Once confirmed,
    // close it and reveal the real manager so there is no fake "sent" screen
    // and no extra click for the user.
    await invoke('preparation_window_action', { label: windowLabel, action: 'close' }).catch(() => {});
    await invoke('wake_main_window').catch(() => invoke('show_main_window').catch(() => {}));
  } catch (error) { showError(error); }
}

document.addEventListener('submit', (event) => { if (event.target.matches('[data-role="source-form"]')) { event.preventDefault(); state.source = String(event.target.querySelector('[data-role="url"]')?.value || '').trim(); void analyzeSource(); } }, { signal: abortController.signal });
document.addEventListener('click', (event) => {
  const actionNode = event.target.closest?.('[data-action]');
  const action = actionNode?.dataset.action;
  if (['maximize', 'close'].includes(action)) {
    if (action === 'close') {
      if (state.closeRequested) return;
      state.closeRequested = true;
      state.sizeGeneration += 1;
      state.analysisRequestId += 1;
      state.activeAnalysisRequestId = 0;
      state.sizeQueue = [];
      state.listController?.abort();
    }
    void invoke('preparation_window_action', { label: windowLabel, action }).catch(showError);
    return;
  }
  if (action === 'download') { void confirmDownload(); return; }
  if (action === 'retry-analysis') { void analyzeSource(); return; }
  if (action === 'change-folder') { void chooseDestination(); return; }
  if (action === 'preview-track') {
    const preview = actionNode;
    const item = state.items.find((entry) => String(entry.id) === String(preview.closest('[data-track-id]')?.dataset.trackId));
    if (item?.sourceUrl) { preview.disabled = true; void invoke('open_online_media_player', { url: item.sourceUrl }).catch(showError).finally(() => { preview.disabled = false; }); }
    return;
  }
  if (!actionNode) {
    const row = event.target.closest?.('[data-track-id]');
    if (row && !event.target.closest('button,input,.track-check')) {
      const input = row.querySelector('[data-role="item-check"]');
      if (input) {
        input.checked = !input.checked;
        input.dispatchEvent(new Event('change', { bubbles: true }));
      }
    }
    return;
  }
  if (action === 'select-all') {
    const selectAll = actionNode;
    const next = selectAll.getAttribute('aria-pressed') !== 'true';
    state.items.forEach((item) => { item.selected = next; });
    document.querySelectorAll('[data-track-id]').forEach((row) => {
      const item = state.items.find((entry) => String(entry.id) === String(row.dataset.trackId));
      row.classList.toggle('selected', Boolean(item?.selected)); row.classList.toggle('is-selected', Boolean(item?.selected));
      const input = row.querySelector('[data-role="item-check"]'); if (input) input.checked = Boolean(item?.selected);
      const visual = row.querySelector('.track-check'); if (visual) { visual.classList.toggle('on', Boolean(item?.selected)); visual.querySelector('span').innerHTML = item?.selected ? icon('check', 14) : ''; }
    });
    paintSummary(); if (next) startSizeAnalysis();
  }
}, { signal: abortController.signal });

document.addEventListener('keydown', (event) => {
  if (!['Enter', ' '].includes(event.key) || event.target.closest('button,input,.track-check')) return;
  const row = event.target.closest?.('[data-track-id]');
  if (!row) return;
  event.preventDefault();
  const input = row.querySelector('[data-role="item-check"]');
  if (input) {
    input.checked = !input.checked;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }
}, { signal: abortController.signal });

document.addEventListener('change', (event) => {
  if (event.target.matches('[data-role="item-check"]')) {
    const item = state.items.find((entry) => String(entry.id) === String(event.target.closest('[data-track-id]')?.dataset.trackId));
    if (item) { item.selected = event.target.checked; paintRow(item.id); paintSummary(); if (item.selected) startSizeAnalysis(); }
  }
  if (event.target.matches('[data-role="output"]')) { state.outputMode = event.target.value; state.selectedFormat = ''; state.formatError = ''; if (outputModeIsAudio()) state.videoQuality = 'best'; chooseFormat(); persistMediaDownloadPreferences(); render(); }
  if (event.target.matches('[data-role="quality"]')) {
    const formats = formatsForOutputMode();
    const candidate = formats.find((format) => String(format.id || '') === String(event.target.value || ''));
    if (!candidate || outputModeIsAudio() !== Boolean(candidate.audio_only)) { state.formatError = 'Selecciona un formato y calidad compatibles.'; render(); return; }
    state.formatError = '';
    state.selectedFormat = String(candidate.id || '');
    const option = event.target.selectedOptions?.[0];
    const selectedQuality = qualityFromText(`${option?.textContent || ''} ${event.target.value}`);
    if (selectedQuality !== 'best') {
      state.videoQuality = selectedQuality;
      if (!selectorMatchesQuality(state.selectedFormat, selectedQuality)) state.selectedFormat = videoSelectorForQuality(selectedQuality);
    }
    persistMediaDownloadPreferences();
  }
  if (event.target.matches('[data-role="playlist-format"]')) { state.playlistFormat = event.target.value; persistMediaDownloadPreferences(); state.sizeGeneration += 1; state.sizeActive = 0; state.items.forEach((item) => { if (item.sizeStatus !== 'unknown') item.sizeStatus = 'pending'; }); render(); startSizeAnalysis(state.sizeGeneration); }
}, { signal: abortController.signal });

document.addEventListener('input', (event) => {
  if (event.target.matches('[data-role="filename"]')) {
    state.filename = String(event.target.value || '').slice(0, 180);
    state.filenameTouched = true;
  }
}, { signal: abortController.signal });

window.addEventListener('beforeunload', () => {
  window.clearTimeout(subwindowEntryStartTimer);
  window.clearTimeout(subwindowEntryFinishTimer);
  state.sizeGeneration += 1;
  state.analysisRequestId += 1;
  state.activeAnalysisRequestId = 0;
  state.closeRequested = true;
  state.sizeQueue = [];
  state.listController?.abort();
  abortController.abort();
}, { once: true });

async function bootstrap() {
  void bindDestinationPickerState();
  applyAppearance(loadStoredAppearance(), { updateNativeIcon: false });
  await bindAppearanceSync({
    getAppearance: () => state.appearance || loadStoredAppearance(),
    onAppearance: (next) => { state.appearance = next; storeAppearanceLocally(next); applyAppearance(next, { updateNativeIcon: false }); applySubwindowLayoutTokens(); },
    onSystemTheme: () => { applyAppearance(state.appearance || loadStoredAppearance(), { updateNativeIcon: false }); applySubwindowLayoutTokens(); }
  });
  try { state.appearance = await invoke('get_appearance_settings'); applyAppearance(state.appearance || loadStoredAppearance(), { updateNativeIcon: false }); } catch { state.appearance = loadStoredAppearance(); }
  applySubwindowLayoutTokens();
  try {
    const session = await invoke('media_session_settings');
    state.sessionConsent = Boolean(session?.useBraveCookies);
    state.cookiesPath = String(session?.cookiesPath || '');
  } catch {}
  try { const settings = await invoke('desktop_settings'); if (settings?.downloads_dir) state.destination = settings.downloads_dir; } catch {}
  render();
  markSubwindowLifecycle('dom-rendered');
  // Preparation windows are created hidden. Ask the native owner to show the
  // window before starting the shell entry so the animation cannot be spent
  // entirely behind an invisible native surface. The bounded timer is only a
  // one-shot safety net for a failed/hung show request.
  armSubwindowEntryFailSafe();
  if (!previewMode) {
    await invoke('show_preparation_window', { label: windowLabel })
      .then(() => markSubwindowLifecycle('native-show'))
      .catch(() => markSubwindowLifecycle('native-show-failed'));
  } else {
    markSubwindowLifecycle('native-show-preview');
  }
  scheduleSubwindowEntry();
  if (state.source) await analyzeSource();
}

bootstrap().catch(showError);
