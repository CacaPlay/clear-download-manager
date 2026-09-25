import { categoriesFromJobs, connectionCapacity, effectiveJobKind, escapeHtml, formatBytes, formatEta, formatSpeed, isPlayableJob, jobFileExtension, thumbnailUrl, youtubeThumbnailFromSource } from '../core/model.js';
import { dmFileAsset, dmIcon } from './icons.js';

export const statusLabel = (status) => ({ running: 'Descargando', queued: 'En cola', paused: 'En pausa', completed: 'Completada', failed: 'Error', cancelled: 'Cancelada' })[status] || status;

function sourceDescriptor(job) {
  const source = String(job.sourceUrl || '').trim();
  if (!source) return { host: 'Origen administrado', protocol: job.kind === 'torrent' ? 'BitTorrent' : 'Local', source: '' };
  if (/^magnet:/i.test(source)) return { host: 'Red BitTorrent', protocol: 'Magnet', source };
  try {
    const parsed = new URL(source);
    return { host: parsed.host || 'Servidor remoto', protocol: parsed.protocol.replace(':', '').toUpperCase(), source };
  } catch {
    return { host: 'Fuente administrada por el motor', protocol: job.kind === 'torrent' ? 'BitTorrent' : 'Local', source };
  }
}

function relatedFilesMarkup(job) {
  const destination = String(job.destination || '').trim();
  const transferActive = !['completed', 'cancelled'].includes(job.status);
  const finalLabel = job.kind === 'torrent' ? 'Carpeta del torrent' : job.kind === 'video' || job.kind === 'audio' || job.kind === 'media' ? 'Salida multimedia' : 'Archivo final';
  const temporary = job.kind === 'torrent'
    ? 'aria2c conserva el estado de la sesión y las piezas verificadas.'
    : job.kind === 'video' || job.kind === 'audio' || job.kind === 'media'
      ? 'yt-dlp y FFmpeg administran pistas y temporales dentro de la carpeta de trabajo.'
      : transferActive && destination ? `${destination}.part` : 'No hay un archivo parcial activo.';
  const temporaryIsPath = transferActive && Boolean(destination) && !['torrent', 'video', 'audio', 'media'].includes(job.kind);
  return `<section class="dm-inspector-files"><header>${dmIcon('file', 24)}<div><strong>Archivos relacionados</strong><span>Rutas reales conocidas por el trabajo seleccionado.</span></div></header><div class="dm-inspector-file-list">
    <article><span>${dmIcon(job.kind === 'torrent' ? 'folder' : 'file', 20)}</span><div><strong>${finalLabel}</strong><small title="${escapeHtml(destination)}">${escapeHtml(destination || 'Se asignará cuando el motor prepare la descarga.')}</small></div>${destination ? `<button data-dm-copy-value="${escapeHtml(destination)}" aria-label="Copiar ruta">${dmIcon('clipboard', 17)}</button>` : ''}</article>
    <article><span>${dmIcon('download', 20)}</span><div><strong>${transferActive ? 'Temporal y reanudación' : 'Estado final'}</strong><small title="${escapeHtml(temporary)}">${escapeHtml(temporary)}</small></div>${temporaryIsPath ? `<button data-dm-copy-value="${escapeHtml(temporary)}" aria-label="Copiar ruta temporal">${dmIcon('clipboard', 17)}</button>` : ''}</article>
    <article><span>${dmIcon('shield', 20)}</span><div><strong>Datos contabilizados</strong><small>${escapeHtml(job.totalBytes ? `${formatBytes(job.downloadedBytes)} de ${formatBytes(job.totalBytes)}` : formatBytes(job.downloadedBytes))} · ${Math.round(job.progress)}%</small></div></article>
  </div></section>`;
}

export function connectionsMarkup(job) {
  const source = sourceDescriptor(job);
  const resume = job.status === 'completed' ? 'Trabajo finalizado' : job.kind === 'torrent' ? 'Sesión y piezas persistentes' : 'Parcial conservable y reanudable';
  const mode = job.kind === 'torrent' ? 'Pares BitTorrent gestionados por aria2c' : ['video', 'audio', 'media'].includes(job.kind) ? 'Extractor yt-dlp; unión local con FFmpeg cuando hace falta' : 'Descarga HTTP con rangos y reintentos';
  const rows = [
    ['Motor', job.engine || 'Local'],
    ['Endpoint', source.host],
    ['Protocolo', source.protocol],
    ['Modo', mode],
    ['Transferencia', `${statusLabel(job.status)} · ${formatSpeed(job.speedBps)}`],
    ['Conexiones', job.status === 'running' ? `${connectionCapacity([job])} configurada${connectionCapacity([job]) === 1 ? '' : 's'}` : 'Sin conexiones activas'],
    ['Recuperación', resume],
  ];
  return `<section class="dm-inspector-connections"><header>${dmIcon('globe', 24)}<div><strong>Detalles avanzados</strong><span>Información técnica reportada por el motor local.</span></div></header><dl class="dm-connection-list">${rows.map(([key, value]) => `<div><dt>${escapeHtml(key)}</dt><dd>${escapeHtml(value)}</dd></div>`).join('')}</dl>${source.source ? `<div class="dm-source-address"><span>Enlace original</span><code title="${escapeHtml(source.source)}">${escapeHtml(source.source)}</code><button data-dm-copy-value="${escapeHtml(source.source)}" aria-label="Copiar enlace original">${dmIcon('clipboard', 17)}</button></div>` : '<p class="dm-source-empty">No hay un enlace original disponible para esta tarea.</p>'}</section>`;
}

function inspectorLogMarkup(job) {
  const events = [
    ['Estado', `${statusLabel(job.status)} · etapa ${job.stage || statusLabel(job.status)}`],
    ['Progreso', `${Math.round(job.progress)}% · ${job.totalBytes ? `${formatBytes(job.downloadedBytes)} / ${formatBytes(job.totalBytes)}` : formatBytes(job.downloadedBytes)}`],
    ['Motor', `${job.engine || 'Local'} · ${job.origin}`],
    ['Último detalle', job.detail || 'El motor no reportó mensajes adicionales.'],
  ];
  return `<section class="dm-inspector-log"><header>${dmIcon('terminal', 24)}<div><strong>Registro del trabajo #${job.id}</strong><span>Resumen persistente del último estado conocido.</span></div></header><div class="dm-log-lines">${events.map(([label, value]) => `<code><b>${escapeHtml(label)}</b><span>${escapeHtml(value)}</span></code>`).join('')}</div></section>`;
}

