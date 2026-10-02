import { DEFAULT_ICON_COLOR, DEFAULT_ICON_COLOR_MODE } from '../appearance/tokens.js';
import { iconVariantForColor } from '../appearance/index.js';

let settingsContext = {};
let appState = {};
let advancedOpen = false;
let APP_VERSION = '1.0.0';
let THUMBNAIL_CACHE_VERSION = 1;

const contextValue = (name, fallback) => settingsContext[name] || fallback;
const icon = (...args) => contextValue('icon', () => '')(...args);
const escapeHtml = (...args) => contextValue('escapeHtml', (value) => String(value ?? ''))(...args);
const invoke = (...args) => contextValue('invoke', () => Promise.reject(new Error('Tauri no disponible')))(...args);
const appearancePresets = [];
const visualDiagnosticsSnapshot = (...args) => contextValue('visualDiagnosticsSnapshot', () => ({}))(...args);
const displayedScalePercent = (...args) => contextValue('displayedScalePercent', (value) => value)(...args);
const automaticScalePercent = (...args) => contextValue('automaticScalePercent', () => 100)(...args);
const downloadDirectoryLabel = (...args) => contextValue('downloadDirectoryLabel', () => '')(...args);
const locale = () => contextValue('locale', () => 'system')();
const tr = (key, ...args) => contextValue('translate', (name) => name)(key, ...args);

export function configureSettings(context = {}) {
  settingsContext = context;
  appState = context.getAppState?.() || {};
  appearancePresets.splice(0, appearancePresets.length, ...(context.appearancePresets || []));
  APP_VERSION = context.APP_VERSION || APP_VERSION;
  THUMBNAIL_CACHE_VERSION = context.THUMBNAIL_CACHE_VERSION || THUMBNAIL_CACHE_VERSION;
}

export function syncAccentPresetSelection(root, selectedPresetId, checkIconMarkup) {
  root.querySelectorAll('.settings-accent-swatch:not(.settings-icon-color-swatch)').forEach((entry) => {
    const isActive = Boolean(selectedPresetId) && entry.dataset.preset === selectedPresetId;
    entry.classList.toggle('is-active', isActive);
    entry.setAttribute('aria-pressed', String(isActive));
    entry.innerHTML = `<i></i>${isActive ? checkIconMarkup : ''}`;
  });
}

export function setSettingsAdvancedOpen(value) {
  advancedOpen = Boolean(value);
}

const checked = (value, expected) => value === expected ? 'checked' : '';
const selected = (value, expected) => value === expected ? 'selected' : '';

function pageIntro(title, description = '') {
  return `<header class="settings-page-intro"><div><h2>${title}</h2>${description ? `<p>${description}</p>` : ''}</div></header>`;
}

function sectionHeading(title) {
  return `<div class="settings-section-heading is-text-only"><h3>${title}</h3></div>`;
}

function statusRow(label, value, tone = 'ok') {
  return `<div class="settings-status-row"><span>${label}</span><strong data-status-tone="${tone}">${value}</strong></div>`;
}

function choice(name, label, values, value) {
  return `<fieldset class="settings-choice"><legend>${label}</legend><div class="settings-choice-options settings-choice-options-${values.length}">${values.map(([id, text]) => `<label><input type="radio" name="appearance-${name}" value="${id}" data-appearance-field="${name}" ${checked(value, id)}><span>${text}</span></label>`).join('')}</div></fieldset>`;
}

function range(id, label, value, min, max) {
  const field = id === 'text-scale' ? 'textScale' : id;
  const suffix = id === 'tone' ? '' : '%';
  const step = ['tone', 'intensity', 'contrast'].includes(id) ? 1 : 5;
  return `<div class="settings-control settings-range-control"><span id="${id}-range-label" class="settings-range-label"><b>${label}</b></span><div class="settings-range-line"><input id="${id}-range" data-appearance-field="${field}" type="range" min="${min}" max="${max}" step="${step}" value="${value}" aria-labelledby="${id}-range-label"><output data-setting-value="${id}">${value}${suffix}</output></div></div>`;
}

function selectControl(id, field, label, value, options) {
  return `<label class="settings-control"><span><b>${label}</b></span><select id="${id}" data-appearance-field="${field}">${options.map(([option, text]) => `<option value="${option}" ${selected(value, option)}>${text}</option>`).join('')}</select></label>`;
}

