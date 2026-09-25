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
const pkg = JSON.parse(read('package.json'));
const tauri = JSON.parse(read('src-tauri/tauri.conf.json'));
const extension = JSON.parse(read('extension/manifest.json'));
const main = readFrontendSource('.js');
const dm = read('app-ui/download-manager/index.js');
const unified = read('app-ui/download-manager/view/unified.js');
const zen = read('app-ui/download-manager/view/zen-sidebar.js');
const dialogs = read('app-ui/download-manager/view/dialogs.js');
const model = read('app-ui/download-manager/core/model.js');
const constants = read('app-ui/download-manager/core/constants.js');
const shared = read('app-ui/download-manager/view/shared.js');
const css = read('app-ui/download-manager/styles.css');
const appCss = readFrontendSource('.css');
const playerHtml = read('app-ui/player/index.html');
const playerCss = read('app-ui/player/player.css');
const player = read('app-ui/player/player.js');
const rust = fs.readdirSync('src-tauri/src', { recursive: true })
  .filter((file) => file.endsWith('.rs'))
  .sort((a, b) => (a === 'lib.rs' ? -1 : b === 'lib.rs' ? 1 : a.localeCompare(b)))
  .map((file) => fs.readFileSync(`src-tauri/src/${file}`, 'utf8'))
  .join('\n');
const worker = read('extension/service-worker.js');

