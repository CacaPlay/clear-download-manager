import fs from 'node:fs';
import path from 'node:path';
const readFrontendSource = (extension) => fs.readdirSync('app-ui', { recursive: true })
  .filter((file) => file.endsWith(extension) && !file.replaceAll('\\', '/').startsWith('download-manager/'))
  .sort((a, b) => {
    const primary = extension === '.js' ? 'main.js' : 'styles.css';
    return a === primary ? -1 : b === primary ? 1 : a.localeCompare(b);
  })
  .map((file) => fs.readFileSync(`app-ui/${file}`, 'utf8'))
  .join('\n');

const read = (file) => fs.readFileSync(file, 'utf8');
const main = read('app-ui/main.js');
const preparation = read('app-ui/subwindow.js');
const preparationIcons = read('app-ui/assets/icons/lucide.js');
const dmIcons = read('app-ui/download-manager/view/icons.js');
const uiFiles = [
  'app-ui/download-manager/view/shared.js',
  'app-ui/download-manager/view/sections.js',
  'app-ui/download-manager/view/unified.js',
  'app-ui/download-manager/view/zen-sidebar.js',
  'app-ui/download-manager/view/dialogs.js'
];
const dmUi = uiFiles.map(read).join('\n');

function block(source, startToken, endToken) {
  const start = source.indexOf(startToken);
  if (start < 0) throw new Error(`No se encontró ${startToken}`);
  const end = source.indexOf(endToken, start);
  if (end < 0) throw new Error(`No se encontró cierre de ${startToken}`);
  return source.slice(start, end);
}
function namesFromObject(source, token) {
  return new Set([...block(source, token, '});').matchAll(/^\s{2}([a-z][a-z0-9_-]*):/gmi)].map((match) => match[1]));
}
function aliasesFromObject(source) {
  const match = source.match(/const ICON_ALIASES = Object\.freeze\(\{([^}]*)\}\);/s);
  return new Map(match ? [...match[1].matchAll(/([a-z][a-z0-9_-]*)\s*:\s*'([a-z][a-z0-9_-]*)'/gi)].map((entry) => [entry[1], entry[2]]) : []);
}
function calls(source, functionName) {
  return new Set([...source.matchAll(new RegExp(`${functionName}\\(\\s*['\"]([a-z][a-z0-9_-]*)['\"]`, 'gi'))].map((match) => match[1]));
}
function resolvedMissing(used, defined, aliases) {
  return [...used].filter((name) => !defined.has(aliases.get(name) || name)).sort();
}

const mainNames = namesFromObject(main, 'const ICON_PATHS = Object.freeze({');
const mainAliases = aliasesFromObject(main);
const mainUses = calls(main, 'icon');
const preparationUses = calls(preparation, 'icon');
const preparationNames = new Set([...preparationIcons.matchAll(/^\s*(?:'([^']+)'|([a-z][a-z0-9_-]*)):\s*/gmi)].map((match) => match[1] || match[2]));
const dmNames = namesFromObject(dmIcons, 'const ICON_PATHS = Object.freeze({');
const dmAliases = aliasesFromObject(dmIcons);
const dmUses = calls(dmUi, 'dmIcon');
const failures = [];
const fail = (message) => failures.push(message);

const mainMissing = resolvedMissing(mainUses, mainNames, mainAliases);
const dmMissing = resolvedMissing(dmUses, dmNames, dmAliases);
const preparationMissing = [...preparationUses].filter((name) => !preparationNames.has(name) && !new Set(['playlist', 'http', 'close']).has(name)).sort();
if (mainMissing.length) fail(`Iconos principales sin registrar: ${mainMissing.join(', ')}`);
if (dmMissing.length) fail(`Iconos del gestor sin registrar: ${dmMissing.join(', ')}`);
if (preparationMissing.length) fail(`Iconos de subventana sin registrar: ${preparationMissing.join(', ')}`);
for (const required of ['search', 'playlist', 'library', 'archive', 'database', 'video', 'app', 'doc']) {
  if (!mainNames.has(required)) fail(`Falta icono principal obligatorio: ${required}`);
}
for (const required of ['search', 'playlist', 'library', 'archive', 'database', 'video', 'pdf', 'sheet', 'presentation', 'package', 'disc']) {
  if (!dmNames.has(required)) fail(`Falta icono del gestor obligatorio: ${required}`);
}

const mainPlaylist = main.match(/playlist:\s*'([^']+)'/)?.[1] || '';
const mainLibrary = main.match(/library:\s*'([^']+)'/)?.[1] || '';
const dmPlaylist = dmIcons.match(/playlist:\s*'([^']+)'/)?.[1] || '';
const dmLibrary = dmIcons.match(/library:\s*'([^']+)'/)?.[1] || '';
const approvedListMusic = '<path d="M16 5H3"/><path d="M11 12H3"/><path d="M11 19H3"/><path d="M21 16V5"/><circle cx="18" cy="16" r="3"/>';
if (!mainPlaylist || mainPlaylist === mainLibrary) fail('Playlist y Biblioteca comparten el mismo dibujo en la interfaz principal');
if (!dmPlaylist || dmPlaylist === dmLibrary) fail('Playlist y Biblioteca comparten el mismo dibujo en el gestor');
if (!mainPlaylist.includes('<circle') || !dmPlaylist.includes('<circle')) fail('El icono de Playlist debe incluir identidad musical, no solo barras genéricas');
if (mainPlaylist !== approvedListMusic || dmPlaylist !== approvedListMusic) fail('Playlist debe coincidir con el icono Lucide oficial list-music aprobado');

