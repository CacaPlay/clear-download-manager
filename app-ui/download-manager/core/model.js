import {
  APPEARANCE_REVISION,
  DEFAULT_ICON_COLOR,
  DEFAULT_ICON_COLOR_MODE,
  PREVIOUS_DEFAULT_ICON_COLOR,
  DEFAULT_PROGRESS_ACTIVE_COLOR,
  DEFAULT_PROGRESS_COMPLETED_COLOR,
  ICON_COLOR_MODES,
  DEFAULT_DOWNLOAD_MANAGER_PREFERENCES,
  DOWNLOAD_MANAGER_STORAGE_KEY,
  LEGACY_DOWNLOAD_MANAGER_STORAGE_KEY
} from './constants.js';

export const THUMBNAIL_CACHE_VERSION = 2;

export function normalizePriority(value) {
  const priority = String(value || '').trim().toLowerCase();
  return priority === 'high' || priority === 'low' ? priority : 'normal';
}

export function youtubeThumbnailFromSource(value = '') {
  const source = String(value || '').trim();
  if (!source) return '';
  try {
    const url = new URL(source);
    const host = url.hostname.toLowerCase();
    if (host === 'youtu.be') {
      const id = url.pathname.split('/').filter(Boolean)[0] || '';
      return /^[A-Za-z0-9_-]{11}$/.test(id) ? `https://i.ytimg.com/vi/${id}/mqdefault.jpg` : '';
    }
    if (host !== 'youtube.com' && !host.endsWith('.youtube.com')) return '';
    const id = url.searchParams.get('v')
      || url.pathname.match(/^\/(?:shorts|embed|live)\/([A-Za-z0-9_-]{11})/i)?.[1]
      || '';
    return /^[A-Za-z0-9_-]{11}$/.test(id) ? `https://i.ytimg.com/vi/${id}/mqdefault.jpg` : '';
  } catch {
    return '';
  }
}

export function thumbnailUrl(value = '') {
  const source = String(value || '').trim();
  if (!/^https?:\/\//i.test(source)) return source;
  const derived = youtubeThumbnailFromSource(source);
  if (derived) return thumbnailUrl(derived);
  try {
    const url = new URL(source);
    // TikTok cover URLs are signed CDN URLs. Adding an unrelated cache-bust
    // query parameter can invalidate their signature and causes a delayed or
    // blank thumbnail even though the original URL is still usable.
    if (/(?:tiktokcdn|ibytedtos|muscdn|byteimg|byteoversea)/i.test(url.hostname)) return url.toString();
    url.searchParams.set('ct_thumbnail_v', String(THUMBNAIL_CACHE_VERSION));
    return url.toString();
  } catch {
    return source;
  }
}

const extensionCategory = new Map([
  ['exe', 'Drivers'], ['msi', 'Software'], ['msix', 'Software'], ['zip', 'Archivos'], ['7z', 'Archivos'], ['rar', 'Archivos'],
  ['iso', 'S.O.'], ['img', 'S.O.'], ['pdf', 'Documentos'], ['docx', 'Documentos'], ['xlsx', 'Documentos'], ['pptx', 'Documentos'],
  ['mp4', 'Vídeo'], ['mkv', 'Vídeo'], ['webm', 'Vídeo'], ['mov', 'Vídeo'], ['mp3', 'Música'], ['m4a', 'Música'], ['flac', 'Música'],
  ['jpg', 'Imágenes'], ['jpeg', 'Imágenes'], ['png', 'Imágenes'], ['webp', 'Imágenes'], ['gif', 'Imágenes'], ['bmp', 'Imágenes'], ['tiff', 'Imágenes'], ['tif', 'Imágenes'], ['svg', 'Imágenes'], ['ico', 'Imágenes'], ['heic', 'Imágenes'], ['avif', 'Imágenes'], ['jfif', 'Imágenes'],
  ['xls', 'Documentos'], ['xlsx', 'Documentos'], ['xlsm', 'Documentos'], ['ods', 'Documentos'], ['csv', 'Documentos'], ['tsv', 'Documentos'], ['numbers', 'Documentos'],
  ['ppt', 'Documentos'], ['pptx', 'Documentos'], ['pptm', 'Documentos'], ['odp', 'Documentos'], ['key', 'Documentos'], ['torrent', 'Torrents']
]);

const archiveExtensions = new Set(['zip', '7z', 'rar', 'tar', 'gz', 'bz2', 'xz', 'zst', 'cab', 'jar']);
const packageExtensions = new Set(['exe', 'msi', 'msix', 'appx', 'appxbundle', 'apk', 'deb', 'rpm', 'dmg']);
const diskExtensions = new Set(['iso', 'img', 'vhd', 'vhdx']);
const videoExtensions = new Set(['mp4', 'mkv', 'webm', 'mov', 'avi', 'm4v']);
const audioExtensions = new Set(['mp3', 'm4a', 'aac', 'wav', 'flac', 'ogg', 'opus']);
const imageExtensions = new Set(['jpg', 'jpeg', 'png', 'webp', 'gif', 'svg', 'bmp', 'tiff', 'tif', 'ico', 'heic', 'avif', 'jfif']);
const sheetExtensions = new Set(['xls', 'xlsx', 'xlsm', 'ods', 'csv', 'tsv', 'numbers']);
const presentationExtensions = new Set(['ppt', 'pptx', 'pptm', 'odp', 'key']);
const textExtensions = new Set(['txt', 'log', 'md', 'markdown', 'rtf', 'nfo', 'ini', 'cfg', 'conf']);
const codeExtensions = new Set(['html', 'htm', 'css', 'scss', 'js', 'jsx', 'ts', 'tsx', 'py', 'java', 'cs', 'cpp', 'c', 'h', 'hpp', 'rs', 'go', 'php', 'rb', 'swift', 'kt', 'lua', 'sql', 'json', 'xml', 'yaml', 'yml', 'toml', 'sh', 'bat', 'ps1']);
const ebookExtensions = new Set(['epub', 'mobi', 'azw', 'azw3', 'fb2', 'djvu', 'cbz', 'cbr']);
const fontExtensions = new Set(['ttf', 'otf', 'woff', 'woff2', 'eot', 'fon']);
const kindTokens = new Set(['file', 'video', 'audio', 'media', 'playlist', 'torrent', 'archive', 'package', 'disk', 'image', 'document', 'sheet', 'presentation', 'pdf', 'text', 'code', 'ebook', 'font']);

export function clampNumber(value, min, max) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.min(max, Math.max(min, numeric)) : min;
}

