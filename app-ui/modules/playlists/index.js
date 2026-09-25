let playlistContext = {};
let appState = {};
let previewMode = false;
const contextValue = (name, fallback) => playlistContext[name] || fallback;
const icon = (...args) => contextValue('icon', () => '')(...args);
const escapeHtml = (...args) => contextValue('escapeHtml', (value) => String(value ?? ''))(...args);
const mediaSizeLabel = (...args) => contextValue('mediaSizeLabel', () => '')(...args);
const invoke = (...args) => contextValue('invoke', async () => {})(...args);
const playlistMetadata = (...args) => contextValue('playlistMetadata', () => '')(...args);
const playlistResolutionLabel = (...args) => contextValue('playlistResolutionLabel', () => '')(...args);
const thumbnailSrc = (...args) => contextValue('thumbnailSrc', (value) => value)(...args);
const showToast = (...args) => contextValue('showToast', () => {})(...args);
const analysisAlternativesMarkup = (...args) => contextValue('analysisAlternativesMarkup', () => '')(...args);
const downloadDirectoryLabel = (...args) => contextValue('downloadDirectoryLabel', () => '')(...args);
let playlistSizeRun = { generation: 0, queue: [], active: 0, format: '', timer: 0, pauseUntil: 0 };
const PLAYLIST_SIZE_CONCURRENCY = 1;
const PLAYLIST_SIZE_INITIAL_DELAY_MS = 900;
const PLAYLIST_SIZE_BETWEEN_ITEMS_MS = 140;
const PLAYLIST_SIZE_SCROLL_PAUSE_MS = 320;
const PLAYLIST_ANALYSIS_CACHE_TTL_MS = 10 * 60 * 1000;
const PLAYLIST_ANALYSIS_CACHE_LIMIT = 64;
const playlistAnalysisCache = new Map();

export function configurePlaylist(context = {}) {
  playlistContext = context;
  appState = context.getAppState?.() || {};
  previewMode = Boolean(context.previewMode);
}

function playlistItemSizeLabel(item = {}) {
  if (item.sizeStatus === 'pending' || item.sizeStatus === 'analyzing') return 'Analizando…';
  return mediaSizeLabel(item.filesize, Boolean(item.filesizeEstimated));
}

function selectedPlaylistSizeSummary() {
  const selected = selectedPlaylistItems();
  if (!selected.length) return 'Sin elementos seleccionados';
  const known = selected.filter((item) => Number.isFinite(Number(item.filesize)) && Number(item.filesize) > 0);
  const pending = selected.filter((item) => ['pending', 'analyzing'].includes(item.sizeStatus)).length;
  const unknown = selected.length - known.length - pending;
  if (!known.length) {
    return '';
  }
  const total = known.reduce((sum, item) => sum + Number(item.filesize || 0), 0);
  const estimated = known.some((item) => item.filesizeEstimated) || pending > 0 || unknown > 0;
  const label = mediaSizeLabel(total, estimated);
  if (pending > 0 || unknown > 0) return `${label} parcial`;
  return label;
}

function paintPlaylistSizeDom(itemId = '') {
  const normalizedId = String(itemId || '');
  let elements = [];
  if (normalizedId && window.CSS?.escape) {
    const element = document.querySelector(`[data-playlist-id="${CSS.escape(normalizedId)}"]`);
    if (element) elements = [element];
    elements = [...document.querySelectorAll('[data-playlist-id]')];
  }
  elements.forEach((element) => {
    if (normalizedId && element.dataset.playlistId !== normalizedId) return;
    const item = appState.playlistItems.find((entry) => String(entry.id) === String(element.dataset.playlistId));
    const target = element.querySelector('[data-playlist-size]');
    if (item && target) target.textContent = playlistItemSizeLabel(item);
  });
  document.querySelectorAll('[data-playlist-size-summary]').forEach((element) => {
    element.textContent = selectedPlaylistSizeSummary();
  });
}

function playlistCachedAnalysis(url) {
  const key = String(url || '').trim();
  if (!key) return null;
  const entry = playlistAnalysisCache.get(key);
  if (!entry || Date.now() - entry.storedAt > PLAYLIST_ANALYSIS_CACHE_TTL_MS) {
    playlistAnalysisCache.delete(key);
    return null;
  }
  playlistAnalysisCache.delete(key);
  playlistAnalysisCache.set(key, entry);
  return entry.value;
}

