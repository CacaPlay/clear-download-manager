import { escapeHtml } from '../core/model.js';
import { dmFileAsset, dmIcon, dmPlaylistLogo } from './icons.js';
import { dialogShell, updateProgressMarkup } from './shared.js';


function progressiveThumbnailMarkup(item, index, iconSize = 34) {
  const source = String(item?.thumbnail || '').trim();
  if (!source) return dmIcon('video', iconSize);
  const escaped = escapeHtml(source);
  const loadAttribute = index < 4
    ? `src="${escaped}" loading="eager"`
    : `data-dm-thumbnail-src="${escaped}" loading="lazy"`;
  return `<img data-dm-thumbnail data-original-thumbnail="${escaped}" ${loadAttribute} alt="" decoding="async" referrerpolicy="no-referrer"><i class="dm-thumbnail-fallback" aria-hidden="true">${dmIcon('video', iconSize)}</i>`;
}

function matchReasonMarkup(item) {
  const reasons = Array.isArray(item?.match_reasons) ? item.match_reasons.filter(Boolean).slice(0, 3) : [];
  return reasons.length ? `<span class="dm-match-reasons">${reasons.map((reason) => `<em>${escapeHtml(reason)}</em>`).join('')}</span>` : '';
}

export function videoSearchDialog(state) {
  const results = state.videoSearchResults || [];
  const body = `<section class="dm-video-search-box"><label>${dmIcon('search')}<input id="dm-video-query" value="${escapeHtml(state.videoSearchQuery || '')}" placeholder="Título, artista, canal o descripción"><button data-dm-run-video-search>Buscar</button></label><p>La búsqueda se realiza mediante el resolvedor local. Nada se envía a CacaTools.</p></section>
    <section class="dm-search-results">${state.videoSearchBusy ? `<div class="dm-search-loading"><i></i><strong>Buscando coincidencias…</strong></div>` : results.length ? results.map((item, index) => `<article class="dm-search-card"><span class="dm-search-thumb">${progressiveThumbnailMarkup(item, index, 34)}<small>${escapeHtml(item.duration_label || item.duration || '—')}</small></span><div><em>#${index + 1} · ${escapeHtml(item.extractor || 'Vídeo')}</em><strong>${escapeHtml(item.title)}</strong><span>${escapeHtml(item.creator || item.uploader || '')}</span>${matchReasonMarkup(item)}</div><button data-dm-analyze-result="${escapeHtml(item.source_url || item.url || '')}">${dmIcon('eye')} Analizar</button></article>`).join('') : `<div class="dm-search-empty">${dmIcon('search', 38)}<strong>Busca un vídeo por su título</strong><span>También puedes escribir artista, canal o palabras clave.</span></div>`}</section>`;
  return dialogShell('video-search', 'Buscar vídeos', body);
}

export function torrentDialog(state) {
  const source = escapeHtml(state.torrentSource || '');
  const body = `<section class="dm-torrent-dialog">
      <label class="dm-torrent-source"><span>Magnet o archivo .torrent</span><div>${dmIcon('magnet')}<input id="dm-torrent-source" value="${source}" placeholder="magnet:?xt=urn:btih:… o C:\\ruta\\archivo.torrent" autocomplete="off" spellcheck="false"><button type="button" class="dm-torrent-icon-action" data-dm-choose-torrent title="Elegir archivo torrent" aria-label="Elegir archivo torrent">${dmIcon('folder')}</button><button type="button" class="dm-torrent-icon-action" data-dm-paste-torrent title="Pegar enlace magnet" aria-label="Pegar enlace magnet">${dmIcon('clipboard')}</button></div></label>
    </section>`;
  const footer = `<button data-dm-modal-close>Cancelar</button><button class="dm-primary-button" data-dm-queue-torrent ${state.torrentBusy ? 'disabled' : ''}>${state.torrentBusy ? 'Añadiendo…' : 'Añadir a la cola'}</button>`;
  return dialogShell('torrent', 'Nueva descarga torrent', body, footer);
}

export function cancelDialog(job) {
  const body = `<div class="dm-cancel-copy">${dmIcon('shield', 38)}<strong>Cancelar “${escapeHtml(job?.title || 'esta descarga')}”</strong><p>Se detendrán de forma segura los procesos y reintentos pendientes. Elige qué hacer con los datos parciales.</p></div><div class="dm-cancel-options"><button data-dm-confirm-cancel="keep" data-job-id="${job?.id}"><span>${dmIcon('pause')}</span><strong>Cancelar y conservar</strong><small>Mantiene fragmentos y temporales para recuperación manual.</small></button><button class="is-danger" data-dm-confirm-cancel="delete" data-job-id="${job?.id}"><span>${dmIcon('trash')}</span><strong>Cancelar y limpiar</strong><small>Elimina únicamente los temporales administrados cuando el proceso termine.</small></button></div>`;
  return dialogShell('cancel', 'Cancelar descarga', body, `<button data-dm-modal-close>Volver</button>`);
}

