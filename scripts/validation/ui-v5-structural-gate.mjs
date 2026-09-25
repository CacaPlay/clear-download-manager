import fs from 'node:fs';

const failMessages = [];
const fail = (message) => failMessages.push(message);
const read = (file) => fs.readFileSync(file, 'utf8');
const subwindowJs = read('app-ui/subwindow.js');
const subwindowHtml = read('app-ui/subwindow.html');
const subwindowCss = read('app-ui/subwindow.css');
const lucide = read('app-ui/assets/icons/lucide.js');
const build = read('scripts/build.mjs');
const capabilities = read('src-tauri/capabilities/main-capability.json');

if (fs.existsSync('app-ui/subwindow-overrides.css')) fail('subwindow-overrides.css todavía existe.');
if (/subwindow-overrides\.css/.test(`${subwindowHtml}\n${build}`)) fail('La capa override retirada todavía está referenciada por producción/build.');
if (/\b(?:class|data-[^=]+)=['"][^'"]*\bsp-/.test(`${subwindowHtml}\n${subwindowJs}`) || /\.sp-[\w-]+/.test(subwindowCss)) fail('El DOM/CSS V5 de subventana conserva hooks legacy .sp- como implementación primaria.');
if (!/class="app-window"/.test(subwindowJs) || !/class="titlebar"/.test(subwindowJs)) fail('Faltan los hooks estructurales de titlebar/app-window V5.');
for (const hook of ['data-role="url"', 'data-role="output"', 'data-role="quality"', 'data-role="filename"', 'data-role="destination-path"', 'data-role="track-content"', 'data-role="item-check"', 'data-action="select-all"']) {
  if (!subwindowJs.includes(hook)) fail(`Falta binding V5: ${hook}`);
}
for (const view of ['.multimedia-grid', '.media-hero', '.media-options', '.playlist-layout', '.track-grid', '.http-layout', '.http-info', '.http-destination']) {
  if (!subwindowCss.includes(view)) fail(`Falta estructura CSS V5: ${view}`);
}
if (!/\.track-grid\{[^}]*grid-template-columns:1fr 1fr;/.test(subwindowCss)) fail('Playlist no declara exactamente dos columnas.');
if (!/\.media-thumb\{[^}]*aspect-ratio:16\/9/.test(subwindowCss) || !/\.track-thumb\{[^}]*aspect-ratio:16\/9/.test(subwindowCss)) fail('Miniaturas no tienen ratio 16:9 contractual.');
if (/transform\s*:\s*scale\s*\(/.test(subwindowCss)) fail('Se detectó transform:scale() global en la UI V5.');
for (const token of ['--sp-bg', '--sp-panel', '--sp-text', '--sp-muted', '--sp-accent', '--sp-accent-rgb']) {
  if (!subwindowCss.includes(token)) fail(`subwindow.css no consume el token semántico ${token}.`);
}
if (!capabilities.includes('"http-prep"')) fail('La capability nativa http-prep no está declarada.');
for (const label of ['media-prep', 'playlist-prep', 'http-prep']) {
  if (!subwindowJs.includes(label)) fail(`El adapter no conserva el label ${label}.`);
}

if (failMessages.length) {
  for (const message of failMessages) console.error(`FAIL: ${message}`);
  process.exit(1);
}
console.log('PASS: UI V5 structural gate, current source contracts, two-column playlist and tokens.');
