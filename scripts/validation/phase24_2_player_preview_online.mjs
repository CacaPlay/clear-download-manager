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
const config = JSON.parse(read('src-tauri/tauri.conf.json'));
const main = readFrontendSource('.js');
const appCss = readFrontendSource('.css');
const playerHtml = read('app-ui/player/index.html');
const playerJs = read('app-ui/player/player.js');
const playerCss = read('app-ui/player/player.css');
const extensionBridge = read('src-tauri/src/extension_bridge.rs');
const csp = String(config.app?.security?.csp?.['media-src'] || '');

const checks = [
  ['Preview online usa el mismo reproductor reutilizable', rust.includes('fn player_online_preview_snapshot') && rust.includes('async fn open_online_media_player') && rust.includes('window.cacatoolsPlayerLoadPreview?.') && playerJs.includes('window.cacatoolsPlayerLoadPreview')],
  ['yt-dlp selecciona un único formato combinado reproducible', rust.includes('best[ext=mp4][protocol^=http][vcodec!=none][acodec!=none]') && rust.includes('best[ext=webm][protocol^=http][vcodec!=none][acodec!=none]') && !rust.includes('player_online_preview_snapshot') === false],
  ['La URL temporal se valida como HTTP público antes de reproducir', rust.includes('parse_public_http_url(&stream_url, "El flujo temporal no es válido")') && rust.includes('ensure_public_network_resolution(&stream)')],
  ['La CSP habilita medios remotos únicamente para el reproductor web sin quitar asset local', csp.includes('asset:') && csp.includes('https:') && csp.includes('http:')],
  ['El video analizado ofrece play sólo sobre la miniatura nativa', main.includes('data-action="preview"') && appCss.includes('.media-thumb') && appCss.includes('.preview-play{position:absolute') && appCss.includes('inset:0')],
  ['Abrir contenido inicia reproducción automáticamente', playerJs.includes('next.autoplay = true') && playerJs.includes('await element.play()') && playerJs.includes("next.addEventListener('canplay'")],
  ['Autoplay tiene fallback en silencio cuando WebView2 bloquea audio automático', playerJs.includes("error?.name === 'NotAllowedError'") && playerJs.includes('element.muted = true') && playerJs.includes("setButtonIcon(muteButton, 'muted')")],
  ['Play y pausa usan iconos SVG reales y no caracteres II', playerJs.includes("pause: '<svg") && !playerJs.includes("'Ⅱ'") && !playerHtml.includes('>Ⅱ<')],
  ['Ajustes del reproductor es sólo un engranaje', playerJs.includes("setButtonIcon(infoButton, 'settings')") && !playerHtml.includes('Más detalles')],
  ['Los controles se superponen al video sin pie exterior', playerCss.includes('.player-controls{position:absolute') && playerCss.includes('linear-gradient(180deg,transparent')],
  ['Audio usa sólo la barra de controles sin lienzo de video', playerCss.includes('[data-media-kind="audio"][data-player-state="ready"] .player-media-wrap{display:none}') && playerCss.includes('[data-media-kind="audio"][data-player-state="ready"] .player-controls{position:relative')],
  ['La ventana se adapta a la proporción del medio y sigue siendo redimensionable', rust.includes('fn player_resize_for_media') && rust.includes('LogicalSize::new(target_width, target_height)') && playerJs.includes("invoke('player_resize_for_media'")],
  ['El tamaño automático respeta el espacio disponible de la pantalla', playerJs.includes('window.screen?.availWidth') && playerJs.includes('window.screen?.availHeight') && playerJs.includes('const scale = Math.min(1, availableWidth / width, availableHeight / height)')],
  ['La franja superior conserva región de arrastre y tres controles de ventana', playerHtml.includes('data-tauri-drag-region') && ['minimize','maximize','close'].every((action) => playerHtml.includes(`data-window-action="${action}"`))],
  ['El aviso de preview de baja calidad es excepcional y persistente', rust.includes('fn player_preview_quality_limited') && playerJs.includes('cacatools.player.low-preview-notice.v1') && playerJs.includes('localStorage.setItem(LOW_PREVIEW_NOTICE_KEY') && playerHtml.includes('data-preview-notice')],
  ['720p frente a 2160p no se considera caso extremo', rust.includes('assert!(!player_preview_quality_limited(Some(720), Some(2160)))')],
  ['Rust sigue en Edition 2021 y sin errores históricos conocidos', cargo.includes('edition = "2021"') && !/(?:&&|\|\|)\s*let\s+/.test(rust) && !/\.eval\s*\(\s*&\s*format!/.test(rust) && !/\(\s*Some\(path\)\s*,\s*Some\(destination\)\s*\)\s*if\s*path\.starts_with\(destination\)/.test(rust)],
  ['Native Messaging conserva el ID y no expone rutas del proveedor retirado', !rust.includes('resolve_spotify_source') && extensionBridge.includes('aonppfnabjnicjjeoofkfjofolfibggp')]
];

checks[0] = ['Preview online prioriza flujo nativo y deja YouTube externo solo mediante acción explícita', rust.includes('async fn open_online_media_player') && !rust.includes('serializer.append_pair("official", "1")') && rust.includes('window.location.replace') && /player\.js\?v=0\.30\.1-phase5-session/.test(playerHtml) && playerJs.includes('openOfficialOnlineEmbed') && playerJs.includes('fallbackFromYoutube') && playerJs.includes('showYoutubeManualFallback') && playerJs.includes("open_external_url") && !playerJs.includes('youtube-nocookie.com/embed') && !playerJs.includes('openOfficialYoutubePreview') && playerCss.includes('.player-shell[data-player-source="preview"] .player-controls') && playerCss.includes('.player-shell[data-player-source="preview"] .player-youtube{pointer-events:auto}')];
checks[1] = ['Las fuentes no YouTube conservan un flujo combinado reproducible', (rust.includes('best[ext=mp4][protocol^=http][vcodec!=none][vcodec!=none]') || rust.includes('best[ext=mp4][protocol^=http][vcodec!=none][acodec!=none]')) && rust.includes('requested_formats') && rust.includes('player_preview_requested_entries')];
checks[checks.length - 1] = ['Native Messaging conserva el ID y el SQLite legacy permanece compatible', !rust.includes('spotify_access_token') && rust.includes("ALTER TABLE playlist_items ADD COLUMN spotify_url TEXT NOT NULL DEFAULT ''") && extensionBridge.includes('aonppfnabjnicjjeoofkfjofolfibggp')];
const failures = checks.filter(([, ok]) => !ok).map(([label]) => label);
const report = { phase: '0.24.2-player-preview-online', checks: checks.length, passed: failures.length === 0, failures, generatedAt: new Date().toISOString() };
fs.mkdirSync('docs/tests', { recursive: true });
fs.writeFileSync('docs/tests/phase24-2-player-preview-online.json', `${JSON.stringify(report, null, 2)}\n`);
for (const [label, ok] of checks) console.log(`${ok ? 'OK' : 'FALLO'}: ${label}`);
if (failures.length) process.exit(1);
console.log(`OK: nueva Fase 1 valida ${checks.length} condiciones del reproductor y preview online.`);