export function loadDownloadManagerPreferences() {
  let stored = {};
  let migrated = false;
  try {
    const current = localStorage.getItem(DOWNLOAD_MANAGER_STORAGE_KEY);
    if (current) stored = JSON.parse(current);
    else {
      const legacy = JSON.parse(localStorage.getItem(LEGACY_DOWNLOAD_MANAGER_STORAGE_KEY) || '{}');
      stored = {
        theme: legacy.theme,
        layout: legacy.layout,
        accent: legacy.accent,
        success: legacy.success,
        warning: legacy.warning,
        danger: legacy.danger
      };
      migrated = true;
    }
  } catch {}
  const phase19Migration = Number(stored.appearanceRevision || 0) < 6;
  const phase25_1Migration = Number(stored.appearanceRevision || 0) < 7;
  const phase12AppearanceMigration = Number(stored.appearanceRevision || 0) < 8;
  const iconAndProgressMigration = Number(stored.appearanceRevision || 0) < APPEARANCE_REVISION;
  if (phase19Migration) {
    stored.layout = 'zen-sidebar';
    stored.sidebarCollapsed = true;
    stored.inspectorCollapsed = true;
    stored.uiScale = Math.round(Math.max(70, Math.min(150, Number(stored.uiScale || 125))) / 5) * 5;
    stored.textScale = Math.round(Math.max(100, Math.min(140, Number(stored.textScale || 120))) / 5) * 5;
    migrated = true;
  }
  if (phase25_1Migration) {
    // Existing installations never tracked whether the completion color was intentional.
    // Keep the old custom value only when it differs from the historical default.
    stored.successCustomized = Boolean(stored.success && String(stored.success).toLowerCase() !== String(DEFAULT_DOWNLOAD_MANAGER_PREFERENCES.success).toLowerCase());
    migrated = true;
  }
  if (phase12AppearanceMigration) {
    stored.uiScale = Math.max(50, Math.min(130, Number(stored.uiScale ?? 125) - 25));
    stored.textScale = Math.max(80, Math.min(120, Number(stored.textScale ?? 120) - 20));
    migrated = true;
  }
  if (iconAndProgressMigration) {
    const restoreHistoricalProgressDefault = (value, fallback) => String(value || '').toLowerCase() === '#24b8e8' ? fallback : value;
    stored.progressActive = restoreHistoricalProgressDefault(stored.progressActive, DEFAULT_PROGRESS_ACTIVE_COLOR);
    stored.progressCompleted = restoreHistoricalProgressDefault(stored.progressCompleted || stored.success, DEFAULT_PROGRESS_COMPLETED_COLOR);
    if (!stored.successCustomized) stored.success = restoreHistoricalProgressDefault(stored.success, DEFAULT_PROGRESS_COMPLETED_COLOR);
    stored.progressActiveCustomized = stored.progressActiveCustomized === true;
    stored.progressCompletedCustomized = stored.progressCompletedCustomized === true;
    const storedIconColor = String(stored.iconColor || '').toLowerCase();
    const preservesCustomIconColor = stored.iconColorMode === 'custom'
      && /^#[0-9a-f]{6}$/i.test(storedIconColor)
      && storedIconColor !== PREVIOUS_DEFAULT_ICON_COLOR;
    stored.iconColorMode = preservesCustomIconColor ? 'custom' : DEFAULT_ICON_COLOR_MODE;
    stored.iconColor = preservesCustomIconColor ? storedIconColor : DEFAULT_ICON_COLOR;
    migrated = true;
  }
  const normalized = normalizePreferences({ ...DEFAULT_DOWNLOAD_MANAGER_PREFERENCES, ...stored, appearanceRevision: APPEARANCE_REVISION });
  if (migrated) {
    try { localStorage.setItem(DOWNLOAD_MANAGER_STORAGE_KEY, JSON.stringify(normalized)); } catch {}
  }
  return normalized;
}

