import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { configureSettings, settingsMarkup } from '../../app-ui/modules/settings/index.js';
import * as settingsModule from '../../app-ui/modules/settings/index.js';
import { torrentDialog, updateDialog } from '../../app-ui/download-manager/view/dialogs.js';
import { downloadRowMarkup, downloadRowState, truncateDownloadTitle } from '../../app-ui/download-manager/view/unified.js';
import { newsPanel } from '../../app-ui/download-manager/view/sections.js';
import { jobsForSection, normalizePreferences } from '../../app-ui/download-manager/core/model.js';
import { translate } from '../../app-ui/modules/i18n/index.js';

globalThis.window ||= { __cacatoolsVisualDiagnostics: null };

const settingsCss = await readFile(new URL('../../app-ui/modules/settings/styles.css', import.meta.url), 'utf8');
const appearanceCss = await readFile(new URL('../../app-ui/modules/appearance/styles.css', import.meta.url), 'utf8');
const baseCss = await readFile(new URL('../../app-ui/download-manager/styles/01-base.css', import.meta.url), 'utf8');
const componentCss = await readFile(new URL('../../app-ui/download-manager/styles/03-components.css', import.meta.url), 'utf8');
const legacyToolbarCss = await readFile(new URL('../../app-ui/download-manager/styles/06-legacy-order.css', import.meta.url), 'utf8');
const overrideCss = await readFile(new URL('../../app-ui/download-manager/styles/05-overrides.css', import.meta.url), 'utf8');
const subwindowCss = await readFile(new URL('../../app-ui/subwindow.css', import.meta.url), 'utf8');
const subwindowJs = await readFile(new URL('../../app-ui/subwindow.js', import.meta.url), 'utf8');
const mainJs = await readFile(new URL('../../app-ui/main.js', import.meta.url), 'utf8');
const liveJs = await readFile(new URL('../../app-ui/download-manager/live.js', import.meta.url), 'utf8');
const newsJs = await readFile(new URL('../../app-ui/download-manager/view/sections.js', import.meta.url), 'utf8');
const sidebarJs = await readFile(new URL('../../app-ui/download-manager/view/zen-sidebar.js', import.meta.url), 'utf8');
const appearanceJs = await readFile(new URL('../../app-ui/modules/appearance/index.js', import.meta.url), 'utf8');
const downloadManagerJs = await readFile(new URL('../../app-ui/download-manager/index.js', import.meta.url), 'utf8');
const downloadEventsJs = await readFile(new URL('../../app-ui/download-manager/events.js', import.meta.url), 'utf8');
const appearanceTokens = await import('../../app-ui/modules/appearance/tokens.js');

const settingsContext = {
  getAppState: () => ({
    settingsCategory: 'general',
    appearance: { theme: 'light', accent: '#2196e8', autoScale: true, scale: 100 },
    startupStatus: { enabled: false, supported: true },
    experienceSettings: { automaticUpdateChecks: true, clipboardAutoSuggest: true, locale: 'en' },
    windowBehavior: { closeAction: 'tray' }
  }),
  translate: (key) => key,
  icon: (name) => `<svg data-icon="${name}"></svg>`,
  escapeHtml: (value) => String(value ?? '')
};
configureSettings(settingsContext);
const setSettingsCategory = (category) => configureSettings({
  ...settingsContext,
  getAppState: () => ({ ...settingsContext.getAppState(), settingsCategory: category })
});

test('settings rail has visible labels and keeps the current category/action hooks', () => {
  const html = settingsMarkup();
  assert.match(html, /settings-workspace-nav/);
  assert.match(html, /data-settings-category="general"[^>]*>[\s\S]*?<span>General<\/span>/);
  assert.match(html, /data-settings-category="downloads"[^>]*>[\s\S]*?<span>Descargas<\/span>/);
  assert.match(html, /data-settings-category="components"[^>]*>[\s\S]*?<span>Complementos<\/span>/);
});