function numericStepper(id, label, value, min, max) {
  return `<label class="settings-control settings-number-stepper"><span><b>${label}</b></span><div class="settings-stepper"><button type="button" data-settings-step="${id}" data-settings-step-delta="-1" aria-label="Reducir ${label}" ${value <= min ? 'disabled' : ''}>−</button><input id="${id}" type="number" min="${min}" max="${max}" step="1" inputmode="numeric" value="${escapeHtml(value)}" aria-label="${label}"><button type="button" data-settings-step="${id}" data-settings-step-delta="1" aria-label="Aumentar ${label}" ${value >= max ? 'disabled' : ''}>+</button></div></label>`;
}

function experienceToggle(id, key, label, description, value) {
  return `<label class="settings-control settings-switch-control settings-experience-toggle"><span><b>${label}</b>${description ? `<small>${description}</small>` : ''}</span><input id="${id}" type="checkbox" role="switch" data-experience-field="${key}" ${value !== false ? 'checked' : ''}></label>`;
}

function downloadBehaviorToggle(key, label, enabled) {
  return `<label class="settings-control settings-switch-control settings-experience-toggle"><span><b>${tr(label)}</b></span><input type="checkbox" role="switch" data-download-behavior="${key}" ${enabled ? 'checked' : ''}></label>`;
}

function nav(activeCategory) {
  const entries = [['general', 'General'], ['downloads', 'Descargas'], ['multimedia', 'Multimedia'], ['appearance', 'Apariencia'], ['integrations', 'Integraciones'], ['updates', 'Actualizaciones y diagnóstico'], ['components', 'Complementos']];
  const brandIconVariant = iconVariantForColor(appState.appearance?.accent || '#24b8e8');
  const back = tr('back') || 'Volver al gestor';
  return `<nav class="settings-workspace-nav" aria-label="Categorías de ajustes"><div class="settings-nav-brand"><img class="settings-nav-logo" data-cdm-brand-logo data-brand-icon-base="./app-ui/assets/brand" src="./app-ui/assets/brand/clear-download-manager-${brandIconVariant}.webp" alt="Clear Download Manager"><strong>Clear Download<br>Manager</strong></div><div class="settings-nav-items">${entries.map(([id, sourceLabel]) => { const label = tr(sourceLabel); return `<button type="button" class="settings-category-button ${activeCategory === id ? 'is-active' : ''}" data-settings-category="${id}" aria-current="${activeCategory === id ? 'page' : 'false'}" aria-label="${label}" title="${label}"><span class="settings-nav-icon" data-settings-icon="${id}" aria-hidden="true"></span><span>${label}</span></button>`; }).join('')}</div><div class="settings-nav-footer"><button type="button" class="settings-back" title="${back}" aria-label="${back}">${icon('arrow', 18)}<span>${back}</span></button></div></nav>`;
}

function generalPage() {
  const closeAction = appState.windowBehavior?.closeAction === 'exit' ? 'exit' : 'tray';
  const startupDisabled = appState.startupStatus?.supported === false;
  const experience = appState.experienceSettings || {};
  const selectedLocale = ['system', 'es', 'en'].includes(String(experience.locale || locale())) ? String(experience.locale || locale()) : 'system';
  return `<div class="settings-page settings-page-general">
    ${pageIntro(tr('general'), tr('windowStartup'))}
    <section class="settings-section">${sectionHeading(tr('windowBehavior'))}${selectControl('close-action-select', 'closeAction', tr('closeAction'), closeAction, [['tray', tr('closeToTray')], ['exit', tr('exitCompletely')]])}<label class="settings-control settings-switch-control"><span><b>${tr('startWithWindows')}</b></span><input id="startup-toggle" type="checkbox" role="switch" ${checked(Boolean(appState.startupStatus?.enabled), true)} ${startupDisabled ? 'disabled' : ''}></label></section>
    <section class="settings-section">${sectionHeading(tr('language'))}<label class="settings-control"><span><b>${tr('interfaceLanguage')}</b></span><select data-experience-field="locale" aria-label="${tr('interfaceLanguage')}"><option value="system" ${selected(selectedLocale, 'system')}>${tr('system')}</option><option value="es" ${selected(selectedLocale, 'es')}>${tr('spanish')}</option><option value="en" ${selected(selectedLocale, 'en')}>${tr('english')}</option></select></label></section>
    <section class="settings-section settings-section-experience">${sectionHeading(tr('automation'))}${experienceToggle('clipboard-suggest-toggle', 'clipboardAutoSuggest', tr('detectClipboard'), '', experience.clipboardAutoSuggest)}${experienceToggle('auto-updates-toggle', 'automaticUpdateChecks', tr('automaticUpdates'), '', experience.automaticUpdateChecks)}</section>
    <section class="settings-section settings-section-compact">${sectionHeading(tr('status'))}${statusRow(tr('minimize'), tr('taskbar'))} ${statusRow(tr('closeAction'), closeAction === 'exit' ? tr('exit') : tr('tray'))}</section>
    <section class="settings-section settings-reset-all-section">${sectionHeading(tr('Restablecer todos los ajustes'))}<p class="settings-section-note">${tr('Restablece las preferencias de la aplicación. Se conservan las descargas, el historial y los archivos.')}</p><button type="button" class="settings-reset-all" data-settings-reset-all>${tr('Restablecer todos los ajustes')}</button></section>
  </div>`;
}

