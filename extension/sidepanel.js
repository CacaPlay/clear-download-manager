import { fallbackThumbnail, resolveThumbnail } from './thumbnail-service.js';
import { canUseJobAction } from './sdk/compatibility.js';
import {appendDetectedLink,youtubeSelection} from './sdk/panel-features.js';
import { DEFAULT_ACCENT, brandAssetPath, effectiveAccent, iconAccentForAppearance, iconVariantForColor, accentPresentation, progressPalette, relativeLuminance as appearanceRelativeLuminance, contrastRatio as appearanceContrastRatio } from './sdk/appearance.js';
import { applyI18n, loadLocale, saveLocale, translate } from './i18n.js';

const port = chrome.runtime.connect({ name: 'cacatools-sidepanel' });
const $ = (selector) => document.querySelector(selector);
let extensionLocale = loadLocale();
let extensionLocaleApplying = false;
function localizeExtension() {
  if (extensionLocaleApplying) return;
  extensionLocaleApplying = true;
  try {
    const resolved = applyI18n(document, extensionLocale);
    document.documentElement.lang = resolved;
    const selector = $('#extension-locale');
    if (selector) selector.value = extensionLocale;
  } finally {
    extensionLocaleApplying = false;
  }
}
const t = (value) => translate(extensionLocale, value);
localizeExtension();
new MutationObserver(() => {
  if (!extensionLocaleApplying) window.queueMicrotask(localizeExtension);
}).observe(document.body, { childList: true, subtree: true, characterData: true });
const RUNTIME_RESPONSE_TIMEOUT_MS = 12000;
const EXT_DIAGNOSTICS = false;
const diagnostic = (...args) => { if (EXT_DIAGNOSTICS) console.warn('[CDM EXT DIAG]', ...args); };
function sendRuntimeRequest(message, timeoutMs = RUNTIME_RESPONSE_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = window.setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error(`Chrome runtime no respondió en ${timeoutMs} ms (${String(message?.type || 'mensaje')}).`));
    }, timeoutMs);
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      callback(value);
    };
    try {
      Promise.resolve(chrome.runtime.sendMessage(message))
        .then((value) => finish(resolve, value), (error) => finish(reject, error));
    } catch (error) {
      finish(reject, error);
    }
  });
}
const safe = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const HEX_COLOR = /^#[0-9a-f]{6}$/i;
// Keep the local helper names used by the extension visual contract while the
// implementation remains the single shared appearance authority.
const relativeLuminance = appearanceRelativeLuminance;
const contrastRatio = appearanceContrastRatio;
const readableAccent = (accent, theme) => accentPresentation(accent, theme).detail;
const readableInk = (accent, theme) => accentPresentation(accent, theme).ink;
const state = {
  detections: [], detectionState: 'analyzing', busy: false, notice: '', quickPreset: 'auto',
  windowMode: 'foreground', appearanceMode: 'follow-app', customTheme: 'dark', customAccent: DEFAULT_ACCENT,
  appState: { appearance: { theme: 'system', accent: DEFAULT_ACCENT, intensity: 82, motion: true, iconColorMode: 'accent', iconColor: '#596574', progressActive: '#00ff2a', progressCompleted: '#00ff2a', progressPaused: '#e2a93f', progressError: '#ef6674' }, jobs: [], queue: {}, updatedAt: 0 },
  collections: [], activeCollectionId: '', looseLinks: [], panelCollapsed: { downloads: false, links: false },
  updateAvailable: null, renderVersion: 0, showAllDownloads: false, contextJobId: null,
  bridge: null, appRunning: false, uncertainSend: false, detectionPage: '', detectionRenderKey: ''
};
function setConnectionStatus(stateName, visibleText, titleText = visibleText) {
  const node = $('#connection');
  if (!node) return;
  node.textContent = t(visibleText);
  node.dataset.state = stateName;
  node.title = t(titleText);
  node.setAttribute('aria-label', t(titleText));
}

const statusCopy = {
  analyzing: 'Analizando la pestaña activa…', media_found: 'Selecciona qué quieres enviar a Clear Download Manager.',
  no_media: 'No se detectó contenido multimedia compatible.', restricted_page: 'Chrome no permite analizar esta página.',
  permission_required: 'La página requiere permiso para analizarse.', detection_failed: 'No se pudo completar el análisis. Pulsa Actualizar para reintentar.',
  host_disconnected: 'Clear Download Manager no está disponible en este momento.', spotify_disabled: 'Spotify está desactivado temporalmente.'
};