test('true binary preferences use accessible switch semantics and preserve state values', () => {
  const html = settingsMarkup();
  assert.match(html, /id="startup-toggle"[^>]*role="switch"/);
  assert.match(html, /id="auto-updates-toggle"[^>]*role="switch"/);
  assert.match(html, /id="clipboard-suggest-toggle"[^>]*role="switch"/);
  setSettingsCategory('appearance');
  const appearanceHtml = settingsMarkup();
  assert.match(appearanceHtml, /id="auto-scale-toggle"[^>]*role="switch"/);
  assert.doesNotMatch(appearanceHtml, /id="auto-scale-select"/);
  assert.match(mainJs, /#auto-scale-toggle[\s\S]{0,160}checked/);
  configureSettings(settingsContext);
});

test('settings return action sits at the bottom of the navigation rail', () => {
  const html = settingsMarkup();
  const intro = html.match(/<header class="settings-page-intro">[\s\S]*?<\/header>/)?.[0] || '';
  assert.match(intro, /<h2>general<\/h2>/i);
  assert.doesNotMatch(intro, /class="settings-back"/);
  assert.match(html, /class="settings-nav-footer"[\s\S]*class="settings-back"/);
  assert.doesNotMatch(html, /settings-workspace-toolbar/);
});

test('General offers a confirmed app-preferences reset without implying download or history deletion', () => {
  const html = settingsMarkup();
  assert.match(html, /data-settings-reset-all/);
  assert.match(html, /restablecer.*ajustes|ajustes.*restablecer/i);
  assert.match(html, /se conservan las descargas, el historial y los archivos/i);
  assert.match(mainJs, /window\.confirm\(t\('¿Restablecer los ajustes de Clear Download Manager\? Las descargas, el historial y los archivos se conservarán\.'\)\)/);
  assert.match(mainJs, /invoke\('reset_application_preferences'\)/);
});

test('Appearance owns scale controls, updates keeps diagnostics, and settings labels are concise', () => {
  configureSettings(settingsContext);
  setSettingsCategory('appearance');
  const appearance = settingsMarkup();
  assert.match(appearance, /id="scale-decrease"/);
  assert.match(appearance, /id="scale-range"/);
  assert.match(appearance, /data-settings-category="appearance"[^>]*aria-current="page"/);

  setSettingsCategory('general');
  const general = settingsMarkup();
  assert.match(general, /<h3>language<\/h3>[\s\S]*<b>interfaceLanguage<\/b>/);

  setSettingsCategory('updates');
  const updates = settingsMarkup();
  assert.match(updates, /copy-visual-diagnostics/);
  assert.doesNotMatch(updates, /id="scale-(?:decrease|number|increase|range)"|id="auto-scale-toggle"|Escala efectiva|Tipografía/);
  assert.doesNotMatch(settingsCss, /settings-diagnostic-scale|settings-diagnostic-typography/);
  assert.doesNotMatch(updates.match(/class="copy-visual-diagnostics"[^>]*>[\s\S]*?<\/button>/)?.[0] || '', /<svg/);
  assert.match(appearanceJs, /applyBrandIconVariant\(iconVariantForColor\(pending\.value\.accent\)\)/);
  assert.equal(translate('es', 'interfaceLanguage'), 'Idioma de la interfaz');
  assert.equal(translate('en', 'interfaceLanguage'), 'Interface language');
});

test('preset accent changes update the selected check and settings logo without leaving Appearance', () => {
  const syncSelection = settingsModule.syncAccentPresetSelection;
  assert.equal(typeof syncSelection, 'function');

  const makeSwatch = (preset, active = false) => {
    const classes = new Set(active ? ['is-active'] : []);
    const attributes = new Map([['aria-pressed', String(active)]]);
    return {
      dataset: { preset },
      classList: { toggle(name, enabled) { enabled ? classes.add(name) : classes.delete(name); }, contains: (name) => classes.has(name) },
      setAttribute(name, value) { attributes.set(name, value); },
      getAttribute(name) { return attributes.get(name); },
      innerHTML: `<i></i>${active ? '<svg data-icon="check"></svg>' : ''}`
    };
  };
  const previous = makeSwatch('crimson', true);
  const selected = makeSwatch('green');
  const root = { querySelectorAll: () => [previous, selected] };

  syncSelection(root, 'green', '<svg data-icon="check"></svg>');

  assert.equal(previous.classList.contains('is-active'), false);
  assert.equal(previous.getAttribute('aria-pressed'), 'false');
  assert.doesNotMatch(previous.innerHTML, /data-icon="check"/);
  assert.equal(selected.classList.contains('is-active'), true);
  assert.equal(selected.getAttribute('aria-pressed'), 'true');
  assert.match(selected.innerHTML, /data-icon="check"/);
  assert.match(mainJs, /applyBrandIconVariant\(iconVariantForColor\(appState\.appearance\.accent\)\)/);
});

test('selected settings segments keep neutral fill and text with only an accent outline', () => {
  assert.match(settingsCss, /\.settings-choice-options input:checked \+ span\s*\{\s*color:\s*var\(--text-secondary\);?\s*\}/);
  assert.match(settingsCss, /\.settings-choice-options label:has\(input:checked\)\s*\{[^}]*background:\s*var\(--settings-elevated\);[^}]*box-shadow:\s*inset 0 0 0 1px var\(--accent\);/s);
});

test('every custom switch has a press response and respects reduced motion', () => {
  assert.match(settingsCss, /\.settings-switch-control input\[type="checkbox"\]\[role="switch"\]:active/);
  assert.match(appearanceCss, /input\[type="checkbox"\]\[role="switch"\]:active/);
  assert.match(overrideCss, /\.dm-switch-row > input\[type="checkbox"\]\[role="switch"\]:active/);
  assert.match(settingsCss, /prefers-reduced-motion:\s*reduce/);
  assert.match(appearanceCss, /prefers-reduced-motion:\s*reduce/);
});

test('default download progress colors match the semantic palette and neutral controls stay neutral', () => {
  assert.equal(appearanceTokens.DEFAULT_PROGRESS_ACTIVE_COLOR, '#22a9d6');
  assert.equal(appearanceTokens.DEFAULT_PROGRESS_COMPLETED_COLOR, '#04d25a');
  assert.equal(appearanceTokens.DEFAULT_PROGRESS_PAUSED_COLOR, '#e2a93f');
  assert.equal(appearanceTokens.DEFAULT_PROGRESS_ERROR_COLOR, '#ef6674');
  assert.match(settingsCss, /\.settings-control select,[\s\S]{0,240}background: var\(--settings-elevated\)/);
  assert.match(settingsCss, /\.settings-switch-control input\[type="checkbox"\]\[role="switch"\][\s\S]{0,500}background: var\(--settings-divider\)/);
  assert.match(settingsCss, /\.settings-category-button\.is-active::before[\s\S]{0,140}width: 2px/);
});