function downloadsPage() {
  const storedHttpConcurrency = Number(appState.downloadConcurrency?.http);
  const storedMultimediaConcurrency = Number(appState.downloadConcurrency?.multimedia);
  const httpConcurrency = Number.isSafeInteger(storedHttpConcurrency) && storedHttpConcurrency >= 1 && storedHttpConcurrency <= 8 ? storedHttpConcurrency : 2;
  const multimediaConcurrency = Number.isSafeInteger(storedMultimediaConcurrency) && storedMultimediaConcurrency >= 1 && storedMultimediaConcurrency <= 4 ? storedMultimediaConcurrency : 1;
  const bytes = appState.bandwidthSettings?.mode === 'limited' ? Number(appState.bandwidthSettings.bytesPerSecond || 0) : 0;
  const presets = [512_000, 1_000_000, 2_000_000, 5_000_000, 10_000_000, 25_000_000, 50_000_000];
  const selectedValue = appState.bandwidthEditorMode === 'custom'
    ? 'custom'
    : bytes === 0 ? 'unlimited' : presets.includes(bytes) ? String(bytes) : 'custom';
  const customVisible = selectedValue === 'custom';
  const limitOptions = [
    ['unlimited', 'Sin límite'],
    ['512000', '512 KB/s'],
    ['1000000', '1 MB/s'],
    ['2000000', '2 MB/s'],
    ['5000000', '5 MB/s'],
    ['10000000', '10 MB/s'],
    ['25000000', '25 MB/s'],
    ['50000000', '50 MB/s'],
    ['custom', 'Personalizado']
  ];
  const storedCustomUnit = bytes > 0 && bytes % 1_000_000 !== 0 ? 'KB' : 'MB';
  const storedCustomValue = storedCustomUnit === 'KB' ? Math.max(1, Math.round(bytes / 1_000)) : Math.max(1, bytes / 1_000_000);
  const custom = appState.bandwidthEditorMode === 'custom'
    ? Math.max(1, Number(appState.bandwidthCustomValue || 1))
    : storedCustomValue;
  const unit = appState.bandwidthEditorMode === 'custom'
    ? appState.bandwidthCustomUnit === 'KB' ? 'KB' : 'MB'
    : storedCustomUnit;
  const bandwidth = `<section class="settings-section settings-bandwidth-section">${sectionHeading('Velocidad')}<label class="settings-control"><span><b>Limitar velocidad de descarga</b></span><select id="bandwidth-limit-select" aria-label="Límite máximo por descarga">${limitOptions.map(([value, label]) => `<option value="${value}" ${selected(selectedValue, value)}>${label}</option>`).join('')}</select></label>${customVisible ? `<div class="settings-bandwidth-custom"><label><span>Velocidad personalizada</span><input id="bandwidth-custom-value" type="number" min="1" step="1" inputmode="numeric" value="${escapeHtml(custom)}"></label><label><span>Unidad</span><select id="bandwidth-custom-unit"><option value="KB" ${selected(unit, 'KB')}>KB/s</option><option value="MB" ${selected(unit, 'MB')}>MB/s</option></select></label><button type="button" class="save-bandwidth-custom">Guardar</button></div>` : ''}</section>`;
  const concurrency = `<section class="settings-section settings-concurrency-section">${sectionHeading('Descargas simultáneas')}${numericStepper('http-concurrency-input', 'HTTP', httpConcurrency, 1, 8)}${numericStepper('multimedia-concurrency-input', 'Multimedia', multimediaConcurrency, 1, 4)}</section>`;
  const behavior = appState.downloadBehaviorSettings || {};
  const behaviorSettings = `<section class="settings-section settings-section-download-behavior">${sectionHeading(tr('Comportamiento de descargas'))}${downloadBehaviorToggle('createCategoryFolders', 'Crear subcarpetas por categoría', behavior.createCategoryFolders !== false)}${downloadBehaviorToggle('useOriginalFileNames', 'Usar nombres de archivo originales', behavior.useOriginalFileNames !== false)}${downloadBehaviorToggle('askForDownloadLocation', 'Preguntar dónde guardar', behavior.askForDownloadLocation === true)}${downloadBehaviorToggle('resumeInterruptedDownloads', 'Reanudar descargas interrumpidas', behavior.resumeInterruptedDownloads !== false)}</section>`;
  return `<div class="settings-page settings-page-downloads">${pageIntro('Descargas', 'Destino y organización')}<section class="settings-section">${sectionHeading('Carpeta de descargas')}<div class="settings-directory"><span>${icon('folder', 22)}</span><div><small>UBICACIÓN ACTUAL</small><strong title="${escapeHtml(appState.downloadDirectory)}">${escapeHtml(downloadDirectoryLabel())}</strong></div></div><div class="settings-inline-actions"><button type="button" class="choose-download-directory">${icon('folder', 16)} Cambiar carpeta</button><button type="button" class="open-download-directory">${icon('arrow', 16)} Abrir carpeta</button></div></section>${concurrency}${behaviorSettings}${bandwidth}</div>`;
}

