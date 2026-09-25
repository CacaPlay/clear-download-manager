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
const css = readFrontendSource('.css');
const dmCss = read('app-ui/download-manager/styles.css');

const checks = [
  ['Memoria multimedia persistente', main.includes("MEDIA_DOWNLOAD_PREFERENCES_KEY = 'cacatools.media-download-preferences.v1'") && main.includes('persistMediaDownloadPreferences()') && main.includes('selectedPlaylistFormat')],
  ['Abrir otro enlace conserva salida y calidad', main.includes('state.outputMode') && main.includes('state.selectedFormat') && main.includes('open_preparation_window') && !main.includes('workspaceMarkup')],
  ['Subventana legacy no reaparece en el gestor principal', !main.includes('data-dialog-minimize') && !main.includes('data-dialog-maximize') && !main.includes('class="dialog-close"') && !main.includes('renderDownloadDialog')],
  ['Controles de ventana usan colores fijos', css.includes('background:#172331!important') && css.includes('border-color:#a94b55!important')],
  ['Porcentajes y tamaños tienen contraste adaptativo', dmCss.includes('--dm-progress-number:#f7fbff') && dmCss.includes('--dm-progress-number:#101b2b') && dmCss.includes('.dm-item-size strong{') && dmCss.includes('color:var(--dm-progress-number)!important')],
  ['Estado actual usa punto verde y porcentaje legible', css.includes('.current-status i{background:#43d28c!important') && css.includes('[data-playlist-current-percent]{color:#fff!important')],
  ['Formato actual ya no usa caja', css.includes('.selected-format{') && css.includes('border:0!important') && css.includes('background:transparent!important')],
  ['Calidad principal permanece en una línea', css.includes('.analysis-v2-badges.is-compact>span') && css.includes('white-space:nowrap!important') && css.includes('color:var(--green)!important')],
  ['Hero multimedia usa el espacio derecho', css.includes('grid-template-columns:minmax(14rem,19rem) minmax(0,1fr)!important')],
  ['Cola de playlist usa scroll del cuerpo', css.includes('.dm-floating-workspace.is-queue>.dialog-body{display:block!important;overflow:auto!important') && css.includes('.playlist-upcoming-list{max-height:none!important')],
  ['Actualización de playlist deriva al gestor principal desde la ventana nativa', main.includes("queue_playlist_selection") && main.includes("open_preparation_window") && !main.includes('workspaceMarkup')],
  ['Cola sincroniza filas y contador sin perder scroll', main.includes('data-playlist-pending-count') && main.includes('data-playlist-upcoming-list') && main.includes('const scrollTop = list.scrollTop')],
  ['Portadas finales están agrupadas y centradas', css.includes('.playlist-terminal-card{width:min(100%,64rem)!important') && css.includes('.playlist-terminal-art{width:10.4rem!important')],
  ['Miniaturas no reciben listeners duplicados', main.includes("image.dataset.thumbnailFallbackBound === '1'")],
  ['Optimización visual evita blur costoso', css.includes('backdrop-filter:none!important') && css.includes('content-visibility:auto')],
  ['Restablecer colores no altera escala ni densidad', main.includes('settings-reset-colors') && main.includes('Colores predeterminados restaurados') && css.includes('.settings-reset-colors{')],
  ['Modo claro mantiene URL legible', css.includes('.dm-dialog-theme-light .dm-workspace-sourcebar .url-field input{color:var(--dl-text)!important')],
  ['Ver Descargas usa solo borde e icono de acento', css.includes('.playlist-open-downloads{color:var(--dm-text)!important;border-color:var(--dm-accent)!important') && css.includes('.playlist-open-downloads .icon{color:var(--dm-accent)!important')]
];

const failures = checks.filter(([, ok]) => !ok).map(([label]) => label);
const report = { phase: '0.24.1-hotfix-8-final-polish', checks: checks.length, failures, generatedAt: new Date().toISOString() };
fs.mkdirSync('docs/tests', { recursive: true });
fs.writeFileSync('docs/tests/phase24-1-hotfix8-final-polish.json', `${JSON.stringify(report, null, 2)}\n`);
if (failures.length) {
  console.error(failures.map((failure) => `FALLO: ${failure}`).join('\n'));
  process.exit(1);
}
for (const [label] of checks) console.log(`OK: ${label}`);
console.log(`OK: Hotfix 8 valida ${checks.length} condiciones de persistencia, playlist, contraste y rendimiento.`);
