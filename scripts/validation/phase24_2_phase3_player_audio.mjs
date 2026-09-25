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
const rust = fs.readdirSync('src-tauri/src', { recursive: true })
  .filter((file) => file.endsWith('.rs'))
  .sort((a, b) => (a === 'lib.rs' ? -1 : b === 'lib.rs' ? 1 : a.localeCompare(b)))
  .map((file) => fs.readFileSync(`src-tauri/src/${file}`, 'utf8'))
  .join('\n');
const cargo = read('src-tauri/Cargo.toml');
const cargoLock = read('src-tauri/Cargo.lock');
const config = JSON.parse(read('src-tauri/tauri.conf.json'));
const capability = JSON.parse(read('src-tauri/capabilities/main-capability.json'));
const build = read('scripts/build.mjs');
const main = readFrontendSource('.js');
const appCss = readFrontendSource('.css');
const dmIndex = read('app-ui/download-manager/index.js');
const dmShared = read('app-ui/download-manager/view/shared.js');
const dmUnified = read('app-ui/download-manager/view/unified.js');
const dmCss = read('app-ui/download-manager/styles.css');
const playerHtml = read('app-ui/player/index.html');
const playerJs = read('app-ui/player/player.js');
const playerCss = read('app-ui/player/player.css');
const extensionBridge = read('src-tauri/src/extension_bridge.rs');
const assetProtocol = config.app?.security?.assetProtocol || {};
const csp = config.app?.security?.csp || {};
const playerVisual = JSON.parse(read('docs/tests/phase24-2-player-visual-smoke.json'));

