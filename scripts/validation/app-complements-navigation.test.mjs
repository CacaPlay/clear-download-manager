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

test('component manager is no longer duplicated inside updates and diagnostics', () => {
  const previousWindow = globalThis.window;
  globalThis.window = { __cacatoolsVisualDiagnostics: {} };
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

test('component progress remains a passive noninteractive indicator', async () => {
  const css = await readFile(path.join(repositoryRoot, 'app-ui/modules/settings/styles.css'), 'utf8');
  const rule = css.match(/\.settings-component-progress\s*\{([^}]+)\}/)?.[1] || '';

  assert.match(rule, /cursor\s*:\s*default\s*;/);
  assert.match(rule, /pointer-events\s*:\s*none\s*;/);
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