function multimediaPage() {
  const session = appState.mediaSessionSettings?.useBraveCookies ? 'Cookies de Brave activadas' : 'Sin cookies del navegador';
  const ytdlp = appState.mediaRuntimeStatus?.yt_dlp;
  const ffmpeg = appState.mediaRuntimeStatus?.ffmpeg;
  return `<div class="settings-page settings-page-multimedia">${pageIntro('Multimedia', 'Motores y preferencias')}<section class="settings-section">${sectionHeading('Disponibilidad')}${statusRow('Sesión', session)} ${statusRow('yt-dlp', ytdlp ? 'Disponible' : 'No detectado', ytdlp ? 'ok' : 'warn')} ${statusRow('FFmpeg', ffmpeg ? 'Disponible' : 'No detectado', ffmpeg ? 'ok' : 'warn')} ${statusRow('Calidad preferida', escapeHtml(appState.selectedVideoQuality || 'Mejor disponible'))}</section><section class="settings-section settings-section-compact">${sectionHeading('Compatibilidad')}<div class="settings-callout">Las políticas multimedia y el reproductor se conservan sin cambios.</div></section></div>`;
}

function progressColorRow(id, label, value) {
  const field = { 'progress-active-color': 'progressActive', 'progress-completed-color': 'progressCompleted', 'progress-paused-color': 'progressPaused', 'progress-error-color': 'progressError' }[id];
  return `<label class="settings-progress-color-row"><span><i style="--progress-swatch:${escapeHtml(value)}"></i><b>${label}</b></span><input id="${id}" data-appearance-field="${field}" type="color" value="${escapeHtml(value)}" aria-label="${label}"><code>${escapeHtml(String(value || '').toUpperCase())}</code></label>`;
}

function iconColorSettings(appearance) {
  const mode = appearance.iconColorMode === 'custom' ? 'custom' : DEFAULT_ICON_COLOR_MODE;
  const disabled = mode === 'custom' ? '' : ' disabled';
  const presetColors = [{ id: 'default-gray', name: 'Gris predeterminado', color: DEFAULT_ICON_COLOR }, ...appearancePresets];
  const presetMarkup = presetColors.map((preset) => {
    const color = preset.color || preset.accent;
    const active = mode === 'custom' && String(appearance.iconColor || '').toLowerCase() === String(color || '').toLowerCase();
    return `<button type="button" class="settings-accent-swatch settings-icon-color-swatch${active ? ' is-active' : ''}" data-icon-color="${escapeHtml(color)}" style="--swatch-color:${escapeHtml(color)}" aria-label="${escapeHtml(preset.name)}" aria-pressed="${active}"><i></i>${active ? icon('check', 14) : ''}</button>`;
  }).join('');
  const iconColor = appearance.iconColor || DEFAULT_ICON_COLOR;
  return `<section class="settings-section settings-icon-color-section">${sectionHeading('Color de iconos')}<p class="settings-section-note">Controla la parte de color de los iconos; la base gris permanece limpia y legible.</p>${choice('iconColorMode', 'Modo', [['accent', 'Automático'], ['custom', 'Personalizado']], mode)}<div class="settings-icon-color-presets"><span class="settings-field-label">Colores preajustados</span><div class="settings-palette-options" role="radiogroup" aria-label="Colores preajustados para iconos">${presetMarkup}</div></div><label class="settings-custom-color settings-icon-color-picker${mode === 'custom' ? '' : ' is-disabled'}"><span>Color personalizado</span><input id="icon-color" data-appearance-field="iconColor" type="color" value="${escapeHtml(iconColor)}" aria-label="Color personalizado de iconos"${disabled}><code>${escapeHtml(String(iconColor).toUpperCase())}</code></label></section>`;
}

