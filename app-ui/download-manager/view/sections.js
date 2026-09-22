import { categoriesFromJobs, escapeHtml, formatBytes, formatSpeed, statusCounts } from '../core/model.js';
import { dmIcon } from './icons.js';
import { fileGlyph, infrastructureSettings, progressMarkup, settingsFields, statusLabel } from './shared.js';

const actionLabels = { resume: 'Iniciar o reanudar', pause: 'Pausar', cancel: 'Cancelar' };
let sectionLocale = 'es';
export function setSectionLocale(value) { sectionLocale = String(value || '').toLowerCase().startsWith('en') ? 'en' : 'es'; }

export function sectionTitle(section) {
  return ({
    downloads: ['Descargas', 'Todos los trabajos locales y sus estados.'],
    panel: ['Panel', 'Vista general del gestor y accesos rápidos.'],
    queue: ['Gestor de cola', 'Ordena lo pendiente y controla qué se ejecuta.'],
    running: ['Descargas activas', 'Trabajos que están transfiriendo datos ahora.'],
    completed: ['Completadas', 'Archivos terminados y validados.'],
    history: ['Historial', 'Trabajos completados, cancelados o con error.'],
    media: ['Multimedia', 'Vídeos, audio y playlists resueltos con yt-dlp.'],
    categories: ['Categorías', 'Organiza y filtra archivos por tipo.'],
    scheduler: ['Programación', 'Inicia, pausa o cancela trabajos automáticamente.'],
    settings: ['Ajustes', 'Diseño, modo visual y colores del gestor.'],
    news: sectionLocale === 'en' ? ["What's new", 'Updates, information and support for Clear Download Manager.'] : ['Novedades', 'Actualizaciones, información y soporte de Clear Download Manager.']
  })[section] || ['Descargas', 'Gestor local de archivos y multimedia.'];
}

export function sectionHeading(section, count = null, actions = '') {
  const [title, description] = sectionTitle(section);
  return `<header class="dm-section-heading"><div><span>${dmIcon(section === 'scheduler' ? 'calendar' : section === 'categories' ? 'folder' : section === 'settings' ? 'settings' : section === 'news' ? 'bell' : section === 'media' ? 'video' : 'download', 26)}</span><div><h2>${escapeHtml(title)}</h2><p>${escapeHtml(description)}</p></div></div><div class="dm-section-heading-actions">${actions}${count === null ? '' : `<b>${count}</b>`}</div></header>`;
}

export function categoriesPanel(jobs) {
  const categories = categoriesFromJobs(jobs);
  const cards = categories.map((category) => {
    const items = jobs.filter((job) => job.category === category);
    const running = items.filter((job) => job.status === 'running').length;
    const bytes = items.reduce((total, job) => total + Number(job.totalBytes || job.downloadedBytes || 0), 0);
    return `<button class="dm-category-card" data-dm-category-jump="${escapeHtml(category)}"><span>${dmIcon(category === 'Vídeo' ? 'video' : category === 'Música' ? 'sparkles' : category === 'Torrents' ? 'magnet' : 'folder', 28)}</span><div><strong>${escapeHtml(category)}</strong><small>${items.length} elemento${items.length === 1 ? '' : 's'} · ${formatBytes(bytes)}</small></div><em>${running ? `${running} activa${running === 1 ? '' : 's'}` : 'Abrir'}</em></button>`;
  }).join('');
  return `<section class="dm-section-page">${sectionHeading('categories', jobs.length)}<div class="dm-category-grid">${cards || `<div class="dm-section-empty">${dmIcon('folder', 42)}<strong>No hay categorías todavía</strong><span>Se crearán automáticamente al añadir archivos.</span></div>`}</div></section>`;
}

