import { effectiveJobKind, escapeHtml, formatBytes, formatSpeed, isPlayableJob, isVisuallySelected, jobFileExtension, statusCounts, thumbnailUrl, totalSpeed, youtubeThumbnailFromSource } from '../core/model.js';
import { dmFileAsset, dmIcon, dmPlaylistLogo } from './icons.js';
import { floatingRowMenu, jobActionButton, progressMarkup, progressValueLabel, rowMenu, statusLabel } from './shared.js?v=0.45.1-runtime-20260903';

function listThumbnailUrl(value) {
  let source = String(value || '').trim();
  try {
    const url = new URL(source);
    if (/^(?:i\.)?ytimg\.com$/i.test(url.hostname)) {
      url.pathname = url.pathname.replace(/\/(?:maxresdefault|sddefault|hqdefault|default)\.jpg$/i, '/mqdefault.jpg');
      source = url.toString();
    }
  } catch { /* thumbnailUrl handles non-URL values below */ }
  return thumbnailUrl(source);
}

function deferredThumbnailMarkup(value, className = '', options = {}) {
  const original = String(value || '').trim();
  if (!original) return '';
  const eager = options?.eager === true;
  const loadAttributes = eager ? 'loading="eager" fetchpriority="high"' : 'loading="lazy"';
  return `<img class="${className}" data-dm-thumbnail data-dm-thumbnail-src="${escapeHtml(listThumbnailUrl(original))}" data-original-thumbnail="${escapeHtml(original)}" data-dm-thumbnail-eager="${eager ? '1' : '0'}" alt="" ${loadAttributes} decoding="async" referrerpolicy="no-referrer">`;
}