/* Advanced controls keep their expanded state for the current session only. */
function appearancePage() {
  const appearance = appState.appearance || {};
  const visual = window.__cdmVisualDiagnostics || visualDiagnosticsSnapshot();
  const loadedThumbs = Array.isArray(visual.thumbnails) ? visual.thumbnails.filter((item) => item.cacheState === 'loaded').length : 0;
  const thumbCount = Array.isArray(visual.thumbnails) ? visual.thumbnails.length : 0;
  const scale = displayedScalePercent(appearance.scale);
  return `<div class="settings-page settings-page-appearance">${pageIntro('Apariencia', 'Personaliza la interfaz')}<div class="settings-appearance-grid"><section class="settings-section settings-section-theme">${sectionHeading('Tema y color')}${choice('theme', 'Tema', [['system', 'Sistema'], ['dark', 'Oscuro'], ['light', 'Claro']], appearance.theme)}<div class="settings-palette"><span class="settings-field-label">Color de acento</span><div class="settings-palette-options" role="radiogroup" aria-label="Colores de acento">${appearancePresets.map((preset) => `<button type="button" class="settings-accent-swatch ${appearance.preset === preset.id ? 'is-active' : ''}" data-preset="${preset.id}" style="--swatch-color:${preset.accent}" aria-label="${escapeHtml(preset.name)}" aria-pressed="${appearance.preset === preset.id}"><i></i>${appearance.preset === preset.id ? icon('check', 14) : ''}</button>`).join('')}</div><label class="settings-custom-color"><span>Personalizado</span><input id="accent-color" type="color" data-appearance-field="accent" value="${escapeHtml(appearance.accent)}"><code>${escapeHtml(String(appearance.accent || '').toUpperCase())}</code></label></div><button type="button" class="settings-reset-colors">Restablecer colores</button></section>${iconColorSettings(appearance)}<section class="settings-section">${sectionHeading('Colores de progreso')}<div class="settings-section-note">Activo, completado, pausa y error conservan sus colores independientes.</div>${progressColorRow('progress-active-color', 'Activo', appearance.progressActive)}${progressColorRow('progress-completed-color', 'Completado', appearance.progressCompleted)}${progressColorRow('progress-paused-color', 'En pausa', appearance.progressPaused)}${progressColorRow('progress-error-color', 'Error', appearance.progressError)}</section><section class="settings-section">${sectionHeading('Escala y densidad')}<label class="settings-control settings-switch-control settings-auto-scale-row"><span><b>Escala automática</b></span><input id="auto-scale-toggle" type="checkbox" role="switch" data-appearance-field="autoScale" aria-label="Escala automática" ${checked(Boolean(appearance.autoScale), true)}></label><div class="settings-control settings-scale-control ${appearance.autoScale ? 'is-disabled' : ''}"><span><b>Escala de interfaz</b></span><div class="settings-stepper"><button id="scale-decrease" type="button" aria-label="Reducir escala" ${appearance.autoScale ? 'disabled' : ''}>−</button><input id="scale-number" type="number" min="50" max="130" step="5" value="${scale}" aria-label="Porcentaje de escala" ${appearance.autoScale ? 'disabled' : ''}><button id="scale-increase" type="button" aria-label="Aumentar escala" ${appearance.autoScale ? 'disabled' : ''}>+</button></div><input id="scale-range" type="range" min="50" max="130" step="5" value="${scale}" ${appearance.autoScale ? 'disabled' : ''}></div>${selectControl('density-select', 'density', 'Densidad', appearance.density, [['compact', 'Compacta'], ['balanced', 'Equilibrada'], ['spacious', 'Amplia']])}</section><section class="settings-section settings-advanced ${advancedOpen ? 'is-open' : ''}"><button type="button" class="settings-advanced-toggle" aria-expanded="${advancedOpen}"><span><b>Avanzado</b><small>Tamaño de texto, miniaturas y preferencias visuales</small></span><i>${icon('chevron', 16)}</i></button>${advancedOpen ? `<div class="settings-advanced-body"><div class="settings-advanced-group"><h4>Color</h4>${range('tone', 'Tonalidad', appearance.tone, 4, 18)}${range('intensity', 'Intensidad del acento', appearance.intensity, 40, 100)}${range('contrast', 'Contraste', appearance.contrast, 86, 116)}</div><div class="settings-advanced-group"><h4>Tipografía y contenido</h4>${range('text-scale', 'Tamaño del texto', appearance.textScale, 80, 120)}${selectControl('thumbnail-size-select', 'thumbnailSize', 'Miniaturas', appearance.thumbnailSize, [['medium', 'Medianas'], ['large', 'Grandes'], ['xlarge', 'Muy grandes']])}</div><div class="settings-advanced-group"><h4>Efectos</h4>${choice('surfaceMode', 'Superficie', [['solid', 'Sólida'], ['mica', 'Mica']], appearance.surfaceMode)}${choice('motionMode', 'Movimiento', [['system', 'Sistema'], ['reduced', 'Reducido'], ['off', 'Desactivado']], appearance.motionMode)}${choice('radius', 'Esquinas', [['sharp', 'Rectas'], ['standard', 'Estándar'], ['soft', 'Suaves']], appearance.radius)}</div><div class="settings-diagnostics-mini">${statusRow('Ventana / DPR', `${visual.viewport?.width || 0} × ${visual.viewport?.height || 0} · ${visual.devicePixelRatio || 1}x`)} ${statusRow('Miniaturas', `${loadedThumbs}/${thumbCount} cargadas · caché v${visual.thumbnailCacheVersion || THUMBNAIL_CACHE_VERSION}`)}</div><div class="settings-diagnostics-actions"><button type="button" class="copy-visual-diagnostics">Copiar diagnóstico</button><button type="button" class="settings-reset">Restablecer apariencia</button></div></div>` : ''}</section></div></div>`;
}