export function normalizePreferences(value = {}) {
  const hex = /^#[0-9a-f]{6}$/i;
  const layout = 'zen-sidebar';
  const theme = ['dark', 'light', 'system'].includes(value.theme) ? value.theme : 'dark';
  const validSections = new Set(['downloads', 'queue', 'history', 'categories', 'scheduler', 'running', 'completed', 'settings', 'news']);
  const section = validSections.has(String(value.section || '')) ? String(value.section) : 'downloads';
  return {
    ...DEFAULT_DOWNLOAD_MANAGER_PREFERENCES,
    ...value,
    layout,
    section,
    theme,
    accent: hex.test(String(value.accent || '')) ? value.accent : DEFAULT_DOWNLOAD_MANAGER_PREFERENCES.accent,
    accentIntensity: Math.round(clampNumber(value.accentIntensity, 40, 100)),
    progressActive: hex.test(String(value.progressActive || '')) ? value.progressActive : DEFAULT_DOWNLOAD_MANAGER_PREFERENCES.progressActive,
    progressCompleted: hex.test(String(value.progressCompleted || '')) ? value.progressCompleted : DEFAULT_DOWNLOAD_MANAGER_PREFERENCES.progressCompleted,
    progressActiveCustomized: Boolean(value.progressActiveCustomized),
    progressCompletedCustomized: Boolean(value.progressCompletedCustomized),
    success: hex.test(String(value.success || '')) ? value.success : DEFAULT_DOWNLOAD_MANAGER_PREFERENCES.success,
    successCustomized: Boolean(value.successCustomized),
    warning: hex.test(String(value.warning || '')) ? value.warning : DEFAULT_DOWNLOAD_MANAGER_PREFERENCES.warning,
    progressPaused: hex.test(String(value.progressPaused || '')) ? value.progressPaused : DEFAULT_DOWNLOAD_MANAGER_PREFERENCES.progressPaused,
    danger: hex.test(String(value.danger || '')) ? value.danger : DEFAULT_DOWNLOAD_MANAGER_PREFERENCES.danger,
    iconColorMode: ICON_COLOR_MODES.includes(String(value.iconColorMode || '')) ? String(value.iconColorMode) : DEFAULT_DOWNLOAD_MANAGER_PREFERENCES.iconColorMode,
    iconColor: hex.test(String(value.iconColor || '')) ? value.iconColor : DEFAULT_DOWNLOAD_MANAGER_PREFERENCES.iconColor,
    selectedJobId: Number.isFinite(Number(value.selectedJobId)) ? Number(value.selectedJobId) : null,
    sidebarCollapsed: Boolean(value.sidebarCollapsed),
    inspectorCollapsed: Boolean(value.inspectorCollapsed),
    lowerPanelCollapsed: true,
    compactRows: Boolean(value.compactRows),
    query: String(value.query || '').slice(0, 180),
    filter: String(value.filter || 'all'),
    category: String(value.category || 'all'),
    inspectorTab: ['summary', 'files', 'connections', 'log'].includes(value.inspectorTab) ? value.inspectorTab : 'summary',
    commandPanel: ['overview', 'connections', 'logs', 'scheduler'].includes(value.commandPanel) ? value.commandPanel : 'overview',
    uiScale: Math.round(clampNumber(value.uiScale, 50, 130) / 5) * 5,
    textScale: Math.round(clampNumber(value.textScale, 80, 120) / 5) * 5,
    appearanceRevision: APPEARANCE_REVISION
  };
}