function categoryLabel(value) {
  return ({
    all: 'Categorías',
    __pending: 'Pendientes',
    __running: 'En ejecución',
    __completed: 'Completadas',
    __failed: 'Con errores',
    HTTP: 'Archivos',
    Torrents: 'Torrent',
    Video: 'Vídeo',
    Audio: 'Música'
  })[value] || String(value || 'Categorías');
}

export function categoryOptions(jobs, selected, open = false) {
  const statusOptions = [['__pending', 'Pendientes'], ['__running', 'En ejecución'], ['__completed', 'Completadas'], ['__failed', 'Con errores']];
  const categoryValues = categoriesFromJobs(jobs).filter((category) => !statusOptions.some(([value]) => value === category));
  const items = [['all', 'Todo'], ...statusOptions, ...categoryValues.map((category) => [category, categoryLabel(category)])];
  const selectedValue = items.some(([value]) => value === selected) ? selected : 'all';
  return `<div class="dm-category-control ${open ? 'is-open' : ''}" data-dm-category-control>
    <button type="button" class="dm-category-toggle" data-dm-category-toggle aria-haspopup="listbox" aria-expanded="${open ? 'true' : 'false'}" aria-label="Filtrar categorías">${dmIcon('list', 16)}<span data-dm-category-label>${escapeHtml(categoryLabel(selectedValue))}</span>${dmIcon('chevron', 15)}</button>
    <div class="dm-category-menu floating-position-root" data-dm-category-menu role="listbox" aria-label="Categorías disponibles" ${open ? '' : 'hidden'}><div class="motion-inner">${items.map(([value, label]) => `<button type="button" role="option" data-dm-category-option="${escapeHtml(value)}" aria-selected="${value === selectedValue ? 'true' : 'false'}" class="${value === selectedValue ? 'is-active' : ''}">${escapeHtml(label)}</button>`).join('')}</div></div>
  </div>`;
}

export function fileGlyph(job, large = false) {
  const effectiveKind = effectiveJobKind(job);
  const playable = isPlayableJob(job);
  const extension = jobFileExtension(job);
  const fileIcon = extension === 'pdf' ? 'pdf'
    : ['doc','docx','odt'].includes(extension) ? 'document'
      : ['txt','log','md','markdown','rtf','nfo','ini','cfg','conf'].includes(extension) ? 'text'
        : ['html','htm','css','scss','js','jsx','ts','tsx','py','java','cs','cpp','c','h','hpp','rs','go','php','rb','swift','kt','lua','sql','json','xml','yaml','yml','toml','sh','bat','ps1'].includes(extension) ? 'code'
          : ['epub','mobi','azw','azw3','fb2','djvu','cbz','cbr'].includes(extension) ? 'ebook'
            : ['ttf','otf','woff','woff2','eot','fon'].includes(extension) ? 'font'
              : ['xls','xlsx','xlsm','csv','tsv','ods','numbers'].includes(extension) ? 'sheet'
                : ['ppt','pptx','pptm','odp','key'].includes(extension) ? 'presentation'
          : ['zip','rar','7z','tar','gz','bz2','xz','zst','cab','jar'].includes(extension) ? 'archive'
            : ['exe','msi','msix','appx','appxbundle','apk','deb','rpm','dmg'].includes(extension) ? 'package'
              : ['jpg','jpeg','png','webp','gif','svg','bmp','tiff','tif','ico','heic','avif','jfif'].includes(extension) ? 'image'
                : ['iso','img','vhd','vhdx'].includes(extension) ? 'disk'
                    : effectiveKind === 'playlist' ? 'playlist'
                      : job.kind === 'torrent' ? 'magnet'
                      : effectiveKind === 'video' || effectiveKind === 'media' ? 'video'
                      : effectiveKind === 'audio' ? 'audio' : 'file';
  // A stale thumbnail must never override the file type. HTTP archives,
  // installers and documents always keep their real file glyph; only media
  // jobs are allowed to render a provider thumbnail.
  const canRenderThumbnail = playable || ['video', 'audio', 'media', 'playlist', 'image'].includes(effectiveKind);
  const source = canRenderThumbnail ? String(job.thumbnail || youtubeThumbnailFromSource(job.sourceUrl || '')).trim() : '';
  const eagerThumbnail = playable ? ' data-dm-thumbnail-eager="1" fetchpriority="low" loading="eager"' : ' loading="lazy"';
  const thumbnail = source ? `<img data-dm-thumbnail data-dm-thumbnail-src="${escapeHtml(thumbnailUrl(source))}" data-original-thumbnail="${escapeHtml(source)}" alt=""${eagerThumbnail} decoding="async" referrerpolicy="no-referrer"><i class="dm-thumbnail-fallback" aria-hidden="true">${dmIcon(playable ? (effectiveKind === 'audio' ? 'audio' : 'video') : fileIcon, large ? 30 : 18)}</i>` : '';
  const asset = large ? dmFileAsset(fileIcon, 'is-large') : '';
  return `<span class="dm-file-glyph kind-${escapeHtml(effectiveKind)} file-${fileIcon} ${large ? 'is-large' : ''}">${thumbnail || asset || dmIcon(fileIcon, large ? 34 : 22)}</span>`;
}

export function progressValueLabel(job) {
  const indeterminate = Boolean(job.indeterminate) && job.status === 'running';
  const estimated = Boolean(job.totalBytesEstimated || job.progressEstimated) && !indeterminate;
  const progress = Math.max(0, Math.min(100, Number(job.progress) || 0));
  return indeterminate ? '—' : `${estimated ? '~' : ''}${Math.round(progress)}%`;
}

export function progressMarkup(job, showValue = true) {
  const indeterminate = Boolean(job.indeterminate) && job.status === 'running';
  const estimated = Boolean(job.totalBytesEstimated || job.progressEstimated) && !indeterminate;
  const progress = Math.max(0, Math.min(100, Number(job.progress) || 0));
  const ariaValue = indeterminate ? '' : ` aria-valuenow="${Math.round(progress)}"`;
  const value = progressValueLabel(job);
  const ariaLabel = indeterminate
    ? 'Progreso indeterminado'
    : `${estimated ? 'Progreso estimado' : 'Progreso'} ${Math.round(progress)} %`;
  const ratio = (progress / 100).toFixed(4);
  const fillStyle = indeterminate ? '' : ` style="--dm-progress-ratio:${ratio};width:100%"`;
  return `<div class="dm-progress-wrap"><div class="dm-progress ${indeterminate ? 'is-indeterminate' : ''} ${estimated ? 'is-estimated' : ''}" role="progressbar" aria-valuemin="0" aria-valuemax="100"${ariaValue} aria-label="${ariaLabel}"><i${fillStyle}></i></div>${showValue ? `<strong>${value}</strong>` : ''}</div>`;
}

