import {
  APPEARANCE_REVISION,
  DEFAULT_ICON_COLOR,
  DEFAULT_ICON_COLOR_MODE,
  PREVIOUS_DEFAULT_ICON_COLOR,
  DEFAULT_PROGRESS_ACTIVE_COLOR,
  DEFAULT_PROGRESS_COMPLETED_COLOR,
  DEFAULT_PROGRESS_ERROR_COLOR,
  DEFAULT_PROGRESS_PAUSED_COLOR,
  ICON_COLOR_MODE_ACCENT,
  normalizeIconColorMode,
  isHexColor
} from './tokens.js';

const THUMBNAIL_CACHE_VERSION = 3;
const APP_BASE_RATIO = 1.10;
const APPEARANCE_STORAGE_KEY = 'cacatools.desktop.appearance.v2';
const LEGACY_APPEARANCE_STORAGE_KEY = 'cacatools.desktop.appearance.v1';
const APPEARANCE_METRICS_STORAGE_KEY = 'cacatools.desktop.appearance.metrics.v1';
export { APPEARANCE_REVISION, DEFAULT_ICON_COLOR, DEFAULT_ICON_COLOR_MODE, ICON_COLOR_MODE_ACCENT } from './tokens.js';
const UI_SCALE_MIN = 50;
const UI_SCALE_MAX = 130;
const TEXT_SCALE_MIN = 80;
const TEXT_SCALE_MAX = 120;
const LEGACY_MIGRATION_SCALE_OFFSET = 25;
const LEGACY_MIGRATION_TEXT_OFFSET = 20;
const AUTO_SCALE_EXPONENT = 0.50;

let appearanceContext = {
  previewAccent: '',
  previewPreset: '',
  getAppState: () => undefined,
  onDownloadManagerAppearance: () => {}
};

export function configureAppearance({ previewAccent = '', previewPreset = '', getAppState = () => undefined, onDownloadManagerAppearance = () => {} } = {}) {
  appearanceContext = { previewAccent, previewPreset, getAppState, onDownloadManagerAppearance };
}

export const visualDiagnostics = { thumbnails: new Map(), lastUpdatedAt: 0 };

export function thumbnailProvider(value = '') {
  try {
    const host = new URL(String(value || ''), window.location.href).hostname.toLowerCase();
    if (host.includes('deezer')) return 'Deezer';
    if (host.includes('ytimg') || host.includes('youtube')) return 'YouTube';
    if (host.includes('musicbrainz') || host.includes('coverartarchive')) return 'Cover Art Archive';
    return host || 'local';
  } catch { return 'unknown'; }
}

export function thumbnailSrc(value = '') {
  const source = String(value || '').trim();
  if (!source) return '';
  try {
    const parsed = new URL(source, window.location.href);
    if (!['http:', 'https:'].includes(parsed.protocol)) return source;
    parsed.searchParams.set('ct_thumbnail_v', String(THUMBNAIL_CACHE_VERSION));
    return parsed.toString();
  } catch { return source; }
}

export function visualDiagnosticsSnapshot() {
  const root = document.documentElement;
  const images = [...visualDiagnostics.thumbnails.values()].slice(-20);
  const snapshot = {
    capturedAt: new Date().toISOString(),
    viewport: { width: window.innerWidth, height: window.innerHeight },
    cssViewport: { width: root.clientWidth, height: root.clientHeight },
    devicePixelRatio: Number(window.devicePixelRatio || 1),
    visualViewportScale: Number(window.visualViewport?.scale || 1),
    webViewZoom: Number(window.visualViewport?.scale || 1),
    windowsScaleHint: Number(root.dataset.displayScale || 0) || null,
    resolvedScale: Number(root.dataset.resolvedScale || 0) || null,
    effectiveFontSize: getComputedStyle(root).fontSize,
    fontFamily: getComputedStyle(document.body).fontFamily,
    thumbnailCacheVersion: THUMBNAIL_CACHE_VERSION,
    thumbnails: images
  };
  window.__cacatoolsVisualDiagnostics = snapshot;
  visualDiagnostics.lastUpdatedAt = Date.now();
  return snapshot;
}