function integrationsPage() {
  const extension = appState.extensionBridgeStatus;
  return `<div class="settings-page settings-page-integrations">${pageIntro('Integraciones', 'Conexiones disponibles')}<section class="settings-section">${sectionHeading('Extensión del navegador')}${statusRow('Puente', extension?.prepared ? 'Preparado' : 'No detectado', extension?.prepared ? 'ok' : 'warn')} ${statusRow('Protocolo', extension?.protocolVersion ? `v${extension.protocolVersion}` : '—')}</section><section class="settings-section settings-section-compact">${sectionHeading(tr('officialSite'))}<div class="settings-official-site"><p>${tr('officialSiteDescription')}</p><button type="button" class="settings-tool-repo" data-settings-official-site>${icon('link', 15)}<span>${tr('visitOfficialSite')}</span></button></div></section></div>`;
}

function componentManagerSection() {
  const components = Array.isArray(appState.components) ? appState.components : [];
  const labels = {
    'media-tools': 'MediaTools',
    'torrent-engine': 'Torrent Engine'
  };
  const stateLabels = {
    missing: tr('No instalado'),
    installed: tr('Instalado'),
    corrupted: tr('Requiere reparación'),
    'update-available': tr('Actualización disponible'),
    downloading: tr('Descargando'),
    verifying: tr('Verificando'),
    installing: tr('Instalando'),
    error: tr('Falló la instalación')
  };
  const phaseLabels = {
    preparing: 'Preparando descarga',
    download: 'Descargando',
    verify: 'Verificando integridad',
    install: 'Preparando instalación',
    activate: 'Activando componente',
    done: 'Instalado',
    error: 'No se pudo completar',
    cancelled: 'Descarga cancelada'
  };
  const formatBytes = (value) => {
    if (!Number.isSafeInteger(value) || value < 0) return '';
    const units = ['B', 'KB', 'MB', 'GB'];
    let amount = value;
    let unit = 0;
    while (amount >= 1000 && unit < units.length - 1) { amount /= 1000; unit += 1; }
    return `${amount.toFixed(unit ? 1 : 0)} ${units[unit]}`;
  };
  const rows = ['media-tools', 'torrent-engine'].map((id) => {
    const component = components.find((item) => item.id === id) || { id, state: 'missing' };
    const operation = appState.componentOperations?.[id];
    const phase = String(operation?.phase || '');
    const state = String(component.state || 'missing').toLowerCase();
    const tone = state === 'installed' ? 'ok' : state === 'installing' ? 'info' : state === 'missing' ? 'warn' : 'error';
    const version = component.version ? ` · v${escapeHtml(component.version)}` : '';
    const activeOperation = ['preparing', 'download', 'verify', 'install', 'activate'].includes(phase);
    const installAction = activeOperation || ['installed', 'downloading', 'verifying', 'installing'].includes(state) ? '' : `<button type="button" class="settings-component-action" data-component-action="install" data-component-id="${id}">${state === 'corrupted' ? tr('Reparar') : state === 'update-available' ? tr('Actualizar') : tr('Descargar e instalar')}</button>`;
    const verifyAction = ['installed', 'corrupted'].includes(state) ? `<button type="button" class="settings-component-action" data-component-action="verify" data-component-id="${id}">${tr('Verificar')}</button>` : '';
    const reclaimable = Number.isSafeInteger(component.reclaimableBytes) && component.reclaimableBytes >= 0
      ? ` · Libera ${formatBytes(component.reclaimableBytes)}` : '';
    const removeAction = ['installed', 'corrupted'].includes(state)
      ? `<button type="button" class="settings-component-action" data-component-action="remove" data-component-id="${id}"${activeOperation ? ' disabled' : ''}>${tr('Quitar')}${reclaimable}</button>` : '';
    const ratio = Number.isFinite(operation?.progressRatio) && operation.progressRatio >= 0 && operation.progressRatio <= 1
      ? Math.round(operation.progressRatio * 100) : null;
    const downloaded = formatBytes(operation?.bytesDownloaded);
    const total = formatBytes(operation?.totalBytes);
    const speed = Number.isFinite(operation?.bytesPerSecond) && operation.bytesPerSecond > 0
      ? ` · ${formatBytes(Math.round(operation.bytesPerSecond))}/s` : '';
    const phaseText = phaseLabels[phase] || stateLabels[state] || 'Status unavailable';
    const metrics = phase === 'download' && downloaded
      ? `<small class="settings-component-metrics">${downloaded}${total ? ` / ${total}` : ''}${ratio === null ? '' : ` · ${ratio}%`}${speed}</small>` : '';
    const progressMarkup = activeOperation
      ? `<progress class="settings-component-progress" max="100"${ratio === null ? '' : ` value="${ratio}"`} aria-label="${labels[id]} · ${phaseText}"></progress>${metrics}`
      : phase === 'error' ? `<small class="settings-component-error">${escapeHtml(operation.error || 'Error de instalación')}</small>` : '';
    const cancelAction = phase === 'download'
      ? `<button type="button" class="settings-component-action" data-component-action="cancel" data-component-id="${id}">${tr('Cancelar')}</button>` : '';
    const available = component.availableVersion && component.availableVersion !== component.version
      ? ` · ${tr('Disponible')} v${escapeHtml(component.availableVersion)}`
      : '';
    return `<article class="settings-component-row" data-component-row="${id}" tabindex="-1"><div><strong>${labels[id]}</strong><span data-status-tone="${tone}">${phaseText}${version}${available}</span>${progressMarkup}</div><div class="settings-inline-actions">${cancelAction}${installAction}${verifyAction}${removeAction}</div></article>`;
  }).join('');
  return `<section class="settings-section settings-section-components"><button type="button" class="settings-component-action" data-component-catalog-check>${tr('Buscar actualizaciones')}</button>${rows}</section>`;
}

