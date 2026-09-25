import fs from 'node:fs';

const read = (file) => fs.readFileSync(file, 'utf8');
const rust = read('src-tauri/src/subwindows.rs');
const settings = read('src-tauri/src/settings.rs');
const commands = read('src-tauri/src/commands/subwindows.rs');
const frontend = read('app-ui/subwindow.js');
const styles = read('app-ui/subwindow.css');
const appearanceStyles = read('app-ui/modules/appearance/styles.css');
const build = read('scripts/build.mjs');
const capability = read('src-tauri/capabilities/main-capability.json');
const downloads = read('app-ui/modules/downloads/index.js');
const failures = [];
const requireToken = (source, token, label) => {
  if (!source.includes(token)) failures.push(`${label}: falta ${token}`);
};

requireToken(rust, 'MEDIA_PREPARATION_LABEL', 'infraestructura multimedia');
requireToken(rust, 'PLAYLIST_PREPARATION_LABEL', 'infraestructura playlist');
requireToken(rust, 'HTTP_PREPARATION_LABEL', 'infraestructura HTTP');
requireToken(rust, 'visible(false)', 'primera pintura oculta');
requireToken(rust, 'min_inner_size', 'tamaños mínimos nativos');
requireToken(rust, '.resizable(label != HTTP_PREPARATION_LABEL)', 'redimensionado nativo salvo ventana HTTP compacta');
requireToken(rust, 'restore_window_geometry', 'tamaño guardado de la subventana');
requireToken(rust, 'remember_window_geometry', 'persistencia del tamaÃ±o nativo');
requireToken(rust, 'WindowEvent::Moved', 'persistencia de posición durante movimiento');
requireToken(rust, 'AtomicU64', 'debounce de geometría');
requireToken(rust, 'decorations(false)', 'titlebar V5 nativa');
requireToken(rust, 'preparation_window_action', 'ciclo de vida de subventana');
requireToken(settings, 'PREPARATION_WINDOW_SETTINGS_KEY', 'clave persistente de subventanas');
requireToken(settings, 'media_output_mode', 'preferencia multimedia persistente');
requireToken(commands, 'open_preparation_window', 'comando de apertura');
requireToken(frontend, 'get_appearance_settings', 'bootstrap de apariencia');
requireToken(frontend, 'show_preparation_window', 'mostrar tras bootstrap');
requireToken(frontend, 'analysisCache', 'deduplicación de análisis');
requireToken(frontend, 'state.sizeActive < 2', 'concurrencia acotada');
requireToken(frontend, 'data-role="track-content"', 'virtualización playlist');
requireToken(frontend, 'track-grid', 'grid playlist V5');
requireToken(frontend, 'paintRow', 'patch incremental de fila');
requireToken(frontend, 'queue_playlist_selection', 'pipeline playlist existente');
requireToken(frontend, 'queue_media_download', 'pipeline multimedia existente');
requireToken(frontend, 'beforeunload', 'limpieza de lifecycle');
requireToken(frontend, 'applyAppearance(state.appearance || loadStoredAppearance()', 'escala compartida con el gestor');
requireToken(frontend, 'MEDIA_DOWNLOAD_PREFERENCES_KEY', 'preferencias multimedia compartidas');
requireToken(frontend, 'persistMediaDownloadPreferences', 'persistencia de formato y calidad');
requireToken(styles, 'var(--sp-scale, 1)', 'tipografía de subventana ligada a la escala compartida');
requireToken(appearanceStyles, '--sp-root-font-size', 'token de tamaño de texto compartido');
requireToken(styles, '.track-card', 'layout playlist V5');
requireToken(styles, '.track-grid{display:grid;grid-template-columns:1fr 1fr;', 'playlist permanente en dos columnas');
requireToken(styles, 'overscroll-behavior: contain', 'scroll contenido');
requireToken(build, "'subwindow.html'", 'recurso frontend de subventana');
requireToken(build, "'subwindow.css'", 'hoja única V5 de subventana');
if (build.includes('subwindow-overrides.css')) failures.push('la compilación conserva subwindow-overrides.css');
requireToken(build, "copyDirectory('app-ui/assets'", 'logos de plataforma de subventana');
if (frontend.includes('<small>${escapeHtml(state.source')) {
  failures.push('el enlace de origen se duplica debajo del título de la subventana');
}
requireToken(capability, 'media-prep', 'capability multimedia');
requireToken(capability, 'playlist-prep', 'capability playlist');
requireToken(capability, 'http-prep', 'capability HTTP');
requireToken(downloads, "open_preparation_window", 'apertura nativa desde descargas');
requireToken(downloads, 'nativePreparationRuntime', 'bloqueo legacy en runtime Tauri');
if (downloads.includes('renderDownloadDialog') || downloads.includes('data-floating-download-dialog') || downloads.includes('download-dialog-v2')) {
  failures.push('renderer legacy de preparación todavía presente');
}
if (frontend.includes('class="sp-') || frontend.includes('data-sp-') || styles.includes('.sp-')) {
  failures.push('DOM/CSS legacy .sp-* todavía es implementación primaria');
}

if (failures.length) {
  console.error(failures.join('\n'));
  process.exit(1);
}
console.log('OK: Fase 13 valida subventanas Tauri nativas, bootstrap visual oculto, lifecycle, análisis incremental, virtualización, selección y pipeline compartido.');
