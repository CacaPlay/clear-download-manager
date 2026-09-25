import { DEFAULT_ICON_COLOR, DEFAULT_ICON_COLOR_MODE } from '../appearance/tokens.js';

let settingsContext = {};
let appState = {};
let advancedOpen = false;
let APP_VERSION = '0.95.4';
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

export function setSettingsAdvancedOpen(value) {
  advancedOpen = Boolean(value);
}

const checked = (value, expected) => value === expected ? 'checked' : '';
const selected = (value, expected) => value === expected ? 'selected' : '';

function pageIntro(title, description = '') {
  return `<header class="settings-page-intro"><div><h2>${title}</h2>${description ? `<p>${description}</p>` : ''}</div></header>`;
}

function sectionHeading(iconName, title) {
  return `<div class="settings-section-heading">${icon(iconName, 19)}<h3>${title}</h3></div>`;
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

function experienceToggle(id, key, label, description, value) {
  return `<label class="settings-control settings-switch-control settings-experience-toggle"><span><b>${label}</b><small>${description}</small></span><input id="${id}" type="checkbox" data-experience-field="${key}" ${value !== false ? 'checked' : ''}></label>`;
}

function nav(activeCategory) {
  const entries = [['general', 'General', 'app'], ['downloads', 'Descargas', 'download'], ['multimedia', 'Multimedia', 'video'], ['appearance', 'Apariencia', 'palette'], ['integrations', 'Integraciones', 'audio'], ['updates', 'Actualizaciones y diagnóstico', 'shield']];
  return `<nav class="settings-workspace-nav" aria-label="Categorías de ajustes"><div class="settings-nav-items">${entries.map(([id, label, iconName]) => `<button type="button" class="settings-category-button ${activeCategory === id ? 'is-active' : ''}" data-settings-category="${id}" aria-current="${activeCategory === id ? 'page' : 'false'}" aria-label="${label}" title="${label}">${icon(iconName, 23)}</button>`).join('')}</div></nav>`;
}

function generalPage() {
  const closeAction = appState.windowBehavior?.closeAction === 'exit' ? 'exit' : 'tray';
  const startupDisabled = appState.startupStatus?.supported === false;
  const experience = appState.experienceSettings || {};
  const selectedLocale = ['system', 'es', 'en'].includes(String(experience.locale || locale())) ? String(experience.locale || locale()) : 'system';
  return `<div class="settings-page settings-page-general">${pageIntro(tr('general'), tr('windowStartup'))}<section class="settings-section">${sectionHeading('app', tr('windowBehavior'))}${selectControl('close-action-select', 'closeAction', tr('closeAction'), closeAction, [['tray', tr('closeToTray')], ['exit', tr('exitCompletely')]])}<label class="settings-control settings-switch-control"><span><b>${tr('startWithWindows')}</b></span><input id="startup-toggle" type="checkbox" ${checked(Boolean(appState.startupStatus?.enabled), true)} ${startupDisabled ? 'disabled' : ''}></label></section><section class="settings-section">${sectionHeading('globe', tr('language'))}<label class="settings-control"><span><b>${tr('language')}</b><small>${tr('system')} ${tr('system') === 'System' ? 'uses your browser/system language.' : 'usa el idioma del sistema/navegador.'}</small></span><select data-experience-field="locale" aria-label="${tr('language')}"><option value="system" ${selected(selectedLocale, 'system')}>${tr('system')}</option><option value="es" ${selected(selectedLocale, 'es')}>${tr('spanish')}</option><option value="en" ${selected(selectedLocale, 'en')}>${tr('english')}</option></select></label></section><section class="settings-section settings-section-experience">${sectionHeading('bell', tr('automation'))}${experienceToggle('clipboard-suggest-toggle', 'clipboardAutoSuggest', tr('detectClipboard'), tr('clipboardDescription'), experience.clipboardAutoSuggest)}${experienceToggle('auto-updates-toggle', 'automaticUpdateChecks', tr('automaticUpdates'), tr('automaticUpdatesDescription'), experience.automaticUpdateChecks)}</section><section class="settings-section settings-section-compact">${sectionHeading('shield', tr('status'))}${statusRow(tr('minimize'), tr('taskbar'))} ${statusRow(tr('closeAction'), closeAction === 'exit' ? tr('exit') : tr('tray'))}</section></div>`;
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
  const bandwidth = `<section class="settings-section settings-bandwidth-section">${sectionHeading('trend', 'Velocidad')}<label class="settings-control"><span><b>Limitar velocidad de descarga</b><small>Máximo por descarga</small></span><select id="bandwidth-limit-select" aria-label="Límite máximo por descarga">${limitOptions.map(([value, label]) => `<option value="${value}" ${selected(selectedValue, value)}>${label}</option>`).join('')}</select></label>${customVisible ? `<div class="settings-bandwidth-custom"><label><span>Velocidad personalizada</span><input id="bandwidth-custom-value" type="number" min="1" step="1" inputmode="numeric" value="${escapeHtml(custom)}"></label><label><span>Unidad</span><select id="bandwidth-custom-unit"><option value="KB" ${selected(unit, 'KB')}>KB/s</option><option value="MB" ${selected(unit, 'MB')}>MB/s</option></select></label><button type="button" class="save-bandwidth-custom">Guardar</button></div>` : ''}<p class="settings-section-note settings-bandwidth-note">Se aplicará a descargas nuevas y reanudadas. MB/s significa megabytes por segundo.</p></section>`;
  const concurrency = `<section class="settings-section settings-concurrency-section">${sectionHeading('queue', 'Descargas simultáneas')}<label class="settings-control"><span><b>HTTP</b></span><input id="http-concurrency-input" type="number" min="1" max="8" step="1" inputmode="numeric" value="${escapeHtml(httpConcurrency)}" aria-label="Descargas HTTP simultáneas"></label><label class="settings-control"><span><b>Multimedia</b></span><input id="multimedia-concurrency-input" type="number" min="1" max="4" step="1" inputmode="numeric" value="${escapeHtml(multimediaConcurrency)}" aria-label="Descargas multimedia simultáneas"></label><p class="settings-section-note">Las tareas activas continúan; el límite se aplica al próximo espacio disponible.</p></section>`;
  return `<div class="settings-page settings-page-downloads">${pageIntro('Descargas', 'Destino y organización')}<section class="settings-section">${sectionHeading('folder', 'Carpeta de descargas')}<div class="settings-directory"><span>${icon('folder', 22)}</span><div><small>UBICACIÓN ACTUAL</small><strong title="${escapeHtml(appState.downloadDirectory)}">${escapeHtml(downloadDirectoryLabel())}</strong></div></div><div class="settings-inline-actions"><button type="button" class="choose-download-directory">${icon('folder', 16)} Cambiar carpeta</button><button type="button" class="open-download-directory">${icon('arrow', 16)} Abrir carpeta</button></div></section>${concurrency}${bandwidth}<section class="settings-section settings-section-compact">${sectionHeading('settings', 'Comportamiento')}${statusRow('Reanudación', 'Disponible')} ${statusRow('Parciales', 'Conservados')} ${statusRow('Progreso', 'En tiempo real')}</section></div>`;
}

function multimediaPage() {
  const session = appState.mediaSessionSettings?.useBraveCookies ? 'Cookies de Brave activadas' : 'Sin cookies del navegador';
  const ytdlp = appState.mediaRuntimeStatus?.yt_dlp;
  const ffmpeg = appState.mediaRuntimeStatus?.ffmpeg;
  return `<div class="settings-page settings-page-multimedia">${pageIntro('Multimedia', 'Motores y preferencias')}<section class="settings-section">${sectionHeading('video', 'Disponibilidad')}${statusRow('Sesión', session)} ${statusRow('yt-dlp', ytdlp ? 'Disponible' : 'No detectado', ytdlp ? 'ok' : 'warn')} ${statusRow('FFmpeg', ffmpeg ? 'Disponible' : 'No detectado', ffmpeg ? 'ok' : 'warn')} ${statusRow('Calidad preferida', escapeHtml(appState.selectedVideoQuality || 'Mejor disponible'))}</section><section class="settings-section settings-section-compact">${sectionHeading('shield', 'Compatibilidad')}<div class="settings-callout">${icon('shield', 17)} Las políticas multimedia y el reproductor se conservan sin cambios.</div></section></div>`;
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
  return `<section class="settings-section settings-icon-color-section">${sectionHeading('palette', 'Color de iconos')}<p class="settings-section-note">Controla la parte de color de los iconos; la base gris permanece limpia y legible.</p>${choice('iconColorMode', 'Modo', [['accent', 'Automático'], ['custom', 'Personalizado']], mode)}<div class="settings-icon-color-presets"><span class="settings-field-label">Colores preajustados</span><div class="settings-palette-options" role="radiogroup" aria-label="Colores preajustados para iconos">${presetMarkup}</div></div><label class="settings-custom-color settings-icon-color-picker${mode === 'custom' ? '' : ' is-disabled'}"><span>Color personalizado</span><input id="icon-color" data-appearance-field="iconColor" type="color" value="${escapeHtml(iconColor)}" aria-label="Color personalizado de iconos"${disabled}><code>${escapeHtml(String(iconColor).toUpperCase())}</code></label></section>`;
}

function appearancePageLegacy() {
  const appearance = appState.appearance || {};
  const visual = window.__cacatoolsVisualDiagnostics || visualDiagnosticsSnapshot();
  const loadedThumbs = Array.isArray(visual.thumbnails) ? visual.thumbnails.filter((item) => item.cacheState === 'loaded').length : 0;
  const thumbCount = Array.isArray(visual.thumbnails) ? visual.thumbnails.length : 0;
  const scale = displayedScalePercent(appearance.scale);
  const effectiveScale = appearance.autoScale ? automaticScalePercent() : scale;
  return `<div class="settings-page settings-page-appearance">${pageIntro('Apariencia', 'Personaliza la interfaz')}<div class="settings-appearance-grid"><section class="settings-section settings-section-theme">${sectionHeading('palette', 'Tema y color')}${choice('theme', 'Tema', [['system', 'Sistema'], ['dark', 'Oscuro'], ['light', 'Claro']], appearance.theme)}<div class="settings-palette"><span class="settings-field-label">Color de acento</span><div class="settings-palette-options" role="radiogroup" aria-label="Colores de acento">${appearancePresets.map((preset) => `<button type="button" class="settings-accent-swatch ${appearance.preset === preset.id ? 'is-active' : ''}" data-preset="${preset.id}" style="--swatch-color:${preset.accent}" aria-label="${escapeHtml(preset.name)}" aria-pressed="${appearance.preset === preset.id}"><i></i>${appearance.preset === preset.id ? icon('check', 14) : ''}</button>`).join('')}</div><label class="settings-custom-color"><span>Personalizado</span><input id="accent-color" type="color" data-appearance-field="accent" value="${escapeHtml(appearance.accent)}"><code>${escapeHtml(String(appearance.accent || '').toUpperCase())}</code></label></div><button type="button" class="settings-reset-colors">${icon('palette', 16)} Restablecer colores</button></section>${iconColorSettings(appearance)}<section class="settings-section">${sectionHeading('trend', 'Colores de progreso')}<div class="settings-section-note">Activo, completado, pausa y error conservan sus colores independientes.</div>${progressColorRow('progress-active-color', 'Activo', appearance.progressActive)}${progressColorRow('progress-completed-color', 'Completado', appearance.progressCompleted)}${progressColorRow('progress-paused-color', 'En pausa', appearance.progressPaused)}${progressColorRow('progress-error-color', 'Error', appearance.progressError)}</section><section class="settings-section">${sectionHeading('tools', 'Escala y densidad')}<label class="settings-control settings-auto-scale-row"><span><b>Escala automática</b></span><output data-setting-value="auto-scale">${effectiveScale}%</output><input id="auto-scale-toggle" type="checkbox" ${checked(Boolean(appearance.autoScale), true)}></label><div class="settings-control settings-scale-control ${appearance.autoScale ? 'is-disabled' : ''}"><span><b>Escala de interfaz</b></span><div class="settings-stepper"><button id="scale-decrease" type="button" aria-label="Reducir escala" ${appearance.autoScale ? 'disabled' : ''}>−</button><input id="scale-number" type="number" min="50" max="130" step="5" value="${scale}" aria-label="Porcentaje de escala" ${appearance.autoScale ? 'disabled' : ''}><button id="scale-increase" type="button" aria-label="Aumentar escala" ${appearance.autoScale ? 'disabled' : ''}>+</button></div><input id="scale-range" type="range" min="50" max="130" step="5" value="${scale}" ${appearance.autoScale ? 'disabled' : ''}></div>${selectControl('density-select', 'density', 'Densidad', appearance.density, [['compact', 'Compacta'], ['balanced', 'Equilibrada'], ['spacious', 'Amplia']])}</section><section class="settings-section settings-advanced ${advancedOpen ? 'is-open' : ''}"><button type="button" class="settings-advanced-toggle" aria-expanded="${advancedOpen}"><span>${icon('settings', 19)}<b>Avanzado</b><small>Tamaño de texto, miniaturas y preferencias visuales</small></span><i>${icon('chevron', 16)}</i></button>${advancedOpen ? `<div class="settings-advanced-body"><div class="settings-advanced-group"><h4>Color</h4>${range('tone', 'Tonalidad', appearance.tone, 4, 18)}${range('intensity', 'Intensidad del acento', appearance.intensity, 40, 100)}${range('contrast', 'Contraste', appearance.contrast, 86, 116)}</div><div class="settings-advanced-group"><h4>Tipografía y contenido</h4>${range('text-scale', 'Tamaño del texto', appearance.textScale, 80, 120)}${selectControl('thumbnail-size-select', 'thumbnailSize', 'Miniaturas', appearance.thumbnailSize, [['medium', 'Medianas'], ['large', 'Grandes'], ['xlarge', 'Muy grandes']])}</div><div class="settings-advanced-group"><h4>Efectos</h4>${choice('surfaceMode', 'Superficie', [['solid', 'Sólida'], ['mica', 'Mica']], appearance.surfaceMode)}${choice('motionMode', 'Movimiento', [['system', 'Sistema'], ['reduced', 'Reducido'], ['off', 'Desactivado']], appearance.motionMode)}${choice('radius', 'Esquinas', [['sharp', 'Rectas'], ['standard', 'Estándar'], ['soft', 'Suaves']], appearance.radius)}</div><div class="settings-diagnostics-mini">${statusRow('Ventana / DPR', `${visual.viewport?.width || 0} × ${visual.viewport?.height || 0} · ${visual.devicePixelRatio || 1}x`)} ${statusRow('Miniaturas', `${loadedThumbs}/${thumbCount} cargadas · caché v${visual.thumbnailCacheVersion || THUMBNAIL_CACHE_VERSION}`)}</div><button type="button" class="copy-visual-diagnostics">${icon('clipboard', 16)} Copiar diagnóstico</button><button type="button" class="settings-reset">Restablecer apariencia</button></div>` : ''}</section></div></div>`;
}

/* Phase 1 completion owner: selector-based Auto Scale and stable diagnostic
   actions. Kept as a dedicated renderer so the session-only Advanced state is
   preserved without introducing persistence fields. */
function appearancePageV4() {
  const appearance = appState.appearance || {};
  const visual = window.__cacatoolsVisualDiagnostics || visualDiagnosticsSnapshot();
  const loadedThumbs = Array.isArray(visual.thumbnails) ? visual.thumbnails.filter((item) => item.cacheState === 'loaded').length : 0;
  const thumbCount = Array.isArray(visual.thumbnails) ? visual.thumbnails.length : 0;
  const scale = displayedScalePercent(appearance.scale);
  return `<div class="settings-page settings-page-appearance">${pageIntro('Apariencia', 'Personaliza la interfaz')}<div class="settings-appearance-grid"><section class="settings-section settings-section-theme">${sectionHeading('palette', 'Tema y color')}${choice('theme', 'Tema', [['system', 'Sistema'], ['dark', 'Oscuro'], ['light', 'Claro']], appearance.theme)}<div class="settings-palette"><span class="settings-field-label">Color de acento</span><div class="settings-palette-options" role="radiogroup" aria-label="Colores de acento">${appearancePresets.map((preset) => `<button type="button" class="settings-accent-swatch ${appearance.preset === preset.id ? 'is-active' : ''}" data-preset="${preset.id}" style="--swatch-color:${preset.accent}" aria-label="${escapeHtml(preset.name)}" aria-pressed="${appearance.preset === preset.id}"><i></i>${appearance.preset === preset.id ? icon('check', 14) : ''}</button>`).join('')}</div><label class="settings-custom-color"><span>Personalizado</span><input id="accent-color" type="color" data-appearance-field="accent" value="${escapeHtml(appearance.accent)}"><code>${escapeHtml(String(appearance.accent || '').toUpperCase())}</code></label></div><button type="button" class="settings-reset-colors">${icon('palette', 16)} Restablecer colores</button></section>${iconColorSettings(appearance)}<section class="settings-section">${sectionHeading('trend', 'Colores de progreso')}<div class="settings-section-note">Activo, completado, pausa y error conservan sus colores independientes.</div>${progressColorRow('progress-active-color', 'Activo', appearance.progressActive)}${progressColorRow('progress-completed-color', 'Completado', appearance.progressCompleted)}${progressColorRow('progress-paused-color', 'En pausa', appearance.progressPaused)}${progressColorRow('progress-error-color', 'Error', appearance.progressError)}</section><section class="settings-section">${sectionHeading('tools', 'Escala y densidad')}<label class="settings-control settings-auto-scale-row"><span><b>Escala automática</b></span><select id="auto-scale-select" data-appearance-field="autoScale" aria-label="Escala automática"><option value="true" ${selected(Boolean(appearance.autoScale), true)}>Activada</option><option value="false" ${selected(Boolean(appearance.autoScale), false)}>Desactivada</option></select></label><div class="settings-control settings-scale-control ${appearance.autoScale ? 'is-disabled' : ''}"><span><b>Escala de interfaz</b></span><div class="settings-stepper"><button id="scale-decrease" type="button" aria-label="Reducir escala" ${appearance.autoScale ? 'disabled' : ''}>−</button><input id="scale-number" type="number" min="50" max="130" step="5" value="${scale}" aria-label="Porcentaje de escala" ${appearance.autoScale ? 'disabled' : ''}><button id="scale-increase" type="button" aria-label="Aumentar escala" ${appearance.autoScale ? 'disabled' : ''}>+</button></div><input id="scale-range" type="range" min="50" max="130" step="5" value="${scale}" ${appearance.autoScale ? 'disabled' : ''}></div>${selectControl('density-select', 'density', 'Densidad', appearance.density, [['compact', 'Compacta'], ['balanced', 'Equilibrada'], ['spacious', 'Amplia']])}</section><section class="settings-section settings-advanced ${advancedOpen ? 'is-open' : ''}"><button type="button" class="settings-advanced-toggle" aria-expanded="${advancedOpen}"><span>${icon('settings', 19)}<b>Avanzado</b><small>Tamaño de texto, miniaturas y preferencias visuales</small></span><i>${icon('chevron', 16)}</i></button>${advancedOpen ? `<div class="settings-advanced-body"><div class="settings-advanced-group"><h4>Color</h4>${range('tone', 'Tonalidad', appearance.tone, 4, 18)}${range('intensity', 'Intensidad del acento', appearance.intensity, 40, 100)}${range('contrast', 'Contraste', appearance.contrast, 86, 116)}</div><div class="settings-advanced-group"><h4>Tipografía y contenido</h4>${range('text-scale', 'Tamaño del texto', appearance.textScale, 80, 120)}${selectControl('thumbnail-size-select', 'thumbnailSize', 'Miniaturas', appearance.thumbnailSize, [['medium', 'Medianas'], ['large', 'Grandes'], ['xlarge', 'Muy grandes']])}</div><div class="settings-advanced-group"><h4>Efectos</h4>${choice('surfaceMode', 'Superficie', [['solid', 'Sólida'], ['mica', 'Mica']], appearance.surfaceMode)}${choice('motionMode', 'Movimiento', [['system', 'Sistema'], ['reduced', 'Reducido'], ['off', 'Desactivado']], appearance.motionMode)}${choice('radius', 'Esquinas', [['sharp', 'Rectas'], ['standard', 'Estándar'], ['soft', 'Suaves']], appearance.radius)}</div><div class="settings-diagnostics-mini">${statusRow('Ventana / DPR', `${visual.viewport?.width || 0} × ${visual.viewport?.height || 0} · ${visual.devicePixelRatio || 1}x`)} ${statusRow('Miniaturas', `${loadedThumbs}/${thumbCount} cargadas · caché v${visual.thumbnailCacheVersion || THUMBNAIL_CACHE_VERSION}`)}</div><div class="settings-diagnostics-actions"><button type="button" class="copy-visual-diagnostics">${icon('clipboard', 16)} Copiar diagnóstico</button><button type="button" class="settings-reset">Restablecer apariencia</button></div></div>` : ''}</section></div></div>`;
}

function appearancePage() {
  return appearancePageV4();
}

function integrationsPage() {
  const extension = appState.extensionBridgeStatus;
  return `<div class="settings-page settings-page-integrations">${pageIntro('Integraciones', 'Conexiones disponibles')}<section class="settings-section">${sectionHeading('link', 'Extensión del navegador')}${statusRow('Puente', extension?.prepared ? 'Preparado' : 'No detectado', extension?.prepared ? 'ok' : 'warn')} ${statusRow('Protocolo', extension?.protocolVersion ? `v${extension.protocolVersion}` : '—')}</section><section class="settings-section settings-section-compact">${sectionHeading('globe', tr('officialSite'))}<div class="settings-official-site"><p>${tr('officialSiteDescription')}</p><button type="button" class="settings-tool-repo" data-settings-official-site>${icon('link', 15)}<span>${tr('visitOfficialSite')}</span></button></div></section></div>`;
}

function updatesPage() {
  const visual = window.__cacatoolsVisualDiagnostics || visualDiagnosticsSnapshot();
  const tool = appState.toolUpdateStatus || {};
  const runtime = appState.runtimeStatus || {};
  const media = appState.mediaRuntimeStatus || {};
  const labels = { CURRENT: 'Actualizado', AVAILABLE: 'Actualización disponible', CHECKING: 'Comprobando…', DOWNLOADING: 'Descargando…', VERIFYING: 'Verificando…', INSTALLING: 'Instalando…', UPDATED: 'Actualizado', FAILED: 'No se pudo completar', OFFLINE: 'Sin conexión', UNAVAILABLE: 'Comprobación no disponible' };
  const state = labels[tool.state] || 'Estado no disponible';
  const tone = ['CURRENT', 'AVAILABLE', 'UPDATED'].includes(tool.state) ? 'ok' : ['CHECKING', 'DOWNLOADING', 'VERIFYING', 'INSTALLING', 'UNAVAILABLE'].includes(tool.state) ? 'info' : 'warn';
  const checking = Boolean(appState.toolUpdateChecking);
  const updating = Boolean(appState.toolUpdateApplying);
  const canUpdate = Boolean(tool.canUpdate) && !checking && !updating;
  const checkedAt = Number(tool.lastChecked || 0);
  const checkedLabel = checkedAt > 0 ? new Date(checkedAt * 1000).toLocaleString() : 'Aún no comprobado';
  const compactVersion = (version) => {
    const raw = String(version || '').split(/\r?\n/, 1)[0];
    const match = raw.match(/\b\d{4}\.\d{2}\.\d{2}\b|\b\d+\.\d+(?:\.\d+)?(?:[-+][a-z0-9.]+)?/i);
    return match?.[0] || '';
  };
  const installed = (available, version) => available
    ? `${compactVersion(version) ? `Instalada · ${escapeHtml(compactVersion(version))}` : 'Instalada'}`
    : 'No detectado';
  const repositoryButton = (toolId, label) => `<button type="button" class="settings-tool-repo" data-settings-tool-repo="${toolId}" title="Abrir repositorio">${icon('link', 15)}<span>${label}</span></button>`;
  const repositories = `<div class="settings-tool-repos"><h4>Repositorios oficiales</h4><div>${repositoryButton('yt-dlp', 'yt-dlp')}${repositoryButton('ffmpeg', 'FFmpeg / FFprobe')}${repositoryButton('deno', 'Deno')}${repositoryButton('aria2', 'aria2c')}</div></div>`;
  const licenseRows = `<ul class="settings-open-source-list"><li><strong>yt-dlp</strong><span>${tr('licenseYtdlp')}</span></li><li><strong>Deno</strong><span>${tr('licenseDeno')}</span></li><li><strong>FFmpeg / FFprobe</strong><span>${tr('licenseFfmpeg')}</span></li><li><strong>aria2c</strong><span>${tr('licenseAria2')}</span></li></ul>`;
  const openSourceLicenses = `<details class="settings-open-source"><summary>${icon('shield', 16)}${tr('openSourceLicenses')}</summary><p>${tr('licensesSummary')}</p>${licenseRows}<small>${tr('licenseBundleInfo')}</small></details>`;
  const availableVersion = `${tool.availableVersion ? statusRow('Versión disponible', escapeHtml(tool.availableVersion), 'ok') : ''}${statusRow('FFmpeg / FFprobe / Deno / aria2c', 'Con la aplicación firmada', 'info')}`;
  return `<div class="settings-page settings-page-updates">${pageIntro('Actualizaciones y diagnóstico', 'Estado local')}<section class="settings-section">${sectionHeading('shield', 'Versiones')}${statusRow('Aplicación', escapeHtml(runtime.version || APP_VERSION), 'neutral')} ${statusRow('yt-dlp', installed(media.yt_dlp, media.yt_dlp_version), media.yt_dlp ? 'ok' : 'warn')} ${statusRow('FFmpeg', installed(media.ffmpeg, media.ffmpeg_version), media.ffmpeg ? 'ok' : 'warn')} ${statusRow('FFprobe', installed(media.ffprobe, media.ffprobe_version), media.ffprobe ? 'ok' : 'warn')} ${statusRow('aria2c', installed(runtime.aria2_available, runtime.aria2_version), runtime.aria2_available ? 'ok' : 'warn')}</section><section class="settings-section settings-section-tools" data-tool-update-section>${sectionHeading('tools', 'Herramientas internas')}${statusRow('yt-dlp', state, tone)}${availableVersion}${statusRow('Última comprobación', escapeHtml(checkedLabel), 'info')}<div class="settings-inline-actions settings-tool-update-actions"><button type="button" class="tool-update-check" ${checking || updating ? 'disabled aria-disabled="true"' : ''}>${icon('history', 16)} Buscar ahora</button>${canUpdate ? `<button type="button" class="tool-update-apply">${icon('download', 16)} Actualizar</button>` : ''}</div>${repositories}${openSourceLicenses}</section><section class="settings-section settings-section-compact">${sectionHeading('tools', 'Diagnóstico visual')}${statusRow('Escala efectiva', `${visual.resolvedScale || 100}%`, 'neutral')} ${statusRow('Tipografía', `${escapeHtml(visual.font?.size || '16px')} · Segoe UI`, 'neutral')}<button type="button" class="copy-visual-diagnostics">${icon('clipboard', 16)} Copiar diagnóstico</button></section></div>`;
}

export function settingsMarkup() {
  const categories = ['general', 'downloads', 'multimedia', 'appearance', 'integrations', 'updates'];
  const activeCategory = categories.includes(appState.settingsCategory) ? appState.settingsCategory : 'general';
  const page = activeCategory === 'downloads' ? downloadsPage() : activeCategory === 'multimedia' ? multimediaPage() : activeCategory === 'appearance' ? appearancePage() : activeCategory === 'integrations' ? integrationsPage() : activeCategory === 'updates' ? updatesPage() : generalPage();
  return `<section class="settings-view settings-workspace"><div class="settings-workspace-frame"><header class="settings-workspace-toolbar"><button type="button" class="settings-back" title="${tr('back') || 'Volver al gestor'}" aria-label="${tr('back') || 'Volver al gestor'}">${icon('arrow', 18)}<span>${tr('back') || 'Volver al gestor'}</span></button></header><div class="settings-workspace-layout">${nav(activeCategory)}<main class="settings-workspace-content">${page}</main></div></div></section>`;
}