export function inputDetection(value = '') {
  const query = String(value || '').trim();
  if (!query) return { label: 'Entrada universal', icon: 'sparkles', kind: 'empty' };
  if (/^magnet:/i.test(query)) return { label: 'Magnet detectado', icon: 'magnet', kind: 'torrent' };
  if (/\.torrent(?:$|[?#])/i.test(query)) return { label: 'Torrent detectado', icon: 'magnet', kind: 'torrent' };
  if (/^https?:\/\//i.test(query)) {
    if (/[?&]list=|\/playlist|\/album/i.test(query)) return { label: 'Playlist', icon: 'playlist', kind: 'playlist' };
    if (/youtube|youtu\.be|vimeo|dailymotion|instagram|tiktok|twitter|x\.com|pinterest|spotify/i.test(query)) return { label: 'Multimedia', icon: 'video', kind: 'media' };
    return { label: 'Enlace detectado', icon: 'link', kind: 'link' };
  }
  return { label: 'Búsqueda de vídeo', icon: 'search', kind: 'search' };
}

function searchThumbnailMarkup(item, index) {
  let source = String(youtubeThumbnailFromSource(item.sourceUrl || '') || item.thumbnail || '').trim();
  if (!source) return dmIcon(item.icon || (item.sourceUrl ? 'video' : 'search'), 22);
  try {
    const url = new URL(source);
    if (/^(?:i\.)?ytimg\.com$/i.test(url.hostname)) {
      url.pathname = url.pathname.replace(/\/(?:maxresdefault|sddefault|hqdefault|default)\.jpg$/i, '/mqdefault.jpg');
      source = url.toString();
    }
  } catch { /* thumbnailUrl handles non-URL values below */ }
  source = thumbnailUrl(source);
  const loadAttribute = index < 6 ? `data-dm-thumbnail-eager="1" loading="eager" fetchpriority="${index < 3 ? 'high' : 'auto'}"` : 'loading="lazy"';
  return `<img data-dm-thumbnail data-dm-thumbnail-src="${escapeHtml(source)}" data-original-thumbnail="${escapeHtml(item.thumbnail)}" ${loadAttribute} alt="" decoding="async" referrerpolicy="no-referrer">`;
}

export function compactStatsMarkup(jobs) {
  const counts = statusCounts(jobs);
  return `<section class="dm-compact-stats" aria-label="Resumen de descargas">
    <span data-dm-stat="running"><small>Activas</small><strong>${counts.running}</strong></span>
    <span data-dm-stat="completed"><small>Completadas</small><strong>${counts.completed}</strong></span>
    <span data-dm-stat="speed"><small>Velocidad</small><strong>${escapeHtml(formatSpeed(totalSpeed(jobs)))}</strong></span>
  </section>`;
}

export function unifiedSuggestionPanelMarkup(context, queryValue = context.unifiedQuery) {
  const query = String(queryValue || '');
  const detection = inputDetection(query);
  const suggestions = Array.isArray(context.unifiedSuggestions) ? context.unifiedSuggestions : [];
  const showSuggestions = Boolean(context.unifiedFocused && query.trim() && detection.kind === 'search');
  if (!showSuggestions) return '';
  const activeIndex = Math.max(-1, Math.min(suggestions.length - 1, Number(context.unifiedActiveIndex ?? -1)));
  return `<div class="dm-unified-suggestions" id="dm-unified-suggestion-list" role="listbox" aria-label="Sugerencias de búsqueda">
    <header><span>RESULTADOS DE VÍDEO</span>${context.unifiedSuggestionBusy ? '<span class="dm-suggestion-refresh"><i></i> Cargando más resultados</span>' : '<small>Listos</small>'}</header>
    ${context.unifiedSuggestionBusy ? `<div class="dm-suggestion-skeletons" aria-label="Cargando resultados">${[0,1,2].map(() => '<i><b></b><span><em></em><em></em></span></i>').join('')}</div>` : ''}
    ${suggestions.length ? suggestions.slice(0, 20).map((item, index) => `<button type="button" id="dm-suggestion-${index}" role="option" aria-selected="${index === activeIndex}" class="${index === activeIndex ? 'is-active' : ''}" data-dm-suggestion-index="${index}">
      <span class="dm-suggestion-visual">${searchThumbnailMarkup(item, index)}${item.sourceUrl ? `<span class="dm-suggestion-play" data-dm-preview-suggestion="${escapeHtml(item.sourceUrl)}" role="button" tabindex="0" aria-label="Reproducir ${escapeHtml(item.title)}" title="Reproducir">${dmIcon('play', 20)}</span>` : ''}${item.duration ? `<small>${escapeHtml(item.duration)}</small>` : ''}</span>
      <span><strong>${escapeHtml(item.title)}</strong><small>${escapeHtml(item.subtitle || (item.sourceUrl ? 'Vídeo encontrado' : 'Sugerencia de YouTube'))}</small></span>
      ${dmIcon('chevron', 18)}
    </button>`).join('') : `<div class="dm-suggestion-empty">${dmIcon('search', 24)}<span>Sigue escribiendo para buscar coincidencias.</span></div>`}
    <footer><span>↑↓ para navegar · Enter para analizar</span><span>Ctrl + K enfoca el buscador</span></footer>
  </div>`;
}

export function unifiedDetectionMarkup() {
  return '';
}

export function unifiedSearchMarkup(context, variant = 'zen') {
  const query = String(context.unifiedQuery || '');
  const placeholder = 'Pega un enlace, torrent, archivo, playlist o busca un vídeo…';
  return `<section class="dm-unified-search dm-unified-${variant}">
    <div class="dm-unified-input-wrap ${query ? 'has-value' : ''}">
      ${dmIcon('search', 24)}
      <input data-dm-unified-input value="${escapeHtml(query)}" placeholder="${placeholder}" autocomplete="off" spellcheck="false" role="combobox" aria-autocomplete="list" aria-controls="dm-unified-suggestion-list" aria-expanded="${Boolean(context.unifiedFocused && query.trim())}" aria-activedescendant="${Number(context.unifiedActiveIndex) >= 0 ? `dm-suggestion-${Number(context.unifiedActiveIndex)}` : ''}" aria-label="Entrada universal de descarga">
      <button type="button" class="dm-unified-clear" data-dm-unified-clear aria-label="Limpiar" ${query ? '' : 'hidden'}>${dmIcon('x', 19)}</button>
      <button type="button" class="dm-unified-submit" data-dm-unified-submit ${context.unifiedBusy ? 'disabled' : ''}>${context.unifiedBusy ? '<i></i><span>Analizando…</span>' : `${dmIcon('sparkles', 19)}<span>Analizar</span>`}</button>
    </div>
    ${unifiedDetectionMarkup(query)}
    ${unifiedSuggestionPanelMarkup(context, query)}
  </section>`;
}

export function helperChipsMarkup({ disabled = false } = {}) {
  const inactive = disabled ? ' disabled aria-disabled="true" tabindex="-1" class="is-inactive"' : '';
  return `<section class="dm-helper-chips" aria-label="Accesos de entrada">
    <button type="button" data-dm-paste-link${inactive}>${dmIcon('clipboard', 17)}<span>Pegar</span></button>
    <button type="button" data-dm-add-torrent${inactive}>${dmIcon('magnet', 17)}<span>Torrent</span></button>
    <button type="button" data-dm-new-download${inactive}>${dmIcon('file', 17)}<span>Archivo o enlace</span></button>
    <button type="button" data-dm-focus-unified${inactive}>${dmPlaylistLogo(16)}<span>Playlist</span></button>
  </section>`;
}

const stablePlaylistStacks = new Map();
const MAX_STABLE_PLAYLIST_STACKS = 160;

function stablePlaylistStack(job = {}) {
  const key = String(job.playlistBatchId || job.id || job.title || 'playlist');
  const incoming = Array.isArray(job.playlistThumbnails)
    ? [...new Set(job.playlistThumbnails.map((value) => String(value || '').trim()).filter(Boolean))]
    : [];
  const stable = [...(stablePlaylistStacks.get(key) || [])];
  for (const thumbnail of incoming) {
    if (stable.length >= 3) break;
    if (!stable.includes(thumbnail)) stable.push(thumbnail);
  }
  if (stable.length) {
    stablePlaylistStacks.delete(key);
    stablePlaylistStacks.set(key, stable);
    while (stablePlaylistStacks.size > MAX_STABLE_PLAYLIST_STACKS) {
      stablePlaylistStacks.delete(stablePlaylistStacks.keys().next().value);
    }
  }
  return stable.slice(0, 3);
}

function playlistVisual(job, large = false) {
  const thumbnails = stablePlaylistStack(job);
  const layers = [
    // Keep the first artwork in front while exposing a deliberate slice of
    // the following covers. The right inset keeps every layer inside the
    // visual frame even when the stack is rendered at the compact card size.
    ['0', '0', '3', '.45rem'],
    ['.34rem', '.10rem', '2', '.55rem'],
    ['.82rem', '.20rem', '1', '.90rem']
  ];
  return `<span class="dm-playlist-stack ${large ? 'is-large' : ''}">
    ${layers.map(([x, y, z, right], index) => thumbnails[index]
      ? `<i style="--stack-x:${x};--stack-y:${y};--stack-z:${z};--stack-right:${right}">${deferredThumbnailMarkup(thumbnails[index])}<span class="dm-thumbnail-fallback" aria-hidden="true">${dmPlaylistLogo(large ? 20 : 16)}</span></i>`
      : `<i style="--stack-x:${x};--stack-y:${y};--stack-z:${z};--stack-right:${right}">${dmPlaylistLogo(large ? 20 : 16)}</i>`).join('')}
    <b>${job.playlistTotal || ''}</b>
  </span>`;
}

function fileVisual(job) {
  if (job.kind === 'playlist') return ['playlist', 'playlist'];
  const kind = effectiveJobKind(job);
  const visualByKind = {
    pdf: ['pdf', 'pdf'], document: ['document', 'document'], ebook: ['ebook', 'ebook'],
    font: ['font', 'font'], text: ['file', 'text'], code: ['file', 'code'],
    sheet: ['sheet', 'sheet'], presentation: ['presentation', 'presentation'],
    archive: ['archive', 'archive'], package: ['package', 'package'], image: ['image', 'image'],
    disk: ['disc', 'disk'], video: ['video', 'video'], media: ['video', 'video'], audio: ['audio', 'audio'],
    torrent: ['magnet', 'torrent']
  };
  return visualByKind[kind] || ['file', 'generic'];
}

function typeMeta(job) {
  const [iconName, visualType] = fileVisual(job);
  // One presentation authority keeps card metadata compact without changing
  // the internal kind/category used by filters, MIME detection or backends.
  const labels = { video: 'Vídeo', audio: 'Audio', playlist: 'Playlist', document: 'Documento', pdf: 'PDF', ebook: 'E-book', font: 'Fuente', text: 'Texto', code: 'Código', sheet: 'Hoja', presentation: 'Presentación', archive: 'Comprimido', package: 'Aplicación', image: 'Imagen', disk: 'Disco', torrent: 'Torrent', generic: 'Archivo' };
  return { iconName, label: labels[visualType] || 'Archivo', visualType };
}

function hasPreviewThumbnail(job) {
  if (job.kind === 'playlist') {
    return Boolean(String(job.thumbnail || '').trim() || (Array.isArray(job.playlistThumbnails) && job.playlistThumbnails.some(Boolean)));
  }
  return Boolean(String(job.thumbnail || '').trim());
}

function rowTypeLabel(job, type) {
  const extension = jobFileExtension(job).toUpperCase();
  if (['video', 'audio', 'image'].includes(type.visualType) && extension) return extension;
  if (type.visualType === 'package') return extension || 'Aplicación';
  if (type.visualType === 'pdf') return 'PDF';
  if (type.visualType === 'document') return 'Documento';
  if (type.visualType === 'archive') return 'Comprimido';
  if (type.visualType === 'generic') return 'Archivo';
  return type.label;
}

function rowTypeIcon(job, type) {
  if (!hasPreviewThumbnail(job)) return '';
  if (type.visualType === 'playlist') return dmPlaylistLogo(11);
  if (type.visualType === 'video' || type.visualType === 'audio') return dmFileAsset(type.visualType, 'is-inline');
  return '';
}

function jobVisual(job) {
  if (job.kind === 'playlist') {
    const visual = playlistVisual(job);
    const playable = Number(job.playlistCompleted || 0) > 0 && Number(job.playlistBatchId || 0) > 0;
    return playable
      ? `<button type="button" class="dm-player-trigger dm-playlist-player-trigger" data-dm-open-playlist-player="${job.playlistBatchId}" aria-label="Reproducir playlist ${escapeHtml(job.title)}">${visual}<i class="dm-player-overlay" aria-hidden="true"></i></button>`
      : visual;
  }
  const effectiveKind = effectiveJobKind(job);
  const playableKind = isPlayableJob(job);
  const playableClass = playableKind ? ' is-playable' : '';
  const visual = job.thumbnail
    ? `<span class="dm-job-thumb${playableClass}">${deferredThumbnailMarkup(job.thumbnail, '', { eager: true })}<i class="dm-thumbnail-fallback">${dmIcon(effectiveKind === 'audio' ? 'audio' : (playableKind ? 'video' : 'file'), 25)}</i>${playableKind ? '<i class="dm-player-overlay" aria-hidden="true"></i>' : ''}</span>`
    : (() => { const [icon, visualType] = fileVisual(job); const asset = dmFileAsset(visualType, 'is-large'); return `<span class="dm-job-file file-${visualType}${playableClass}">${asset || dmIcon(icon, 27)}${playableKind ? '<i class="dm-player-overlay" aria-hidden="true"></i>' : ''}</span>`; })();
  return playableKind
    ? `<button type="button" class="dm-player-trigger" data-dm-open-player="${job.id}" aria-label="Abrir ${escapeHtml(job.title)} en el reproductor">${visual}</button>`
    : visual;
}

function alternativesMarkup(job, recovery) {
  if (job.status !== 'failed' || !isPlayableJob(job)) return '';
  const alternatives = Array.isArray(recovery?.alternatives) ? recovery.alternatives.slice(0, 3) : [];
  if (!recovery) return `<div class="dm-inline-recovery is-loading" data-job-id="${job.id}"><span>${dmIcon('sparkles', 20)}</span><div><strong>Comprobando el error y buscando alternativas…</strong><small>Se hará automáticamente; no necesitas abrir otra ventana.</small></div><i></i></div>`;
  if (!alternatives.length) return `<div class="dm-inline-recovery is-empty" data-job-id="${job.id}"><span>${dmIcon('shield', 20)}</span><div><strong>${escapeHtml(recovery?.diagnosis?.title || 'No se encontró una alternativa fiable')}</strong><small>${escapeHtml(recovery?.message || recovery?.diagnosis?.summary || 'Puedes reintentar la fuente original conservando el parcial.')}</small></div><button data-dm-recover-job="${job.id}">Ver diagnóstico</button></div>`;
  return `<div class="dm-inline-recovery" data-job-id="${job.id}">
    <div class="dm-recovery-copy"><span>${dmIcon('shield', 21)}</span><div><strong>${escapeHtml(recovery?.diagnosis?.title || 'Alternativas encontradas')}</strong><small>${escapeHtml(recovery?.message || 'El origen falló; elige una coincidencia para sustituirlo.')}</small></div></div>
    <div class="dm-inline-alternatives">${alternatives.map((item, index) => `<article>
      <span>${item.thumbnail ? deferredThumbnailMarkup(item.thumbnail) : dmIcon('video', 18)}<small>${escapeHtml(item.duration_label || '')}</small></span>
      <div><strong>${escapeHtml(item.title || `Alternativa ${index + 1}`)}</strong><small>${escapeHtml(item.creator || '')}</small></div>
      <button data-dm-analyze-result="${escapeHtml(item.source_url || '')}">Usar</button>
    </article>`).join('')}</div>
    <button class="dm-recovery-more" data-dm-recover-job="${job.id}">Ver todas</button>
  </div>`;
}

function stableRowSignature(job) {
  const value = [
    job.title,
    job.kind,
    job.thumbnail,
    job.category,
    job.origin,
    job.extension,
    job.destination,
    job.priority,
    job.playlistBatchId,
    job.playlistTotal,
    ...(Array.isArray(job.playlistThumbnails) ? job.playlistThumbnails : [])
  ].join('\u001f');
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function stableRowContentSignature(job) {
  const value = [
    job.title,
    job.kind,
    job.category,
    job.origin,
    job.extension,
    job.destination,
    job.priority,
    job.playlistBatchId,
    job.playlistTotal
  ].join('\u001f');
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function liveRowSignature(job, visibleDetail, statusText, size, sizeDetail) {
  return [
    job.status,
    job.stage,
    visibleDetail,
    statusText,
    Number(job.progress || 0).toFixed(3),
    Number(job.downloadedBytes || 0),
    Number(job.totalBytes || 0),
    job.totalBytesEstimated ? 1 : 0,
    job.progressEstimated ? 1 : 0,
    Number(job.finalSize || 0),
    Number(job.speedBps || 0).toFixed(2),
    Number(job.etaSeconds || 0),
    job.indeterminate ? 1 : 0,
    job.playlistCompleted || 0,
    job.playlistFailed || 0,
    job.playlistActive || 0,
    job.priority,
    size,
    sizeDetail
  ].join('\u001f');
}

function priorityMetaMarkup(job) {
  if (!['running', 'queued', 'paused', 'failed'].includes(job.status)) return '';
  const priority = ['high', 'low'].includes(job.priority) ? job.priority : 'normal';
  // Normal is the implicit/default state. It remains selectable in the menu,
  // but it should not consume card metadata width.
  if (priority === 'normal') return '';
  const label = { high: 'Alta', normal: 'Normal', low: 'Baja' }[priority];
  const marker = priority === 'high' ? '<span class="dm-priority-marker" aria-hidden="true">↑</span>'
    : priority === 'low' ? '<span class="dm-priority-marker" aria-hidden="true">↓</span>' : '';
  return `<span class="dm-priority-meta is-${priority}" title="Prioridad ${label.toLowerCase()}">${marker}<span>${label}</span></span>`;
}

export function downloadVisualState(job, processing = null) {
  const status = String(job?.status || '').toLowerCase();
  const stage = String(job?.stage || '').toLowerCase();
  if (status === 'running' && stage.includes('finaliz')) return 'finalizing';
  if (status === 'running' && processing === true) return 'processing';
  if (status === 'running') return 'downloading';
  if (status === 'queued') return 'queued';
  if (status === 'paused') return 'paused';
  if (status === 'completed') return 'completed';
  if (status === 'failed') return 'error';
  return status || 'unknown';
}

export function downloadRowState(job) {
  const completed = job.status === 'completed';
  const processing = !completed && job.status === 'running' && ['Combinando video y audio', 'Convirtiendo', 'Validando', 'Preparando', 'Procesando', 'Finalizando'].includes(String(job.stage || ''));
  const displayedTotal = completed && job.finalSize ? job.finalSize : job.totalBytes;
  const totalLabel = displayedTotal ? `${job.totalBytesEstimated ? '~' : ''}${formatBytes(displayedTotal)}` : '';
  const transferPrimary = completed && displayedTotal
      ? formatBytes(displayedTotal)
      : processing
        ? 'Procesando…'
      : displayedTotal
        ? `${formatBytes(job.downloadedBytes)} /`
        : formatBytes(job.downloadedBytes);
  const transferSecondary = !processing && !completed && displayedTotal ? totalLabel : '';
  const liveSpeed = !processing && job.status === 'running' && Number(job.speedBps || 0) > 0
    ? formatSpeed(job.speedBps)
    : '';
  const statusText = job.kind === 'playlist' && job.status === 'completed'
    ? `${job.playlistCompleted || job.playlistTotal || 0}/${job.playlistTotal || 0} completados`
    : job.status === 'running'
      ? (processing ? 'Procesando…' : liveSpeed || String(job.stage || 'Descargando'))
      : statusLabel(job.status);
  return {
    size: `${transferPrimary}\u001e${transferSecondary}`,
    transferPrimary,
    transferSecondary,
    processing,
    statusText,
    visualState: downloadVisualState(job, processing),
    structureSignature: stableRowSignature(job),
    liveSignature: liveRowSignature(job, '', statusText, transferPrimary, transferSecondary)
  };
}

// Kept for recovery panels and diagnostic consumers; it is intentionally not
// rendered inside the compact Download Manager row.
export function directDownloadErrorHint(job) {
  if (job.status !== 'failed') return '';
  const detail = String(job.detail || '').toLowerCase();
  if (detail.includes('403') || detail.includes('sesión') || detail.includes('cookies')) {
    return 'El servidor exige una sesión o un enlace temporal; vuelve a iniciar la descarga desde la página original.';
  }
  if (detail.includes('página web') || detail.includes('html')) {
    return 'La dirección devuelve una página de acceso, no el archivo; usa el botón de descarga directa del sitio.';
  }
  if (detail.includes('unsupported url') || detail.includes('no es compatible')) {
    return 'El servidor usa una ruta intermedia; analiza la página original o copia el enlace final.';
  }
  if (detail.includes('error interno del extractor') || detail.includes('traceback')) {
    return 'Fallo interno de yt-dlp, no de tu conexión. Suele resolverse solo; si se repite mucho, actualiza la app.';
  }
  return 'El parcial se conserva cuando el origen lo permite; puedes reintentar después de corregir el enlace.';
}

export function downloadRowMarkup(job, index, selectedId, rowMenuJobId, rowMenuPosition, recovery, selectionMode = false, selectedJobIds = new Set()) {
  const { transferPrimary, transferSecondary, processing, statusText, visualState, structureSignature, liveSignature } = downloadRowState(job);
  const contentSignature = stableRowContentSignature(job);
  const batchSelected = Boolean(selectionMode && selectedJobIds?.has?.(Number(job.id)));
  const isVisualSelected = isVisuallySelected(job.id, { selectedJobId: selectedId }, selectionMode, selectedJobIds);
  const isSingleSelected = Boolean(!selectionMode && isVisualSelected);
  const type = typeMeta(job);
  return `<article class="dm-download-item ${isSingleSelected ? 'is-selected' : ''} ${isVisualSelected ? 'is-visually-selected' : ''} ${selectionMode ? 'has-selection' : ''} ${batchSelected ? 'is-batch-selected' : ''} is-${escapeHtml(job.status)} kind-${escapeHtml(job.kind)}" data-dm-select-job="${job.id}" data-dm-state="${escapeHtml(job.status)}" data-dm-visual-state="${escapeHtml(visualState)}" data-dm-stage="${escapeHtml(job.stage || '')}" data-dm-processing="${processing ? 'true' : 'false'}" data-dm-row-structure="${structureSignature}" data-dm-row-content="${contentSignature}" data-dm-row-live="${escapeHtml(liveSignature)}" data-dm-drag-path="${job.status === 'completed' && job.destination ? escapeHtml(job.destination) : ''}" draggable="${job.status === 'completed' && job.destination ? 'true' : 'false'}" aria-selected="${isVisualSelected ? 'true' : 'false'}" tabindex="0">
    <span class="dm-item-index" aria-hidden="true">${index + 1}</span>
    ${selectionMode ? `<label class="dm-row-select" title="Seleccionar esta descarga"><input type="checkbox" data-dm-select-checkbox="${job.id}" ${batchSelected ? 'checked' : ''} aria-label="Seleccionar ${escapeHtml(job.title)}"><i></i></label>` : ''}
    ${jobVisual(job)}
    <div class="dm-item-body">
      <div class="dm-item-name">
        <strong title="${escapeHtml(job.title)}">${escapeHtml(job.title)}</strong>
        <div class="dm-item-subline">
          <span class="dm-item-type">${rowTypeIcon(job, type)}<span>${escapeHtml(rowTypeLabel(job, type))}</span></span>
          <div class="dm-item-status status-lane" title="${escapeHtml(statusText)}" aria-label="${escapeHtml(statusText)}"><i class="status-lane-icon-slot"></i><span class="status-lane-text-stage"><span class="status-lane-current">${escapeHtml(statusText)}</span></span></div>
          ${priorityMetaMarkup(job)}
        </div>
      </div>
      <div class="dm-item-meta"><span>${escapeHtml(job.category)}</span><small>${dmIcon('globe', 14)} ${escapeHtml(job.origin)}</small></div>
    </div>
    <div class="dm-item-progress${processing ? ' is-processing' : ''}" data-dm-analyzing="${processing ? 'true' : 'false'}">${processing ? `<div class="dm-progress-wrap dm-progress-processing-wrap"><div class="dm-progress dm-progress-processing is-indeterminate" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-label="${escapeHtml(statusText)}"><i aria-hidden="true"></i></div></div>` : progressMarkup(job)}</div>
    <strong class="dm-item-percentage">${escapeHtml(progressValueLabel(job))}</strong>
     <div class="dm-item-transfer ${processing ? 'is-processing' : ''}" aria-label="${escapeHtml(transferPrimary)}">${processing ? '' : `<strong>${escapeHtml(transferPrimary)}</strong>${transferSecondary ? `<small>${escapeHtml(transferSecondary)}</small>` : ''}`}</div>
    <div class="dm-item-actions">${jobActionButton(job)}${rowMenu(job, rowMenuJobId)}</div>
  </article>${alternativesMarkup(job, recovery)}`;
}

export function downloadAreaMarkup(context, visible, selectedId) {
  const recoveryByJobId = context.recoveryByJobId || {};
  if (!visible.length) return `<section class="dm-download-area is-empty">
    <header><span>Nombre</span><span>Estado</span><span>Progreso</span><span>Tamaño / ETA</span><span>Tipo</span><span></span></header>
    <div class="dm-download-empty"><div class="dm-empty-content"><div class="dm-empty-visual" aria-hidden="true"><span>${dmIcon('download', 28)}</span><i></i></div><div class="dm-empty-copy"><small>ÁREA DE DESCARGAS</small><strong>No hay descargas aquí todavía</strong><span>Pega un enlace, añade un torrent o busca un vídeo para comenzar.</span></div><button type="button" data-dm-focus-unified>${dmIcon('plus', 17)}<span>Nueva descarga</span></button></div></div>
  </section>`;
  const openMenuJob = context.jobs.find((job) => Number(job.id) === Number(context.rowMenuJobId));
  const virtualization = context.virtualization?.enabled ? context.virtualization : null;
  const start = virtualization ? Math.max(0, Number(virtualization.start) || 0) : 0;
  const end = virtualization ? Math.min(visible.length, Number(virtualization.end) || 0) : visible.length;
  const rows = visible.slice(start, end).map((job, index) => downloadRowMarkup(
    job,
    start + index,
    selectedId,
    context.rowMenuJobId,
    context.rowMenuPosition,
    recoveryByJobId[job.id],
    Boolean(context.selectionMode),
    context.selectedJobIds || new Set()
  )).join('');
  const list = virtualization
    ? `<div class="dm-download-scroll" data-dm-live-replaced="1" data-dm-virtual-list="1" data-dm-virtual-key="${escapeHtml(virtualization.key)}" data-dm-virtual-start="${start}" data-dm-virtual-end="${end}" data-dm-virtual-total="${visible.length}" tabindex="0" aria-label="Historial de descargas">
        <div class="dm-virtual-spacer" data-dm-virtual-spacer="top" style="height:${Math.max(0, Number(virtualization.topHeight) || 0)}px"></div>
        <div class="dm-virtual-window" data-dm-virtual-window>${rows}</div>
        <div class="dm-virtual-spacer" data-dm-virtual-spacer="bottom" style="height:${Math.max(0, Number(virtualization.bottomHeight) || 0)}px"></div>
      </div>`
    : `<div class="dm-download-scroll">${visible.map((job, index) => downloadRowMarkup(job, index, selectedId, context.rowMenuJobId, context.rowMenuPosition, recoveryByJobId[job.id], Boolean(context.selectionMode), context.selectedJobIds || new Set())).join('')}</div>`;
  return `<section class="dm-download-area${virtualization ? '" data-dm-live-replaced="1' : ''}">
    <header><span>Nombre</span><span>Estado</span><span>Progreso</span><span>Tamaño / ETA</span><span>Tipo</span><span></span></header>
    ${list}
    ${floatingRowMenu(openMenuJob, context.rowMenuJobId, context.rowMenuPosition)}
  </section>`;
}

export function minimalStatusFooter(context) {
  return '';
}