test('reference dialogs keep action hooks and real updater progress slot', () => {
  const torrent = torrentDialog({ torrentSource: '', torrentBusy: false });
  assert.match(torrent, /data-dm-choose-torrent/);
  assert.match(torrent, /data-dm-paste-torrent/);
  assert.match(torrent, /data-dm-queue-torrent/);
  assert.match(torrent, /dm-torrent-source/);

  const update = updateDialog({ availableUpdate: { version: '1.2.3' }, updaterInstallBusy: true, updaterProgress: { phase: 'download', percent: 41, downloadedBytes: 4, contentLength: 10 } });
  assert.match(update, /data-dm-update-progress-slot/);
  assert.match(update, /data-dm-modal-action="install-update"/);
  assert.match(update, /aria-valuenow="41"/);
});

test('reference styling uses personalization tokens and supports modal elevation', () => {
  assert.match(settingsCss, /--accent/);
  assert.match(settingsCss, /\.settings-category-button span/);
  assert.match(settingsCss, /\[role="switch"\]/);
  assert.match(appearanceCss, /\[role="switch"\]/);
  assert.match(baseCss, /\.dm-modal-backdrop/);
  assert.match(baseCss, /var\(--dm-accent\)/);
  assert.match(componentCss, /\.dm-update-progress/);
  assert.match(subwindowCss, /var\(--sp-accent\)/);
});

test('Downloads reference-only preferences are not rendered as inert controls', () => {
  setSettingsCategory('downloads');
  const html = settingsMarkup();
  assert.doesNotMatch(html, /Create subfolders by category|Use original file names|Ask for download location|Resume interrupted downloads/);
  configureSettings(settingsContext);
});

