import fs from 'node:fs';
import assert from 'node:assert/strict';
import { translate } from '../../extension/i18n.js';

const html = fs.readFileSync('extension/sidepanel.html', 'utf8');
const css = fs.readFileSync('extension/sidepanel.css', 'utf8');
const panel = fs.readFileSync('extension/sidepanel.js', 'utf8');
const worker = fs.readFileSync('extension/service-worker.js', 'utf8');
const sdk = fs.readFileSync('extension/sdk/cdm-native-client.js', 'utf8');
const app = fs.readFileSync('app-ui/modules/extension/index.js', 'utf8');
const manifest = JSON.parse(fs.readFileSync('extension/manifest.json', 'utf8'));
const extensionBuild = fs.readFileSync('scripts/build-extension.ps1', 'utf8');

assert.equal(manifest.default_locale, 'en');
assert.equal(manifest.version_name, '1.0.0');
assert.equal(manifest.homepage_url, 'https://github.com/CacaPlay/clear-download-manager');
assert.match(extensionBuild, /Join-Path \$Source '_locales'/, 'Extension package must include Chrome locale message files');
for (const [source, expected] of [
  ['Pausar', 'Pause'],
  ['Reanudar', 'Resume'],
  ['Cancelar', 'Cancel'],
  ['Mostrar archivo', 'Show file'],
  ['Eliminar archivo y registro', 'Delete file and record'],
  ['Reproducir en Clear Download Manager', 'Play in Clear Download Manager'],
  ['Abrir en Clear Download Manager', 'Open in Clear Download Manager'],
  ['Abrir archivo', 'Open file'],
  ['Eliminar del historial', 'Remove from history'],
  ['Añadir a playlist manual', 'Add to manual playlist'],
  ['Vídeo de YouTube', 'YouTube video'],
  ['Enlace multimedia', 'Media link'],
  ['Aplicando…', 'Applying…'],
  ['3 elementos detectados', '3 detected items'],
  ['2 activas · 1 completada', '2 active · 1 completed'],
  ['Carpeta A · 4 enlaces', 'Carpeta A · 4 links'],
  ['Enlaces sueltos (5)', 'Loose links (5)'],
]) {
  assert.equal(translate('en', source), expected, `English extension copy missing for: ${source}`);
}

assert.match(html, /data-download-action="play"/);
for (const action of ['pause', 'resume', 'retry', 'cancel', 'reveal_file', 'open_file', 'delete_history', 'delete_file']) assert.match(html, new RegExp(`data-download-action="${action}"`));
assert.match(panel, /addEventListener\('contextmenu'/);
assert.match(panel, /data-download-menu/);
assert.match(panel, /function showDownloadMenu\(event, jobId\)[\s\S]*?localizeExtension\(\)/);
assert.match(panel, /button\.title = allowed \? '' : t\(/);
assert.match(panel, /function displayLinkTitle\(entry\)[\s\S]*?t\('Vídeo de YouTube'\)/);
assert.match(panel, /type: 'JOB_ACTION'/);
assert.match(css, /grid-template-areas:"thumb copy state action"/);
assert.match(css, /\.download-row-action\{grid-area:action/);
assert.match(css, /\.thumb-frame\{[^}]*border:1px solid var\(--line\)/);
assert.match(css, /\.download-thumb\{[^}]*border:1px solid var\(--line\)/);
assert.match(css, /\.thumb-frame,\.manual-link-thumb,\.download-thumb\{\s*border-color:var\(--line\)!important;/);
assert.match(worker, /cdmNative\.openPlayer/);
assert.match(worker, /cdmNative\.jobAction/);
assert.match(sdk, /sendCDMNativeMessage\('open_player'/);
assert.match(sdk, /sendCDMNativeMessage\('job_action'/);
assert.match(app, /request\.action === 'open_player'/);
assert.match(app, /invoke\('open_media_player'/);
assert.doesNotMatch(panel, /wake_main_window/);

console.log('OK: menú único, botón de opciones a la derecha y reproducción interna tienen hooks consistentes.');