function cachePlaylistAnalysis(url, value) {
  const key = String(url || '').trim();
  if (!key || !value) return;
  playlistAnalysisCache.delete(key);
  playlistAnalysisCache.set(key, { storedAt: Date.now(), value });
  while (playlistAnalysisCache.size > PLAYLIST_ANALYSIS_CACHE_LIMIT) {
    const oldest = playlistAnalysisCache.keys().next().value;
    if (!oldest) break;
    playlistAnalysisCache.delete(oldest);
  }
}

async function analyzePlaylistItemForSize(url) {
  const cached = playlistCachedAnalysis(url);
  if (cached) return cached;
  const result = await invoke('analyze_media_url', { url });
  cachePlaylistAnalysis(url, result);
  return result;
}

function schedulePlaylistSizePump(run, delay = 0) {
  if (run !== playlistSizeRun || previewMode) return;
  if (run.timer) window.clearTimeout(run.timer);
  run.timer = window.setTimeout(() => {
    run.timer = 0;
    pumpPlaylistSizeAnalysis(run);
  }, Math.max(0, delay));
}

function playlistFormatFromAnalysis(formats = [], label = '') {
  const available = Array.isArray(formats) ? formats : [];
  const lower = String(label || '').toLocaleLowerCase('es');
  if (lower.includes('m4a')) return available.find((format) => /m4a/i.test(`${format.ext || ''} ${format.label || ''}`));
  if (lower.includes('opus') || lower.includes('mp3')) return available.find((format) => format.audio_only);
  const requestedHeight = [2160, 1440, 1080, 720, 480, 360].find((height) => lower.includes(String(height)));
  if (requestedHeight) return available.find((format) => !format.audio_only && String(format.id || '').includes(String(requestedHeight)));
  if (lower.includes('vídeo') || lower.includes('video') || lower.includes('mejor')) return available.find((format) => !format.audio_only) || available[0];
  return available[0];
}

function pumpPlaylistSizeAnalysis(run) {
  if (run !== playlistSizeRun || previewMode) return;
  const now = performance.now();
  if (run.pauseUntil > now) {
    schedulePlaylistSizePump(run, run.pauseUntil - now + 24);
  }
  while (run.active < PLAYLIST_SIZE_CONCURRENCY && run.queue.length) {
    const itemId = run.queue.shift();
    const item = appState.playlistItems.find((entry) => entry.id === itemId);
    if (!item || !item.selected || !String(item.selectedSourceUrl || item.sourceUrl || '').trim()) continue;
    const sourceUrl = item.selectedSourceUrl || item.sourceUrl;
    run.active += 1;
    item.sizeStatus = 'analyzing';
    paintPlaylistSizeDom(item.id);
    Promise.resolve(analyzePlaylistItemForSize(sourceUrl)).then((result) => {
      if (run !== playlistSizeRun) return;
      const current = appState.playlistItems.find((entry) => entry.id === item.id);
      if (!current) return;
      const format = playlistFormatFromAnalysis(result?.formats, run.format);
      const bytes = Number(format?.filesize || 0);
      current.filesize = Number.isFinite(bytes) && bytes > 0 ? bytes : null;
      current.filesizeEstimated = Boolean(format?.filesize_estimated) || /mp3|opus/i.test(run.format);
      current.sizeStatus = current.filesize ? 'known' : 'unknown';
    }).catch(() => {
      if (run !== playlistSizeRun) return;
      const current = appState.playlistItems.find((entry) => entry.id === item.id);
      if (current) current.sizeStatus = 'unknown';
    }).finally(() => {
      run.active = Math.max(0, run.active - 1);
      if (run === playlistSizeRun) {
        paintPlaylistSizeDom(item.id);
        schedulePlaylistSizePump(run, PLAYLIST_SIZE_BETWEEN_ITEMS_MS);
      }
    });
  }
}

function startPlaylistSizeAnalysis({ reset = true, delay = 0 } = {}) {
  if (!Array.isArray(appState.playlistItems) || !appState.playlistItems.length) return;
  if (playlistSizeRun.timer) window.clearTimeout(playlistSizeRun.timer);
  const generation = playlistSizeRun.generation + 1;
  const format = appState.selectedPlaylistFormat || 'MP3 320 kbps';
  const queue = [];
  appState.playlistItems.forEach((item) => {
    const source = String(item.selectedSourceUrl || item.sourceUrl || '').trim();
    const analyzable = item.selected && source;
    if (reset) {
      const knownSize = Number(item.filesize || 0) > 0;
      if (!knownSize) {
        item.filesize = null;
        item.filesizeEstimated = false;
      }
      item.sizeStatus = knownSize ? 'known' : analyzable ? 'pending' : 'unknown';
    }
    if (analyzable && !['known', 'analyzing'].includes(item.sizeStatus)) queue.push(item.id);
  });
  playlistSizeRun = { generation, queue, active: 0, format, timer: 0, pauseUntil: 0 };
  paintPlaylistSizeDom();
  schedulePlaylistSizePump(playlistSizeRun, delay);
}

