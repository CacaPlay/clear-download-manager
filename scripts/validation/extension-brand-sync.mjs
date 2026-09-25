import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const read = (file) => fs.readFileSync(file, 'utf8');
const manifest = JSON.parse(read('extension/manifest.json'));
const panel = read('extension/sidepanel.js');
const html = read('extension/sidepanel.html');
const worker = read('extension/service-worker.js');
const appearance = read('extension/sdk/appearance.js');
const appExtension = read('app-ui/modules/extension/index.js');
const build = read('scripts/build-extension.ps1');
const nativeHost = read('extension/native-host/src/main.rs');
const expectedVariants = ['rojo', 'naranja', 'verde', 'celeste', 'azul', 'morado'];
const expectedTypes = ['archive', 'document', 'ebook', 'package', 'torrent', 'font', 'text', 'sheet', 'code', 'image', 'disk', 'audio', 'video', 'pdf', 'presentation', 'playlist-prep', 'generic'];
const checks = [
  ['Manifest rebrandeado', manifest.name === 'Clear Download Manager' && manifest.action?.default_title === 'Abrir Clear Download Manager'],
  ['Panel rebrandeado', html.includes('<title>Clear Download Manager</title>') && html.includes('Clear Download Manager</strong>') && html.includes('id="brand-logo"')],
  ['Icono nativo del navegador apunta a Clear Download Manager', manifest.icons?.['128'] === 'icons/icon128.png' && manifest.action?.default_icon?.['128'] === 'icons/icon128.png'],
  ['La app publica iconos y progreso completos', ['iconColorMode', 'iconColor', 'progressActive', 'progressCompleted', 'progressPaused', 'progressError', 'appearanceRevision'].every((token) => appExtension.includes(token))],
  ['La extensión calcula el mismo acento efectivo', appearance.includes('effectiveAccent') && appearance.includes('iconAccentForAppearance') && panel.includes('effectiveAccent(sourceAccent, intensity, theme)')],
  ['La extensión usa el icono de marca según el acento de la app', panel.includes('iconVariantForColor(sourceAccent)') && panel.includes('brandAssetPath(variant)') && worker.includes('syncActionIcon') && worker.includes('chrome.action?.setIcon')],
  ['El icono del navegador conserva la variante al reiniciar', worker.includes('initializeActionIcon') && worker.includes('lastAppState') && worker.includes('await initializeActionIcon()')],
  ['La extensión conserva iconos de tipo de archivo en dos capas', panel.includes('fileAssetMarkup') && panel.includes('assets/file-types/${asset}-neutral.png') && panel.includes('assets/file-types/${asset}-accent.png')],
  ['Las barras usan colores de progreso independientes', panel.includes('--progress-active') && panel.includes('--progress-completed') && panel.includes('--progress-paused') && panel.includes('--progress-error')],
  ['El build incluye todos los assets de marca y tipos', build.includes("Get-ChildItem (Join-Path $Source 'assets')") && build.includes("Get-ChildItem (Join-Path $Source 'icons\\brand')")],
  ['El host local reconoce el ejecutable rebrandeado', nativeHost.includes('Clear Download Manager.exe')],
  ['Variantes de marca completas', expectedVariants.every((variant) => fs.existsSync(path.join('extension', 'assets', 'brand', `clear-download-manager-${variant}.png`)) && fs.existsSync(path.join('extension', 'icons', 'brand', `clear-download-manager-${variant}-128.png`)))],
  ['Tipos de archivo completos', expectedTypes.every((type) => fs.existsSync(path.join('extension', 'assets', 'file-types', `${type}-neutral.png`)) && fs.existsSync(path.join('extension', 'assets', 'file-types', `${type}-accent.png`)))],
  ['Sintaxis válida de la extensión', ['extension/sidepanel.js', 'extension/service-worker.js', 'extension/sdk/appearance.js'].every((file) => spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' }).status === 0)]
];
const failures = checks.filter(([, ok]) => !ok).map(([label]) => label);
const report = { check: 'extension-brand-sync', checks: checks.length, failures, variants: expectedVariants, fileTypes: expectedTypes, generatedAt: new Date().toISOString() };
fs.mkdirSync('docs/tests', { recursive: true });
fs.writeFileSync('docs/tests/extension-brand-sync.json', `${JSON.stringify(report, null, 2)}\n`);
if (failures.length) {
  console.error(failures.map((failure) => `FALLO: ${failure}`).join('\n'));
  process.exit(1);
}
for (const [label] of checks) console.log(`OK: ${label}`);
console.log(`OK: extensión rebrandeada y sincronizada (${checks.length} comprobaciones).`);
