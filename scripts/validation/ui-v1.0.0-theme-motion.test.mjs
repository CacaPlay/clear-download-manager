import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const appearancePath = path.join(root, 'app-ui/modules/appearance/index.js');
const settingsCssPath = path.join(root, 'app-ui/modules/settings/styles.css');
const dmCssPath = path.join(root, 'app-ui/download-manager/styles/03-components.css');
const mainPath = path.join(root, 'app-ui/main.js');

function mustMatch(source, pattern, message) { assert.ok(pattern.test(source), message); }

test('cyan and green are the first two fixed accent presets', async () => {
  const source = await readFile(appearancePath, 'utf8');
  const block = source.match(/export const appearancePresets = \[([\s\S]*?)\n\];/)?.[1] || '';
  const presets = [...block.matchAll(/\{ id: '([^']+)', name: '([^']+)', accent: '(#[0-9a-f]{6})'/gi)];
  assert.equal(presets[0]?.[3].toLowerCase(), '#24b8e8');
  assert.equal(presets[1]?.[3].toLowerCase(), '#04d25a');
});

test('selected settings and download filters stay on neutral surfaces', async () => {
  const [settingsCss, dmCss] = await Promise.all([readFile(settingsCssPath, 'utf8'), readFile(dmCssPath, 'utf8')]);
  mustMatch(settingsCss, /settings-category-button\.is-active[\s\S]{0,250}background:\s*var\(--settings-elevated\)/, 'settings selection must use a neutral surface');
  mustMatch(settingsCss, /settings-category-button\.is-active[\s\S]{0,250}color:\s*var\(--text-secondary\)/, 'settings navigation labels must remain neutral');
  mustMatch(dmCss, /\.dm-zen-nav nav button\.is-active,[\s\S]{0,180}background:\s*transparent\s*!important/, 'selected main navigation must not fill with the accent');
  mustMatch(dmCss, /#app \.dm-host\.dm-host \.dm-news-filters button\.is-active,[\s\S]{0,500}background: var\(--dm-surface-2\) !important/, 'selected News filters must use a neutral surface');
});

test('theme state is committed before a cancellable reveal and reduced motion skips it', async () => {
  const main = await readFile(mainPath, 'utf8');
  const body = main.match(/function applyThemeWithMotion\([\s\S]*?\n\}/)?.[0] || '';
  assert.ok(body, 'theme transition function must exist');
  const transitionAt = body.indexOf('document.startViewTransition(() => {');
  const commitAt = body.indexOf('applyAppAppearance(value, options);', transitionAt);
  assert.ok(transitionAt >= 0, 'theme reveal must use a single captured transition');
  assert.ok(commitAt > transitionAt, 'all synchronized appearance state must commit inside the transition callback');
  mustMatch(body, /motionMode|prefers-reduced-motion|reducedMotion/, 'reduced motion must bypass the reveal');
  mustMatch(body, /skipTransition|themeTransitionToken/, 'stale theme transitions must not win after rapid toggles');
});