function pausePlaylistSizeAnalysis() {
  playlistSizeRun.pauseUntil = performance.now() + PLAYLIST_SIZE_SCROLL_PAUSE_MS;
}


function selectedPlaylistItems() {
  return (Array.isArray(appState.playlistItems) ? appState.playlistItems : []).filter((item) => item && item.selected);
}

function playlistThumbnailKey(item = {}, fallbackIndex = 0) {
  const source = item && typeof item === 'object' ? item : {};
  const sourceId = String(source.source_id || source.sourceId || source.id || '').trim();
  const sourceUrl = String(source.source_url || source.sourceUrl || '').trim();
  const title = String(source.title || '').trim().toLocaleLowerCase('es');
  return sourceId || sourceUrl || title || `playlist-item-${fallbackIndex}`;
}

function stablePlaylistThumbnail(item = {}, fallbackIndex = 0) {
  const source = item && typeof item === 'object' ? item : {};
  const key = playlistThumbnailKey(source, fallbackIndex);
  const candidate = String(source.thumbnail || '').trim();
  if (candidate) appState.playlistThumbnailCache[key] = candidate;
  return candidate || String(appState.playlistThumbnailCache[key] || '');
}

function hydratePlaylistRuntimeItem(rawItem, fallbackIndex = 0) {
  if (!rawItem) return null;
  const candidates = Array.isArray(appState.playlistItems) ? appState.playlistItems : [];
  const rawSourceId = String(rawItem.source_id || rawItem.sourceId || '').trim();
  const rawSourceUrl = String(rawItem.source_url || rawItem.sourceUrl || '').trim();
  const rawItemId = Number(rawItem.item_id || rawItem.itemId || 0);
  const rawPosition = Number.isFinite(Number(rawItem.position)) ? Number(rawItem.position) : fallbackIndex;
  const normalizedTitle = String(rawItem.title || '').trim().toLocaleLowerCase('es');
  const matching = candidates.find((candidate) => {
    const candidateId = String(candidate.id || candidate.source_id || '').trim();
    const candidateUrl = String(candidate.sourceUrl || candidate.source_url || '').trim();
    const candidateTitle = String(candidate.title || '').trim().toLocaleLowerCase('es');
    return (rawSourceId && candidateId === rawSourceId)
      || (rawSourceUrl && candidateUrl === rawSourceUrl)
      || (rawItemId && Number(candidate.itemId || candidate.item_id || 0) === rawItemId)
      || (normalizedTitle && candidateTitle === normalizedTitle);
  }) || candidates[Math.max(0, Math.min(candidates.length - 1, rawPosition))] || null;
  const rawTitle = String(rawItem.title || '').trim();
  const genericTitle = /^elemento\s+\d+$/i.test(rawTitle);
  const hydrated = {
    ...(matching || {}),
    ...rawItem,
    id: rawItem.job_id || rawItem.id || matching?.id || `playlist-runtime-${rawPosition}`,
    title: (!rawTitle || genericTitle ? matching?.title : rawTitle) || `Elemento ${rawPosition + 1}`,
    creator: String(rawItem.creator || '').trim() || matching?.creator || 'Origen multimedia',
    thumbnail: String(rawItem.thumbnail || '').trim() || matching?.thumbnail || '',
    duration: rawItem.duration_label || rawItem.duration || matching?.duration || '—',
    tone: matching?.tone || rawItem.tone || ((rawPosition % 7) + 1),
    sourceUrl: rawSourceUrl || matching?.sourceUrl || '',
    selectedSourceUrl: String(rawItem.selected_source_url || rawItem.selectedSourceUrl || matching?.selectedSourceUrl || matching?.sourceUrl || rawSourceUrl || '').trim(),
    sourceId: rawSourceId || matching?.id || ''
  };
  hydrated.thumbnail = stablePlaylistThumbnail(hydrated, rawPosition);
  return hydrated;
}

