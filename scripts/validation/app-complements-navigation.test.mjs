import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { renderZenSidebar } from '../../app-ui/download-manager/view/zen-sidebar.js';
import { configureSettings, settingsMarkup } from '../../app-ui/modules/settings/index.js';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function configureSettingsFor(category) {
  configureSettings({
    getAppState: () => ({ settingsCategory: category, components: [] }),
    icon: () => '<svg aria-hidden="true"></svg>',
    escapeHtml: value => String(value ?? ''),
    translate: value => value
  });
}

test('primary download navigation keeps Downloads and routes Complementos without duplicate status sections', () => {
  const markup = renderZenSidebar({
    jobs: [],
    preferences: { section: 'downloads', sidebarCollapsed: true, inspectorCollapsed: true, compactRows: false, filter: 'all', category: 'all', query: '' },
    experienceSettings: { extensionPromptDecision: 'declined' },
    translate: (_key, fallback) => fallback
  });
  const nav = markup.match(/<nav aria-label="Navegación principal">([\s\S]*?)<\/nav>/)?.[1] || '';

  assert.match(nav, /Descargas/);
  assert.match(nav, />Complementos</);
  assert.match(nav, /data-dm-open-complements/);
  assert.doesNotMatch(nav, /Cola|Activas|Completadas/);
});

test('Complementos is a dedicated settings category containing manual component management', () => {
  configureSettingsFor('components');
  const markup = settingsMarkup();

  assert.match(markup, /data-settings-category="components"[^>]*aria-label="Complementos"/);
  assert.match(markup, /class="settings-page settings-page-components"/);
  assert.match(markup, /MediaTools/);
  assert.match(markup, /Torrent Engine/);
  assert.match(markup, /data-component-action="install"/);
});

test('component catalog refresh button is in the page intro header and wraps on narrow windows', async () => {
  configureSettingsFor('components');
  const markup = settingsMarkup();
  const intro = markup.match(/<header class="settings-page-intro">([\s\S]*?)<\/header>/)?.[1] || '';
  const componentSection = markup.match(/<section class="settings-section settings-section-components">([\s\S]*?)<\/section>/)?.[1] || '';
  const css = await readFile(path.join(repositoryRoot, 'app-ui/modules/settings/styles.css'), 'utf8');

  assert.match(intro, /class="settings-page-intro-actions"[\s\S]*data-component-catalog-check/);
  assert.doesNotMatch(componentSection, /data-component-catalog-check/);
  assert.match(css, /\.settings-page-intro\s*\{[^}]*justify-content:\s*space-between/s);
  assert.match(css, /@media\s*\(max-width:\s*760px\)\s*\{[^}]*\.settings-page-intro\s*\{[^}]*flex-wrap:\s*wrap/s);
});

test('component manager is no longer duplicated inside updates and diagnostics', () => {
  const previousWindow = globalThis.window;
  globalThis.window = { __cdmVisualDiagnostics: {} };
  configureSettingsFor('updates');
  try {
    const markup = settingsMarkup();
    assert.doesNotMatch(markup, /data-component-action="install"/);
    assert.doesNotMatch(markup, /settings-section-components/);
  } finally {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  }
});

test('component rows are passive and progress remains a noninteractive indicator', async () => {
  configureSettingsFor('components');
  const markup = settingsMarkup();
  const css = await readFile(path.join(repositoryRoot, 'app-ui/modules/settings/styles.css'), 'utf8');
  const rule = css.match(/\.settings-component-progress\s*\{([^}]+)\}/)?.[1] || '';

  assert.match(markup, /class="settings-component-row" data-component-row="media-tools"/);
  assert.doesNotMatch(markup, /data-component-row="(?:media-tools|torrent-engine)" tabindex=/);
  assert.doesNotMatch(css, /\.settings-component-row:focus\s*\{/);
  assert.match(rule, /cursor\s*:\s*default\s*;/);
  assert.match(rule, /pointer-events\s*:\s*none\s*;/);
});