const resumableStatuses = new Set(['queued', 'paused', 'failed']);
const cancellableStatuses = new Set(['running', 'queued', 'paused', 'failed']);
function speedLimitMenuMarkup(job, { inspector = false, playlist = false } = {}) {
  const currentSpeed = Number.isFinite(Number(job.speedLimitBps)) ? Number(job.speedLimitBps) : null;
  const customTargetAttributes = playlist
    ? `data-dm-apply-playlist-speed-limit data-playlist-batch-id="${job.playlistBatchId}"`
    : `data-dm-apply-speed-limit data-job-id="${job.id}"`;
  const customValue = currentSpeed > 0 ? String(Math.max(1, Math.round(currentSpeed / 1_000))) : '';
  // Keep the context action intentionally small: one editable value, one
  // unit and one commit button.  The old second row of preset buttons was
  // visually noisy and, because the menu can move to the fixed overlay, it
  // was easy to click a detached button without committing the value.
  return `<section class="dm-speed-menu${inspector ? ' dm-inspector-speed-menu' : ''}" role="group" aria-label="Límite de descarga"><small>Límite de descarga</small><div class="dm-speed-custom"><input type="text" inputmode="numeric" pattern="[0-9]*" value="${customValue}" placeholder="Sin límite" data-dm-speed-custom-value aria-label="Velocidad personalizada en KB/s"><span class="dm-speed-unit" aria-hidden="true">KB/s</span><button type="button" ${customTargetAttributes} aria-label="Aplicar velocidad personalizada">Aplicar</button></div></section>`;
}

export function jobActionButton(job) {
  if (job.kind === 'playlist' && job.playlistBatchId) {
    if (job.status === 'running') return `<button class="dm-icon-button" data-dm-playlist-action="pause" data-playlist-batch-id="${job.playlistBatchId}" aria-label="Pausar playlist">${dmIcon('pause')}</button>`;
    if (['queued', 'paused'].includes(job.status)) return `<button class="dm-icon-button" data-dm-playlist-action="resume" data-playlist-batch-id="${job.playlistBatchId}" aria-label="Reanudar playlist">${dmIcon('play')}</button>`;
    if (job.status === 'failed') return `<button class="dm-icon-button" data-dm-playlist-action="retry" data-playlist-batch-id="${job.playlistBatchId}" aria-label="Reintentar elementos fallidos">${dmIcon('retry')}</button>`;
    if (job.destination) return `<button class="dm-icon-button" data-dm-reveal-path="${escapeHtml(job.destination)}" aria-label="Abrir carpeta de playlist">${dmIcon('folder')}</button>`;
    return `<span class="dm-action-placeholder" aria-hidden="true"></span>`;
  }
  if (job.status === 'running') return `<button class="dm-icon-button" data-dm-job-action="pause" data-job-id="${job.id}" aria-label="Pausar">${dmIcon('pause')}</button>`;
  if (resumableStatuses.has(job.status)) return `<button class="dm-icon-button" data-dm-job-action="resume" data-job-id="${job.id}" aria-label="Iniciar o reanudar">${dmIcon('play')}</button>`;
  if (job.destination) return `<button class="dm-icon-button" data-dm-job-action="reveal" data-job-id="${job.id}" aria-label="Mostrar archivo">${dmIcon('folder')}</button>`;
  return `<span class="dm-action-placeholder" aria-hidden="true"></span>`;
}

function inspectorActions(job) {
  const actions = [];
  if (job.kind === 'playlist' && job.playlistBatchId) {
    if (job.status === 'running') actions.push(`<button data-dm-playlist-action="pause" data-playlist-batch-id="${job.playlistBatchId}">${dmIcon('pause')}<span>Pausar playlist</span></button>`);
    else if (['queued', 'paused'].includes(job.status)) actions.push(`<button data-dm-playlist-action="resume" data-playlist-batch-id="${job.playlistBatchId}">${dmIcon('play')}<span>Reanudar playlist</span></button>`);
    if (job.status === 'failed') actions.push(`<button data-dm-playlist-action="retry" data-playlist-batch-id="${job.playlistBatchId}">${dmIcon('retry')}<span>Reintentar fallidos</span></button>`);
    if (['running', 'queued', 'paused'].includes(job.status)) actions.push(speedLimitMenuMarkup(job, { inspector: true, playlist: true }));
    if (job.destination) actions.push(`<button data-dm-reveal-path="${escapeHtml(job.destination)}">${dmIcon('folder')}<span>Abrir carpeta</span></button>`);
    if (job.sourceUrl) actions.push(`<button data-dm-advanced-details="${job.id}">${dmIcon('globe')}<span>Detalles avanzados</span></button>`);
    actions.push(`<button class="is-danger" data-dm-delete-playlist-batch="${job.playlistBatchId}" data-delete-storage="0">${dmIcon('trash')}<span>Eliminar del historial</span></button>`);
    actions.push(`<button class="is-danger" data-dm-delete-playlist-batch="${job.playlistBatchId}" data-delete-storage="1" data-playlist-destination="${escapeHtml(job.destination || '')}">${dmIcon('trash')}<span>Eliminar también archivos</span></button>`);
    return actions.length ? `<section class="dm-inspector-actions">${actions.join('')}</section>` : `<section class="dm-inspector-actions dm-inspector-actions-empty"><span>La playlist no tiene acciones disponibles.</span></section>`;
  }
  if (job.status === 'running') actions.push(`<button data-dm-job-action="pause" data-job-id="${job.id}">${dmIcon('pause')}<span>Pausar</span></button>`);
  else if (resumableStatuses.has(job.status)) actions.push(`<button data-dm-job-action="resume" data-job-id="${job.id}">${dmIcon('play')}<span>Reanudar</span></button>`);
  if (job.kind !== 'playlist' && ['running', 'queued', 'paused'].includes(job.status)) {
    actions.push(speedLimitMenuMarkup(job, { inspector: true }));
  }
  if (cancellableStatuses.has(job.status)) actions.push(`<button class="is-danger" data-dm-cancel-job="${job.id}">${dmIcon('shield')}<span>Cancelar descarga</span></button>`);
  actions.push(`<button class="is-danger" data-dm-delete-job="${job.id}">${dmIcon('trash')}<span>Eliminar</span></button>`);
  if (job.destination) actions.push(`<button data-dm-job-action="reveal" data-job-id="${job.id}">${dmIcon('folder')}<span>Abrir carpeta</span></button>`);
  if (job.status === 'completed' && job.destination) {
    const path = escapeHtml(job.destination);
    actions.push(`<button data-dm-file-action="copy" data-dm-file-path="${path}">${dmIcon('clipboard')}<span>Copiar</span></button>`);
    actions.push(`<button data-dm-file-action="cut" data-dm-file-path="${path}">${dmIcon('scissors')}<span>Cortar</span></button>`);
  }
  if (cancellableStatuses.has(job.status)) actions.push(`<button data-dm-schedule-job="${job.id}">${dmIcon('calendar')}<span>Programar</span></button>`);
  if (job.sourceUrl) actions.push(`<button data-dm-advanced-details="${job.id}">${dmIcon('globe')}<span>Detalles avanzados</span></button>`);
  return actions.length ? `<section class="dm-inspector-actions">${actions.join('')}</section>` : `<section class="dm-inspector-actions dm-inspector-actions-empty"><span>Esta tarea no tiene acciones disponibles.</span></section>`;
}

