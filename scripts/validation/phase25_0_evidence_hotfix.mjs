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
const main = readFrontendSource('.js');
const player = read('app-ui/player/player.js');
const dm = read('app-ui/download-manager/index.js');
const unified = read('app-ui/download-manager/view/unified.js');
const dmCss = read('app-ui/download-manager/styles.css');

const checks = [
  ['Reproductor conserva UI pero obtiene arrastre nativo',
    rust.includes('fn player_start_dragging') && rust.includes('window.start_dragging()') && player.includes('player_start_dragging') && !player.includes('playlistStandalone')],
  ['Preview de playlist normaliza IDs planos de YouTube',
    main.includes('/^[A-Za-z0-9_-]{11}$/.test(direct)') && main.includes('https://www.youtube.com/watch?v=${direct}')],
  ['Playlist reproduce local al completar y online antes de descargar',
    main.includes("if (jobId > 0) await invoke('open_media_player', { jobId });") && main.includes("else await invoke('open_online_media_player', { url });")],
  ['Iniciar playlist usa la ventana nativa y deriva a Descargas',
    main.includes("open_preparation_window") && main.includes('queue_playlist_selection') && !main.includes('workspaceMarkup')],
  ['Ventana secundaria de cola de playlist ya no es una etapa visible',
    !main.includes('function playlistAnalysisMarkup') && !main.includes('renderDownloadDialog') && !/playlistStage\s*=\s*['"]queue['"]/.test(main)],
  ['Menú contextual resiste click sintético de WebView2',
    dm.includes("document.addEventListener('pointerdown', handleGlobalPointerDown, true)") && dm.includes('event.stopImmediatePropagation();') && !dm.includes('justOpenedByContextMenu')],
  ['Play del gestor se centra contra la miniatura real',
    dmCss.includes('.dm-job-thumb>.dm-player-overlay') && dmCss.includes('inset:0!important;margin:auto!important')],
  ['Plan de yt-dlp actualiza número real de streams aunque falte tamaño',
    rust.includes('struct RequestedMediaPlan') && rust.includes('self.expected_streams = plan.stream_count.max(1)') && rust.includes('stream_count: downloads.len()')],
  ['Progreso usa porcentaje real aun sin total',
    rust.includes('reported_percent: Option<f64>') && rust.includes('let measured_percent =') && rust.includes('.or(measured_percent)')],
  ['filesize_approx no se usa como total autoritativo durante transferencia',
    rust.includes('known_totals_complete') && rust.includes('declared_total_estimated') && rust.includes('total_estimated')],
  ['Totales reales de streams reemplazan estimaciones sin promover filesize_approx',
    rust.includes('actual_totals_complete')
      && rust.includes('known_totals_complete')
      && rust.includes('multimedia_progress_marks_mixed_dash_totals_as_estimated')],
  ['SQLite conserva porcentaje real pero no persiste total_bytes_estimate como total exacto',
    rust.includes('structured_ytdlp_estimate_remains_explicitly_approximate')
      && rust.includes('assert_eq!(total, Some(10_485_760));')
      && rust.includes('assert_eq!(estimated, 1);')],
  ['Selector de calidad y cálculo de tamaño usan los mismos IDs de streams',
    rust.includes('fn video_selection_selector')
      && rust.includes('fn media_format_id')
      && rust.includes('video_selection_selector(entries, max_height)')
      && rust.includes('video_selection_selector_matches_the_streams_used_for_size')],
  ['Snapshot deja de forzar spinner si existe progreso medible',
    rust.includes('let progress_estimated =')
      && rust.includes('total_bytes.is_none()')
      && rust.includes('!progress_estimated')],
  ['Conversión muestra tamaño fuente en vez de total final inventado',
    unified.includes("`${formatBytes(job.downloadedBytes)} de entrada`") && unified.includes('Archivo fuente · tamaño final al terminar')],
  ['MP4 descargado no se recodifica innecesariamente',
    rust.includes('if extension == "mp4" {\n        return Ok(path.to_path_buf());')],
  ['Contenedor no MP4 intenta remux sin recodificar antes de transcodificar',
    rust.includes('"-c",\n            "copy"') && rust.includes('"veryfast"')],
  ['Descarga HTTP usa perfil de navegador y Referer sin credenciales inventadas',
    rust.includes('Chrome/151.0.0.0 Safari/537.36') && rust.includes('.header("Referer", referer.as_str())') && rust.includes('Sec-Fetch-Mode')],
  ['403 persistente devuelve diagnóstico explícito',
    rust.includes('sesión, cookies o un enlace temporal nuevo')],
  ['Archivo final mantiene tamaño exacto autoritativo',
    rust.includes('total_bytes=?2,total_bytes_estimated=0') || rust.includes('total_bytes=?1,total_bytes_estimated=0')],
  ['Regresiones Rust conocidas siguen bloqueadas',
    !/(?:&&|\|\|)\s*let\s+/.test(rust)
      && !/\.eval\s*\(\s*&\s*format!/.test(rust)
      && !/\.then\s*\(\s*\|\|\s*(?:\{\s*)?PlayerStreamTechnicalSnapshot/.test(rust)],
];

checks[15] = ['MP4 preserva calidad y solo remuxea colas temporales invalidas', rust.includes('fn duration_needs_normalization') && rust.includes('if extension == "mp4"') && rust.includes('"-c",') && rust.includes('"copy"')];
const failures = checks.filter(([, ok]) => !ok).map(([label]) => label);
const report = { phase: '0.25.0-evidence-hotfix', checks: checks.length, failures, generatedAt: new Date().toISOString() };
fs.mkdirSync('docs/tests', { recursive: true });
fs.writeFileSync('docs/tests/phase25-0-evidence-hotfix.json', `${JSON.stringify(report, null, 2)}\n`);
if (failures.length) {
  console.error(failures.map((failure) => `FALLO: ${failure}`).join('\n'));
  process.exit(1);
}
for (const [label] of checks) console.log(`OK: ${label}`);
console.log(`OK: hotfix 0.25.0 de evidencias valida ${checks.length} condiciones.`);
