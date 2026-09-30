import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const sectionsPath = path.join(root, 'app-ui/download-manager/view/sections.js');
const sidebarPath = path.join(root, 'app-ui/download-manager/view/zen-sidebar.js');
const mainPath = path.join(root, 'app-ui/main.js');
const cssPath = path.join(root, 'app-ui/download-manager/styles/03-components.css');

test('News shows verified component updates as an optional user action', async () => {
  const [sections, sidebar, main, css] = await Promise.all([
    readFile(sectionsPath, 'utf8'), readFile(sidebarPath, 'utf8'), readFile(mainPath, 'utf8'), readFile(cssPath, 'utf8')
  ]);
  assert.ok(sections.includes('context.componentUpdates'));
  assert.ok(sections.includes('data-dm-open-complements'));
  assert.ok(sections.includes('componentUpdateTitle'));
  assert.ok(main.includes("component?.state === 'update-available'"));
  assert.ok(main.includes("invoke('refresh_component_catalog')"));
  assert.ok(main.includes('componentUpdates: verifiedComponentUpdates()'));
  assert.ok(sidebar.includes('context.newsUpdateAvailable'));
  assert.ok(css.includes('.dm-news-component-update'));
  assert.ok(css.includes('prefers-reduced-motion: reduce'));
});

test('component alert is deduplicated as one aggregate card and never installs automatically', async () => {
  const [sections, main] = await Promise.all([readFile(sectionsPath, 'utf8'), readFile(mainPath, 'utf8')]);
  assert.match(sections, /const componentUpdateNotice = componentUpdates\.length/);
  assert.match(sections, /data-dm-open-complements/);
  const scheduler = main.match(/function startComponentCatalogDiscovery\(\) \{[\s\S]*?\n\}/)?.[0] || '';
  assert.ok(scheduler.includes('componentDiscoveryScheduler.start()'));
  assert.ok(!scheduler.includes('install_component_from_catalog'));
});