function rowMenuActions(job) {
  const actions = [];
  if (job.kind === 'playlist' && job.playlistBatchId) {
    actions.push(`<button data-dm-open-playlist-player="${job.playlistBatchId}">${dmIcon('play')}<span>Reproducir</span></button>`);
    if (job.status === 'running') actions.push(`<button data-dm-playlist-action="pause" data-playlist-batch-id="${job.playlistBatchId}">${dmIcon('pause')}<span>Pausar playlist</span></button>`);
    else if (['queued', 'paused'].includes(job.status)) actions.push(`<button data-dm-playlist-action="resume" data-playlist-batch-id="${job.playlistBatchId}">${dmIcon('play')}<span>Iniciar o reanudar</span></button>`);
    if (job.status === 'failed') actions.push(`<button data-dm-playlist-action="retry" data-playlist-batch-id="${job.playlistBatchId}">${dmIcon('retry')}<span>Reintentar fallidos</span></button>`);
    if (['running', 'queued', 'paused'].includes(job.status)) actions.push(speedLimitMenuMarkup(job, { playlist: true }));
    if (job.destination) actions.push(`<button data-dm-reveal-path="${escapeHtml(job.destination)}">${dmIcon('folder')}<span>Abrir carpeta</span></button>`);
    else actions.push(`<button data-dm-open-download-directory>${dmIcon('folder')}<span>Abrir carpeta de descargas</span></button>`);
    if (job.sourceUrl) actions.push(`<button data-dm-advanced-details="${job.id}">${dmIcon('globe')}<span>Detalles avanzados</span></button>`);
    actions.push(`<button class="is-danger" data-dm-delete-playlist-batch="${job.playlistBatchId}" data-delete-storage="0">${dmIcon('trash')}<span>Eliminar del historial</span></button>`);
    actions.push(`<button class="is-danger" data-dm-delete-playlist-batch="${job.playlistBatchId}" data-delete-storage="1" data-playlist-destination="${escapeHtml(job.destination || '')}">${dmIcon('trash')}<span>Eliminar también archivos</span></button>`);
  } else {
    if (isPlayableJob(job) && job.id) {
      actions.push(`<button data-dm-open-player="${job.id}">${dmIcon('play')}<span>Reproducir</span></button>`);
    }
    if (job.status === 'completed' && job.destination) {
      const path = escapeHtml(job.destination);
      actions.push(`<button data-dm-open-path="${path}">${dmIcon('file')}<span>Abrir</span></button>`);
      actions.push(`<button data-dm-file-action="copy" data-dm-file-path="${path}">${dmIcon('clipboard')}<span>Copiar</span></button>`);
      actions.push(`<button data-dm-file-action="cut" data-dm-file-path="${path}">${dmIcon('scissors')}<span>Cortar</span></button>`);
      actions.push(`<button data-dm-rename-job="${job.id}">${dmIcon('edit')}<span>Renombrar</span></button>`);
    }
    if (job.status === 'running') actions.push(`<button data-dm-job-action="pause" data-job-id="${job.id}">${dmIcon('pause')}<span>Pausar</span></button>`);
    else if (resumableStatuses.has(job.status)) actions.push(`<button data-dm-job-action="resume" data-job-id="${job.id}">${dmIcon('play')}<span>Iniciar o reanudar</span></button>`);
    if (cancellableStatuses.has(job.status)) actions.push(`<button data-dm-schedule-job="${job.id}">${dmIcon('calendar')}<span>Programar</span></button>`);
    if (job.status === 'failed') actions.push(`<button data-dm-recover-job="${job.id}">${dmIcon('retry')}<span>Diagnosticar</span></button>`);
    if (job.destination) actions.push(`<button data-dm-job-action="reveal" data-job-id="${job.id}">${dmIcon('folder')}<span>Mostrar archivo</span></button>`);
    else actions.push(`<button data-dm-open-download-directory>${dmIcon('folder')}<span>Abrir carpeta de descargas</span></button>`);
    if (job.sourceUrl) actions.push(`<button data-dm-advanced-details="${job.id}">${dmIcon('globe')}<span>Detalles avanzados</span></button>`);
    if (cancellableStatuses.has(job.status)) actions.push(`<button class="is-danger" data-dm-cancel-job="${job.id}">${dmIcon('shield')}<span>Cancelar descarga</span></button>`);
    actions.push(`<button class="is-danger" data-dm-delete-job="${job.id}">${dmIcon('trash')}<span>Eliminar</span></button>`);
  }
  if (['running', 'queued', 'paused', 'failed'].includes(job.status)) {
    const current = ['high', 'low'].includes(job.priority) ? job.priority : 'normal';
    const target = job.kind === 'playlist' && Number(job.playlistBatchId || 0) > 0
      ? `data-priority-target="playlist" data-playlist-batch-id="${job.playlistBatchId}"`
      : `data-priority-target="job" data-job-id="${job.id}"`;
    const choices = [['high', 'Alta'], ['normal', 'Normal'], ['low', 'Baja']]
      .map(([value, label]) => `<button type="button" role="menuitemradio" aria-checked="${current === value ? 'true' : 'false'}" data-dm-set-priority="${value}" ${target}><span>${label}</span>${current === value ? dmIcon('check', 16) : ''}</button>`)
      .join('');
    actions.splice(Math.max(0, actions.length - 2), 0, `<section class="dm-priority-menu" role="group" aria-label="Prioridad"><small>Prioridad</small>${choices}</section>`);
    if (job.kind !== 'playlist' && ['running', 'queued', 'paused'].includes(job.status)) {
      actions.splice(Math.max(0, actions.length - 2), 0, speedLimitMenuMarkup(job));
    }
  }
  return actions;
}