export function bindVisualDiagnostics() {
  document.querySelectorAll('[data-thumbnail-image], [data-dm-thumbnail]').forEach((image) => {
    if (image.dataset.visualDiagnosticsBound === '1') return;
    image.dataset.visualDiagnosticsBound = '1';
    const collect = () => {
      const sourceUrl = String(image.dataset.originalThumbnail || image.currentSrc || image.src || '');
      const record = {
        sourceUrl,
        provider: thumbnailProvider(sourceUrl),
        declaredWidth: Number(image.dataset.thumbnailWidth || 0) || null,
        declaredHeight: Number(image.dataset.thumbnailHeight || 0) || null,
        naturalWidth: Number(image.naturalWidth || 0),
        naturalHeight: Number(image.naturalHeight || 0),
        renderedWidth: Math.round(image.getBoundingClientRect().width),
        renderedHeight: Math.round(image.getBoundingClientRect().height),
        cacheState: image.complete ? (image.naturalWidth > 0 ? 'loaded' : 'failed') : 'pending'
      };
      visualDiagnostics.thumbnails.set(`${sourceUrl}|${record.renderedWidth}x${record.renderedHeight}`, record);
      visualDiagnosticsSnapshot();
    };
    image.addEventListener('load', collect, { passive: true });
    image.addEventListener('error', collect, { passive: true });
    if (image.complete) collect();
  });
  visualDiagnosticsSnapshot();
}

export const appearancePresets = [
  { id: 'caca-green', name: 'Caca verde', accent: '#00ff2a', tone: 8, intensity: 88 },
  { id: 'caca-blue', name: 'Caca azul', accent: '#5f73ff', tone: 8, intensity: 84 },
  { id: 'violet', name: 'Violeta', accent: '#8a5cff', tone: 8, intensity: 86 },
  { id: 'cyan', name: 'Cian', accent: '#24b8e8', tone: 8, intensity: 82 },
  { id: 'rose', name: 'Rosa', accent: '#e45e9d', tone: 8, intensity: 78 },
  { id: 'amber', name: 'Ámbar', accent: '#f0a43b', tone: 8, intensity: 76 },
  { id: 'emerald', name: 'Esmeralda', accent: '#22c58b', tone: 8, intensity: 78 },
  { id: 'indigo', name: 'Índigo', accent: '#6f7cff', tone: 8, intensity: 84 },
  { id: 'magenta', name: 'Magenta', accent: '#d94fff', tone: 8, intensity: 80 },
  { id: 'crimson', name: 'Carmesí', accent: '#f15972', tone: 8, intensity: 78 },
  { id: 'teal', name: 'Turquesa', accent: '#12b8a5', tone: 8, intensity: 80 }
];

export const defaultAppearance = { theme: 'system', preset: 'cyan', accent: '#24b8e8', progressActive: DEFAULT_PROGRESS_ACTIVE_COLOR, progressCompleted: DEFAULT_PROGRESS_COMPLETED_COLOR, progressPaused: DEFAULT_PROGRESS_PAUSED_COLOR, progressError: DEFAULT_PROGRESS_ERROR_COLOR, progressActiveCustomized: false, progressCompletedCustomized: false, iconColorMode: DEFAULT_ICON_COLOR_MODE, iconColor: DEFAULT_ICON_COLOR, tone: 8, intensity: 82, contrast: 108, scale: 100, textScale: 100, density: 'balanced', thumbnailSize: 'large', autoScale: false, motion: true, motionMode: 'system', surfaceMode: 'mica', radius: 'soft', revision: 0, appearanceRevision: APPEARANCE_REVISION };

