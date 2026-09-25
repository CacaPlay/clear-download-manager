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
const dmIndex = read('app-ui/download-manager/index.js');
const dmShared = read('app-ui/download-manager/view/shared.js');
const dmCss = read('app-ui/download-manager/styles.css');
const dmModel = read('app-ui/download-manager/core/model.js');
const rust = fs.readdirSync('src-tauri/src', { recursive: true })
  .filter((file) => file.endsWith('.rs'))
  .sort((a, b) => (a === 'lib.rs' ? -1 : b === 'lib.rs' ? 1 : a.localeCompare(b)))
  .map((file) => fs.readFileSync(`src-tauri/src/${file}`, 'utf8'))
  .join('\n');

const checks = [
  ['Texto normalizado de 80 a 120 sin escalar paneles', main.includes('TEXT_SCALE_MIN = 80') && main.includes('TEXT_SCALE_MAX = 120') && dmModel.includes('80, 120') && rust.includes('!(80..=120).contains(&self.text_scale)')],
  ['Escala de texto llega al gestor por variable independiente', dmIndex.includes('--dm-text-scale:') && dmCss.includes('--dm-readable-sm:calc(.64rem * var(--dm-text-scale,1))')],
  ['Marcos de iconos mantienen interior neutro', css.includes('El acento vive en el borde y el símbolo') && css.includes('background:var(--hf5-icon-surface)!important') && dmCss.includes('background:var(--dm-surface-2)!important')],
  ['La barra de URL nativa tiene un solo marco', main.includes('class="url-row"') && css.includes('.url-row') && css.includes('.url-input')],
  ['Contenido individual elimina textos redundantes', !main.includes('Video + audio se combinarán automáticamente.') && main.includes('data-role="output"') && main.includes('data-role="quality"')],
  ['Hero multimedia conserva composición V5', css.includes('.media-hero{') && css.includes('.media-thumb{') && css.includes('aspect-ratio:16/9')],
  ['Hero playlist conserva composición V5', css.includes('.playlist-layout{') && css.includes('.playlist-summary{') && css.includes('.track-grid{')],
  ['Subventana legacy no reaparece en el gestor principal', !main.includes('data-dialog-minimize') && !main.includes('data-dialog-maximize') && !main.includes('class="dialog-close"') && !main.includes('renderDownloadDialog')],
  ['Cabecera y pie de subventana usan geometry tokens V5', css.includes('--titlebar-h: calc(38px * var(--ui-scale))') && css.includes('--footer-h: calc(66px * var(--ui-scale))')],
  ['Playlist permite borrar historial o almacenamiento', dmShared.includes('data-dm-delete-playlist-batch') && dmIndex.includes("'delete_playlist_batch'") && rust.includes('fn delete_playlist_batch(')],
  ['Playlist reintenta una vez fallos temporales', rust.includes('automatic_retries') && rust.includes('Reintento automático de playlist') && rust.includes('diagnosis.likely_temporary')],
  ['Versión se coloca en esquina del pie', dmCss.includes('.dm-footer-beta{') && dmCss.includes('right:1rem!important')],
  ['Actualizaciones parciales no animan ni reanclan', css.includes('overflow-anchor:none!important') && css.includes('animation:none!important')],
  ['Hotfixes Rust previos permanecen', rust.includes('!self.scale.is_multiple_of(5)') && rust.includes("trim_end_matches([' ', '.'])")]
];

const failures = checks.filter(([, ok]) => !ok).map(([label]) => label);
const report = { phase: '0.24.1-hotfix-5-harmony', checks: checks.length, failures, generatedAt: new Date().toISOString() };
fs.mkdirSync('docs/tests', { recursive: true });
fs.writeFileSync('docs/tests/phase24-1-hotfix5-harmony.json', `${JSON.stringify(report, null, 2)}\n`);
if (failures.length) {
  console.error(failures.map((failure) => `FALLO: ${failure}`).join('\n'));
  process.exit(1);
}
for (const [label] of checks) console.log(`OK: ${label}`);
console.log(`OK: Hotfix 5 valida ${checks.length} condiciones de armonía, lectura, playlists y estabilidad.`);