export function rowMenu(job, rowMenuJobId) {
  if (!job) return '';
  const open = Number(rowMenuJobId) === Number(job.id);
  return `<button type="button" class="dm-icon-button dm-row-menu-trigger" data-dm-row-menu="${job.id}" aria-haspopup="menu" aria-expanded="${open ? 'true' : 'false'}" aria-label="Más acciones para ${escapeHtml(job.title)}" title="Más acciones">${dmIcon('more', 18)}</button>`;
}

export function floatingRowMenu(job, rowMenuJobId, position) {
  if (!job || Number(rowMenuJobId) !== Number(job.id) || !position) return '';
  const actions = rowMenuActions(job);
  const left = Number(position.left || 8);
  const top = Number(position.top || 8);
  return `<div class="dm-row-menu dm-row-menu-floating floating-position-root" role="menu" style="left:${left}px;top:${top}px"><div class="motion-inner">${actions.join('') || '<span class="dm-row-menu-empty">Sin acciones disponibles</span>'}</div></div>`;
}

export function selectedInspector(job, preferences) {
  if (!job) return `<aside class="dm-inspector dm-empty-inspector"><button class="dm-collapse-control" data-dm-toggle="inspector" aria-label="Ocultar inspector">${dmIcon('collapse')}</button>${dmIcon('file', 38)}<strong>Selecciona una descarga</strong><span>Los detalles, archivos, conexiones y acciones aparecerán aquí.</span></aside>`;
  const tabs = [['summary', 'Resumen'], ['files', 'Archivos'], ['connections', 'Detalles avanzados'], ['log', 'Registro']];
  const metadata = [
    ['Estado', statusLabel(job.status)], ['Progreso', `${Math.round(job.progress)}%`], ['Tamaño', job.totalBytes ? `${formatBytes(job.downloadedBytes)} de ${formatBytes(job.totalBytes)}` : formatBytes(job.downloadedBytes)],
    ['Velocidad', formatSpeed(job.speedBps)], ['Restante', formatEta(job.etaSeconds)], ['Motor', job.engine || 'Local'], ['Categoría', job.category], ['Origen', job.origin]
  ];
  const errorRecovery = job.status === 'failed' ? `<section class="dm-recovery-card"><div>${dmIcon('shield', 22)}<span><strong>Diagnóstico y recuperación</strong><small>Se confirmará el error, se distinguirá si es temporal y se buscarán alternativas solo cuando corresponda.</small></span></div><button data-dm-recover-job="${job.id}">${dmIcon('retry', 18)} Diagnosticar y reparar</button></section>` : '';
  return `<aside class="dm-inspector" data-job-id="${job.id}">
    <header class="dm-inspector-head">${fileGlyph(job, true)}<div><strong title="${escapeHtml(job.title)}">${escapeHtml(job.title)}</strong><span><em>${escapeHtml(job.category)}</em><em>${escapeHtml(job.engine || 'Local')}</em></span></div><button class="dm-collapse-control" data-dm-toggle="inspector" aria-label="Ocultar inspector">${dmIcon('collapse')}</button></header>
    <nav class="dm-inspector-tabs">${tabs.map(([id, label]) => `<button class="${preferences.inspectorTab === id ? 'is-active' : ''}" data-dm-inspector-tab="${id}">${label}</button>`).join('')}</nav>
    <div class="dm-inspector-body">
      ${preferences.inspectorTab === 'summary' ? `${inspectorActions(job)}<dl class="dm-metadata">${metadata.map(([key, value]) => `<div><dt>${escapeHtml(key)}</dt><dd>${escapeHtml(value)}</dd></div>`).join('')}</dl>${errorRecovery}` : ''}
      ${preferences.inspectorTab === 'files' ? relatedFilesMarkup(job) : ''}
      ${preferences.inspectorTab === 'connections' ? connectionsMarkup(job) : ''}
      ${preferences.inspectorTab === 'log' ? inspectorLogMarkup(job) : ''}
    </div>
  </aside>`;
}

export function settingsFields(preferences) {
  const displayedScale = Math.max(50, Math.min(130, Math.round(Number(preferences.uiScale ?? 100) / 5) * 5));
  const displayedTextScale = Math.max(80, Math.min(120, Math.round(Number(preferences.textScale ?? 100) / 5) * 5));
  const displayedIntensity = Math.max(40, Math.min(100, Math.round(Number(preferences.accentIntensity || 88))));
  const displayedSuccess = preferences.success;
  return `<div class="dm-settings-field-grid">
    <label class="dm-setting-field"><span><strong>Modo</strong><small>Claro, oscuro o según Windows.</small></span><select data-dm-setting="theme"><option value="dark" ${preferences.theme === 'dark' ? 'selected' : ''}>Oscuro</option><option value="light" ${preferences.theme === 'light' ? 'selected' : ''}>Claro</option><option value="system" ${preferences.theme === 'system' ? 'selected' : ''}>Sistema</option></select></label>
    <section class="dm-scale-setting"><span><strong>Escala de interfaz</strong><small>100 % conserva el tamaño visual aprobado; usa pasos reales de 5 %.</small></span><div><button type="button" data-dm-scale-decrease aria-label="Reducir escala">−</button><input type="number" min="50" max="130" step="5" value="${displayedScale}" data-dm-scale-number aria-label="Porcentaje de escala"><button type="button" data-dm-scale-increase aria-label="Aumentar escala">+</button></div><input type="range" min="50" max="130" step="5" value="${displayedScale}" data-dm-setting="uiScale"></section>
    <label class="dm-text-scale-setting"><span><strong>Tamaño del texto</strong><small>100 % conserva la tipografía aprobada sin cambiar miniaturas ni geometría.</small></span><input type="range" min="80" max="120" step="5" value="${displayedTextScale}" data-dm-setting="textScale"><output>${displayedTextScale}%</output></label>
    <label class="dm-setting-field"><span><strong>Color principal</strong><small>Se aplica a foco, selección, bordes y acciones principales.</small></span><input type="color" data-dm-setting="accent" value="${preferences.accent}"></label>
    <label class="dm-text-scale-setting dm-accent-intensity-setting"><span><strong>Intensidad del acento</strong><small>No modifica texto, éxito, advertencia ni error.</small></span><input type="range" min="40" max="100" step="1" value="${displayedIntensity}" data-dm-setting="accentIntensity"><output>${displayedIntensity}%</output></label>
    <div class="dm-semantic-color-group"><header><strong>Colores semánticos</strong><small>Completado, espera, pausa y error permanecen independientes del acento principal.</small></header><div><label>Completado<input type="color" data-dm-setting="success" value="${displayedSuccess}"></label><label>En espera<input type="color" data-dm-setting="warning" value="${preferences.warning}"></label><label>En pausa<input type="color" data-dm-setting="progressPaused" value="${preferences.progressPaused}"></label><label>Error<input type="color" data-dm-setting="danger" value="${preferences.danger}"></label></div></div>
    <label class="dm-switch-row"><span><strong>Filas compactas</strong><small>Reduce separación sin ocultar progreso ni acciones.</small></span><input type="checkbox" data-dm-setting="compactRows" ${preferences.compactRows ? 'checked' : ''}></label>
  </div>`;
}