function storagePathList(paths = [], emptyLabel) {
  const values = Array.isArray(paths) ? paths.filter(Boolean) : [];
  return values.length
    ? `<ul>${values.map((path) => `<li><code title="${escapeHtml(path)}">${escapeHtml(path)}</code></li>`).join('')}</ul>`
    : `<span>${escapeHtml(emptyLabel)}</span>`;
}

export function deleteDialog(state, job) {
  const preview = state.deletePreview;
  const busy = Boolean(state.deletePreviewBusy);
  const deleting = Boolean(state.deleteBusy);
  const safe = Boolean(preview?.safeForStorageDeletion);
  const hasStorage = Boolean(preview?.storageExists);
  const warning = preview?.safetyWarning ? `<aside class="dm-delete-warning">${dmIcon('shield', 20)}<span><strong>El almacenamiento está protegido</strong><small>${escapeHtml(preview.safetyWarning)}</small></span></aside>` : '';
  const details = busy
    ? `<div class="dm-delete-loading"><i></i><strong>Validando rutas administradas…</strong></div>`
    : preview
      ? `<section class="dm-delete-paths"><article><strong>Archivo o carpeta final</strong>${storagePathList(preview.finalPaths, 'No existe una salida final registrada.')}</article><article><strong>Temporales relacionados</strong>${storagePathList(preview.partialPaths, 'No hay temporales registrados.')}</article><small>Raíz administrada: <code>${escapeHtml(preview.managedRoot || '')}</code></small></section>${warning}`
      : `<div class="dm-delete-loading is-error"><strong>No se pudieron inspeccionar las rutas.</strong></div>`;
  const body = `<div class="dm-delete-copy">${dmIcon('trash', 38)}<strong>Eliminar “${escapeHtml(job?.title || preview?.title || 'esta tarea')}”</strong><p>Eliminar solo de CacaTools conserva los archivos. La segunda opción elimina únicamente las rutas mostradas y nunca puede borrar la carpeta administrada completa.</p></div>${details}<div class="dm-delete-options"><button data-dm-confirm-delete="record" data-job-id="${job?.id}" ${busy || deleting ? 'disabled' : ''}><span>${dmIcon('file')}</span><strong>Solo de CacaTools</strong><small>Borra la tarea de la cola y el historial. Conserva archivos y carpetas.</small></button><label class="dm-delete-storage-option ${safe && hasStorage ? '' : 'is-disabled'}"><span>${dmIcon('trash')}</span><strong>CacaTools y almacenamiento</strong><small>Elimina las rutas finales y parciales indicadas arriba.</small><em><input type="checkbox" data-dm-delete-storage-ack ${safe && hasStorage && !busy && !deleting ? '' : 'disabled'}> Confirmo la eliminación del almacenamiento</em><button class="is-danger" data-dm-confirm-delete="storage" data-job-id="${job?.id}" disabled>Eliminar archivo y registro</button></label></div>`;
  return dialogShell('delete', 'Eliminar descarga', body, `<button data-dm-modal-close ${deleting ? 'disabled' : ''}>Volver</button>`);
}


