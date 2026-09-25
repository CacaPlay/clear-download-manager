import fs from 'node:fs';
const readFrontendSource = (extension) => fs.readdirSync('app-ui', { recursive: true })
  .filter((file) => file.endsWith(extension) && !file.replaceAll('\\', '/').startsWith('download-manager/'))
  .sort((a, b) => {
    const primary = extension === '.js' ? 'main.js' : 'styles.css';
    return a === primary ? -1 : b === primary ? 1 : a.localeCompare(b);
  })
  .map((file) => fs.readFileSync(`app-ui/${file}`, 'utf8'))
  .join('\n');

const read = (file) => fs.readFileSync(file, 'utf8');
const main = readFrontendSource('.js');
const appCss = readFrontendSource('.css');
const dmUnified = read('app-ui/download-manager/view/unified.js');
const dmCss = read('app-ui/download-manager/styles.css');
const dmShared = read('app-ui/download-manager/view/shared.js');
const playerHtml = read('app-ui/player/index.html');
const playerJs = read('app-ui/player/player.js');
const playerCss = read('app-ui/player/player.css');
const rust = fs.readdirSync('src-tauri/src', { recursive: true })
  .filter((file) => file.endsWith('.rs'))
  .sort((a, b) => (a === 'lib.rs' ? -1 : b === 'lib.rs' ? 1 : a.localeCompare(b)))
  .map((file) => fs.readFileSync(`src-tauri/src/${file}`, 'utf8'))
  .join('\n');
const cargo = read('src-tauri/Cargo.toml');
const extensionBridge = read('src-tauri/src/extension_bridge.rs');

const forbiddenUi = ['Multimedia detectado', 'Playlist detectada', 'Buscando video', 'La cola continúa en segundo plano.', 'Ocultar ventana', 'No se declara como lossless'];
const uiSources = [main, dmUnified, playerHtml].join('\n');
const checks = [
  ['El play de las miniaturas solo aparece en hover o foco', dmUnified.includes('class="dm-player-overlay" aria-hidden="true"') && dmCss.includes('opacity:0') && dmCss.includes('.dm-player-trigger:hover .dm-player-overlay') && dmCss.includes('.dm-player-trigger:focus-visible .dm-player-overlay')],
  ['El hover no desplaza la miniatura ni añade borde de acento', dmCss.includes('transform:none!important') && dmCss.includes('.dm-player-trigger .dm-job-thumb{border:0!important}') && !dmCss.includes('border-color:color-mix(in srgb,var(--dm-accent) 48%,transparent)')],
  ['El reproductor conserva escala principal y detalles opcionales', rust.includes('.inner_size(1600.0, 980.0)') && rust.includes('.min_inner_size(960.0, 560.0)') && playerHtml.includes('data-player-action="info"') && playerCss.includes('.player-info') && playerJs.includes('function setInfoOpen')],
  ['El reproductor sincroniza cambios de apariencia sin reiniciarse', playerJs.includes("window.addEventListener('storage'") && playerJs.includes("event.key === 'cacatools.desktop.appearance.v1'")],
  ['Las etiquetas internas innecesarias desaparecen de la interfaz', forbiddenUi.every((token) => !uiSources.includes(token)) && dmUnified.includes("export function unifiedDetectionMarkup() {\n  return '';\n}")],
  ['La etiqueta global de formato no incluye tamaño y permanece blanca', main.includes('function mediaSummaryBadgeLabel') && main.includes("return 'Original / mejor audio disponible';") && appCss.includes('.analysis-v2-badges.is-compact>span.is-audio-original{\n  color:#fff!important;')],
  ['Las calidades eliminan video + audio y conservan calidad más tamaño', main.includes('function mediaQualityName') && main.includes('mediaSizeLabel(format.filesize') && !main.includes('1080p · vídeo + audio')],
  ['Los detalles técnicos permanecen cerrados y sin aviso lossless', main.includes('<details class="analysis-technical"') && main.includes('Más detalles</span>') && !main.includes('data-media-tech-note') && !playerHtml.includes('player-quality-note')],
  ['Cambiar queda alineado y blanco en todos los selectores', appCss.includes('.analysis-option-grid .folder-field>button') && appCss.includes('.playlist-v2-options .folder-field>button') && appCss.includes('color:#fff!important;')],
  ['La cola de playlist no conserva el renderer integrado legacy', !main.includes('renderDownloadDialog') && !main.includes('dm-floating-workspace') && !main.includes('download-dialog-v2')],
  ['La playlist conserva scroll y reduce bordes de acento', appCss.includes('.playlist-selection-scroll{max-height:none!important;min-height:0;overflow:auto!important') && appCss.includes('.playlist-v2-list .playlist-select-item.selected{\n  border-color:var(--dm-border')],
  ['Ajustes es más pequeño y separa títulos de descripciones', dmCss.includes('width:min(58rem') && dmCss.includes('height:min(40rem') && dmCss.includes('.dm-settings-section-body>.dm-switch-row>span') && dmShared.includes('<strong>Filas compactas</strong><small>') && dmShared.includes('<strong>Comprobar al iniciar</strong><small>')],
  ['El progreso real y el parche por fila de Fase 4 continúan presentes', rust.includes('MEDIA_PROGRESS_DB_INTERVAL_MS: u64 = 250') && read('app-ui/download-manager/index.js').includes('function keyedDownloadRowsPatch') && read('app-ui/download-manager/index.js').includes('function patchLiveDownloadRow')],
  ['Rust sigue en Edition 2021 y conserva correcciones previas', cargo.includes('edition = "2021"') && !/&&\s*let\s+/.test(rust) && !rust.includes('.eval(&format!("window.cacatoolsPlayerLoadJob?.')],
  ['Updater y extensión oficial siguen integrados', extensionBridge.includes('aonppfnabjnicjjeoofkfjofolfibggp') && fs.existsSync('src-tauri/src/update_manager.rs')],
];
const failures = checks.filter(([, ok]) => !ok).map(([label]) => label);
const report = { phase:'0.24.2-phase3-final-closure', checks:checks.length, failures, passed:failures.length === 0, generatedAt:new Date().toISOString() };
fs.mkdirSync('docs/tests',{recursive:true});
fs.writeFileSync('docs/tests/phase24-2-phase3-final-closure.json', `${JSON.stringify(report,null,2)}\n`);
if (failures.length) {
  console.error(failures.map((failure)=>`FALLO: ${failure}`).join('\n'));
  process.exit(1);
}
for (const [label] of checks) console.log(`OK: ${label}`);
console.log(`OK: cierre final de Fase 3 validado (${checks.length} condiciones).`);