test('Settings brand uses the accent-aware app logo and keeps headings visually quiet', () => {
  const general = settingsMarkup();
  assert.match(general, /class="settings-nav-brand"[^>]*>[\s\S]*?<img[^>]*data-cdm-brand-logo[^>]*data-brand-icon-base="\.\/app-ui\/assets\/brand"/);
  assert.doesNotMatch(general, /settings-nav-brand[^<]*<span>/);
  assert.doesNotMatch(general, /settings-section-heading"><svg/);
});

test('selected controls keep neutral text and surfaces while the accent stays on the outline', () => {
  assert.match(settingsCss, /#app \.settings-workspace \.settings-category-button\.is-active\s*\{[^}]*color:\s*var\(--text-secondary\)[^}]*border-color:\s*var\(--accent\)[^}]*background:\s*var\(--settings-elevated\)/s);
  assert.match(settingsCss, /#app \.settings-workspace \.settings-choice-options label:has\(input:checked\)\s*\{[^}]*color:\s*var\(--text-secondary\)[^}]*background:\s*var\(--settings-elevated\)[^}]*box-shadow:\s*inset 0 0 0 1px var\(--accent\)/s);
  assert.match(componentCss, /#app \.dm-host\.dm-host \.dm-category-menu\s*\{[^}]*width:\s*min\(13rem,\s*calc\(100vw - 2rem\)\)/s);
  assert.match(componentCss, /#app \.dm-host\.dm-host \.dm-category-menu > \.motion-inner > button\.is-active\s*\{[^}]*color:\s*var\(--dm-text\)[^}]*border-color:\s*var\(--dm-accent\)[^}]*background:\s*var\(--dm-surface\)/s);
  assert.match(componentCss, /#app \.dm-host\.dm-host \.dm-news-filters button\.is-active\s*\{[^}]*color:\s*var\(--dm-text\)[^}]*border-color:\s*var\(--dm-accent\)[^}]*background:\s*var\(--dm-surface\)/s);
});

test('multimedia preparation uses the provided fixed-art icons with accent-only overlays', () => {
  assert.match(subwindowJs, /class="header-icon\$\{isPlaylist \? '' : ' media-art-icon'\}" data-role="header-icon">\$\{isPlaylist \? playlistPrepLogo\(24\) : mediaReferenceIcon\('download'\)\}/);
  assert.match(subwindowJs, /data-role="panel-icon-format"[^>]*>\$\{mediaReferenceIcon\('format'\)\}/);
  assert.match(subwindowJs, /data-role="panel-icon-destination"[^>]*>\$\{mediaReferenceIcon\('destination'\)\}/);
  assert.match(subwindowCss, /\.media-reference-art::after\s*\{[^}]*background:\s*var\(--sp-accent\)[^}]*mask:\s*var\(--media-art-accent-mask\)/s);
  assert.match(subwindowCss, /\.media-reference-art\[data-media-art="download"\][\s\S]*?multimedia-download-base\.webp/);
  assert.match(subwindowCss, /\.media-reference-art\[data-media-art="format"\][\s\S]*?multimedia-format-base\.webp/);
  assert.match(subwindowCss, /\.media-reference-art\[data-media-art="destination"\][\s\S]*?multimedia-destination-base\.webp/);
});

test('Components page avoids repeating its explanation inside the management card', () => {
  setSettingsCategory('components');
  const html = settingsMarkup();
  assert.match(html, /Complementos/);
  assert.match(html, /MediaTools/);
  assert.match(html, /Torrent Engine/);
  assert.doesNotMatch(html, /settings-section-note/);
  configureSettings(settingsContext);
});

test('Updates and diagnostics follows the reference table while preserving live controls', () => {
  configureSettings({
    ...settingsContext,
    getAppState: () => ({
      settingsCategory: 'updates',
      appearance: { theme: 'dark', accent: '#2196e8', autoScale: false, scale: 100 },
      runtimeStatus: { version: '0.95.4', aria2_available: true, aria2_version: '1.37.0' },
      mediaRuntimeStatus: { yt_dlp: true, yt_dlp_version: '2026.08.19', ffmpeg: false, ffprobe: false },
      updaterStatus: { configured: true, enabled: true },
      availableUpdate: null,
      updaterMessage: 'Estás usando la versión más reciente.',
      experienceSettings: { lastUpdateCheckAt: 1780000000000 }
    }),
    visualDiagnosticsSnapshot: () => ({ resolvedScale: 100, effectiveFontSize: '16px', fontFamily: 'Segoe UI' })
  });
  const html = settingsMarkup();
  assert.match(html, /Actualizaciones y diagnóstico/);
  assert.match(html, /settings-runtime-table/);
  assert.match(html, /<th[^>]*>Nombre<\/th>[\s\S]*<th[^>]*>Versión<\/th>[\s\S]*<th[^>]*>Estado<\/th>/);
  assert.match(html, /Clear Download Manager[\s\S]*0\.95\.4[\s\S]*Actualizado/);
  assert.match(html, /yt-dlp[\s\S]*2026\.08\.19[\s\S]*Instalado/);
  assert.match(html, /FFmpeg[\s\S]*No detectado/);
  const runtimeTable = html.match(/<table class="settings-runtime-table">[\s\S]*?<\/table>/)?.[0] || '';
  assert.doesNotMatch(runtimeTable, /<svg/);
  for (const repo of ['yt-dlp', 'ffmpeg', 'deno', 'aria2']) assert.match(html, new RegExp(`data-settings-tool-repo="${repo}"`));
  assert.match(html, /settings-open-source/);
  assert.doesNotMatch(html, /id="scale-(?:decrease|number|increase|range)"|id="auto-scale-toggle"/);
  assert.match(html, /copy-visual-diagnostics/);
  const copyAction = html.match(/class="copy-visual-diagnostics"[^>]*>[\s\S]*?<\/button>/)?.[0] || '';
  assert.doesNotMatch(copyAction, /<svg/);
  assert.equal(translate('en', 'Aplicación y herramientas'), 'Application and tools');
  assert.equal(translate('en', 'No detectado'), 'Not detected');
  assert.equal(translate('en', 'Actualizado'), 'Up to date');
  configureSettings(settingsContext);
});

test('Updates status never claims current without a completed check and reflects an available update', () => {
  configureSettings({
    ...settingsContext,
    getAppState: () => ({
      settingsCategory: 'updates',
      appearance: { theme: 'light', accent: '#2196e8', autoScale: true, scale: 100 },
      runtimeStatus: { version: '0.95.4' },
      mediaRuntimeStatus: {},
      availableUpdate: { version: '0.95.5' },
      experienceSettings: {}
    }),
    visualDiagnosticsSnapshot: () => ({ resolvedScale: 110, effectiveFontSize: '18px', fontFamily: 'Segoe UI' })
  });
  const html = settingsMarkup();
  assert.match(html, /Actualización disponible/);
  assert.doesNotMatch(html, /id="auto-scale-toggle"|id="scale-range"|18px/);
  assert.doesNotMatch(html, /Clear Download Manager[\s\S]*?Actualizado/);
  configureSettings(settingsContext);
});

test('Download toolbar groups creation actions and exposes sort, all, select and inspector controls', async () => {
  const { downloadToolbarMarkup } = await import('../../app-ui/download-manager/view/zen-sidebar.js');
  assert.equal(typeof downloadToolbarMarkup, 'function');
  const html = downloadToolbarMarkup({
    jobs: [],
    preferences: { category: 'all', sortOrder: 'newest' },
    selectionMode: false,
    selectedJobIds: new Set(),
    addMenuOpen: false,
    categoryMenuOpen: false,
    translate: (_key, fallback) => fallback
  });
  assert.match(html, /data-dm-add-menu-toggle/);
  assert.match(html, /data-dm-add-menu[\s\S]*data-dm-paste-link/);
  assert.match(html, /data-dm-add-torrent/);
  assert.match(html, /data-dm-new-download/);
  assert.match(html, /data-dm-focus-unified/);
  assert.match(html, /data-dm-category-toggle[\s\S]*Todas/);
  assert.match(html, /data-dm-selection-toggle[\s\S]*Seleccionar/);
  assert.match(componentCss, /width: min\(13rem, calc\(100vw - 2rem\)\)/);
  assert.match(componentCss, /dm-add-dropdown \.dm-helper-chips button\s*\{[^}]*grid-template-columns:\s*1\.55rem minmax\(0, 1fr\)/s);
  assert.match(componentCss, /dm-add-dropdown \.dm-helper-chips button > \.dm-playlist-logo/);
  assert.match(html, /data-dm-sort-select/);
  assert.match(html, /data-dm-toggle="inspector"/);
  const dividerAt = html.indexOf('dm-toolbar-divider');
  const categoryAt = html.indexOf('data-dm-category-toggle');
  const selectionAt = html.indexOf('data-dm-selection-toggle');
  const sortAt = html.indexOf('data-dm-sort-select');
  assert.ok(categoryAt < dividerAt && dividerAt < selectionAt && selectionAt < sortAt);
  const selectedHtml = downloadToolbarMarkup({
    jobs: [], preferences: { category: 'all', sortOrder: 'newest' }, selectionMode: true,
    selectedJobIds: new Set(), addMenuOpen: false, categoryMenuOpen: false,
    translate: (_key, fallback) => fallback
  });
  const exit = selectedHtml.match(/<button[^>]*data-dm-selection-toggle[^>]*>[\s\S]*?<\/button>/)?.[0] || '';
  assert.match(exit, /aria-label="Salir de selección"/);
  assert.match(exit, /data-icon="x"/);
  const allSelectedHtml = downloadToolbarMarkup({
    jobs: [], visible: [{ id: 1 }], preferences: { category: 'all', sortOrder: 'newest' },
    selectionMode: true, selectedJobIds: new Set([1]), addMenuOpen: false, categoryMenuOpen: false,
    translate: (_key, fallback) => fallback
  });
  assert.match(allSelectedHtml, /data-dm-select-all-visible[^>]*aria-label="Quitar selección visible"[^>]*><svg[^>]*data-icon="x"[\s\S]*?<span>Ninguna<\/span>/);
  assert.match(componentCss, /data-dm-select-all-visible[^}]*min-width:/s);
  assert.match(componentCss, /\.dm-selection-tools select\s*\{[^}]*width:\s*8\.5rem/s);
  assert.match(componentCss, /\.dm-sort-control \{[^}]*width:\s*7rem/s);
  assert.doesNotMatch(legacyToolbarCss, /\.dm-zen-secondary-row:has\(\.dm-selection-tools\)\s*\{[^}]*flex-wrap:\s*nowrap/s);
  assert.doesNotMatch(legacyToolbarCss, /\.dm-zen-secondary-row:has\(\.dm-selection-tools\)[\s\S]{0,900}overflow-x:\s*auto/s);
  assert.equal(translate('en', 'Mayor a menor'), 'Largest first');
  const englishSelectedHtml = downloadToolbarMarkup({
    jobs: [], preferences: { category: 'all', sortOrder: 'size' }, selectionMode: true,
    selectedJobIds: new Set(), addMenuOpen: false, categoryMenuOpen: false,
    translate: (key) => translate('en', key)
  });
  assert.match(englishSelectedHtml, /data-dm-select-all-visible[^>]*aria-label="Select all visible downloads"/);
  assert.match(englishSelectedHtml, /data-dm-select-all-visible[^>]*><svg[^>]*data-icon="check"[\s\S]*?<\/svg><span>Visible<\/span>/);
  const englishAllSelectedHtml = downloadToolbarMarkup({
    jobs: [], visible: [{ id: 1 }], preferences: { category: 'all', sortOrder: 'newest' },
    selectionMode: true, selectedJobIds: new Set([1]), addMenuOpen: false, categoryMenuOpen: false,
    translate: (key) => translate('en', key)
  });
  assert.match(englishAllSelectedHtml, /data-dm-select-all-visible[^>]*aria-label="Clear visible selection"[^>]*><svg[^>]*data-icon="x"[\s\S]*?<span>None<\/span>/);
  assert.match(englishSelectedHtml, /Priority/);
  assert.match(englishSelectedHtml, /Delete/);
  assert.match(englishSelectedHtml, /Size ↓/);
  assert.match(componentCss, /min-width:\s*981px/);
  assert.match(componentCss, /5\.7rem 19rem minmax\(19rem,\s*1fr\) 3\.4rem 5rem 3\.2rem/);
  assert.match(componentCss, /dm-progress-wrap\s*\{[^}]*max-width:\s*none !important;[^}]*margin-left:\s*0 !important/s);
  assert.equal(translate('en', 'Ninguna'), 'None');
  assert.match(englishSelectedHtml, /aria-label="Change selected priority"/);
  assert.match(html, /dm-toolbar-divider/);
  assert.match(componentCss, /dm-zen-head-actions \.dm-compact-stats[\s\S]{0,240}grid-template-columns: repeat\(3, minmax\(0, 1fr\)\)/);
  assert.match(componentCss, /\.dm-zen-secondary-row \.dm-add-menu-toggle[\s\S]{0,1500}min-height: 2\.5rem !important/);
});

test('supplied two-tone image icons replace the Settings rail and download-entry glyphs', async () => {
  const { downloadToolbarMarkup } = await import('../../app-ui/download-manager/view/zen-sidebar.js');
  const iconAssets = new URL('../../app-ui/assets/icons/', import.meta.url);
  const { access, readFile: readAsset } = await import('node:fs/promises');
  const names = ['general','downloads','multimedia','appearance','integrations','updates','components','paste','torrent','link'];
  for (const name of names) {
    const folder = ['paste','torrent','link'].includes(name) ? 'download-actions/' : 'settings/';
    for (const tone of ['white','accent']) {
      const file = new URL(`${folder}${name}-${tone}.webp`, iconAssets);
      await access(file);
      const webp = await readAsset(file);
      assert.equal(webp.toString('ascii', 0, 4), 'RIFF');
      assert.equal(webp.toString('ascii', 8, 12), 'WEBP');
    }
  }
  const settings = settingsMarkup();
  assert.match(settings, /data-settings-icon="general"/);
  assert.match(settingsCss, /\.settings-nav-icon::after[^}]*background(?:-color)?:\s*var\(--ui-icon-accent-detail/);
  const addMenu = downloadToolbarMarkup({
    jobs: [], preferences: {}, selectionMode: false, selectedJobIds: new Set(),
    addMenuOpen: true, categoryMenuOpen: false, translate: (_key, fallback) => fallback
  });
  assert.match(addMenu, /data-dm-new-icon="link"/);
  assert.match(addMenu, /data-dm-new-icon="torrent"/);
  assert.match(addMenu, /data-dm-new-icon="paste"/);
  assert.match(addMenu, /dm-playlist-logo/);
});

test('Download ordering is stable, selectable and persisted as a valid preference', async () => {
  const { sortDownloadJobs } = await import('../../app-ui/download-manager/core/model.js');
  const jobs = [
    { id: 1, addedOrder: 1, title: 'Beta', status: 'completed', finalSize: 5 },
    { id: 2, addedOrder: 2, title: 'Alpha', status: 'running', totalBytes: 20 },
    { id: 3, addedOrder: 3, title: 'Gamma', status: 'completed', finalSize: 50 }
  ];
  assert.equal(typeof sortDownloadJobs, 'function');
  assert.deepEqual(sortDownloadJobs(jobs, 'newest').map((job) => job.id), [3, 2, 1]);
  assert.deepEqual(sortDownloadJobs(jobs, 'oldest').map((job) => job.id), [1, 2, 3]);
  assert.deepEqual(sortDownloadJobs(jobs, 'name').map((job) => job.id), [2, 1, 3]);
  assert.deepEqual(sortDownloadJobs(jobs, 'size').map((job) => job.id), [3, 2, 1]);
  assert.deepEqual(jobsForSection(jobs, normalizePreferences({ sortOrder: 'name' })).map((job) => job.id), [2, 1, 3]);
  assert.equal(normalizePreferences({ sortOrder: 'not-a-sort' }).sortOrder, 'newest');
});

test('Completion dates use localized Today/Yesterday labels and abbreviated older dates', async () => {
  const { completionDateParts } = await import('../../app-ui/download-manager/core/model.js');
  const now = new Date(2026, 8, 28, 12, 0, 0);
  assert.equal(typeof completionDateParts, 'function');
  assert.equal(completionDateParts(new Date(2026, 8, 28, 1, 19).getTime(), 'es', now).dateLabel, 'Hoy');
  assert.equal(completionDateParts(new Date(2026, 8, 27, 17, 6).getTime(), 'es', now).dateLabel, 'Ayer');
  assert.equal(completionDateParts(new Date(2026, 8, 28, 1, 19).getTime(), 'en', now).dateLabel, 'Today');
  assert.equal(completionDateParts(new Date(2026, 8, 27, 17, 6).getTime(), 'en', now).dateLabel, 'Yesterday');
  assert.equal(completionDateParts(new Date(2026, 8, 18, 12, 0).getTime(), 'es', now).dateLabel, '18 Sept');
  assert.equal(completionDateParts(new Date(2026, 8, 18, 12, 0).getTime(), 'en', now).dateLabel, 'Sep 18');
});

test('Active rows keep stacked transfer amounts; completed rows put date by status and keep a folder action', () => {
  const active = downloadRowState({ status: 'running', stage: 'Descargando', downloadedBytes: 8_000_000, totalBytes: 258_998_272, speedBps: 1_000_000 }, 'es');
  assert.equal(active.transferPrimary.endsWith('/'), true);
  assert.equal(active.transferSecondary, '247 MB');
  const completed = downloadRowState({ status: 'completed', finalSize: 34_603_008, completedAtMs: new Date(2026, 8, 28, 1, 19).getTime() }, 'es', new Date(2026, 8, 28, 12, 0));
  assert.equal(completed.transferPrimary, '33.0 MB');
  assert.equal(completed.transferSecondary, '');
  assert.equal(completed.completedDate.dateLabel, 'Hoy');
  assert.match(completed.completedDate.timeLabel, /\d/);
  assert.match(componentCss, /dm-item-progress \.dm-progress-wrap[\s\S]{0,300}max-width:\s*none !important;[\s\S]{0,100}margin-left:\s*0 !important/);
  const completedMarkup = downloadRowMarkup({
    id: 9,
    status: 'completed',
    title: 'Finished file.pdf',
    kind: 'file',
    category: 'Documentos',
    origin: 'HTTP',
    extension: 'pdf',
    progress: 100,
    finalSize: 34_603_008,
    destination: 'C:\\Downloads\\Finished file.pdf',
    completedAtMs: new Date(2026, 8, 28, 1, 19).getTime(),
    updatedAt: '2026-09-28 01:19:00'
  }, 0, null, null, null, null, false, new Set(), 'es');
  assert.match(completedMarkup, /class="dm-item-date"[^>]*>Ayer<\/span>/);
  assert.doesNotMatch(completedMarkup, /class="dm-completion-date"|dm-transfer-divider/);
  assert.match(completedMarkup, /class="dm-item-actions"[\s\S]*data-dm-job-action="reveal"/);
  assert.doesNotMatch(completedMarkup, /data-dm-row-menu/);
  assert.doesNotMatch(completedMarkup, /class="dm-row-select"/);
  assert.match(downloadEventsJs, /addEventListener\('contextmenu'/);
  assert.match(downloadEventsJs, /event\.key === 'ContextMenu' \|\| \(event\.shiftKey && event\.key === 'F10'\)/);
  const pausedMarkup = downloadRowMarkup({
    id: 10,
    status: 'paused',
    title: 'Paused download.zip',
    kind: 'file',
    category: 'Archivos',
    origin: 'HTTP',
    extension: 'zip',
    downloadedBytes: 10,
    totalBytes: 100
  }, 0, null, null, null, null, false, new Set(), 'es');
  assert.match(pausedMarkup, /data-dm-job-action="resume"/);
  assert.doesNotMatch(pausedMarkup, /data-dm-row-menu/);
});

test('download titles stop at 25 visible characters plus three dots while full titles remain available', () => {
  assert.equal(truncateDownloadTitle('1234567890123456789012345'), '1234567890123456789012345');
  assert.equal(truncateDownloadTitle('12345678901234567890123456'), '1234567890123456789012345...');
  assert.equal(Array.from(truncateDownloadTitle('á'.repeat(40))).length, 28);
  const title = '12345678901234567890123456-tail.mp4';
  const markup = downloadRowMarkup({
    id: 88, status: 'completed', title, kind: 'file', category: 'Archivos', origin: 'HTTP',
    extension: 'mp4', progress: 100, finalSize: 100, destination: 'C:\\Downloads\\video.mp4'
  }, 0, null, null, null, null, false, new Set(), 'es');
  assert.match(markup, /<strong title="12345678901234567890123456-tail\.mp4">1234567890123456789012345\.\.\.<\/strong>/);
});

test('active and completed rows share the progress and action columns, including missing destinations', () => {
  const makeRow = (status, destination = '') => downloadRowMarkup({
    id: 89, status, title: 'Video de prueba', kind: 'file', category: 'Vídeo', origin: 'HTTP',
    extension: 'mp4', progress: status === 'completed' ? 100 : 57, downloadedBytes: 57,
    totalBytes: 100, finalSize: status === 'completed' ? 100 : undefined, destination
  }, 0, null, null, null, null, false, new Set(), 'es');
  const active = makeRow('running', 'C:\\Downloads\\active.mp4');
  const completed = makeRow('completed', 'C:\\Downloads\\done.mp4');
  const completedWithoutPath = makeRow('completed');
  for (const markup of [active, completed, completedWithoutPath]) {
    assert.match(markup, /class="dm-item-actions"/);
  }
  assert.match(componentCss, /grid-template-columns:\s*5\.7rem 19rem minmax\(19rem, 1fr\) 3\.4rem 5rem 3\.2rem/);
  assert.match(componentCss, /dm-item-progress \.dm-progress\s*\{\s*height:\s*12px/);
  assert.match(active, /data-dm-job-action="pause"/);
  assert.match(completed, /data-dm-job-action="reveal"/);
  assert.match(completedWithoutPath, /data-dm-open-download-directory/);
  assert.doesNotMatch(componentCss, /\.is-completed \.dm-item-actions\s*\{[^}]*display:\s*none/s);
  assert.doesNotMatch(componentCss, /\.dm-item-progress \.dm-progress-wrap\s*\{[^}]*max-width:\s*12rem/s);
});

test('completed size is separate from its date and the progress track grows to the right', () => {
  assert.match(componentCss, /\.dm-item-transfer\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\)\s*!important;/s);
  assert.match(componentCss, /\.dm-item-progress \.dm-progress-wrap\s*\{[^}]*max-width:\s*none !important;[^}]*margin-left:\s*0 !important;/s);
});

test('desktop action controls fit their own grid column instead of overlapping file sizes', () => {
  assert.match(componentCss, /grid-template-areas:\s*"visual body progress percent transfer actions"/);
  assert.match(componentCss, /\.dm-host\.dm-host \.dm-item-actions\s*\{[^}]*width:\s*3\.2rem !important;[^}]*min-width:\s*0 !important;/s);
});

test('Main row geometry reserves a little more breathing room around the transfer size', () => {
  assert.match(componentCss, /#app \.dm-host\.dm-host\.dm-host \.dm-download-item\s*\{[^}]*grid-template-areas:\s*"visual body progress percent transfer actions" !important;/s);
  assert.match(componentCss, /#app \.dm-host\.dm-host\.dm-host \.dm-item-actions\s*\{[^}]*min-width:\s*0 !important;/s);
  const wideGridOwners = [...componentCss.matchAll(/@container download-center \(min-width: 981px\) \{([\s\S]*?)\n\}/g)];
  const wideGridOwner = wideGridOwners.at(-1)?.[1] || '';
  assert.match(wideGridOwner, /5\.7rem minmax\(11\.5rem, 1\.6fr\) minmax\(10\.5rem, 1\.4fr\) 2\.8rem 5\.6rem 3\.2rem/);
  assert.match(wideGridOwner, /column-gap:\s*\.52rem !important/);
  assert.doesNotMatch(wideGridOwner, /19rem/);
});

test('selection toolbar keeps its controls on one line at the reference width and pushes details right', () => {
  assert.match(componentCss, /#app \.dm-host\.dm-host\.dm-host \.dm-zen-secondary-row\s*\{[^}]*box-sizing:\s*border-box !important;[^}]*width:\s*100% !important;[^}]*max-width:\s*100% !important;/s);
  assert.match(componentCss, /@media \(min-width: 1100px\) and \(max-width: 1180px\)\s*\{[\s\S]*?\.dm-zen-secondary-row\s*\{[^}]*flex-wrap:\s*nowrap !important/s);
  assert.match(componentCss, /@media \(min-width: 1100px\) and \(max-width: 1180px\)[\s\S]*?\.dm-selection-tools\s*\{[^}]*flex-wrap:\s*nowrap !important/s);
  assert.match(componentCss, /@media \(min-width: 1100px\) and \(max-width: 1180px\)[\s\S]*?\.dm-details-toggle\s*\{[^}]*margin-left:\s*auto !important/s);
  assert.match(componentCss, /@media \(min-width: 821px\) and \(max-width: 1099px\)[\s\S]*?\.dm-zen-secondary-row:has\(\.dm-selection-tools\) > \.dm-toolbar-divider\s*\{[^}]*flex:\s*0 0 100% !important/s);
});

test('bulk select label stays short and localized after selecting a row', () => {
  assert.match(downloadEventsJs, /function patchSelectionControls\(root, jobs, context = \{\}\)/);
  assert.match(downloadEventsJs, /translate\('Visibles', 'Visibles'\)/);
  assert.match(downloadEventsJs, /translate\('Ninguna', 'Ninguna'\)/);
  assert.match(downloadEventsJs, /setAttribute\('aria-label', actionLabel\)/);
  assert.doesNotMatch(downloadEventsJs, /label\.textContent = allSelected \? 'Ninguna' : 'Todas'/);
});

test('two-tone icons share theme-aware neutral and readable accent colors', () => {
  assert.match(settingsCss, /\.settings-nav-icon::before[\s\S]*?background-color:\s*var\(--ui-icon-neutral/);
  assert.match(componentCss, /\.dm-entry-icon::before,[\s\S]*?background-color:\s*var\(--dm-icon-neutral/);
  assert.match(settingsCss, /\.settings-nav-icon::after\s*\{[^}]*background-color:\s*var\(--ui-icon-accent-detail/);
  assert.match(componentCss, /\.dm-entry-icon::after\s*\{\s*background-color:\s*var\(--dm-icon-accent-detail/);
  assert.match(appearanceJs, /setProperty\('--ui-icon-neutral',\s*'var\(--text-secondary\)'\)/);
  assert.match(appearanceJs, /setProperty\('--ui-icon-accent-detail',\s*iconAccentVisual\.detail\)/);
  assert.match(downloadManagerJs, /setProperty\('--dm-icon-neutral',\s*'var\(--dm-muted\)'\)/);
  assert.match(downloadManagerJs, /setProperty\('--dm-icon-accent-detail',\s*dmReadableAccent\(iconAccent,\s*theme\)\)/);
});

test('download rows use a shared, balanced type scale and a legible progress track', () => {
  assert.match(componentCss, /--dm-row-title-size:\s*1\.13rem/);
  assert.match(componentCss, /--dm-row-meta-size:\s*\.86rem/);
  assert.match(componentCss, /--dm-row-value-size:\s*\.98rem/);
  assert.match(componentCss, /\.dm-download-item \.dm-item-name\s*>\s*strong\s*\{[^}]*font-size:\s*calc\(var\(--dm-row-title-size\)/s);
  assert.match(componentCss, /\.dm-download-item \.dm-item-type,[\s\S]*?\.dm-item-status\s*\{[^}]*font-size:\s*calc\(var\(--dm-row-meta-size\)/);
  assert.match(componentCss, /\.dm-item-percentage,[\s\S]*?font-size:\s*calc\(var\(--dm-row-value-size\)/s);
  assert.match(componentCss, /\.dm-download-item \.dm-item-progress \.dm-progress-wrap\s*\{[^}]*width:\s*calc\(100% - \.9rem\)/s);
});

test('live state transitions replace the label atomically and relocalize the patched row', () => {
  assert.match(liveJs, /currentText\.textContent\s*=\s*nextText\.textContent/);
  assert.doesNotMatch(liveJs, /status-lane-(?:exit|enter)/);
  assert.match(liveJs, /localizeDom\(patchedArea/);
});

test('news actions are compact text controls beside the filters and support opens the project site', () => {
  const html = newsPanel({ newsMessages: [], translate: (_key, fallback) => fallback });
  const filters = html.match(/<nav class="dm-news-filters"[\s\S]*?<\/nav>/)?.[0] || '';
  const actions = filters.match(/<div class="dm-news-header-actions">[\s\S]*?<\/div>/)?.[0] || '';
  assert.match(filters, /data-dm-news-filter="history"[\s\S]*dm-news-header-actions/);
  assert.match(actions, /Buscar actualizaciones/);
  assert.match(actions, /Comentarios y sugerencias/);
  assert.doesNotMatch(actions, /<svg/);
  assert.match(newsJs, /dm-news-header-actions[\s\S]*dm-news-filters/);
  assert.match(mainJs, /onSupport:\s*\(\)\s*=>\s*\{[^}]*https:\/\/cdm\.cacaplay\.lat/s);
});

test('available updates are checked on startup and periodically, notify through the existing command, and pulse Novedades', () => {
  assert.match(mainJs, /APP_UPDATE_CHECK_INTERVAL_MS\s*=\s*30\s*\*\s*60\s*\*\s*1000/);
  assert.match(mainJs, /function startAutomaticAppUpdateChecks\(\)/);
  assert.match(mainJs, /startupPromise\.then\(\(\)\s*=>\s*\{[\s\S]{0,500}startAutomaticAppUpdateChecks\(\)/);
  assert.match(mainJs, /notify_app_update/);
  assert.match(mainJs, /newsUpdateAvailable:\s*Boolean\(appState\.availableUpdate\?\.version\)/);
  assert.match(sidebarJs, /has-app-update/);
  assert.match(componentCss, /dm-news-attention-pulse/);
  assert.match(componentCss, /prefers-reduced-motion:\s*reduce/);
});