export function bulkDeleteDialog(state, jobs = []) {
  const selected = jobs.filter((job) => state.selectedJobIds?.has?.(Number(job.id)));
  const count = selected.length;
  const preview = selected.slice(0, 6);
  const more = Math.max(0, count - preview.length);
  const body = `<div class="dm-delete-copy">${dmIcon('trash', 38)}<strong>Eliminar ${count} ${count === 1 ? 'descarga seleccionada' : 'descargas seleccionadas'}</strong><p>Puedes quitar los registros de CacaTools conservando los archivos, o eliminar también el almacenamiento administrado. Las tareas activas se detendrán de forma segura por el mismo flujo de borrado existente.</p></div>
    <section class="dm-bulk-delete-list">${preview.map((job) => `<span>${job.kind === 'playlist' ? dmPlaylistLogo(16) : dmIcon('file', 16)}<strong title="${escapeHtml(job.title)}">${escapeHtml(job.title)}</strong><small>${escapeHtml(job.status || '')}</small></span>`).join('')}${more ? `<em>+${more} más</em>` : ''}</section>
    <div class="dm-delete-options"><button data-dm-confirm-bulk-delete="record" ${state.bulkDeleteBusy || !count ? 'disabled' : ''}><span>${dmIcon('file')}</span><strong>Solo de CacaTools</strong><small>Elimina los registros seleccionados y conserva todos los archivos descargados.</small></button><label class="dm-delete-storage-option"><span>${dmIcon('trash')}</span><strong>CacaTools y almacenamiento</strong><small>Solicita al backend borrar únicamente las rutas administradas de cada elemento.</small><em><input type="checkbox" data-dm-bulk-delete-storage-ack ${state.bulkDeleteBusy || !count ? 'disabled' : ''}> Confirmo la eliminación del almacenamiento</em><button class="is-danger" data-dm-confirm-bulk-delete="storage" disabled>Eliminar archivos y registros</button></label></div>`;
  return dialogShell('bulk-delete', 'Eliminar selección', body, `<button data-dm-modal-close ${state.bulkDeleteBusy ? 'disabled' : ''}>Volver</button>`);
}

export function updateDialog(context = {}) {
  const update = context.availableUpdate || {};
  const version = String(update.version || 'nueva versión');
  const notes = String(update.notes || 'Incluye mejoras de estabilidad y experiencia en Clear Download Manager.');
  const body = `<section class="dm-info-dialog">
    <div class="dm-info-dialog-icon">${dmIcon('download', 30)}</div>
    <div class="dm-info-dialog-copy"><span class="dm-info-dialog-kicker">ACTUALIZACIÓN DISPONIBLE</span><h3>Clear Download Manager ${escapeHtml(version)}</h3><p>${escapeHtml(notes)}</p><small>La instalación no comienza automáticamente y se mantiene bloqueada mientras haya descargas activas.</small></div>
  </section>`;
  const busyLabel = context.updaterProgress?.phase === 'install' ? 'Instalando…' : 'Descargando…';
  const progress = updateProgressMarkup(context);
  const footer = `<button data-dm-modal-close ${context.updaterInstallBusy ? 'disabled' : ''}>Más tarde</button><button class="dm-primary-button" data-dm-modal-action="install-update" ${context.updaterInstallBusy ? 'disabled' : ''}>${context.updaterInstallBusy ? busyLabel : 'Instalar ahora'}</button>`;
  return dialogShell('update', 'Actualización disponible', `${body}${progress}`, footer);
}

export function renameDialog(job) {
  const currentName = String(job?.destination || job?.title || '').replace(/^.*[\\/]/, '');
  const body = `<form class="dm-rename-form" data-dm-rename-form><label for="dm-rename-name">Nuevo nombre</label><input id="dm-rename-name" name="filename" value="${escapeHtml(currentName)}" maxlength="180" autocomplete="off" required><small>El archivo descargado se renombrará en su carpeta. Su extensión se conservará.</small></form>`;
  return dialogShell('rename', 'Renombrar archivo', body, '<button data-dm-modal-close>Cancelar</button><button class="dm-primary-button" data-dm-rename-save>Guardar</button>');
}

export function newsDetailsDialog(context = {}) {
  const message = context.newsMessages?.find((item) => item.id === context.newsId) || {};
  const details = Array.isArray(message.details) ? message.details.filter(Boolean) : [];
  const list = details.length ? `<ul class="dm-news-details-list">${details.map((entry) => `<li>${escapeHtml(entry)}</li>`).join('')}</ul>` : `<p class="dm-news-details-empty">${escapeHtml(message.body || '')}</p>`;
  const image = message.image || message.thumbnail;
  const media = image ? `<button class="dm-news-details-image-button" type="button" data-dm-news-action="open-news-image" data-news-image="${escapeHtml(image)}"><img src="${escapeHtml(image)}" alt="" loading="lazy" decoding="async"></button>` : '';
  return dialogShell('news-details', escapeHtml(message.title || 'Detalles de novedades'), `<section class="dm-news-details-dialog"><p>${escapeHtml(message.summary || message.body || '')}</p>${list}${media}</section>`, `<button data-dm-modal-close>${context.t?.('close') || 'Cerrar'}</button>`);
}

export function newsImageDialog(context = {}) {
  const image = String(context.newsImage || '').trim();
  if (!image) return '';
  return dialogShell('news-image', 'Vista previa', `<div class="dm-news-image-preview"><img src="${escapeHtml(image)}" alt="" decoding="async"></div>`, `<button data-dm-modal-close>Cerrar</button>`);
}