function playlistPreviewUrl(item = {}) {
  const source = item && typeof item === 'object' ? item : {};
  const direct = String(source.selectedSourceUrl || source.selected_source_url || source.sourceUrl || source.source_url || '').trim();
  if (/^https?:\/\//i.test(direct)) return direct;
  if (direct.startsWith('//')) return `https:${direct}`;
  const sourceId = String(source.sourceId || source.source_id || source.id || '').trim();
  if (/^[A-Za-z0-9_-]{11}$/.test(direct)) return `https://www.youtube.com/watch?v=${direct}`;
  if (/^[A-Za-z0-9_-]{11}$/.test(sourceId)) return `https://www.youtube.com/watch?v=${sourceId}`;
  return '';
}

function playlistThumb(item, size = 'normal', position = null) {
  const source = item && typeof item === 'object' ? item : {};
  const thumbnail = stablePlaylistThumbnail(source);
  const image = thumbnail
    ? `<img data-thumbnail-image data-original-thumbnail="${escapeHtml(thumbnail)}" src="${escapeHtml(thumbnailSrc(thumbnail))}" alt="" loading="${size === 'large' ? 'eager' : 'lazy'}" decoding="async"${size === 'large' ? ' fetchpriority="high"' : ''}><span class="playlist-thumbnail-fallback" aria-hidden="true">${icon('play', size === 'large' ? 28 : 17)}</span>`
    : icon('play', size === 'large' ? 28 : 17);
  const positionBadge = Number.isFinite(Number(position)) && Number(position) > 0 ? `<b class="playlist-position-badge">${Number(position)}</b>` : '';
  return `<span class="playlist-thumb tone-${Number(source.tone || 1)} ${size === 'large' ? 'large' : ''}">${image}${positionBadge}<small>${escapeHtml(source.duration || '—')}</small></span>`;
}

function playlistPlayableThumb(item, size = 'normal', position = null) {
  const source = item && typeof item === 'object' ? item : {};
  const url = playlistPreviewUrl(source);
  const playable = Boolean(url);
  const label = `Reproducir ${String(source.title || 'elemento de la playlist').trim()}`;
  const jobId = Number(source.job_id || source.jobId || 0);
  const completed = String(source.status || '').toLocaleLowerCase() === 'completed' && jobId > 0;
  return `<span class="playlist-thumb-action ${playable || completed ? 'is-playable' : ''}">${playlistThumb(source, size, position)}${playable || completed ? `<button type="button" class="playlist-item-preview" data-playlist-preview-url="${escapeHtml(url)}" data-playlist-preview-job-id="${completed ? jobId : ''}" aria-label="${escapeHtml(label)}" title="Reproducir">${icon('play', size === 'large' ? 23 : 17)}</button>` : ''}</span>`;
}

function bindPlaylistPreviewButtons(root = document) {
  root.querySelectorAll?.('[data-playlist-preview-url]').forEach((button) => {
    if (button.dataset.playlistPreviewBound === '1') return;
    button.dataset.playlistPreviewBound = '1';
    button.addEventListener('click', async (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (previewMode) return;
      const url = String(button.dataset.playlistPreviewUrl || '').trim();
      const jobId = Number(button.dataset.playlistPreviewJobId || 0);
      if (!url && !jobId) return;
      button.disabled = true;
      try {
        if (jobId > 0) await invoke('open_media_player', { jobId });
        else await invoke('open_online_media_player', { url });
      } catch (error) {
        showToast(String(error?.message || error || 'No se pudo reproducir este elemento de la playlist'), 'error');
      } finally {
        button.disabled = false;
      }
    });
  });
}

// Integrated preparation markup was removed; preparation is native-only.

export {
  playlistItemSizeLabel,
  selectedPlaylistSizeSummary,
  paintPlaylistSizeDom,
  playlistCachedAnalysis,
  cachePlaylistAnalysis,
  analyzePlaylistItemForSize,
  schedulePlaylistSizePump,
  playlistFormatFromAnalysis,
  pumpPlaylistSizeAnalysis,
  startPlaylistSizeAnalysis,
  pausePlaylistSizeAnalysis,
  selectedPlaylistItems,
  playlistThumbnailKey,
  stablePlaylistThumbnail,
  hydratePlaylistRuntimeItem,
  playlistPreviewUrl,
  playlistThumb,
  playlistPlayableThumb,
  bindPlaylistPreviewButtons,
};
