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
const json = (file) => JSON.parse(read(file));
const files = {
  packageJson: json('package.json'),
  tauri: json('src-tauri/tauri.conf.json'),
  model: read('app-ui/download-manager/core/model.js'),
  dmView: read('app-ui/download-manager/view/unified.js'),
  dmCss: read('app-ui/download-manager/styles.css'),
  appMain: readFrontendSource('.js'),
  appCss: readFrontendSource('.css'),
  extensionCss: read('extension/sidepanel.css'),
  extensionJs: read('extension/sidepanel.js'),
  extensionManifest: json('extension/manifest.json'),
  rust: fs.readdirSync('src-tauri/src', { recursive: true })
    .filter((file) => file.endsWith('.rs'))
    .sort((a, b) => (a === 'lib.rs' ? -1 : b === 'lib.rs' ? 1 : a.localeCompare(b)))
    .map((file) => fs.readFileSync(`src-tauri/src/${file}`, 'utf8'))
    .join('\n'),
  bridge: read('src-tauri/src/extension_bridge.rs')
};
const publishedId = 'aonppfnabjnicjjeoofkfjofolfibggp';
const windowConfig = files.tauri.app.windows.find((entry) => entry.label === 'main');
const checks = [
  ['La ventana mantiene el mínimo funcional 1180 × 720', windowConfig?.minWidth === 1180 && windowConfig?.minHeight === 720],
  ['La fila separa cuerpo, metadatos y acciones', files.dmView.includes('class="dm-item-body"') && files.dmView.includes('class="dm-item-actions"')],
  ['Las acciones permanecen a la derecha y no debajo de la miniatura', files.dmCss.includes('grid-template-areas:"visual body meta actions"') && files.dmCss.includes('grid-area:actions!important')],
  ['El responsive usa el ancho real del Centro de descargas', files.dmCss.includes('container-type:inline-size') && files.dmCss.includes('@container download-center')],
  ['Las filas usan superficie fija y solo el borde adopta el acento', files.dmCss.includes('background:var(--dm-section-surface)!important') && files.dmCss.includes('border-color:var(--dm-accent)!important')],
  ['Los metadatos no tienen rellenos ni contornos internos', files.dmCss.includes('.dm-item-meta span{') && files.dmCss.includes('background:transparent!important')],
  ['Los iconos conservan interior neutro', files.dmCss.includes('background:var(--dm-icon-surface)!important')],
  ['El progreso se calcula desde bytes exactos', files.model.includes('exactDownloaded * 100 / total') && files.model.includes('Math.min(downloaded, total)')],
  ['Cero bytes se representa como 0 B', files.model.includes("if (value === 0) return '0 B'") && files.appMain.includes("if (bytes === 0) return '0 B'")],
  ['La extensión calcula progreso y tamaño exactos', files.extensionJs.includes('exactJobProgress') && files.extensionJs.includes('transferSizeLabel')],
  ['La extensión usa superficies neutras coherentes', files.extensionCss.includes('--section-surface:#101a25') && files.extensionCss.includes('.primary-section,.compact-panel,.capture-settings')],
  ['La extensión conserva iconos y miniaturas con interior fijo', files.extensionCss.includes('background:var(--icon-surface)!important')],
  ['El backend suaviza velocidad con una sola función común', files.rust.includes('struct TransferRateSampler') && files.rust.includes('fn stabilize_reported_speed')],
  ['Descarga directa, curl y torrent usan el mismo muestreador', (files.rust.match(/TransferRateSampler::new/g) || []).length >= 3],
  ['El backend elimina velocidad y ETA obsoletas en tareas detenidas', files.rust.includes('let speed_bps = if status == "running"') && files.rust.includes('let eta_seconds = if status == "running"')],
  ['Los lotes de playlist calculan el progreso desde bytes', files.rust.includes('let raw_downloaded_bytes = row.get::<_, i64>(9)?') && files.rust.includes('downloaded_bytes as f64 * 100.0 / total as f64')],
  ['Las miniaturas válidas de playlists se conservan entre renders', files.appMain.includes('playlistThumbnailCache') && files.appMain.includes('stablePlaylistThumbnail')],
  ['El selector de calidad ocupa el ancho y reduce espacios vacíos', files.appCss.includes('grid-template-areas:"hero" "options" "alternatives" "preview"') && files.appCss.includes('repeat(auto-fit,minmax(9.5rem,1fr))')],
  ['El gestor de playlists tiene lista y opciones responsive', files.appCss.includes('.playlist-v2-layout') && files.appCss.includes('@media(max-width:900px)')],
  ['Las barras de playlist comparten la transición de progreso', files.appCss.includes('transition:width .25s linear!important')],
  ['Los menús quedan dentro del viewport', files.dmCss.includes('max-height:min(25rem,calc(100vh - 1rem))')],
   ['El pie muestra CacaTools 0.45.0', files.dmView.includes('CacaTools 0.45.0') && files.dmCss.includes('.dm-footer-beta')],
  ['Las pruebas Rust cubren picos y caída de velocidad', files.rust.includes('transfer_speed_smoothing_limits_unrealistic_spikes') && files.rust.includes('transfer_speed_smoothing_decays_when_no_bytes_arrive')],
  ['Manifest V3 y permisos permanecen sin cambios', files.extensionManifest.manifest_version === 3 && JSON.stringify(files.extensionManifest.permissions) === JSON.stringify(['activeTab','scripting','downloads','storage','sidePanel','nativeMessaging'])],
  ['El ID publicado permanece fijo', files.bridge.includes(`PUBLISHED_CHROMIUM_EXTENSION_ID: &str = "${publishedId}"`)]
];
const failures = checks.filter(([, ok]) => !ok).map(([label]) => label);
const report = {
  phase: '0.24.1-fase-6-componentes-playlists-progreso',
  version: files.packageJson.version,
  publishedExtensionId: publishedId,
  checks: checks.length,
  failures,
  generatedAt: new Date().toISOString()
};
fs.mkdirSync('docs/tests', { recursive: true });
fs.writeFileSync('docs/tests/phase24-1-components-playlists-progress.json', `${JSON.stringify(report, null, 2)}\n`);
if (failures.length) {
  console.error(failures.map((failure) => `FALLO: ${failure}`).join('\n'));
  process.exit(1);
}
for (const [label] of checks) console.log(`OK: ${label}`);
console.log(`OK: Fase 6 valida ${checks.length} condiciones de filas, playlists y progreso.`);