function presetPreferences() {
  if (state.quickPreset === 'mp3' || state.quickPreset === 'm4a') return { preferredFormat: state.quickPreset, preferredQuality: 'auto' };
  return { preferredFormat: 'auto', preferredQuality: ['1080p', '720p'].includes(state.quickPreset) ? state.quickPreset : 'auto' };
}
function extensionFilenameMetadata(item, preferences) {
  const title = String(item?.title || item?.playlistTitle || '').trim().slice(0, 220);
  const expectedExtension = preferences.preferredFormat === 'mp3'
    ? 'mp3'
    : preferences.preferredFormat === 'm4a' || ['1080p', '720p'].includes(preferences.preferredQuality)
      ? (preferences.preferredFormat === 'm4a' ? 'm4a' : 'mp4')
      : '';
  const mime = preferences.preferredFormat === 'mp3'
    ? 'audio/mpeg'
    : preferences.preferredFormat === 'm4a'
      ? 'audio/mp4'
      : preferences.preferredQuality !== 'auto'
        ? 'video/mp4'
        : '';
  const hasExtension = expectedExtension && new RegExp(`\\.${expectedExtension}$`, 'i').test(title);
  return {
    filename: title && expectedExtension && !hasExtension ? `${title}.${expectedExtension}` : title,
    mime,
    expectedExtension
  };
}
function currentCollection() { return state.collections.find((entry) => entry.id === state.activeCollectionId) || null; }
function currentLinks() { return currentCollection()?.links || state.looseLinks; }
function safeImageUrl(value) {
  try {
    const url = new URL(String(value || '').trim());
    return ['http:', 'https:'].includes(url.protocol) ? url.href : '';
  } catch { return ''; }
}
const archiveDownloadExtensions = new Set(['zip', '7z', 'rar', 'tar', 'gz', 'bz2', 'xz', 'zst', 'cab', 'jar']);
const packageDownloadExtensions = new Set(['exe', 'msi', 'msix', 'appx', 'appxbundle', 'apk', 'deb', 'rpm', 'dmg']);
const diskDownloadExtensions = new Set(['iso', 'img', 'vhd', 'vhdx']);
const videoDownloadExtensions = new Set(['mp4', 'webm', 'mkv', 'mov', 'avi', 'm4v']);
const audioDownloadExtensions = new Set(['mp3', 'm4a', 'aac', 'wav', 'flac', 'ogg', 'opus']);
const documentDownloadExtensions = new Set(['doc', 'docx', 'odt', 'rtf']);
const pdfDownloadExtensions = new Set(['pdf']);
const ebookDownloadExtensions = new Set(['epub', 'mobi', 'azw', 'azw3']);
const sheetDownloadExtensions = new Set(['xls', 'xlsx', 'ods', 'csv']);
const presentationDownloadExtensions = new Set(['ppt', 'pptx', 'odp']);
const imageDownloadExtensions = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'avif', 'tif', 'tiff']);
const codeDownloadExtensions = new Set(['js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'rs', 'go', 'py', 'java', 'c', 'h', 'cpp', 'cs', 'css', 'html', 'json', 'xml', 'yaml', 'yml', 'toml', 'sh', 'ps1']);
const textDownloadExtensions = new Set(['txt', 'md', 'log', 'ini', 'cfg', 'srt', 'vtt']);
const fontDownloadExtensions = new Set(['ttf', 'otf', 'woff', 'woff2']);
const fileAssetTypes = new Set(['archive', 'document', 'ebook', 'package', 'torrent', 'font', 'text', 'sheet', 'code', 'image', 'disk', 'audio', 'video', 'pdf', 'presentation', 'playlist-prep', 'generic']);
function downloadFileExtension(job = {}) {
  const explicit = String(job.extension || '').trim().replace(/^\./, '').toLowerCase();
  if (/^[a-z0-9]{1,16}$/.test(explicit) && !['file', 'video', 'audio', 'media', 'playlist', 'torrent'].includes(explicit)) return explicit;
  const namedCandidates = [job.destination, job.outputPath, job.output_path, job.title];
  for (const candidate of namedCandidates) {
    const value = String(candidate || '').trim().split(/[?#]/)[0].replace(/\\/g, '/').split('/').pop() || '';
    const match = value.match(/\.([a-z0-9]{1,16})$/i);
    if (match) return match[1].toLowerCase();
  }
  const urlCandidates = [job.sourceUrl, job.source_url, job.finalUrl, job.final_url];
  for (const candidate of urlCandidates) {
    const value = String(candidate || '').trim().split(/[?#]/)[0].replace(/\\/g, '/').split('/').pop() || '';
    const match = value.match(/\.([a-z0-9]{1,16})$/i);
    if (match) return match[1].toLowerCase();
  }
  return '';
}
function downloadKind(job = {}) {
  const extension = downloadFileExtension(job);
  if (archiveDownloadExtensions.has(extension)) return 'archive';
  if (packageDownloadExtensions.has(extension)) return 'package';
  if (diskDownloadExtensions.has(extension)) return 'disk';
  if (videoDownloadExtensions.has(extension)) return 'video';
  if (audioDownloadExtensions.has(extension)) return 'audio';
  return ['video', 'audio', 'media'].includes(String(job.kind || '').toLowerCase()) ? String(job.kind).toLowerCase() : 'file';
}
function downloadAssetType(job = {}) {
  const extension = downloadFileExtension(job);
  if (archiveDownloadExtensions.has(extension)) return 'archive';
  if (documentDownloadExtensions.has(extension)) return 'document';
  if (ebookDownloadExtensions.has(extension)) return 'ebook';
  if (packageDownloadExtensions.has(extension)) return 'package';
  if (extension === 'torrent') return 'torrent';
  if (fontDownloadExtensions.has(extension)) return 'font';
  if (textDownloadExtensions.has(extension)) return 'text';
  if (sheetDownloadExtensions.has(extension)) return 'sheet';
  if (codeDownloadExtensions.has(extension)) return 'code';
  if (imageDownloadExtensions.has(extension)) return 'image';
  if (diskDownloadExtensions.has(extension)) return 'disk';
  if (audioDownloadExtensions.has(extension)) return 'audio';
  if (videoDownloadExtensions.has(extension)) return 'video';
  if (pdfDownloadExtensions.has(extension)) return 'pdf';
  if (presentationDownloadExtensions.has(extension)) return 'presentation';
  if (['playlist', 'playlist-prep'].includes(String(job.kind || job.type || '').toLowerCase())) return 'playlist-prep';
  const kind = downloadKind(job);
  return fileAssetTypes.has(kind) ? kind : 'generic';
}
function fileAssetMarkup(type) {
  const asset = fileAssetTypes.has(type) ? type : 'generic';
  const flat = asset === 'audio' ? `<i class="download-file-asset-flat" style="-webkit-mask-image:url('assets/file-types/audio-flat.png');mask-image:url('assets/file-types/audio-flat.png')"></i>` : '';
  return `<span class="download-file-asset" data-file-asset="${asset}" aria-hidden="true"><img class="download-file-asset-neutral" src="assets/file-types/${asset}-neutral.png" alt="" decoding="async"><i class="download-file-asset-accent" style="-webkit-mask-image:url('assets/file-types/${asset}-accent.png');mask-image:url('assets/file-types/${asset}-accent.png')"></i>${flat}</span>`;
}
function downloadCanPlay(job = {}) { return ['video', 'audio', 'media'].includes(downloadKind(job)); }
function parseUrls(value) {
  const matches = String(value || '').match(/https?:\/\/[^\s<>"']+/gi) || [];
  const result = [];
  for (const raw of matches) {
    try {
      const url = new URL(raw.replace(/[),.;]+$/, ''));
      if (!['http:', 'https:'].includes(url.protocol)) continue;
      url.hash = '';
      if (!result.includes(url.href)) result.push(url.href);
    } catch {}
  }
  return result.slice(0, 500);
}
function youtubeVideoId(value) {
  try {
    const parsed = new URL(value);
    const host = parsed.hostname.replace(/^www\./, '').toLowerCase();
    if (host === 'youtu.be') return parsed.pathname.split('/').filter(Boolean)[0] || '';
    return parsed.searchParams.get('v') || parsed.pathname.match(/^\/(?:shorts|embed|live)\/([\w-]{6,})/i)?.[1] || '';
  } catch { return ''; }
}
function linkTitle(url, index = 0) {
  try {
    const parsed = new URL(url);
    const videoId = youtubeVideoId(url);
    if (videoId) return `Vídeo de YouTube · ${videoId}`;
    const segment = decodeURIComponent(parsed.pathname.split('/').filter(Boolean).pop() || '').replace(/[-_]+/g, ' ').trim();
    return segment || parsed.hostname.replace(/^www\./, '') || `Enlace ${index + 1}`;
  } catch { return `Enlace ${index + 1}`; }
}
function linkThumbnail(url) { const id = youtubeVideoId(url); return id ? `https://i.ytimg.com/vi/${encodeURIComponent(id)}/mqdefault.jpg` : ''; }
function makeLink(url, index = 0) { return { id: crypto.randomUUID?.() || `${Date.now()}-${index}`, url, title: linkTitle(url, index), thumbnail: linkThumbnail(url), author: '', selected: true, addedAt: Date.now(), metadataResolved: false }; }
async function persistLinkState() {
  await chrome.storage.local.set({ manualLinkCollections: state.collections, activeManualCollectionId: state.activeCollectionId, looseManualLinks: state.looseLinks });
}
async function resolveManualLinkMetadata(entry) {
  if (!entry?.url || entry.metadataResolved) return false;
  try {
    const response = await chrome.runtime.sendMessage({ type: 'RESOLVE_LINK_METADATA', url: entry.url });
    if (response?.ok && response.metadata) {
      entry.title = String(response.metadata.title || entry.title || linkTitle(entry.url)).slice(0, 220);
      entry.thumbnail = safeImageUrl(response.metadata.thumbnail) || entry.thumbnail || linkThumbnail(entry.url);
      entry.author = String(response.metadata.author || '').slice(0, 120);
    }
  } catch {}
  entry.metadataResolved = true;
  return true;
}
async function enrichManualLinks(entries) {
  const pending = entries.filter((entry) => entry && !entry.metadataResolved).slice(0, 40);
  if (!pending.length) return;
  let changed = false;
  for (const entry of pending) changed = await resolveManualLinkMetadata(entry) || changed;
  if (changed) { await persistLinkState(); renderCollections(); }
}
function formatBytes(bytes) {
  const value = Number(bytes || 0); if (!value) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB']; let current = value; let unit = 0;
  while (current >= 1024 && unit < units.length - 1) { current /= 1024; unit += 1; }
  return `${current >= 100 ? current.toFixed(0) : current.toFixed(1)} ${units[unit]}`;
}
function formatRate(bytes) { const text = formatBytes(bytes); return text === '—' ? '—' : `${text}/s`; }
function formatEta(seconds) {
  const total = Number(seconds); if (!Number.isFinite(total) || total < 0) return '—';
  if (total < 60) return `${Math.round(total)} s`;
  if (total < 3600) return `${Math.floor(total / 60)} min`;
  return `${Math.floor(total / 3600)} h ${Math.floor((total % 3600) / 60)} min`;
}
function exactJobProgress(job = {}) {
  const total = Math.max(0, Number(job.totalBytes ?? job.total_bytes ?? 0) || 0);
  const downloaded = Math.max(0, Number(job.downloadedBytes ?? job.downloaded_bytes ?? 0) || 0);
  if (String(job.status) === 'completed') return 100;
  if (total > 0) return Math.max(0, Math.min(99.9, Math.min(downloaded, total) * 100 / total));
  return Math.max(0, Math.min(100, Number(job.progress || 0)));
}
function formatBytesCompact(bytes) {
  const value = Math.max(0, Number(bytes || 0));
  if (!value) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB']; let amount = value; let unit = 0;
  while (amount >= 1024 && unit < units.length - 1) { amount /= 1024; unit += 1; }
  return `${amount >= 100 ? amount.toFixed(0) : amount >= 10 ? amount.toFixed(1) : amount.toFixed(2)} ${units[unit]}`;
}
function transferSizeLabel(job = {}) {
  const downloaded = Math.max(0, Number(job.downloadedBytes ?? job.downloaded_bytes ?? 0) || 0);
  const total = Math.max(0, Number(job.totalBytes ?? job.total_bytes ?? 0) || 0);
  return total ? `${formatBytesCompact(Math.min(downloaded, total))} / ${formatBytesCompact(total)}` : formatBytesCompact(downloaded);
}
function statusLabel(status) {
  const source = ({ running: 'Descargando', queued: 'En cola', paused: 'Pausada', completed: 'Completada', failed: 'Error', cancelled: 'Cancelada' })[String(status)] || String(status || 'Pendiente');
  return t(source);
}
function applyAppearance() {
  const app = state.appState?.appearance || {};
  const followsApp = state.appearanceMode === 'follow-app';
  const theme = (followsApp ? (app.theme || 'dark') : state.customTheme) === 'light' ? 'light' : 'dark';
  const sourceAccent = HEX_COLOR.test(followsApp ? app.accent : state.customAccent) ? (followsApp ? app.accent : state.customAccent) : DEFAULT_ACCENT;
  const intensity = followsApp ? app.intensity : 82;
  const accent = effectiveAccent(sourceAccent, intensity, theme);
  const detail = readableAccent(accent, theme);
  const iconAccent = followsApp ? iconAccentForAppearance(app, theme) : accent;
  const progress=progressPalette(app);
  for(const [field,variable] of Object.entries({progressActive:'--progress-active',progressCompleted:'--progress-completed',progressPaused:'--progress-paused',progressError:'--progress-error'})) {
    document.documentElement.style.setProperty(variable,progress[field]);
  }
  $('#progress-sync-note').textContent=t(progress.synced?'Colores de progreso sincronizados con Clear Download Manager.':'La app instalada todavía no envía sus colores de progreso. Se muestran los valores predeterminados, no una sincronización personalizada.');
  document.body.dataset.theme = theme;
  document.documentElement.style.setProperty('--accent', accent);
  document.documentElement.style.setProperty('--accent-detail', detail);
  document.documentElement.style.setProperty('--accent-ink', readableInk(accent, theme));
  document.documentElement.style.setProperty('--icon-accent', iconAccent);
  const logo = $('#brand-logo');
  if (logo) {
    const variant = iconVariantForColor(sourceAccent);
    const path = brandAssetPath(variant);
    if (logo.getAttribute('src') !== path) logo.setAttribute('src', path);
    logo.alt = 'Clear Download Manager';
  }
  document.documentElement.dataset.motion = app.motion === false ? 'off' : 'on';
  $('#appearance-mode').value = state.appearanceMode;
  $('#custom-theme').value = state.customTheme;
  $('#custom-accent').value = state.customAccent;
  $('#custom-theme').disabled = state.appearanceMode === 'follow-app';
  $('#custom-accent').disabled = state.appearanceMode === 'follow-app';
}
function renderPanelState() {
  for (const name of ['downloads', 'links']) {
    const collapsed = Boolean(state.panelCollapsed[name]);
    const body = document.querySelector(`[data-panel-body="${name}"]`);
    const button = document.querySelector(`[data-toggle-panel="${name}"]`);
    if (body) body.hidden = collapsed;
    if (button) { button.textContent = t(collapsed ? 'Mostrar' : 'Ocultar'); button.setAttribute('aria-expanded', String(!collapsed)); }
  }
}
function renderUpdate() {
  const section = $('#extension-update');
  section.hidden = !state.updateAvailable;
  if (state.updateAvailable) $('#extension-update-version').textContent = t(`Versión ${state.updateAvailable.version || 'nueva'} descargada por Chrome`);
}
function renderDownloads() {
  $('#bridge-actions-note').textContent = t(state.bridge && !state.bridge.actions.includes('job_action') ? 'Este puente solo ofrece apertura en la app. Para reproducir, gestionar o eliminar desde aquí hace falta actualizar el puente nativo; no la extensión únicamente.' : '');
  const jobs = Array.isArray(state.appState?.jobs) ? state.appState.jobs : [];
  const active = jobs.filter((job) => ['running', 'queued', 'paused'].includes(job.status));
  const completed = jobs.filter((job) => ['completed', 'failed', 'cancelled'].includes(job.status));
  const completedCount = completed.filter((job) => job.status === 'completed').length;
  $('#download-summary').textContent = t(`${active.length} ${active.length === 1 ? 'activa' : 'activas'} · ${completedCount} ${completedCount === 1 ? 'completada' : 'completadas'}`);
  const target = $('#downloads-list');
  const all = [...active, ...completed];
  const more = $('#show-all-downloads');
  if (more) {
    more.hidden = all.length <= 4;
    more.textContent = t(state.showAllDownloads ? 'Ver menos' : `Ver más (${Math.max(0, all.length - 4)})`);
  }
  const visible = state.showAllDownloads ? all : all.slice(0, 4);
  if (!visible.length) {
    if (target.dataset.renderKey !== 'empty') { target.innerHTML = `<div class="download-empty">${safe(t('No hay descargas registradas todavía.'))}</div>`; target.dataset.renderKey = 'empty'; }
    return;
  }
  const renderKey = JSON.stringify(visible.map((job) => ({
    id: String(job.id), title: job.title || '', kind: downloadKind(job), extension: downloadFileExtension(job),
    thumbnail: job.thumbnail || '', status: String(job.status || 'queued')
  })));
  if (target.dataset.renderKey === renderKey) {
    for (const job of visible) {
      const row = [...target.querySelectorAll('[data-job-id]')].find((candidate) => candidate.dataset.jobId === String(job.id));
      if (!row) continue;
      const status = String(job.status || 'queued');
      const transfer = transferSizeLabel(job);
      const extension = downloadFileExtension(job);
      const detail = `${extension ? `${extension.toUpperCase()} · ` : ''}${transfer} · ${statusLabel(status)}${status === 'running' ? ` · ${formatRate(job.speedBps)} · ${formatEta(job.etaSeconds)}` : ''}`;
      const progress = exactJobProgress(job);
      const detailNode = row.querySelector('.download-copy small');
      const stateNode = row.querySelector('.download-state');
      const progressNode = row.querySelector('.download-progress i');
      const percentNode = row.querySelector('.download-progress b');
      if (detailNode) detailNode.textContent = detail;
      if (stateNode) stateNode.textContent = statusLabel(status);
      if (progressNode) progressNode.style.width = `${progress}%`;
      if (percentNode) percentNode.textContent = `${Math.round(progress)}%`;
    }
    return;
  }
  target.dataset.renderKey = renderKey;
  target.innerHTML = visible.map((job) => {
    const progress = exactJobProgress(job);
    const status = String(job.status || 'queued');
    const transfer = transferSizeLabel(job);
    const extension = downloadFileExtension(job);
    const kind = downloadKind(job);
    const detail = `${extension ? `${extension.toUpperCase()} · ` : ''}${transfer} · ${statusLabel(status)}${status === 'running' ? ` · ${formatRate(job.speedBps)} · ${formatEta(job.etaSeconds)}` : ''}`;
    const thumbnail = safeImageUrl(job.thumbnail);
    const thumb = thumbnail ? `<img src="${safe(thumbnail)}" alt="" loading="lazy">` : fileAssetMarkup(downloadAssetType(job));
    return `<article class="download-row kind-${safe(kind)}" data-job-id="${safe(job.id)}" tabindex="0" aria-label="${safe(job.title || t('Descarga'))}. ${safe(t('Menú contextual disponible'))}"><div class="download-thumb">${thumb}</div><div class="download-copy"><strong title="${safe(job.title)}">${safe(job.title || t('Descarga'))}</strong><small>${safe(detail)}</small></div><span class="download-state ${safe(status)}">${safe(statusLabel(status))}</span><button type="button" class="download-row-action" data-download-menu="${safe(job.id)}" aria-label="${safe(t('Acciones de '))}${safe(job.title || t('descarga'))}">⋯</button><div class="download-progress"><span><i style="width:${progress}%"></i></span><b>${Math.round(progress)}%</b></div></article>`;
  }).join('');
  target.querySelectorAll('.download-thumb img').forEach((image) => image.addEventListener('error', () => { image.replaceWith(Object.assign(document.createElement('span'), { className: 'download-file-mark', textContent: 'FILE' })); }, { once: true }));
}
function renderCollections() {
  const select = $('#collection-select');
  select.innerHTML = `<option value="">Enlaces sueltos (${state.looseLinks.length})</option>${state.collections.map((entry) => `<option value="${safe(entry.id)}" ${entry.id === state.activeCollectionId ? 'selected' : ''}>${safe(entry.name)} (${entry.links.length})</option>`).join('')}`;
  select.value = state.activeCollectionId || '';
  $('#leave-collection').disabled = !state.activeCollectionId;
  const collection = currentCollection();
  const links = currentLinks();
  $('#links-summary').textContent = collection ? `${collection.name} · ${links.length} enlaces` : `${links.length} enlaces sueltos`;
  $('#send-current-collection').textContent = collection ? 'Enviar playlist' : links.length > 1 ? 'Enviar como playlist' : 'Enviar enlace';
  $('#send-current-collection').disabled = !links.some((entry) => entry.selected);
  $('#clear-current-links').disabled = !links.length;
  const target = $('#manual-links-list');
  if (!links.length) { target.innerHTML = '<p class="muted">No hay enlaces en esta carpeta.</p>'; return; }
  target.innerHTML = links.map((entry) => { const thumbnail = safeImageUrl(entry.thumbnail); const artwork = thumbnail ? `<img src="${safe(thumbnail)}" alt="" loading="lazy">` : '<span>↗</span>'; const meta = [entry.author].filter(Boolean).join(' · '); return `<div class="manual-link"><input type="checkbox" data-link-select="${safe(entry.id)}" ${entry.selected ? 'checked' : ''} aria-label="Seleccionar enlace"><span class="manual-link-thumb">${artwork}</span><div class="manual-link-copy"><strong title="${safe(entry.title)}">${safe(entry.title || 'Enlace multimedia')}</strong>${meta ? `<small title="${safe(meta)}">${safe(meta)}</small>` : ''}</div><button type="button" data-link-remove="${safe(entry.id)}" aria-label="Eliminar enlace">×</button></div>`; }).join('');
  target.querySelectorAll('.manual-link-thumb img').forEach((image) => image.addEventListener('error', () => { image.replaceWith(Object.assign(document.createElement('span'), { textContent: '↗' })); }, { once: true }));
  target.querySelectorAll('[data-link-select]').forEach((input) => input.addEventListener('change', async () => {
    const item = links.find((entry) => entry.id === input.dataset.linkSelect); if (item) item.selected = input.checked;
    await persistLinkState(); renderCollections();
  }));
  target.querySelectorAll('[data-link-remove]').forEach((button) => button.addEventListener('click', async () => {
    const index = links.findIndex((entry) => entry.id === button.dataset.linkRemove); if (index >= 0) links.splice(index, 1);
    await persistLinkState(); renderCollections();
  }));
}
function detectionStructureKey(item) {
  return JSON.stringify({
    id: item?.id || '', type: item?.type || '', mediaUrl: item?.mediaUrl || '', canonicalUrl: item?.canonicalUrl || '',
    title: item?.title || '', author: item?.author || '', album: item?.album || '', duration: item?.duration || '',
    thumbnail: item?.thumbnail || '', thumbnailCandidates: item?.thumbnailCandidates || []
  });
}
function renderDetections() {
  const list = $('#list');
  const selected = state.detections.filter((item) => item.selected);
  const hasMedia = state.detectionState === 'media_found' && state.detections.length > 0;
  const hasVideo = state.detections.some((item) => item.type === 'video' && item.selected);
  const statusText = state.notice || statusCopy[state.detectionState] || statusCopy.detection_failed;
  $('#count').textContent = `${state.detections.length} elemento${state.detections.length === 1 ? '' : 's'} detectado${state.detections.length === 1 ? '' : 's'}`;
  $('#message').textContent = statusText;
  $('#send-current').disabled = !hasVideo || state.busy || !hasMedia;
  $('#select-all').disabled = !hasMedia;
  $('#select-all').checked = Boolean(hasMedia && selected.length === state.detections.length);
  if (!hasMedia) {
    const emptyKey = `empty:${statusText}`;
    if (list.dataset.renderKey !== emptyKey) { list.innerHTML = `<div class="empty">${safe(statusText)}</div>`; list.dataset.renderKey = emptyKey; }
    return;
  }
  const structureKey = JSON.stringify(state.detections.map(detectionStructureKey));
  if (list.dataset.renderKey === structureKey && list.children.length) {
    list.querySelectorAll('input[data-index]').forEach((input) => {
      const item = state.detections[Number(input.dataset.index)];
      input.checked = Boolean(item?.selected);
      input.closest('.item')?.classList.toggle('selected', Boolean(item?.selected));
    });
    return;
  }
  const previousScroll = list.scrollTop;
  const renderVersion = ++state.renderVersion;
  list.innerHTML = state.detections.map((item, index) => {
    const detectedMeta = [item.author, item.duration].filter(Boolean).join(' · ') || 'Canal no disponible';
    return `<div class="item ${item.selected ? 'selected' : ''}"><span class="detected-thumb-column"><span class="thumb-frame" data-thumb-index="${index}"><span class="thumb-skeleton"></span><img class="thumb" alt="" loading="lazy" hidden><span class="thumb-fallback" hidden>▶</span></span></span><span class="copy"><strong>${safe(item.title || 'Contenido multimedia')}</strong><small class="detected-meta">${safe(detectedMeta)}</small></span>${['video','audio'].includes(item.type)?`<button class="add-detected" type="button" data-add-detected="${index}" aria-label="Añadir ${safe(item.title || 'contenido')} a playlist manual" title="Añadir a playlist manual">+</button>`:''}</div>`;
  }).join('');
  list.dataset.renderKey = structureKey;
  list.scrollTop = previousScroll;
  list.querySelectorAll('input[data-index]').forEach((input) => input.addEventListener('change', () => { const item = state.detections[Number(input.dataset.index)]; if (item) item.selected = input.checked; renderDetections(); }));
  list.querySelectorAll('[data-add-detected]').forEach(button=>button.addEventListener('click',()=>void addDetectedToCollection(Number(button.dataset.addDetected))));
  void hydrateThumbnails(renderVersion);
}
async function hydrateThumbnails(renderVersion) {
  await Promise.all([...document.querySelectorAll('.thumb-frame[data-thumb-index]')].map(async (frame) => {
    const item = state.detections[Number(frame.dataset.thumbIndex)]; if (!item) return;
    const result = await resolveThumbnail(item, { minWidth: 300, timeoutMs: 2200 });
    if (renderVersion !== state.renderVersion || !frame.isConnected) return;
    if (result.url && !result.fallback && safeImageUrl(result.url)) item.thumbnail = result.url;
    const image = frame.querySelector('.thumb'); const skeleton = frame.querySelector('.thumb-skeleton'); const fallback = frame.querySelector('.thumb-fallback');
    image.src = result.url || fallbackThumbnail(); image.hidden = Boolean(result.fallback); skeleton.hidden = true; fallback.hidden = !result.fallback;
  }));
}
function renderAll() { applyAppearance(); renderPanelState(); renderUpdate(); renderDownloads(); renderCollections(); renderDetections(); localizeExtension(); }

async function loadPreferences() {
  const values = await chrome.storage.local.get({
    browserCaptureMode: 'automatic', preferredQuality: 'auto', preferredFormat: 'auto',
    extensionWindowMode: 'foreground', extensionWindowModeConfigured: false, extensionAppearanceMode: 'follow-app', extensionCustomTheme: 'dark', extensionCustomAccent: DEFAULT_ACCENT,
    extensionPanels: { downloads: false, links: false }, manualLinkCollections: [], activeManualCollectionId: '', looseManualLinks: [],
    lastAppState: state.appState, pendingExtensionUpdate: null
  });
  $('#capture-mode').value = values.browserCaptureMode;
  state.quickPreset = values.preferredFormat !== 'auto' ? values.preferredFormat : values.preferredQuality;
  if (!['auto', '1080p', '720p', 'mp3', 'm4a'].includes(state.quickPreset)) state.quickPreset = 'auto';
  $('#quick-preset').value = state.quickPreset;
  state.windowMode = values.extensionWindowModeConfigured === true && ['background', 'foreground'].includes(values.extensionWindowMode) ? values.extensionWindowMode : 'foreground';
  $('#window-mode').value = state.windowMode;
  if (values.extensionWindowModeConfigured !== true) await chrome.storage.local.set({ extensionWindowMode: 'foreground' });
  state.appearanceMode = values.extensionAppearanceMode === 'custom' ? 'custom' : 'follow-app'; state.customTheme = values.extensionCustomTheme === 'light' ? 'light' : 'dark'; state.customAccent = /^#[0-9a-f]{6}$/i.test(values.extensionCustomAccent) ? values.extensionCustomAccent : DEFAULT_ACCENT;
  state.panelCollapsed = { downloads: Boolean(values.extensionPanels?.downloads), links: Boolean(values.extensionPanels?.links) };
  state.collections = Array.isArray(values.manualLinkCollections) ? values.manualLinkCollections : []; state.activeCollectionId = String(values.activeManualCollectionId || ''); state.looseLinks = Array.isArray(values.looseManualLinks) ? values.looseManualLinks : [];
  const allLinks = [...state.looseLinks, ...state.collections.flatMap((entry) => Array.isArray(entry.links) ? entry.links : [])];
  allLinks.forEach((entry, index) => { entry.title = entry.title || linkTitle(entry.url, index); entry.thumbnail = safeImageUrl(entry.thumbnail) || linkThumbnail(entry.url); entry.author = entry.author || ''; entry.metadataResolved = Boolean(entry.metadataResolved && entry.title); });
  state.appState = values.lastAppState || state.appState; state.updateAvailable = values.pendingExtensionUpdate || null;
  renderAll(); void enrichManualLinks(allLinks);
}
async function refreshAppState() {
  try {
    const response = await sendRuntimeRequest({ type: 'GET_APP_STATUS' });
    const hostReachable = Boolean(response?.ok === true && response?.result?.ok === true && response?.result?.bridge);
    state.bridge = hostReachable ? response.result.bridge : null;
    state.appRunning = hostReachable && response.result.appRunning === true;
    const connected = Boolean(hostReachable && response?.result?.appRunning === true);
    const sleeping = Boolean(hostReachable && !connected);
    setConnectionStatus(
      connected ? 'connected' : sleeping ? 'sleeping' : 'offline',
      connected ? 'Disponible' : sleeping ? 'App cerrada' : 'No disponible',
      connected ? 'Clear Download Manager disponible' : sleeping ? 'Puente instalado; la app se abrirá al enviar' : 'Host nativo de Clear Download Manager no disponible'
    );
    if (response?.result?.state) { state.appState = response.result.state; await chrome.storage.local.set({ lastAppState: state.appState }); }
    $('#sync-state').textContent = connected ? (state.bridge?.actions.includes('job_action') ? 'Sincronizado' : 'Conectado · gestión desde la app') : sleeping ? 'Puente listo' : 'Datos guardados';
    if (sleeping && state.detectionState === 'media_found') state.notice = 'La app está cerrada; se abrirá al enviar.';
  } catch (error) {
    // A broken or sleeping service worker must settle the visible state. Keep
    // the exact runtime error in the console for a real Chrome diagnosis while
    // presenting the stable product wording in the panel.
    diagnostic('GET_APP_STATUS failed:', error);
    state.bridge = null; state.appRunning = false;
    setConnectionStatus('offline', 'No disponible', 'No se pudo contactar con el puente de Clear Download Manager');
    $('#sync-state').textContent = 'Sin conexión';
  }
  renderDownloads(); applyAppearance();
}
function hideDownloadMenu() {
  const menu = $('#download-context-menu');
  if (!menu) return;
  menu.hidden = true;
  state.contextJobId = null;
}
function showDownloadMenu(event, jobId) {
  const menu = $('#download-context-menu');
  if (!menu) return;
  state.contextJobId = String(jobId || '');
  const job = (Array.isArray(state.appState?.jobs) ? state.appState.jobs : []).find((item) => String(item?.id) === state.contextJobId);
  const playButton = menu.querySelector('[data-download-action="play"]');
  if (playButton) playButton.hidden = !downloadCanPlay(job);
  const status = String(job?.status || '').toLowerCase();
  const visibility = {
    pause: status === 'running',
    resume: status === 'paused',
    retry: status === 'failed',
    cancel: ['running', 'queued', 'paused'].includes(status),
    reveal_file: status === 'completed',
    open_file: status === 'completed',
    delete_history: true,
    delete_file: status === 'completed'
  };
  for (const [action, visible] of Object.entries(visibility)) {
    const actionButton = menu.querySelector(`[data-download-action="${action}"]`);
    if (actionButton) actionButton.hidden = !visible;
  }
  const fresh = state.appRunning && Date.now() - Number(state.appState?.updatedAt || 0) < 15000;
  menu.querySelectorAll('[data-download-action]').forEach(button => {
    const allowed = canUseJobAction(state.bridge, button.dataset.downloadAction, job, fresh);
    button.disabled = !allowed;
    button.title = allowed ? '' : 'No disponible con este puente o estado. Utiliza Clear Download Manager.';
  });
  menu.hidden = false;
  const width = menu.offsetWidth || 190;
  const height = menu.offsetHeight || 88;
  menu.style.left = `${Math.max(8, Math.min(event.clientX, window.innerWidth - width - 8))}px`;
  menu.style.top = `${Math.max(8, Math.min(event.clientY, window.innerHeight - height - 8))}px`;
}
async function analyze() {
  state.notice = ''; state.detectionState = 'analyzing'; state.detections = []; renderDetections();
  try {
    const result = await sendRuntimeRequest({ type: 'ANALYZE_ACTIVE' });
    if (!result?.ok) {
      state.detectionState = 'detection_failed';
      state.notice = 'No se pudo completar el análisis. Pulsa Actualizar para reintentar.';
      diagnostic('ANALYZE_ACTIVE failed:', result?.error || 'respuesta no válida');
    } else if (state.detectionState === 'analyzing') {
      // The port normally delivers DETECTIONS first. This fallback also makes
      // the one-shot request authoritative when that event is missed.
      const detections = Array.isArray(result.detections) ? result.detections.filter((item) => item?.type !== 'playlist') : [];
      state.detections = detections.map((item) => ({ ...item, selected: true }));
      state.detectionState = detections.length ? 'media_found' : 'no_media';
    }
  } catch (error) {
    state.detectionState = 'detection_failed';
    state.notice = 'No se pudo completar el análisis. Pulsa Actualizar para reintentar.';
    diagnostic('ANALYZE_ACTIVE rejected:', error);
  } finally {
    renderDetections();
  }
}
async function sendItems(items, { label = 'seleccionados', manualPlaylist = false, playlistTitle = '' } = {}) {
  const selected = items.filter((item) => item && item.selected !== false); if (!selected.length || state.busy) return;
  let allowUncertainRetry = false;
  if (state.uncertainSend) {
    allowUncertainRetry = window.confirm('El envío anterior no se confirmó. Comprueba primero las descargas y ventanas de Clear Download Manager. ¿Ya verificaste que no se recibió y deseas reenviar?');
    if (!allowUncertainRetry) return;
  }
  state.busy = true; state.notice = 'Enviando a Clear Download Manager…'; renderDetections();
  try {
    const preferences = { ...presetPreferences(), ...extensionFilenameMetadata(selected[0], presetPreferences()), windowMode: state.windowMode, manualPlaylist, playlistTitle, operationId: `send-${crypto.randomUUID()}`, allowUncertainRetry };
    const response = await chrome.runtime.sendMessage({ type: 'SEND_TO_APP', items: selected, preferences });
    state.uncertainSend = response?.uncertain === true;
    if (response?.ok === true) { state.notice = `Solicitud recibida por el puente (${label}). Comprueba su preparación en Clear Download Manager.`; }
    else { state.notice = response?.error || 'Clear Download Manager no está disponible.'; if (response?.status === 'spotify_disabled') state.detectionState = 'spotify_disabled'; }
  } catch (error) { state.uncertainSend = true; state.notice = 'No se confirmó el envío. Revisa Clear Download Manager antes de volver a enviarlo.'; }
  finally { state.busy = false; renderDetections(); window.setTimeout(() => void refreshAppState(), 700); }
}
async function addManualLinks() {
  const urls = parseUrls($('#manual-links-input').value); if (!urls.length) { state.notice = 'Pega al menos un enlace HTTP o HTTPS válido.'; renderDetections(); return; }
  if (!state.activeCollectionId && !state.looseLinks.length && window.confirm('¿Crear playlist? Los siguientes enlaces se añadirán automáticamente a esa carpeta.')) {
    const name = window.prompt('Nombre de la playlist', 'Mi playlist')?.trim();
    if (name) { const collection = { id: crypto.randomUUID?.() || String(Date.now()), name: name.slice(0, 80), links: [], createdAt: Date.now() }; state.collections.push(collection); state.activeCollectionId = collection.id; }
  }
  const target = currentLinks(); const existing = new Set(target.map((entry) => entry.url)); const added = [];
  urls.forEach((url, index) => { if (!existing.has(url)) { const entry = makeLink(url, index); target.push(entry); added.push(entry); existing.add(url); } });
  $('#manual-links-input').value = ''; await persistLinkState(); renderCollections(); void enrichManualLinks(added);
}
async function sendCurrentCollection() {
  const collection = currentCollection(); const links = currentLinks().filter((entry) => entry.selected); if (!links.length) return;
  const items = links.map((entry) => { const selection=youtubeSelection(entry.url); const url=selection?.url||entry.url; return { id: entry.id, type: entry.type || selection?.type || 'generic_url', title: entry.title, author: entry.author || '', thumbnail: entry.thumbnail || '', mediaUrl: url, canonicalUrl: url, pageUrl: entry.url, platform: new URL(url).hostname, confidence: 100, selected: true }; });
  await sendItems(items, { label: collection ? 'playlist' : 'enlaces manuales', manualPlaylist: Boolean(collection || items.length > 1), playlistTitle: collection?.name || (items.length > 1 ? 'Enlaces manuales' : '') });
}

async function addDetectedToCollection(index) {
  const item=state.detections[index];if(!item)return;
  let collection=currentCollection();
  if(!collection){
    const name=window.prompt('Nombre de la playlist manual', 'Mi playlist')?.trim();if(!name)return;
    collection={id:crypto.randomUUID(),name:name.slice(0,80),links:[],createdAt:Date.now()};
    state.collections.push(collection);state.activeCollectionId=collection.id;
  }
  try {
    if (!safeImageUrl(item.thumbnail)) {
      const result = await resolveThumbnail(item, { minWidth: 300, timeoutMs: 2200 });
      if (result.url && !result.fallback) item.thumbnail = result.url;
      if (!safeImageUrl(item.thumbnail)) item.thumbnail = linkThumbnail(item.mediaUrl || item.canonicalUrl || item.pageUrl);
    }
    const added=appendDetectedLink(collection,item,crypto.randomUUID());
    await persistLinkState();renderCollections();
    state.notice=added?`Añadido a «${collection.name}». Puedes seguir agregando vídeos con +.`:'Ese vídeo ya está en esta playlist.';
  } catch(error){state.notice=String(error.message||error);}
  renderDetections();
}

$('#capture-mode').addEventListener('change', async (event) => { await chrome.runtime.sendMessage({ type: 'SET_CAPTURE_MODE', mode: event.target.value }); });
$('#extension-locale')?.addEventListener('change', (event) => {
  extensionLocale = saveLocale(event.target.value);
  delete $('#downloads-list').dataset.renderKey;
  renderAll();
});
$('#quick-preset').addEventListener('change', async (event) => { state.quickPreset = event.target.value; await chrome.storage.local.set(presetPreferences()); });
$('#window-mode').addEventListener('change', async (event) => { state.windowMode = event.target.value; await chrome.storage.local.set({ extensionWindowMode: state.windowMode, extensionWindowModeConfigured: true }); });
$('#open-app').addEventListener('click', async () => { await chrome.runtime.sendMessage({ type: 'OPEN_APP' }); });
$('#refresh').addEventListener('click', () => void analyze()); $('#retry').addEventListener('click', () => void analyze());
$('#select-all').addEventListener('change', (event) => { state.detections.forEach((item) => { item.selected = event.target.checked; }); renderDetections(); });
$('#send-current').addEventListener('click', () => void sendItems(state.detections.filter((item) => item.type === 'video'), { label: 'vídeo actual' }));
$('#show-all-downloads').addEventListener('click', () => { state.showAllDownloads = !state.showAllDownloads; renderDownloads(); });
$('#downloads-list').addEventListener('contextmenu', (event) => {
  const row = event.target.closest('[data-job-id]');
  if (!row) return;
  event.preventDefault();
  showDownloadMenu(event, row.dataset.jobId);
});
$('#downloads-list').addEventListener('click', (event) => {
  const button = event.target.closest('[data-download-menu]');
  if (!button) return;
  event.preventDefault();
  event.stopPropagation();
  const rect = button.getBoundingClientRect();
  showDownloadMenu({ clientX: rect.right, clientY: rect.bottom }, button.dataset.downloadMenu);
});
$('#downloads-list').addEventListener('keydown', (event) => {
  if (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10')) return;
  const row = event.target.closest('[data-job-id]');
  if (!row) return;
  event.preventDefault();
  const rect = row.getBoundingClientRect();
  showDownloadMenu({ clientX: rect.left + 10, clientY: rect.bottom - 4 }, row.dataset.jobId);
});
$('#download-context-menu').addEventListener('click', async (event) => {
  const button = event.target.closest('[data-download-action]');
  if (!button || button.disabled || !state.contextJobId) return;
  const mode = button.dataset.downloadAction;
  const jobId = state.contextJobId;
  hideDownloadMenu();
  if (mode === 'delete_file' && !window.confirm('¿Eliminar el archivo descargado y su registro? Esta acción no se puede deshacer.')) return;
  if (mode === 'delete_history' && !window.confirm('¿Eliminar esta descarga del historial?')) return;
  const responsePayload = { type: 'JOB_ACTION', jobId, action: mode };
  if (mode === 'delete_file' || mode === 'delete_history') responsePayload.confirmed = true;
  const response = mode === 'play' || mode === 'open'
    ? await chrome.runtime.sendMessage({ type: 'OPEN_JOB', jobId, mode })
    : await chrome.runtime.sendMessage(responsePayload);
  if (!response?.ok) {
    state.notice = response?.error || 'No se pudo abrir la descarga en Clear Download Manager.';
    renderDetections();
  } else { window.setTimeout(() => void refreshAppState(), 250); }
});
document.addEventListener('click', (event) => {
  if (!event.target.closest('#download-context-menu') && !event.target.closest('[data-download-menu]')) hideDownloadMenu();
});
document.addEventListener('contextmenu', (event) => {
  if (!event.target.closest('[data-job-id]')) hideDownloadMenu();
});
document.addEventListener('keydown', (event) => { if (event.key === 'Escape') hideDownloadMenu(); });
document.querySelectorAll('[data-toggle-panel]').forEach((button) => button.addEventListener('click', async () => { const name = button.dataset.togglePanel; state.panelCollapsed[name] = !state.panelCollapsed[name]; await chrome.storage.local.set({ extensionPanels: state.panelCollapsed }); renderPanelState(); }));
$('#new-collection').addEventListener('click', async () => { const name = window.prompt('Nombre de la nueva playlist', `Playlist ${state.collections.length + 1}`)?.trim(); if (!name) return; const collection = { id: crypto.randomUUID?.() || String(Date.now()), name: name.slice(0, 80), links: [], createdAt: Date.now() }; state.collections.push(collection); state.activeCollectionId = collection.id; await persistLinkState(); renderCollections(); });
$('#leave-collection').addEventListener('click', async () => { state.activeCollectionId = ''; await persistLinkState(); renderCollections(); });
$('#collection-select').addEventListener('change', async (event) => { state.activeCollectionId = event.target.value; await persistLinkState(); renderCollections(); });
let manualInputTimer = 0;
$('#manual-links-input').addEventListener('input', () => {
  window.clearTimeout(manualInputTimer);
  if (!parseUrls($('#manual-links-input').value).length) return;
  manualInputTimer = window.setTimeout(() => void addManualLinks(), 260);
});
$('#clear-current-links').addEventListener('click', async () => { if (!window.confirm('¿Vaciar esta carpeta de enlaces?')) return; currentLinks().splice(0); await persistLinkState(); renderCollections(); });
$('#send-current-collection').addEventListener('click', () => void sendCurrentCollection());
$('#appearance-mode').addEventListener('change', async (event) => { state.appearanceMode = event.target.value; await chrome.storage.local.set({ extensionAppearanceMode: state.appearanceMode }); applyAppearance(); });
$('#custom-theme').addEventListener('change', async (event) => { state.customTheme = event.target.value; await chrome.storage.local.set({ extensionCustomTheme: state.customTheme }); applyAppearance(); });
$('#custom-accent').addEventListener('input', async (event) => { state.customAccent = event.target.value; await chrome.storage.local.set({ extensionCustomAccent: state.customAccent }); applyAppearance(); });
$('#apply-extension-update').addEventListener('click', async () => { $('#apply-extension-update').disabled = true; $('#apply-extension-update').textContent = 'Aplicando…'; await chrome.runtime.sendMessage({ type: 'APPLY_EXTENSION_UPDATE' }); });

port.onMessage.addListener((message) => {
  if (message?.type === 'DETECTIONS') {
    const page = `${message.tabId}:${message.pageUrl || ''}`;
    const key = item => `${item.type}:${item.mediaUrl || item.canonicalUrl || item.pageUrl}`;
    const previous = new Map(state.detectionPage === page ? state.detections.map(item=>[key(item),item.selected]) : []);
    state.detectionPage = page;
    state.detectionState = message.status || message.state || (message.detections?.length ? 'media_found' : 'no_media');
    state.detections = (message.detections || []).filter((item) => item?.type !== 'playlist').map(item => ({ ...item, selected: previous.get(key(item)) ?? true }));
    renderDetections();
  }
  if (message?.type === 'DETECTION_ERROR') { state.detectionState = 'detection_failed'; state.notice = message.message || ''; state.detections = []; renderDetections(); }
  if (message?.type === 'APP_STATE') {
    state.bridge = message.result?.ok === true ? message.result.bridge || null : null;
    state.appRunning = Boolean(state.bridge && message.result.appRunning === true);
    setConnectionStatus(state.appRunning ? 'connected' : state.bridge ? 'sleeping' : 'offline', state.appRunning ? 'Disponible' : state.bridge ? 'App cerrada' : 'No disponible');
    $('#sync-state').textContent = state.appRunning ? (state.bridge.actions.includes('job_action') ? 'Sincronizado' : 'Conectado · gestión desde la app') : 'Datos guardados';
    if (message.result?.state) { state.appState = message.result.state; void chrome.storage.local.set({lastAppState:state.appState}); }
    if (!state.appRunning) hideDownloadMenu();
    renderDownloads(); applyAppearance();
  }
  if (message?.type === 'EXTENSION_UPDATE_AVAILABLE') { state.updateAvailable = message.update || { version: 'nueva' }; renderUpdate(); }
  if (message?.type === 'CONTEXT_SEND_ERROR') state.notice=message.message;
  if (message?.type === 'CAPTURE_PENDING') state.notice = `Captura recibida: ${message.item?.filename || 'descarga'}.`;
  if (message?.type === 'CAPTURE_ACCEPTED') {
    state.notice = message.response?.status === 'review_opened'
      ? 'Abierta en Clear Download Manager; elige la carpeta y confirma.'
      : 'Descarga transferida a Clear Download Manager.';
    window.setTimeout(() => void refreshAppState(), 600);
  }
  if (message?.type === 'CAPTURE_FALLBACK') state.notice = message.response?.error || 'Clear Download Manager no la aceptó; Chrome continúa la descarga.';
  if (message?.type === 'CAPTURE_AVAILABLE') state.notice = `Descarga disponible: ${message.item?.filename || 'archivo'}.`;
  renderDetections();
});

await loadPreferences();
void refreshAppState();
void analyze();