function updaterSettings(context = {}) {
  const updater = context.updaterStatus || {};
  if (updater.storeManaged) {
    return `<article class="dm-settings-feature is-ready"><div class="dm-settings-feature-head"><span>${dmIcon('download', 20)}</span><div><strong>Actualizaciones de Microsoft Store</strong><small>Esta edición recibe sus actualizaciones a través de Microsoft Store.</small></div><i>Microsoft Store</i></div><p class="dm-settings-message">Busca Clear Download Manager en la Biblioteca de Microsoft Store para instalar la versión más reciente.</p></article>`;
  }
  const configured = Boolean(updater.configured);
  const update = context.availableUpdate || null;
  const updaterMessage = String(context.updaterMessage || updater.message || '');
  const messageTone = update || /versión más reciente|actualizado/i.test(updaterMessage)
    ? 'is-status-ready'
    : /no se pudo|no disponible|no est[aá] configurado/i.test(updaterMessage)
      ? 'is-status-warning'
      : '';
  return `<article class="dm-settings-feature ${configured ? 'is-ready' : 'is-pending'}">
    <div class="dm-settings-feature-head"><span>${dmIcon('download', 20)}</span><div><strong>Actualizaciones automáticas</strong><small>${configured ? `Canal ${escapeHtml(updater.channel || 'stable')} · ${escapeHtml(updater.repository || 'repositorio configurado')}` : 'El código está preparado; la publicación requiere endpoint y firma válidos.'}</small></div><i>${configured ? 'Listo' : 'Sin configurar'}</i></div>
    <label class="dm-switch-row"><span><strong>Comprobar automáticamente</strong><small>Busca al iniciar y cada 6 horas cuando el actualizador firmado está configurado.</small></span><input type="checkbox" data-dm-auto-update ${context.autoUpdateEnabled !== false ? 'checked' : ''} ${configured ? '' : 'disabled'}></label>
    ${update ? `<div class="dm-update-available"><b>Versión ${escapeHtml(update.version)}</b><span>${escapeHtml(update.notes || 'Nueva versión disponible.')}</span></div>` : ''}
    ${updaterMessage ? `<p class="dm-settings-message ${messageTone}">${escapeHtml(updaterMessage)}</p>` : ''}
    ${updateProgressMarkup(context)}
    <div class="dm-settings-feature-actions"><button type="button" data-dm-check-update ${!configured || context.updaterCheckBusy || context.updaterInstallBusy ? 'disabled' : ''}>${context.updaterCheckBusy ? 'Comprobando…' : 'Buscar actualización'}</button>${update ? `<button type="button" data-dm-dismiss-update>Más tarde</button><button type="button" class="is-primary" data-dm-install-update ${context.updaterInstallBusy ? 'disabled' : ''}>${context.updaterInstallBusy ? 'Instalando…' : 'Descargar e instalar'}</button>` : ''}</div>
  </article>`;
}

export function updateProgressMarkup(context = {}) {
  if (!context.updaterInstallBusy) return '';
  const progress = context.updaterProgress || {};
  const phase = progress.phase === 'install' ? 'install' : 'download';
  const rawPercent = Number(progress.percent);
  const percent = phase === 'download' && Number.isFinite(rawPercent)
    ? Math.max(0, Math.min(100, Math.round(rawPercent)))
    : phase === 'install' ? 100 : null;
  const downloaded = Number(progress.downloadedBytes);
  const total = Number(progress.contentLength);
  const hasDownloaded = Number.isFinite(downloaded) && downloaded > 0;
  const hasTotal = Number.isFinite(total) && total > 0;
  const detail = phase === 'install'
    ? 'Verificando e instalando la actualización firmada.'
    : percent === null
      ? 'Descargando la actualización firmada…'
      : `Descargando la actualización firmada (${percent}%).`;
  const transfer = hasTotal
    ? `${formatBytes(downloaded)} / ${formatBytes(total)}`
    : hasDownloaded ? formatBytes(downloaded) : '';
  const progressLabel = phase === 'install' ? 'Instalando actualización' : 'Progreso de descarga';
  return `<div class="dm-update-progress" role="status" aria-live="polite"><div class="dm-update-progress-track ${percent === null ? 'is-indeterminate' : ''}" role="progressbar" aria-label="${progressLabel}" aria-valuemin="0" aria-valuemax="100" ${percent === null ? 'aria-valuetext="Descargando actualización"' : `aria-valuenow="${percent}"`}><i style="width:${percent === null ? 28 : percent}%"></i></div><span>${detail}</span>${transfer ? `<small>${transfer}${hasTotal && percent !== null ? ` · ${percent}%` : ''}</small>` : ''}</div>`;
}

function extensionSettings(context = {}) {
  const bridge = context.extensionBridgeStatus || {};
  const configured = Boolean(bridge.configured || bridge.prepared);
  const registered = Boolean(bridge.registered);
  return `<article class="dm-settings-feature ${configured ? 'is-ready' : 'is-pending'}">
    <div class="dm-settings-feature-head"><span>${dmIcon('link', 20)}</span><div><strong>Extensión del navegador</strong><small>Puente Native Messaging v${escapeHtml(String(bridge.protocolVersion || 1))}.</small></div><i>${registered ? 'Registrado' : configured ? 'Preparado' : 'No disponible'}</i></div>
    <p class="dm-settings-message">${configured ? 'La integración conserva el ID oficial y recibe enlaces, estado y progreso desde la extensión.' : 'El puente nativo no informó una configuración válida.'}</p>
    <code class="dm-bridge-host">${escapeHtml(bridge.hostName || 'lat.cacaplay.cacatools.downloadmanager')}</code>
    <div class="dm-settings-feature-actions"><button type="button" data-dm-repair-integration>${dmIcon('shield', 16)} Reparar integración de Windows</button></div>
  </article>`;
}

