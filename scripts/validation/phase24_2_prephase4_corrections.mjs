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

const checks = [
  ['La búsqueda libre no añade una insignia redundante', dmUnified.includes("export function unifiedDetectionMarkup() {\n  return '';\n}")],
  ['La miniatura multimedia no superpone la extensión con el botón de reproducción', dmUnified.includes("const extensionLabel = playableKind ? ''") && dmCss.includes('.dm-player-trigger:hover .dm-player-overlay')],
  ['El resumen de tamaño no concatena una ETA desconocida', dmUnified.includes("etaLabel !== '—'") && !dmUnified.includes("Total aproximado'} · ${formatEta")],
  ['La información técnica del análisis está plegada por defecto', main.includes('<details class="analysis-technical"') && appCss.includes('.analysis-technical>summary')],
  ['La mejor calidad conserva la selección semántica en la ventana nativa', main.includes('function formatLabel(format = {})') && main.includes('data-role="quality"') && main.includes('data-role="quality-note"')],
  ['El distintivo de audio original puede envolver el texto', appCss.includes('.analysis-v2-badges.is-compact>span') && appCss.includes('white-space:normal!important')],
  ['La cola elimina el renderer legacy y su pie de cierre', !main.includes('renderDownloadDialog') && !main.includes('download-dialog-v2') && !main.includes('workspaceMarkup')],
  ['Los botones de diagnóstico alinean icono y texto horizontalmente', dmCss.includes('.dm-settings-feature-actions button{\n  display:inline-flex')],
  ['El reproductor conserva la escala principal y no reserva una columna técnica permanente', rust.includes('.inner_size(1600.0, 980.0)') && rust.includes('.min_inner_size(960.0, 560.0)') && playerCss.includes('definitive glass player') && !playerCss.includes('grid-template-columns:minmax(0,1fr) 300px')],
  ['El panel técnico del reproductor es opcional y accesible', playerHtml.includes('data-player-action="info"') && playerHtml.includes('data-player-info-close') && playerJs.includes('function setInfoOpen') && playerCss.includes('.player-shell.is-info-open .player-info')],
  ['La lista de playlist ya no depende del workspace integrado legacy', !main.includes('renderDownloadDialog') && !main.includes('dm-floating-workspace')],
  ['Rust sigue en Edition 2021 y no introduce let chains', cargo.includes('edition = "2021"') && !/&&\s*let\s+/.test(rust)],
  ['No reaparecen los patrones Rust ya corregidos', !rust.includes('if path.starts_with(destination) =>') && !rust.includes('.eval(&format!("window.cacatoolsPlayerLoadJob?.')],
  ['La extensión oficial mantiene su identificador', extensionBridge.includes('aonppfnabjnicjjeoofkfjofolfibggp')],
];
const failures = checks.filter(([, ok]) => !ok).map(([label]) => label);
const report = { phase:'0.24.2-pre-phase4-visual-corrections', checks:checks.length, failures, generatedAt:new Date().toISOString() };
fs.mkdirSync('docs/tests',{recursive:true});
fs.writeFileSync('docs/tests/phase24-2-prephase4-corrections.json', `${JSON.stringify(report,null,2)}\n`);
if (failures.length) {
  console.error(failures.map((failure)=>`FALLO: ${failure}`).join('\n'));
  process.exit(1);
}
for (const [label] of checks) console.log(`OK: ${label}`);
console.log(`OK: correcciones visuales previas a Fase 4 validadas (${checks.length} condiciones).`);
