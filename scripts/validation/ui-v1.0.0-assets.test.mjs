import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const iconsPath = path.join(root, 'app-ui/download-manager/view/icons.js');
const sidebarPath = path.join(root, 'app-ui/download-manager/view/zen-sidebar.js');
const baseCssPath = path.join(root, 'app-ui/download-manager/styles/01-base.css');
const responsiveCssPath = path.join(root, 'app-ui/download-manager/styles/04-responsive.css');
const cssPath = path.join(root, 'app-ui/download-manager/styles/03-components.css');
const assetRoot = path.join(root, 'app-ui/assets/icons/navigation');

function mustMatch(source, pattern, message) {
  assert.ok(pattern.test(source), message);
}

test('navbar renders the user-supplied icon family through an accessible nav-icon helper', async () => {
  const [icons, sidebar] = await Promise.all([
    readFile(iconsPath, 'utf8'),
    readFile(sidebarPath, 'utf8')
  ]);
  mustMatch(icons, /export function dmNavIcon\(/, 'icons.js must expose dmNavIcon');
  mustMatch(icons, /class="dm-nav-icon"[^>]*data-nav-icon=/, 'the icon wrapper needs its semantic icon key');
  mustMatch(icons, /\.\.\/\.\.\/assets\/icons\/navigation\//, 'mask URLs must resolve from the Download Manager stylesheet directory');
  mustMatch(icons, /aria-hidden="true"/, 'decorative navbar artwork must be hidden from assistive technology');
  mustMatch(icons, /data-nav-accent="true"/, 'two-tone nav icons must mark when their accent layer exists');
  mustMatch(sidebar, /dmNavIcon\(/, 'the sidebar must render the supplied icon family');
  mustMatch(sidebar, /id === activeSection \? ' style="appearance:none!important;background:transparent!important;background-color:transparent!important;background-image:none!important"'/, 'the selected button must not retain the browser default button face');
  for (const name of ['downloads', 'components', 'news', 'settings', 'sun', 'moon']) {
    mustMatch(sidebar, new RegExp(`dmNavIcon\\(['"]${name}['"]\\)`), `sidebar must render ${name}`);
  }
});

test('new navbar masks are lossless WebP files small enough for the shipped UI', async () => {
  const names = [
    'downloads-base.webp', 'downloads-accent.webp',
    'components-base.webp', 'components-accent.webp',
    'news-base.webp', 'settings-base.webp', 'sun-base.webp', 'moon-base.webp'
  ];
  for (const name of names) {
    const file = path.join(assetRoot, name);
    const [bytes, metadata] = await Promise.all([readFile(file), stat(file)]);
    assert.equal(bytes.toString('ascii', 0, 4), 'RIFF', `${name} must be WebP`);
    assert.equal(bytes.toString('ascii', 8, 12), 'WEBP', `${name} must be WebP`);
    assert.ok(metadata.size < 15_000, `${name} should be a compact icon mask`);
  }
});

test('navbar icon masks use the selected accent without tinting their fixed surfaces', async () => {
  const [css, baseCss, responsiveCss, icons] = await Promise.all([
    readFile(cssPath, 'utf8'), readFile(baseCssPath, 'utf8'), readFile(responsiveCssPath, 'utf8'), readFile(iconsPath, 'utf8')
  ]);
  assert.ok(baseCss.includes('nav span:not(.dm-nav-icon)') && responsiveCss.includes('nav span:not(.dm-nav-icon)'), 'collapsed navigation must hide labels without hiding the new icon wrappers');
  mustMatch(css, /nav button > span:not\(\.dm-nav-icon\)/, 'collapsed navigation must hide labels without hiding the new icon wrappers');
  mustMatch(css, /\.dm-nav-icon::before/, 'base icon mask must be rendered');
  mustMatch(css, /\.dm-nav-icon::after/, 'accent icon mask must be rendered separately');
  mustMatch(css, /background-color:\s*var\(--dm-accent/, 'the accent mask should use the selected accent');
  mustMatch(css, /\.dm-host\[data-dm-theme="light"\] \.dm-nav-icon::before\s*\{\s*background-color:\s*var\(--dm-nav-icon-color,\s*#657d93\)/, 'light mode must use the slate neutral instead of near-black icon color');
  mustMatch(css, /mask-image:\s*var\(--dm-nav-accent-mask, none\)/, 'the supplied recolorable area must stay a separate mask');
  mustMatch(css, /\.dm-nav-icon:not\(\[data-nav-accent="true"\]\)::after\s*\{\s*display:\s*none;/, 'single-layer nav icons must not render the accent pseudo-element as a solid square');
  mustMatch(css, /button\.is-active::after\s*\{[\s\S]{0,200}inset:\s*8px[\s\S]{0,180}background:\s*var\(--dm-surface-2\)/, 'selected navigation surface must be inset from the full click target');
  mustMatch(css, /nav button\.is-active\s*\{[^}]*appearance:\s*none\s*!important/, 'the compact active surface must replace the browser default button face');
  mustMatch(css, /button\.is-active::before\s*\{[\s\S]{0,200}height:\s*30px/, 'the selected marker must stay compact');
  for (const name of ['downloads', 'components', 'news', 'settings', 'sun', 'moon']) {
    assert.ok(icons.includes(`${name}: { base: '${name}-base.webp'`), `asset registry must map ${name}`);
  }
});