function componentsPage() {
  return `<div class="settings-page settings-page-components">${pageIntro(tr('Complementos'), tr('Gestiona los componentes opcionales de Clear.'))}${componentManagerSection()}</div>`;
}

function updatesPage() {
  const visual = window.__cdmVisualDiagnostics || visualDiagnosticsSnapshot();
  const runtime = appState.runtimeStatus || {};
  const media = appState.mediaRuntimeStatus || {};
  const compactVersion = (version) => {
    const raw = String(version || '').split(/\r?\n/, 1)[0];
    const match = raw.match(/\b\d{4}\.\d{2}\.\d{2}\b|\b\d+\.\d+(?:\.\d+)?(?:[-+][a-z0-9.]+)?/i);
    return match?.[0] || '';
  };
  const installed = (available) => available
    ? { label: tr('Instalado'), tone: 'ok' }
    : { label: tr('No detectado'), tone: 'warn' };
  const applicationStatus = () => {
    if (appState.updaterCheckBusy) return { label: tr('Comprobando…'), tone: 'info' };
    if (appState.availableUpdate?.version) return { label: `${tr('Actualización disponible')} · ${escapeHtml(appState.availableUpdate.version)}`, tone: 'info' };
    if (appState.updaterStatus?.storeManaged) return { label: tr('Microsoft Store'), tone: 'neutral' };
    if (/versión más reciente|usando la versión más reciente/i.test(String(appState.updaterMessage || ''))) return { label: tr('Actualizado'), tone: 'ok' };
    if (!appState.updaterStatus?.configured || /no se pudo comprobar|todavía no está configurado/i.test(String(appState.updaterMessage || ''))) return { label: tr('No disponible'), tone: 'neutral' };
    return { label: tr('Aún no comprobado'), tone: 'neutral' };
  };
  const appVersion = compactVersion(runtime.version || appState.updaterStatus?.currentVersion || APP_VERSION) || APP_VERSION;
  const runtimeRows = [
    { name: 'Clear Download Manager', version: appVersion, ...applicationStatus() },
    { name: 'yt-dlp', version: compactVersion(media.yt_dlp_version) || '—', ...installed(media.yt_dlp) },
    { name: 'FFmpeg', version: compactVersion(media.ffmpeg_version) || '—', ...installed(media.ffmpeg) },
    { name: 'FFprobe', version: compactVersion(media.ffprobe_version) || '—', ...installed(media.ffprobe) },
    { name: 'aria2c', version: compactVersion(runtime.aria2_version) || '—', ...installed(runtime.aria2_available) }
  ];
  const runtimeTable = `<div class="settings-runtime-table-wrap"><table class="settings-runtime-table"><thead><tr><th scope="col">${tr('Nombre')}</th><th scope="col">${tr('Versión')}</th><th scope="col">${tr('Estado')}</th></tr></thead><tbody>${runtimeRows.map((row) => `<tr><th scope="row">${row.name}</th><td>${escapeHtml(row.version)}</td><td><span class="settings-runtime-status" data-status-tone="${row.tone}">${row.label}</span></td></tr>`).join('')}</tbody></table></div>`;
  const repositoryButton = (toolId, label) => `<button type="button" class="settings-tool-repo" data-settings-tool-repo="${toolId}" title="${tr('Abrir repositorio')}">${icon('link', 15)}<span>${label}</span></button>`;
  const repositories = `<div class="settings-tool-repos"><h4>${tr('Repositorios oficiales')}</h4><div>${repositoryButton('yt-dlp', 'yt-dlp')}${repositoryButton('ffmpeg', 'FFmpeg / FFprobe')}${repositoryButton('deno', 'Deno')}${repositoryButton('aria2', 'aria2c')}</div></div>`;
  const licenseRows = `<ul class="settings-open-source-list"><li><strong>yt-dlp</strong><span>${tr('licenseYtdlp')}</span></li><li><strong>Deno</strong><span>${tr('licenseDeno')}</span></li><li><strong>FFmpeg / FFprobe</strong><span>${tr('licenseFfmpeg')}</span></li><li><strong>aria2c</strong><span>${tr('licenseAria2')}</span></li></ul>`;
  const openSourceLicenses = `<details class="settings-open-source"><summary>${tr('openSourceLicenses')}</summary><p>${tr('licensesSummary')}</p>${licenseRows}<small>${tr('licenseBundleInfo')}</small></details>`;
  const diagnostics = `<button type="button" class="copy-visual-diagnostics">${tr('Copiar diagnóstico')}</button>`;
  return `<div class="settings-page settings-page-updates">${pageIntro(tr('Actualizaciones y diagnóstico'), tr('Consulta versiones, estado de herramientas y diagnóstico visual.'))}<section class="settings-section settings-section-runtime">${sectionHeading(tr('Aplicación y herramientas'))}${runtimeTable}</section><section class="settings-section settings-section-tools">${repositories}${openSourceLicenses}</section><section class="settings-section settings-section-visual">${sectionHeading(tr('Diagnóstico visual'))}${diagnostics}</section></div>`;
}

export function settingsMarkup() {
  const categories = ['general', 'downloads', 'multimedia', 'appearance', 'integrations', 'updates', 'components'];
  const activeCategory = categories.includes(appState.settingsCategory) ? appState.settingsCategory : 'general';
  const page = activeCategory === 'downloads' ? downloadsPage() : activeCategory === 'multimedia' ? multimediaPage() : activeCategory === 'appearance' ? appearancePage() : activeCategory === 'integrations' ? integrationsPage() : activeCategory === 'updates' ? updatesPage() : activeCategory === 'components' ? componentsPage() : generalPage();
  return `<section class="settings-view settings-workspace"><div class="settings-workspace-frame"><div class="settings-workspace-layout">${nav(activeCategory)}<main class="settings-workspace-content">${page}</main></div></div></section>`;
}