export function clipboardPreviewDialog(prompt = {}) {
  const title = String(prompt.title || 'Enlace detectado');
  const platform = String(prompt.host || 'Origen web');
  const kind = prompt.kind === 'playlist' ? 'Playlist' : 'Multimedia';
  const visual = prompt.thumbnail
    ? `<img class="dm-clipboard-preview-thumb" src="${escapeHtml(prompt.thumbnail)}" alt="" loading="eager" decoding="async">`
    : prompt.kind === 'playlist' ? dmFileAsset('playlist-prep', 'is-clipboard') : dmIcon('video', 34);
  const body = `<section class="dm-clipboard-preview"><div class="dm-clipboard-preview-visual">${visual}</div><div class="dm-clipboard-preview-copy"><span class="dm-info-dialog-kicker">ENLACE DETECTADO</span><h3>${escapeHtml(title)}</h3><p>${escapeHtml(kind)} · ${escapeHtml(platform)}</p><small>Elige Analizar para abrir la preparación correspondiente. La descarga no comenzará desde esta sugerencia.</small><label class="dm-clipboard-suggestion-option"><input type="checkbox" data-dm-clipboard-suppress><span>No volver a mostrar sugerencias del portapapeles</span></label></div></section>`;
  const footer = `<button data-dm-clipboard-action="cancel">Cancelar</button><button class="dm-primary-button" data-dm-clipboard-action="analyze">Analizar</button>`;
  return dialogShell('clipboard-preview', 'Enlace detectado', body, footer);
}

export function extensionDialog() {
  const body = `<section class="dm-info-dialog">
    <div class="dm-info-dialog-icon">${dmIcon('link', 30)}</div>
    <div class="dm-info-dialog-copy"><span class="dm-info-dialog-kicker">EXTENSIÓN DE CLEAR DOWNLOAD MANAGER</span><h3>Envía enlaces desde tu navegador</h3><p>Envía enlaces al gestor y consulta tus descargas directamente desde el navegador.</p><small>La extensión no se instala automáticamente. Solo se abrirá la Chrome Web Store si eliges continuar.</small></div>
  </section>`;
  const footer = `<button data-dm-modal-action="decline-extension">No gracias</button><button class="dm-primary-button" data-dm-modal-action="open-extension">Ver extensión</button>`;
  return dialogShell('extension', 'Extensión de Clear Download Manager', body, footer);
}

export function feedbackDialog() {
  const body = `<section class="dm-feedback-dialog">
    <p class="dm-feedback-intro">Prepara un reporte local para abrirlo en GitHub. CacaTools no adjunta logs ni rutas privadas automáticamente.</p>
    <label><span>Tipo de reporte</span><select data-dm-feedback-field="type"><option value="problem">Problema</option><option value="suggestion">Sugerencia</option><option value="comment">Comentario</option><option value="other">Otro</option></select></label>
    <label><span>Título</span><input data-dm-feedback-field="title" maxlength="140" placeholder="Resumen breve"></label>
    <label><span>Descripción</span><textarea data-dm-feedback-field="description" maxlength="4000" rows="3" placeholder="Qué ocurrió y qué esperabas"></textarea></label>
    <label data-dm-feedback-steps><span>Pasos para reproducir</span><textarea data-dm-feedback-field="steps" maxlength="2500" rows="2" placeholder="1. …&#10;2. …"></textarea></label>
  </section>`;
  const footer = `<button data-dm-modal-close>Cancelar</button><button class="dm-primary-button" data-dm-modal-action="open-feedback">Abrir GitHub</button>`;
  return dialogShell('feedback', 'Comentarios y sugerencias', body, footer);
}

export function scheduleDialog(job) {
  const available = Boolean(job?.id);
  const body = `<div class="dm-schedule-form"><p>${available ? `Programa una acción local para <strong>${escapeHtml(job.title)}</strong>.` : '<strong>Selecciona primero una descarga.</strong> La programación se vincula a un trabajo concreto para evitar tareas sin efecto.'}</p><label>Acción<select id="dm-schedule-action" ${available ? '' : 'disabled'}><option value="resume">Iniciar o reanudar</option><option value="pause">Pausar</option><option value="cancel">Cancelar</option></select></label><label>Fecha y hora<input id="dm-schedule-at" type="datetime-local" ${available ? '' : 'disabled'}></label><label class="dm-switch-row"><span>Repetir diariamente</span><input id="dm-schedule-repeat" type="checkbox" ${available ? '' : 'disabled'}></label></div>`;
  return dialogShell('schedule', 'Programar tarea', body, `<button data-dm-modal-close>Cancelar</button><button class="dm-primary-button" data-dm-save-schedule data-job-id="${job?.id || ''}" ${available ? '' : 'disabled'}>Guardar tarea</button>`);
}