function generalSettings(context = {}) {
  return `<div class="dm-settings-section-body">
    <label class="dm-window-setting"><span><strong>Al pulsar cerrar</strong><small>Minimizar siempre conserva la aplicación en la barra de tareas.</small></span><select data-dm-close-action><option value="tray" ${context.windowBehavior?.closeAction !== 'exit' ? 'selected' : ''}>Cerrar a la bandeja</option><option value="exit" ${context.windowBehavior?.closeAction === 'exit' ? 'selected' : ''}>Salir completamente</option></select></label>
    ${context.startupStatus ? `<label class="dm-switch-row dm-startup-setting"><span><strong>Iniciar con Windows</strong><small>Se inicia en segundo plano y se muestra al recibir una descarga.</small></span><input type="checkbox" data-dm-startup ${context.startupStatus.enabled ? 'checked' : ''} ${context.startupStatus.supported === false ? 'disabled' : ''}></label>` : ''}
    <aside class="dm-settings-local-note">${dmIcon('shield', 18)}<span><strong>Configuración local</strong><small>Las preferencias se guardan únicamente en este equipo.</small></span></aside>
  </div>`;
}

function downloadsSettings(context = {}) {
  const directory = String(context.downloadDirectory || 'Carpeta de descargas');
  return `<div class="dm-settings-section-body"><article class="dm-download-directory-setting"><span>${dmIcon('folder', 24)}</span><div><small>Carpeta predeterminada</small><strong title="${escapeHtml(directory)}">${escapeHtml(directory)}</strong></div></article><div class="dm-settings-inline-actions"><button type="button" data-dm-choose-download-directory>${dmIcon('folder', 17)} Cambiar carpeta</button><button type="button" data-dm-open-download-directory>${dmIcon('eye', 17)} Abrir carpeta</button></div><aside class="dm-settings-explanation"><strong>Cola y recuperación</strong><span>Las pausas, reintentos, programación y categorías existentes se gestionan desde sus secciones. No se muestran controles globales que todavía no tengan implementación real.</span></aside></div>`;
}

function multimediaSettings(context = {}) {
  const media = context.mediaPreferences || {};
  const session = context.mediaSessionSettings || {};
  const cookiesPath = String(session.cookiesPath || '').trim();
  const cookiesName = cookiesPath.split(/[\\/]/).pop() || '';
  const sessionLabel = session.useBraveCookies
    ? 'Brave: se usará la sesión local con consentimiento guardado.'
    : cookiesPath
      ? (session.cookiesFileAvailable === false ? 'El archivo guardado ya no está disponible.' : `Archivo Netscape: ${cookiesName}`)
      : 'Descargas anónimas: no se leerán cookies.';
  const outputMode = String(media.outputMode || 'video_mp4');
  const formatSelector = String(media.formatSelector || '');
  const quality = ['best', '2160', '1440', '1080', '720', '480', '360', '240', '144'].includes(String(media.videoQuality || ''))
    ? String(media.videoQuality)
    : /2160/.test(formatSelector) ? '2160' : /1440/.test(formatSelector) ? '1440' : /1080/.test(formatSelector) ? '1080' : /720/.test(formatSelector) ? '720' : /480/.test(formatSelector) ? '480' : /360/.test(formatSelector) ? '360' : /240/.test(formatSelector) ? '240' : /144/.test(formatSelector) ? '144' : 'best';
  const playlistFormat = String(media.playlistFormat || 'MP3 320 kbps');
  return `<div class="dm-settings-section-body dm-multimedia-settings">
    <label class="dm-setting-field"><span><strong>Salida predeterminada</strong><small>Se reutiliza al analizar el siguiente enlace compatible.</small></span><select data-dm-media-output><option value="video_mp4" ${outputMode === 'video_mp4' ? 'selected' : ''}>MP4 · vídeo + audio</option><option value="video_webm" ${outputMode === 'video_webm' ? 'selected' : ''}>WebM · vídeo + audio</option><option value="audio_best" ${outputMode === 'audio_best' ? 'selected' : ''}>Original / mejor audio disponible</option><option value="audio_mp3" ${outputMode === 'audio_mp3' ? 'selected' : ''}>MP3 320 kbps · compatibilidad</option><option value="audio_m4a" ${outputMode === 'audio_m4a' ? 'selected' : ''}>M4A · compatibilidad</option><option value="source" ${outputMode === 'source' ? 'selected' : ''}>Original, sin conversión cuando sea posible</option></select></label>
    <label class="dm-setting-field"><span><strong>Calidad de vídeo predeterminada</strong><small>Si la fuente no ofrece esa calidad, el analizador elige la mejor compatible sin superar el límite.</small></span><select data-dm-media-quality><option value="best" ${quality === 'best' ? 'selected' : ''}>Mejor disponible</option><option value="2160" ${quality === '2160' ? 'selected' : ''}>Hasta 2160p</option><option value="1440" ${quality === '1440' ? 'selected' : ''}>Hasta 1440p</option><option value="1080" ${quality === '1080' ? 'selected' : ''}>Hasta 1080p</option><option value="720" ${quality === '720' ? 'selected' : ''}>Hasta 720p</option><option value="480" ${quality === '480' ? 'selected' : ''}>Hasta 480p</option><option value="360" ${quality === '360' ? 'selected' : ''}>Hasta 360p</option><option value="240" ${quality === '240' ? 'selected' : ''}>Hasta 240p</option><option value="144" ${quality === '144' ? 'selected' : ''}>Hasta 144p</option></select></label>
    <label class="dm-setting-field"><span><strong>Formato de playlist</strong><small>Se conserva entre playlists y se reajusta solo si resulta incompatible.</small></span><select data-dm-playlist-format>${['Original / mejor audio disponible','M4A','Opus','MP3 320 kbps','MP3 V0','Vídeo · MP4 720p','Vídeo · MP4 480p','Vídeo · MP4 1080p','Vídeo · mejor disponible'].map((value) => `<option ${playlistFormat === value ? 'selected' : ''}>${value}</option>`).join('')}</select></label>
    <article class="dm-settings-feature dm-media-session-settings ${session.useBraveCookies || cookiesPath ? 'is-ready' : 'is-pending'}"><div class="dm-settings-feature-head"><span>${dmIcon('shield', 20)}</span><div><strong>Sesión para YouTube y plataformas compatibles</strong><small>Se configura una sola vez y se aplica a análisis, descargas y playlists.</small></div><i>${session.useBraveCookies || cookiesPath ? 'Configurada' : 'Anónima'}</i></div><p class="dm-settings-message">${escapeHtml(sessionLabel)}</p><div class="dm-settings-feature-actions"><label class="dm-switch-row"><span><strong>Usar cookies de Brave</strong><small>Con tu consentimiento, yt-dlp lee el perfil local y puede enviar al sitio del contenido las cookies que correspondan. Al extraerlas, usa una copia temporal local.</small></span><input type="checkbox" data-dm-media-session-consent ${session.useBraveCookies ? 'checked' : ''}></label><button type="button" data-dm-choose-media-cookies>${dmIcon('file', 16)} Elegir cookies Netscape (.txt)</button>${cookiesPath ? `<button type="button" data-dm-clear-media-cookies>Quitar archivo</button>` : ''}</div><small class="dm-settings-message">Clear guarda la preferencia y, si eliges un archivo, su ruta local; no guarda los valores de las cookies en su base SQLite. Desactivar la opción no borra las cookies de Brave ni el archivo original.</small></article>
    <aside class="dm-settings-explanation"><strong>Preferencias persistentes activas</strong><span>La preferencia de Brave se conserva y se aplica a análisis, descargas y playlists hasta que la desactives.</span></aside>
  </div>`;
}