test('component progress phases patch mounted values and controls without replacing nodes', async () => {
  const { patchComponentDownloadProgress } = await import('../../app-ui/modules/settings/index.js');
  configureSettingsFor('components');
  const progress = { value: 0, hidden: false, removeAttribute() {} };
  const metrics = { textContent: '0 MB / 0 MB', hidden: false };
  const status = { dataset: { statusTone: 'info' } };
  const phaseLabel = { textContent: 'Preparando descarga' };
  const error = { textContent: '', hidden: true };
  const cancelButton = { label: 'Cancelar', hidden: true, identity: Symbol('cancel') };
  const installButton = { label: 'Descargar e instalar', hidden: false, identity: Symbol('install') };
  const verifyButton = { label: 'Verificar', hidden: true, identity: Symbol('verify') };
  const removeButton = { label: 'Quitar', hidden: true, disabled: false, identity: Symbol('remove') };
  const row = {
    querySelector(selector) {
      if (selector === '[data-component-progress="media-tools"]') return progress;
      if (selector === '[data-component-metrics="media-tools"]') return metrics;
      if (selector === '[data-component-status="media-tools"]') return status;
      if (selector === '[data-component-phase="media-tools"]') return phaseLabel;
      if (selector === '[data-component-action="cancel"]') return cancelButton;
      if (selector === '[data-component-action="install"]') return installButton;
      if (selector === '[data-component-action="verify"]') return verifyButton;
      if (selector === '[data-component-action="remove"]') return removeButton;
      if (selector === '[data-component-error="media-tools"]') return error;
      return null;
    }
  };
  const root = { querySelector: selector => selector === '[data-component-row="media-tools"]' ? row : null };
  const identities = [cancelButton, installButton, verifyButton, removeButton].map(button => button.identity);

  assert.equal(patchComponentDownloadProgress(root, 'media-tools', {
    phase: 'download', progressRatio: 0.39, bytesDownloaded: 34_300_000,
    totalBytes: 88_700_000, bytesPerSecond: 2_400_000
  }), true);
  assert.equal(progress.value, 39);
  assert.equal(progress.hidden, false);
  assert.equal(metrics.hidden, false);
  assert.equal(metrics.textContent, '34.3 MB / 88.7 MB · 39% · 2.4 MB/s');
  assert.equal(phaseLabel.textContent, 'Descargando');
  assert.equal(cancelButton.hidden, false);
  assert.equal(installButton.hidden, true);
  assert.equal(error.hidden, true);
  assert.deepEqual([cancelButton, installButton, verifyButton, removeButton].map(button => button.identity), identities);

  patchComponentDownloadProgress(root, 'media-tools', { phase: 'done', progressRatio: 1 });
  assert.equal(phaseLabel.textContent, 'Instalado');
  assert.equal(status.dataset.statusTone, 'ok');
  assert.equal(progress.hidden, true);
  assert.equal(metrics.hidden, true);
  assert.equal(cancelButton.hidden, true);
  assert.equal(installButton.hidden, true);
  assert.equal(verifyButton.hidden, false);
  assert.equal(removeButton.hidden, false);
  assert.deepEqual([cancelButton, installButton, verifyButton, removeButton].map(button => button.identity), identities);
});

test('optional component dialog uses a solid raised surface and a moderate backdrop', async () => {
  const css = await readFile(path.join(repositoryRoot, 'app-ui/modules/settings/styles.css'), 'utf8');
  const dialog = css.match(/\.optional-component-dialog\s*\{([^}]+)\}/)?.[1] || '';
  const backdrop = css.match(/\.optional-component-dialog::backdrop\s*\{([^}]+)\}/)?.[1] || '';

  assert.match(dialog, /background\s*:\s*var\(--surface-elevated/);
  assert.match(dialog, /border\s*:\s*1px solid var\(--border-subtle/);
  assert.doesNotMatch(dialog, /background\s*:\s*color-mix\([^;]*transparent/i);
  assert.match(backdrop, /background\s*:\s*rgba\(0\s*,\s*0\s*,\s*0\s*,\s*\.5\s*\)/);
  assert.doesNotMatch(backdrop, /\.78/);
});