export function recoveryDialog(state, job) {
  const result = state.recoveryResult;
  const diagnosis = result?.diagnosis || {};
  const attempts = Number(result?.verification_attempts || 0);
  const verdictClass = result?.original_available ? 'is-available' : diagnosis.likely_temporary ? 'is-temporary' : 'is-unavailable';
  const sessionRequired = diagnosis.code === 'authentication_required' || result?.recovery_mode === 'session_required';
  const suggestions = Array.isArray(diagnosis.suggestions) ? diagnosis.suggestions.filter(Boolean) : [];
  const alternatives = Array.isArray(result?.alternatives) ? result.alternatives : [];
  const resultMarkup = result ? `<div class="dm-recovery-verdict ${verdictClass}"><span class="dm-recovery-code">${dmIcon(result.original_available ? 'check' : diagnosis.likely_temporary ? 'clock' : 'shield', 18)} ${escapeHtml(diagnosis.title || (result.original_available ? 'Fuente disponible' : 'Fallo confirmado'))}</span><strong>${escapeHtml(result.message || diagnosis.summary || '')}</strong><small>${attempts ? `Fuente comprobada ${attempts === 1 ? 'una vez' : `${attempts} veces`}` : 'Diagnóstico basado en el registro local'} · ${escapeHtml(diagnosis.code || 'diagnóstico')}</small></div>
    ${suggestions.length ? `<section class="dm-recovery-suggestions"><strong>Qué conviene hacer</strong><ol>${suggestions.map((suggestion) => `<li>${escapeHtml(suggestion)}</li>`).join('')}</ol></section>` : ''}
    ${alternatives.length ? `<section class="dm-alternative-list"><header><strong>Alternativas encontradas</strong><span>Ordenadas por título, autor y duración.</span></header>${alternatives.map((item, index) => `<article><span>${progressiveThumbnailMarkup(item, index, 28)}</span><div><strong>${escapeHtml(item.title)}</strong><small>${escapeHtml(item.creator || '')}</small><b>${Math.round(item.similarity || 0)}% similar</b>${matchReasonMarkup(item)}</div><button data-dm-analyze-result="${escapeHtml(item.source_url || '')}">Usar alternativa</button></article>`).join('')}</section>` : `<div class="dm-recovery-no-alternatives"><strong>${result.recovery_mode === 'media_alternatives' ? 'No apareció una alternativa suficientemente fiable' : 'No es necesario buscar otro vídeo para este tipo de error'}</strong><span>El asistente conserva el archivo parcial y propone reparar la tarea original cuando es seguro.</span></div>`}
    ${sessionRequired ? `<div class="dm-recovery-actions"><button class="dm-primary-button" data-dm-open-session-settings>${dmIcon('settings')} Abrir ajustes de sesión</button></div>` : result.can_retry ? `<div class="dm-recovery-actions"><button class="dm-primary-button" data-dm-retry-recovery data-job-id="${job?.id}">${dmIcon('retry')} ${result.original_available ? 'Reanudar fuente original' : 'Reintentar conservando el parcial'}</button></div>` : ''}` : '';
  const body = `<section class="dm-recovery-flow"><header>${dmIcon('shield', 38)}<div><strong>${escapeHtml(job?.title || 'Descarga con error')}</strong><span>Diagnóstico local, doble comprobación y reparación según el tipo de tarea.</span></div></header>${state.recoveryBusy ? `<div class="dm-recovery-checking"><i></i><strong>Confirmando el error antes de actuar…</strong><span>Se distingue entre fallo temporal, restricción, archivo bloqueado y contenido realmente ausente.</span></div>` : result ? resultMarkup : `<div class="dm-recovery-intro"><strong>¿El error es definitivo o todavía se puede corregir?</strong><span>Primero se verificará la fuente. Solo los vídeos realmente no disponibles activarán la búsqueda de alternativas.</span><button data-dm-run-recovery data-job-id="${job?.id}">${dmIcon('retry')} Diagnosticar y confirmar</button></div>`}</section>`;
  return dialogShell('recovery', 'Diagnóstico y recuperación', body);
}