export function schedulerPanel(jobs, schedules = [], selectedJobId = null) {
  const jobMap = new Map(jobs.map((job) => [Number(job.id), job]));
  const rows = schedules.map((schedule) => {
    const job = jobMap.get(Number(schedule.job_id));
    return `<article class="dm-schedule-row"><span>${dmIcon('calendar', 24)}</span><div><strong>${escapeHtml(job?.title || `Trabajo #${schedule.job_id || '—'}`)}</strong><small>${escapeHtml(actionLabels[schedule.action] || schedule.action)} · ${escapeHtml(String(schedule.run_at || '').replace('T', ' '))}${schedule.repeat_daily ? ' · cada día' : ''}</small></div><em>${schedule.enabled ? 'Activa' : 'Desactivada'}</em><button data-dm-delete-schedule="${schedule.id}" aria-label="Eliminar tarea">${dmIcon('trash', 18)}</button></article>`;
  }).join('');
  return `<section class="dm-section-page">${sectionHeading('scheduler', schedules.length)}<div class="dm-scheduler-page-actions"><div>${dmIcon('clock', 24)}<span><strong>Programador local</strong><small>La aplicación revisa las tareas cada pocos segundos y conserva la programación en SQLite.</small></span></div><button class="dm-primary-button" data-dm-new-schedule data-dm-schedule-job="${selectedJobId || ''}" ${jobs.length ? '' : 'disabled'}>${dmIcon('plus')} Nueva tarea</button></div><div class="dm-schedule-list">${rows || `<div class="dm-section-empty">${dmIcon('calendar', 46)}<strong>No hay tareas programadas</strong><span>Selecciona una descarga y crea una acción con fecha y hora.</span></div>`}</div></section>`;
}

export function settingsPanel(preferences) {
  return `<section class="dm-section-page">${sectionHeading('settings')}<div class="dm-settings-page"><article><span>${dmIcon('palette', 34)}</span><div><strong>Apariencia Zen</strong><small>El gestor usa una única composición Zen, fluida y legible; el usuario controla modo, escala y colores sin alterar el motor.</small></div></article><div class="dm-settings-page-fields">${settingsFields(preferences)}</div><aside>${dmIcon('shield', 22)}<span><strong>Preferencias locales</strong><small>Se guardan únicamente en este equipo y pueden restablecerse sin tocar descargas ni historial.</small></span></aside></div></section>`;
}