const checks = [
  ['Versión Beta 0.25.1 sincronizada', pkg.version === '0.25.1' && tauri.version === '0.25.1' && extension.version === '0.25.1' && main.includes("const APP_VERSION = '0.25.1'") && main.includes('CDM-0.25.1-BETA-20260807') && unified.includes('Beta 0.25.1')],
  ['Selección múltiple disponible sin cambiar el layout normal', zen.includes('data-dm-selection-toggle') && zen.includes('data-dm-select-all-visible') && unified.includes('data-dm-select-checkbox') && dialogs.includes('data-dm-confirm-bulk-delete')],
  ['Borrado múltiple conserva opción solo app o app+almacenamiento', dialogs.includes('Solo de CacaTools') && dialogs.includes('CacaTools y almacenamiento') && dm.includes("invoke?.('delete_download_job'") && dm.includes("invoke?.('delete_playlist_batch'")],
  ['Borrado backend detiene tareas activas de forma segura', rust.includes('let was_active = job_is_active(&state, id)') && rust.includes('stop_job_internal(id, false, &state)?') && rust.includes('wait_for_job_idle(&state, id)')],
  ['Menú contextual resiste progreso, eco de WebView2 y scroll programático', dm.includes("document.addEventListener('pointerdown', handleGlobalPointerDown, true)") && dm.includes('event.stopImmediatePropagation();') && dm.includes('nearContextAnchor') && dm.includes('rowMenuOpenedAt') && dm.includes("nextScroll.addEventListener('wheel'") && !dm.includes("nextScroll.addEventListener('scroll'") && !dm.includes('justOpenedByContextMenu')],
  ['Live patch se suspende solo mientras el menú contextual está abierto', !dm.includes('context.workspaceActive') && dm.includes('runtimeState.rowMenuJobId)') && !dm.includes("area.querySelector('.dm-download-item:hover')")],
  ['Selección sobre filas live reemplazadas usa delegación estable', dm.includes("root.addEventListener('change', (event) =>") && dm.includes('.dm-download-area[data-dm-live-replaced="1"]') && dm.includes("target.closest?.('[data-dm-select-checkbox]')")],
  ['Play queda geométricamente centrado dentro de miniatura', css.includes('.dm-job-thumb>.dm-player-overlay') && css.includes('inset:0!important;margin:auto!important') && css.includes('left:0!important;right:0!important;top:0!important;bottom:0!important')],
  ['Play de preview online usa centrado absoluto independiente del tamaño de miniatura', appCss.includes('.analysis-v2-preview .analysis-preview-play') && appCss.includes('inset:0!important') && appCss.includes('margin:auto!important') && appCss.includes('transform:scale(.9)!important')],
  ['Calidad seleccionada usa solo borde de acento, sin relleno azul', appCss.includes('.analysis-format-chips>button.selected') && appCss.includes('border:1px solid var(--dm-accent,var(--accent-base))!important') && appCss.includes('background:var(--dm-surface-2,var(--dl-panel-2))!important') && appCss.includes('box-shadow:none!important')],
  ['Mejor disponible conserva texto blanco y borde del color de interfaz', appCss.includes('.analysis-v2-badges.is-compact>span.is-best') && appCss.includes('color:#fff!important') && appCss.includes('border-color:var(--dm-accent,var(--accent-base))!important')],
  ['La ventana nativa conserva la selección de mejor formato por salida', main.includes('function mediaFormats') && main.includes('function chooseFormat') && main.includes('data-role="output"') && main.includes('data-role="quality"')],
  ['Primera instalación usa verde #00ff2a como acento predeterminado', main.includes("preset: 'caca-green', accent: '#00ff2a'") && constants.includes("accent: '#00ff2a'") && appCss.includes('--accent-base: #00ff2a;')],
  ['Multimedia nueva instalación queda MP4 + mejor disponible + playlist MP3 320', main.includes("return { outputMode: 'video_mp4', formatSelector: '', videoQuality: 'best', playlistFormat: 'MP3 320 kbps' }") && shared.includes('MP4 · vídeo + audio') && shared.includes("playlistFormat || 'MP3 320 kbps'")],
  ['Seleccionar permite alternar filas individuales además de seleccionar todas', dm.includes('if (runtimeState.selectionMode)') && dm.includes('runtimeState.selectedJobIds.has(id)') && dm.includes("!target.closest('button,input,select,a,.dm-row-select')") && dm.includes('data-dm-select-all-visible')],
  ['Reproductor de playlist muestra lista completa y controles anterior/siguiente', rust.includes('WHERE pi.batch_id=?1') && rust.includes('LEFT JOIN media_jobs') && rust.includes('playable: bool') && playerHtml.includes('data-player-playlist-list') && playerHtml.includes('data-player-action="previous-track"') && playerHtml.includes('data-player-action="next-track"') && player.includes('playlistItemPlayable')],
  ['Reproductor aumenta controles, tiempos, volumen y detalles sin rediseñar su estética', playerCss.includes('.player-control-row button{width:38px;height:36px') && playerCss.includes('.player-timeline-row{') && playerCss.includes('font-size:11px') && playerCss.includes('.player-volume{width:min(112px,18vw)') && playerCss.includes('.player-technical dt,.player-technical dd{font-size:11px}')],
  ['Iconos internos de sidebar crecen sin ampliar el botón externo', css.includes('width:28px!important;height:28px!important') && css.includes('width:29px!important;height:29px!important') && !css.includes('.dm-zen-nav>footer button{width:3rem')],
  ['Texto de chips y filtros aumenta en el tamaño predeterminado', css.includes('font-size:1.08rem!important') && css.includes('font-size:1.06rem!important')],
  ['Actualizador queda fijo debajo de Ajustes y no se expande', zen.indexOf('dm-settings-entry') < zen.indexOf('${updateAction}') && css.includes('.dm-zen-nav>footer .dm-update-entry') && css.includes('max-width:2.8rem!important') && css.includes('animation:dm-update-attention') && css.includes('.dm-update-entry span{display:none!important}')],
  ['Los estados semánticos permanecen independientes del acento', constants.includes("success: '#51c987'") && model.includes('successCustomized: Boolean') && dm.includes('const effectiveSuccess = runtimeState.preferences.success;') && shared.includes('permanecen independientes del acento principal')],
  ['Playlist completa abre cola local en el reproductor existente', unified.includes('data-dm-open-playlist-player') && main.includes('onOpenPlaylistPlayer') && rust.includes('fn player_playlist_queue_snapshot') && rust.includes('async fn open_playlist_media_player') && player.includes("invoke('player_playlist_queue_snapshot'")],
  ['Playlist avanza automáticamente sin rediseñar el reproductor', player.includes("element.addEventListener('ended'") && player.includes("if (currentSource === 'playlist') void advancePlaylist(1);") && player.includes('window.cacatoolsPlayerLoadPlaylist')],
  ['Playlist omite inteligentemente archivos locales que WebView2 no puede decodificar', player.includes("playlist ? 'Elemento omitido de la playlist'") && player.includes('continuará con el siguiente elemento reproducible') && player.includes('advancePlaylist(1, { skipUnavailable: true })')],
  ['Captura normal refresca filename/finalUrl/mime después de pausar Chrome', worker.includes('async function refreshDownloadMetadata') && worker.includes("downloadApiCall('search', { id: item.id })") && worker.includes('capture = capturePayload(refreshedItem, requestedWindowMode)')],
  ['Captura normal espera brevemente metadatos tardíos sin bloquear la descarga del navegador', worker.includes('const waits = [0, 70, 130, 210]') && worker.includes('downloadFilenameLooksFinal') && worker.includes('Poll briefly (<=410 ms)')],
  ['Resolver de nombres trata nombres temporales y Content-Disposition robustamente', rust.includes('fn filename_is_temporary_or_opaque') && rust.includes('fn split_content_disposition_parameters') && rust.includes('filename*=') && rust.includes('browser_opaque_name_prefers_informative_url_and_mime')],
  ['Mapa MIME cubre binarios y archivos comprimidos frecuentes', ['application/x-msdownload','application/x-msdos-program','application/zip','application/x-7z-compressed','application/vnd.rar','application/x-msi','application/vnd.android.package-archive'].every((token) => rust.includes(token))],
  ['Pie diferencia velocidad agregada cuando hay varias activas', unified.includes('Total · ${aggregateSpeed}') && dm.includes('Total · ${aggregateSpeed}')],
];

checks[0] = ['Release UI 0.45.0 sincronizada', pkg.version === '0.45.0' && tauri.version === '0.45.0' && extension.version === '0.45.0' && main.includes("const APP_VERSION = '0.45.0'") && main.includes('CDM-0.45.0-UI-20260825') && unified.includes('CacaTools 0.45.0')];
const failures = checks.filter(([, pass]) => !pass).map(([name]) => name);
const report = { phase: '0.25.1-beta-polish', version: pkg.version, checks: checks.length, failures, generatedAt: new Date().toISOString() };
fs.mkdirSync('docs/tests', { recursive: true });
fs.writeFileSync('docs/tests/phase25-1-beta-polish.json', `${JSON.stringify(report, null, 2)}\n`);
for (const [name, pass] of checks) console.log(`${pass ? 'OK' : 'FALLO'}: ${name}`);
if (failures.length) process.exit(1);
console.log(`OK: Beta 0.25.1 valida ${checks.length} correcciones específicas.`);