if (main.includes('renderDownloadDialog') || main.includes('data-floating-download-dialog') || main.includes('download-dialog-v2')) fail('La interfaz principal todavía contiene el renderer legacy de preparación');
if (dmUi.includes('<footer class="dm-minimal-footer">')) fail('El footer visual permanente del gestor debe permanecer eliminado');
if (!dmUi.includes("dmIcon('library', 30)") || dmUi.includes("dmIcon('video', 30)}<span><strong>Biblioteca multimedia")) fail('Biblioteca multimedia debe conservar su icono propio');
if (!dmUi.includes("return ['playlist', 'playlist']")) fail('Una playlist sin miniatura no tiene fallback semántico');
if (!dmUi.includes('dmPlaylistLogo(large ? 20 : 16)') || dmUi.includes("dmIcon('playlist', large ? 24 : 18)")) fail('La pila visual de playlist debe usar el logo ancho de origen');
if (!dmUi.includes("pdf: ['pdf', 'pdf']") || !dmUi.includes("sheet: ['sheet', 'sheet']") || !dmUi.includes("presentation: ['presentation', 'presentation']") || !dmUi.includes("ebook: ['ebook', 'ebook']") || !dmUi.includes("code: ['file', 'code']")) fail('Los archivos siguen agrupados bajo un icono genérico');
if (!dmUi.includes("item.icon || (item.sourceUrl ? 'video' : 'search')")) fail('Las sugerencias no respetan iconos semánticos');
if (!main.includes('iconMarkupCache') || !dmIcons.includes('iconMarkupCache')) fail('El render de SVG no está cacheado');
if (!main.includes('data-icon-fallback') || !dmIcons.includes('data-icon-fallback')) fail('Falta diagnóstico explícito para iconos desconocidos');

const report = {
  passed: failures.length === 0,
  main: { registered: mainNames.size, staticallyUsed: [...mainUses].sort(), aliases: Object.fromEntries(mainAliases) },
  preparation: { registered: preparationNames.size, staticallyUsed: [...preparationUses].sort(), missing: preparationMissing },
  downloadManager: { registered: dmNames.size, staticallyUsed: [...dmUses].sort(), aliases: Object.fromEntries(dmAliases) },
  checks: { playlistDistinctFromLibrary: mainPlaylist !== mainLibrary && dmPlaylist !== dmLibrary, mainMissing, dmMissing },
  failures
};
fs.mkdirSync('docs/tests', { recursive: true });
fs.writeFileSync('docs/tests/phase20-icon-audit.json', `${JSON.stringify(report, null, 2)}\n`);
if (failures.length) {
  console.error(`Icon audit failed:\n - ${failures.join('\n - ')}`);
  process.exit(1);
}
console.log(`OK: iconografía auditada (${mainNames.size} iconos principales, ${dmNames.size} del gestor); sin fallbacks desconocidos ni confusión Playlist/Biblioteca.`);