export function newsPanel(context = {}) {
  const messages = Array.isArray(context.newsMessages) ? context.newsMessages : [];
  const t = (key, fallback, ...args) => context.translate?.(key, ...args) || fallback;
  const localeDate = (value) => context.formatDate?.(value) || '';
  const filter = ['all', 'updates', 'extension', 'history'].includes(context.newsFilter) ? context.newsFilter : 'all';
  const history = Array.isArray(context.experienceSettings?.installedUpdateHistory) ? context.experienceSettings.installedUpdateHistory : [];
  const iconFor = (message) => message.type === 'update' ? 'download' : message.type === 'extension' ? 'link' : message.type === 'release' ? 'sparkles' : message.type === 'manual' ? 'globe' : 'shield';
  const assetFor = (message) => message.type === 'update' || message.type === 'release'
    ? './app-ui/assets/news/Novedad.png'
    : message.type === 'extension'
      ? './app-ui/assets/news/Extension.png'
      : message.type === 'manual'
        ? './app-ui/assets/news/Imagenes.png'
        : '';
  const semanticIcon = (asset, mode = 'green') => {
    if (!asset) return '';
    const matrix = mode === 'blue' ? '0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 -1 0 1 0 0' : '0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 -1 2 -1 0 0';
    const id = `dm-semantic-${mode}`;
    return `<svg class="dm-news-semantic-icon" viewBox="0 0 1254 1254" aria-hidden="true"><defs><filter id="${id}" color-interpolation-filters="sRGB"><feColorMatrix type="matrix" values="${matrix}" result="accentMask"/><feComponentTransfer in="accentMask" result="cleanAccentMask"><feFuncA type="linear" slope="1.35" intercept="-0.22"/></feComponentTransfer><feFlood style="flood-color:var(--dm-icon-accent)" result="accentColor"/><feComposite in="accentColor" in2="cleanAccentMask" operator="in"/></filter></defs><image href="${asset}" width="1254" height="1254" preserveAspectRatio="xMidYMid meet"/><image href="${asset}" width="1254" height="1254" preserveAspectRatio="xMidYMid meet" filter="url(#${id})"/></svg>`;
  };
  const englishNews = String(context.locale?.() || context.locale || '').toLowerCase().startsWith('en');
  const actionsFor = (message) => {
    if (message.type === 'update') return `<button type="button" data-dm-news-action="open-update-modal">${t('update', 'Actualizar')}</button><button type="button" data-dm-news-action="open-news-details" data-news-id="${escapeHtml(message.id)}">${t('details', 'Más detalles')}</button>`;
    if (message.type === 'extension' && message.action?.type === 'open-url') return `<button type="button" data-dm-news-action="open-news-url" data-news-url="${escapeHtml(message.action.url || '')}">${escapeHtml(message.action.label || t('open', 'Abrir'))}</button>`;
    if (message.type === 'extension') return `<button type="button" data-dm-news-action="open-extension-modal">${t('extension', 'Extensión')}</button>`;
    if (message.action?.type === 'open-feedback') return `<button type="button" data-dm-news-action="feedback">${t('feedback', 'Comentarios y sugerencias')}</button>`;
    if (message.action?.type === 'open-url') return `<button type="button" data-dm-news-action="open-news-url" data-news-url="${escapeHtml(message.action.url || '')}">${escapeHtml(message.action.label || t('open', 'Abrir'))}</button>`;
    return '';
  };
  const filtered = filter === 'updates' ? messages.filter((item) => item.type === 'update' || item.type === 'release') : filter === 'extension' ? messages.filter((item) => item.type === 'extension') : filter === 'history' ? [] : messages;
  const markup = filtered.map((message) => {
    const image = message.image || message.thumbnail;
    const asset = assetFor(message);
    const media = asset ? semanticIcon(asset, message.type === 'manual' ? 'blue' : 'green') : dmIcon(iconFor(message), 22);
    const promo = image ? `<button class="dm-news-image-button dm-news-promo" type="button" data-dm-news-action="open-news-image" data-news-image="${escapeHtml(image)}"><img class="dm-news-thumbnail" src="${escapeHtml(image)}" alt="" loading="lazy" decoding="async"></button>` : '';
    const date = localeDate(message.publishedAt);
    const versionMatch = String(message.title || '').match(/(\d+\.\d+(?:\.\d+)?)/);
    const title = englishNews && message.type === 'update' ? `Clear Download Manager ${versionMatch?.[1] || ''} — What's new`.replace(/  —/, ' —') : englishNews && message.type === 'extension' ? t('extensionTitle', 'Clear Download Manager extension') : message.title;
    const summary = englishNews && message.type === 'update' ? t('updateSummary', 'CDM includes important stability, performance and experience improvements.') : englishNews && message.type === 'extension' ? t('extensionSummary', 'Send links, videos and playlists from your browser directly to CDM.') : (message.summary || message.body);
    const category = message.type === 'update' || message.type === 'release' ? t('updateCategory', 'ACTUALIZACIÓN') : message.type === 'extension' ? t('extensionCategory', 'EXTENSIÓN') : message.type === 'manual' ? (englishNews ? 'NEWS' : 'NOVEDAD') : '';
    const actions = actionsFor(message);
    const dismiss = message.dismissible ? `<button type="button" class="dm-news-dismiss" data-dm-news-action="dismiss-news" data-news-id="${escapeHtml(message.id)}" aria-label="${t('dismissNews', 'Quitar de novedades')}" title="${t('dismissNews', 'Quitar de novedades')}">×</button>` : '';
    return `<article class="dm-news-item ${message.actionRequired ? 'dm-news-action' : ''} ${message.read ? 'is-read' : ''}" data-news-id="${escapeHtml(message.id)}"><span class="dm-news-media">${media}</span><div class="dm-news-copy"><div class="dm-news-meta">${category ? `<span class="dm-news-category">${escapeHtml(category)}</span>` : ''}${date ? `<span class="dm-news-date">${category ? '· ' : ''}${escapeHtml(date)}</span>` : ''}</div><strong>${escapeHtml(title)}</strong><small>${escapeHtml(summary)}</small></div>${promo}${actions || dismiss ? `<div class="dm-news-actions">${actions}${dismiss}</div>` : ''}</article>`;
  }).join('');
  const historyMarkup = history.filter((entry) => !(context.experienceSettings?.dismissedHistoryIds || []).includes(entry.id)).map((entry) => `<article class="dm-news-history-row"><span>${dmIcon('check', 20)}</span><div><small>${t('installed', 'Instalada')} · ${escapeHtml(localeDate(entry.installedAt))}</small><strong>Clear Download Manager ${escapeHtml(entry.version)}</strong><small>${escapeHtml(entry.summary || '')}</small></div><button type="button" aria-label="${t('close', 'Cerrar')}" data-dm-news-action="dismiss-history" data-history-id="${escapeHtml(entry.id)}">×</button></article>`).join('');
  const content = filter === 'history' ? (historyMarkup || `<div class="dm-section-empty dm-news-empty">${dmIcon('history', 42)}<strong>${t('historyTitle', 'Actualizaciones anteriores')}</strong><span>${t('noNewsDescription', 'Las actualizaciones y avisos aparecerán aquí.')}</span></div>`) : (markup || `<div class="dm-section-empty dm-news-empty">${dmIcon('bell', 42)}<strong>${t('noNews', 'No hay novedades nuevas')}</strong><span>${t('noNewsDescription', 'Las actualizaciones y avisos aparecerán aquí.')}</span></div>`);
  const support = filter === 'history' ? '' : `<aside class="dm-news-support"><span class="dm-news-support-media">${semanticIcon('./app-ui/assets/news/Apoyo.png')}</span><div><strong>${t('support', 'Apoya el proyecto')}</strong><small>${t('supportDescription', 'Tu apoyo ayuda a mantener Clear Download Manager en desarrollo.')}</small></div><button type="button" data-dm-news-action="support">${t('supportAction', 'Apoyar')}</button></aside>`;
  const headerActions = `<div class="dm-news-header-actions"><button type="button" data-dm-news-action="check-update" title="${t('checkUpdates', 'Buscar actualizaciones')}">${dmIcon('retry', 16)}<span>${t('checkUpdates', 'Buscar actualizaciones')}</span></button><button type="button" data-dm-news-action="feedback" title="${t('feedback', 'Comentarios y sugerencias')}">${dmIcon('clipboard', 16)}<span>${t('feedback', 'Comentarios y sugerencias')}</span></button></div>`;
  return `<section class="dm-section-page dm-news-page">${sectionHeading('news', null, headerActions)}<nav class="dm-news-filters" aria-label="${t('news', 'Novedades')}"><button type="button" class="${filter === 'all' ? 'is-active' : ''}" data-dm-news-filter="all">${t('all', 'Todas')}</button><button type="button" class="${filter === 'updates' ? 'is-active' : ''}" data-dm-news-filter="updates">${t('updates', 'Actualizaciones')}</button><button type="button" class="${filter === 'extension' ? 'is-active' : ''}" data-dm-news-filter="extension">${t('extension', 'Extensión')}</button><button type="button" class="${filter === 'history' ? 'is-active' : ''}" data-dm-news-filter="history">${t('history', 'Historial')}</button></nav><div class="dm-news-list">${content}</div>${support}</section>`;
}