export function saveDownloadManagerPreferences(preferences) {
  const normalized = normalizePreferences(preferences);
  try { localStorage.setItem(DOWNLOAD_MANAGER_STORAGE_KEY, JSON.stringify(normalized)); } catch {}
  return normalized;
}

export function resolveTheme(preferences) {
  if (preferences.theme !== 'system') return preferences.theme;
  return window.matchMedia?.('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

export function fileExtension(title = '') {
  const clean = String(title).split(/[?#]/)[0].replace(/\\/g, '/').split('/').pop() || '';
  const index = clean.lastIndexOf('.');
  return index > 0 && index < clean.length - 1 ? clean.slice(index + 1).toLowerCase() : '';
}

function extensionToken(value = '') {
  const token = String(value || '').trim().replace(/^\./, '').toLowerCase();
  return /^[a-z0-9]{1,16}$/.test(token) && !kindTokens.has(token) ? token : '';
}

export function jobFileExtension(job = {}) {
  // An explicit extension is authoritative.  Only this field may be a bare
  // token; treating URL path tokens as extensions turns `/watch?v=...` into
  // the visible format WATCH.
  const explicit = extensionToken(job.extension);
  if (explicit) return explicit;
  const namedCandidates = [job.destination, job.output_path, job.outputPath, job.title];
  for (const candidate of namedCandidates) {
    const fromName = fileExtension(candidate);
    if (fromName) return fromName;
  }
  // URLs can still carry a real filename extension in their path, but never
  // infer a bare final path segment from an opaque media page URL.
  const urlCandidates = [job.sourceUrl, job.source_url, job.url, job.finalUrl, job.final_url];
  for (const candidate of urlCandidates) {
    const fromName = fileExtension(candidate);
    if (fromName) return fromName;
  }
  return '';
}

export function kindFromExtension(extension = '') {
  const normalized = String(extension || '').toLowerCase();
  if (archiveExtensions.has(normalized)) return 'archive';
  if (packageExtensions.has(normalized)) return 'package';
  if (diskExtensions.has(normalized)) return 'disk';
  if (videoExtensions.has(normalized)) return 'video';
  if (audioExtensions.has(normalized)) return 'audio';
  if (imageExtensions.has(normalized)) return 'image';
  if (normalized === 'pdf') return 'pdf';
  if (ebookExtensions.has(normalized)) return 'ebook';
  if (fontExtensions.has(normalized)) return 'font';
  if (codeExtensions.has(normalized)) return 'code';
  if (textExtensions.has(normalized)) return 'text';
  if (sheetExtensions.has(normalized)) return 'sheet';
  if (presentationExtensions.has(normalized)) return 'presentation';
  if (['doc', 'docx', 'odt'].includes(normalized)) return 'document';
  return '';
}

export function effectiveJobKind(job = {}) {
  return kindFromExtension(jobFileExtension(job)) || String(job.kind || 'file').toLowerCase();
}

export function isPlayableJob(job = {}) {
  return ['video', 'audio', 'media'].includes(effectiveJobKind(job));
}

export function inferCategory(job) {
  if (job.kind === 'playlist') return 'Playlist';
  if (job.category) return job.category;
  if (job.kind === 'video') return 'Vídeo';
  if (job.kind === 'audio') return 'Música';
  if (job.kind === 'media') return 'Multimedia';
  return extensionCategory.get(jobFileExtension(job)) || 'Otros';
}

export function inferOrigin(job) {
  if (job.origin) return job.origin;
  if (['media', 'video', 'audio', 'playlist'].includes(job.kind)) return 'yt-dlp';
  if (job.kind === 'torrent') return 'Torrent';
  return job.engine?.includes('curl') ? 'HTTP' : 'Directo';
}

export function playlistJobId(batchId) {
  return -1_000_000_000 - Math.max(0, Number(batchId) || 0);
}

function positiveOrder(value) {
  const numeric = Number(value);
  return Number.isSafeInteger(numeric) && numeric > 0 ? numeric : null;
}

function insertionOrder(job) {
  const persisted = positiveOrder(job?.addedOrder);
  if (persisted !== null) return { persisted: true, value: persisted };
  const id = positiveOrder(job?.id);
  if (id !== null) return { persisted: true, value: id };
  const optimistic = Number(job?.__addedOrder ?? job?.__addedAt);
  if (Number.isFinite(optimistic)) return { persisted: false, value: optimistic };
  return { persisted: false, value: Number.MAX_SAFE_INTEGER };
}

function compareByInsertion(left, right) {
  const leftOrder = insertionOrder(left);
  const rightOrder = insertionOrder(right);
  if (leftOrder.persisted !== rightOrder.persisted) return leftOrder.persisted ? -1 : 1;
  // Newest insertion stays at the top. Once rendered, this immutable order
  // remains independent from status, progress and updated_at changes.
  if (leftOrder.value !== rightOrder.value) return rightOrder.value - leftOrder.value;
  return String(left?.id ?? '').localeCompare(String(right?.id ?? ''), 'en');
}

function normalizePlaylistBatch(batch, index) {
  const batchId = Number(batch?.batch_id ?? batch?.id ?? 0) || index + 1;
  const total = Math.max(0, Number(batch?.total_items ?? batch?.total ?? 0) || 0);
  const completed = Math.max(0, Number(batch?.completed_items ?? batch?.completed ?? 0) || 0);
  const failed = Math.max(0, Number(batch?.failed_items ?? batch?.failed ?? 0) || 0);
  let active = Math.max(0, Number(batch?.active_items ?? batch?.active ?? 0) || 0);
  let queued = Math.max(0, total - completed - failed - active);
  let status = String(batch?.status || 'queued');
  if (total > 0 && completed === total) status = 'completed';
  else if (total > 0 && completed + failed >= total && failed > 0) status = 'failed';
  else if (active > 0) status = status === 'paused' ? 'paused' : 'running';
  else if (status === 'completed_with_errors') status = 'failed';
  const rawTotalBytes = Number(batch?.total_bytes ?? batch?.totalBytes ?? 0);
  const totalBytes = Number.isFinite(rawTotalBytes) && rawTotalBytes > 0 ? Math.floor(rawTotalBytes) : null;
  const totalBytesEstimated = Boolean(batch?.total_bytes_estimated ?? batch?.totalBytesEstimated);
  const progressEstimated = Boolean(batch?.progress_estimated ?? batch?.progressEstimated);
  const rawDownloadedBytes = Number(batch?.downloaded_bytes ?? batch?.downloadedBytes ?? 0);
  const downloadedBytes = Math.max(0, Math.floor(Number.isFinite(rawDownloadedBytes) ? rawDownloadedBytes : 0));
  const speedBps = Math.max(0, Number(batch?.speed_bps ?? batch?.speedBps ?? 0) || 0);
  const liveEvidence = downloadedBytes > 0 || speedBps > 0 || Number(batch?.progress || 0) > 0;
  if (status === 'queued' && liveEvidence) {
    status = 'running';
    active = Math.max(active, 1);
    queued = Math.max(0, total - completed - failed - active);
  }
  const exactDownloadedBytes = totalBytes && !totalBytesEstimated
    ? Math.min(downloadedBytes, totalBytes)
    : downloadedBytes;
  const aggregateProgress = status === 'completed'
    ? 100
    : clampNumber(batch?.progress ?? (total ? ((completed + failed) * 100) / total : 0), 0, 100);
  const stage = String(batch?.stage || status);
  const processing = status === 'running' && ['Combinando video y audio', 'Convirtiendo', 'Validando', 'Preparando', 'Procesando', 'Finalizando'].includes(stage);
  const hasUsefulProgress = Number.isFinite(Number(batch?.progress)) && Number(batch?.progress) > 0;
  const indeterminate = status === 'running'
    && !hasUsefulProgress
    && (processing || Boolean(batch?.indeterminate) || (totalBytes == null && !progressEstimated));
  const thumbnails = Array.isArray(batch?.thumbnails)
    ? batch.thumbnails.filter(Boolean).slice(0, 4).map(String)
    : String(batch?.thumbnail_stack || '')
      .split('\u001f')
      .map((item) => item.trim())
      .filter(Boolean)
      .slice(0, 4);
  const destination = String(batch?.destination || batch?.destination_dir || '');
  const detailParts = [`${total} elemento${total === 1 ? '' : 's'}`];
  if (completed) detailParts.push(`${completed} completado${completed === 1 ? '' : 's'}`);
  if (queued) detailParts.push(`${queued} pendiente${queued === 1 ? '' : 's'}`);
  if (failed) detailParts.push(`${failed} con error`);
  return {
    ...batch,
    id: playlistJobId(batchId),
    addedOrder: positiveOrder(batch?.added_order ?? batch?.addedOrder),
    playlistBatchId: batchId,
    title: String(batch?.title || 'Playlist sin nombre'),
    detail: String(batch?.detail || detailParts.join(' · ')),
    status,
    progress: aggregateProgress,
    downloadedBytes: exactDownloadedBytes,
    totalBytes,
    totalBytesEstimated,
    progressEstimated,
    finalSize: status === 'completed' && !totalBytesEstimated
      ? (Number(batch?.final_size ?? batch?.finalSize ?? totalBytes ?? 0) || 0) || null
      : null,
    progressEstimated: progressEstimated || (totalBytesEstimated && status !== 'completed' && !indeterminate),
    indeterminate,
    speedBps: status === 'paused' ? 0 : speedBps,
    etaSeconds: Math.max(0, Number(batch?.eta_seconds ?? batch?.etaSeconds ?? 0) || 0) || null,
    kind: 'playlist',
    engine: 'yt-dlp',
    stage,
    thumbnail: thumbnails[0] || String(batch?.thumbnail || ''),
    playlistThumbnails: thumbnails,
    playlistTotal: total,
    playlistCompleted: completed,
    playlistFailed: failed,
    playlistActive: active,
    sourceUrl: String(batch?.source_url || batch?.sourceUrl || ''),
    createdAt: String(batch?.created_at || batch?.createdAt || ''),
    updatedAt: String(batch?.updated_at || batch?.updatedAt || batch?.created_at || batch?.createdAt || ''),
    destination,
    category: 'Playlist',
    origin: 'yt-dlp',
    extension: 'LISTA',
    lastError: String(batch?.last_error || batch?.lastError || ''),
    speedLimitBps: (() => {
      const value = Number(batch?.speed_limit_bps ?? batch?.speedLimitBps);
      return Number.isFinite(value) && value >= 0 ? Math.floor(value) : null;
    })(),
    priority: normalizePriority(batch?.priority)
  };
}

export function normalizeJobs(snapshot = {}, pendingJobs = []) {
  const pending = Array.isArray(pendingJobs) ? pendingJobs : [];
  const persisted = Array.isArray(snapshot.jobs) ? snapshot.jobs : [];
  const playlistBatches = Array.isArray(snapshot.playlist_batches)
    ? snapshot.playlist_batches.map(normalizePlaylistBatch)
    : [];
  const deduplicated = new Map();
  [...pending, ...persisted].forEach((job, index) => {
    const numericId = Number(job?.id);
    const fallbackParts = [
      String(job?.title || ''),
      String(job?.destination || job?.output_path || job?.outputPath || ''),
      String(job?.source_url || job?.sourceUrl || '')
    ];
    const fallbackKey = fallbackParts.some(Boolean) ? fallbackParts.join('\u0000') : `anonymous:${index}`;
    const key = Number.isFinite(numericId) ? `id:${numericId}` : `fallback:${fallbackKey}`;
    deduplicated.set(key, { job, index });
  });
  const regularJobs = [...deduplicated.values()].map(({ job, index }) => {
    let status = String(job.status || 'queued');
    const rawTotal = Number(job.total_bytes ?? job.totalBytes ?? 0);
    const total = Number.isFinite(rawTotal) && rawTotal > 0 ? Math.floor(rawTotal) : null;
    const totalBytesEstimated = Boolean(job.total_bytes_estimated ?? job.totalBytesEstimated);
    const progressEstimated = Boolean(job.progress_estimated ?? job.progressEstimated);
    const rawDownloaded = Number(job.downloaded_bytes ?? job.downloadedBytes ?? 0);
    const downloaded = Math.max(0, Math.floor(Number.isFinite(rawDownloaded) ? rawDownloaded : 0));
    const speedBps = Math.max(0, Number(job.speed_bps ?? job.speedBps ?? 0) || 0);
    const activeStream = Array.isArray(job.streams)
      && job.streams.some((stream) => ['preparing', 'downloading'].includes(String(stream.phase || '')));
    const exactDownloaded = total && !totalBytesEstimated ? Math.min(downloaded, total) : downloaded;
    const reportedProgress = clampNumber(job.progress ?? 0, 0, 100);
    const liveEvidence = downloaded > 0 || speedBps > 0 || activeStream || (reportedProgress > 0 && reportedProgress < 100);
    if (status === 'queued' && liveEvidence) status = 'running';
    const stage = String(job.stage || status);
    const processing = status === 'running' && ['Combinando video y audio', 'Convirtiendo', 'Validando', 'Preparando', 'Procesando', 'Finalizando'].includes(stage);
    const progress = status === 'completed'
      ? 100
      : total && !totalBytesEstimated
        ? clampNumber(exactDownloaded * 100 / total, 0, 99.9)
        : reportedProgress;
    const hasUsefulProgress = Number.isFinite(Number(job.progress)) && Number(job.progress) > 0;
    const indeterminate = status === 'running'
      && !hasUsefulProgress
      && (processing || Boolean(job.indeterminate) || (total == null && !progressEstimated));
    const rawExtension = jobFileExtension(job);
    const effectiveKind = effectiveJobKind({ ...job, extension: rawExtension });
    const normalized = {
      ...job,
      id: Number(job.id ?? -(index + 1)),
      addedOrder: positiveOrder(job.added_order ?? job.addedOrder) ?? positiveOrder(job.id),
      title: String(job.title || 'Descarga sin nombre'),
      detail: String(job.detail || ''),
      status,
      progress,
      downloadedBytes: exactDownloaded,
      totalBytes: total,
      totalBytesEstimated,
      progressEstimated,
      finalSize: status === 'completed' && !totalBytesEstimated
        ? (Number(job.final_size ?? job.finalSize ?? total ?? 0) || 0) || null
        : null,
      progressEstimated: progressEstimated || (totalBytesEstimated && status !== 'completed' && !indeterminate),
      indeterminate,
      speedBps: status === 'paused' ? 0 : speedBps,
      speedLimitBps: (() => {
        const raw = job.speed_limit_bps ?? job.speedLimitBps;
        const value = Number(raw);
        return Number.isFinite(value) && value >= 0 ? Math.floor(value) : null;
      })(),
      etaSeconds: Number(job.eta_seconds ?? job.etaSeconds ?? 0) || null,
      kind: effectiveKind,
      engine: String(job.engine || (job.kind === 'media' ? 'yt-dlp' : 'aria2c')),
      stage,
      thumbnail: (() => {
        const sourceUrl = String(job.source_url || job.sourceUrl || '');
        // YouTube's extractor also returns signed CDN thumbnail variants.
        // Prefer the stable public image derived from the video id so a
        // completed row does not regress to the generic placeholder later.
        return youtubeThumbnailFromSource(sourceUrl) || String(job.thumbnail || '');
      })(),
      sourceUrl: String(job.source_url || job.sourceUrl || ''),
      createdAt: String(job.created_at || job.createdAt || ''),
      updatedAt: String(job.updated_at || job.updatedAt || job.created_at || job.createdAt || ''),
      destination: String(job.destination || job.output_path || job.outputPath || ''),
      activeConnections: Math.max(0, Number(job.active_connections ?? job.activeConnections ?? 0) || 0),
      maxConnections: Math.max(0, Number(job.max_connections ?? job.maxConnections ?? 0) || 0),
      priority: normalizePriority(job.priority)
    };
    normalized.category = inferCategory(normalized);
    normalized.origin = inferOrigin(normalized);
    normalized.extension = rawExtension.toUpperCase() || normalized.kind.toUpperCase();
    return normalized;
  });
  return [...playlistBatches, ...regularJobs].sort(compareByInsertion);
}

export function statusCounts(jobs) {
  return jobs.reduce((counts, job) => {
    counts.all += 1;
    counts[job.status] = (counts[job.status] || 0) + 1;
    return counts;
  }, { all: 0, running: 0, queued: 0, paused: 0, completed: 0, failed: 0, cancelled: 0 });
}

export function filteredJobs(jobs, preferences) {
  const query = preferences.query.trim().toLocaleLowerCase('es');
  return jobs.filter((job) => {
    const statusMatches = preferences.filter === 'all' || job.status === preferences.filter;
    const category = preferences.category;
    const categoryMatches = category === 'all'
      || (category === '__pending' && ['queued', 'paused', 'cancelled'].includes(job.status))
      || (category === '__running' && job.status === 'running')
      || (category === '__completed' && job.status === 'completed')
      || (category === '__failed' && job.status === 'failed')
      || job.category === category;
    const queryMatches = !query || `${job.title} ${job.detail} ${job.category} ${job.origin}`.toLocaleLowerCase('es').includes(query);
    return statusMatches && categoryMatches && queryMatches;
  });
}

export function jobsForSection(jobs, preferences, section = preferences.section) {
  const terminal = new Set(['completed', 'failed', 'cancelled']);
  let scoped = jobs;
  if (section === 'news') scoped = [];
  else if (section === 'queue') scoped = jobs.filter((job) => ['queued', 'paused'].includes(job.status));
  else if (section === 'running') scoped = jobs.filter((job) => job.status === 'running');
  else if (section === 'completed') scoped = jobs.filter((job) => job.status === 'completed');
  else if (section === 'history') scoped = jobs.filter((job) => terminal.has(job.status));
  const ignoreStatusFilter = ['news', 'queue', 'running', 'completed', 'history'].includes(section);
  return filteredJobs(scoped, ignoreStatusFilter ? { ...preferences, filter: 'all' } : preferences);
}

export const LONG_LIST_VIRTUALIZATION_POLICIES = Object.freeze({
  history: Object.freeze({ threshold: 120, estimatedRowHeight: 92 }),
  completed: Object.freeze({ threshold: 160, estimatedRowHeight: 92 })
});

export function longListVirtualizationPolicy(section, count) {
  const policy = LONG_LIST_VIRTUALIZATION_POLICIES[section];
  if (!policy || Number(count) <= policy.threshold) return null;
  return { section, ...policy };
}

export function sectionForLayout(preferences) {
  const sections = new Set(['downloads', 'queue', 'running', 'completed', 'history', 'categories', 'scheduler', 'settings', 'news']);
  return sections.has(preferences.section) ? preferences.section : 'downloads';
}

export function categoriesFromJobs(jobs) {
  return [...new Set(jobs.map((job) => job.category).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'es'));
}

export function selectedJob(jobs, preferences) {
  return jobs.find((job) => job.id === preferences.selectedJobId)
    || jobs.find((job) => ['running', 'queued', 'paused'].includes(job.status))
    || jobs[0]
    || null;
}

export function isVisuallySelected(jobId, preferences = {}, selectionMode = false, selectedJobIds = new Set()) {
  const numericId = Number(jobId);
  if (!Number.isFinite(numericId)) return false;
  if (selectionMode) return Boolean(selectedJobIds?.has?.(numericId));
  const explicitId = Number(preferences.selectedJobId);
  return Number.isFinite(explicitId) && numericId === explicitId;
}

export function totalSpeed(jobs) {
  return jobs
    .filter((job) => job.status === 'running' && Number(job.speedBps) > 0)
    .reduce((total, job) => total + Math.max(0, Number(job.speedBps) || 0), 0);
}

export function connectionCapacity(jobs) {
  return jobs
    .filter((job) => job.status === 'running')
    .reduce((total, job) => total + (job.engine === 'aria2c' ? 16 : 1), 0);
}

export function formatBytes(bytes) {
  const value = Number(bytes);
  if (!Number.isFinite(value) || value < 0) return '—';
  if (value === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let result = value;
  let unit = 0;
  while (result >= 1024 && unit < units.length - 1) { result /= 1024; unit += 1; }
  return `${result >= 100 ? result.toFixed(0) : result >= 10 ? result.toFixed(1) : result.toFixed(2)} ${units[unit]}`;
}

export function formatSpeed(value) {
  const bytes = Number(value || 0);
  return bytes > 0 ? `${formatBytes(bytes)}/s` : '—';
}

export function formatEta(seconds) {
  const value = Math.max(0, Number(seconds || 0));
  if (!value) return '—';
  const hours = Math.floor(value / 3600);
  const minutes = Math.floor((value % 3600) / 60);
  const rest = Math.floor(value % 60);
  if (hours) return `${hours}h ${String(minutes).padStart(2, '0')}m`;
  if (minutes) return `${minutes}m ${String(rest).padStart(2, '0')}s`;
  return `${rest}s`;
}

export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[character]);
}