export function clamp(value, min, max) { return Math.min(max, Math.max(min, Number(value) || min)); }
const HEX_COLOR = /^#[0-9a-f]{6}$/i;
export function colorRgb(value, fallback = '#24b8e8') {
  const source = HEX_COLOR.test(String(value || '')) ? String(value) : fallback;
  const clean = source.slice(1);
  return [0, 2, 4].map((index) => Number.parseInt(clean.slice(index, index + 2), 16));
}
function hueForColor(value) {
  const [red, green, blue] = colorRgb(value).map((channel) => channel / 255);
  const maximum = Math.max(red, green, blue);
  const minimum = Math.min(red, green, blue);
  const delta = maximum - minimum;
  if (!delta) return 0;
  let hue = maximum === red
    ? 60 * (((green - blue) / delta) % 6)
    : maximum === green
      ? 60 * ((blue - red) / delta + 2)
      : 60 * ((red - green) / delta + 4);
  if (hue < 0) hue += 360;
  return hue;
}
export function iconVariantForColor(value) {
  const hue = hueForColor(value);
  if (hue < 20 || hue >= 335) return 'rojo';
  if (hue < 75) return 'naranja';
  if (hue < 170) return 'verde';
  if (hue < 205) return 'celeste';
  if (hue < 245) return 'azul';
  return 'morado';
}
export function colorLuminance(value) {
  return colorRgb(value).map((channel) => {
    const normalized = channel / 255;
    return normalized <= .04045 ? normalized / 12.92 : ((normalized + .055) / 1.055) ** 2.4;
  }).reduce((sum, channel, index) => sum + channel * [0.2126, 0.7152, 0.0722][index], 0);
}
export function blendColor(first, second, amount) {
  const a = colorRgb(first);
  const b = colorRgb(second, '#ffffff');
  const ratio = clamp(amount, 0, 1);
  return `#${a.map((channel, index) => Math.round(channel * (1 - ratio) + b[index] * ratio).toString(16).padStart(2, '0')).join('')}`;
}
export function colorContrast(first, second) {
  const a = colorLuminance(first);
  const b = colorLuminance(second);
  return (Math.max(a, b) + .05) / (Math.min(a, b) + .05);
}
export function accentPresentation(accent, theme = 'dark') {
  const luminance = colorLuminance(accent);
  const ink = colorContrast(accent, '#07111d') >= colorContrast(accent, '#ffffff') ? '#07111d' : '#ffffff';
  const detail = theme === 'light' && luminance > .34
    ? blendColor(accent, '#07111d', .58)
    : theme === 'dark' && luminance < .12
      ? blendColor(accent, '#ffffff', .46)
      : accent;
  return { ink, detail };
}
export function resolveAppearanceTheme(appearance = defaultAppearance) {
  const themeMode = appearance.themeMode || appearance.theme;
  if (themeMode !== 'system') return themeMode === 'light' ? 'light' : 'dark';
  return window.matchMedia?.('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}
export function displayedScalePercent(scale) { return clamp(Math.round(Number(scale ?? 100) / 5) * 5, UI_SCALE_MIN, UI_SCALE_MAX); }
export function internalScalePercent(scale) { return displayedScalePercent(scale); }
export function normalizeAppearance(value = {}) {
  const accent = isHexColor(value.accent) ? String(value.accent) : defaultAppearance.accent;
  const progressColor = (candidate, fallback) => HEX_COLOR.test(String(candidate || '')) ? String(candidate) : fallback;
  const density = value.density === 'normal' ? 'balanced' : value.density === 'comfortable' ? 'spacious' : value.density;
  const motionMode = ['system', 'reduced', 'off'].includes(value.motionMode)
    ? value.motionMode
    : value.motion === false ? 'off' : 'system';
  return {
    theme: ['dark', 'light', 'system'].includes(value.theme) ? value.theme : defaultAppearance.theme,
    preset: String(value.preset || 'custom'),
    accent,
    progressActive: progressColor(value.progressActive, defaultAppearance.progressActive),
    progressCompleted: progressColor(value.progressCompleted, defaultAppearance.progressCompleted),
    progressPaused: progressColor(value.progressPaused, defaultAppearance.progressPaused),
    progressError: progressColor(value.progressError, defaultAppearance.progressError),
    progressActiveCustomized: value.progressActiveCustomized === true,
    progressCompletedCustomized: value.progressCompletedCustomized === true,
    iconColorMode: normalizeIconColorMode(value.iconColorMode),
    iconColor: isHexColor(value.iconColor) ? String(value.iconColor) : defaultAppearance.iconColor,
    tone: clamp(value.tone ?? defaultAppearance.tone, 4, 18),
    intensity: clamp(value.intensity ?? defaultAppearance.intensity, 40, 100),
    contrast: clamp(value.contrast ?? defaultAppearance.contrast, 86, 116),
    scale: displayedScalePercent(value.scale ?? defaultAppearance.scale),
    textScale: Math.round(clamp(value.textScale ?? defaultAppearance.textScale, TEXT_SCALE_MIN, TEXT_SCALE_MAX) / 5) * 5,
    density: ['compact', 'balanced', 'spacious'].includes(density) ? density : defaultAppearance.density,
    thumbnailSize: ['medium', 'large', 'xlarge'].includes(value.thumbnailSize) ? value.thumbnailSize : defaultAppearance.thumbnailSize,
    autoScale: Object.prototype.hasOwnProperty.call(value, 'autoScale') ? value.autoScale === true : defaultAppearance.autoScale,
    motion: motionMode !== 'off',
    motionMode,
    surfaceMode: ['solid', 'mica'].includes(value.surfaceMode) ? value.surfaceMode : defaultAppearance.surfaceMode,
    radius: ['sharp', 'standard', 'soft'].includes(value.radius) ? value.radius : defaultAppearance.radius,
    revision: Math.max(0, Number(value.revision || 0)),
    appearanceRevision: Math.max(0, Number(value.appearanceRevision || APPEARANCE_REVISION))
  };
}
export function loadStoredAppearance() {
  let raw = {};
  try { raw = JSON.parse(localStorage.getItem(APPEARANCE_STORAGE_KEY) || localStorage.getItem(LEGACY_APPEARANCE_STORAGE_KEY) || '{}'); } catch {}
  const hasStoredAppearance = raw && typeof raw === 'object' && Object.keys(raw).length > 0;
  const sourceRevision = hasStoredAppearance ? Math.max(0, Number(raw.appearanceRevision || 0)) : APPEARANCE_REVISION;
  let migrated = !hasStoredAppearance || sourceRevision < APPEARANCE_REVISION;
  if (!hasStoredAppearance) raw = { ...defaultAppearance };
  if (sourceRevision < 6) {
    const legacyScale = sourceRevision < 3 ? Number(raw.scale || 120) - 20 : Number(raw.scale || 125);
    raw = {
      ...raw,
      scale: legacyScale || 125,
      textScale: Math.max(115, Number(raw.textScale || 120)),
      density: raw.density === 'comfortable' ? 'spacious' : raw.density === 'balanced' ? 'normal' : raw.density || 'normal',
      thumbnailSize: raw.thumbnailSize || 'large',
      autoScale: raw.autoScale
    };
  }
  if (sourceRevision < APPEARANCE_REVISION) {
    let inheritedTheme = raw.theme;
    if (!['dark', 'light', 'system'].includes(inheritedTheme)) {
      try { inheritedTheme = JSON.parse(localStorage.getItem('cacatools.download-manager.v2') || '{}').theme; } catch {}
    }
    const restoreHistoricalProgressDefault = (value, fallback) => String(value || '').toLowerCase() === '#24b8e8' ? fallback : value;
    const preserveCustomIconColor = raw.iconColorMode === 'custom'
      && isHexColor(raw.iconColor)
      && String(raw.iconColor).toLowerCase() !== PREVIOUS_DEFAULT_ICON_COLOR;
    raw = {
      ...raw,
      theme: ['dark', 'light', 'system'].includes(inheritedTheme) ? inheritedTheme : 'dark',
       scale: clamp(Number(raw.scale ?? 125) - LEGACY_MIGRATION_SCALE_OFFSET, UI_SCALE_MIN, UI_SCALE_MAX),
       textScale: clamp(Number(raw.textScale ?? 120) - LEGACY_MIGRATION_TEXT_OFFSET, TEXT_SCALE_MIN, TEXT_SCALE_MAX),
      motionMode: raw.motion === false ? 'off' : 'system',
      density: raw.density === 'normal' ? 'balanced' : raw.density,
       surfaceMode: raw.surfaceMode,
      radius: raw.radius || 'standard',
      progressActive: restoreHistoricalProgressDefault(raw.progressActive, DEFAULT_PROGRESS_ACTIVE_COLOR),
      progressCompleted: restoreHistoricalProgressDefault(raw.progressCompleted, DEFAULT_PROGRESS_COMPLETED_COLOR),
      iconColorMode: preserveCustomIconColor ? 'custom' : DEFAULT_ICON_COLOR_MODE,
      iconColor: preserveCustomIconColor ? String(raw.iconColor) : DEFAULT_ICON_COLOR,
      appearanceRevision: APPEARANCE_REVISION
    };
  }
  let stored = normalizeAppearance(raw);
  if (migrated) storeAppearanceLocally(stored);
  if (appearanceContext.previewPreset) {
    const preset = appearancePresets.find((entry) => entry.id === appearanceContext.previewPreset);
    if (preset) stored = normalizeAppearance({ ...stored, ...preset, preset: preset.id });
  }
  if (/^#[0-9a-f]{6}$/i.test(appearanceContext.previewAccent)) stored = normalizeAppearance({ ...stored, preset: 'custom', accent: appearanceContext.previewAccent });
  return stored;
}
export function storeAppearanceLocally(value) {
  try { localStorage.setItem(APPEARANCE_STORAGE_KEY, JSON.stringify(value)); } catch {}
}
export function automaticScalePercent() {
  const viewportWidth = Number(window.innerWidth) || Number(document.documentElement.clientWidth) || Number(window.visualViewport?.width) || 0;
  const viewportHeight = Number(window.innerHeight) || Number(document.documentElement.clientHeight) || Number(window.visualViewport?.height) || 0;
  const logicalViewportArea = Math.max(1, viewportWidth * viewportHeight);
  const rawScale = 100 * (logicalViewportArea / (1920 * 1080)) ** AUTO_SCALE_EXPONENT;
  return clamp(Math.round(rawScale / 5) * 5, 90, 130);
}
export function effectiveInterfaceRatio(displayedScale, baseRatio = 1) {
  const requestedRatio = Number(displayedScale) / 100;
  const safeBaseRatio = Number.isFinite(Number(baseRatio)) && Number(baseRatio) > 0 ? Number(baseRatio) : 1;
  return clamp(requestedRatio * safeBaseRatio, UI_SCALE_MIN / 100, (UI_SCALE_MAX / 100) * safeBaseRatio);
}
export function synchronizeDownloadManagerAppearance(appearance) {
  try {
    const key = 'cacatools.download-manager.v2';
    const stored = JSON.parse(localStorage.getItem(key) || '{}');
    const next = { ...stored, theme: appearance.theme, accent: appearance.accent, accentIntensity: appearance.intensity, uiScale: displayedScalePercent(appearance.scale), textScale: appearance.textScale, progressActive: appearance.progressActive, progressCompleted: appearance.progressCompleted, progressPaused: appearance.progressPaused, progressError: appearance.progressError, progressActiveCustomized: appearance.progressActiveCustomized === true, progressCompletedCustomized: appearance.progressCompletedCustomized === true, iconColorMode: appearance.iconColorMode, iconColor: appearance.iconColor, appearanceRevision: APPEARANCE_REVISION };
    localStorage.setItem(key, JSON.stringify(next));
  } catch {}
}
export function applyAccentVariables(root, appearance) {
  const theme = appearance.resolvedTheme || resolveAppearanceTheme(appearance);
  const mixBase = theme === 'light' ? '#ffffff' : '#07111d';
  const effectiveAccent = blendColor(mixBase, appearance.accent, appearance.intensity / 100);
  const accentVisual = accentPresentation(effectiveAccent, theme);
  const accentSurface = theme === 'light' ? '#f7f9fb' : `hsl(213 48% ${appearance.tone + 4}%)`;
  const accentBorderBase = theme === 'light' ? '#b9c5d2' : `hsl(212 36% ${appearance.tone + 16}%)`;
  root.style.setProperty('--accent-base', appearance.accent);
  root.style.setProperty('--accent-rgb', colorRgb(effectiveAccent).join(','));
  root.style.setProperty('--accent-ink', accentVisual.ink);
  root.style.setProperty('--accent-detail', accentVisual.detail);
  root.style.setProperty('--accent', effectiveAccent);
  root.style.setProperty('--accent-strong', accentVisual.detail);
  root.style.setProperty('--accent-soft', `color-mix(in srgb, ${effectiveAccent} ${theme === 'light' ? 12 : 18}%, ${accentSurface})`);
  root.style.setProperty('--accent-glow', `color-mix(in srgb, ${appearance.accent} 22%, transparent)`);
  root.style.setProperty('--accent-border', `color-mix(in srgb, ${accentVisual.detail} 48%, ${accentBorderBase})`);
  root.style.setProperty('--accent-button', `linear-gradient(105deg,color-mix(in srgb, ${accentVisual.detail} 90%, white),color-mix(in srgb, ${accentVisual.detail} 84%, #07111d))`);
  root.style.setProperty('--accent-gradient', `linear-gradient(90deg,color-mix(in srgb, ${accentVisual.detail} 92%, white),color-mix(in srgb, ${accentVisual.detail} 82%, #07111d))`);
  root.style.setProperty('--accent-gradient-soft', `linear-gradient(105deg,color-mix(in srgb, ${effectiveAccent} 22%, transparent),color-mix(in srgb, ${effectiveAccent} 10%, transparent))`);
  root.style.setProperty('--accent-contrast', accentVisual.detail);
  const iconAccent = appearance.iconColorMode === 'custom' && isHexColor(appearance.iconColor) ? appearance.iconColor : effectiveAccent;
  root.style.setProperty('--icon-accent', iconAccent);
  root.style.setProperty('--focus-ring', `color-mix(in srgb, ${accentVisual.detail} 72%, transparent)`);
  root.style.setProperty('--progress-active', appearance.progressActive || defaultAppearance.progressActive);
  root.style.setProperty('--progress-completed', appearance.progressCompleted || defaultAppearance.progressCompleted);
  root.style.setProperty('--progress-paused', appearance.progressPaused || defaultAppearance.progressPaused);
  root.style.setProperty('--progress-error', appearance.progressError || defaultAppearance.progressError);
}
const appearancePerformance = globalThis.__cacatoolsAppearancePerformance || {
  previewEvents: 0,
  previewCommits: 0,
  persistenceWrites: 0,
  globalRendersDuringPreview: 0,
  totalPreviewLatencyMs: 0,
  maxPreviewLatencyMs: 0
};
globalThis.__cacatoolsAppearancePerformance = appearancePerformance;
export function appearancePerformanceSnapshot() {
  const averagePreviewLatencyMs = appearancePerformance.previewCommits
    ? appearancePerformance.totalPreviewLatencyMs / appearancePerformance.previewCommits
    : 0;
  return { ...appearancePerformance, averagePreviewLatencyMs: Number(averagePreviewLatencyMs.toFixed(3)) };
}
export function markAppearancePersistence() { appearancePerformance.persistenceWrites += 1; }
let appearanceLiveFrame = 0;
let pendingLiveAppearance = null;
let lastAppliedNativeTheme = Symbol('native-theme-unset');
let lastAppliedNativeIconVariant = '';
let pendingNativeIconVariant = '';
let nativeIconUpdateWorker = null;
function startNativeIconUpdateWorker(invoke) {
  if (nativeIconUpdateWorker) return;
  nativeIconUpdateWorker = (async () => {
    while (pendingNativeIconVariant && pendingNativeIconVariant !== lastAppliedNativeIconVariant) {
      const nextVariant = pendingNativeIconVariant;
      pendingNativeIconVariant = '';
      try {
        await invoke('set_application_icon', { variant: nextVariant });
        lastAppliedNativeIconVariant = nextVariant;
      } catch {}
    }
  })().finally(() => {
    nativeIconUpdateWorker = null;
    if (pendingNativeIconVariant && pendingNativeIconVariant !== lastAppliedNativeIconVariant) {
      startNativeIconUpdateWorker(invoke);
    }
  });
}
export function applyBrandIconVariant(variant) {
  document.querySelectorAll('[data-cdm-brand-logo]').forEach((image) => {
    const base = image.dataset.brandIconBase || './app-ui/assets/brand';
    const next = `${base}/clear-download-manager-${variant}.png`;
    if (image.getAttribute('src') !== next) image.setAttribute('src', next);
  });
}
export function applyNativeApplicationIcon(appearance = defaultAppearance) {
  // The native/brand icon represents the application itself, so it always
  // follows the app accent.  The optional icon-color setting is reserved for
  // file-type artwork inside the UI and must never recolor the Windows icon.
  const source = appearance.accent;
  const variant = iconVariantForColor(source);
  try {
    const invoke = window.__TAURI__?.core?.invoke;
    if (typeof invoke !== 'function' || variant === lastAppliedNativeIconVariant) return;
    pendingNativeIconVariant = variant;
    // Accent previews can call this function several times before the native
    // command resolves.  Keep one worker and always apply the latest requested
    // variant after the previous command has finished; concurrent invokes can
    // otherwise complete out of order and make the Windows icon flip back.
    if (nativeIconUpdateWorker) return;
    startNativeIconUpdateWorker(invoke);
  } catch {}
}
function applyNativeWindowTheme(theme) {
  if (Object.is(lastAppliedNativeTheme, theme)) return;
  lastAppliedNativeTheme = theme;
  try {
    const tauri = window.__TAURI__;
    const invoke = tauri?.core?.invoke;
    if (typeof invoke === 'function') {
      Promise.resolve(invoke('plugin:app|set_app_theme', { theme })).catch(() => {});
      return;
    }
    const getCurrentWindow = tauri?.window?.getCurrentWindow;
    const currentWindow = typeof getCurrentWindow === 'function' ? getCurrentWindow() : null;
    const setTheme = currentWindow?.setTheme;
    if (typeof setTheme === 'function') Promise.resolve(setTheme.call(currentWindow, theme)).catch(() => {});
  } catch {}
}
export function scheduleAppearanceLivePreview(value) {
  appearancePerformance.previewEvents += 1;
  pendingLiveAppearance = { value, queuedAt: globalThis.performance?.now?.() ?? Date.now() };
  if (appearanceLiveFrame) return;
  appearanceLiveFrame = window.requestAnimationFrame(() => {
    appearanceLiveFrame = 0;
    const pending = pendingLiveAppearance;
    pendingLiveAppearance = null;
    if (!pending) return;
    const latency = Math.max(0, (globalThis.performance?.now?.() ?? Date.now()) - pending.queuedAt);
    appearancePerformance.previewCommits += 1;
    appearancePerformance.totalPreviewLatencyMs += latency;
    appearancePerformance.maxPreviewLatencyMs = Math.max(appearancePerformance.maxPreviewLatencyMs, latency);
      applyAccentVariables(document.documentElement, pending.value);
      // Live slider previews are intentionally web-only.  Do not rewrite
      // document-wide brand images here: the main download view owns its
      // sidebar logo and renders it from the committed app accent.  Updating
      // all images during a slider preview let stale renders put the cyan
      // bootstrap image back over a committed green/red logo.
      appearanceContext.onDownloadManagerAppearance?.(pending.value);
  });
}
export function applyAppearance(value = appearanceContext.getAppState()?.appearance || defaultAppearance, { synchronize = true, updateNativeIcon = true } = {}) {
  const appearance = normalizeAppearance(value);
  const root = document.documentElement;
   const tone = appearance.tone;
   applyNativeWindowTheme(appearance.theme === 'system' ? null : appearance.theme);
  const theme = resolveAppearanceTheme(appearance);
  const resolvedAppearance = { ...appearance, resolvedTheme: theme };
  const viewportHeight = Math.max(window.innerHeight || 0, document.documentElement.clientHeight || 0);
  const resolvedScale = appearance.autoScale ? automaticScalePercent() : appearance.scale;
  // Universal internal baseline for non-Main surfaces. The Download Manager
  // keeps its approved 1.20 Main-only owner in main.js; never multiply both.
  const interfaceRatio = effectiveInterfaceRatio(resolvedScale, APP_BASE_RATIO);
  const textScale = clamp(1.08 + (appearance.textScale - 100) * .004, .92, 1.16);
  const effectiveFontSize = clamp(16 * interfaceRatio, 16.5, 29);
  const densityMap = { compact: .94, balanced: 1, spacious: 1.09 };
  const layoutDensity = clamp(interfaceRatio * (densityMap[appearance.density] || 1), .98, 1.48);
  root.style.setProperty('--ui-scale', String(interfaceRatio)); root.style.setProperty('--resolved-scale', String(resolvedScale)); root.style.setProperty('--density-scale', String(layoutDensity));
  root.style.setProperty('--display-density', String(window.devicePixelRatio || 1)); root.style.setProperty('--effective-font-size', `${effectiveFontSize.toFixed(2)}px`); root.style.setProperty('--root-font-size', `${effectiveFontSize.toFixed(2)}px`); root.style.setProperty('--text-scale', String(textScale));
   root.style.setProperty('--semantic-ui-scale', String(resolvedScale / 100)); root.style.setProperty('--thumbnail-scale', appearance.thumbnailSize === 'xlarge' ? '1.14' : appearance.thumbnailSize === 'medium' ? '.92' : '1'); root.style.setProperty('--viewport-height', `${viewportHeight}px`);
   root.style.setProperty('--range-track-inactive', theme === 'light' ? '#c7ced7' : '#1b2735');
  const radiusMap = { sharp: '2px', standard: '8px', soft: '14px' };
  const motionMode = appearance.motionMode || (appearance.motion === false ? 'off' : 'system');
  const reducedMotion = motionMode === 'reduced' || (motionMode === 'system' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches);
  const mixBase = theme === 'light' ? '#ffffff' : '#07111d';
  const effectiveAccent = blendColor(mixBase, appearance.accent, appearance.intensity / 100);
  const accentVisual = accentPresentation(effectiveAccent, theme);
  root.dataset.motionMode = motionMode;
  root.dataset.reducedMotion = reducedMotion ? 'true' : 'false';
  root.dataset.surfaceMode = appearance.surfaceMode;
  root.dataset.radius = appearance.radius;
  root.style.setProperty('--radius-sm', radiusMap[appearance.radius] || radiusMap.standard);
  root.style.setProperty('--radius-md', radiusMap[appearance.radius] || radiusMap.standard);
  root.style.setProperty('--radius-lg', appearance.radius === 'sharp' ? '4px' : appearance.radius === 'soft' ? '20px' : '12px');
  root.dataset.displayScale = String(Math.round((window.devicePixelRatio || 1) * 100)); root.dataset.scaleMode = appearance.autoScale ? 'auto' : 'manual'; root.dataset.resolvedScale = String(resolvedScale); root.dataset.contentDensity = appearance.density;
  const scaledBodyFont = (pixels) => `${clamp(pixels * interfaceRatio * textScale * .78, pixels, pixels * 1.62).toFixed(2)}px`;
  const scaledHeadingFont = (pixels) => `${clamp(pixels * interfaceRatio * .78, pixels, pixels * 1.62).toFixed(2)}px`;
  root.style.setProperty('--font-xs', scaledBodyFont(14)); root.style.setProperty('--font-sm', scaledBodyFont(15)); root.style.setProperty('--font-md', scaledBodyFont(16)); root.style.setProperty('--font-lg', scaledHeadingFont(18)); root.style.setProperty('--font-xl', scaledHeadingFont(22)); root.style.setProperty('--font-2xl', scaledHeadingFont(27)); root.style.setProperty('--font-3xl', scaledHeadingFont(32));
  try {
    localStorage.setItem(APPEARANCE_METRICS_STORAGE_KEY, JSON.stringify({
      interfaceRatio,
      textScale,
      resolvedScale,
      theme,
      density: appearance.density,
      viewportWidth: window.innerWidth || 0,
      viewportHeight: window.innerHeight || 0
    }));
  } catch {}
  applyAccentVariables(root, resolvedAppearance);
  // The main window is the single owner of the Windows taskbar/tray icon.
  // Preparation subwindows share the appearance module but can briefly load a
  // stale persisted accent; letting each one call the native command makes the
  // icon oscillate between variants while those windows open or refresh.
  if (updateNativeIcon) applyNativeApplicationIcon(resolvedAppearance);
  const palette = theme === 'light' ? {
    bgApp: '#e9eef4', bgSidebar: '#e4eaf1', bgSurface: '#f7f9fb', bgRaised: '#ffffff', bgInput: '#eef2f6', bgHover: '#e7edf3',
    borderSubtle: '#d5dde7', borderStrong: '#b9c5d2', textPrimary: '#172231', textSecondary: '#526174', textMuted: '#728095',
    success: '#168455', warning: '#a86308', danger: '#c43d4b', info: '#276ea8', shadow: '0 18px 48px rgba(41,57,74,.14)'
  } : {
    bgApp: `hsl(215 54% ${tone - 2}%)`, bgSidebar: `hsl(214 51% ${tone + 1}%)`, bgSurface: `hsl(213 48% ${tone + 4}%)`, bgRaised: `hsl(212 46% ${tone + 7}%)`, bgInput: `hsl(214 48% ${tone + 2}%)`, bgHover: `hsl(212 45% ${tone + 10}%)`,
    borderSubtle: `hsl(212 35% ${tone + 10}%)`, borderStrong: `hsl(211 32% ${tone + 16}%)`, textPrimary: '#f5f7fc', textSecondary: `hsl(212 24% ${clamp(68 * appearance.contrast / 100, 60, 78)}%)`, textMuted: `hsl(212 24% ${clamp(61 * appearance.contrast / 100, 52, 72)}%)`,
     success: '#00ff2a', warning: '#e2a93f', danger: '#ef6674', info: '#4ba3df', shadow: '0 24px 68px rgba(0,0,0,.34)'
  };
  const tokens = {
    '--surface-base': palette.bgApp, '--surface-primary': palette.bgSurface, '--surface-secondary': palette.bgInput, '--surface-elevated': palette.bgRaised,
    '--border-default': palette.borderStrong, '--border-subtle': palette.borderSubtle, '--border-strong': palette.borderStrong,
    '--text-primary': palette.textPrimary, '--text-secondary': palette.textSecondary, '--text-muted': palette.textMuted,
    '--accent-hover': accentVisual.detail, '--accent-active': accentVisual.detail, '--accent-surface-subtle': `color-mix(in srgb, ${effectiveAccent} 12%, ${palette.bgSurface})`,
    '--bg-app': palette.bgApp, '--bg-sidebar': palette.bgSidebar, '--bg-surface': palette.bgSurface, '--bg-surface-raised': palette.bgRaised, '--bg-input': palette.bgInput, '--bg-hover': palette.bgHover,
    '--border-subtle': palette.borderSubtle, '--border-strong': palette.borderStrong, '--text-primary': palette.textPrimary, '--text-secondary': palette.textSecondary, '--text-muted': palette.textMuted,
    '--success': palette.success, '--warning': palette.warning, '--danger': palette.danger, '--info': palette.info, '--shadow-theme': palette.shadow,
    '--bg': palette.bgApp, '--window': palette.bgSurface, '--sidebar': palette.bgSidebar, '--panel': palette.bgSurface, '--panel-2': palette.bgRaised, '--panel-3': palette.bgHover, '--panel-hover': palette.bgHover,
    '--line': palette.borderStrong, '--line-soft': palette.borderSubtle, '--text': palette.textPrimary, '--text-soft': palette.textSecondary, '--muted': palette.textMuted, '--muted-2': palette.textMuted,
    '--green': palette.success, '--amber': palette.warning, '--red': palette.danger,
    '--dl-bg': palette.bgApp, '--dl-window': palette.bgSurface, '--dl-panel': palette.bgSurface, '--dl-panel-2': palette.bgRaised, '--dl-line': palette.borderStrong, '--dl-line-soft': palette.borderSubtle, '--dl-text': palette.textPrimary, '--dl-muted': palette.textMuted
  };
  Object.entries(tokens).forEach(([name, tokenValue]) => root.style.setProperty(name, tokenValue));
  root.dataset.motion = reducedMotion ? 'off' : 'on'; root.dataset.theme = theme; root.style.colorScheme = theme;
  window.requestAnimationFrame(() => document.querySelectorAll('.module-iframe').forEach((frame) => frame.contentWindow?.postMessage({ type: 'cacatools:appearance', accent: appearance.accent, theme, scale: appearance.scale, textScale: appearance.textScale }, '*')));
   if (synchronize) synchronizeDownloadManagerAppearance(appearance);
   appearanceContext.onDownloadManagerAppearance?.(resolvedAppearance);
  window.requestAnimationFrame(visualDiagnosticsSnapshot); return appearance;
}
export { THUMBNAIL_CACHE_VERSION };