export function mediaOverview(jobs) {
  const mediaJobs = jobs.filter((job) => ['media', 'video', 'audio'].includes(job.kind) || job.origin === 'yt-dlp');
  const cards = mediaJobs.slice(0, 24).map((job) => `<article class="dm-media-card" data-dm-select-job="${job.id}" role="button" tabindex="0">${fileGlyph(job, true)}<div><strong title="${escapeHtml(job.title)}">${escapeHtml(job.title)}</strong><small>${escapeHtml(statusLabel(job.status))} · ${escapeHtml(job.category)} · ${formatSpeed(job.speedBps)}</small>${progressMarkup(job, false)}</div><button data-dm-job-action="${job.status === 'running' ? 'pause' : 'resume'}" data-job-id="${job.id}">${dmIcon(job.status === 'running' ? 'pause' : 'play')}</button></article>`).join('');
  return `<section class="dm-media-overview"><div class="dm-media-overview-head"><div>${dmIcon('library', 30)}<span><strong>Biblioteca multimedia</strong><small>Miniaturas, pistas, playlists y conversiones locales.</small></span></div><button data-dm-video-search>${dmIcon('search')} Buscar vídeo</button></div><div class="dm-media-grid">${cards || `<div class="dm-section-empty">${dmIcon('video', 44)}<strong>No hay trabajos multimedia</strong><span>Busca un título o analiza un enlace de vídeo o playlist.</span></div>`}</div></section>`;
}

export function overviewCards(jobs) {
  const counts = statusCounts(jobs);
  const speed = jobs.filter((job) => job.status === 'running').reduce((total, job) => total + Number(job.speedBps || 0), 0);
  return `<section class="dm-overview-cards"><article>${dmIcon('download', 28)}<div><small>Activas</small><strong>${counts.running}</strong><span>${counts.queued} en cola</span></div></article><article>${dmIcon('check', 28)}<div><small>Completadas</small><strong>${counts.completed}</strong><span>${counts.failed} con error</span></div></article><article>${dmIcon('globe', 28)}<div><small>Velocidad total</small><strong>${formatSpeed(speed)}</strong><span>Motor local</span></div></article></section>`;
}

export function specialSectionPanel(section, context) {
  if (section === 'categories') return categoriesPanel(context.jobs || []);
  if (section === 'scheduler') return schedulerPanel(context.jobs || [], context.schedules || [], context.preferences?.selectedJobId);
  if (section === 'settings') return `${settingsPanel(context.preferences)}${infrastructureSettings(context)}`;
  if (section === 'news') return newsPanel(context);
  return '';
}