function integrationsSettings(context = {}) {
  return `<div class="dm-settings-section-body dm-infrastructure-settings">${extensionSettings(context)}</div>`;
}

function diagnosticsSettings(context = {}) {
  const runtime = context.runtimeStatus || {};
  const media = context.mediaRuntimeStatus || {};
  const status = (ready, version = '') => ({
    label: ready ? (version || 'Disponible') : 'No detectado',
    tone: ready ? 'is-ready' : 'is-missing'
  });
  const statusCell = (ready, version = '') => {
    const value = status(ready, version);
    return `<dd class="${value.tone}">${escapeHtml(value.label)}</dd>`;
  };
  return `<div class="dm-settings-section-body dm-infrastructure-settings"><article class="dm-settings-feature is-ready"><div class="dm-settings-feature-head"><span>${dmIcon('terminal', 20)}</span><div><strong>Motor y diagnóstico</strong><small>Estado reportado por los componentes locales.</small></div><i>Local</i></div><dl class="dm-runtime-diagnostics"><div><dt>Aplicación</dt><dd>${escapeHtml(runtime.version || context.updaterStatus?.currentVersion || '0.25.1')}</dd></div><div><dt>aria2c</dt>${statusCell(runtime.aria2_available, runtime.aria2_version)}</div><div><dt>yt-dlp</dt>${statusCell(media.yt_dlp, media.yt_dlp_version)}</div><div><dt>FFmpeg</dt>${statusCell(media.ffmpeg, media.ffmpeg_version)}</div><div><dt>FFprobe</dt>${statusCell(media.ffprobe, media.ffprobe_version)}</div></dl><p class="dm-settings-message">${escapeHtml(media.detail || 'Los componentes se ejecutan localmente.')}</p><div class="dm-settings-feature-actions"><button type="button" data-dm-refresh-runtime>${dmIcon('retry', 16)} Actualizar estado</button><button type="button" data-dm-copy-diagnostics>${dmIcon('clipboard', 16)} Copiar diagnóstico</button></div></article></div>`;
}

const SETTINGS_SECTIONS = Object.freeze([
  ['general', 'General', 'settings'],
  ['downloads', 'Descargas', 'download'],
  ['multimedia', 'Multimedia', 'audio'],
  ['appearance', 'Apariencia', 'palette'],
  ['integrations', 'Integraciones', 'link'],
  ['diagnostics', 'Actualizaciones y diagnóstico', 'terminal']
]);

export function infrastructureSettings(context = {}) {
  return `<section class="dm-infrastructure-settings">${updaterSettings(context)}${extensionSettings(context)}</section>`;
}

export function settingsPopover(preferences, open = false, context = {}) {
  const active = SETTINGS_SECTIONS.some(([id]) => id === context.settingsSection) ? context.settingsSection : 'general';
  const panels = {
    general: generalSettings(context),
    downloads: downloadsSettings(context),
    multimedia: multimediaSettings(context),
    appearance: `<div class="dm-settings-section-body">${settingsFields(preferences)}</div>`,
    integrations: integrationsSettings(context),
    diagnostics: diagnosticsSettings(context)
  };
  const current = SETTINGS_SECTIONS.find(([id]) => id === active) || SETTINGS_SECTIONS[0];
  return `<div class="dm-settings-popover floating-position-root" ${open ? '' : 'hidden'}><div class="motion-inner">
    <header><div><small>CONTROL LOCAL</small><strong>Ajustes de CacaTools</strong><span>Secciones independientes, sin una página vertical interminable.</span></div><button data-dm-settings-close aria-label="Cerrar ajustes">${dmIcon('x')}</button></header>
    <div class="dm-settings-shell">
      <nav class="dm-settings-nav" aria-label="Secciones de ajustes">${SETTINGS_SECTIONS.map(([id, label, iconName]) => `<button type="button" class="${id === active ? 'is-active' : ''}" data-dm-settings-section="${id}">${dmIcon(iconName, 18)}<span>${escapeHtml(label)}</span></button>`).join('')}</nav>
      <section class="dm-settings-panel" data-dm-settings-panel="${active}"><div class="dm-settings-panel-title"><span>${dmIcon(current[2], 22)}</span><div><strong>${escapeHtml(current[1])}</strong><small>${active === 'general' ? 'Ventana e inicio.' : active === 'downloads' ? 'Destino y comportamiento real de la cola.' : active === 'multimedia' ? 'Preferencias persistentes de salida y calidad.' : active === 'appearance' ? 'Tema, escala, densidad y colores.' : active === 'integrations' ? 'Extensión y puente nativo.' : 'Actualizador y componentes locales.'}</small></div></div>${panels[active]}</section>
    </div>
  </div></div>`;
}

export function dialogShell(id, title, body, footer = '') {
  return `<div class="dm-modal-backdrop floating-position-root" data-dm-modal="${id}"><section class="dm-modal motion-inner" role="dialog" aria-modal="true" aria-labelledby="dm-modal-title-${id}"><header><h2 id="dm-modal-title-${id}">${escapeHtml(title)}</h2><button data-dm-modal-close>${dmIcon('x')}</button></header><div class="dm-modal-body">${body}</div>${footer ? `<footer>${footer}</footer>` : ''}</section></div>`;
}