const checks = [
  ['El reproductor tiene HTML, CSS y JavaScript propios', fs.existsSync('app-ui/player/index.html') && fs.existsSync('app-ui/player/player.css') && fs.existsSync('app-ui/player/player.js')],
  ['La construcción web copia la ventana del reproductor', build.includes("copyDirectory('app-ui/player'")],
  ['Tauri autoriza una única ventana player', capability.windows?.includes('player') && rust.includes('get_webview_window("player")') && rust.includes('WebviewWindowBuilder::new(&app, "player"')],
  ['La ventana se reutiliza en vez de duplicarse', rust.includes('window.cacatoolsPlayerLoadJob?.') && rust.includes('window.set_focus()')],
  ['La reutilización del reproductor no introduce un préstamo innecesario para Clippy', !rust.includes('.eval(&format!(\"window.cacatoolsPlayerLoadJob?.') && rust.includes('.eval(format!(\"window.cacatoolsPlayerLoadJob?.')],
  ['La creación de ventana es asíncrona', rust.includes('async fn open_media_player')],
  ['La barra superior incluye minimizar, maximizar/restaurar y cerrar', ['minimize', 'maximize', 'close'].every((action) => playerHtml.includes(`data-window-action="${action}"`)) && rust.includes('fn player_window_action')],
  ['Los controles cubren reproducción, saltos, tiempo, volumen y pantalla completa', ['play', 'back', 'forward', 'mute', 'info', 'fullscreen'].every((action) => playerHtml.includes(`data-player-action="${action}"`)) && playerHtml.includes('player-timeline') && playerHtml.includes('player-volume')],
  ['Los atajos básicos están conectados', playerJs.includes("event.code === 'Space'") && playerJs.includes("event.key === 'ArrowLeft'") && playerJs.includes("event.key === 'ArrowRight'") && playerJs.includes("event.key.toLowerCase() === 'm'") && playerJs.includes("event.key.toLowerCase() === 'f'")],
  ['Minimizar no pausa el audio y se conserva actividad de fondo', !playerJs.includes('visibilitychange') && playerJs.includes('cacatools-player-background-playback') && playerJs.includes('navigator.locks?.request')],
  ['Solo se reproduce un archivo final completado', rust.includes('status == "completed" && candidate.is_file()') && rust.includes('path.starts_with(destination.as_path()).then_some(path)') && !rust.includes('if path.starts_with(destination) =>')],
  ['No se reproducen .part ni flujos separados', rust.includes('no reproduce archivos .part') && rust.includes('vídeo y audio separados')],
  ['El reproductor actualiza el estado hasta que aparece el archivo final', playerJs.includes('loadGeneration') && playerJs.includes('refreshTimer') && playerJs.includes('window.setTimeout(() => { void loadJob(activeJobId); }, 1500)')],
  ['El protocolo asset está habilitado con alcance dinámico exacto y lockfile sincronizado', assetProtocol.enable === true && Array.isArray(assetProtocol.scope) && assetProtocol.scope.length === 0 && cargo.includes('"protocol-asset"') && cargoLock.includes('name = "http-range"') && cargoLock.includes('"http-range"') && rust.includes('asset_protocol_scope()') && rust.includes('.allow_file(path)')],
  ['La CSP conserva medios locales y habilita el preview remoto controlado', String(csp['media-src'] || '').includes('asset:') && String(csp['media-src'] || '').includes('https:')],
  ['Una incompatibilidad de codec ofrece abrir el archivo con Windows', playerHtml.includes('data-player-fallback') && playerJs.includes("invoke('open_local_file'")],
  ['Las miniaturas multimedia abren el reproductor', dmUnified.includes('data-dm-open-player') && dmUnified.includes('dm-player-trigger') && dmIndex.includes('context.onOpenPlayer') && main.includes("invoke('open_media_player'")],
  ['Original / mejor audio disponible usa bestaudio sin conversión', rust.includes('("bestaudio/best".into(), "audio_best".into())') && rust.includes('"audio_best" => {}') && dmShared.includes('Original / mejor audio disponible')],
  ['MP3 de compatibilidad solicita realmente 320 kbps', rust.includes('"--audio-format",\n                "mp3",\n                "--audio-quality",\n                "320K"') && main.includes('Conversión a MP3 320 kbps')],
  ['La UI muestra codec, bitrate, muestreo, canales, contenedor y conversión', ['Codec', 'Bitrate', 'Muestreo', 'Canales', 'Contenedor', 'Conversión'].every((label) => playerHtml.includes(label)) && main.includes('mediaTechnicalMarkup') && appCss.includes('analysis-technical-grid')],
  ['No se declara lossless sin evidencia ni se muestra el aviso retirado', rust.includes('let lossless = matches!') && !main.includes('No se declara como lossless') && !playerHtml.includes('no puede recuperar calidad')],
  ['FFprobe obtiene metadatos del archivo local final', rust.includes('fn probe_player_technical') && rust.includes('format=format_name,bit_rate,duration:stream=codec_type')],
  ['El guard de historial queda y la extensión conserva su ID', rust.includes('job_uses_legacy_removed_provider') && rust.includes("ALTER TABLE playlist_items ADD COLUMN spotify_url TEXT NOT NULL DEFAULT ''") && extensionBridge.includes('aonppfnabjnicjjeoofkfjofolfibggp') && read('extension/README.md').includes('aonppfnabjnicjjeoofkfjofolfibggp')],
  ['Zen Sidebar sigue siendo el diseño único', fs.existsSync('app-ui/download-manager/view/zen-sidebar.js') && !main.includes('Command Center')],
  ['Rust permanece en Edition 2021 y sin let chains', cargo.includes('edition = "2021"') && !/&&\s*let\s+/.test(rust)],
  ['La interfaz del reproductor responde a ventanas pequeñas y mantiene la información técnica opcional', playerCss.includes('@media(max-width:620px)') && playerCss.includes('@media(max-width:480px)') && dmCss.includes('.dm-player-overlay') && playerJs.includes('setInfoOpen') && playerHtml.includes('data-player-info-close')],
  ['La prueba visual cubre oscuro, claro, listo y en espera', playerVisual.passed === true && playerVisual.cases?.length === 2]
];

const failures = checks.filter(([, ok]) => !ok).map(([label]) => label);
const report = {
  phase: '0.24.2-phase-3-player-original-best-audio',
  checks: checks.length,
  failures,
  generatedAt: new Date().toISOString()
};
fs.mkdirSync('docs/tests', { recursive: true });
fs.writeFileSync('docs/tests/phase24-2-phase3-player-audio.json', `${JSON.stringify(report, null, 2)}\n`);
if (failures.length) {
  console.error(failures.map((failure) => `FALLO: ${failure}`).join('\n'));
  process.exit(1);
}
for (const [label] of checks) console.log(`OK: ${label}`);
console.log(`OK: Fase 3 de 0.24.2 valida ${checks.length} condiciones de reproductor y fidelidad de audio.`);
